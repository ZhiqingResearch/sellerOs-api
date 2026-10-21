// 车泰斗素材工作台 — 模型输出 JSON Schema 与跨字段业务校验
// 「JSON 可解析 ≠ 可用」：所有模型输出必须过这里；校验失败 → outcome=INVALID，
// 校验失败直接标失败，不自动重试付费请求，不落业务表。
import { BadRequestException, Logger } from "@nestjs/common"
import Ajv, { type ErrorObject } from "ajv"
import addFormats from "ajv-formats"
import { createHash } from "crypto"
import { jsonrepair } from "jsonrepair"
import {
  CountRange,
  ExecutionSettings,
  dimensionRangeOf,
  validCountRange,
} from "./chetaidou-execution"
import { CHETAIDOU_SITES } from "./chetaidou.constants"

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const outputLogger = new Logger("ChetaidouOutput")

export function ajvErrorsToString(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "未知校验错误"
  return errors
    .slice(0, 12)
    .map(e => `${e.instancePath || "(root)"} ${e.message} ${JSON.stringify(e.params)}`)
    .join("; ")
}

// ── 业务类型（方案 §5.4） ─────────────────────────────────────────────────

export interface ChetaidouSettings extends ExecutionSettings {
  site: string
  textMode: "keep" | "hide" | "translate" | "show"
  personMode: "keep" | "replace"
  personText: string
  customText: string
}

export interface ChetaidouOption {
  key: string
  selectionId: string // 服务端分配；模型输出不含
  label: string
  changeInstruction: string
  preserveInstruction: string
  riskLevel: "low" | "medium" | "high"
  riskReason: string
  requiresEvidence: boolean
  evidenceNeeded: string[]
  dependentChanges: string[]
  incompatibleWith: string[]
  targetText?: string
  targetLocale?: string
  meaningCn?: string
  origin?: "AI" | "USER"
  sourceTaskId?: string
}

export interface ChetaidouGroupDefinition {
  key: string
  label: string
  currentValue: string
  sourceDimensions: string[]
  expansionReason: string
  selectionMode: "single" | "multi"
  targetElement: string
  attribute: string
  kind: "visual" | "copy"
  purpose?: string
  basketId?: string
}

export interface ChetaidouConflict {
  id: string
  question: string
  reason: string
  sources: string[]
  blocking: boolean
  choices: { id: string; label: string; instruction: string }[]
  questionVersion?: number // 服务端分配
}

export interface ChetaidouComposeOutput {
  status: "READY" | "NEEDS_RESOLUTION" | "BLOCKED"
  summaryCn: string
  editPromptEn: string | null
  changedFeatures: string[]
  preservedFeatures: string[]
  coveredSelectionIds: string[]
  textReplacements: {
    textId: string
    sourceText: string
    targetText: string
    targetLocale: string
  }[]
  copyAdditions: { targetText: string; targetLocale: string; meaningCn: string }[]
  conflicts: ChetaidouConflict[]
  acknowledgedAnswerIds: string[]
  decisions?: unknown[]
}

export interface ChetaidouBreakdownPayload {
  summary: string
  hasPeople: boolean
  persons: { personId: string; observedAppearance?: string }[]
  textInventory: {
    textId: string
    sourceText: string
    category: string
    editable: boolean
    readability: string
  }[]
  softFeatures: Record<string, string>
  hardConstraints: string[]
  conflicts: string[]
  uncertainties: string[]
  basketContents: { hasItems: boolean | null; evidence: string; items: string[] }
  baskets?: {
    id: string
    position: string
    hasItems: boolean | null
    evidence: string
    items: string[]
  }[]
  pets?: { id: string; description: string; position: string }[]
  props?: { id: string; description: string; position: string }[]
}

// ── JSON Schema 定义 ──────────────────────────────────────────────────────

const simpleKey = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]*$", minLength: 1 }

const observedObjectsSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "description", "position"],
    properties: { id: simpleKey, description: { type: "string" }, position: { type: "string" } },
  },
} as const

