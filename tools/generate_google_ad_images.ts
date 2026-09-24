import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import sharp from 'sharp'
import type { ToolDefinition } from 'loopengine'

type ShotType = 'product_only' | 'lifestyle_product' | 'cover_lifestyle'

interface ShotSpec {
  shotType: ShotType
  scenePrompt: string
  aspectRatioSpecs: string[]
  targetRatios: number[]
  productImageUrl: string
}

interface UnitResult {
  shot_index: number
  shot_type: ShotType
  aspect_ratio: string
  // Which product photo this unit actually used — useful for tracing a
  // result back to its source when different shots in the batch
  // reference different photos.
  product_image_url: string
  status: 'done' | 'failed'
  // A short relative URL — /storage-redirect (AD_IMAGE_STORAGE=gcs) or
  // /local-file (AD_IMAGE_STORAGE=local, when AD_IMAGE_OUTPUT_DIR
  // resolves inside this deployment's own project directory) — or, only
  // when AD_IMAGE_OUTPUT_DIR is set to an absolute path outside it, a
  // bare filesystem path with no web-accessible URL at all. See
  // saveImage's own doc comment. A URL here is only openable from a
  // browser already authenticated to this same loopengine server — not
  // a standalone shareable link. Present only when status is "done".
  path?: string
  // A second URL for the same file with disposition=attachment, forcing
  // a real browser download instead of opening inline — present
  // whenever `path` is itself a URL (see its own doc comment); absent
  // only for the bare-filesystem-path fallback case, which has no
  // meaningful separate "download" URL to offer.
  download_path?: string
  width?: number
  height?: number
  error?: string
}

