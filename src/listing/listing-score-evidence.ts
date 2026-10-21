import { projectListingAttributeCriterion } from "./listing-attribute-score"
import { findListingBulletDataPoint } from "./listing-bullet-data"

/** 原文证据只约束已有评分检查点；模型取证，程序按原规则计算。 */
export interface ListingScoreSource {
  mode?: "standard" | "custom"
  title: string
  itemHighlights: string
  bullets: string[]
  description: string
  searchTerms: string
  keywordDataBlock?: string
  /** 原始属性字段；统计行保留为证据，由属性核算排除，不代表后台必填清单。 */
  structuredAttributes?: Array<{ name: string; value: string }>
  /** 仅服务端从本次首次评估冻结，不能从客户端输入接收。 */
  longtailTerms?: string[]
}

interface EvidenceDeduction {
  ruleId: string
  points: number
  reason: string
  evidence: string
  checkId?: string
}

export interface ListingEvidenceProjection {
  score: number
  description: string
  deductions: EvidenceDeduction[]
  assessment: Record<string, unknown>
}

const MEDIUM_RELATIONS = ["IS_A", "USED_TO", "USED_BY", "USED_FOR_EVE"]
const DESCRIPTION_CHECKS = ["specifications", "overview_scenes"]
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const normalizeText = (value: string): string => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()
const roundScore = (value: number): number => Math.round(value * 10000) / 10000
const fail = (message: string): never => { throw new Error(`原文证据核验：${message}`) }

/** 只读取专用结构化原文块，历史请求不强行猜测字段边界。 */
export function parseListingScoreSource(userPrompt: string): ListingScoreSource | undefined {
  const startTag = "<listing-scoring-source>", endTag = "</listing-scoring-source>"
  const prompt = userPrompt.trimEnd()
  const start = prompt.lastIndexOf(startTag)
  if (start < 0 || !prompt.endsWith(endTag)) return undefined
  try {
    const value: unknown = JSON.parse(prompt.slice(start + startTag.length, -endTag.length))
    if (!isRecord(value) || !Array.isArray(value.bullets) || value.bullets.some(item => typeof item !== "string")) return undefined
    const getText = (key: string): string | undefined => {
      const item = value[key]
      return typeof item === "string" ? item : Array.isArray(item) && item.every(text => typeof text === "string") ? item.join(" ") : undefined
    }
    const title = getText("title"), itemHighlights = getText("itemHighlights")
    const description = getText("description"), searchTerms = getText("searchTerms")
    if ([title, itemHighlights, description, searchTerms].some(item => item === undefined)) return undefined
    const mode = /^mode[：:]\s*(standard|custom)(?:\r?\n|$)/.exec(userPrompt)?.[1] as "standard" | "custom" | undefined
    return {
      ...(mode ? { mode } : {}),
      title: title!, itemHighlights: itemHighlights!, description: description!, searchTerms: searchTerms!,
      bullets: [...value.bullets] as string[],
      ...(Array.isArray(value.structuredAttributes) && value.structuredAttributes.length > 0 &&
        value.structuredAttributes.every(item => isRecord(item) && typeof item.name === "string" && typeof item.value === "string")
        ? { structuredAttributes: value.structuredAttributes.map(item => ({ name: item.name as string, value: item.value as string })) } : {}),
      ...(typeof value.keywordDataBlock === "string" ? { keywordDataBlock: value.keywordDataBlock } : {}),
    }
  } catch { return undefined }
}