export const BREAKDOWN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "hasPeople",
    "persons",
    "textInventory",
    "softFeatures",
    "hardConstraints",
    "conflicts",
    "uncertainties",
    "basketContents",
  ],
  properties: {
    summary: { type: "string", minLength: 1 },
    hasPeople: { type: "boolean" },
    persons: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["personId"],
        properties: { personId: simpleKey },
      },
    },
    textInventory: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["textId", "sourceText", "category", "editable", "readability"],
        properties: {
          textId: simpleKey,
          sourceText: { type: "string" },
          category: {
            type: "string",
            enum: [
              "marketing",
              "brand",
              "model",
              "spec",
              "certification",
              "product_mark",
              "unknown",
            ],
          },
          editable: { type: "boolean" },
          readability: { type: "string", enum: ["readable", "unclear"] },
        },
      },
    },
    softFeatures: { type: "object", additionalProperties: { type: "string" } },
    pets: observedObjectsSchema,
    props: observedObjectsSchema,
    baskets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "position", "hasItems", "evidence", "items"],
        properties: {
          id: simpleKey,
          position: { type: "string" },
          hasItems: { type: ["boolean", "null"] },
          evidence: { type: "string" },
          items: { type: "array", items: { type: "string" } },
        },
      },
    },
    hardConstraints: { type: "array", items: { type: "string" } },
    conflicts: { type: "array", items: { type: "string" } },
    uncertainties: { type: "array", items: { type: "string" } },
    basketContents: {
      type: "object",
      additionalProperties: false,
      required: ["hasItems", "evidence", "items"],
      properties: {
        hasItems: { type: ["boolean", "null"] },
        evidence: { type: "string" },
        items: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const

const BREAKDOWN_REJECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reason"],
  properties: {
    status: { const: "REJECTED" },
    reason: { type: "string", pattern: "\\S" },
  },
} as const

export const BREAKDOWN_RESPONSE_SCHEMA = {
  anyOf: [BREAKDOWN_SCHEMA, BREAKDOWN_REJECTION_SCHEMA],
} as const

const GROUP_DEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "key",
    "label",
    "currentValue",
    "sourceDimensions",
    "expansionReason",
    "selectionMode",
    "targetElement",
    "attribute",
    "kind",
  ],
  properties: {
    key: simpleKey,
    label: { type: "string", minLength: 1 },
    currentValue: { type: "string" },
    sourceDimensions: { type: "array", items: { type: "string" } },
    expansionReason: { type: "string" },
    selectionMode: { type: "string", enum: ["single", "multi"] },
    targetElement: { type: "string", minLength: 1 },
    attribute: { type: "string", minLength: 1 },
    kind: { type: "string", enum: ["visual", "copy"] },
    purpose: { type: "string" },
    basketId: simpleKey,
  },
} as const

export const IDENTIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "basketContents", "groups"],
  properties: {
    summary: { type: "string" },
    basketContents: BREAKDOWN_SCHEMA.properties.basketContents,
    groups: {
      type: "array",
      minItems: 1,
      items: {
        ...GROUP_DEF_SCHEMA,
        properties: {
          ...GROUP_DEF_SCHEMA.properties,
          selectionMode: { type: "string", const: "single" },
        },
      },
    },
  },
} as const

/** 提供给模型的 Schema 包含数量与文字模式要求；后端仍允许清理后保留不足的有效结果。 */
export function identifySchemaOf(settings: ChetaidouSettings) {
  const groups = IDENTIFY_SCHEMA.properties.groups
  return {
    ...IDENTIFY_SCHEMA,
    properties: {
      ...IDENTIFY_SCHEMA.properties,
      groups: {
        ...groups,
        minItems: Math.max(1, dimensionRangeOf(settings).min),
        maxItems: dimensionRangeOf(settings).max,
        ...(settings.textMode === "show"
          ? {
              contains: {
                type: "object",
                required: ["kind"],
                properties: { kind: { const: "copy" } },
              },
            }
          : {}),
        items: {
          ...groups.items,
          ...(settings.textMode === "hide"
            ? { not: { required: ["purpose"], properties: { purpose: { const: "copy_layout" } } } }
            : {}),
          properties: {
            ...groups.items.properties,
            kind: {
              type: "string",
              enum: settings.textMode === "show" ? ["visual", "copy"] : ["visual"],
            },
          },
        },
      },
    },
  }
}

const OPTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "key",
    "label",
    "changeInstruction",
    "preserveInstruction",
    "riskLevel",
    "riskReason",
    "requiresEvidence",
    "evidenceNeeded",
    "dependentChanges",
    "incompatibleWith",
  ],
  properties: {
    key: simpleKey,
    label: { type: "string", minLength: 1 },
    changeInstruction: { type: "string", minLength: 1 },
    preserveInstruction: { type: "string" },
    riskLevel: { type: "string", enum: ["low", "medium", "high"] },
    riskReason: { type: "string" },
    requiresEvidence: { type: "boolean" },
    evidenceNeeded: { type: "array", items: { type: "string" } },
    dependentChanges: { type: "array", items: { type: "string" } },
    incompatibleWith: { type: "array", items: { type: "string" } },
    targetText: { type: "string" },
    targetLocale: { type: "string" },
    meaningCn: { type: "string" },
  },
} as const

const EXPANSION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["group"],
  properties: {
    group: {
      type: "object",
      additionalProperties: false,
      required: [...(GROUP_DEF_SCHEMA.required as readonly string[]), "options"],
      properties: {
        ...GROUP_DEF_SCHEMA.properties,
        options: {
          type: "array",
        },
      },
    },
  },
} as const

const DIVERGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["options"],
  properties: {
    options: {
      type: "array",
    },
  },
} as const