interface JobRecord {
  job_id: string
  // "processing" until every unit (one shot × one of its aspect_ratios)
  // has settled. "done" only if every unit succeeded, "failed" only if
  // every unit failed, "partial" if it's a mix — a batch of 30+
  // independent generations WILL sometimes have a handful fail without
  // the rest being any less usable, so collapsing that into a binary
  // done/failed would either hide real failures or throw away good
  // images.
  status: 'processing' | 'done' | 'partial' | 'failed'
  created_at: string
  finished_at?: string
  progress: { total: number; done: number; failed: number; processing: number }
  // Grows incrementally as each unit finishes — a caller polling mid-run
  // already sees every unit that's settled so far, not just a bare
  // "processing" flag with no visibility for however many minutes a big
  // batch takes.
  results: UnitResult[]
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

// Builds the Storage client — Application Default Credentials (a real
// key file via GOOGLE_APPLICATION_CREDENTIALS, gcloud user credentials,
// or the GCE/Cloud Run metadata server) by default, needing zero setup
// here. GOOGLE_APPLICATION_CREDENTIALS_JSON is the one non-ADC path this
// reads itself: the *entire contents* of a downloaded service-account
// key file, pasted directly into an env var — for an operator who can
// create a key via the GCP Console's own UI but has no way to get a
// file onto wherever this is actually running (no SSH, no shell). Same
// design as create_zip_archive's own buildGcsStorageClient — duplicated
// here rather than shared since abilities can't import each other's
// code.
function buildGcsStorageClient(gcs: any): any {
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  if (!credentialsJson) return new gcs.Storage()
  let credentials: { project_id?: string }
  try {
    credentials = JSON.parse(credentialsJson)
  } catch {
    throw new Error(
      'generate_google_ad_images: GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON — paste the entire contents of the downloaded service-account key file, unedited.',
    )
  }
  return new gcs.Storage({ credentials, projectId: credentials.project_id })
}

// Job status files always stay local regardless of AD_IMAGE_STORAGE —
// they're small operational bookkeeping, not the generated creative
// itself, so there's no reason to route them through GCS too.
function validateStorageConfig(): void {
  const storage = process.env.AD_IMAGE_STORAGE || 'local'
  if (storage !== 'local' && storage !== 'gcs') {
    throw new Error(`generate_google_ad_images: AD_IMAGE_STORAGE must be "local" or "gcs" — got "${storage}"`)
  }
  if (storage === 'gcs' && !process.env.AD_IMAGE_GCS_BUCKET) {
    throw new Error('generate_google_ad_images: AD_IMAGE_GCS_BUCKET is not set (required when AD_IMAGE_STORAGE=gcs)')
  }
}

interface SavedImage {
  path: string
  // Set alongside a /storage-redirect or /local-file path (a real,
  // openable URL) — never alongside a bare filesystem path, which has
  // no separate "download" URL to offer. See UnitResult.download_path's
  // own doc comment for why.
  downloadPath?: string
}

// Saves one generated image and returns where it landed — a local
// filesystem path by default, or a short redirect URL when
// AD_IMAGE_STORAGE=gcs. @google-cloud/storage is imported lazily, not at
// the top of the file, so installing it is only required for callers
// who actually turn GCS storage on — everyone else (the local default)
// never needs it, same reasoning as why sharp is a manual `npm install`
// rather than something add-ability manages.
//
// The GCS branch no longer signs a URL itself — it returns
// /storage-redirect?provider=gcs&bucket=...&object=..., loopengine
// core's own generic route (adapters/http.ts's handleStorageRedirect),
// which signs fresh on every click instead. Two things that fixes: the
// model's own reply has to reproduce this URL to embed it as a markdown
// image/download link, and a bucket+object name (human-readable, not
// random) is dramatically cheaper and safer to reproduce than a
// ~300-character opaque Signature — see core/known-urls.ts's own doc
// comment for what used to go wrong here. A real behavior change worth
// knowing: this URL is relative, not a standalone shareable link the
// old signed URL was — only openable from a browser already
// authenticated to this same server (same Basic Auth gate every other
// route here already needs), and it depends on a loopengine core new
// enough to serve /storage-redirect at all (see this ability's own
// loopengineVersion floor in loopengine.ability.json, bumped alongside
// this change so installing/upgrading onto an older core refuses
// outright instead of silently 404ing on first click).
async function saveImage(args: { buffer: Buffer; filename: string; outputDir: string }): Promise<SavedImage> {
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
        'generate_google_ad_images: AD_IMAGE_STORAGE=gcs requires the @google-cloud/storage package — npm install @google-cloud/storage in your own project.',
      )
    }
    const client = buildGcsStorageClient(gcs)
    const file = client.bucket(bucketName).file(objectName)
    await file.save(args.buffer, { contentType: 'image/png' })

    const bucketParam = encodeURIComponent(bucketName)
    const objectParam = encodeURIComponent(objectName)
    const viewUrl = `/storage-redirect?provider=gcs&bucket=${bucketParam}&object=${objectParam}`
    const downloadUrl = `${viewUrl}&disposition=attachment&filename=${encodeURIComponent(args.filename)}`
    return { path: viewUrl, downloadPath: downloadUrl }
  }
  await mkdir(args.outputDir, { recursive: true })
  const outputPath = join(args.outputDir, args.filename)
  await writeFile(outputPath, args.buffer)

  // Same /local-file route AD_IMAGE_STORAGE=gcs's own /storage-redirect
  // sits alongside — loopengine core's own generic "serve a file from
  // this deployment's own project directory" route (adapters/http.ts's
  // handleLocalFile), giving local storage the same preview/
  // download-button treatment gcs already gets, instead of a bare path
  // nothing but direct server access can open. Only offered when
  // outputPath actually resolves inside process.cwd() — that route
  // refuses anything outside it (see its own doc comment: it's a
  // generic file server, not scoped to AD_IMAGE_OUTPUT_DIR specifically,
  // so it can't tell "this ability's own configured output dir" from
  // "an arbitrary path" any other way). AD_IMAGE_OUTPUT_DIR left at its
  // own relative-path default is already under cwd; pointed at an
  // absolute path elsewhere, this falls back to the bare path exactly
  // like before — no preview/download URL for that file, same as an
  // older loopengine core with no /local-file route at all.
  const relativeToRoot = relative(process.cwd(), outputPath)
  if (!isAbsolute(relativeToRoot) && !relativeToRoot.startsWith('..')) {
    const pathParam = encodeURIComponent(relativeToRoot)
    const viewUrl = `/local-file?path=${pathParam}`
    const downloadUrl = `${viewUrl}&disposition=attachment&filename=${encodeURIComponent(args.filename)}`
    return { path: viewUrl, downloadPath: downloadUrl }
  }
  return { path: outputPath }
}

