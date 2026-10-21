export const RPA_MEDIA_TYPES = ["IMAGE", "VIDEO"] as const
export type RpaMediaType = (typeof RPA_MEDIA_TYPES)[number]

export const RPA_IMAGE_MODELS = ["NANO_BANANA_PRO", "NANO_BANANA_2", "NANO_BANANA_2_LITE"] as const

export const RPA_VIDEO_MODELS = [
  "OMNI_1_1_FLASH",
  "VEO_3_1_LITE",
  "VEO_3_1_FAST",
  "VEO_3_1_QUALITY",
] as const

export const RPA_TASK_STATUSES = ["PENDING", "SUCCESS", "TIMEOUT", "CANCELLED"] as const
export type RpaTaskStatus = (typeof RPA_TASK_STATUSES)[number]

export const RPA_OUTPUT_STATUSES = ["PENDING", "GENERATING", "SUCCESS", "FAILED"] as const

export const RPA_TERMINAL_STATUSES = ["SUCCESS", "TIMEOUT", "CANCELLED"] as const

export const RPA_MODEL_LABELS: Record<string, string> = {
  NANO_BANANA_PRO: "Nano Banana Pro",
  NANO_BANANA_2: "Nano Banana 2",
  NANO_BANANA_2_LITE: "Nano Banana 2 Lite",
  OMNI_1_1_FLASH: "Omni 1.1 Flash",
  VEO_3_1_LITE: "Veo 3.1 - Lite",
  VEO_3_1_FAST: "Veo 3.1 - Fast",
  VEO_3_1_QUALITY: "Veo 3.1 - Quality",
}

// 2026-09-15 Flow 网页确认；Veo 当前没有分辨率和时长切换项。
const RPA_VIDEO_MODEL_LIMITS = {
  OMNI_1_1_FLASH: { durations: [4, 6, 8, 10], resolutions: ["360p", "720p"] },
  VEO_3_1_LITE: { durations: [8], resolutions: ["720p"] },
  VEO_3_1_FAST: { durations: [8], resolutions: ["720p"] },
  VEO_3_1_QUALITY: { durations: [8], resolutions: ["720p"] },
} as const

export const RPA_CREATION_CAPABILITIES = {
  IMAGE: {
    models: RPA_IMAGE_MODELS.map(value => ({ value, label: RPA_MODEL_LABELS[value] })),
    aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16"],
    quantities: [1, 2, 3, 4],
    reference: {
      image: { enabled: true, max: 10 },
      video: { enabled: false, max: 0 },
    },
  },
  VIDEO: {
    models: RPA_VIDEO_MODELS.map(value => ({
      value,
      label: RPA_MODEL_LABELS[value],
      ...RPA_VIDEO_MODEL_LIMITS[value],
    })),
    inputModes: ["INGREDIENTS"],
    aspectRatios: ["9:16", "16:9"],
    quantities: [1, 2, 3, 4],
    // 顶层仅给出所有模型的公共选项，前端应优先读取所选 models[] 项。
    durations: [8],
    resolutions: ["720p"],
    defaultResolution: "720p",
    reference: {
      image: { enabled: true, max: 10 },
      video: { enabled: true, max: 1 },
    },
  },
} as const