export const COMPOSITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summaryCn", "conflicts", "editPromptEn"],
  if: { properties: { status: { const: "ready" } } },
  then: {
    required: [
      "coveredSelectionIds",
      "changedFeatures",
      "preservedFeatures",
      "textReplacements",
      "copyAdditions",
      "acknowledgedAnswerIds",
    ],
  },
  else: { properties: { editPromptEn: { const: "" } } },
  properties: {
    status: { type: "string", enum: ["ready", "needs_resolution"] },
    summaryCn: { type: "string" },
    editPromptEn: { type: ["string", "null"] },
    coveredSelectionIds: { type: "array", items: { type: "string" } },
    // 元素类型在服务端归一化为字符串（模型偶发输出对象数组，见 normalizeFeatureStrings）
    changedFeatures: { type: "array" },
    preservedFeatures: { type: "array" },
    appliedRiskIds: { type: "array", items: { type: "string" } },
    textReplacements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["textId", "sourceText", "targetText", "targetLocale"],
        properties: {
          textId: simpleKey,
          sourceText: { type: "string" },
          targetText: { type: "string", minLength: 1 },
          targetLocale: { type: "string" },
        },
      },
    },
    copyAdditions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["targetText", "targetLocale", "meaningCn"],
        properties: {
          targetText: { type: "string", minLength: 1 },
          targetLocale: { type: "string" },
          meaningCn: { type: "string" },
        },
      },
    },
    acknowledgedAnswerIds: { type: "array", items: { type: "string" } },
    conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "question", "reason", "sources", "choices", "blocking"],
        properties: {
          id: simpleKey,
          question: { type: "string", minLength: 1 },
          reason: { type: "string" },
          sources: { type: "array", items: { type: "string" }, minItems: 1 },
          blocking: { type: "boolean" },
          choices: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "label", "instruction"],
              properties: {
                id: simpleKey,
                label: { type: "string", minLength: 1 },
                instruction: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const

const validateBreakdownAjv = ajv.compile(BREAKDOWN_SCHEMA)
const validateBreakdownRejectionAjv = ajv.compile(BREAKDOWN_REJECTION_SCHEMA)
const validateIdentifyAjv = new Ajv({
  allErrors: true,
  strict: false,
  removeAdditional: true,
}).compile(IDENTIFY_SCHEMA)
const validateExpansionAjv = ajv.compile(EXPANSION_SCHEMA)
const validateDivergeAjv = ajv.compile(DIVERGE_SCHEMA)
const validateCompositionAjv = ajv.compile(COMPOSITION_SCHEMA)
const validateOptionAjv = ajv.compile(OPTION_SCHEMA)

export function parseBatchOutput(text: string, callId?: string): { groups: unknown[] } {
  let raw: unknown
  try {
    raw = parseModelJson(text, callId)
  } catch {
    throw new ModelOutputInvalidError("批次输出不是有效 JSON")
  }
  assert(
    !!raw && typeof raw === "object" && Array.isArray((raw as { groups?: unknown }).groups),
    "批次输出缺少 groups 数组"
  )
  return raw as { groups: unknown[] }
}

export function validateBatchGroupOptions(
  raw: { groups: unknown[] },
  definition: ChetaidouGroupDefinition,
  settings: ChetaidouSettings,
  countRange: CountRange,
  callId?: string
): ChetaidouOption[] {
  const matches = raw.groups.filter(
    g => g && typeof g === "object" && (g as { key?: string }).key === definition.key
  )
  assert(matches.length === 1, `维度 ${definition.key} 缺失或重复`)
  const options = (matches[0] as { options?: unknown }).options
  assert(Array.isArray(options), `维度 ${definition.key} 缺少 options 数组`)
  return validateOptionList(options, {
    settings,
    kind: definition.kind,
    purpose: definition.purpose,
    countRange,
    callId,
    dimensionKey: definition.key,
  })
}

// ── 业务校验（跨字段；schema 之外的第二道闸） ─────────────────────────────

export class ModelOutputInvalidError extends Error {
  constructor(
    message: string,
    readonly issues: unknown[] = []
  ) {
    super(message)
    this.name = "ModelOutputInvalidError"
  }
}

/** 同名问题不等于同一决策范围；旧记录缺少原问题时不推断可替换。 */
export function compositionScopeKey(
  question: string | undefined,
  sources: string[]
): string | null {
  if (!question?.trim() || !sources.length) return null
  return createHash("sha256")
    .update(JSON.stringify([question.trim(), [...new Set(sources)].sort()]))
    .digest("hex")
}

/** 仅组合入口将 JSON 语法错误纳入内容修复，不改变其他阶段的异常语义。 */
export function parseCompositionJson(text: string, callId?: string): unknown {
  try {
    return parseModelJson(text, callId)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new ModelOutputInvalidError("组合结果不是合法 JSON", [
      { keyword: "parse", message: error.message },
    ])
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ModelOutputInvalidError(message)
}

/** 本地只修复已闭合的内容，不让修复器补写截断回复。 */
function hasCompleteJsonContainers(body: string): boolean {
  const stack: Array<{ opener: string; hasColon: boolean }> = []
  let quote: string | null = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  let previous = ""
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    const next = body[index + 1]
    if (lineComment) {
      if (char === "\n" || char === "\r") lineComment = false
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) {
        quote = null
        previous = "string"
      }
      continue
    }
    if (char === "/" && next === "/") {
      lineComment = true
      index++
      continue
    }
    if (char === "/" && next === "*") {
      blockComment = true
      index++
      continue
    }
    if (/\s/.test(char)) continue
    if (body.startsWith("...", index) || /^(undefined|NaN|Infinity)\b/.test(body.slice(index)))
      return false
    if (/[\d-]/.test(char) && [":", "[", ","].includes(previous)) {
      const number = body.slice(index).match(/^[^\s,}\]/]+/)?.[0] ?? ""
      if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(number)) return false
      index += number.length - 1
      previous = "number"
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "{" || char === "[") stack.push({ opener: char, hasColon: false })
    else if (char === ":") {
      const container = stack.at(-1)
      if (container?.opener !== "{") return false
      container.hasColon = true
    } else if (char === "}" || char === "]") {
      const container = stack.pop()
      if (previous === ":" || container?.opener !== (char === "}" ? "{" : "[")) return false
      if (char === "}" && !["{", ","].includes(previous) && !container.hasColon) return false
      if (stack.length === 0) return !body.slice(index + 1).trim()
    } else if (char === ",") {
      if ([":", "{", "[", ","].includes(previous)) return false
      const container = stack.at(-1)
      if (container?.opener === "{") {
        if (!container.hasColon) return false
        container.hasColon = false
      }
    }
    previous = char
  }
  return false
}

