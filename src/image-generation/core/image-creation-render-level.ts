// src/server/image/image-creation-render-level.ts
//
// Server-side provider configuration for the image-creation prompt compiler.
// renderLevel decides how many sections the structured renderer in
// `prompt-builder.ts` emits — it is NEVER exposed to the frontend, the form,
// or the URL. Routes import the helper below to pick a level by provider id.
//
// Lives in its own file (rather than inside route.ts or model-factory.ts) so
// "added a new provider but forgot to map a renderLevel" is a single-point
// edit that's easy to catch in code review. The fallback `console.warn` makes
// the omission visible at runtime instead of silently shipping `full`.

import type { ImageProviderId } from "./types";

export type ImageCreationRenderLevel = "full" | "compact" | "minimal";

const IMAGE_CREATION_RENDER_LEVEL_BY_PROVIDER: Partial<
  Record<ImageProviderId, ImageCreationRenderLevel>
> = {
  "openai-gpt-image": "full",
  "apifox-zq2-pro-plus": "full",
  "atlas-gpt": "full",
  "gemini-nano-banana": "full",
  "atlas-wan": "full",
  "atlas-seedream-pro": "full",
};

export function imageCreationRenderLevelForProvider(
  provider: ImageProviderId,
): ImageCreationRenderLevel {
  const level = IMAGE_CREATION_RENDER_LEVEL_BY_PROVIDER[provider];
  if (!level) {
    console.warn(
      `[image-creation] no renderLevel mapping for provider "${provider}", falling back to "full"`,
    );
    return "full";
  }
  return level;
}