export function getListingEvidenceRequirement(dimensionIndex: number, criterionIndex: number, source?: ListingScoreSource): Record<string, unknown> | undefined {
  const key = `${dimensionIndex}:${criterionIndex}`
  const common = "assessment中的quote/quotes必须摘录listing-scoring-source对应字段原文，保留精确词句；不能引用currentCriterion或其他评分结论。缺失项仍逐一列出，不能省略。field用title/itemHighlights/description/searchTerms/bullets.1（从1计数）。分数和扣分由程序计算。"
  if (key === "0:0" && source?.structuredAttributes?.length) return {
    instructions: "属性原文为listing-scoring-source.structuredAttributes。请为全部实际属性逐一填写attributeChecks，index是原始数组从1开始的位置；ASIN、BSR、评论统计行不参与。正确与待确认的属性也逐条列出，不能只列扣分项、合并或重复索引。weight必须为JSON数字，按文档3/2/1，不要写数字字符串；errorType按矛盾→错位→单位→营销顺序命中即停，分辨不了填PENDING且建议补证。comparison只引用本次实际原文，field用title/itemHighlights/description/bullets.1/attributes.1。矛盾必须引用另一个同口径事实的实际原值，Printer等泛化品类不能用来证明型号矛盾；包数/件数错位必须引用实际包装层级。颜色矛盾必须引用另一处颜色原值（如实际Ink Colour），不能引用不包含颜色信息的型号/产品名短语。quote必须为原文连续片段，可取短但完整的型号或颜色，不用省略号、中文改写或自行拼接；例如不能在截断型号后添加原文不存在的“...”。中性产品描述用PRODUCT_DESCRIPTION，不能写MARKETING；页产量口径不明用PENDING。suggestion用卖家能操作的改法，直接说明当前字段建议填什么，不能只说“填写不规范”；有证据才建议具体替换值，待确认写明需补齐的事实。不在suggestion中写权重、扣除比例、模型判定等计算术语。程序按既有严重度生成严重/中等/待确认分组和折叠核算说明。所有权重分母、分值和描述由程序依据完整表统一计算，模型不得把失分份额或百分比直接填成扣分。此表复用可选assessment，旧客户端不提供原始属性时仍沿用既有接口。",
    assessment: { attributeChecks: [{ index: 1, weight: 2, errorType: "NONE | CONTRADICTION | TYPE_MISMATCH | WRONG_FIELD | GRANULARITY | PRODUCT_DESCRIPTION | UNIT_MISMATCH | MISSING_UNIT | MARKETING | PENDING", comparison: [{ field: "原始字段，如attributes.2或bullets.1；无须比较时[]", quote: "同口径支持判断的真实原文" }], suggestion: "具体改法；NONE可为空；PENDING写待确认口径" }] },
    formula: "W=全部非统计属性权重之和；扣除比例按类型固定100%/50%/0%；逐项扣分=30×weight×比例/W，score=30−逐项扣分合计。不得将总权重、总扣分或总体描述当成事实来源。",
  }
  if (key === "1:2") return {
    instructions: common + "仅在Bullet、真实description、searchTerms核对长尾；标题和亮点不参与本项。先列全候选词（包括未覆盖词），有B/C关键词数据先按原规则排除跨品类词，否则依据行业推断。不得为提高得分缩减、替换同次冻结的候选词表。模型可提供field/quote，但程序会在允许原文字段中直接逐词匹配并重新生成field/quote；只命中标题或亮点不算覆盖。大小写、空格和标点差异归一，按完整词边界匹配。basis由实际是否提供B/C数据判定，不以模型标签为准。",
    assessment: { basis: "provided | inferred", terms: [{ term: "候选长尾词", field: "bullets.1 | description | searchTerms | 空字符串", quote: "原文中包含该候选词的短语；未覆盖为空" }], excludedTerms: [{ term: "仅提供词表中的跨品类词", reason: "与当前产品不符的具体原因；无排除则[]" }] },
    formula: "覆盖率=覆盖词数/候选词总数；得分=5×min(覆盖率/0.7,1)。不得因SEARCH TERMS未获取把其他字段的未覆盖词判已覆盖。",
  }
  if (key === "2:2") return {
    instructions: common + "固定四类各列一次，quote为空表示该关系未覆盖。正向判断必须写出完整支持该关系的原文：IS_A支持产品身份/类型，USED_TO支持具体用途/动作，USED_BY支持具体使用者，USED_FOR_EVE支持具体事件/活动。仅产品名Ink不同时证明用途、使用者或事件，不能将同一无关产品名复用到多类关系。若一段原文包含多类关系，分别摘出各自有实义的不同片段；不同关系不得复用完全相同的quote。不能把推断关系的中文解释充当原文。",
    assessment: { relations: MEDIUM_RELATIONS.map(type => ({ type, field: "实际原文字段，未覆盖为空", quote: "支持该关系的原文，未覆盖为空" })) },
    formula: "已覆盖关系数≥3得4分；低于3时每缺一类扣1.5，最低0，即max(0,4-1.5×max(0,3-覆盖数))。",
  }
  if (key === "3:1") return {
    instructions: common + "按实际全部N条分别核验，index从1开始、每条一次。合格quote只引用该条的具名规格/认证/数字指标本身，kind=numeric/specification/certification；不合格quote为空、kind为空。明确兼容型号（如ET-2850）是具名规格、明确24/7服务时间是数字指标，不能只认容量/页数而漏掉它们。不得借用别条的数据；premium/best/high-quality、rigorous testing、dozens等泛称不是可验证数据点，不能用整条营销文案代替具体数据点。无数字的具名规格/认证可用specification/certification，不能虚构准入条件。",
    assessment: { bullets: [{ index: 1, kind: "numeric | specification | certification | 空字符串", quote: "本条的具体数据点原文，不合格为空" }] },
    formula: "standard得分=5×合格条数/N，N=0时0分；custom固定按6条基准：得分=min(5,5×合格条数/6)，即使实际输入不是6条也不得改用实际N作分母。两种模式均须逐条核验全部实际输入。",
  }
  if (key === "3:2") return {
    instructions: common + "只能使用真实description原文，不得借用标题、Bullet、结构化属性或页面摘要。必须分别列两类检查。specifications有规格段时引用规格段字段和具体值（原文字段:值或HTML表格字段值），不能只引excellent等形容词；overview_scenes有至少两个具体场景时分别引用不同且不重叠的完整场景原文短语，不能把一句话拆成My ink与ink is伪装成两个场景。不能把同一场景换句式重复计算。未满足检查时isPresent=false且quotes=[]。不另增格式、段数或措辞扣分。",
    assessment: { checks: DESCRIPTION_CHECKS.map(checkId => ({ checkId, isPresent: "boolean", quotes: ["该检查的原文证据；未满足时[]"] })) },
    formula: "满分3；缺规格段扣1，PRODUCT OVERVIEW缺场景扣1，分别计算、每类仅一次。",
  }
  return undefined
}

