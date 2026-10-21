import { Logger } from "@nestjs/common"
import { parseListingJsonObject } from "./listing-result-parser"
import { recalculateCdqScoreSummary } from "./listing-cdq-summary"
import { recalculateListingAlexaScore } from "./listing-alexa-score"
import { validateScoreReport } from "./listing-score-recovery"
import { validateListingReportRules, type ListingRuleContext } from "./listing-score-rules"
import { recalculateListingAttributeScore } from "./listing-attribute-normalization"
import { normalizeListingScoreArithmetic, normalizeListingScoreStructure } from "./listing-score-normalization"
import { reconcileListingDescriptionScore } from "./listing-description-score"

/** 只检查能否展示；算术、证据、规则差异都不能把已有完整报告变成错误页。 */
export function prepareListingScoreDelivery(
  text: string,
  market?: string,
  context?: ListingRuleContext
): string | undefined {
  let report: Record<string, unknown>
  if (!text.trim()) return undefined
  try { report = parseListingJsonObject(text) } catch {
    // 原始输出已单独保存；格式未完整返回也交付中性占位，不把已有正文变成错误页。
    report = {}
  }
  report = normalizeListingScoreStructure(report, market)
  if (!Array.isArray(report.dimensions) || !report.dimensions.length) return undefined
  // 缺失的纯展示字段只补空容器，不补造评分、扣分理由或建议。
  if (!Array.isArray(report.suggestions)) report.suggestions = []
  else report.suggestions = report.suggestions.filter(value => typeof value === "string")
  if (typeof report.potential !== "string") report.potential = ""
  delete report.validationStatus
  delete report.validationWarnings
  report = normalizeListingScoreArithmetic(report)
  report = recalculateListingAlexaScore(report, context?.sourceFacts)
  report = recalculateListingAttributeScore(report, context?.sourceFacts)
  report = reconcileListingDescriptionScore(report, context?.sourceFacts)
  try {
    validateListingReportRules(report, context)
    report = parseListingJsonObject(validateScoreReport(JSON.stringify(report), market))
  } catch (error) {
    Logger.warn(error instanceof Error ? error.message : "评分一致性待核对", "ListingScoreDelivery")
    // 细则得分、扣分与证据保留；校验是诊断，不是交付门槛。
    report.validationStatus = "BEST_EFFORT"
  }
  // 汇总由已交付的细则得分计算，不触发规则校对或模型重试。
  report = normalizeListingScoreArithmetic(report)
  report = recalculateCdqScoreSummary(report)
  return JSON.stringify(report)
}
/** 在首次生成阶段约束完整性，不把事后模型自检变成用户操作的前置条件。 */
export const LISTING_SCORE_OUTPUT_DELIVERY_PROMPT = `
请在本次回答中一次性完成现有提示词要求的完整评分报告，只输出报告JSON。
所有得分必须介于0与对应maxScore之间，总分介于0与100之间；只有规则明确未获取/不适用项可以是null。不得用负分抵消其他项目或凑总分，扣分须符合对应细则的固定规则。
每个细则先列事实判断和扣分明细，再计算score=maxScore-扣分合计，不得独立猜测分数。描述项满分3，缺规格段扣1、缺具体场景扣1，例如仅缺规格段必须得2分。
描述项必须先输出assessment.checks中的specifications和overview_scenes两项判断及对应原文引用，再从这两个判断生成description、deductions和score。两项均满足时score=3、deductions=[]；有一项不满足时score=2，并在deductions说明缺少哪一项及原文依据。禁止输出“包含场景与规格”却给2分，也禁止score小于3时deductions为空或只有0分明细。
生成前逐项依据原文和既有规则判断，重点保证细则得分与对应扣分依据一致；不要新增规则或为了凑分改写扣分依据。CDQ汇总、百分制得分及40分贡献由后端按细则得分和既定状态计算，再与其余维度得分相加得到总分；仍完整输出原要求的汇总字段。
每个维度完整输出name/weight/maxScore/score/criteria；每个细则完整输出name/maxScore/score/description/source/deductions，CDQ项同时输出既定status。没有扣分时deductions为[]，未获取项按既定状态规则表示，不伪造证据。
要求assessment的评分项在同一报告中逐条补齐；引用仅取对应字段中的真实连续原文。把判断不确定的事项按原提示词处理，不把营销话术当数字或具名认证，不将正文片段挪到其他字段。
保留报告的suggestions和potential。不要用校验失败、需要重试、请补充校对或内部错误替代报告，也不要输出局部corrections格式。
`
