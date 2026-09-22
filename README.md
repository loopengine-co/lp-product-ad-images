# lp-product-ad-images

A [loopengine](https://github.com/loopengine-co/loopengine) ability: a
tool for generating Google-Ads-ready product images from a real product
photo, plus a skill that teaches an agent how to turn a request — a
single image, a batch of one format, or a full 18-20 image asset set —
into one shot list and one batch job, instead of only knowing how to
plan one shape of batch.

## What's in it

- **Tool** — `generate_google_ad_images(product_image_url?, shots, quality?)`.
  Starts a **whole batch as one job**, not one job per shot: `shots` is
  the full shot list for the request (one entry for a single-image
  request, dozens for a full set), each with its own `shot_type`,
  `scene_prompt`, `aspect_ratios`, and optionally its own
  `product_image_url`. Returns immediately with
  `{ job_id, status: "processing" }` instead of blocking until every
  image is ready — a batch of dozens of shots can take several minutes,
  and jobs run with bounded concurrency (`AD_IMAGE_CONCURRENCY`, default
  4 at a time) rather than firing every generation at once. Poll
  `check_google_ad_image_job({ job_id })` for progress and results:
  - `{ status: "processing", progress, results }` — `results` fills in
    incrementally as each (shot, ratio) unit finishes; check it even
    mid-run, don't wait for the job to fully settle to see what's ready.
  - `{ status: "done", progress, results }` — every unit succeeded.
  - `{ status: "partial", progress, results }` — a mix; each `results`
    entry has its own `status`/`path`/`error`, so successes and failures
    are both visible per-unit, not collapsed into one job-level verdict.
  - `{ status: "failed", progress, results }` — every unit failed (most
    often a bad API key, or every shot sharing one dead
    `product_image_url`). If different shots reference different photos,
    a dead URL only fails the shots that use it — the rest of the batch
    settles normally as `"partial"`.

  Each `results` entry is
  `{ shot_index, shot_type, aspect_ratio, product_image_url, status, path?, width?, height?, error? }`.
  `path` is where the file actually landed — a local filesystem path
  (`AD_IMAGE_OUTPUT_DIR`, the default), or (`AD_IMAGE_STORAGE=gcs`) a
  time-limited signed HTTPS URL that's actually openable in a browser,
  falling back to a bare `gs://bucket/object` URI (not openable outside
  GCP's own tooling) if the configured credentials can't sign one —
  never inline base64 either way, so a full multi-format batch doesn't
  blow the conversation's own context budget.
  The background generation sends the real product photo to an
  image-edit model along with a `shot_type`-specific instruction to keep
  the product exactly as shown — not a text-only reinterpretation of it.
  `shot_type` is one of:
  - `product_only` — clean, product-alone shot.
  - `lifestyle_product` — the product in realistic, plausible use.
  - `cover_lifestyle` — an aspirational hero/cover shot; the product is
    present but the scene carries the mood.

  `product_image_url` can be set once at the top level as the default
  every shot uses, and/or overridden per shot (`shots[].product_image_url`)
  when the request provides several photos of the product and different
  shots should be based on different ones — see the skill for how to pick
  which photo fits which shot. Each distinct URL is only ever fetched
  once per job even if many shots reference it, not once per shot.

  **Two providers**, chosen once via `AD_IMAGE_PROVIDER` (a deployment
  setting, not a per-call argument):
  - `openai` (default) — `gpt-image-2.5-sunburst` by default, configurable
    via `OPENAI_IMAGE_MODEL` (e.g. `gpt-image-2.5-flare` for faster, lower-
    precision generation). Sunburst is the default because this ability
    edits a real product photo into an ad rather than generating a scene
    from scratch, and editing precision is what keeps the product looking
    like the product. Generates at one of three fixed native pixel sizes
    (landscape 1536×1024, square 1024×1024, portrait 1024×1536).
  - `google` — Google's Gemini image models, aka "Nano Banana":
    `gemini-3.1-flash-image` (**Nano Banana 2**, the default) or
    `gemini-3-pro-image` (**Nano Banana Pro**, higher quality and cost)
    via `GOOGLE_IMAGE_MODEL`. Supports a real `aspect_ratio` parameter
    with ten presets — square and both portrait specs (`4:5`, `9:16`)
    are exact presets here, so those need no cropping at all; only
    landscape still gets a small trim from the nearest preset (`16:9`).

  Each shot's `aspect_ratios` is an array, not a single value — but each
  ratio in it is its own independent, separately generated image-edit
  call, not cropped from a shared source, so a landscape and a square
  version of "the same shot" can still drift in composition, lighting,
  even framing, exactly as two separate shots would. Combining ratios
  into one shot is a bookkeeping convenience only — each ratio is its
  own billed generation regardless. Whichever provider is active, each
  ratio's generation targets whichever native size/preset is closest to
  it, then center-crops down to the exact ratio — never upscaled or
  padded. Supports all three Google Ads image formats: `"1.91:1"`
  (landscape, the default), `"1:1"` (square), and `"4:5"`/`"9:16"`
  (portrait).

  **Storage**, chosen once via `AD_IMAGE_STORAGE` (default `local`):
  - `local` — writes each PNG under `AD_IMAGE_OUTPUT_DIR`; `path` in each
    result is a real filesystem path.
  - `gcs` — uploads each PNG to `AD_IMAGE_GCS_BUCKET` (optionally under
    `AD_IMAGE_GCS_PREFIX`) instead, then generates a V4 signed URL for it
    (valid for `AD_IMAGE_GCS_SIGNED_URL_EXPIRY` seconds, default 7 days —
    the GCS-imposed maximum) so `path` is a real `https://` link, not
    just an internal `gs://` address. Signing requires credentials that
    can actually sign (a service account key, or IAM `signBlob` via
    impersonation) — plain user Application Default Credentials from
    `gcloud auth application-default login` can't, so in that case
    `path` falls back to the bare `gs://bucket/object` URI instead (the
    upload itself still succeeds either way). Requires
    `npm install @google-cloud/storage` in your own project (lazily
    imported, so `local` users never need it). Job-status files always
    stay local under `AD_IMAGE_OUTPUT_DIR/.jobs/` regardless of this
    setting.
- **Tool** — `check_google_ad_image_job(job_id)`. Reads back the status
  of a job `generate_google_ad_images` started, from a JSON file under
  `AD_IMAGE_OUTPUT_DIR/.jobs/` — read-only, safe to poll as often as
  needed.
- **Skill** — `product-google-ad-images`: how to size a request (one
  image, a batch of one format, or a full set) into one `shots` array,
  how to read a job's incremental progress and handle a `partial`
  result, how to pick which photo fits which shot when a request
  provides more than one, a suggested shot-type mix, how to write a
  `scene_prompt` that actually varies shot to shot, and why the tool
  needs the real product photo rather than a description of it.
- **actauth rules** — `generate-google-ad-images-allowed` and
  `check-google-ad-images-job-allowed`, both `decision: allow`.
  Deliberately not gated behind a human `ask` — see the rule file's own
  comments for why (this is a cost-per-shot tool, not a destructive one,
  and the whole point is generating a full batch in one unattended run).

## Install

```
npx loopengine add-ability lp-product-ad-images --agent <your-agent>
```

Then:

1. Pick a provider and set its key (via the Admin UI's Environment tab,
   or directly in `.env`):
   - OpenAI (default, no `AD_IMAGE_PROVIDER` needed): `OPENAI_API_KEY`,
     optionally `OPENAI_IMAGE_MODEL`.
   - Google/Nano Banana: `AD_IMAGE_PROVIDER=google`, `GEMINI_API_KEY`,
     optionally `GOOGLE_IMAGE_MODEL=gemini-3-pro-image` for Nano Banana
     Pro instead of the default Nano Banana 2.
   - Optionally `AD_IMAGE_OUTPUT_DIR` if you don't want generated
     images (when storage is `local`) or job-status files (always)
     landing under `./generated/ad-images`.
   - Optionally `AD_IMAGE_STORAGE=gcs` plus `AD_IMAGE_GCS_BUCKET` (and
     optionally `AD_IMAGE_GCS_PREFIX`, `AD_IMAGE_GCS_SIGNED_URL_EXPIRY`)
     to upload images to GCS instead of writing them locally. Use a
     service account key (`GOOGLE_APPLICATION_CREDENTIALS` pointing at
     one) rather than plain user ADC if you want real signed URLs back —
     see the tool's own description above for what happens otherwise.
   - Optionally `AD_IMAGE_CONCURRENCY` (default `4`) to raise or lower
     how many generations one batch job runs at once — tune it against
     your actual provider rate limits.
2. `npm install sharp` in your own project — this ability's tool uses
   it for the center-crop step, for both providers and both storage
   backends. If you set `AD_IMAGE_STORAGE=gcs`, also
   `npm install @google-cloud/storage`. Installing an ability copies
   its files in, it doesn't manage your project's own `package.json`,
   so these are one-time manual steps (see loopengine's own
   `ABILITIES.md` on why abilities are copied rather than imported).
3. If using `local` storage, add wherever generated images land
   (`AD_IMAGE_OUTPUT_DIR`, default `generated/ad-images`) to your
   project's own `.gitignore` if you don't want to commit generated
   creative. Either way, that same directory's `.jobs/` subdirectory
   holds job-status files and is worth ignoring too.

Every shot costs real money against whichever provider/model you've
configured — see the actauth rule's own comment if you want a per-batch
approval instead of the default unattended behavior.

A job keeps running only as long as the agent process that started it
stays alive — fine under a long-lived server (`npx loopengine
dev`/`serve`), but a job started right before a short-lived, single-shot
CLI invocation exits may never get the chance to finish.

## Example requests

The agent — not the end user — constructs this JSON: a user just says
something like "generate a full set from this photo" in plain language,
and the skill guides the agent through sizing that into a `shots` array
and writing each `scene_prompt`. These are what the agent ends up
calling `generate_google_ad_images` with, for a few different request
shapes:

**"Generate one landscape image with product_only style from this
image: `https://cdn.example.com/mug.png`"**

```json
{
  "product_image_url": "https://cdn.example.com/mug.png",
  "shots": [
    { "shot_type": "product_only", "scene_prompt": "on a clean marble countertop, soft natural window light, straight-on angle", "aspect_ratios": ["1.91:1"] }
  ]
}
```

**"Generate a batch of 6 landscape images"** (no style specified —
the agent applies the shot-type mix itself)

```json
{
  "product_image_url": "https://cdn.example.com/mug.png",
  "shots": [
    { "shot_type": "product_only", "scene_prompt": "flat lay, marble surface, overhead angle", "aspect_ratios": ["1.91:1"] },
    { "shot_type": "product_only", "scene_prompt": "three-quarter angle on dark wood, studio lighting", "aspect_ratios": ["1.91:1"] },
    { "shot_type": "lifestyle_product", "scene_prompt": "hand reaching for the mug on a kitchen counter, morning light", "aspect_ratios": ["1.91:1"] },
    { "shot_type": "lifestyle_product", "scene_prompt": "mug mid-use on a desk beside a laptop, soft afternoon light", "aspect_ratios": ["1.91:1"] },
    { "shot_type": "cover_lifestyle", "scene_prompt": "cozy reading nook, blanket, rain on the window, mug on the armrest", "aspect_ratios": ["1.91:1"] },
    { "shot_type": "cover_lifestyle", "scene_prompt": "outdoor patio at sunrise, steam rising from the mug", "aspect_ratios": ["1.91:1"] }
  ]
}
```

**"Generate 4 portrait images at 9:16 for Performance Max"**

```json
{
  "product_image_url": "https://cdn.example.com/mug.png",
  "shots": [
    { "shot_type": "product_only", "scene_prompt": "centered on a pedestal, vertical studio backdrop", "aspect_ratios": ["9:16"] },
    { "shot_type": "lifestyle_product", "scene_prompt": "held upright in hand, tiled kitchen wall behind", "aspect_ratios": ["9:16"] },
    { "shot_type": "cover_lifestyle", "scene_prompt": "tall bookshelf backdrop, mug on a side table, evening lamp light", "aspect_ratios": ["9:16"] },
    { "shot_type": "cover_lifestyle", "scene_prompt": "standing on a windowsill, city skyline blurred behind", "aspect_ratios": ["9:16"] }
  ]
}
```

**"Generate a full Google Ads image set from this photo"** — still
**one** call and one `job_id`, `shots` combining every format:

```json
{
  "product_image_url": "https://cdn.example.com/mug.png",
  "shots": [
    { "shot_type": "product_only", "scene_prompt": "flat lay, marble surface", "aspect_ratios": ["1.91:1", "1:1"] },
    { "shot_type": "product_only", "scene_prompt": "three-quarter angle, dark wood", "aspect_ratios": ["1.91:1", "1:1"] },
    { "shot_type": "lifestyle_product", "scene_prompt": "hand reaching for it on a counter", "aspect_ratios": ["1.91:1", "1:1"] },
    { "shot_type": "cover_lifestyle", "scene_prompt": "cozy reading nook, rain on the window", "aspect_ratios": ["1.91:1", "1:1"] },
    { "shot_type": "product_only", "scene_prompt": "centered on a pedestal, vertical backdrop", "aspect_ratios": ["9:16"] },
    { "shot_type": "lifestyle_product", "scene_prompt": "held upright, tiled kitchen wall", "aspect_ratios": ["9:16"] },
    { "shot_type": "cover_lifestyle", "scene_prompt": "windowsill, city skyline blurred behind", "aspect_ratios": ["9:16"] }
  ]
}
```
(Shown abbreviated — a real full set repeats this pattern out to 18-20
landscape+square shots and 12-15 portrait shots, ~30-35 entries total.)

**"Generate 3 draft square images, doesn't need to be high quality"**

```json
{
  "product_image_url": "https://cdn.example.com/mug.png",
  "shots": [
    { "shot_type": "product_only", "scene_prompt": "flat lay, plain white background", "aspect_ratios": ["1:1"] },
    { "shot_type": "product_only", "scene_prompt": "three-quarter angle, light gray background", "aspect_ratios": ["1:1"] },
    { "shot_type": "lifestyle_product", "scene_prompt": "on a desk beside a notebook", "aspect_ratios": ["1:1"] }
  ],
  "quality": "low"
}
```
`quality` applies to every shot in the batch — there's no per-shot
override.

**"Generate a batch using these three photos — front, packaging, and
in-hand — pick whichever fits each shot"**

```json
{
  "product_image_url": "https://cdn.example.com/mug-front.png",
  "shots": [
    { "shot_type": "product_only", "scene_prompt": "flat lay, marble surface", "aspect_ratios": ["1:1"], "product_image_url": "https://cdn.example.com/mug-front.png" },
    { "shot_type": "product_only", "scene_prompt": "boxed, on a shipping table", "aspect_ratios": ["1:1"], "product_image_url": "https://cdn.example.com/mug-packaging.png" },
    { "shot_type": "lifestyle_product", "scene_prompt": "held over a kitchen counter, morning light", "aspect_ratios": ["1:1"], "product_image_url": "https://cdn.example.com/mug-inhand.png" }
  ]
}
```
The top-level `product_image_url` here acts as the fallback for any
shot that doesn't set its own — every shot above happens to override it,
but it wouldn't need to if one shot were fine using the default photo.

**"Generate a batch for our Women's Running Shoes collection"** — three
*different* shoe models (not just colorways of one shoe), but still one
closely related collection sharing a theme and landing page, so it's
still **one job** (it maps to one Google Ads asset group), with the
specific model rotated across shots rather than one dominating:

```json
{
  "shots": [
    { "shot_type": "product_only", "scene_prompt": "flat lay, studio white background", "aspect_ratios": ["1:1"], "product_image_url": "https://cdn.example.com/velocity-trainer.png" },
    { "shot_type": "product_only", "scene_prompt": "three-quarter angle, studio white background", "aspect_ratios": ["1:1"], "product_image_url": "https://cdn.example.com/trail-runner-pro.png" },
    { "shot_type": "product_only", "scene_prompt": "top-down, laces untied", "aspect_ratios": ["1:1"], "product_image_url": "https://cdn.example.com/cloud-cushion.png" },
    { "shot_type": "lifestyle_product", "scene_prompt": "worn on a morning trail run, dawn light", "aspect_ratios": ["1:1"], "product_image_url": "https://cdn.example.com/trail-runner-pro.png" },
    { "shot_type": "lifestyle_product", "scene_prompt": "laced up in a gym locker room", "aspect_ratios": ["1:1"], "product_image_url": "https://cdn.example.com/velocity-trainer.png" },
    { "shot_type": "cover_lifestyle", "scene_prompt": "runner mid-stride on a city street at sunrise", "aspect_ratios": ["1:1"], "product_image_url": "https://cdn.example.com/cloud-cushion.png" }
  ]
}
```
Unrelated products (different category, different landing page) should
instead be separate `generate_google_ad_images` calls — one job, and
one report, per product. See the skill's "Multiple product photos"
section for the full reasoning.

## Upgrading

```
npx loopengine upgrade-ability lp-product-ad-images --agent <your-agent>
```

See loopengine's own `ABILITIES.md` for how abilities, installs, and
upgrades work in general.