// Keeps the actual product accurate across every shot instead of letting
// the model reinterpret it from a text description each time — see
// SKILL.md's own "Why image-edit, not text-to-image" note for the
// reasoning. Each prefix constrains what the edit is allowed to change;
// scene_prompt (the caller's own input) supplies the rest — the specific
// setting, styling, and mood for this one shot.
// Every generation lands at whichever fixed native size/preset the
// provider actually offers (OPENAI_NATIVE_SIZES / GOOGLE_ASPECT_PRESETS
// below) — neither provider can generate Google Ads' own required ratios
// (1.91:1, 9:16, 4:5, ...) directly, so cropRectFor always center-crops
// the result down to the exact target ratio afterward. A composition
// that fills the frame edge-to-edge loses whatever sits in the trimmed
// margin; MARGIN_INSTRUCTION is appended to every shot type's own prefix
// for exactly this reason, not just product_only (a lifestyle/cover shot
// crops the exact same way, only the composition around the product
// differs).
const MARGIN_INSTRUCTION =
  ' Leave comfortable margin around the product on every side — it must not touch or extend past any edge of the frame. The final image gets center-cropped afterward, and anything sitting at the very edge risks being trimmed off.'

const SHOT_TYPE_PREFIX: Record<ShotType, string> = {
  product_only:
    'Photorealistic e-commerce product photography. Keep the product exactly as shown in the reference image — same shape, colors, proportions, and any printed text or logo, unchanged. No people, no hands, no added props beyond a simple surface and background. Clean studio lighting, sharp focus on the product, commercial ad quality.' +
    MARGIN_INSTRUCTION,
  lifestyle_product:
    'Photorealistic lifestyle product photography for an ad. Keep the product exactly as shown in the reference image — same shape, colors, proportions, and any printed text or logo, unchanged. Show it in realistic natural use — a hand, partial body, or its real-world setting interacting with it plausibly. The product stays clearly recognizable and is not obscured.' +
    MARGIN_INSTRUCTION,
  cover_lifestyle:
    'Photorealistic lifestyle hero/cover photography for an ad campaign. Keep the product exactly as shown in the reference image — same shape, colors, proportions, and any printed text or logo, unchanged. Aspirational, editorial setting and natural lighting; the product is present and identifiable but the scene itself carries the mood, not a tight product close-up.' +
    MARGIN_INSTRUCTION,
}

function parseAspectRatio(spec: string): number {
  const match = spec.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/)
  if (!match) throw new Error(`generate_google_ad_images: aspect_ratio must look like "1.91:1" — got "${spec}"`)
  const w = Number(match[1])
  const h = Number(match[2])
  if (w <= 0 || h <= 0) throw new Error(`generate_google_ad_images: aspect_ratio must be positive — got "${spec}"`)
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

// Fallback for an OPENAI_IMAGE_MODEL that isn't gpt-image-2.5-sunburst/
// flare (see OPENAI_CUSTOM_SIZE_MODELS below for those two) — an older
// gpt-image-* model only ever generates at one of these 3 fixed native
// pixel sizes, with no way to request an arbitrary ratio like Google
// Ads' 1.91:1 landscape or 9:16 portrait specs directly. Every ratio
// still gets its own independent generation at whichever native size is
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

