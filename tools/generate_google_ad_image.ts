import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { ToolDefinition } from 'loopengine'

type ShotType = 'product_only' | 'lifestyle_product' | 'cover_lifestyle'

interface JobResult {
  // A local filesystem path (default, AD_IMAGE_STORAGE=local), or a
  // gs://bucket/object URI when AD_IMAGE_STORAGE=gcs.
  path: string
  shot_type: ShotType
  aspect_ratio: string
  width: number
  height: number
}

interface JobRecord {
  job_id: string
  status: 'processing' | 'done' | 'failed'
  created_at: string
  finished_at?: string
  request: { shot_type: ShotType; aspect_ratios: string[] }
  result?: JobResult[]
  error?: string
}

// Job files live alongside the images themselves, under the same
// AD_IMAGE_OUTPUT_DIR — check_google_ad_image_job re-derives this same
// path independently (it can't import this file; add-ability copies each
// tool file standalone, flattened, with no shared-module support), so
// the on-disk path convention here is the actual contract between the
// two tools, not a shared function.
function jobPath(outputDir: string, jobId: string): string {
  return join(outputDir, '.jobs', `${jobId}.json`)
}

async function writeJob(outputDir: string, record: JobRecord): Promise<void> {
  await mkdir(join(outputDir, '.jobs'), { recursive: true })
  await writeFile(jobPath(outputDir, record.job_id), JSON.stringify(record, null, 2))
}

// Job status files always stay local regardless of AD_IMAGE_STORAGE —
// they're small operational bookkeeping, not the generated creative
// itself, so there's no reason to route them through GCS too.
function validateStorageConfig(): void {
  const storage = process.env.AD_IMAGE_STORAGE || 'local'
  if (storage !== 'local' && storage !== 'gcs') {
    throw new Error(`generate_google_ad_image: AD_IMAGE_STORAGE must be "local" or "gcs" — got "${storage}"`)
  }
  if (storage === 'gcs' && !process.env.AD_IMAGE_GCS_BUCKET) {
    throw new Error('generate_google_ad_image: AD_IMAGE_GCS_BUCKET is not set (required when AD_IMAGE_STORAGE=gcs)')
  }
}

// Saves one generated image and returns where it landed — a local
// filesystem path by default, or a gs://bucket/object URI when
// AD_IMAGE_STORAGE=gcs. @google-cloud/storage is imported lazily, not at
// the top of the file, so installing it is only required for callers
// who actually turn GCS storage on — everyone else (the local default)
// never needs it, same reasoning as why sharp is a manual `npm install`
// rather than something add-ability manages.
async function saveImage(args: { buffer: Buffer; filename: string; outputDir: string }): Promise<string> {
  const storage = process.env.AD_IMAGE_STORAGE || 'local'
  if (storage === 'gcs') {
    const bucketName = process.env.AD_IMAGE_GCS_BUCKET as string // validateStorageConfig already required this
    const objectName = `${process.env.AD_IMAGE_GCS_PREFIX || ''}${args.filename}`
    // Imported by a variable, not a string literal, so tsc treats this as
    // `Promise<any>` instead of trying to resolve @google-cloud/storage's
    // own types at compile time — installing it is only required at
    // runtime for callers who actually set AD_IMAGE_STORAGE=gcs; everyone
    // else (the local default) would otherwise fail `tsc` just for not
    // having a package they never use.
    const gcsModuleName = '@google-cloud/storage'
    let gcs: any
    try {
      gcs = await import(gcsModuleName)
    } catch {
      throw new Error(
        'generate_google_ad_image: AD_IMAGE_STORAGE=gcs requires the @google-cloud/storage package — npm install @google-cloud/storage in your own project.',
      )
    }
    const client = new gcs.Storage()
    await client.bucket(bucketName).file(objectName).save(args.buffer, { contentType: 'image/png' })
    return `gs://${bucketName}/${objectName}`
  }
  await mkdir(args.outputDir, { recursive: true })
  const outputPath = join(args.outputDir, args.filename)
  await writeFile(outputPath, args.buffer)
  return outputPath
}

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
  if (!match) throw new Error(`generate_google_ad_image: aspect_ratio must look like "1.91:1" — got "${spec}"`)
  const w = Number(match[1])
  const h = Number(match[2])
  if (w <= 0 || h <= 0) throw new Error(`generate_google_ad_image: aspect_ratio must be positive — got "${spec}"`)
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
  targetRatio: number
  quality: string
}