function getFieldText(source: ListingScoreSource, field: unknown): string {
  if (typeof field !== "string") return fail("field必须为原文字段名")
  if (["title", "itemHighlights", "description", "searchTerms"].includes(field)) return source[field as "title" | "itemHighlights" | "description" | "searchTerms"]
  const match = /^bullets\.(\d+)$/.exec(field)
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= source.bullets.length) return source.bullets[Number(match[1]) - 1]
  return fail(`未知证据字段${field}`)
}

function validateQuote(source: ListingScoreSource, field: unknown, quote: unknown): string {
  if (typeof quote !== "string" || !quote.trim()) return fail(`field=${String(field)}的正向判断必须提供非空原文引用`)
  if (!normalizeText(getFieldText(source, field)).includes(normalizeText(quote))) return fail(`${String(field)}不包含引用“${quote}”，禁止跨字段或虚构证据`)
  return quote.trim()
}

/** COSMO允许多个原文字段；仅在真实原文连续命中时纠正模型误标的出处。 */
function resolveRelationQuote(source: ListingScoreSource, field: unknown, quote: string): { field: string; quote: string } {
  const fields = ["title", "itemHighlights", "description", "searchTerms", ...source.bullets.map((_, index) => `bullets.${index + 1}`)]
  const candidates = typeof field === "string" && fields.includes(field)
    ? [field, ...fields.filter(candidate => candidate !== field)] : fields
  const matched = quote.trim() && candidates.find(candidate => normalizeText(getFieldText(source, candidate)).includes(normalizeText(quote)))
  if (matched) return { field: matched, quote: validateQuote(source, matched, quote) }
  return { field: String(field), quote: validateQuote(source, field, quote) }
}

function getEntries(assessment: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const entries = assessment[name]
  if (!Array.isArray(entries) || entries.some(item => !isRecord(item))) return fail(`assessment.${name}必须为逐项对象数组`)
  return entries as Record<string, unknown>[]
}

function getProvidedKeywords(source: ListingScoreSource): Array<{ tier: string; term: string }> {
  return [...(source.keywordDataBlock ?? "").matchAll(/^\s*\[([SABC])\]\s*(.*?)\s*(?:—|–|\s+-\s+|\|)\s*月搜索量.*$/gm)]
    .map(match => ({ tier: match[1], term: match[2].trim() })).filter(item => item.term)
}

function getKeywordTokens(value: string): Array<{ text: string; start: number; end: number }> {
  return [...value.matchAll(/[\p{L}\p{N}]+/gu)].map(match => ({
    text: normalizeText(match[0]), start: match.index!, end: match.index! + match[0].length,
  }))
}

const normalizeKeyword = (value: string): string => getKeywordTokens(value).map(token => token.text).join(" ")