// gpt-image-2.5-sunburst/flare specifically (confirmed against OpenAI's
// own docs) additionally accept a custom size as a literal "WIDTHxHEIGHT"
// string — width and height each a multiple of 16, total pixels between
// 655,360 and 8,294,400 (4K), aspect ratio between 1:3 and 3:1 (every
// ratio this tool ever requests is comfortably inside that range). Older
// models (gpt-image-2 and earlier) only ever support the 3 fixed native
// sizes above — OPENAI_NATIVE_SIZES stays the fallback for those.
const OPENAI_CUSTOM_SIZE_MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']
// Matches OPENAI_NATIVE_SIZES' own landscape/portrait pixel count — same
// rough cost/quality tier as before, just at the exact target ratio
// instead of whichever of the 3 fixed sizes happens to be closest.
const OPENAI_CUSTOM_SIZE_PIXEL_BUDGET = 1536 * 1024
const OPENAI_SIZE_MULTIPLE = 16

// Computing the exact target ratio directly here — instead of picking
// the nearest of 3 fixed native sizes and relying on cropRectFor to trim
// the difference afterward — means that crop only ever removes a few
// pixels of rounding error, not real composition. This is what actually
// eliminates the "product cropped at the edge" problem at its root for
// these two models, rather than just mitigating it (see
// MARGIN_INSTRUCTION above, which still matters for the rounding-error
// margin and for older models still on OPENAI_NATIVE_SIZES).
function computeCustomOpenAISize(targetRatio: number): { width: number; height: number } {
  const rawWidth = Math.sqrt(OPENAI_CUSTOM_SIZE_PIXEL_BUDGET * targetRatio)
  const rawHeight = rawWidth / targetRatio
  const width = Math.max(OPENAI_SIZE_MULTIPLE, Math.round(rawWidth / OPENAI_SIZE_MULTIPLE) * OPENAI_SIZE_MULTIPLE)
  const height = Math.max(OPENAI_SIZE_MULTIPLE, Math.round(rawHeight / OPENAI_SIZE_MULTIPLE) * OPENAI_SIZE_MULTIPLE)
  return { width, height }
}

async function generateWithOpenAI({ productBytes, productContentType, prompt, targetRatio, quality }: GenerationArgs): Promise<Generation> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('generate_google_ad_images: OPENAI_API_KEY is not set (required when AD_IMAGE_PROVIDER=openai, the default)')
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-sunburst'

  const size = OPENAI_CUSTOM_SIZE_MODELS.includes(model)
    ? computeCustomOpenAISize(targetRatio)
    : OPENAI_NATIVE_SIZES.reduce((best, s) => {
        const bestDiff = Math.abs(best.width / best.height - targetRatio)
        const diff = Math.abs(s.width / s.height - targetRatio)
        return diff < bestDiff ? s : best
      })

  const form = new FormData()
  form.set('model', model)
  form.set('prompt', prompt)
  form.set('size', `${size.width}x${size.height}`)
  form.set('quality', quality)
  form.set('image', new Blob([productBytes], { type: productContentType }), 'product')

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`generate_google_ad_images: OpenAI image edit failed (HTTP ${res.status}) ${detail.slice(0, 300)}`)
  }
  const body = (await res.json()) as { data?: { b64_json?: string }[] }
  const b64 = body.data?.[0]?.b64_json
  if (!b64) throw new Error('generate_google_ad_images: OpenAI response carried no image data')

  return { buffer: Buffer.from(b64, 'base64'), width: size.width, height: size.height }
}

// Google's Gemini image models ("Nano Banana") — gemini-3.1-flash-image
// (Nano Banana 2) and gemini-3.1-pro-image (Nano Banana Pro) — support a
// real aspect_ratio parameter with a fixed set of presets, unlike
// OpenAI's three pixel sizes. Every ratio still gets its own independent
// generation at whichever preset is nearest to it, same as the OpenAI
// path — square and both portrait specs (4:5, 9:16) are exact presets
// here so those need no crop at all; only 1.91:1 isn't itself a preset,
// so 16:9 (the closest) still gets a small trim afterward.
const GOOGLE_ASPECT_PRESETS = ['1:1', '16:9', '9:16', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '21:9']

