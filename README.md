# lp-product-ad-images

A [loopengine](https://github.com/loopengine-co/loopengine) ability: a
tool for generating Google-Ads-ready product images from a real product
photo, plus a skill that teaches an agent how to turn a request — a
single image, a batch of one format, or a full 18-20 image asset set —
into the right calls, instead of only knowing how to plan one shape of
batch.

## What's in it

- **Tool** — `generate_google_ad_image(product_image_url, shot_type, scene_prompt, aspect_ratios?, quality?)`.
  Fetches the real product photo and sends it to an image-edit model
  along with a `shot_type`-specific instruction to keep the product
  exactly as shown — not a text-only reinterpretation of it. `shot_type`
  is one of:
  - `product_only` — clean, product-alone shot.
  - `lifestyle_product` — the product in realistic, plausible use.
  - `cover_lifestyle` — an aspirational hero/cover shot; the product is
    present but the scene carries the mood.

  **Two providers**, chosen once via `AD_IMAGE_PROVIDER` (a deployment
  setting, not a per-call argument):
  - `openai` (default) — `gpt-image-1` by default, configurable via
    `OPENAI_IMAGE_MODEL`. Generates at one of three fixed native pixel
    sizes (landscape 1536×1024, square 1024×1024, portrait 1024×1536).
  - `google` — Google's Gemini image models, aka "Nano Banana":
    `gemini-3.1-flash-image` (**Nano Banana 2**, the default) or
    `gemini-3-pro-image` (**Nano Banana Pro**, higher quality and cost)
    via `GOOGLE_IMAGE_MODEL`. Supports a real `aspect_ratio` parameter
    with ten presets — square and both portrait specs (`4:5`, `9:16`)
    are exact presets here, so those need no cropping at all; only
    landscape still gets a small trim from the nearest preset (`16:9`).

  `aspect_ratios` is an array, not a single value, for either provider —
  every ratio in it is exported from the *same* generation, so a
  landscape and a square version of one shot are guaranteed to share
  the same photo, not two independently (and non-deterministically)
  regenerated ones. Whichever provider is active, the tool picks the
  generation closest to the *widest* requested ratio and center-crops
  each requested ratio down from that one generation — never upscaled
  or padded. Supports all three Google Ads image formats: `"1.91:1"`
  (landscape, the default), `"1:1"` (square), and `"4:5"`/`"9:16"`
  (portrait — best kept to its own call rather than combined with
  landscape/square, since it benefits from its own native vertical
  canvas; see the skill for why). Returns a JSON array, one entry per
  ratio: `[{ path, shot_type, aspect_ratio, width, height }, ...]` —
  `path` is a real file written to disk (`AD_IMAGE_OUTPUT_DIR`), not a
  URL or inline base64, so a full multi-format batch doesn't blow the
  conversation's own context budget.
- **Skill** — `product-google-ad-images`: how to size a request (one
  image, a batch of one format, or a full set) into the right number of
  calls, which ratios to combine in one call vs. keep separate, a
  suggested shot-type mix, how to write a `scene_prompt` that actually
  varies shot to shot, and why the tool needs the real product photo
  rather than a description of it.
- **actauth rule** — `generate-google-ad-image-allowed`, `decision: allow`.
  Deliberately not gated behind a human `ask` — see the rule file's own
  comment for why (this is a cost-per-call tool, not a destructive one,
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
     images landing under `./generated/ad-images`.
2. `npm install sharp` in your own project — this ability's tool uses
   it for the center-crop step, for both providers. Installing an
   ability copies its files in, it doesn't manage your project's own
   `package.json`, so this is a one-time manual step (see loopengine's
   own `ABILITIES.md` on why abilities are copied rather than imported).
3. Add wherever generated images land (`AD_IMAGE_OUTPUT_DIR`, default
   `generated/ad-images`) to your project's own `.gitignore` if you
   don't want to commit generated creative.

Every call costs real money against whichever provider/model you've
configured — see the actauth rule's own comment if you want a per-image
approval instead of the default unattended-batch behavior.

## Upgrading

```
npx loopengine upgrade-ability lp-product-ad-images --agent <your-agent>
```

See loopengine's own `ABILITIES.md` for how abilities, installs, and
upgrades work in general.
