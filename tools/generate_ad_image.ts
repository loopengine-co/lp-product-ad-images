import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { ToolDefinition } from 'loopengine'

type ShotType = 'product_only' | 'lifestyle_product' | 'cover_lifestyle'

// Keeps the actual product accurate across every shot instead of letting
// the model reinterpret it from a text description each time — see
// SKILL.md's own "Why image-edit, not text-to-image" note for the
// reasoning. Each prefix constrains what the edit is allowed to change;
// scene_prompt (the caller's own input) supplies the rest — the specific
// setting, styling, and mood for this one shot.
const SHOT_TYPE_PREFIX: Record<ShotType, string> = {
  product_only:
    'Photorealistic e-commerce product photography. Keep the product exactly as shown in the reference image — same shape, colors, proportions, and any printed text or logo, unchanged. No people, no hands, no added props beyond a simple surface and background. Clean studio lighting, sharp focus on the product, commercial ad quality.',
  lifestyle_product:
    'Photorealistic lifestyle product photography for an ad. Keep the product exactly as shown in the reference image — same shape, colors, proportions, and any printed text or logo, unchanged. Show it in realistic natural use — a hand, partial body, or its real-world setting interacting with it plausibly. The product stays clearly recognizable and is not obscured.',
  cover_lifestyle:
    'Photorealistic lifestyle hero/cover photography for an ad campaign. Keep the product exactly as shown in the reference image — same shape, colors, proportions, and any printed text or logo, unchanged. Aspirational, editorial setting and natural lighting; the product is present and identifiable but the scene itself carries the mood, not a tight product close-up.',
}

function parseAspectRatio(spec: string): number {
  const match = spec.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/)
  if (!match) throw new Error(`generate_ad_image: aspect_ratio must look like "1.91:1" — got "${spec}"`)
  const w = Number(match[1])
  const h = Number(match[2])
  if (w <= 0 || h <= 0) throw new Error(`generate_ad_image: aspect_ratio must be positive — got "${spec}"`)
  return w / h
}

// Center-crop only, off whichever size a provider actually generated —
// this ability's whole point is that the product itself must stay
// exactly as generated, so cropping never resizes or distorts it, only
// trims from whichever axis the target ratio is narrower on (often
// nothing at all, when the target matches what was generated exactly,
// like the square case usually does).
function cropRectFor(
  targetRatio: number,
  source: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const { width: srcW, height: srcH } = source
  const srcRatio = srcW / srcH

  if (targetRatio >= srcRatio) {
    // Target is wider (or equal) than the source — keep full width,
    // crop height down.
    const height = Math.round(srcW / targetRatio)
    return { left: 0, top: Math.round((srcH - height) / 2), width: srcW, height: Math.min(height, srcH) }
  }
  // Target is narrower/taller than the source — keep full height, crop
  // width down.
  const width = Math.round(srcH * targetRatio)
  return { left: Math.round((srcW - width) / 2), top: 0, width: Math.min(width, srcW), height: srcH }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function ratioLabel(spec: string): string {
  return spec.replace(/[^0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

interface Generation {
  buffer: Buffer
  width: number
  height: number
}

interface GenerationArgs {
  productBytes: Buffer
  productContentType: string
  prompt: string
  widestRatio: number
  quality: string
}

// gpt-image-* only ever generates at a small fixed set of native pixel
// sizes — there is no way to request an arbitrary ratio like Google
// Ads' 1.91:1 landscape or 9:16 portrait specs directly. Picking
// whichever native size is *closest* to the actual widest requested
// ratio, rather than always generating landscape and cropping
// everything down to it, matters most for portrait: cropping a 9:16
// frame out of a 1536x1024 landscape source would throw away most of
// the composition; generating at the native 1024x1536 portrait size
// instead keeps nearly all of it.
const OPENAI_NATIVE_SIZES = [
  { width: 1536, height: 1024 }, // landscape
  { width: 1024, height: 1024 }, // square
  { width: 1024, height: 1536 }, // portrait
] as const

async function generateWithOpenAI({ productBytes, productContentType, prompt, widestRatio, quality }: GenerationArgs): Promise<Generation> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('generate_ad_image: OPENAI_API_KEY is not set (required when AD_IMAGE_PROVIDER=openai, the default)')
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1'

  const nativeSize = OPENAI_NATIVE_SIZES.reduce((best, size) => {
    const bestDiff = Math.abs(best.width / best.height - widestRatio)
    const diff = Math.abs(size.width / size.height - widestRatio)
    return diff < bestDiff ? size : best
  })

  const form = new FormData()
  form.set('model', model)
  form.set('prompt', prompt)
  form.set('size', `${nativeSize.width}x${nativeSize.height}`)
  form.set('quality', quality)
  form.set('image', new Blob([productBytes], { type: productContentType }), 'product')

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`generate_ad_image: OpenAI image edit failed (HTTP ${res.status}) ${detail.slice(0, 300)}`)
  }
  const body = (await res.json()) as { data?: { b64_json?: string }[] }
  const b64 = body.data?.[0]?.b64_json
  if (!b64) throw new Error('generate_ad_image: OpenAI response carried no image data')

  return { buffer: Buffer.from(b64, 'base64'), width: nativeSize.width, height: nativeSize.height }
}

// Google's Gemini image models ("Nano Banana") — gemini-3.1-flash-image
// (Nano Banana 2) and gemini-3-pro-image (Nano Banana Pro) — support a
// real aspect_ratio parameter with a fixed set of presets, unlike
// OpenAI's three pixel sizes. Square and both portrait specs (4:5, 9:16)
// are exact presets here — no crop needed at all for those; only
// landscape 1.91:1 isn't itself a preset, so 16:9 (the closest) still
// gets a small trim afterward, same reasoning as the OpenAI path.
const GOOGLE_ASPECT_PRESETS = ['1:1', '16:9', '9:16', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '21:9']

function nearestGooglePreset(targetRatio: number): string {
  return GOOGLE_ASPECT_PRESETS.reduce((best, preset) => {
    const bestDiff = Math.abs(parseAspectRatio(best) - targetRatio)
    const diff = Math.abs(parseAspectRatio(preset) - targetRatio)
    return diff < bestDiff ? preset : best
  })
}

// Walks the Interactions API's steps[].content[] shape for the first
// image content block, rather than assuming a fixed index — a response
// can interleave text/image blocks, and which position the image lands
// in isn't a contract worth hardcoding against.
function findImageData(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  for (const value of Object.values(body as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>
          if (obj.type === 'image' && typeof obj.data === 'string') return obj.data
          const nested = findImageData(obj)
          if (nested) return nested
        }
      }
    } else if (value && typeof value === 'object') {
      const nested = findImageData(value)
      if (nested) return nested
    }
  }
  return undefined
}

