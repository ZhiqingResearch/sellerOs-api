export interface FeatureModuleDefinition {
  source: string
  label: string
  module: string | null
  moduleLabel: string | null
  sortOrder: number
}

/**
 * 系统内置功能模块定义。
 *
 * FeatureModule 表仍是扣费校验和统计展示的运行时单一事实来源；这份定义仅用于：
 * 1. seed 时创建并更新注册数据；
 * 2. 应用启动时为全新数据库补齐缺失行。
 *
 * 启动补齐只创建缺失行，不覆盖 active，避免把人工下线的功能重新启用。
 */
export const FEATURE_MODULE_DEFINITIONS: readonly FeatureModuleDefinition[] = [
  {
    source: "category.analysis",
    label: "类目分析",
    module: "selection",
    moduleLabel: "市场前调",
    sortOrder: 0,
  },
  // ── 选品台 ──
  {
    source: "product.score",
    label: "选品打分",
    module: "selection",
    moduleLabel: "选品台",
    sortOrder: 1,
  },
  {
    source: "flow.workbench",
    label: "选品工作台",
    module: "selection",
    moduleLabel: "选品台",
    sortOrder: 2,
  },
  // ── Listing ──
  {
    source: "listing.generate",
    label: "Listing 生成",
    module: "listing",
    moduleLabel: "Listing",
    sortOrder: 3,
  },
  {
    source: "listing.score",
    label: "Listing 打分",
    module: "listing",
    moduleLabel: "Listing",
    sortOrder: 4,
  },
  // ── 竞品分析 ──
  {
    source: "competitor.research",
    label: "竞品研究",
    module: "competitor",
    moduleLabel: "竞品分析",
    sortOrder: 5,
  },
  // ── ASIN 审计 ──
  {
    source: "asin.audit",
    label: "ASIN 审计",
    module: "asin_audit",
    moduleLabel: "ASIN 审计",
    sortOrder: 6,
  },
  {
    // 取证独立功能口径（与工作台 WorkbenchFeatureKey.ASIN_EVIDENCE 一致）：
    // 不挂在 ASIN 审计模块下，功能使用分布/统计单列「ASIN 取证」
    source: "asin.audit.evidence",
    label: "ASIN 取证",
    module: "asin_evidence",
    moduleLabel: "ASIN 取证",
    sortOrder: 6,
  },
  // ── 智能定价（占位）──
  {
    source: "pricing.quote",
    label: "智能定价",
    module: "pricing",
    moduleLabel: "智能定价",
    sortOrder: 7,
  },
  // ── 新品推广计划（占位）──
  {
    source: "launch.plan",
    label: "新品推广计划",
    module: "launch_plan",
    moduleLabel: "新品推广计划",
    sortOrder: 8,
  },
  // ── 广告优化建议（占位）──
  {
    source: "ad.optimize",
    label: "广告优化建议",
    module: "ad_opt",
    moduleLabel: "广告优化建议",
    sortOrder: 9,
  },
  // ── AI 生图 ──
  {
    source: "aicreative.image_generate",
    label: "图片生成",
    module: "img",
    moduleLabel: "AI 生图",
    sortOrder: 10,
  },
  // ── 车泰斗 AI 商品素材工作台（方案 §8.1：归 img 菜单，invokeType=PLATFORM）──
  {
    source: "chetaidou.breakdown",
    label: "车泰斗·母版拆解",
    module: "img",
    moduleLabel: "AI 生图",
    sortOrder: 10,
  },
  {
    source: "chetaidou.ideation",
    label: "车泰斗·联想扩展",
    module: "img",
    moduleLabel: "AI 生图",
    sortOrder: 10,
  },
  {
    source: "chetaidou.diverge",
    label: "车泰斗·维度发散",
    module: "img",
    moduleLabel: "AI 生图",
    sortOrder: 10,
  },
  {
    source: "chetaidou.compose",
    label: "车泰斗·指令组合",
    module: "img",
    moduleLabel: "AI 生图",
    sortOrder: 10,
  },
  {
    source: "chetaidou.image",
    label: "车泰斗·图片生成",
    module: "img",
    moduleLabel: "AI 生图",
    sortOrder: 10,
  },
  {
    // 人像创作专用子来源：与通用图片生成区分计费统计；sortOrder 与主来源同级，
    // 列表内按 id 排在其后（紧邻「图片生成」）
    source: "aicreative.image_generate.portrait",
    label: "人像创作",
    module: "img",
    moduleLabel: "AI 生图",
    sortOrder: 10,
  },
  {
    source: "replace2.aigen",
    label: "换装/替换生成",
    module: "img",
    moduleLabel: "AI 生图",
    sortOrder: 11,
  },
  {
    source: "aicreative.ai_split",
    label: "AI 拆图分析",
    module: "img",
    moduleLabel: "AI 生图",
    sortOrder: 12,
  },
  {
    source: "aicreative.image_generate.ai_split",
    label: "AI 拆图生图",
    module: "img",
    moduleLabel: "AI 生图",
    sortOrder: 13,
  },
  // ── AI 生视频 ──
  {
    source: "video-project.generate",
    label: "视频生成",
    module: "video",
    moduleLabel: "AI 生视频",
    sortOrder: 14,
  },
  {
    source: "beauty-workflow.generate",
    label: "美业视频生成",
    module: "video",
    moduleLabel: "AI 生视频",
    sortOrder: 15,
  },
  {
    source: "video.analysis",
    label: "视频分析",
    module: "video",
    moduleLabel: "AI 生视频",
    sortOrder: 16,
  },
  {
    source: "video-project.sales",
    label: "带货视频生成",
    module: "video",
    moduleLabel: "AI 生视频",
    sortOrder: 17,
  },
  {
    source: "video-project.motion",
    label: "动作复刻视频",
    module: "video",
    moduleLabel: "AI 生视频",
    sortOrder: 18,
  },
  // ── 未归 9 大菜单的历史/其他功能 ──
  {
    source: "quick.publish",
    label: "一键上架",
    module: null,
    moduleLabel: null,
    sortOrder: 90,
  },
  {
    source: "ai.chat",
    label: "AI 问一问",
    module: null,
    moduleLabel: null,
    sortOrder: 91,
  },
  {
    source: "llm.generic",
    label: "通用 LLM",
    module: null,
    moduleLabel: null,
    sortOrder: 92,
  },
  {
    source: "rpa-creation.generate",
    label: "内部创作",
    module: null,
    moduleLabel: null,
    sortOrder: 93,
  },
  {
    source: "inspiration_radar.refresh",
    label: "灵感雷达",
    module: null,
    moduleLabel: null,
    sortOrder: 94,
  },
  {
    source: "manual.deduct",
    label: "手动扣款",
    module: null,
    moduleLabel: null,
    sortOrder: 95,
  },
  // ── Skills 平台 API（外部项目功能，source 由 zq-skills-platform-api 计费侧冻结）──
  {
    source: "product.lookup",
    label: "ASIN 商品查询",
    module: null,
    moduleLabel: null,
    sortOrder: 96,
  },
  {
    source: "vidflowos.deduct",
    label: "VidFlowOS 扣费",
    module: null,
    moduleLabel: null,
    sortOrder: 96,
  },
]
