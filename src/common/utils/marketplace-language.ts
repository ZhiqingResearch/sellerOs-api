/**
 * 站点（商城）→ 图上文字语言 的动态解析。
 *
 * 全仓库站点值统一为 `{平台}_{国家码}` 格式（amazon_us / WALMART_US / tiktok_mx…），
 * 图上文字语言只由国家码决定（平台不影响语言）。图片模型/网关没有站点参数，
 * 语言控制只能靠 prompt 硬性指令，故各生图链路在提交前用本模块把站点解析成
 * 语言指令素材。新平台/新国家站点零改动自动生效（缺一国补一行表即可）。
 */

export interface MarketplaceLanguage {
  /** 归一后站点码（大写、下划线，如 "AMAZON_MX"） */
  site: string
  /** BCP-47 locale，如 "es-MX" */
  locale: string
  /** 语言英文名（prompt 指令用），如 "Spanish" */
  languageEn: string
  /** 语言中文名（日志/展示用），如 "西班牙语" */
  languageZh: string
}

type CountryLanguage = Omit<MarketplaceLanguage, "site">

/**
 * 国家码 → 商城主语言。覆盖全部亚马逊在营站点 + 主流跨境电商市场
 * （美欧日韩、东南亚、中东、拉美）。多语言国家取该商城的主语言
 * （如 CA→英语、BE→荷兰语、CH→德语、AE→英语）；UK/GB 双写为别名。
 */
export const COUNTRY_LANGUAGES: Record<string, CountryLanguage> = {
  US: { locale: "en-US", languageEn: "English", languageZh: "英语" },
  CA: { locale: "en-CA", languageEn: "English", languageZh: "英语" },
  MX: { locale: "es-MX", languageEn: "Spanish", languageZh: "西班牙语" },
  BR: { locale: "pt-BR", languageEn: "Portuguese", languageZh: "葡萄牙语" },
  UK: { locale: "en-GB", languageEn: "English", languageZh: "英语" },
  GB: { locale: "en-GB", languageEn: "English", languageZh: "英语" },
  DE: { locale: "de-DE", languageEn: "German", languageZh: "德语" },
  AT: { locale: "de-AT", languageEn: "German", languageZh: "德语" },
  CH: { locale: "de-CH", languageEn: "German", languageZh: "德语" },
  FR: { locale: "fr-FR", languageEn: "French", languageZh: "法语" },
  BE: { locale: "nl-BE", languageEn: "Dutch", languageZh: "荷兰语" },
  NL: { locale: "nl-NL", languageEn: "Dutch", languageZh: "荷兰语" },
  IT: { locale: "it-IT", languageEn: "Italian", languageZh: "意大利语" },
  ES: { locale: "es-ES", languageEn: "Spanish", languageZh: "西班牙语" },
  PT: { locale: "pt-PT", languageEn: "Portuguese", languageZh: "葡萄牙语" },
  SE: { locale: "sv-SE", languageEn: "Swedish", languageZh: "瑞典语" },
  DK: { locale: "da-DK", languageEn: "Danish", languageZh: "丹麦语" },
  FI: { locale: "fi-FI", languageEn: "Finnish", languageZh: "芬兰语" },
  NO: { locale: "nb-NO", languageEn: "Norwegian", languageZh: "挪威语" },
  PL: { locale: "pl-PL", languageEn: "Polish", languageZh: "波兰语" },
  CZ: { locale: "cs-CZ", languageEn: "Czech", languageZh: "捷克语" },
  GR: { locale: "el-GR", languageEn: "Greek", languageZh: "希腊语" },
  HU: { locale: "hu-HU", languageEn: "Hungarian", languageZh: "匈牙利语" },
  RO: { locale: "ro-RO", languageEn: "Romanian", languageZh: "罗马尼亚语" },
  IE: { locale: "en-IE", languageEn: "English", languageZh: "英语" },
  TR: { locale: "tr-TR", languageEn: "Turkish", languageZh: "土耳其语" },
  RU: { locale: "ru-RU", languageEn: "Russian", languageZh: "俄语" },
  UA: { locale: "uk-UA", languageEn: "Ukrainian", languageZh: "乌克兰语" },
  AU: { locale: "en-AU", languageEn: "English", languageZh: "英语" },
  NZ: { locale: "en-NZ", languageEn: "English", languageZh: "英语" },
  JP: { locale: "ja-JP", languageEn: "Japanese", languageZh: "日语" },
  KR: { locale: "ko-KR", languageEn: "Korean", languageZh: "韩语" },
  CN: { locale: "zh-CN", languageEn: "Simplified Chinese", languageZh: "简体中文" },
  HK: { locale: "zh-HK", languageEn: "Traditional Chinese", languageZh: "繁体中文" },
  TW: { locale: "zh-TW", languageEn: "Traditional Chinese", languageZh: "繁体中文" },
  SG: { locale: "en-SG", languageEn: "English", languageZh: "英语" },
  MY: { locale: "ms-MY", languageEn: "Malay", languageZh: "马来语" },
  ID: { locale: "id-ID", languageEn: "Indonesian", languageZh: "印尼语" },
  TH: { locale: "th-TH", languageEn: "Thai", languageZh: "泰语" },
  VN: { locale: "vi-VN", languageEn: "Vietnamese", languageZh: "越南语" },
  PH: { locale: "en-PH", languageEn: "English", languageZh: "英语" },
  IN: { locale: "en-IN", languageEn: "English", languageZh: "英语" },
  AE: { locale: "en-AE", languageEn: "English", languageZh: "英语" },
  SA: { locale: "ar-SA", languageEn: "Arabic", languageZh: "阿拉伯语" },
  QA: { locale: "ar-QA", languageEn: "Arabic", languageZh: "阿拉伯语" },
  KW: { locale: "ar-KW", languageEn: "Arabic", languageZh: "阿拉伯语" },
  EG: { locale: "ar-EG", languageEn: "Arabic", languageZh: "阿拉伯语" },
  IL: { locale: "he-IL", languageEn: "Hebrew", languageZh: "希伯来语" },
  NG: { locale: "en-NG", languageEn: "English", languageZh: "英语" },
  KE: { locale: "en-KE", languageEn: "English", languageZh: "英语" },
  ZA: { locale: "en-ZA", languageEn: "English", languageZh: "英语" },
  AR: { locale: "es-AR", languageEn: "Spanish", languageZh: "西班牙语" },
  CL: { locale: "es-CL", languageEn: "Spanish", languageZh: "西班牙语" },
  CO: { locale: "es-CO", languageEn: "Spanish", languageZh: "西班牙语" },
  PE: { locale: "es-PE", languageEn: "Spanish", languageZh: "西班牙语" },
}