/** 关键词覆盖为文本事实：只在原规则允许的字段内匹配，不依赖模型填写field/quote。 */
function findLongtailEvidence(source: ListingScoreSource, term: string): { field: string; quote: string } {
  const expected = getKeywordTokens(term).map(token => token.text)
  if (!expected.length) return fail(`长尾候选词“${term}”不包含有效词项`)
  const fields = [
    ...source.bullets.map((text, index) => ({ field: `bullets.${index + 1}`, text })),
    { field: "description", text: source.description },
    { field: "searchTerms", text: source.searchTerms },
  ]
  for (const { field, text } of fields) {
    const tokens = getKeywordTokens(text)
    for (let index = 0; index <= tokens.length - expected.length; index++) {
      if (expected.every((word, offset) => tokens[index + offset].text === word)) {
        return { field, quote: text.slice(tokens[index].start, tokens[index + expected.length - 1].end) }
      }
    }
  }
  return { field: "", quote: "" }
}

/** 候选分区先于命中核验，防止把首轮遗漏的provided分母永久冻结。 */
function getLongtailCandidatePlan(assessment: Record<string, unknown>, source: ListingScoreSource): { terms: string[]; basis: string } {
  const entries = getEntries(assessment, "terms")
  if (!entries.length) return fail("长尾须提供包含未覆盖词的非空候选词表")
  const terms: string[] = [], seen = new Set<string>()
  for (const item of entries) {
    if (typeof item.term !== "string" || !item.term.trim()) return fail("长尾候选词不能为空")
    const term = normalizeKeyword(item.term)
    if (!term) return fail(`长尾候选词“${item.term}”不包含有效词项`)
    if (seen.has(term)) return fail(`长尾词${item.term}重复`)
    seen.add(term)
    terms.push(item.term.trim())
  }
  const provided = getProvidedKeywords(source)
  const providedKeys = new Set(provided.map(item => normalizeKeyword(item.term)))
  const providedLongtailKeys = new Set(provided.filter(item => ["B", "C"].includes(item.tier)).map(item => normalizeKeyword(item.term)))
  const excluded = assessment.excludedTerms === undefined ? [] : getEntries(assessment, "excludedTerms")
  const excludedKeys = new Set<string>()
  for (const item of excluded) {
    if (typeof item.term !== "string" || typeof item.reason !== "string" || !item.reason.trim()) return fail("跨品类排除词必须提供具体term和reason")
    const term = normalizeKeyword(item.term)
    if (!providedKeys.has(term) || seen.has(term) || excludedKeys.has(term)) return fail(`跨品类排除词“${item.term}”必须来自提供词表、不得与候选词重复`)
    excludedKeys.add(term)
  }
  // <3阈值针对整个S/A/B/C词库；长尾分母只取其中未被明确排除的B/C。
  const availableCount = [...providedKeys].filter(term => !excludedKeys.has(term)).length
  const remaining = [...providedLongtailKeys].filter(term => !excludedKeys.has(term))
  const isUsingProvided = remaining.length > 0 && availableCount >= 3
  if (isUsingProvided && (remaining.some(term => !seen.has(term)) || [...seen].some(term => !remaining.includes(term)))) {
    return fail("provided模式必须逐一核对提供的B/C词表，未覆盖词不能省略；跨品类词须说明排除原因")
  }
  if (source.longtailTerms) {
    const expected = new Set(source.longtailTerms.map(normalizeKeyword))
    if (expected.size !== seen.size || [...expected].some(term => !seen.has(term))) return fail("长尾候选词与本次冻结词表不一致，不得删除未覆盖词或替换分母")
  }
  return { terms, basis: isUsingProvided ? "provided" : "inferred" }
}

/** 仅合法候选分区可冻结，不要求模型field/quote或分数正确。 */
export function getListingLongtailTerms(criterion: { assessment?: unknown }, source: ListingScoreSource): string[] | undefined {
  if (!isRecord(criterion.assessment)) return undefined
  try { return getLongtailCandidatePlan(criterion.assessment, source).terms }
  catch { return undefined }
}

