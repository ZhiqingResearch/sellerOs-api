/**
 * 由图推理 completion → 三字段派生（P0 契约冻结 §4.3，逐条移植前端 splitReply，行为等价）：
 * 1. 主路径：找第一个独立分隔线（≥3 连字符、独立成行），两侧均非空 → 前段视觉复述 / 后段结构化
 * 2. 兜底 1：找第一个 `[主体]:` 行（半角/全角冒号都认），前段有内容 → 前段 / 从该行起
 * 3. 兜底 2：整段视为结构化 → visualDescription 空、structuredPrompt = 整段
 * 入参 raw 为已 trim 的模型原文；raw 字段本身由调用方原样返回（不加工）。
 */

export interface SplitInferenceReply {
  visualDescription: string
  structuredPrompt: string
}

const SEPARATOR_LINE_RE = /(^|\n)\s*-{3,}\s*(\n|$)/
const SUBJECT_LINE_RE = /(^|\n)\s*\[主体\]\s*[:：]/

export function splitInferenceReply(raw: string): SplitInferenceReply {
  const separator = SEPARATOR_LINE_RE.exec(raw)
  if (separator) {
    const before = raw.slice(0, separator.index).trim()
    const after = raw.slice(separator.index + separator[0].length).trim()
    if (before && after) {
      return { visualDescription: before, structuredPrompt: after }
    }
  }

  const subject = SUBJECT_LINE_RE.exec(raw)
  if (subject) {
    // [主体] 所在行的行首位置（跳过捕获组里的行首锚点）
    const lineStart = subject.index + subject[1].length
    const before = raw.slice(0, lineStart).trim()
    if (before) {
      return { visualDescription: before, structuredPrompt: raw.slice(lineStart).trim() }
    }
  }

  return { visualDescription: "", structuredPrompt: raw }
}
