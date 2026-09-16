# lp-product-ad-images

A [loopengine](https://github.com/loopengine-co/loopengine) ability: a
tool for generating Google-Ads-ready product images from a real product
photo, plus a skill that teaches an agent how to plan a full 18-20 image
asset set instead of just generating one shot at a time.

## What's in it

- **Tool** — `generate_ad_image(product_image_url, shot_type, scene_prompt, aspect_ratios?, quality?)`.
  Fetches the real product photo and sends it to OpenAI's image-edit
  endpoint (`gpt-image-1` by default, configurable) along with a
  `shot_type`-specific instruction to keep the product exactly as shown
  — not a text-only reinterpretation of it. `shot_type` is one of:
  - `product_only` — clean, product-alone shot.
  - `lifestyle_product` — the product in realistic, plausible use.
  - `cover_lifestyle` — an aspirational hero/cover shot; the product is
    present but the scene carries the mood.

  `aspect_ratios` is an array, not a single value — every ratio in it
  is exported from the *same* generation, so a landscape and a square
  version of one shot are guaranteed to share the same photo, not two
  independently (and non-deterministically) regenerated ones. The model
  only generates at three fixed native sizes (landscape 1536×1024,
  square 1024×1024, portrait 1024×1536); the tool picks whichever is
  closest to the *widest* requested ratio and center-crops each
  requested ratio down from that one generation — never upscaled or
  padded. Supports all three Google Ads image formats: `"1.91:1"`
  (landscape), `"1:1"` (square, defaults to `["1.91:1"]` if omitted),
  and `"4:5"`/`"9:16"` (portrait — best kept to its own call rather
  than combined with landscape/square, since it benefits from its own
  native vertical canvas; see the skill for why). Returns a JSON array,
  one entry per ratio: `[{ path, shot_type, aspect_ratio, width,
  height }, ...]` — `path` is a real file written to disk
  (`AD_IMAGE_OUTPUT_DIR`), not a URL or inline base64, so a full
  multi-format batch doesn't blow the conversation's own context
  budget.
- **Skill** — `product-ad-images`: which ratios to combine in one call
  vs. keep separate, a suggested shot-type mix, how to write a
  `scene_prompt` that actually varies shot to shot, and why the tool
  needs the real product photo rather than a description of it.
- **actauth rule** — `generate-ad-image-allowed`, `decision: allow`.
  Deliberately not gated behind a human `ask` — see the rule file's own
  comment for why (this is a cost-per-call tool, not a destructive one,
  and the whole point is generating a full batch in one unattended run).

## Install

```
npx loopengine add-ability lp-product-ad-images --agent <your-agent>
```

Then:

1. Set `OPENAI_API_KEY` (via the Admin UI's Environment tab, or
   directly in `.env`). Optionally set `OPENAI_IMAGE_MODEL` if you want
   a different image model than the default (`gpt-image-1`), and
   `AD_IMAGE_OUTPUT_DIR` if you don't want generated images landing
   under `./generated/ad-images`.
2. `npm install sharp` in your own project — this ability's tool uses
   it for the center-crop step. Installing an ability copies its files
   in, it doesn't manage your project's own `package.json`, so this is
   a one-time manual step (see loopengine's own `ABILITIES.md` on why
   abilities are copied rather than imported).
3. Add wherever generated images land (`AD_IMAGE_OUTPUT_DIR`, default
   `generated/ad-images`) to your project's own `.gitignore` if you
   don't want to commit generated creative.

Every call costs real money against whichever OpenAI image model you've
configured — see the actauth rule's own comment if you want a per-image
approval instead of the default unattended-batch behavior.

## Upgrading

```
npx loopengine upgrade-ability lp-product-ad-images --agent <your-agent>
```

See loopengine's own `ABILITIES.md` for how abilities, installs, and
upgrades work in general.
