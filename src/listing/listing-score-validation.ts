import { BadGatewayException } from "@nestjs/common"
import { parseListingJsonObject } from "./listing-result-parser"

import { isCdqScoreReport, normalizeCdqScoreReport } from "./listing-cdq-score"
import { normalizeUnavailableSearchTerms } from "./listing-search-terms-score"

export const LISTING_SCORE_CONSISTENCY_PROMPT = `
评分输出校验要求（不改变各平台原有评分标准）：
只返回完整 JSON 评分对象，不要返回正文说明代替 JSON。
每项 criteria.score 表示最终得分，不是扣分；maxScore 表示满分。
每项得分必须等于该项满分减去 deductions 中所有 points 的合计。
新版CDQ的UNAVAILABLE/NOT_APPLICABLE项必须score=null、deductions=[]，不适用以下数值扣分校验；V=0时CDQ及total为null。
关键词覆盖第4项后台搜索词确定未获取时，description="SEARCH TERMS未获取"、status="UNAVAILABLE"、score=4、deductions=[]，表示该项不扣分；不得据此增加维度级扣分。此例外仅适用于后台搜索词，不改变其他项目。
已核验项目没有扣分时 score=maxScore 且 deductions=[]，禁止输出 score=0 配合空扣分列表。
扣分 points 必须大于 0，并附具体理由；“无明显堆砌”等无问题说明应放 description，不能作为 0 分扣分项。
无法核验时依照原评分标准说明依据，不得静默给 0 分或编造扣分理由。
维度级额外惩罚仍依原规则处理，不得改写为小项无理由扣分。
输出前逐项复核分数与扣分合计一致。
`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** 仅验证已有评分，不猜测得分、不补造理由、不触发模型重试。 */
export function validateListingScoreOutput(text: string): string {
  let result: Record<string, unknown>
  try {
    result = normalizeUnavailableSearchTerms(parseListingJsonObject(text))
  } catch {
    throw new BadGatewayException("AI 评分未返回完整 JSON，本次评分未扣费，请稍后重试")
  }
  if (isCdqScoreReport(result)) {
    try { return JSON.stringify(normalizeCdqScoreReport(result)) }
    catch { throw new BadGatewayException("CDQ评分数据与取证状态不一致，本次未扣费") }
  }
  if (!Number.isFinite(result.total) || !Array.isArray(result.dimensions) || !result.dimensions.length) {
    throw new BadGatewayException("AI 评分数据格式异常，本次评分未扣费")
  }
  for (const dimension of result.dimensions) {
    if (!isRecord(dimension) || !Array.isArray(dimension.criteria) || !dimension.criteria.length) {
      throw new BadGatewayException("AI 评分缺少细则，本次评分未扣费")
    }
    for (const criterion of dimension.criteria) {
      if (!isRecord(criterion)) throw new BadGatewayException("AI 评分细则异常，本次评分未扣费")
      const { score, maxScore } = criterion
      const deductions = criterion.deductions ?? []
      const fail = () => {
        throw new BadGatewayException("AI 评分的得分与扣分依据不一致，本次评分未扣费")
      }
      if (typeof score !== "number" || !Number.isFinite(score) || typeof maxScore !== "number" ||
        !Number.isFinite(maxScore) || maxScore <= 0 || score < 0 || !Array.isArray(deductions)) fail()
      let deducted = 0
      for (const deduction of deductions as unknown[]) {
        if (!isRecord(deduction) || typeof deduction.points !== "number" ||
          !Number.isFinite(deduction.points) || deduction.points < 0 ||
          (deduction.points > 0 && (typeof deduction.reason !== "string" || !deduction.reason.trim()))) fail()
        deducted += (deduction as { points: number }).points
      }
      // 允许前端沿用既有的越界裁剪；但不允许无依据的低分通过。
      if (deducted > (maxScore as number) ||
        Math.abs(Math.min(score as number, maxScore as number) + deducted - (maxScore as number)) > 0.0001) fail()
      criterion.deductions = (deductions as Array<{ points: number }>).filter(deduction => deduction.points > 0)
    }
  }
  return JSON.stringify(result)
}
