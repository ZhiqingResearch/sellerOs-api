import { findSourceQuote, hashValue } from "./listing-audit"

export interface ProductConfiguration {
  ramGb: number
  storageGb: number
}
export interface ConfigurationEvidence {
  field: "title" | "second_title"
  kind: "ram" | "storage"
  capacityGb: number
  quote: string
}

export function parseCorrectConfigurations(note: string): ProductConfiguration[] {
  const text = note.split(/正确配置[：:]/)[1]
  if (!text) throw new Error("缺少正确配置")
  return text.split(/\s*\/\s*/).map(part => {
    const match = part
      .trim()
      .match(/^(\d+(?:\.\d+)?)\s*GB\s*RAM\s*\+\s*(\d+(?:\.\d+)?)\s*(TB|GB)\s*存储\s*$/i)
    if (!match) throw new Error(`正确配置格式不明确：${part}`)
    return {
      ramGb: Number(match[1]),
      storageGb: Number(match[2]) * (match[3].toUpperCase() === "TB" ? 1024 : 1),
    }
  })
}

export function extractConfigurationEvidence(title: string, secondTitle: string) {
  const evidence: ConfigurationEvidence[] = []
  const ambiguities: string[] = []
  const capacity = "\\b(\\d+(?:\\.\\d+)?)\\s*(GB|TB|G)\\b"
  const speed = "(?:\\d{3,5}\\s*(?:MHz|MT/s)?\\s*)"
  const ddr = "(?:LP)?DDR[345X]*"
  const patterns: Array<{ kind: "ram" | "storage"; pattern: string }> = [
    {
      kind: "ram",
      pattern: `${capacity}\\s*(?:(?:of|high[- ]speed|onboard|unified)\\s+)*(?:${speed})?(?:RAM\\b|memory\\b|${ddr}\\b(?:[-\\s]*${speed})?(?:\\s*RAM\\b)?)`,
    },
    {
      kind: "ram",
      pattern: `(?:RAM(?:\\s+Installed\\s+Size)?|(?:System\\s+)?Memory(?:\\s+Size)?)\\s*[:：-]?\\s*${capacity}`,
    },
    {
      kind: "ram",
      pattern: `${capacity}\\s*\\d{3,5}\\s*(?:MHz|MT/s)\\b`,
    },
    {
      kind: "storage",
      pattern: `${capacity}\\s*(?:(?:PCIe(?:\\s*\\d(?:\\.\\d)?)?|Gen\\s*\\d(?:\\.\\d)?|NVMe|M\\.2|SATA|Solid[- ]State|Flash)\\s*)*(?:SSD|HDD|eMMC|UFS|Storage|Hard\\s*(?:Drive|Disk))\\b`,
    },
    {
      kind: "storage",
      pattern: `(?:SSD|HDD|eMMC|UFS|Storage(?:\\s+Capacity)?|Hard\\s*(?:Drive|Disk)(?:\\s+Size)?)\\s*[:：-]?\\s*${capacity}`,
    },
  ]
  for (const [field, text] of Object.entries({ title, second_title: secondTitle })) {
    const suspectedTypo = text.match(/\b\d+\s*GB\s+Ran\b/i)
    if (suspectedTypo)
      ambiguities.push(`${field}「${suspectedTypo[0]}」疑似把 RAM 拼成 Ran，内存需人工确认`)
    if (/\bNO\s+Stock\b/i.test(text))
      ambiguities.push(`${field}原文标注 NO Stock，没有可用于配置核对的参数`)
    for (const rule of patterns) {
      for (const match of text.matchAll(new RegExp(rule.pattern, "gi"))) {
        const start = match.index ?? 0
        const prefix =
          text
            .slice(Math.max(0, start - 80), start)
            .split(/[,;|()]/)
            .at(-1) ?? ""
        const suffix = text
          .slice(start + match[0].length, start + match[0].length + 28)
          .split(/[,;|()+&]/)[0]
        // “32GB RAM 2TB SSD”中的 RAM 属于前一个容量，不能向后误读成 2TB 内存。
        if (
          !/^\d/.test(match[0]) &&
          new RegExp(`\\d\\s*(?:GB|TB|G)\\s*(?:${speed})?(?:${ddr}\\s*(?:${speed})?)?$`, "i").test(
            prefix
          )
        )
          continue
        // VRAM/GDDR、云盘、赠送存储和升级上限不能当作当前配置。
        if (
          /(?:up\s+to|maximum|max\.?|supports?|optional|expandable|upgradeable|upgradable|最高|可选)\s*(?:(?:RAM|memory|storage|SSD)\s*[:：-]?\s*)?$/i.test(
            prefix
          ) ||
          /cloud|onedrive|google\s+drive|external|SD\s*Card|MSD|USB\s*(?:Drive|Flash)/i.test(
            prefix + match[0] + suffix
          )
        ) {
          ambiguities.push(`${field}「${match[0]}」属于范围或额外存储，未作为当前配置`)
          continue
        }
        if (
          rule.kind === "ram" &&
          /(?:graphics|video|gpu|vram|geforce|gddr|RTX\s*\d+)\s*[:：-]?\s*$/i.test(prefix)
        )
          continue
        const quote = findSourceQuote(text, match[0])
        if (!quote) throw new Error("提取引用不存在于对应原文")
        evidence.push({
          field: field as ConfigurationEvidence["field"],
          kind: rule.kind,
          capacityGb: Number(match[1]) * (match[2].toUpperCase() === "TB" ? 1024 : 1),
          quote,
        })
      }
    }
    // 已明确的内存短语后紧接裸容量，是常见“RAM + 硬盘”配置序列。
    // 仅在同一连续序列内推导，不在整篇标题里寻找任意裸GB/TB。
    for (const ram of evidence.filter(item => item.field === field && item.kind === "ram")) {
      const start = text.indexOf(ram.quote)
      const tail = text.slice(start + ram.quote.length)
      const match = tail.match(new RegExp(`^[\\s,;+|]*(${capacity})(?=$|[\\s,;|])`, "i"))
      if (!match) continue
      const rest = tail.slice(match[0].length).split(/[,;|]/)[0]
      if (
        /RAM|DDR|memory|VRAM|cloud|external|SD\s*Card|MSD|USB|up\s+to|optional|support/i.test(rest)
      )
        continue
      const capacityGb = Number(match[2]) * (match[3].toUpperCase() === "TB" ? 1024 : 1)
      if (
        !evidence.some(
          item => item.field === field && item.kind === "storage" && item.capacityGb === capacityGb
        )
      ) {
        evidence.push({
          field: field as ConfigurationEvidence["field"],
          kind: "storage",
          capacityGb,
          quote: match[1],
        })
      }
    }
  }
  return {
    evidence: [...new Map(evidence.map(item => [hashValue(item), item])).values()],
    ambiguities,
  }
}

