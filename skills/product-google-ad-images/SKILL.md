---
name: product-google-ad-images
description: How to plan and generate a full set of Google Ads product image assets with generate_google_ad_image — the mix of shot types, how to write a good scene_prompt, and why every call needs the real product photo.
---

# Product ad images

`generate_google_ad_image` runs one real generation per call and exports it as
every ratio you pass in `aspect_ratios` — all sharing the exact same
underlying photo, not independently regenerated per ratio (image
generation isn't deterministic; two separate calls for "the same shot"
in two ratios would drift in composition, lighting, even framing). There
is no batch-of-shots parameter, though — a good asset set is dozens of
genuinely different compositions, not the same idea repeated, so
planning the shot list is your job before you start calling the tool,
not something to hand off to the tool itself. A *full* set spans all
three of Google Ads' own image formats — see below.

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

## The three formats — and which ones share a call

Landscape and square are the *same underlying frame*, just cropped
differently (both are 1024px tall natively) — always request them
together, one call per shot:

```json
{ "aspect_ratios": ["1.91:1", "1:1"], "shot_type": "...", "scene_prompt": "..." }
```

That one call produces both a landscape and a square file, guaranteed
to be the same photo, same lighting, same composition — just framed
differently. Do **not** call the tool once for landscape and again for
square with the "same" `scene_prompt`; two separate generations are two
separate photos, not two crops of one.

Portrait is different: keep it to its **own separate call**,
`aspect_ratios: ["9:16"]` (or `["4:5"]`), with its own `scene_prompt`.
Portrait benefits from being generated at its own native vertical
canvas (taller, more resolution, room for genuinely vertical framing —
a person standing, product held up) rather than a narrow crop pulled
out of a landscape-framed photo, so intentionally trading the
cross-format consistency for real portrait composition quality.

| Format | Shots (calls) | `aspect_ratios` per call | Files produced |
| --- | --- | --- | --- |
| Landscape + Square (combined) | 18-20 | `["1.91:1", "1:1"]` | 36-40 (2 per call) |
| Portrait | 12-15 | `["9:16"]` or `["4:5"]` | 12-15 (1 per call) |

Ask which portrait ratio(s) the campaign actually needs — Google Ads
uses both `4:5` and `9:16` for different placements, and generating
both when only one is needed just burns budget. Confirm scope with the
operator before starting (all formats, or just some) rather than
assuming a full set is wanted, given each call is a real, metered
generation.

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

Each call returns a JSON array, one entry per ratio requested —
`[{ path, shot_type, aspect_ratio, width, height }, ...]`. `path` is a
real file on disk (`AD_IMAGE_OUTPUT_DIR`, default
`./generated/ad-images`), not a URL or inline image data. Report the
full list of generated paths back at the end of the batch, grouped by
format (`aspect_ratio`) and then `shot_type` within each, so the
operator can review the actual files rather than having to reconstruct
what got made from dozens of separate tool results.