/** 站点值解析不出语言时的兜底（跨境电商默认语境 → 英文） */
export const FALLBACK_MARKETPLACE_LANGUAGE: MarketplaceLanguage = {
  site: "",
  locale: "en-US",
  languageEn: "English",
  languageZh: "英语",
}

/** `平台_国家码`（大写归一后），国家码为 ISO 3166-1 alpha-2（UK/GB 双写） */
const SITE_CODE_PATTERN = /^[A-Z0-9]+_([A-Z]{2})$/

/**
 * 解析站点值为商城语言。接受任意平台前缀（amazon/walmart/tiktok/temu/…），
 * 大小写与 `-`/`_` 分隔符归一；格式不符或国家码查不到返回 undefined，
 * 由调用方决定兜底（生图链路统一兜 FALLBACK_MARKETPLACE_LANGUAGE 英文档）。
 */
export function resolveMarketplaceLanguage(raw: unknown): MarketplaceLanguage | undefined {
  if (typeof raw !== "string") return undefined
  const site = raw.trim().toUpperCase().replace(/-/g, "_")
  const match = SITE_CODE_PATTERN.exec(site)
  if (!match) return undefined
  const entry = COUNTRY_LANGUAGES[match[1]]
  if (!entry) return undefined
  return { site, ...entry }
}

/** 规划 LLM / generation_settings 用的显式语言标签，如 "Spanish (es-MX)" */
export function marketplaceLanguageLabel(ml: MarketplaceLanguage): string {
  return `${ml.languageEn} (${ml.locale})`
}

/**
 * 生图 prompt 头部硬性语言指令（head 基座，带尾随空格，与 prompt-builder
 * 其他 head 指令格式一致）。图片模型没有站点/语言参数，语言控制只能靠
 * prompt 头尾双侧指令——这是全仓各生图链路的共同做法。
 */
export function marketplaceLanguageHead(ml: MarketplaceLanguage): string {
  return `LANGUAGE=${ml.languageEn.toUpperCase()} (${ml.locale.toUpperCase()}). STRICT RULE: Any text, captions, annotations, labels, callouts, dimension numbers with units, brand words, or stickers rendered in the output image MUST be written in ${ml.languageEn} only. The user's brief and any product facts may be written in another language — translate all on-image copy into ${ml.languageEn} before rendering. Do NOT render any characters outside the ${ml.languageEn} writing system. `
}

/** 生图 prompt 尾部复查指令（tail，带前导空格），与 head 同语言硬约束 */
export function marketplaceLanguageTail(ml: MarketplaceLanguage): string {
  return ` Final reminder: every glyph rendered in the output image must be in ${ml.languageEn} (${ml.locale}); translate any other-language copy into ${ml.languageEn} first and reject foreign characters even if the source description contains them.`
}