async function generateWithGoogle({ productBytes, productContentType, prompt, widestRatio, quality }: GenerationArgs): Promise<Generation> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('generate_ad_image: GEMINI_API_KEY is not set (required when AD_IMAGE_PROVIDER=google)')
  const model = process.env.GOOGLE_IMAGE_MODEL || 'gemini-3.1-flash-image' // Nano Banana 2; set to gemini-3-pro-image for Nano Banana Pro

  const aspectRatio = nearestGooglePreset(widestRatio)
  const imageSize = quality === 'high' ? '2K' : '1K'

  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [
        { type: 'text', text: prompt },
        { type: 'image', mime_type: productContentType, data: productBytes.toString('base64') },
      ],
      response_format: { type: 'image', mime_type: 'image/png', aspect_ratio: aspectRatio, image_size: imageSize },
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`generate_ad_image: Google image edit failed (HTTP ${res.status}) ${detail.slice(0, 300)}`)
  }
  const body: unknown = await res.json()
  const b64 = findImageData(body)
  if (!b64) throw new Error('generate_ad_image: Google response carried no image data')

  const buffer = Buffer.from(b64, 'base64')
  // Read real dimensions off the actual bytes rather than assuming what
  // a given aspect_ratio+image_size pair produces — the crop step below
  // needs the truth, not a guess.
  const meta = await sharp(buffer).metadata()
  if (!meta.width || !meta.height) throw new Error('generate_ad_image: could not read generated image dimensions')

  return { buffer, width: meta.width, height: meta.height }
}

