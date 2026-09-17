---
name: product-google-ad-images
description: How to turn a request — one image, a batch of one format, or a full asset set — into one generate_google_ad_images call with a full shot list, how to poll check_google_ad_image_job for progress and results, plus the shot-type mix, how to write a good scene_prompt, and why every shot needs the real product photo.
---

# Product ad images

`generate_google_ad_images` takes the **whole shot list for the request** —
one or more shots, each its own `shot_type`/`scene_prompt`/`aspect_ratios` —
in a single call, and tracks the entire thing as **one job**, not one job per
shot. Every (shot, ratio) pair is still its own independent, real generation
under the hood — two shots, or two ratios of the same shot, can still come
out with different composition, lighting, even framing, exactly as separate
calls would (image generation isn't deterministic) — grouping them into one
call only changes how many `job_id`s you have to track, never how many
billed generations happen or whether they match each other.

The tool returns immediately with that one `job_id`, not the finished
images — see "Starting the job and polling it" below. Planning the shot
list itself (how many shots, what mix of `shot_type`s, what each
`scene_prompt` says) is still your job before you call the tool — a good
asset set is dozens of genuinely different compositions, not the same idea
repeated, and the tool has no opinion on what makes a good shot list, only
on how to execute one.

## Sizing the request

Requests come in at three different scopes — read which one you got before
building the shot list, since each implies a different `shots` array:

- **"Generate one/a single `<format>` image..."** (optionally "with `<style>`
  style") — one call, `shots` has exactly one entry. Map the format to
  `aspect_ratios` (table below), take `shot_type` from the wording if it
  named one (default `product_only` if not), and write the `scene_prompt`
  yourself if none was given — don't stop to demand a creative brief for a
  single image; a reasonable scene beats no image.
- **"Generate a batch (N) of `<format>` images..."** — one call, `shots` has
  N entries, all at that one format's `aspect_ratios` only. A request
  scoped to one format stays scoped to it — don't fold in the other formats
  just because the full-set table below combines landscape+square
  elsewhere. Apply the shot-type mix below across the N entries, and give
  each its own distinct `scene_prompt`; N shots sharing one scene defeats
  the point of a batch.
- **"Generate a full Google Ads image set..."** (or "all formats",
  "everything") — still **one call**: `shots` has every entry from both
  rows of the table below combined — 18-20 entries at
  `["1.91:1", "1:1"]` plus 12-15 entries at `["9:16"]` (or `["4:5"]`) — all
  in the same `shots` array, all under the one job this call starts.

Only ask the operator something before generating when it would actually
change what you'd otherwise do — the product's category/audience if neither
is obvious from the image or title and the shot mix would look wrong without
it, or which portrait ratio (`4:5` vs `9:16`) if the request needs portrait
and doesn't say which. Don't ask just to reconfirm a scope the request
already stated plainly; when scope genuinely isn't stated at all, default to
assuming the full set is wanted rather than guessing at a smaller one.

| Say | `aspect_ratios` |
| --- | --- |
| "landscape" | `["1.91:1"]` |
| "square" | `["1:1"]` |
| "landscape and square" (or the full-set landscape row) | `["1.91:1", "1:1"]` |
| "portrait" | `["9:16"]` or `["4:5"]` — ask only if both are plausible and the request doesn't say |

## Starting the job and polling it

One call starts the whole thing:

```json
{
  "product_image_url": "https://...",
  "shots": [
    { "shot_type": "product_only", "scene_prompt": "...", "aspect_ratios": ["1.91:1", "1:1"] },
    { "shot_type": "lifestyle_product", "scene_prompt": "...", "aspect_ratios": ["1.91:1", "1:1"] },
    { "shot_type": "cover_lifestyle", "scene_prompt": "...", "aspect_ratios": ["9:16"] }
  ]
}
```

It returns immediately — `{ "job_id": "...", "status": "processing" }` —
before any image exists. The real work (fetching the product photo once,
then every shot's every ratio as its own generation, a few at a time in the
background) keeps running after the call returns; a batch of dozens of
shots can take several minutes. Poll
`check_google_ad_image_job({ "job_id": "..." })` to track it:

```json
{
  "status": "processing",
  "progress": { "total": 36, "done": 22, "failed": 1, "processing": 13 },
  "results": [
    { "shot_index": 0, "shot_type": "product_only", "aspect_ratio": "1.91:1", "product_image_url": "https://...", "status": "done", "path": "...", "width": 1536, "height": 804 },
    { "shot_index": 3, "shot_type": "lifestyle_product", "aspect_ratio": "1:1", "product_image_url": "https://...", "status": "failed", "error": "..." }
  ]
}
```

`results` fills in incrementally as each (shot, ratio) unit finishes — check
it even while `status` is still `"processing"` to see what's already ready,
rather than treating the whole job as opaque until the end. `status`
settles once `progress.processing` hits 0:

- `"done"` — every unit succeeded.
- `"partial"` — a mix; some units are `"done"` (with a real `path`), some
  are `"failed"` (with their own `error`). Don't wait for `"done"` before
  reporting a `"partial"` batch — the images that succeeded are real and
  usable; call out the failed ones by their `error` rather than silently
  dropping them.
- `"failed"` — every unit failed (most often a missing/invalid API key, or
  every shot sharing one dead `product_image_url`). If different shots use
  different photos, a dead URL only fails the shots that reference it —
  the rest of the batch settles normally, landing on `"partial"` instead.

This background work only continues for as long as the underlying agent
process stays running — fine for a long-lived server (`npx loopengine
dev`/`serve`), but a job started right before a short-lived, single-shot
CLI invocation exits may never get the chance to finish.

## Why image-edit, not text-to-image

Every shot is a real edit of an actual product photo, not a text
description of the product. Each shot-type prompt explicitly tells the
model to keep the product exactly as shown in that reference image —
same shape, colors, proportions, any printed text or logo. Do not try
to describe the product yourself in `scene_prompt`; the reference image
already establishes what it looks like, and repeating a text
description of it just invites the model to drift from the real thing.
`scene_prompt` is for the *scene* only: where it is, what's around it,
the lighting, the mood.

## Multiple product photos

Most requests only ever hand over one photo — set `product_image_url`
once at the top level, and every shot uses it by default. When a request
provides *several* photos of the same product (different angles,
packaging, already-in-context shots), pick which one fits each shot
deliberately with that shot's own `product_image_url`, rather than
reusing one photo for everything or picking randomly:

- A clean product-alone photo (plain background, no hands/props) fits
  `product_only` shots best.
- A photo that already shows the product being held or in a real setting
  fits `lifestyle_product` shots — the model has less reinterpreting to
  do when the reference is already close to the target composition.
- Whichever photo best represents the product's overall identity (the
  one that would work as a listing's main image) is usually the safest
  default for `cover_lifestyle` shots, unless a more scene-appropriate
  photo is obviously available.

If it's not obvious from context (filenames, alt text, how the operator
described each one) which photo is which, ask rather than guessing —
a mismatched photo/shot pairing (e.g. a boxed/packaging photo used for a
shot meant to show the product in use) produces a worse result than
just using the default for every shot. Every `results` entry from
`check_google_ad_image_job` reports which `product_image_url` it
actually used, so a mismatch is traceable after the fact too.

**A closely-related collection** (e.g. a "Women's Running Shoes" line
with several genuinely different models, not just colorways of one shoe)
is a different case from "one product, several reference photos" above,
but still belongs in **one job**: Google Ads
itself normally treats a tightly related collection as a single asset
group (one theme, one landing page), so one shot list spanning the whole
collection maps correctly to what actually gets uploaded. What matters
here is *rotating* which item's photo gets used across the shot list —
don't let one SKU's photo end up in 90% of the shots with the others
making a token appearance; spread each item across the `product_only`/
`lifestyle_product`/`cover_lifestyle` mix roughly evenly so the finished
set actually represents the whole collection, not mostly one item with
a few reskins.

**Genuinely unrelated products**, though, don't belong in one job at
all — different categories, different landing pages, different campaign
themes. Bundling those together makes the job's aggregate `status`
useless (a `"partial"` spanning two unrelated products tells you nothing
about either one individually) and scrambles the "group by format, then
shot_type" reporting below across products that have nothing to do with
each other. For that case, call `generate_google_ad_images` once per
product — separate jobs, separate `job_id`s, separate reports.

## The three formats

Every format — landscape, square, portrait — is generated at its own
native size/preset regardless of how shots are grouped, since generating at
the ratio's own native canvas (rather than cropping it out of a different
one) keeps the most composition and resolution for that ratio. There's no
format-pairing rule: a shot with `aspect_ratios: ["1.91:1", "1:1"]`
produces two files from **two independent generations**, not one shared
photo cropped two ways — combining ratios into one shot just means one
`shot_index`'s worth of results to read together, not a cost or
consistency shortcut.