export function compareConfigurations(
  title: string,
  secondTitle: string,
  configurations: ProductConfiguration[]
) {
  if (!configurations.length) throw new Error("没有可用的正确配置")
  const { evidence, ambiguities } = extractConfigurationEvidence(title, secondTitle)
  const ramValues = [
    ...new Set(evidence.filter(item => item.kind === "ram").map(item => item.capacityGb)),
  ]
  const storageValues = [
    ...new Set(evidence.filter(item => item.kind === "storage").map(item => item.capacityGb)),
  ]
  const formatStorage = (value: number) =>
    value >= 1024 && value % 1024 === 0 ? `${value / 1024}TB` : `${value}GB`
  const correctText = configurations
    .map(item => `${item.ramGb}GB RAM + ${formatStorage(item.storageGb)} 存储`)
    .join(" / ")
  const candidates = configurations.filter(
    item =>
      (!ramValues.length || ramValues.every(value => value === item.ramGb)) &&
      (!storageValues.length || storageValues.every(value => value === item.storageGb))
  )
  const isConflict = ramValues.length > 1 || storageValues.length > 1
  const hasMissing = !ramValues.length || !storageValues.length
  const status = isConflict || !candidates.length ? "不匹配" : hasMissing ? "无法判断" : "匹配"
  const actualText = `${ramValues.length ? ramValues.map(value => `${value}GB RAM`).join("、") : "未识别内存"} + ${storageValues.length ? storageValues.map(formatStorage).join("、") + " 存储" : "未识别硬盘"}`
  const reason = isConflict
    ? "正副标题出现相互冲突的配置"
    : status === "不匹配"
      ? "正副标题配置与正确配置不一致"
      : status === "无法判断"
        ? "正副标题信息仍不足，不能确认是否匹配"
        : "正副标题配置与正确配置匹配"
  const citations = evidence
    .map(item => `${item.field === "title" ? "标题" : "亮点"}「${item.quote}」`)
    .join("；")
  return {
    status,
    note: `${reason}；识别配置：${actualText}；正确配置：${correctText}${citations ? `；依据：${citations}` : ""}${ambiguities.length ? `；${ambiguities.join("；")}` : ""}`,
    evidence,
    ambiguities,
    configurations,
  }
}

// 原审计快照留在同一个文件中，原始响应与历史判断的证据不会被新标题覆盖。
export function mergeHighlightsListing(existing: any, highlights: any) {
  const originalAuditSnapshot = existing.originalAuditSnapshot ?? structuredClone(existing)
  const title = highlights.response.data.title.trim()
  const secondTitle = highlights.response.data.second_title.trim()
  const listing = { ...existing.listing, ...(title ? { title } : {}), second_title: secondTitle }
  return {
    ...existing,
    originalAuditSnapshot,
    listing,
    ...(existing.currentListing
      ? {
          currentListing: {
            ...existing.currentListing,
            ...(title ? { title } : {}),
            second_title: secondTitle,
          },
        }
      : {}),
    highlights,
    listingUpdatedAt: highlights.fetchedAt,
  }
}