// gemini-3.1-flash-image (Nano Banana 2) and gemini-3.1-pro-image (Nano
// Banana Pro) don't share one resolution/cost table (confirmed against
// Google's own docs for each) — flash has 4 real tiers (512px/1K/2K/4K,
// costing roughly 747/1120/1680/2520 tokens, each about 1.5x the one
// below), while pro only ever offers 3 (1K/2K/4K, no 512px tier at all)
// — and pro's own 1K and 2K cost the *exact same* 1120 tokens, meaning
// requesting 1K on pro is strictly worse for zero savings, never worth
// picking. Each gets its own quality mapping for this reason — sharing
// one would either ask pro for a 512px tier it doesn't have, or leave
// low/medium/high on pro's own strictly-dominated 1K tier for no reason.
// "high" stays 2K on both — xhigh and max both land on 4K on both
// models too, since each one's own tiers cap there with nothing above
// it left to tell the two apart by. This tool's own default is
// "medium", not "high" — see the quality input_schema's own description
// for why.
const GOOGLE_FLASH_IMAGE_SIZE_BY_QUALITY: Record<string, string> = {
  low: '512px',
  medium: '1K',
  high: '2K',
  xhigh: '4K',
  max: '4K',
}
const GOOGLE_PRO_IMAGE_SIZE_BY_QUALITY: Record<string, string> = {
  low: '2K',
  medium: '2K',
  high: '2K',
  xhigh: '4K',
  max: '4K',
}

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
  if (!apiKey) throw new Error('generate_google_ad_images: GEMINI_API_KEY is not set (required when AD_IMAGE_PROVIDER=google)')
  const model = process.env.GOOGLE_IMAGE_MODEL || 'gemini-3.1-flash-image' // Nano Banana 2; set to gemini-3.1-pro-image for Nano Banana Pro

  const aspectRatio = nearestGooglePreset(targetRatio)
  // Falls back to '2K' (this tool's own default quality's own tier, and
  // the one size both models' own mappings happen to agree on) for a
  // quality value outside the known five — shouldn't happen given the
  // tool's own input_schema enum already restricts it, but a fallback
  // beats an undefined image_size reaching the request at all.
  const imageSizeByQuality = model === 'gemini-3.1-pro-image' ? GOOGLE_PRO_IMAGE_SIZE_BY_QUALITY : GOOGLE_FLASH_IMAGE_SIZE_BY_QUALITY
  const imageSize = imageSizeByQuality[quality] || '2K'

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
    throw new Error(`generate_google_ad_images: Google image edit failed (HTTP ${res.status}) ${detail.slice(0, 300)}`)
  }
  const body: unknown = await res.json()
  const b64 = findImageData(body)
  if (!b64) throw new Error('generate_google_ad_images: Google response carried no image data')

  const buffer = Buffer.from(b64, 'base64')
  // Read real dimensions off the actual bytes rather than assuming what
  // a given aspect_ratio+image_size pair produces — the crop step below
  // needs the truth, not a guess.
  const meta = await sharp(buffer).metadata()
  if (!meta.width || !meta.height) throw new Error('generate_google_ad_images: could not read generated image dimensions')

  return { buffer, width: meta.width, height: meta.height }
}

interface WorkUnit {
  shotIndex: number
  shotType: ShotType
  scenePrompt: string
  productImageUrl: string
  aspectRatioSpec: string
  targetRatio: number
}

// Runs `items` through `worker`, at most `limit` concurrently — a plain
// `Promise.all` over every unit in a 30+ shot batch would fire that many
// simultaneous provider calls at once and likely trip rate limits;
// this instead keeps `limit` workers alive, each pulling the next
// not-yet-started item off the shared list until it's exhausted.
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  async function runOne(): Promise<void> {
    while (next < items.length) {
      const item = items[next++]
      await worker(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne))
}