function projectLongtail(assessment: Record<string, unknown>, source: ListingScoreSource): ListingEvidenceProjection {
  const { terms, basis } = getLongtailCandidatePlan(assessment, source)
  const missing: string[] = [], covered: string[] = []
  const normalizedTerms = terms.map(term => {
    const evidence = findLongtailEvidence(source, term)
    if (evidence.quote) covered.push(term)
    else missing.push(term)
    return { term, ...evidence }
  })
  const score = roundScore(5 * Math.min(covered.length / terms.length / 0.7, 1))
  const description = `长尾词覆盖${covered.length}/${terms.length}（${roundScore(covered.length / terms.length * 100)}%）；${basis === "provided" ? "依据提供词表" : "依据行业推断词表"}${missing.length ? `；未覆盖：${missing.join("、")}` : ""}。`
  return { score, description, assessment: { ...assessment, basis, terms: normalizedTerms }, deductions: score < 5 ? [{ ruleId: "keyword.longtail", points: roundScore(5 - score), reason: `长尾词覆盖率低于70%；未覆盖：${missing.join("、")}`, evidence: description }] : [] }
}

function projectMediumRelations(assessment: Record<string, unknown>, source: ListingScoreSource): ListingEvidenceProjection {
  const relations = getEntries(assessment, "relations")
  if (relations.length !== MEDIUM_RELATIONS.length) return fail("中优先级关系必须完整列出四类")
  const seen = new Set<string>(), quotedRelations = new Set<string>(), covered: string[] = [], missing: string[] = []
  const normalizedRelations: Record<string, unknown>[] = []
  for (const item of relations) {
    if (typeof item.type !== "string" || !MEDIUM_RELATIONS.includes(item.type) || seen.has(item.type)) return fail("中优先级关系类型非法或重复")
    seen.add(item.type)
    if (typeof item.quote !== "string") return fail(`${item.type}缺少quote，未覆盖须明确为空`)
    if (item.quote.trim()) {
      const evidence = resolveRelationQuote(source, item.field, item.quote)
      const quote = evidence.quote
      normalizedRelations.push({ ...item, ...evidence })
      const quoteKey = normalizeKeyword(quote)
      if (quotedRelations.has(quoteKey)) return fail(`COSMO ${item.type}复用了相同证据“${quote}”，须分别摘出支持产品类型/用途/使用者/事件的原文片段`)
      quotedRelations.add(quoteKey)
      covered.push(item.type)
    } else {
      if (item.field !== "") return fail(`${item.type}未覆盖时field必须为空`)
      normalizedRelations.push({ ...item })
      missing.push(item.type)
    }
  }
  const points = Math.min(4, 1.5 * Math.max(0, 3 - covered.length))
  const description = `中优先级关系已覆盖${covered.length}类${covered.length ? `：${covered.join("、")}` : ""}；未覆盖：${missing.length ? missing.join("、") : "无"}。`
  return { score: roundScore(4 - points), description, assessment: { ...assessment, relations: normalizedRelations }, deductions: points > 0 ? [{ ruleId: "cosmo.medium", points, reason: `中优先级关系仅覆盖${covered.length}类，未达到3类；待补充：${missing.join("、")}`, evidence: description }] : [] }
}

function validateBulletDataPoint(kind: unknown, quote: string): void {
  if (!["numeric", "specification", "certification"].includes(String(kind))) return fail("合格Bullet必须标记numeric/specification/certification")
  const text = normalizeText(quote)
  if (kind === "numeric" && !/\d/.test(text)) return fail("numeric证据必须包含原文实际数字，不能把dozens等泛称当数字指标")
  // 仅排除原规则明确不承认可验证数据的空泛话术，不另列产品规格白名单。
  if (/^(?:premium|best|high[- ]quality|superior quality|professional quality|rigorous (?:quality )?testing|quality testing|consistent[, ]+reliable performance|reliable performance|strict (?:shipping )?tests?|dozens(?: of)?(?: strict)?(?: shipping)?(?: tests?)?|优质|高品质|严格(?:质量)?测试|品质保证)[.!。\s]*$/i.test(text))
    return fail("泛化质量或测试话术不是具名规格、认证或数字指标")
  if (kind !== "numeric" && !/\d/.test(text) && /(?:every (?:bottle|page)|your (?:work|satisfaction)|our (?:commitment|standard)|rigorous (?:quality )?testing|quality you can trust|colors that pop|professionally polished|fade-resistant colors|razor-sharp text|dozens of)/i.test(text))
    return fail("引用的是整条营销或质量描述，须只引用具体具名规格/认证，不能据此判为合格")
}

