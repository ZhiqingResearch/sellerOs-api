import { PrismaClient } from "@prisma/client"

// AI 模型目录（企业「模型配置」Tab 的可选池；按 kind 约束功能模块可选范围）。
// 新增/下架模型改这里后跑 `tsx prisma/seed.ts models`（下架把 active 置 false，勿删行，历史配置仍引用 code）。
// const AI_MODELS = [
//   // 文本（选品台/Listing/竞品分析/ASIN 审计/智能定价/新品推广计划/广告优化建议）
//   { code: "gemini-2.5-flash", name: "Gemini 2.5 Flash", kind: "TEXT", sortOrder: 1 },
//   { code: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", kind: "TEXT", sortOrder: 2 },
//   // 生图（AI 生图）
//   { code: "nano-banana-2", name: "Nano Banana 2", kind: "IMAGE", sortOrder: 1 },
//   { code: "zq-image-2", name: "ZQ-Image-2", kind: "IMAGE", sortOrder: 2 },
//   { code: "zq-image-3", name: "ZQ-Image-3", kind: "IMAGE", sortOrder: 3 },
//   { code: "zq-image-4", name: "ZQ-Image-4", kind: "IMAGE", sortOrder: 4 },
//   // 生视频（AI 生视频）
//   { code: "veo-3.1-fast", name: "Veo 3.1 Fast", kind: "VIDEO", sortOrder: 1 },
//   { code: "veo-3.1-lite", name: "Veo 3.1 Lite", kind: "VIDEO", sortOrder: 2 },
//   { code: "seedance-2.0-fast", name: "Seedance 2.0 Fast", kind: "VIDEO", sortOrder: 3 },
//   { code: "seedance-2.0-mini", name: "Seedance 2.0 Mini", kind: "VIDEO", sortOrder: 4 },
//   { code: "kling-v3.0-turbo", name: "Kling V3.0 Turbo", kind: "VIDEO", sortOrder: 5 },
//   { code: "grok-imagine", name: "Grok Imagine", kind: "VIDEO", sortOrder: 6 },
// ] as const

