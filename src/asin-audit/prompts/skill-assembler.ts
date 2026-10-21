// ASIN 审计 skill 装配器（从 Web lib/skill-assembler.ts 等价迁移的三个 build 函数，
// md 常量由编译产物替换为 prompt-assets 运行时加载；交付包提交 1fd586c）。

import {
  PROMPT_ASIN_AUDIT_OPTIMIZE,
  PROMPT_ASIN_AUDIT_SCORE,
  PROMPT_REF_CATEGORY_COMPUTER,
  PROMPT_REF_OPTIMIZE_DELIVERABLES,
  PROMPT_REF_SCORE_DIMENSIONS,
  PROMPT_REF_SCORE_EVIDENCE_GUIDE,
  PROMPT_REF_SENSITIVE_WORDS,
  PROMPT_REF_TRAFFIC_OPTIMIZATION,
  PROMPT_REVIEW_ANALYSIS,
  PROMPT_REVIEW_PAIN_POINTS,
} from "./prompt-assets"

const SECTION_SEP = "\n\n---\n\n"

/** Wrap a loaded reference with a marker matching the existing `## 已加载 references/xxx.md` convention. */
function loaded(file: string, body: string): string {
  return `## 已加载 references/${file}\n\n${body}`
}

/**
 * Build the B-card review pain-point extraction system prompt.
 *
 * 单文件 skill：读取 `review.comment_list` 原始评论，做关键词提取 + 语义归并，
 * 依出现次数输出 Top 5 差评痛点。
 */
export function buildReviewPainPointsSkill(): string {
  return PROMPT_REVIEW_PAIN_POINTS()
}

/**
 * Build the B-card review analysis (highlights + pain points) system prompt.
 *
 * 取证模块 type=module 专用：单文件 skill，读取 `review.comment_list` 原始评论，
 * 双向语义聚类输出 Top 5 好评亮点 + Top 5 差评痛点（各带原文摘录 quote）。
 * 与现有 buildReviewPainPointsSkill 并存，互不影响。
 */
export function buildReviewAnalysisSkill(): string {
  return PROMPT_REVIEW_ANALYSIS()
}

/**
 * Build the ASIN audit 十板块 scoring system prompt.
 *
 * category：类目落地版覆盖层（v2.3 起）。系统在打分前用类目路径确定性判定（rules/audit-category.ts），
 * 命中电脑类目时追加 category-computer.md——类目冻结清单与改写规则优先于通用细则；null=走通用规则。
 */
export function buildAsinAuditScoreSkill(category?: "computer" | null): string {
  return [
    PROMPT_ASIN_AUDIT_SCORE(),
    loaded("sensitive-words.md", PROMPT_REF_SENSITIVE_WORDS()),
    loaded("score-evidence-guide.md", PROMPT_REF_SCORE_EVIDENCE_GUIDE()),
    loaded("score-dimensions.md", PROMPT_REF_SCORE_DIMENSIONS()),
    loaded("traffic-optimization.md", PROMPT_REF_TRAFFIC_OPTIMIZATION()),
    ...(category === "computer"
      ? [loaded("category-computer.md", PROMPT_REF_CATEGORY_COMPUTER())]
      : []),
  ].join(SECTION_SEP)
}

/**
 * Build the ASIN audit 第三步优化交付物 system prompt.
 */
export function buildAsinAuditOptimizeSkill(): string {
  return [
    PROMPT_ASIN_AUDIT_OPTIMIZE(),
    loaded("sensitive-words.md", PROMPT_REF_SENSITIVE_WORDS()),
    loaded("optimize-deliverables.md", PROMPT_REF_OPTIMIZE_DELIVERABLES()),
    loaded("traffic-optimization.md", PROMPT_REF_TRAFFIC_OPTIMIZATION()),
  ].join(SECTION_SEP)
}