/** 新放宽范围仅允许内部补分隔符/闭合符，原文每个字符都必须保留。 */
function internalJsonInsertions(
  body: string,
  repaired: string
): Array<{ offset: number; text: string }> | null {
  const insertions: Array<{ offset: number; text: string }> = []
  const contentEnd = body.trimEnd().length
  let originalIndex = 0
  let repairedIndex = 0
  let inString = false
  let escaped = false
  while (repairedIndex < repaired.length) {
    const char = repaired[repairedIndex]
    if (originalIndex < body.length && body[originalIndex] === char) {
      if (inString) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      originalIndex++
    } else {
      if (inString || originalIndex >= contentEnd || !",}]".includes(char)) return null
      const last = insertions.at(-1)
      if (last?.offset === originalIndex) last.text += char
      else insertions.push({ offset: originalIndex, text: char })
    }
    repairedIndex++
  }
  return originalIndex === body.length && insertions.length > 0 ? insertions : null
}

/** 直解失败仅本地修复一次；不修改原回执，不调用模型。 */
export function parseModelJson(text: string, callId?: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  const body = fenced ? fenced[1] : trimmed
  try {
    return JSON.parse(body)
  } catch (error) {
    if (!body.startsWith("{") && !body.startsWith("[")) throw error
    try {
      const complete = hasCompleteJsonContainers(body)
      const repaired = jsonrepair(body)
      const insertions = complete ? null : internalJsonInsertions(body, repaired)
      if (!complete && !insertions) throw error
      const parsed: unknown = JSON.parse(repaired)
      outputLogger.warn({
        message: "模型输出已本地修复 JSON 格式，原始回执保留",
        callId,
        ...(insertions ? { insertions } : {}),
      })
      return parsed
    } catch {
      throw error
    }
  }
}

/** 明显无关图片只返回拒绝结果；正常拆解沿用原契约及业务校验。 */
export function validateBreakdownResponse(
  data: unknown
): ChetaidouBreakdownPayload | { status: "REJECTED"; reason: string } {
  if (validateBreakdownRejectionAjv(data)) {
    return data as { status: "REJECTED"; reason: string }
  }
  return validateBreakdownOutput(data)
}

/** A2 拆解输出校验 */
export function validateBreakdownOutput(data: unknown): ChetaidouBreakdownPayload {
  if (!validateBreakdownAjv(data)) {
    throw new ModelOutputInvalidError(ajvErrorsToString(validateBreakdownAjv.errors))
  }
  const payload = data as ChetaidouBreakdownPayload
  const personIds = new Set(payload.persons.map(p => p.personId))
  assert(
    (payload.hasPeople && payload.persons.length > 0) ||
      (!payload.hasPeople && payload.persons.length === 0),
    "hasPeople 与 persons 数组不一致"
  )
  const textIds = new Set<string>()
  for (const t of payload.textInventory) {
    assert(!textIds.has(t.textId), `textId 重复：${t.textId}`)
    textIds.add(t.textId)
    assert(
      !(t.category !== "marketing" && t.editable),
      `非营销文字不可标记可编辑：${t.textId}(${t.category})`
    )
  }
  assert(personIds.size === payload.persons.length, "personId 重复")
  for (const list of [payload.baskets, payload.pets, payload.props]) {
    if (list) assert(new Set(list.map(item => item.id)).size === list.length, "拆解对象 ID 重复")
  }
  for (const basket of [payload.basketContents, ...(payload.baskets ?? [])]) {
    assert(basket.hasItems !== false || basket.items.length === 0, "空货篮不能同时包含物品")
  }
  if (payload.baskets?.length) {
    const observed = payload.baskets.some(b => b.hasItems === true)
      ? true
      : payload.baskets.some(b => b.hasItems === null)
        ? null
        : false
    assert(payload.basketContents.hasItems === observed, "货篮汇总与各货篮状态不一致")
  }
  return payload
}