const AI_MODELS = [
  // TEXT
  { code: "ZQ-Think-Lite", name: "ZQ-Think-Lite（DeepSeek V4 Flash）", kind: "TEXT", sortOrder: 1 },
  {
    code: "ZQ-Think-Flash",
    name: "ZQ-Think-Flash（Gemini 3.1 Flash Lite）",
    kind: "TEXT",
    sortOrder: 2,
  },
  { code: "ZQ-Think-Pro", name: "ZQ-Think-Pro（Gemini 3.5 Flash）", kind: "TEXT", sortOrder: 3 },
  {
    code: "ZQ-Think-Ultra",
    name: "ZQ-Think-Ultra（GPT 5.5 / Claude Opus 4.8）",
    kind: "TEXT",
    sortOrder: 4,
  },
  {
    code: "ZQ-Multimodal-Gemini-3.1-Pro",
    name: "ZQ-Multimodal-Gemini-3.1-Pro（Atlas 多模态理解）",
    kind: "TEXT",
    sortOrder: 5,
  },
  {
    code: "ZQ-Multimodal-Gemini-3.5-Flash-Lite",
    name: "ZQ-Multimodal-Gemini-3.5-Flash-Lite（Google Gemini 3.5 Flash Lite 多模态理解）",
    kind: "TEXT",
    sortOrder: 6,
  },
  {
    code: "ZQ-Multimodal-Gemini-3.7-Flash",
    name: "ZQ-Multimodal-Gemini-3.7-Flash（Google Gemini 3.7 Flash 多模态理解）",
    kind: "TEXT",
    sortOrder: 7,
  },
  {
    code: "ZQ-Multimodal-Qwen-3.7-Plus",
    name: "ZQ-Multimodal-Qwen-3.7-Plus（千问 3.7 Plus 多模态理解）",
    kind: "TEXT",
    sortOrder: 8,
  },

  // IMAGE
  { code: "ZQ-Image-1", name: "ZQ-Image-1（Nano Banana 2）", kind: "IMAGE", sortOrder: 1 },
  { code: "ZQ-Image-2", name: "ZQ-Image-2（Pro Plus）", kind: "IMAGE", sortOrder: 2 },
  { code: "ZQ-Image-3", name: "ZQ-Image-3（Seedream 5.0 Lite）", kind: "IMAGE", sortOrder: 3 },
  {
    code: "ZQ-Image-Ultra",
    name: "ZQ-Image-Ultra（Seedream 5.0 Pro）",
    kind: "IMAGE",
    sortOrder: 4,
  },

  // VIDEO
  {
    code: "sourcing-storyboard-veo-lite",
    name: "客户分镜 Veo 3.1 Lite",
    kind: "VIDEO",
    sortOrder: 1,
  },
  { code: "sourcing-veo-fast-i2v", name: "Veo 3.1 Fast 图生/首尾帧", kind: "VIDEO", sortOrder: 2 },
  {
    code: "sourcing-veo-fast-reference",
    name: "Veo 3.1 Standard 参考生视频",
    kind: "VIDEO",
    sortOrder: 3,
  },
  {
    code: "sourcing-kling-v3-turbo-i2v",
    name: "Kling V3.0 Turbo 图生视频",
    kind: "VIDEO",
    sortOrder: 4,
  },
  { code: "sourcing-kling-o3-video-edit", name: "Kling O3 视频编辑", kind: "VIDEO", sortOrder: 5 },
  {
    code: "sourcing-seedance-mini-i2v",
    name: "Seedance 2.0 Mini 图生/首尾帧",
    kind: "VIDEO",
    sortOrder: 6,
  },
  {
    code: "sourcing-seedance-mini-reference",
    name: "Seedance 2.0 Mini 参考生视频",
    kind: "VIDEO",
    sortOrder: 7,
  },
  {
    code: "sourcing-beauty-seedance-mini",
    name: "美妆专线 Seedance 2.0 Mini",
    kind: "VIDEO",
    sortOrder: 8,
  },
  {
    code: "sourcing-seedance-2-5-i2v",
    name: "Seedance 2.5 图生/首尾帧",
    kind: "VIDEO",
    sortOrder: 9,
  },
  {
    code: "sourcing-seedance-2-5-reference",
    name: "Seedance 2.5 参考/编辑视频",
    kind: "VIDEO",
    sortOrder: 10,
  },
  {
    code: "sourcing-grok-imagine-i2v",
    name: "Grok Imagine 图生视频",
    kind: "VIDEO",
    sortOrder: 11,
  },
  {
    code: "sourcing-grok-imagine-reference",
    name: "Grok Imagine 参考生视频",
    kind: "VIDEO",
    sortOrder: 12,
  },
  {
    code: "sourcing-grok-imagine-v2v",
    name: "Grok Imagine 视频转视频",
    kind: "VIDEO",
    sortOrder: 13,
  },
  {
    code: "sourcing-grok-imagine-1-5-i2v",
    name: "Grok Imagine 1.5 图生视频",
    kind: "VIDEO",
    sortOrder: 14,
  },
  {
    code: "sourcing-seedance-fast-i2v",
    name: "Seedance 2.0 Fast 图生/首尾帧",
    kind: "VIDEO",
    sortOrder: 15,
  },
  {
    code: "sourcing-seedance-fast-reference",
    name: "Seedance 2.0 Fast 参考生视频",
    kind: "VIDEO",
    sortOrder: 16,
  },
  { code: "sourcing-kling-motion", name: "Kling 3.0 动作复刻", kind: "VIDEO", sortOrder: 17 },
  {
    code: "sourcing-suchuang-grok-imagine",
    name: "速创 Grok Imagine",
    kind: "VIDEO",
    sortOrder: 18,
  },
  { code: "sourcing-suchuang-google-omni", name: "速创 Google Omni", kind: "VIDEO", sortOrder: 19 },
  {
    code: "sourcing-minimax-h3-reference",
    name: "MiniMax H3 多图参考生视频",
    kind: "VIDEO",
    sortOrder: 20,
  },
  {
    code: "sourcing-gemini-omni-flash",
    name: "Gemini Omni Flash 全能视频",
    kind: "VIDEO",
    sortOrder: 21,
  },
] as const

export async function seedModels(prisma: PrismaClient) {
  for (const m of AI_MODELS) {
    await prisma.aiModel.upsert({
      where: { code: m.code },
      update: { name: m.name, kind: m.kind, sortOrder: m.sortOrder },
      create: m,
    })
  }
  return { models: AI_MODELS.length }
}
