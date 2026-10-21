export interface ParsedListingPaste {
  title: string
  bullets: string[]
  description: string
  searchTerms: string
}

const SECTION_PATTERNS: { key: keyof ParsedListingPaste; re: RegExp }[] = [
  { key: "title", re: /^(?:标题|title)\s*[：:]/i },
  {
    key: "bullets",
    re: /^(?:bullet\s*points?|五点描述?|卖点|key\s*features?|要点|五行)\s*[：:（(]/i,
  },
  { key: "description", re: /^(?:产品描述|描述|product\s*description|description)\s*[：:]/i },
  {
    key: "searchTerms",
    re: /^(?:后台搜索词|后台关键词|搜索词|search\s*terms?|backend\s*(?:search\s*)?(?:terms?|keywords?)|product\s*attributes?|产品属性)\s*[：:（(]/i,
  },
]

/** 从用户粘贴文本解析 Listing 字段（与 ListingInputPanel 规则一致）。 */
export function parseListingPaste(raw: string): ParsedListingPaste | null {
  const lines = raw.split(/\n/)
  let currentKey: keyof ParsedListingPaste | null = null
  const sections: Record<keyof ParsedListingPaste, string[]> = {
    title: [],
    bullets: [],
    description: [],
    searchTerms: [],
  }
  let matched = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (currentKey && currentKey !== "title") sections[currentKey].push("")
      continue
    }
    let foundSection = false
    for (const { key, re } of SECTION_PATTERNS) {
      if (re.test(trimmed)) {
        currentKey = key
        matched++
        const after = trimmed
          .replace(re, "")
          .replace(/^[）)：:\s]+/, "")
          .trim()
        if (after) sections[key].push(after)
        foundSection = true
        break
      }
    }
    if (!foundSection && currentKey) sections[currentKey].push(trimmed)
  }

  if (matched < 2) return null

  return {
    title: sections.title.join(" ").trim(),
    bullets: sections.bullets
      .join("\n")
      .split(/\n/)
      .map(l => l.replace(/^\s*(?:\d+[.、)）]|[-•·●])\s*/, "").trim())
      .filter(Boolean),
    description: sections.description.join("\n").trim(),
    searchTerms: sections.searchTerms.join("\n").trim(),
  }
}

/** 无结构化标签时：首行作标题，其余作描述兜底。 */
export function parseListingPasteLoose(raw: string): ParsedListingPaste {
  const structured = parseListingPaste(raw)
  if (structured) return structured
  const lines = raw
    .split(/\n/)
    .map(l => l.trim())
    .filter(Boolean)
  const title = lines[0] ?? ""
  const rest = lines.slice(1).join("\n")
  return { title, bullets: [], description: rest, searchTerms: "" }
}