/**
 * 服务端推导必需维度（方案 §7.2）：show → copy 维；每个 occupied 货篮 →
 * basket_contents 维（purpose）
 */
export function deriveRequiredDimensions(
  breakdown: ChetaidouBreakdownPayload,
  settings: ChetaidouSettings
): Array<{ kind: "copy" } | { purpose: string; basketId?: string }> {
  const required: Array<{ kind: "copy" } | { purpose: string; basketId?: string }> = []
  if (settings.textMode === "show") required.push({ kind: "copy" })
  const occupied = breakdown.baskets?.filter(b => b.hasItems === true) ?? []
  if (occupied.length)
    required.push(...occupied.map(b => ({ purpose: "basket_contents", basketId: b.id })))
  else if (breakdown.basketContents?.hasItems === true)
    required.push({ purpose: "basket_contents" })
  return required
}

/** A3 维度识别输出校验（含必需维度覆盖推导） */
export function validateIdentifyOutput(
  data: unknown,
  ctx: {
    breakdown: ChetaidouBreakdownPayload | null
    settings: ChetaidouSettings
    countRange?: CountRange
    callId?: string
  }
): {
  summary: string
  basketContents: ChetaidouBreakdownPayload["basketContents"]
  groups: ChetaidouGroupDefinition[]
} {
  // 清洗解析副本，保留原始模型回执供核对。
  const normalized = structuredClone(data)
  const groups = (normalized as { groups?: unknown } | null)?.groups
  if (Array.isArray(groups)) {
    const retained: unknown[] = []
    const removed: Array<{ index: number; reason: string }> = []
    for (const [index, group] of groups.entries()) {
      if (group && typeof group === "object" && !Array.isArray(group)) {
        const definition = group as Record<string, unknown>
        if (
          (ctx.settings.textMode !== "show" && definition.kind === "copy") ||
          (ctx.settings.textMode === "hide" && definition.purpose === "copy_layout")
        ) {
          removed.push({ index, reason: `textMode=${ctx.settings.textMode} 禁止该文案维度` })
          continue
        }
        Object.assign(group, { selectionMode: "single" })
        if ((group as { currentValue?: unknown }).currentValue === undefined) {
          Object.assign(group, { currentValue: "未指定" })
        }
      }
      retained.push(group)
    }
    Object.assign(normalized as object, { groups: retained })
    if (removed.length)
      outputLogger.warn({
        message: "已剔除禁止维度",
        callId: ctx.callId,
        removedCount: removed.length,
        removed,
      })
  }
  if (!validateIdentifyAjv(normalized)) {
    throw new ModelOutputInvalidError(ajvErrorsToString(validateIdentifyAjv.errors))
  }
  const parsed = normalized as {
    summary: string
    basketContents: ChetaidouBreakdownPayload["basketContents"]
    groups: ChetaidouGroupDefinition[]
  }
  const keys = new Set<string>()
  const labels = new Set<string>()
  for (const g of parsed.groups) {
    assert(!keys.has(g.key), `维度 key 重复：${g.key}`)
    keys.add(g.key)
    assert(!labels.has(g.label), `维度名称重复：${g.label}`)
    labels.add(g.label)
    assertCopyLayoutDefinition(g, ctx.settings)
  }
  // textMode 对 copy 维的约束
  if (ctx.settings.textMode === "show") {
    assert(
      parsed.groups.some(g => g.kind === "copy"),
      "textMode=show 必须包含文案（copy）维度"
    )
  } else {
    assert(
      !parsed.groups.some(g => g.kind === "copy"),
      `textMode=${ctx.settings.textMode} 不允许文案（copy）维度`
    )
  }
  if (ctx.breakdown)
    for (const required of deriveRequiredDimensions(ctx.breakdown, ctx.settings)) {
      if ("purpose" in required)
        assert(
          parsed.groups.some(
            g =>
              g.purpose === required.purpose &&
              (!required.basketId || g.basketId === required.basketId)
          ),
          `货篮 ${required.basketId ?? ""} 有物品时必须提供对应的 basket_contents 维度`
        )
    }
  return parsed
}