interface FetchedProduct {
  bytes: Buffer
  contentType: string
}

// OpenAI's images/edits endpoint only accepts an exact "image/jpeg",
// "image/png", or "image/webp" Content-Type — some CDNs/servers instead
// serve the non-standard "image/jpg" alias (or append "; charset=..."),
// neither of which OpenAI accepts even though the actual bytes are a
// perfectly valid JPEG. Normalized once here so both providers get the
// canonical type regardless of what the source server actually sent.
const CONTENT_TYPE_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/x-png': 'image/png',
}
function normalizeImageContentType(raw: string): string {
  const bare = raw.split(';')[0].trim().toLowerCase()
  return CONTENT_TYPE_ALIASES[bare] || bare
}

// One product photo can be shared by many shots (the common case — one
// photo, a varied shot list) or differ per shot (a request that hands
// over several photos of the same product and lets the caller pick which
// fits each shot). Either way, a given URL should only ever be fetched
// once per job — this cache is keyed by URL and shared across every
// concurrent unit, so units referencing the same photo just await the
// same in-flight fetch instead of each starting their own.
function createProductFetcher(): (url: string) => Promise<FetchedProduct> {
  const cache = new Map<string, Promise<FetchedProduct>>()
  return function fetchProduct(url: string): Promise<FetchedProduct> {
    let pending = cache.get(url)
    if (!pending) {
      pending = (async () => {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`could not fetch product_image_url (HTTP ${res.status})`)
        return { bytes: Buffer.from(await res.arrayBuffer()), contentType: normalizeImageContentType(res.headers.get('content-type') || 'image/png') }
      })()
      cache.set(url, pending)
    }
    return pending
  }
}

