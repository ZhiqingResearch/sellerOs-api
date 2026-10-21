import type { AuditGrade } from "../types/audit.types"

/**
 * ASIN 审计等级（v2.0 §四.1）：≥85 优秀 / ≥70 良好 / ≥50 一般 / <50 待优化。
 * 旧 S/A/B+/B/C 与四类问题分数推导（problemTypes）已随十维契约废弃。
 */

export function auditGrade(score: number): AuditGrade {
  if (score >= 85) return "EXCELLENT"
  if (score >= 70) return "GOOD"
  if (score >= 50) return "FAIR"
  return "POOR"
}

export function auditGradeLabel(grade: AuditGrade): string {
  const map: Record<AuditGrade, string> = {
    EXCELLENT: "优秀",
    GOOD: "良好",
    FAIR: "一般",
    POOR: "待优化",
  }
  return map[grade]
}

/** 分档话术（v2.0 §五：≥85 整体健康 / ≥70 基本盘可用 / ≥50 存在明显短板 / <50 系统性重做） */
export function auditGradeNarrative(grade: AuditGrade): string {
  const map: Record<AuditGrade, string> = {
    EXCELLENT: "整体健康，按建议精进即可",
    GOOD: "基本盘可用，需补 1–2 处短板",
    FAIR: "存在明显短板，建议按优先级逐项修",
    POOR: "多域同时失分，需要一轮系统性重做",
  }
  return map[grade]
}
