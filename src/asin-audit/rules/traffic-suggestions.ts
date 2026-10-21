import type { TrafficPrecompute, TrafficSuggestionBlock } from "../types/de.types"

/**
 * 流量四子维度建议兜底（v2.0 §八）：LLM 未输出 trafficSuggestions 时，
 * 用「流量诊断预计算」块生成 G1/G3 的降级建议；I3 自 v2.2 起 BSR 口径——
 * 预计算块 bsrTrend 数据充足即按公式评分，不足则 ⏸ 待核；J2 缺词族合并数据 → ⏸ 待核行。
 * 仅含数据驱动内容；AI 摘要留待 LLM 输出时覆盖。
 */

/** 扣分 → 建议级别（v2.0 §八分级表） */
function g1Level(deducted: number): TrafficSuggestionBlock["level"] {
  if (deducted >= 6) return "urgent"
  if (deducted >= 3) return "important"
  return "optimize"
}

function g3Level(deducted: number): TrafficSuggestionBlock["level"] {
  if (deducted >= 4) return "urgent"
  if (deducted >= 2) return "important"
  return "optimize"
}

/** I3 分级（v2.0 §八：≥5 urgent / 2.4~5 important / >0~2.4 optimize） */
function i3Level(deducted: number): TrafficSuggestionBlock["level"] {
  if (deducted >= 5) return "urgent"
  if (deducted >= 2.4) return "important"
  return "optimize"
}

export function buildTrafficSuggestionsFromPrecompute(
  pc: TrafficPrecompute | undefined
): TrafficSuggestionBlock[] | undefined {
  // G1 · 当日核心词首页观测率（最高扣 8）
  const g1: TrafficSuggestionBlock = (() => {
    if (!pc) {
      return {
        subDimension: "当日核心词首页观测率",
        ruleId: "G1",
        deducted: 0,
        maxScore: 8,
        level: "pending",
        summary: "⏸ 固定词池抓取状态不明或口径未冻结，本次不评分",
      }
    }
    const hp = pc.homepageHitTier
    const deducted = hp.max - hp.score
    if (deducted === 0) {
      return {
        subDimension: "当日核心词首页观测率",
        ruleId: "G1",
        deducted: 0,
        maxScore: 8,
        level: "ok",
        summary: "✅ 核心词首页覆盖良好",
      }
    }
    return {
      subDimension: "当日核心词首页观测率",
      ruleId: "G1",
      deducted,
      maxScore: hp.max,
      level: g1Level(deducted),
      summary: `按搜索量 Top10 中仅 ${pc.top10Page1Hits} 个自然排名进首页（建议得分 ${hp.score}/${hp.max}）`,
      ...(pc.positionAllocation?.length ? { positionTable: pc.positionAllocation } : {}),
    }
  })()

  // I3 · 排名趋势与稳定性（最高扣 8）——v2.2 BSR 口径：预计算块有 14 天序列即按公式评分
  const i3: TrafficSuggestionBlock = (() => {
    const bt = pc?.bsrTrend
    if (!bt?.available) {
      return {
        subDimension: "排名趋势与稳定性",
        ruleId: "I3",
        deducted: 0,
        maxScore: 8,
        level: "pending",
        summary: `⏸ ${bt?.reason ?? "日级排名序列不足（需近 14 天 BSR：前 7 天 vs 后 7 天）"}，本次只诊断不评分`,
      }
    }
    const deducted = Math.round((bt.tier.max - bt.tier.score) * 100) / 100
    if (deducted <= 0) {
      return {
        subDimension: "排名趋势与稳定性",
        ruleId: "I3",
        deducted: 0,
        maxScore: 8,
        level: "ok",
        summary: `✅ 排名保持稳定（前 7 天均 BSR ${bt.prev7AvgBsr} vs 后 7 天均 ${bt.last7AvgBsr}，保持率 ${bt.retainedPct}%）`,
      }
    }
    const declineNote = bt.declinedDays > 0 ? `；尾部连续劣于基线 ${bt.declinedDays} 天` : ""
    return {
      subDimension: "排名趋势与稳定性",
      ruleId: "I3",
      deducted,
      maxScore: 8,
      level: i3Level(deducted),
      summary: `前 7 天均 BSR ${bt.prev7AvgBsr} → 后 7 天均 ${bt.last7AvgBsr}，保持率 ${bt.retainedPct}%，扣 ${deducted} 分${declineNote}`,
    }
  })()

  // G3 · 合格机会词曝光承接（最高扣 6）
  const g3: TrafficSuggestionBlock = (() => {
    if (!pc) {
      return {
        subDimension: "合格机会词曝光承接",
        ruleId: "G3",
        deducted: 0,
        maxScore: 6,
        level: "pending",
        summary: "⏸ 机会词池采集状态不明，本次不评分",
      }
    }
    // 预计算无「冻结需求权重 × 自然排名观测」明细，按机会词存在与否给保守扣分（与旧口径一致）
    const deducted = pc.opportunityCount === 0 ? 0 : 2
    if (deducted === 0) {
      return {
        subDimension: "合格机会词曝光承接",
        ruleId: "G3",
        deducted: 0,
        maxScore: 6,
        level: "ok",
        summary: "✅ 未识别到待承接机会词",
      }
    }
    return {
      subDimension: "合格机会词曝光承接",
      ruleId: "G3",
      deducted,
      maxScore: 6,
      level: g3Level(deducted),
      summary: `识别到 ${pc.opportunityCount} 个机会词待文案承接（覆盖率需结合 Listing 交叉比对）`,
      ...(pc.opportunityList?.length ? { opportunityTable: pc.opportunityList } : {}),
    }
  })()

  // J2 · 流量来源韧性（最高扣 6）——预计算无词族合并，恒待核
  const j2: TrafficSuggestionBlock = {
    subDimension: "流量来源韧性",
    ruleId: "J2",
    deducted: 0,
    maxScore: 6,
    level: "pending",
    summary: "⏸ 词族合并基准未冻结，本次只诊断不评分",
  }

  // 扣分越多越靠前（v2.0 §八总原则）；待核与满分排后
  return [g1, i3, g3, j2].sort(
    (a, b) =>
      (b.level === "urgent" ? 3 : b.level === "important" ? 2 : b.level === "optimize" ? 1 : 0) -
      (a.level === "urgent" ? 3 : a.level === "important" ? 2 : a.level === "optimize" ? 1 : 0)
  )
}