// The actual work — every shot's every requested ratio as its own
// independent generation — all happens here, after
// generate_google_ad_images has already returned a job_id to the caller.
// Progress is persisted after each unit settles (not just once at the
// very end), so a caller polling mid-run sees real partial results
// instead of a bare "processing" flag for however long the whole batch
// takes.
async function runJob(args: {
  jobId: string
  outputDir: string
  provider: string
  shots: ShotSpec[]
  quality: string
  concurrency: number
  createdAt: string
}): Promise<void> {
  const { jobId, outputDir, provider, shots, quality, concurrency, createdAt } = args

  const results: UnitResult[] = []
  const progress = { total: 0, done: 0, failed: 0, processing: 0 }
  for (const shot of shots) progress.total += shot.aspectRatioSpecs.length
  progress.processing = progress.total

  // Writes are chained (not fired independently) so two units finishing
  // close together can't race and leave the file with an earlier,
  // less-complete snapshot overwriting a later one — each chained write
  // reads `results`/`progress` fresh at the moment it actually runs, by
  // which point every synchronous push that happened before it in
  // program order is already reflected.
  let writeChain: Promise<void> = Promise.resolve()
  function persist(finished: boolean): void {
    writeChain = writeChain.then(() =>
      writeJob(outputDir, {
        job_id: jobId,
        status: !finished
          ? 'processing'
          : progress.failed === 0
            ? 'done'
            : progress.done === 0
              ? 'failed'
              : 'partial',
        created_at: createdAt,
        finished_at: finished ? new Date().toISOString() : undefined,
        progress: { ...progress },
        results: [...results],
      }),
    )
  }

  const fetchProduct = createProductFetcher()
  const generate = provider === 'google' ? generateWithGoogle : generateWithOpenAI
  const stamp = Date.now()

  const units: WorkUnit[] = []
  shots.forEach((shot, shotIndex) => {
    shot.aspectRatioSpecs.forEach((aspectRatioSpec, i) => {
      units.push({
        shotIndex,
        shotType: shot.shotType,
        scenePrompt: shot.scenePrompt,
        productImageUrl: shot.productImageUrl,
        aspectRatioSpec,
        targetRatio: shot.targetRatios[i],
      })
    })
  })

  await runWithConcurrency(units, concurrency, async (unit) => {
    try {
      // Units sharing the same URL await the same cached fetch — only
      // the units whose URL actually fails to fetch fail here, not the
      // whole batch, unlike when every shot shared one fixed photo.
      const { bytes: productBytes, contentType: productContentType } = await fetchProduct(unit.productImageUrl)
      const prompt = `${SHOT_TYPE_PREFIX[unit.shotType]}\n\nScene: ${unit.scenePrompt}`
      const generation = await generate({ productBytes, productContentType, prompt, targetRatio: unit.targetRatio, quality })
      // Still a crop, not a resize — the provider's native size/preset
      // for this ratio is rarely pixel-exact (e.g. 1.91:1 has no native
      // OpenAI size and no Google preset), so this trims the small
      // remainder rather than stretching or padding.
      const crop = cropRectFor(unit.targetRatio, generation)
      const cropped = await sharp(generation.buffer).extract(crop).png().toBuffer()

      const sceneSlug = slugify(unit.scenePrompt) || 'shot'
      const filename = `${stamp}-shot${unit.shotIndex}-${unit.shotType}-${sceneSlug}-${ratioLabel(unit.aspectRatioSpec)}.png`
      const { path, downloadPath } = await saveImage({ buffer: cropped, filename, outputDir })

      results.push({
        shot_index: unit.shotIndex,
        shot_type: unit.shotType,
        aspect_ratio: unit.aspectRatioSpec,
        product_image_url: unit.productImageUrl,
        status: 'done',
        path,
        download_path: downloadPath,
        width: crop.width,
        height: crop.height,
      })
      progress.done++
    } catch (err) {
      results.push({
        shot_index: unit.shotIndex,
        shot_type: unit.shotType,
        aspect_ratio: unit.aspectRatioSpec,
        product_image_url: unit.productImageUrl,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
      progress.failed++
    } finally {
      progress.processing--
      persist(progress.processing === 0)
    }
  })

  // Best-effort: if even the final write fails (e.g. the output dir was
  // removed mid-run), there's nothing further to do —
  // check_google_ad_image_job will just report the job as not found.
  await writeChain.catch(() => {})
}

export const generateGoogleAdImages: ToolDefinition = {
  name: 'generate_google_ad_images',
  description:
    'Start a whole batch of Google Ads product photo shoots — one or more shots, each with its own shot_type/scene_prompt/aspect_ratios (and optionally its own product_image_url) — as ONE job covering the entire request, not one job per shot. Every (shot, ratio) pair is its own independent, separately generated image-edit call, run with bounded concurrency in the background. Returns immediately with a job_id and status "processing"; poll check_google_ad_image_job with that job_id for progress and results — it fills in incrementally as each shot finishes, so a big batch is never a black box mid-run. For a single image, pass one shot with one ratio.',
  input_schema: {
    type: 'object',
    properties: {
      product_image_url: {
        type: 'string',
        description:
          'Default product photo URL for any shot that doesn\'t specify its own. Required unless every entry in shots sets its own product_image_url. Most requests only ever have one photo — set it here once rather than repeating it on every shot.',
      },
      shots: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
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
                'One or more target ratios as "W:H" for this shot, each generated independently — not cropped from a shared source. Default ["1.91:1"]. Google Ads\' three standard formats: "1.91:1" (landscape), "1:1" (square), "4:5" or "9:16" (portrait).',
            },
            product_image_url: {
              type: 'string',
              description:
                'Override product photo for this one shot only — use when the request provides several photos of the product (different angles, packaging, in-context) and this particular shot should be based on a specific one rather than the top-level default. Falls back to the top-level product_image_url when omitted.',
            },
          },
          required: ['shot_type', 'scene_prompt'],
        },
        description: 'The full shot list for this batch — one entry per shot. A single-image request is just one entry.',
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'xhigh', 'max'],
        description:
          'Generation quality, also the main cost lever, applied to every shot in this batch — default "medium" (every resolution this tool ever generates at, even the lowest quality tier, already clears Google Ads\' own recommended image sizes by a wide margin, so "medium" is the cost/latency-conscious choice, not a quality compromise for what Google Ads actually needs). "xhigh"/"max" are only valid on gpt-image-2.5-sunburst/flare (the default OPENAI_IMAGE_MODEL) — gpt-image-2 and earlier only support low/medium/high and reject the other two.',
      },
    },
    required: ['shots'],
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
      throw new Error(`generate_google_ad_images: AD_IMAGE_PROVIDER must be "openai" or "google" — got "${provider}"`)
    }
    validateStorageConfig()

    const concurrencyRaw = Number(process.env.AD_IMAGE_CONCURRENCY || '4')
    const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? Math.floor(concurrencyRaw) : 4

    const defaultProductImageUrl = typeof input.product_image_url === 'string' && input.product_image_url ? input.product_image_url : undefined
    const shotsInput = Array.isArray(input.shots) ? input.shots : []
    if (shotsInput.length === 0) throw new Error('generate_google_ad_images: shots must be a non-empty array')

    const shots: ShotSpec[] = shotsInput.map((raw, i) => {
      const shotObj = (raw ?? {}) as Record<string, unknown>
      const shotType = String(shotObj.shot_type) as ShotType
      if (!(shotType in SHOT_TYPE_PREFIX)) {
        throw new Error(`generate_google_ad_images: shots[${i}].shot_type must be one of ${Object.keys(SHOT_TYPE_PREFIX).join(', ')} — got "${shotType}"`)
      }
      if (typeof shotObj.scene_prompt !== 'string' || !shotObj.scene_prompt) {
        throw new Error(`generate_google_ad_images: shots[${i}].scene_prompt is required`)
      }
      const productImageUrl =
        typeof shotObj.product_image_url === 'string' && shotObj.product_image_url ? shotObj.product_image_url : defaultProductImageUrl
      if (!productImageUrl) {
        throw new Error(
          `generate_google_ad_images: shots[${i}] has no product_image_url, and no top-level product_image_url was set as a default`,
        )
      }
      const aspectRatioSpecs =
        Array.isArray(shotObj.aspect_ratios) && shotObj.aspect_ratios.length > 0 ? shotObj.aspect_ratios.map(String) : ['1.91:1']
      const targetRatios = aspectRatioSpecs.map(parseAspectRatio) // throws synchronously on a bad ratio spec, at any shot index
      return { shotType, scenePrompt: shotObj.scene_prompt, aspectRatioSpecs, targetRatios, productImageUrl }
    })
    const quality = typeof input.quality === 'string' && input.quality ? input.quality : 'medium'

    const jobId = randomUUID()
    const createdAt = new Date().toISOString()
    const total = shots.reduce((n, shot) => n + shot.aspectRatioSpecs.length, 0)
    await writeJob(outputDir, {
      job_id: jobId,
      status: 'processing',
      created_at: createdAt,
      progress: { total, done: 0, failed: 0, processing: total },
      results: [],
    })

    // Not awaited — see runJob's own comment for why. Errors inside it
    // are caught per-unit and written into the job record itself, never
    // thrown here, since by this point the caller has already moved on.
    void runJob({ jobId, outputDir, provider, shots, quality, concurrency, createdAt })

    return JSON.stringify({ job_id: jobId, status: 'processing' })
  },
  // Each call is independent — writes its own uniquely-named job file
  // and (once each unit's background work finishes) image file(s),
  // reads nothing shared, no risk of two calls conflicting — so it's
  // fine in ToolLane's parallel lane despite not being "read-only" in
  // the usual sense that flag is for.
  safe: true,
}