// gpt-image-* only ever generates at a small fixed set of native pixel
// sizes — there is no way to request an arbitrary ratio like Google
// Ads' 1.91:1 landscape or 9:16 portrait specs directly. Every ratio
// gets its own independent generation at whichever native size is
// *closest* to it — never a shared landscape generation cropped down to
// other ratios — since cropping a 9:16 frame out of a 1536x1024
// landscape source would throw away most of the composition, and
// generating at the native 1024x1536 portrait size instead keeps nearly
// all of it. The same reasoning applies to every ratio, not just
// portrait: two ratios generated independently are two independently
// composed photos, never guaranteed to match, but each is the fullest,
// least-cropped version of its own ratio.
const OPENAI_NATIVE_SIZES = [
  { width: 1536, height: 1024 }, // landscape
  { width: 1024, height: 1024 }, // square
  { width: 1024, height: 1536 }, // portrait
] as const

async function generateWithOpenAI({ productBytes, productContentType, prompt, targetRatio, quality }: GenerationArgs): Promise<Generation> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('generate_google_ad_image: OPENAI_API_KEY is not set (required when AD_IMAGE_PROVIDER=openai, the default)')
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1'

  const nativeSize = OPENAI_NATIVE_SIZES.reduce((best, size) => {
    const bestDiff = Math.abs(best.width / best.height - targetRatio)
    const diff = Math.abs(size.width / size.height - targetRatio)
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
    throw new Error(`generate_google_ad_image: OpenAI image edit failed (HTTP ${res.status}) ${detail.slice(0, 300)}`)
  }
  const body = (await res.json()) as { data?: { b64_json?: string }[] }
  const b64 = body.data?.[0]?.b64_json
  if (!b64) throw new Error('generate_google_ad_image: OpenAI response carried no image data')

  return { buffer: Buffer.from(b64, 'base64'), width: nativeSize.width, height: nativeSize.height }
}

// Google's Gemini image models ("Nano Banana") — gemini-3.1-flash-image
// (Nano Banana 2) and gemini-3-pro-image (Nano Banana Pro) — support a
// real aspect_ratio parameter with a fixed set of presets, unlike
// OpenAI's three pixel sizes. Every ratio still gets its own independent
// generation at whichever preset is nearest to it, same as the OpenAI
// path — square and both portrait specs (4:5, 9:16) are exact presets
// here so those need no crop at all; only 1.91:1 isn't itself a preset,
// so 16:9 (the closest) still gets a small trim afterward.
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

async function generateWithGoogle({ productBytes, productContentType, prompt, targetRatio, quality }: GenerationArgs): Promise<Generation> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('generate_google_ad_image: GEMINI_API_KEY is not set (required when AD_IMAGE_PROVIDER=google)')
  const model = process.env.GOOGLE_IMAGE_MODEL || 'gemini-3.1-flash-image' // Nano Banana 2; set to gemini-3-pro-image for Nano Banana Pro

  const aspectRatio = nearestGooglePreset(targetRatio)
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
    throw new Error(`generate_google_ad_image: Google image edit failed (HTTP ${res.status}) ${detail.slice(0, 300)}`)
  }
  const body: unknown = await res.json()
  const b64 = findImageData(body)
  if (!b64) throw new Error('generate_google_ad_image: Google response carried no image data')

  const buffer = Buffer.from(b64, 'base64')
  // Read real dimensions off the actual bytes rather than assuming what
  // a given aspect_ratio+image_size pair produces — the crop step below
  // needs the truth, not a guess.
  const meta = await sharp(buffer).metadata()
  if (!meta.width || !meta.height) throw new Error('generate_google_ad_image: could not read generated image dimensions')

  return { buffer, width: meta.width, height: meta.height }
}

