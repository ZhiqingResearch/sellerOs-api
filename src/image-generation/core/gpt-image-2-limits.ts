// src/image-generation/core/gpt-image-2-limits.ts
//
// Ported verbatim from amazon-agent
// src/components/ai-creative/image-creation/size-validation.ts (constant only).
// Mirrors the gpt-image-2 dimension constraints from the model info card:
//   - both sides must be integer multiples of 16
//   - longest side ≤ 3840
//   - long-side : short-side ratio ≤ 3:1
//   - 655,360 ≤ width × height ≤ 8,294,400
// The prd-size-support spec uses it to assert the target size registry stays
// inside the model's documented envelope.

export const GPT_IMAGE_2_LIMITS = {
  multipleOf: 16,
  maxEdge: 3840,
  maxAspectRatio: 3,
  minPixels: 655_360,
  maxPixels: 8_294_400,
} as const;
