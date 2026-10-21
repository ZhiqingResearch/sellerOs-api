import { buildListingAlexaPrompt } from "./listing-alexa-score"
import { LISTING_SCORE_OUTPUT_DELIVERY_PROMPT } from "./listing-score-delivery"
import { buildListingEvidencePrompt } from "./listing-score-evidence-flow"
import { parseListingScoreSource } from "./listing-score-evidence"
import { LISTING_RULE_CHECK_PROMPT } from "./listing-score-rules"
import { LISTING_SCORE_CONSISTENCY_PROMPT } from "./listing-score-validation"

/** 自动评分与独立打分共用首次评分约束，规则和证据要求不随入口改变。 */
export function buildListingScoreSystemPrompt(systemPrompt: string | undefined, userPrompt: string): string {
  const source = parseListingScoreSource(userPrompt)
  return (systemPrompt ?? "") + LISTING_SCORE_CONSISTENCY_PROMPT + LISTING_RULE_CHECK_PROMPT +
    buildListingEvidencePrompt(source) + LISTING_SCORE_OUTPUT_DELIVERY_PROMPT + buildListingAlexaPrompt(source) +
    (source?.structuredAttributes?.length ? `
本次已提供结构化属性原文，首次回答请完整填写assessment.attributeChecks：每个实际属性对应一行，正确的写NONE，口径不明的写PENDING，不省略正确项，不虚构未提供的后台模板字段。判断推荐/选填属性未填时只写优化建议，不生成扣分；已填写的推荐属性有原文可证的真实错误仍按既定规则评估。
先完成逐项事实判断，再按原有3/2/1权重及100%/50%/0%严重度计算。每条deductions必须对应具体字段问题，不能输出“属性填写完整度与重要度加权扣分”等笼统失分；全部NONE/PENDING时本项30分，无扣分。description、score、deductions必须来自同一张逐项取证表，不得一边写填写规范一边以完整度为由扣分。
` : "")
}