/** A5 单维扩展输出校验（元数据不得漂移，数量范围仅作生成目标） */
export function validateExpansionOutput(
  data: unknown,
  ctx: {
    definition: ChetaidouGroupDefinition
    settings: ChetaidouSettings
    /** 保留调用契约，数量目标不作为输出失败条件。 */
    maxOptions?: number
    countRange?: CountRange
    callId?: string
  }
): ChetaidouOption[] {
  // AI 维度的选择模式由后端决定，不依赖模型回填或历史多选元数据。
  if (
    data &&
    typeof data === "object" &&
    "group" in data &&
    data.group &&
    typeof data.group === "object" &&
    !Array.isArray(data.group)
  ) {
    data = { ...data, group: { ...data.group, selectionMode: "single" } }
  }
  if (!validateExpansionAjv(data)) {
    throw new ModelOutputInvalidError(ajvErrorsToString(validateExpansionAjv.errors))
  }
  const group = (data as { group: ChetaidouGroupDefinition & { options: unknown[] } }).group
  const def = ctx.definition
  assert(group.key === def.key, `维度 key 漂移：${group.key} ≠ ${def.key}`)
  assert(group.kind === def.kind, `kind 漂移：${group.key}`)
  if (def.basketId) assert(group.basketId === def.basketId, `basketId 漂移：${group.key}`)
  if (def.purpose) assert(group.purpose === def.purpose, `purpose 漂移：${group.key}`)
  return validateOptionList(group.options as ChetaidouOption[], {
    settings: ctx.settings,
    kind: def.kind,
    purpose: def.purpose,
    maxOptions: ctx.maxOptions,
    countRange: ctx.countRange,
    callId: ctx.callId,
    dimensionKey: def.key,
  })
}

/** A6 DIVERGE 输出校验 */
export function validateDivergeOutput(
  data: unknown,
  ctx: {
    settings: ChetaidouSettings
    maxOptions?: number
    countRange?: CountRange
    callId?: string
  }
): ChetaidouOption[] {
  if (!validateDivergeAjv(data)) {
    throw new ModelOutputInvalidError(ajvErrorsToString(validateDivergeAjv.errors))
  }
  const options = (data as { options: ChetaidouOption[] }).options
  return validateOptionList(options, {
    settings: ctx.settings,
    kind: "visual",
    maxOptions: ctx.maxOptions,
    countRange: ctx.countRange,
    callId: ctx.callId,
  })
}

function assertCopyLayoutDefinition(
  definition: { kind: string; purpose?: string },
  settings: ChetaidouSettings
) {
  if (definition.purpose !== "copy_layout") return
  assert(definition.kind === "visual", "文案排版（copy_layout）必须为 visual，不能作为文案内容维度")
  assert(settings.textMode !== "hide", "textMode=hide 不允许文案排版维度")
}

function validateOptionList(
  options: unknown[],
  ctx: {
    settings: ChetaidouSettings
    kind: string
    purpose?: string
    maxOptions?: number
    countRange?: CountRange
    callId?: string
    dimensionKey?: string
  }
): ChetaidouOption[] {
  assertCopyLayoutDefinition(ctx, ctx.settings)
  // 用户数量范围是生成目标，少于/超过目标或去重后减少都保留实际结果。
  const keys = new Set<string>()
  const labels = new Set<string>()
  const uniqueOptions: ChetaidouOption[] = []
  const removed: Array<{ index: number; reason: string }> = []
  const locale = CHETAIDOU_SITES[ctx.settings.site] ?? null
  for (const [index, raw] of options.entries()) {
    try {
      let normalized = raw
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        // 辅助字段缺失不丢弃方案；只补解析副本，已返回的错误类型仍校验。
        const candidate = { ...raw } as Record<string, unknown>
        for (const field of ["dependentChanges", "incompatibleWith"])
          if (candidate[field] === undefined) candidate[field] = []
        if (candidate.requiresEvidence === false && candidate.evidenceNeeded === undefined)
          candidate.evidenceNeeded = []
        normalized = candidate
      }
      assert(validateOptionAjv(normalized), ajvErrorsToString(validateOptionAjv.errors))
      const opt = normalized as ChetaidouOption
      // 同名方案保留首次出现的完整选项，不能因为模型重复一项而丢掉整个维度。
      const labelNorm = opt.label.trim()
      if (labels.has(labelNorm)) {
        removed.push({ index, reason: "选项名称重复，保留首次合格项" })
        continue
      }
      assert(!keys.has(opt.key), `选项 key 重复：${opt.key}`)
      if (ctx.purpose === "copy_layout") {
        assert(
          opt.targetText === undefined &&
            opt.targetLocale === undefined &&
            opt.meaningCn === undefined,
          `文案排版选项只能描述排版，不能包含 targetText/targetLocale/meaningCn：${opt.key}`
        )
      }
      if (ctx.kind === "copy") {
        assert(
          !!opt.targetText && !!opt.targetLocale && !!opt.meaningCn,
          `copy 选项缺少 targetText/targetLocale/meaningCn：${opt.key}`
        )
        if (locale) {
          assert(
            opt.targetLocale === locale,
            `copy 选项 targetLocale(${opt.targetLocale}) 与站点 locale(${locale}) 不一致：${opt.key}`
          )
        }
      }
      labels.add(labelNorm)
      keys.add(opt.key)
      uniqueOptions.push(opt)
    } catch (error) {
      if (!(error instanceof ModelOutputInvalidError)) throw error
      removed.push({ index, reason: error.message })
    }
  }
  if (removed.length)
    outputLogger.warn({
      message: "已剔除不合格或重复选项",
      callId: ctx.callId,
      dimensionKey: ctx.dimensionKey,
      removedCount: removed.length,
      removed,
    })
  assert(uniqueOptions.length > 0, `没有可用选项${removed.length ? `：${removed[0].reason}` : ""}`)
  return uniqueOptions
}

