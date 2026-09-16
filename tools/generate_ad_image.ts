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

// gpt-image-* models only ever generate at a small fixed set of native
// sizes — there is no way to request an arbitrary ratio like Google
// Ads' 1.91:1 landscape or 9:16 portrait specs directly from the API.
// Picking whichever native size is *closest* to the actual target ratio
// (see nearestNativeSize) and cropping the small remainder off that,
// rather than always generating landscape and cropping everything down
// to it, matters most for portrait: cropping a 9:16 frame out of a
// 1536x1024 landscape source would throw away most of the composition
// the model actually produced; generating at the native 1024x1536
// portrait size instead keeps nearly all of it.
const NATIVE_SIZES = [
  { width: 1536, height: 1024 }, // landscape
  { width: 1024, height: 1024 }, // square
  { width: 1024, height: 1536 }, // portrait
] as const

function nearestNativeSize(targetRatio: number): (typeof NATIVE_SIZES)[number] {
  return NATIVE_SIZES.reduce((best, size) => {
    const bestDiff = Math.abs(best.width / best.height - targetRatio)
    const diff = Math.abs(size.width / size.height - targetRatio)
    return diff < bestDiff ? size : best
  })
}

function parseAspectRatio(spec: string): number {
  const match = spec.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/)
  if (!match) throw new Error(`generate_ad_image: aspect_ratio must look like "1.91:1" — got "${spec}"`)
  const w = Number(match[1])
  const h = Number(match[2])
  if (w <= 0 || h <= 0) throw new Error(`generate_ad_image: aspect_ratio must be positive — got "${spec}"`)
  return w / h
}

// Center-crop only, off whichever native size was actually generated —
// this ability's whole point is that the product itself must stay
// exactly as generated, so cropping never resizes or distorts it, only
// trims from whichever axis the target ratio is narrower on (often
// nothing at all, when the target matches a native size exactly, like
// the square case).
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
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('generate_ad_image: OPENAI_API_KEY is not set')
    const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1'
    const outputDir = process.env.AD_IMAGE_OUTPUT_DIR || './generated/ad-images'

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

    // A wider native source can always yield a narrower crop, never the
    // reverse — so the shared source for this whole call is whichever
    // native size fits the *widest* of the requested ratios; every
    // other requested ratio crops down from that same single generation.
    const widestRatio = Math.max(...targetRatios)
    const nativeSize = nearestNativeSize(widestRatio)

    const form = new FormData()
    form.set('model', model)
    form.set('prompt', prompt)
    form.set('size', `${nativeSize.width}x${nativeSize.height}`)
    form.set('quality', quality)
    form.set('image', new Blob([productBytes], { type: productContentType }), 'product')

    const editRes = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })
    if (!editRes.ok) {
      const detail = await editRes.text().catch(() => '')
      throw new Error(`generate_ad_image: OpenAI image edit failed (HTTP ${editRes.status}) ${detail.slice(0, 300)}`)
    }
    const editBody = (await editRes.json()) as { data?: { b64_json?: string }[] }
    const b64 = editBody.data?.[0]?.b64_json
    if (!b64) throw new Error('generate_ad_image: OpenAI response carried no image data')

    const generated = Buffer.from(b64, 'base64')
    await mkdir(outputDir, { recursive: true })

    // One shared timestamp + slug for the whole call, disambiguated per
    // ratio — these files are siblings from the same generation, and
    // should sort/group together on disk.
    const stamp = Date.now()
    const sceneSlug = slugify(scenePrompt) || 'shot'

    const outputs = []
    for (const [i, targetRatio] of targetRatios.entries()) {
      const aspectRatioSpec = aspectRatioSpecs[i]
      const crop = cropRectFor(targetRatio, nativeSize)
      const cropped = await sharp(generated).extract(crop).png().toBuffer()

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