| Format | Shots | `aspect_ratios` per shot | Generations (billed) | Files produced |
| --- | --- | --- | --- | --- |
| Landscape + Square (grouped per shot) | 18-20 | `["1.91:1", "1:1"]` | 36-40 (2 per shot) | 36-40 |
| Portrait | 12-15 | `["9:16"]` or `["4:5"]` | 12-15 (1 per shot) | 12-15 |

Google Ads uses both `4:5` and `9:16` for different placements — see
"Sizing the request" above for when to ask which one versus just picking.

## The shot-type mix

Apply this mix separately to the landscape+square shots and to the
portrait shots in the `shots` array — a reasonable starting split, adjust
based on what the product and campaign actually call for, this isn't a
fixed formula:

- **`product_only`** (~35% of that format's count): clean, no ambiguity
  about what's for sale. Vary the surface, background color/texture,
  and camera angle across these — flat lay, three-quarter angle,
  straight-on — so they don't read as the same shot repeated.
- **`lifestyle_product`** (~35%): the product in real, plausible use.
  Vary the setting and who/what is interacting with it (a hand reaching
  for it, it sitting mid-use on a counter, etc.) — this is where most
  of the "does someone actually want this" persuasion in an ad image
  set comes from.
- **`cover_lifestyle`** (~30%): the hero/cover shots — aspirational
  scenes where the product is present but the mood of the scene is
  doing the work, not a tight product close-up. These are what a
  campaign's top-performing creative is usually built around.

Ask the operator for the product's category and target audience first
if neither is obvious from context — a kitchen gadget's lifestyle shots
look nothing like a skincare product's, and a generic prompt produces
generic (and less effective) ad creative either way.

## Writing a good `scene_prompt`

Be concrete about the same things a real photo brief would specify:

- **Setting** — where, specifically (a sunlit kitchen counter, not just
  "kitchen"; a gym locker room, not just "gym").
- **Styling** — what else is in frame and why (props that make sense
  for the product's actual use case, not generic clutter).
- **Lighting/mood** — morning light, moody evening, bright and clean
  studio — this does more to make 18-20 images look like a real,
  varied set than almost anything else.
- **Composition**, only if it matters for this shot — off-center,
  close crop, negative space for ad text overlay.

Keep each `scene_prompt` to one clear idea. A prompt trying to cover
three different moods at once tends to produce a muddled result, not
three ideas blended well.

## After generating

Once the job's `status` is `"done"` or `"partial"` (see "Starting the job
and polling it" above for when to stop polling), each successful `results`
entry's `path` is where the file actually landed — a local filesystem
path under `AD_IMAGE_OUTPUT_DIR` by default, or a `gs://bucket/object`
URI if the deployment has `AD_IMAGE_STORAGE=gcs` set — never a URL or
inline image data either way. Report the full list of generated paths
back, grouped by format (`aspect_ratio`) and then `shot_type` within
each, so the operator can review the actual files rather than having to
reconstruct what got made from one long `results` array. Call out any
`failed` entries by their `error` rather than silently dropping them
from the report.