// The actual work — fetching the product photo, the real provider call,
// cropping, writing files — all happens here, after generate_google_ad_image
// has already returned a job_id to the caller. A single high-quality
// generation can take up to a minute or more; running it in the
// background instead of blocking the tool call means the caller (and
// whichever agent turn is waiting on it) isn't stuck for that whole
// time, and a batch of many shots can all be in flight at once instead
// of strictly serialized behind each other's generation time.
async function runJob(args: {
  jobId: string
  outputDir: string
  provider: string
  productImageUrl: string
  shotType: ShotType
  scenePrompt: string
  aspectRatioSpecs: string[]
  targetRatios: number[]
  quality: string
  createdAt: string
}): Promise<void> {
  const { jobId, outputDir, provider, productImageUrl, shotType, scenePrompt, aspectRatioSpecs, targetRatios, quality, createdAt } = args
  const request = { shot_type: shotType, aspect_ratios: aspectRatioSpecs }
  try {
    const productRes = await fetch(productImageUrl)
    if (!productRes.ok) throw new Error(`could not fetch product_image_url (HTTP ${productRes.status})`)
    const productBytes = Buffer.from(await productRes.arrayBuffer())
    const productContentType = productRes.headers.get('content-type') || 'image/png'

    const prompt = `${SHOT_TYPE_PREFIX[shotType]}\n\nScene: ${scenePrompt}`

    // Every requested ratio is its own independent, separately generated
    // photo — never one shared generation cropped down to the rest —
    // so two ratios from the same call can drift in composition,
    // lighting, even framing, same as two separate calls would. Run
    // them concurrently rather than one after another purely for
    // latency: they're unrelated generations, nothing to serialize on.
    const generate = provider === 'google' ? generateWithGoogle : generateWithOpenAI
    const generations = await Promise.all(targetRatios.map((targetRatio) => generate({ productBytes, productContentType, prompt, targetRatio, quality })))

    // One shared timestamp + slug for the whole call, disambiguated per
    // ratio — these files are siblings from the same call, and should
    // sort/group together wherever they land even though each is its
    // own generation.
    const stamp = Date.now()
    const sceneSlug = slugify(scenePrompt) || 'shot'

    const outputs: JobResult[] = []
    for (const [i, targetRatio] of targetRatios.entries()) {
      const aspectRatioSpec = aspectRatioSpecs[i]
      const generation = generations[i]
      // Still a crop, not a resize — the provider's native size/preset
      // for this ratio is rarely pixel-exact (e.g. 1.91:1 has no native
      // OpenAI size and no Google preset), so this trims the small
      // remainder rather than stretching or padding.
      const crop = cropRectFor(targetRatio, generation)
      const cropped = await sharp(generation.buffer).extract(crop).png().toBuffer()

      const filename = `${stamp}-${shotType}-${sceneSlug}-${ratioLabel(aspectRatioSpec)}.png`
      const path = await saveImage({ buffer: cropped, filename, outputDir })

      outputs.push({ path, shot_type: shotType, aspect_ratio: aspectRatioSpec, width: crop.width, height: crop.height })
    }

    await writeJob(outputDir, { job_id: jobId, status: 'done', created_at: createdAt, finished_at: new Date().toISOString(), request, result: outputs })
  } catch (err) {
    // Best-effort: if even writing the failure record fails (e.g. the
    // output dir was removed mid-run), there's nothing further to do —
    // check_google_ad_image_job will just report the job as not found.
    await writeJob(outputDir, {
      job_id: jobId,
      status: 'failed',
      created_at: createdAt,
      finished_at: new Date().toISOString(),
      request,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {})
  }
}

export const generateGoogleAdImage: ToolDefinition = {
  name: 'generate_google_ad_image',
  description:
    'Start one photo shoot against the real product photo, for one or more Google Ads aspect ratios. Each ratio in aspect_ratios is its own independent, separately generated image-edit call — not cropped from a shared source — so passing several here is purely a convenience (one job_id covers all of them) not a cost or consistency shortcut; two ratios from one call can still come out with different composition/lighting, same as two separate calls would. Returns immediately with a job_id and status "processing" instead of blocking until every image is ready (a single generation can take up to a minute or more); poll check_google_ad_image_job with that job_id for the result.',
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
          'One or more target ratios as "W:H", each generated independently (its own real, separately metered provider call) — not cropped from a shared source. Default ["1.91:1"]. Google Ads\' three standard formats: "1.91:1" (landscape), "1:1" (square), "4:5" or "9:16" (portrait).',
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
      throw new Error(`generate_google_ad_image: AD_IMAGE_PROVIDER must be "openai" or "google" — got "${provider}"`)
    }
    validateStorageConfig()

    const productImageUrl = String(input.product_image_url)
    const shotType = String(input.shot_type) as ShotType
    if (!(shotType in SHOT_TYPE_PREFIX)) {
      throw new Error(`generate_google_ad_image: shot_type must be one of ${Object.keys(SHOT_TYPE_PREFIX).join(', ')} — got "${shotType}"`)
    }
    const scenePrompt = String(input.scene_prompt)
    const aspectRatioSpecs =
      Array.isArray(input.aspect_ratios) && input.aspect_ratios.length > 0 ? input.aspect_ratios.map(String) : ['1.91:1']
    const targetRatios = aspectRatioSpecs.map(parseAspectRatio)
    const quality = typeof input.quality === 'string' && input.quality ? input.quality : 'high'

    const jobId = randomUUID()
    const createdAt = new Date().toISOString()
    await writeJob(outputDir, {
      job_id: jobId,
      status: 'processing',
      created_at: createdAt,
      request: { shot_type: shotType, aspect_ratios: aspectRatioSpecs },
    })

    // Not awaited — see runJob's own comment for why. Errors inside it
    // are caught there and written into the job record itself, never
    // thrown here, since by this point the caller has already moved on.
    void runJob({ jobId, outputDir, provider, productImageUrl, shotType, scenePrompt, aspectRatioSpecs, targetRatios, quality, createdAt })

    return JSON.stringify({ job_id: jobId, status: 'processing' })
  },
  // Each call is independent — writes its own uniquely-named job file
  // and (once the background run finishes) image file(s), reads nothing
  // shared, no risk of two calls conflicting — so it's fine in
  // ToolLane's parallel lane despite not being "read-only" in the usual
  // sense that flag is for.
  safe: true,
}