function projectBulletData(assessment: Record<string, unknown>, source: ListingScoreSource): ListingEvidenceProjection {
  const bullets = getEntries(assessment, "bullets")
  if (bullets.length !== source.bullets.length) return fail(`Bullet必须完整评估实际${source.bullets.length}条，不能漏条、合并或按固定5条评分`)
  const seen = new Set<number>(), qualified: number[] = [], unqualified: number[] = []
  const normalizedBullets: Record<string, unknown>[] = []
  for (const item of bullets) {
    if (!Number.isSafeInteger(item.index) || Number(item.index) < 1 || Number(item.index) > source.bullets.length || seen.has(Number(item.index))) return fail("Bullet索引必须从1开始、逐条唯一且不越界")
    const index = Number(item.index)
    seen.add(index)
    if (typeof item.quote !== "string") return fail(`Bullet ${index}缺少quote，不合格也须明确为空`)
    const explicit = !item.quote.trim() ? findListingBulletDataPoint(source.bullets[index - 1]) : undefined
    const normalized = explicit ? { ...item, ...explicit } : item
    normalizedBullets.push(normalized)
    if (!(normalized.quote as string).trim()) {
      if (item.kind !== "" && item.kind !== undefined) return fail(`Bullet ${index}未提供数据点时kind必须为空`)
      unqualified.push(index)
    } else {
      const quote = validateQuote(source, `bullets.${index}`, normalized.quote)
      validateBulletDataPoint(normalized.kind, quote)
      qualified.push(index)
    }
  }
  qualified.sort((a, b) => a - b); unqualified.sort((a, b) => a - b)
  const denominator = source.mode === "custom" ? 6 : source.bullets.length
  const score = denominator ? Math.min(5, roundScore(5 * qualified.length / denominator)) : 0
  const description = `逐条核验${source.bullets.length}条Bullet，合格${qualified.length}条${qualified.length ? `（${qualified.join("、")}）` : ""}${unqualified.length ? `；未含可验证数据点：${unqualified.join("、")}` : ""}。`
  return { score, description, assessment: { ...assessment, bullets: normalizedBullets }, deductions: score < 5 ? [{ ruleId: "alexa.bulletData", points: roundScore(5 - score), reason: !source.bullets.length ? "未提供Bullet，实际条数为0" : unqualified.length ? `Bullet ${unqualified.join("、")}缺少具名规格、认证或数字指标${source.mode === "custom" ? "；按custom固定6条基准计分" : ""}` : `custom按固定6条基准计分，本次实际核验${source.bullets.length}条、合格${qualified.length}条`, evidence: description }] : [] }
}

function hasSpecificationStructure(quote: string): boolean {
  const isSpecificationLabel = (label: string) => !/^(?:(?:product\s+)?overview|description|产品(?:概述|描述))$/i.test(label.trim())
  // 仅结构识别副本去除行内HTML标记，原quote仍由validateQuote逐字核对出处。
  const plain = quote.replace(/\*\*/g, "").replace(/<\/?(?:strong|b|em|i|span|u|small|sup|sub|mark|a|code)\b[^>]*>/gi, "")
  const fields = [...plain.matchAll(/(?:^|[\r\n;]|\.\s+)\s*([\p{L}\p{N}][\p{L}\p{N} _/()-]{0,70})\s*[:：]\s*([^\r\n;]+)/gu)]
  if (fields.some(match => isSpecificationLabel(match[1]) && match[2].trim())) return true
  const cells = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>\s*<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
  return [...quote.matchAll(cells)].some(match => {
    const label = match[1].replace(/<[^>]*>/g, "").trim()
    const value = match[2].replace(/<[^>]*>/g, "").trim()
    return !!label && !!value && isSpecificationLabel(label)
  })
}

function hasSeparateSceneQuotes(description: string, quotes: string[]): boolean {
  const text = normalizeText(description)
  const normalized = quotes.map(normalizeText)
  for (let left = 0; left < normalized.length; left++) {
    for (let right = left + 1; right < normalized.length; right++) {
      if (normalized[left].includes(normalized[right]) || normalized[right].includes(normalized[left])) return false
    }
  }
  // 任意两个引用都须能在描述中对应不重叠的片段，而不是重叠截词凑两个场景。
  const getPositions = (quote: string): number[] => {
    const positions: number[] = []
    for (let start = text.indexOf(quote); start >= 0; start = text.indexOf(quote, start + 1)) positions.push(start)
    return positions
  }
  return normalized.every((quote, index) => normalized.slice(index + 1).every(other =>
    getPositions(quote).some(start => getPositions(other).some(otherStart =>
      start + quote.length <= otherStart || otherStart + other.length <= start))))
}