/** A7 组合输出校验（结构 + 文案规则 + 覆盖精确性） */
/** 模型偶发把 changedFeatures/preservedFeatures 输出为对象数组——归一化为
 *  字符串（取 label/text/name/description/feature 字段，兜底 JSON 摘要）。 */
function normalizeFeatureStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): string => {
      if (typeof item === "string") return item
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>
        for (const key of ["label", "text", "name", "description", "feature"]) {
          if (typeof o[key] === "string" && o[key]) return o[key]
        }
        return JSON.stringify(item).slice(0, 120)
      }
      return String(item)
    })
    .filter(v => v.length > 0)
}

export interface CompositionValidationContext {
  settings: ChetaidouSettings
  selectionIds: string[]
  effectiveDecisionIds: string[]
  breakdown: ChetaidouBreakdownPayload | null
  selections?: { selectionId: string; kind?: string; targetText?: string; targetLocale?: string }[]
  decisions?: {
    decisionId: string
    originalConflict?: { blocking: boolean; sources: string[] }
  }[]
}

export function validateCompositionOutput(
  data: unknown,
  ctx: CompositionValidationContext
): ChetaidouComposeOutput {
  // 旧冻结模板可能继续返回已撤销的扩展字段；仅忽略该字段，不改写原始回执。
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const candidate = { ...(data as Record<string, unknown>) }
    if (candidate.status === "ready" && Array.isArray(candidate.hardConstraintChecks))
      assert(
        !candidate.hardConstraintChecks.some(
          (check: unknown) =>
            check &&
            typeof check === "object" &&
            (check as { status?: unknown }).status === "conflict"
        ),
        "组合包含未解决的硬事实冲突"
      )
    delete candidate.hardConstraintChecks
    data = candidate
  }
  if (!validateCompositionAjv(data)) {
    throw new ModelOutputInvalidError(
      ajvErrorsToString(validateCompositionAjv.errors),
      structuredClone(validateCompositionAjv.errors ?? [])
    )
  }
  const raw = { ...(data as ChetaidouComposeOutput) }
  const mode = (data as { status: string }).status === "ready" ? "READY" : "NEEDS_RESOLUTION"
  if (mode === "NEEDS_RESOLUTION") {
    assert(raw.conflicts.length > 0, "NEEDS_RESOLUTION 组合必须携带至少一个问题")
    const conflictIds = new Set<string>()
    for (const c of raw.conflicts) {
      assert(!conflictIds.has(c.id), `冲突 id 重复：${c.id}`)
      conflictIds.add(c.id)
      assert(!!c.question.trim() && !!c.reason.trim(), "冲突问题和原因不可为空")
      assert(
        c.sources.every(source => !!source.trim()),
        "冲突来源不可为空"
      )
      assert(c.blocking || c.choices.length > 0, "软性冲突必须提供处理选项")
      assert(
        new Set(c.choices.map(choice => choice.id)).size === c.choices.length,
        `冲突选项 ID 重复：${c.id}`
      )
      assert(
        c.choices.every(choice => !!choice.label.trim() && !!choice.instruction.trim()),
        `冲突选项缺少文案或处理指令：${c.id}`
      )
    }
    // 冲突结果没有最终生图产物，补齐展示形状不放宽 READY 校验。
    return {
      ...raw,
      status: mode,
      editPromptEn: null,
      coveredSelectionIds: [],
      changedFeatures: [],
      preservedFeatures: [],
      textReplacements: [],
      copyAdditions: [],
      acknowledgedAnswerIds: [],
    }
  }

  assert(!!raw.editPromptEn?.trim(), "READY 组合缺少英文编辑指令")
  assert(raw.conflicts.length === 0, "READY 组合不应携带冲突")
  const expected = new Set(ctx.selectionIds)
  const covered = new Set(raw.coveredSelectionIds)
  assert(covered.size === raw.coveredSelectionIds.length, "覆盖 ID 不可重复")
  for (const id of expected) assert(covered.has(id), `覆盖缺少已选项：${id}`)
  for (const id of covered) assert(expected.has(id), `覆盖包含未知选项 ID：${id}`)

  const expectedDecisions = new Set(ctx.effectiveDecisionIds)
  const acknowledged = new Set(raw.acknowledgedAnswerIds)
  assert(acknowledged.size === raw.acknowledgedAnswerIds.length, "决策 ID 不可重复")
  for (const id of expectedDecisions) assert(acknowledged.has(id), `组合未确认有效决策：${id}`)
  for (const id of acknowledged) assert(expectedDecisions.has(id), `组合确认了未知决策：${id}`)

  const s = ctx.settings
  if (s.textMode === "keep" || s.textMode === "hide") {
    assert(
      raw.textReplacements.length === 0 && raw.copyAdditions.length === 0,
      `textMode=${s.textMode} 不允许产生翻译或新增文案`
    )
  }
  if (s.textMode === "show") {
    assert(raw.textReplacements.length === 0, "show 不允许产生逐条翻译")
    assert(raw.copyAdditions.length > 0, "show 缺少准确目标文案")
    for (const addition of raw.copyAdditions) {
      assert(addition.targetLocale === CHETAIDOU_SITES[s.site], "新增文案语言与目标站点不一致")
      assert(
        !!addition.targetText.trim() && !!addition.meaningCn.trim(),
        "新增文案及中文含义不可为空"
      )
      assert(
        raw.editPromptEn!.includes(addition.targetText),
        `新增文案未逐字进入编辑指令：${addition.targetText}`
      )
    }
    const resolvedCopyIds = new Set<string>()
    for (const decision of ctx.decisions ?? []) {
      const conflict = decision.originalConflict
      if (
        expectedDecisions.has(decision.decisionId) &&
        acknowledged.has(decision.decisionId) &&
        conflict?.blocking === false &&
        conflict.sources.length > 0 &&
        conflict.sources.every(id => expected.has(id))
      )
        conflict.sources.forEach(id => resolvedCopyIds.add(id))
    }
    for (const selection of ctx.selections ?? []) {
      if (
        selection.kind !== "copy" ||
        !selection.targetText ||
        (selection.targetLocale !== undefined &&
          selection.targetLocale !== CHETAIDOU_SITES[s.site]) ||
        resolvedCopyIds.has(selection.selectionId)
      )
        continue
      assert(
        raw.copyAdditions.some(addition => addition.targetText === selection.targetText),
        `已选文案未原样保留：${selection.selectionId}`
      )
    }
  }
  if (s.textMode === "translate") {
    assert(raw.copyAdditions.length === 0, "translate 不允许新增文案")
    const editable = (ctx.breakdown?.textInventory ?? []).filter(
      t => t.category === "marketing" && t.editable && t.readability === "readable"
    )
    const translated = new Set<string>()
    for (const replacement of raw.textReplacements) {
      const source = editable.find(t => t.textId === replacement.textId)
      assert(
        !!source && source.sourceText === replacement.sourceText,
        `翻译原文不匹配或不可编辑：${replacement.textId}`
      )
      assert(!translated.has(replacement.textId), `翻译 textId 重复：${replacement.textId}`)
      translated.add(replacement.textId)
      assert(replacement.targetLocale === CHETAIDOU_SITES[s.site], "翻译语言与目标站点不一致")
      assert(
        !!replacement.targetText.trim() && raw.editPromptEn!.includes(replacement.targetText),
        `翻译未逐字进入编辑指令：${replacement.textId}`
      )
    }
    assert(
      editable.every(t => translated.has(t.textId)),
      "翻译遗漏可编辑营销文案"
    )
  }
  return {
    ...raw,
    status: mode,
    changedFeatures: normalizeFeatureStrings(raw.changedFeatures),
    preservedFeatures: normalizeFeatureStrings(raw.preservedFeatures),
  }
}

