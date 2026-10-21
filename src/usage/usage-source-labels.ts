/**
 * 消费来源 source → 中文功能名，三级解析：
 *   ① FeatureModule 注册表缓存（DB 单一事实来源，FeatureRegistryService 启动/定时刷新写入）
 *   ② 静态字典 SOURCE_LABEL_MAP + 前缀兜底（注册表未加载/历史未注册来源的老数据不丢标签）
 *   ③ 原样返回（未知来源保留原值便于排查）
 *
 * 单一事实来源：积分明细「项目」列（transaction-display）、用量分析「功能」维度（team-usage）、
 * 用量导出脚本共用同一条 labelForSource。新增功能模块 → 往 FeatureModule 表 seed，不改代码。
 */
export const SOURCE_LABEL_MAP: Record<string, string> = {
  "category.analysis": "类目分析",
  "listing.generate": "Listing 生成",
  "listing.score": "Listing 打分",
  "product.score": "选品打分",
  "flow.workbench": "选品工作台",
  "competitor.research": "竞品研究",
  "ai.chat": "AI 问一问",
  "aicreative.image_generate": "图片生成",
  "aicreative.image_generate.portrait": "人像创作",
  "aicreative.ai_split": "AI 拆图分析",
  "aicreative.image_generate.ai_split": "AI 拆图生图",
  "llm.generic": "通用 LLM",
  "video-project.generate": "视频生成",
  "video-project.sales": "带货视频生成",
  "video-project.motion": "动作复刻视频",
  // 历史兜底：本分支前分镜/形象照用过的旧 source（已收敛，不再产生新流水）
  "customer.storyboard-video.generate": "客户分镜视频",
  "beauty-workflow.generate": "美业视频生成",
  "rpa-creation.generate": "内部创作",
  "inspiration_radar.refresh": "灵感雷达",
  "replace2.aigen": "换装/替换生成",
  "quick.publish": "一键上架",
}

/**
 * 精确映射未命中时，按 source 的命名空间前缀兜底（覆盖同族未单列的新增动作，如未来的 listing.xxx）。
 * 顺序敏感：更具体的前缀放前面（aicreative 需在 ai 之前，否则 aicreative.* 会被 ai 抢先匹配）。
 */
const SOURCE_PREFIX_LABELS: { prefix: string; label: string }[] = [
  { prefix: "listing", label: "Listing 生成" },
  { prefix: "competitor", label: "竞品研究" },
  { prefix: "flow", label: "选品工作台" },
  { prefix: "aicreative", label: "图片生成" },
  { prefix: "llm", label: "通用 LLM" },
  { prefix: "ai", label: "AI 问一问" },
  { prefix: "product", label: "产品报告" },
  { prefix: "customer", label: "客户运营方案" },
  { prefix: "video", label: "视频生成" },
  { prefix: "image", label: "图片生成" },
  { prefix: "inspiration_radar", label: "灵感雷达" },
  { prefix: "deep", label: "深度调研" },
  { prefix: "mcp", label: "MCP 调用" },
]

/** FeatureModule 注册表行（active 才入缓存） */
export interface RegisteredFeature {
  source: string
  label: string
  module: string | null // 一级目录 key（null=未归类的历史功能/外部项目功能）
  moduleLabel: string | null
}

/** 注册表内存缓存：由 FeatureRegistryService 启动加载 + 60s TTL 刷新写入；null=尚未加载 */
let registryCache: Map<string, RegisteredFeature> | null = null

/** 写入/替换注册表缓存（仅 FeatureRegistryService 调用） */
export function setFeatureRegistryCache(rows: RegisteredFeature[]): void {
  registryCache = new Map(rows.map(r => [r.source, r]))
}

/** 查注册表行（未加载/未登记返回 null） */
export function getRegisteredFeature(source: string): RegisteredFeature | null {
  return registryCache?.get(source) ?? null
}

/** 注册表全部行（sortOrder 升序由写入方保证） */
export function listRegisteredFeatures(): RegisteredFeature[] {
  return registryCache ? [...registryCache.values()] : []
}

/**
 * source → 中文功能名：注册表 → 静态字典 → 前缀兜底 → 原样返回。
 * 空 source 返回「消费」。
 */
export function labelForSource(source: string | null | undefined): string {
  if (!source) return "消费"
  return (
    registryCache?.get(source)?.label ??
    SOURCE_LABEL_MAP[source] ??
    SOURCE_PREFIX_LABELS.find(s => source.startsWith(s.prefix))?.label ??
    source
  )
}

/** 非消费来源的固定筛选项（不属于 FeatureModule 扣费功能，始终追加在下拉尾部） */
const NON_CONSUME_SOURCE_OPTIONS: { value: string; label: string }[] = [
  // 非消费来源：后台手动调额（admin.recharge.manual）也要能在「功能模块」里筛选/显示
  { value: "admin.recharge.manual", label: "手动调整" },
  // 非消费来源：后台个人订阅调整（客服补偿）——使用记录(DEBIT)侧为「后台积分扣减」；
  // source 是存量数据里的存储标识（不迁移），展示文案以流水 title 为准
  { value: "客服补偿赠送", label: "后台积分扣减" },
  // 非消费来源：个人转企业（packChoice=inject）个人充值积分整额注入企业共享池的转出行
  { value: "team.pack.inject", label: "个人充值积分转入企业共享池" },
  { value: "team.member.gift.transfer", label: "个人赠送积分转入企业共享池" },
  // 非消费来源：平台侧调整企业池充值积分（adjustPoolRecharge；正/负向同一 source）
  { value: "admin.team.adjust", label: "企业池调整" },
  // 非消费来源：企业归档时套餐/赠送池清零（EXPIRE 留痕）
  { value: "team.archive", label: "企业归档积分清零" },
  // 非消费来源：切换为邀请人(LV5)时清零套餐/赠送积分的 EXPIRE 流水
  { value: "invite.switch", label: "套餐/赠送积分清零" },
  // 非消费来源：每日定时任务对到期赠送积分的清零（系统回收）
  { value: "system.expire", label: "系统回收" },
]

/**
 * 用量 / 积分明细「来源」筛选下拉项（value=完整 source、label=中文）：注册表优先（未注册前回退静态字典），
 * 头部带「全部」项（value 空串=不筛选）。经 GET /api/usage/source-options 下发，前端不再各自硬编码，
 * 与「项目」列文案同源、永不漂移。
 */
export function getUsageSourceOptions(): { value: string; label: string }[] {
  const merged = new Map<string, string>(Object.entries(SOURCE_LABEL_MAP))
  for (const f of listRegisteredFeatures()) merged.set(f.source, f.label) // 注册表覆盖/新增
  return [
    { value: "", label: "全部" },
    ...[...merged.entries()].map(([value, label]) => ({ value, label })),
    ...NON_CONSUME_SOURCE_OPTIONS,
  ]
}

/** @deprecated 静态快照（注册表加载前的兜底）；请用 getUsageSourceOptions() 取实时合并结果 */
export const USAGE_SOURCE_OPTIONS: { value: string; label: string }[] = getUsageSourceOptions()