export const generateAdImage: ToolDefinition = {
  name: 'generate_ad_image',
  description:
    'Generate one photo shoot — a real image-edit call against the product photo — and export it as one or more Google Ads aspect ratios from that single generation. Pass every ratio that should share the exact same content/style/composition in one call (e.g. ["1.91:1", "1:1"] for matching landscape+square); call again separately for a shot that needs its own distinct composition (typically portrait — see the skill for why). Each call is one real, metered generation regardless of how many ratios you pass.',
  input_schema: {
    type: 'object',
    properties: {
      product_image_url: {
        type: 'string',
        description: 'Publicly reachable URL of the real product photo to base this shot on.',
      },
      shot_type: {
        type: 'string',
        enum: ['product_only', 'lifestyle_product', 'cover_lifestyle'],
        description:
          'product_only: clean product-alone shot. lifestyle_product: product shown in realistic use. cover_lifestyle: aspirational hero/cover shot, product present but not the sole focus.',
      },
      scene_prompt: {
        type: 'string',
        description:
          'The specific setting, styling, mood, and composition for this one shot (e.g. "on a rustic wooden table with soft morning light, a coffee cup beside it"). Describe the scene only — do not restate what the product looks like, the reference photo already establishes that.',
      },
      aspect_ratios: {
        type: 'array',
        items: { type: 'string' },
        description:
          'One or more target ratios as "W:H", all exported from the same single generation. Default ["1.91:1"]. Google Ads\' three standard formats: "1.91:1" (landscape), "1:1" (square), "4:5" or "9:16" (portrait). Combine landscape+square here since they share the same underlying frame height; keep portrait to its own call — see the skill.',
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Generation quality, also the main cost lever — default "high" for ad-ready output.',
      },
    },
    required: ['product_image_url', 'shot_type', 'scene_prompt'],
  },
  execute: async (input) => {
    const outputDir = process.env.AD_IMAGE_OUTPUT_DIR || './generated/ad-images'
    // Which model actually does the generation — OpenAI's gpt-image-*
    // (default) or Google's Nano Banana 2 / Nano Banana Pro. This is a
    // deployment-wide choice, not a per-call one: set once via env, not
    // exposed as a tool argument, since an operator picks a provider for
    // cost/quality/quota reasons that don't vary shot to shot.
    const provider = process.env.AD_IMAGE_PROVIDER || 'openai'
    if (provider !== 'openai' && provider !== 'google') {
      throw new Error(`generate_ad_image: AD_IMAGE_PROVIDER must be "openai" or "google" — got "${provider}"`)
    }

    const productImageUrl = String(input.product_image_url)
    const shotType = String(input.shot_type) as ShotType
    if (!(shotType in SHOT_TYPE_PREFIX)) {
      throw new Error(`generate_ad_image: shot_type must be one of ${Object.keys(SHOT_TYPE_PREFIX).join(', ')} — got "${shotType}"`)
    }
    const scenePrompt = String(input.scene_prompt)
    const aspectRatioSpecs =
      Array.isArray(input.aspect_ratios) && input.aspect_ratios.length > 0 ? input.aspect_ratios.map(String) : ['1.91:1']
    const targetRatios = aspectRatioSpecs.map(parseAspectRatio)
    const quality = typeof input.quality === 'string' && input.quality ? input.quality : 'high'

    const productRes = await fetch(productImageUrl)
    if (!productRes.ok) throw new Error(`generate_ad_image: could not fetch product_image_url (HTTP ${productRes.status})`)
    const productBytes = Buffer.from(await productRes.arrayBuffer())
    const productContentType = productRes.headers.get('content-type') || 'image/png'

    const prompt = `${SHOT_TYPE_PREFIX[shotType]}\n\nScene: ${scenePrompt}`

    // A wider source can always yield a narrower crop, never the
    // reverse — so the shared generation for this whole call targets
    // whichever the *widest* of the requested ratios is; every other
    // requested ratio crops down from that same single generation.
    const widestRatio = Math.max(...targetRatios)
    const generate = provider === 'google' ? generateWithGoogle : generateWithOpenAI
    const generation = await generate({ productBytes, productContentType, prompt, widestRatio, quality })

    await mkdir(outputDir, { recursive: true })

    // One shared timestamp + slug for the whole call, disambiguated per
    // ratio — these files are siblings from the same generation, and
    // should sort/group together on disk.
    const stamp = Date.now()
    const sceneSlug = slugify(scenePrompt) || 'shot'

    const outputs = []
    for (const [i, targetRatio] of targetRatios.entries()) {
      const aspectRatioSpec = aspectRatioSpecs[i]
      const crop = cropRectFor(targetRatio, generation)
      const cropped = await sharp(generation.buffer).extract(crop).png().toBuffer()

      const filename = `${stamp}-${shotType}-${sceneSlug}-${ratioLabel(aspectRatioSpec)}.png`
      const outputPath = join(outputDir, filename)
      await writeFile(outputPath, cropped)

      outputs.push({ path: outputPath, shot_type: shotType, aspect_ratio: aspectRatioSpec, width: crop.width, height: crop.height })
    }

    return JSON.stringify(outputs)
  },
  // Each call is independent — writes its own uniquely-named file(s),
  // reads nothing shared, no risk of two calls conflicting — so it's
  // fine in ToolLane's parallel lane despite not being "read-only" in
  // the usual sense that flag is for.
  safe: true,
}
