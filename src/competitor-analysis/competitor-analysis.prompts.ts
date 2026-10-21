import type {
  AssembledCompetitorAnalysis,
  CompetitorEvidenceBundle,
} from "./competitor-analysis.types"

const SYSTEM_PROMPT = `你是 Amazon 竞品分析总结引擎。用户消息已经包含由事实接口确定性组装的商品画像、流量广告和价格促销指标。你只负责生成跨竞品总结，不能重写页面模块数据，也不得补造价格、销量、排名、关键词、评论、库存、促销或时间点。

输出必须是一个 JSON 对象，不要输出 Markdown。顶层只能包含 summary，严格使用 {"summary":{"insights":[],"rankings":[]}} 结构，insights 和 rankings 即使为空也不可省略。

summary.insights 固定返回 landscape、threat、opportunity、action 四项。每项包含 kind, status, title, description, severity, confidence, method, evidence；method 固定 ai_generated。evidence 必须是数组，每项包含 asin, metric, label, value, unit, source, provider；value 只能是字符串或数字，source 只能是 profile、traffic、pricePromo 之一。无法在输入数据中逐项核对的证据不要返回。

summary.rankings 每个 ASIN 一项，包含 asin, rank, relativePressureScore, evidenceCoverage, price, monthlySales, trafficScore, adRatio, bsrDelta, reviewGrowth30d。排名只能依据有效证据计算；证据不足时 rank 和分数为 null。

比例字段使用 0 到 1 的小数；金额和计数字段使用 number 或 null；数组字段不可为 null。所有面向用户的说明使用简体中文。`

export function buildCompetitorAnalysisPrompts(
  evidence: CompetitorEvidenceBundle,
  assembled: AssembledCompetitorAnalysis
): { systemPrompt: string; userPrompt: string } {
  const compactFacts = {
    country: evidence.country,
    asins: evidence.asins,
    profiles: assembled.profiles.map(profile => ({
      asin: profile.asin,
      found: profile.found,
      brand: profile.brand,
      price: profile.price,
      score: profile.score,
      ratingNum: profile.ratingNum,
      boughtInPastMonth: profile.boughtInPastMonth,
      mainBsr: profile.mainBsr,
      listedDays: profile.listedDays,
      variationNum: profile.variationNum,
      salesTrend: profile.salesTrend,
      priorityTags: profile.priorityTags,
      exceptionTags: profile.exceptionTags,
    })),
    traffic: assembled.trafficBoards.map(board => ({
      asin: board.asin,
      found: board.found,
      summary: board.summary,
      keywords: Array.isArray(board.keywords) ? board.keywords.slice(0, 10) : [],
      adDetail: compactAdDetail(board.adDetail),
    })),
    pricePromo: assembled.pricePromoBoards.map(board => ({
      asin: board.asin,
      found: board.found,
      currentPrice: board.currentPrice,
      metrics: board.metrics,
      verdict: board.verdict,
      verdictTags: board.verdictTags,
      sop: compactSop(board.sop),
    })),
  }

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `请基于以下已核验的模块事实生成竞品总结。站点：${evidence.country}；ASIN：${evidence.asins.join(", ")}。\n\n事实数据：\n${JSON.stringify(compactFacts)}`,
  }
}

function compactAdDetail(value: unknown): Record<string, unknown> {
  const detail = asRecord(value)
  return {
    keywordCount: detail.keywordCount,
    campaignCountEstimate: detail.campaignCountEstimate,
    adGroupCountEstimate: detail.adGroupCountEstimate,
    primaryTargeting: detail.primaryTargeting,
    confidence: detail.confidence,
  }
}

function compactSop(value: unknown): Record<string, unknown> {
  const sop = asRecord(value)
  return {
    stage: sop.stage,
    listedDays: sop.listedDays,
    salesTrendPct: sop.salesTrendPct,
    bsrTrendPct: sop.bsrTrendPct,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