// ── DTO 侧校验（服务端入参，非模型输出） ──────────────────────────────────

/** settings 白名单与语言规则（方案 §5.4） */
export function validateSettings(
  settings: ChetaidouSettings,
  breakdown: ChetaidouBreakdownPayload | null
): void {
  for (const name of ["dimensionCountRange", "optionCountRange"] as const) {
    if (settings[name] !== undefined && !validCountRange(settings[name]))
      throw new BadRequestException(`${name} 必须为非负安全整数范围，且 min ≤ max`)
  }
  assert(!!settings.site && settings.site in CHETAIDOU_SITES, `未知站点：${settings.site}`)
  assert(
    ["keep", "hide", "translate", "show"].includes(settings.textMode),
    `未知文字模式：${settings.textMode}`
  )
  assert(["keep", "replace"].includes(settings.personMode), `未知人物模式：${settings.personMode}`)
  if (settings.textMode === "translate" || settings.textMode === "show") {
    assert(settings.site !== "original", `${settings.textMode} 要求非 original 站点`)
  }
  if (settings.textMode === "translate" && breakdown) {
    const hasEditableMarketing = breakdown.textInventory.some(
      t => t.editable && t.category === "marketing" && t.readability === "readable"
    )
    assert(hasEditableMarketing, "translate 要求存在可读、可编辑的营销文字（当前母版没有）")
  }
  if (settings.personText.length > 1000)
    throw new ModelOutputInvalidError("personText 超过 1000 字")
  if (settings.customText.length > 1000)
    throw new ModelOutputInvalidError("customText 超过 1000 字")
}