function projectDescription(assessment: Record<string, unknown>, source: ListingScoreSource): ListingEvidenceProjection {
  const checks = getEntries(assessment, "checks")
  if (checks.length !== DESCRIPTION_CHECKS.length) return fail("描述必须分别检查specifications与overview_scenes")
  const seen = new Set<string>(), deductions: EvidenceDeduction[] = [], states: string[] = []
  for (const item of checks) {
    if (typeof item.checkId !== "string" || !DESCRIPTION_CHECKS.includes(item.checkId) || seen.has(item.checkId) || typeof item.isPresent !== "boolean" || !Array.isArray(item.quotes) || item.quotes.some(quote => typeof quote !== "string")) return fail("描述检查必须为两个唯一checkId，并含isPresent布尔值与quotes数组")
    seen.add(item.checkId)
    const name = item.checkId === "specifications" ? "结构化规格段" : "PRODUCT OVERVIEW具体场景"
    if (item.isPresent) {
      const quotes = (item.quotes as string[]).map(quote => validateQuote(source, "description", quote))
      const quoteKeys = new Set(quotes.map(normalizeText))
      if (quotes.length !== quoteKeys.size || quotes.length < (item.checkId === "overview_scenes" ? 2 : 1)) return fail(`${name}必须提供${item.checkId === "overview_scenes" ? "至少两个不同场景" : "至少一个规格字段和值"}的原文证据`)
      if (item.checkId === "specifications" && !quotes.some(hasSpecificationStructure)) return fail("specifications证据须含真实字段:值或HTML表格字段值，形容词和场景句不等于规格段")
      if (item.checkId === "overview_scenes" && !hasSeparateSceneQuotes(source.description, quotes)) return fail("overview_scenes必须引用两个不同且不互相包含、重叠的完整场景，不能拆词凑场景")
      states.push(`${name}已核验`)
    } else {
      if (item.quotes.length) return fail(`${name}未满足时quotes必须为空，不能携带已通过证据`)
      states.push(`${name}缺失`)
      deductions.push({ ruleId: "alexa.description", checkId: item.checkId, points: 1, reason: `缺少${name}`, evidence: source.description.trim() ? `description逐项核验：未确认${name}；不得以Bullet或页面摘要代替描述。` : "description为空，未提供独立产品描述。" })
    }
  }
  return { score: 3 - deductions.length, description: `${states.join("；")}。`, deductions, assessment }
}

export function projectListingCriterionEvidence(
  dimensionIndex: number,
  criterionIndex: number,
  criterion: { assessment?: unknown; score?: unknown },
  source: ListingScoreSource
): ListingEvidenceProjection | undefined {
  const key = `${dimensionIndex}:${criterionIndex}`
  if (key === "0:0") return source.structuredAttributes?.length
    ? projectListingAttributeCriterion(criterion, { ...source, structuredAttributes: source.structuredAttributes }) : undefined
  if (!getListingEvidenceRequirement(dimensionIndex, criterionIndex)) return undefined
  // 空description是已确定的输入事实，直接按既有两项各扣1分；不让跨字段引用或漏填assessment阻断评分。
  if (key === "3:2" && !source.description.trim()) return projectDescription({
    checks: DESCRIPTION_CHECKS.map(checkId => ({ checkId, isPresent: false, quotes: [] })),
  }, source)
  if (!isRecord(criterion.assessment)) return fail(`${key}缺少assessment；满分也必须逐项提交原文证据，不能只清空deductions`)
  if (key === "1:2") return projectLongtail(criterion.assessment, source)
  if (key === "2:2") return projectMediumRelations(criterion.assessment, source)
  if (key === "3:1") return projectBulletData(criterion.assessment, source)
  return projectDescription(criterion.assessment, source)
}

export function getListingEvidenceError(
  dimensionIndex: number,
  criterionIndex: number,
  criterion: { assessment?: unknown; score?: unknown },
  source: ListingScoreSource
): string | null {
  try {
    const projected = projectListingCriterionEvidence(dimensionIndex, criterionIndex, criterion, source)
    if (projected && (typeof criterion.score !== "number" || Math.abs(projected.score - criterion.score) > 0.0001)) return "评分与逐项原文证据计算结果不一致，须采用程序投影分数"
    return null
  } catch (error) { return error instanceof Error ? error.message : String(error) }
}
