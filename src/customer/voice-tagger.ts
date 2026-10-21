/**
 * 公共音色启发式打标签（方案 C）。
 *
 * 百度 `/tts/persons?isSystem=true` 仅返回 perId/name/describe/version/gender/exampleAudioUrl
 * 六个字段，而前端弹窗要按 年龄 / 风格 / 语言 / 能力 / 特征 / 延时 六个维度过滤。
 * 这里从 name + describe + version 按关键字规则抽取标签，覆盖 80% 左右的现有目录，
 * 个别失准属已知代价；后续产品若要 100% 准确，再升级到后台人工覆盖。
 *
 * 返回字段与 PublicVoice.age / style / language / capability / feature / latency 对应。
 */

export interface TaggedVoice {
  age?: string
  style?: string
  language?: string[]
  capability?: string
  feature?: string
  latency?: string
}

/**
 * 主入口：合并 name/describe/version 做规则匹配。任何未命中的维度返回 undefined，
 * service 入库时统一按 null 存。
 */
export function tagPublicVoice(input: {
  name: string
  describe?: string | null
  version?: string | null
}): TaggedVoice {
  const haystack = `${input.name} ${input.describe ?? ""}`.toLowerCase()
  const ver = (input.version ?? "").toUpperCase()

  return {
    age: detectAge(haystack),
    style: detectStyle(haystack),
    language: detectLanguage(input.name, input.describe ?? ""),
    capability: detectCapability(haystack, ver),
    feature: detectFeature(haystack),
    latency: detectLatency(ver),
  }
}

// ==================== 年龄 ====================
// 覆盖词按优先级排序，首个命中即返回
function detectAge(s: string): string | undefined {
  if (/少年|小学生|童声|小孩|小朋友/.test(s)) return "少年"
  if (/青少年|中学生|高中|少女|少男/.test(s)) return "青少年"
  if (/中年|大叔|阿姨|中生代/.test(s)) return "中年"
  if (/老年|爷爷|奶奶|老人|长辈/.test(s)) return "老年"
  // 默认：小哥/妹子/女生/男生/主播/青年 → 青年
  if (/青年|小哥|妹子|女生|男生|女声|男声|主播|anchor|voice/.test(s)) return "青年"
  return undefined
}

// ==================== 风格 ====================
function detectStyle(s: string): string | undefined {
  if (/权威|专业|主持|新闻|播报|官方|严肃/.test(s)) return "权威专业"
  if (/活力|激情|热情|欢快|阳光|活泼|青春/.test(s)) return "活力激情"
  if (/亲和|陪伴|温柔|知性|治愈|温暖|柔和/.test(s)) return "亲和陪伴"
  return undefined
}

// ==================== 语言 ====================
// 返回数组：一个音色可以是多语种（比如"中文 + 方言 + 粤语"）
const LANG_RULES: Array<{ langs: string[]; test: RegExp }> = [
  { langs: ["粤语"], test: /粤语|粤|广州|香港|港腔/i },
  { langs: ["中文", "方言"], test: /沪普|川普|湾湾|台湾|东北|山东|河南|重庆|成都|北京儿化|方言/ },
  { langs: ["英语"], test: /english|英语|美式|英式|british|american/i },
  { langs: ["法语"], test: /french|法语|français/i },
  { langs: ["西班牙语"], test: /spanish|西班牙|español/i },
  { langs: ["俄语"], test: /russian|俄语|русск/i },
  { langs: ["葡萄牙语"], test: /portuguese|葡萄牙|português/i },
  { langs: ["德语"], test: /german|德语|deutsch/i },
  { langs: ["土耳其语"], test: /turkish|土耳其|türk/i },
  { langs: ["荷兰语"], test: /dutch|荷兰/i },
  { langs: ["乌克兰语"], test: /ukrainian|乌克兰/i },
  { langs: ["越南语"], test: /vietnamese|越南/i },
  { langs: ["印尼语"], test: /indonesian|印尼/i },
  { langs: ["日语"], test: /japanese|日语|日本語/i },
  { langs: ["意大利语"], test: /italian|意大利|italiano/i },
  { langs: ["韩语"], test: /korean|韩语|한국/i },
  { langs: ["泰语"], test: /thai|泰语|ไทย/i },
  { langs: ["波兰语"], test: /polish|波兰/i },
  { langs: ["罗马尼亚语"], test: /romanian|罗马尼亚/i },
  { langs: ["希腊语"], test: /greek|希腊/i },
  { langs: ["捷克语"], test: /czech|捷克/i },
  { langs: ["芬兰语"], test: /finnish|芬兰/i },
  { langs: ["印地语"], test: /hindi|印地|印度/i },
]

function detectLanguage(name: string, describe: string): string[] | undefined {
  const s = `${name} ${describe}`
  const hits = new Set<string>()
  for (const rule of LANG_RULES) {
    if (rule.test.test(s)) rule.langs.forEach(l => hits.add(l))
  }
  // 如果命中了任何其它语种但没命中"中文"，默认不额外加"中文"（比如 English Anchor 就是纯英语）
  // 如果一个非中文语种都没命中，默认视为"中文"
  const nonChineseHit = [...hits].some(l => l !== "中文" && l !== "方言" && l !== "粤语")
  if (hits.size === 0) return ["中文"]
  if (!nonChineseHit && !hits.has("中文")) hits.add("中文")
  return [...hits]
}

// ==================== 能力 ====================
// 主要靠 version 和关键词：V2/超拟 → 超拟；LITE → 精品（轻量）
function detectCapability(s: string, ver: string): string | undefined {
  if (/超拟|hyper|v2|pro|premium/i.test(s) || ver === "V2") return "超拟"
  if (/精品|lite|basic|standard/i.test(s) || ver === "LITE") return "精品"
  return undefined
}

// ==================== 特征 ====================
function detectFeature(s: string): string | undefined {
  if (/温润|柔和|温柔|知性|温暖/.test(s)) return "温润柔和"
  if (/清透|明亮|清澈|清脆|亮|清新/.test(s)) return "清透明亮"
  if (/低沉|磁性|浑厚|沉稳|厚重|成熟/.test(s)) return "低沉磁性"
  return undefined
}

// ==================== 延时 ====================
function detectLatency(ver: string): string | undefined {
  if (ver === "LITE") return "超低时延"
  if (ver === "V2") return "低时延"
  return undefined
}
