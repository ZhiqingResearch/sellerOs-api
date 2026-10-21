import { readFileSync } from "fs"
import { join } from "path"

/**
 * ASIN 审计提示词资产（9 个 md）运行时加载：nest-cli assets 把
 * asin-audit/prompts/**\/*.md 复制进 dist，此处 readFileSync + 进程内一次性缓存。
 * 资产来源：Web UAT 交付包 src/skills/（提交 1fd586c），等价迁移。
 */

/**
 * 提示词版本，写计费 meta 用于对账。
 * v2-20260908：评分体系切换十板块 A–J（24 项目 · 100 分 · A/V/E 三分母），依据《十板块项目分值与扣分规则.xlsx》V1.1。
 * v2.1-20260910：新增 review-analysis.md（取证模块 type=module 的评论分析双输出：好评亮点 + 差评痛点，带原文摘录）。
 * v2.2-20260910：I3 改 BSR 口径（D 卡预计算块 bsrTrend 为唯一数据源）；E1 禁止视频扣分（唯一归 E3）、
 *                E2 禁止任何扣分；A1 品牌词以机械预检为准、A2 明确全页覆盖口径；deduction 归属/事实护栏。
 * v2.3-20260910：新增电脑类目落地版覆盖层（references/category-computer.md）——系统按类目路径判定后
 *                在打分 system prompt 末尾追加，类目冻结清单与改写规则优先于通用细则。
 * v2.5-20260911：暂时下线「关键词与流量建议」板块——打分提示词不再要求输出 trafficSuggestions，
 *                finalizeScoreResult 不再拼装该字段（前端优化·交付物清单不展示）；优化侧选词原料
 *                改由 trafficPrecompute 现场构建，注入内容不变。代码保留注释，优化后恢复接入。
 * v2.4-20260910：禁词红线三口径（促销词 / 他人型号裸写 / 竞品品牌词，兼容前缀表述除外）——打分侧
 *                「禁词与竞品关键词不是覆盖义务、未使用不扣分」+ 流量预计算入口剔除确定性禁词；
 *                优化侧选词过滤、埋词去重（标题已覆盖语义改埋 Bullet/Q&A/评论/描述）、
 *                广告建议闸门（D 卡 ranking 广告位无排名才建议开投/调价）；
 *                optimize user prompt 补拼 trafficSuggestions 四子维度块。
 * v2.6-20260917：优化底线新增规则 7 事实性护栏（面料/护理/版型/结构/认证/尺码颜色数只写 A/P 卡证据，
 *                缺失不得虚构、标「待卖家确认」）+ A 卡 prompt 增输出副标题（second_title）行；
 *                适配层：overviews 键值对并入 P 卡（服装类新版详情页无参数表）、描述剔除
 *                "This is a modal window." 噪音行——修「优化文案与详情页不符、模型编造属性」。
 *                打分侧：adDiagnostics 契约钉死结构（顶层 score + dimensions 5 项带固定权重），
 *                服务端附带归档兼容摘要（overallScore/contentScore/trafficScore/adScore）并回写
 *                规范化 adDiagnostics.score（提取兜底序与前端归档预检同序 score→total→overallScore），
 *                归档 validator 增 v2 boards 分支并从 adDiagnostics 兜底提取广告分——修「已上传广告
 *                归档失败：后端未返回有效广告分」。
 */
export const PROMPT_VERSION = "asin-audit.v2.6-20260917"

const cache = new Map<string, string>()

function loadAsset(relativePath: string): string {
  const hit = cache.get(relativePath)
  if (hit !== undefined) return hit
  const text = readFileSync(join(__dirname, "..", "prompts", relativePath), "utf8").trim()
  cache.set(relativePath, text)
  return text
}

export const PROMPT_REVIEW_PAIN_POINTS = () => loadAsset("review-pain-points.md")
export const PROMPT_REVIEW_ANALYSIS = () => loadAsset("review-analysis.md")
export const PROMPT_ASIN_AUDIT_SCORE = () => loadAsset("asin-audit-score.md")
export const PROMPT_ASIN_AUDIT_OPTIMIZE = () => loadAsset("asin-audit-optimize.md")
export const PROMPT_REF_SCORE_DIMENSIONS = () =>
  loadAsset(join("references", "score-dimensions.md"))
export const PROMPT_REF_SCORE_EVIDENCE_GUIDE = () =>
  loadAsset(join("references", "score-evidence-guide.md"))
export const PROMPT_REF_OPTIMIZE_DELIVERABLES = () =>
  loadAsset(join("references", "optimize-deliverables.md"))
export const PROMPT_REF_TRAFFIC_OPTIMIZATION = () =>
  loadAsset(join("references", "traffic-optimization.md"))
export const PROMPT_REF_CATEGORY_COMPUTER = () =>
  loadAsset(join("references", "category-computer.md"))
export const PROMPT_REF_SENSITIVE_WORDS = () => loadAsset(join("references", "sensitive-words.md"))
