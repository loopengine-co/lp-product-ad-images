---
name: product-google-ad-images
description: How to turn a request — one image, a batch of one format, or a full asset set — into generate_google_ad_image calls, how to poll check_google_ad_image_job for the result, plus the shot-type mix, how to write a good scene_prompt, and why every call needs the real product photo.
---

# Product ad images

`generate_google_ad_image` starts one independent, real generation for
*each* ratio you pass in `aspect_ratios` — never one shared generation
cropped down to the rest, for either provider. Two ratios from the same
call can still come out with different composition, lighting, even
framing, exactly as two separate calls would (image generation isn't
deterministic) — passing several ratios in one call is purely a
bookkeeping convenience (one `job_id` covers all of them), not a way to
get matching content or to save cost; each ratio is its own billed
generation regardless of how you group them. The tool returns
immediately with that `job_id`, not the finished images — see "Starting
a job and getting the result" below for the poll loop. There is no
batch-of-shots parameter, though — a good asset set is dozens of
genuinely different compositions, not the same idea repeated, so
planning the shot list is your job before you start calling the tool,
not something to hand off to the tool itself. A *full* set spans all
three of Google Ads' own image formats — see below.

## Sizing the request

Requests come in at three different scopes — read which one you got before
planning anything, since each implies a different amount of work:

- **"Generate one/a single `<format>` image..."** (optionally "with `<style>`
  style") — exactly one call. Map the format to `aspect_ratios` (table
  below), take `shot_type` from the wording if it named one (default
  `product_only` if not), and write the `scene_prompt` yourself if none was
  given — don't stop to demand a creative brief for a single image; a
  reasonable scene beats no image. Return that one result.
- **"Generate a batch (N) of `<format>` images..."** — N calls, all at that
  one format only. A request scoped to one format stays scoped to it — don't
  fold in the other formats just because the full-set table below combines
  landscape+square elsewhere. Apply the shot-type mix below across the N
  calls, and give each its own distinct `scene_prompt`; N images sharing one
  scene defeats the point of a batch.
- **"Generate a full Google Ads image set..."** (or "all formats",
  "everything") — the whole three-format batch: 18-20 landscape+square
  (combined calls) plus 12-15 portrait, per the table below.

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

## Starting a job and getting the result

Every `generate_google_ad_image` call returns right away —
`{ "job_id": "...", "status": "processing" }` — before the actual image
exists. The real work (fetching the product photo, the provider call,
cropping) keeps running in the background; a single generation can take
up to a minute or more, longer at high quality. Poll
`check_google_ad_image_job({ "job_id": "..." })` to find out when it's
ready:

- `{ "status": "processing" }` — not ready yet, check again shortly.
- `{ "status": "done", "result": [...] }` — `result` is the same array
  shape `generate_google_ad_image` used to return directly:
  `[{ path, shot_type, aspect_ratio, width, height }, ...]`.
- `{ "status": "failed", "error": "..." }` — the generation itself
  errored (bad product URL, provider error, etc.); report the error
  rather than retrying blindly, since most causes (a dead image URL, a
  missing API key) won't fix themselves on a second attempt.

For a single-image request, start the one job, then poll it until
`done`/`failed` before reporting back. For a batch, start *all* the
jobs for that batch first, then poll the outstanding ones — this is the
actual reason the tool is job-based rather than blocking: a batch of 18
images no longer has to wait for each generation to finish before the
next one starts, so the whole batch's wall-clock time is close to one
generation's time, not 18 of them stacked end to end.

This background work only continues for as long as the underlying agent
process stays running — fine for a long-lived server (`npx loopengine
dev`/`serve`), but a job started right before a short-lived, single-shot
CLI invocation exits may never get the chance to finish.

## Why image-edit, not text-to-image

Every call is a real edit of the actual `product_image_url` you pass in,
not a text description of the product. Each shot-type prompt explicitly
tells the model to keep the product exactly as shown in that reference
image — same shape, colors, proportions, any printed text or logo. Do
not try to describe the product yourself in `scene_prompt`; the
reference image already establishes what it looks like, and repeating a
text description of it just invites the model to drift from the real
thing. `scene_prompt` is for the *scene* only: where it is, what's
around it, the lighting, the mood.

## The three formats

Every format — landscape, square, portrait — is generated at its own
native size/preset regardless of how you group them into calls, since
generating at the ratio's own native canvas (rather than cropping it out
of a different one) keeps the most composition and resolution for that
ratio. There's no format-pairing rule anymore: grouping landscape and
square into one call, like this,

```json
{ "aspect_ratios": ["1.91:1", "1:1"], "shot_type": "...", "scene_prompt": "..." }
```

produces two files from **two independent generations**, not one shared
photo cropped two ways — grouping them just means one `job_id` to poll
for both instead of two. Group ratios in one call when that's simpler to
track; call once per ratio when you'd rather poll each independently
(e.g. so a slow portrait generation doesn't hold up reporting the
landscape one that already finished).

| Format | Shots | `aspect_ratios` per shot | Generations (billed) | Files produced |
| --- | --- | --- | --- | --- |
| Landscape + Square (grouped per shot) | 18-20 | `["1.91:1", "1:1"]` | 36-40 (2 per shot) | 36-40 |
| Portrait | 12-15 | `["9:16"]` or `["4:5"]` | 12-15 (1 per shot) | 12-15 |

Google Ads uses both `4:5` and `9:16` for different placements — see
"Sizing the request" above for when to ask which one versus just picking.

## The shot-type mix

Apply this mix separately to the landscape+square shot list and to the
portrait shot list above — a reasonable starting split, adjust based on
what the product and campaign actually call for, this isn't a fixed
formula:

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

Once every job in the batch reports `done` (or `failed`), each `result`
entry's `path` is where the file actually landed — a local filesystem
path under `AD_IMAGE_OUTPUT_DIR` by default, or a `gs://bucket/object`
URI if the deployment has `AD_IMAGE_STORAGE=gcs` set — never a URL or
inline image data either way. Report the full list of generated paths
back at the end of the batch, grouped by format (`aspect_ratio`) and
then `shot_type` within each, so the operator can review the actual
files rather than having to reconstruct what got made from dozens of
separate job results. Call out any `failed` jobs by their `error`
rather than silently dropping them from the report.
