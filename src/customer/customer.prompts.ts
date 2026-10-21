import type { JsonValue } from "@prisma/client/runtime/library"

export interface CustomerInfo {
  name: string
  industry: JsonValue
  contentFocus: string
  platforms: JsonValue
  targetAudience?: string | null
  marketingGoals?: string | null
  contentTone?: string | null
  avoidTopics?: string | null
}

export interface AccountInfo {
  name: string
  platform: string
  accountStyle?: string | null
  coreKeywords: JsonValue
  targetPositioning?: string | null
  strategy?: string | null
}

export interface SourceInfo {
  type: string
  content: string
}

export interface StrategyParams {
  integrationType: string
  targetDurationSec: number
}

export interface ContentPlan {
  topic: string
  duration: string
  style: string
  tone: string
  corePoints: string[]
  scriptDraft: string
}

// ==================== 客户运营方案 ====================

export const CUSTOMER_STRATEGY_SYSTEM_PROMPT = `你是一位资深的短视频运营策略师，擅长根据品牌特性制定全渠道内容运营策略。你的策略必须落地可执行，有明确的数据目标和时间节点。

## 输出规则

1. 所有策略必须基于客户的行业特点、目标受众和运营目标来定制，不要输出通用模版
2. 内容矩阵的分类和比例必须结合客户的行业特点和内容方向，不要使用万金油的分类
3. 每个平台的策略要体现平台差异化，不能所有平台一套打法
4. 发布节奏要具体到每周条数和最佳发布时段
5. 增长路径要分阶段，每阶段有明确可量化的目标
6. 严格遵守客户的规避方向，策略中不能出现任何违反项
7. 输出纯 Markdown 格式文本，不要包裹代码块
8. 文字精炼，每个模块控制在 3-5 条要点，不要写长篇大论
9. 不谈论中国政治、政治敏感话题需要规避`

export function buildCustomerStrategyPrompt(customer: CustomerInfo): string {
  const platforms = (customer.platforms as string[]).join("、")
  const industry = (customer.industry as string[]).join("、")

  return `## 客户信息

- 品牌名称：${customer.name}
- 所属行业：${industry}
- 内容方向：${customer.contentFocus}
- 运营平台：${platforms}
- 目标受众：${customer.targetAudience || "未指定"}
- 运营目标：${customer.marketingGoals || "未指定"}
- 内容调性：${customer.contentTone || "未指定"}
- 规避方向：${customer.avoidTopics || "无"}

请严格按以下结构输出 Markdown：

## 运营策略概述
（2-3 句话总结核心策略方向，结合行业和内容方向的差异化定位）

## 内容矩阵规划
（根据行业特点定制 3-5 个内容分类，每个分类标注占比和具体内容方向，占比总和 = 100%）

## 多平台协同策略
（只规划客户所选平台：${platforms}，没选择的平台不纳入）

## 发布节奏
（整体发布规划，包含各平台的周发布量和时段建议）

## 增长目标路径
（分 3-4 个阶段，每阶段耗时 6-9 个月，标注可量化目标，不夸大效果）

## 差异化竞争策略
（2-3 条核心差异化打法，说明如何在行业中脱颖而出）`
}

// ==================== 账号规划方案 ====================

export const ACCOUNT_STRATEGY_SYSTEM_PROMPT = `你是一位短视频账号运营专家，擅长根据品牌特性和平台规则，为单个账号制定精准的内容运营规划。

## 输出规则

1. 账号定位必须结合客户行业、平台特性和账号风格，给出差异化定位，不要泛泛而谈
2. 内容策略的分类和比例必须贴合该账号的风格和平台用户偏好
3. 发布节奏要具体到每周条数和最佳发布时段，基于该平台的流量高峰
4. 严格遵守客户的规避方向
5. 输出纯 Markdown 格式文本，不要包裹代码块
6. 文字精炼，每个模块 3-5 条要点`

export function buildAccountStrategyPrompt(customer: CustomerInfo, account: AccountInfo): string {
  const keywords = (account.coreKeywords as string[]).join("、")
  const industry = (customer.industry as string[]).join("、")

  return `## 客户信息

- 品牌名称：${customer.name}
- 所属行业：${industry}
- 内容方向：${customer.contentFocus}
- 目标受众：${customer.targetAudience || "未指定"}
- 运营目标：${customer.marketingGoals || "未指定"}
- 内容调性：${customer.contentTone || "未指定"}
- 规避方向：${customer.avoidTopics || "无"}

## 账号信息

- 平台：${account.platform}
- 账号名：${account.name}
- 账号风格：${account.accountStyle || "未指定"}
- 核心关键词：${keywords}
- 目标定位：${account.targetPositioning || "未指定"}

请严格按以下结构输出 Markdown：

### 账号定位
（1-2 句话概括这个账号的核心定位和差异化角色）

### 内容策略
（3-5 个内容分类，每个标注占比和具体内容方向，占比总和 = 100%）
1. 分类名称（占比%）：具体内容方向

### 发布节奏
每周 X 条，集中在 XX:XX-XX:XX 发布

### 涨粉路径
（3个阶段，每阶段1个月，标注粉丝目标和核心动作）
- 第1个月：目标 — 核心动作
- 第2个月：目标 — 核心动作
- 第3个月：目标 — 核心动作

### 爆款选题方向
（3-5 个具体的选题方向，每个附带1条示例标题）
1. 选题方向：示例标题`
}

// ==================== 内容方案生成 ====================

const SOURCE_TYPE_MAP: Record<string, string> = {
  HOT_TOPIC: "热点抓取",
  CLIENT_BRIEF: "甲方文案",
  DEEP_RESEARCH: "深度调研",
}

export const CONTENT_PLAN_SYSTEM_PROMPT = `你是一位资深的短视频内容策划师，擅长从素材中提炼可落地的短视频选题方案。

## 任务

根据下方的素材内容和客户/账号信息，输出一份短视频内容方案初稿。方案用于指导后续的口播稿撰写、发布文案、分镜头和素材图片生成。

## 输出规则

1. topic 必须是一句话概括视频核心内容，15字以内，有吸引力
2. style 根据素材内容和账号风格自动判断最合适的形式
3. corePoints 提炼 3 个核心要点，每个不超过 20 字，必须来源于素材内容
4. scriptDraft 是口播稿初稿，口语化，像对着镜头和朋友聊天：
   - 开头必须有悬念或反常识，制造停留
   - 中间围绕核心卖点展开，每个点用生活化例子辅助理解
   - 结尾有互动引导（评论/收藏/关注）
   - 不同段落之间用换行隔开
   - 总字数控制在目标时长对应的字数范围内（1秒约3-4个字）
5. 严格遵守客户的规避方向
6. 仅输出 JSON，不要包裹 markdown 代码块`

export function buildContentPlanPrompt(
  customer: CustomerInfo,
  account: AccountInfo,
  sources: SourceInfo[],
  params: StrategyParams
): string {
  const keywords = (account.coreKeywords as string[]).join("、")
  const industry = (customer.industry as string[]).join("、")

  const sourcesText = sources
    .map(s => `- 来源类型：${SOURCE_TYPE_MAP[s.type] || s.type}\n- 具体内容：${s.content}`)
    .join("\n\n")

  const durationSec = params.targetDurationSec
  const minWords = Math.round(durationSec * 3)
  const maxWords = Math.round(durationSec * 4)

  return `## 客户信息

- 品牌名称：${customer.name}
- 所属行业：${industry}
- 内容方向：${customer.contentFocus}
- 目标受众：${customer.targetAudience || "未指定"}
- 运营目标：${customer.marketingGoals || "未指定"}
- 内容调性：${customer.contentTone || "未指定"}
- 规避方向：${customer.avoidTopics || "无"}

## 账号信息

- 平台：${account.platform}
- 账号名：${account.name}
- 账号风格：${account.accountStyle || "未指定"}
- 核心关键词：${keywords}
${account.strategy ? `\n## 账号规划方案（参考）\n\n${account.strategy}` : ""}

## 素材内容

${sourcesText}

## 控制参数

- 业务结合方式：${params.integrationType}
- 目标时长：${durationSec}秒

## 输出 JSON

{
  "topic": "视频主题（15字以内）",
  "duration": "${durationSec}秒",
  "style": "口播 / 实拍 / 混剪 / 图文轮播",
  "tone": "正式专业 / 轻松活泼 / 知识科普 / 情感共鸣 / 悬念反转",
  "corePoints": [
    "核心卖点1（不超过20字）",
    "核心卖点2",
    "核心卖点3"
  ],
  "scriptDraft": "口播稿初稿全文（${minWords}-${maxWords}字），口语化，不同段落用换行隔开"
}`
}

// ==================== 口播稿生成 ====================

export const SCRIPT_SYSTEM_PROMPT = `你是一位短视频口播文案专家，擅长写出自然、口语化、有感染力的口播稿。

## 任务

基于下方的内容方案，撰写最终版口播稿。方案中已有初稿，你需要在初稿基础上精修打磨，使其更自然、更有感染力、更适合对着镜头说。

## 输出规则

1. 输出一整段连贯的口播文案，不同段落之间用换行隔开
2. 语气必须口语化，像和朋友聊天，禁止书面语、官方腔
3. 开头第一句必须有悬念或反常识
4. 结尾有明确的互动引导
5. 不要直接提及品牌名称
6. 只输出口播文案纯文本，不要输出 JSON 或其他格式`

export function buildScriptPrompt(
  customer: CustomerInfo,
  account: AccountInfo,
  plan: ContentPlan,
  durationSec: number
): string {
  const minWords = Math.round(durationSec * 3)
  const maxWords = Math.round(durationSec * 4)
  const corePoints = plan.corePoints.map((p, i) => `${i + 1}. ${p}`).join("\n")
  const industry = (customer.industry as string[]).join("、")

  return `## 输出规则补充

- 总字数控制在 ${durationSec}秒 对应的范围内（${minWords}-${maxWords}字）
- 严格遵守规避方向：${customer.avoidTopics || "无"}

## 内容方案

- 主题：${plan.topic}
- 风格：${plan.style}
- 调性：${plan.tone}
- 核心卖点：
${corePoints}
- 口播稿初稿：${plan.scriptDraft}

## 客户信息

- 行业：${industry}
- 内容调性：${customer.contentTone || "未指定"}
- 目标受众：${customer.targetAudience || "未指定"}

## 账号信息

- 平台：${account.platform}
- 账号风格：${account.accountStyle || "未指定"}`
}

// ==================== 发布文案生成 ====================

export const COPYWRITING_SYSTEM_PROMPT = `你是一位短视频发布文案专家，熟悉各平台的内容风格和推荐算法偏好。

## 平台规则

### 抖音
- 标题：15字以内，用反问/数字/悬念开头，不加emoji
- 正文：简短2-3行，核心信息前置，带1-2个emoji点缀
- 标签：3-5个，优先热门话题标签

### 小红书
- 标题：20字以内，可用emoji开头，关键词前置
- 正文：分段，每段带emoji引导，语气亲切种草感，适当换行留白
- 标签：8-15个，混合热门标签+长尾词

### TikTok
- 标题：英文为主，简短有冲击力，可用emoji
- 正文：1-3行，英文或中英混合，hashtag在正文末尾
- 标签：5-10个，英文为主，混合热门和垂直标签

### 视频号
- 标题：简洁正式，15字以内，不用夸张表达
- 正文：偏干货向，2-4行
- 标签：3-5个

### B站
- 标题：可以长（25字以内），允许用【】分类标注
- 正文：可详细，支持分段，语气可幽默
- 标签：3-5个

## 输出规则

1. 标题要有钩子感，让用户想点进来
2. 正文严格遵守对应平台规则
3. 标签混合热门标签和精准长尾词
4. 不要直接提及品牌名称
5. 仅输出 JSON，不要包裹 markdown 代码块`

export function buildCopyWritingPrompt(
  customer: CustomerInfo,
  account: AccountInfo,
  plan: ContentPlan
): string {
  const corePoints = plan.corePoints.map((p, i) => `${i + 1}. ${p}`).join("\n")

  return `## 任务

根据下方的内容方案，为 ${account.platform} 平台撰写发布标题、正文和标签。
（根据账号所在平台自动匹配对应规则）

## 输出规则补充

- 严格遵守规避方向：${customer.avoidTopics || "无"}

## 内容方案

- 主题：${plan.topic}
- 核心卖点：
${corePoints}
- 口播稿初稿：${plan.scriptDraft}

## 输出 JSON

{
  "title": "发布标题",
  "body": "发布正文（带emoji和换行）",
  "tags": ["#标签1", "#标签2", "#标签3"]
}`
}

// ==================== 分镜头生成 ====================

export interface StoryboardItem {
  shot: string
  duration: number
  prompt: string
  motion: string
}

export const STORYBOARD_SYSTEM_PROMPT = `你是一位短视频分镜头脚本专家，擅长将口播内容拆解为视觉画面，并撰写可直接用于 Google Veo 生视频的 prompt。

## 任务

根据下方的内容方案，拆分为分镜头脚本。每个镜头作为独立的剪辑素材片段，供剪辑师按需取用。

## 输出规则

1. 每个镜头时长只能是 4、6 或 8 秒（Veo 限制），默认 4 秒
2. prompt 用中文，面向视频生成，包含：主体、构图、运镜、光线、氛围、色调
3. 不涉及真人面部和动作，主要生成信息流视频素材（产品特写、数据卡片动效、场景氛围、文字排版动画、对比图等）
4. 每个镜头标注运镜方式（如推近、平移、固定、缓慢拉远）
5. 镜头内容要覆盖口播稿中的各个知识点和卖点，确保剪辑师有足够的素材可选
6. 仅输出 JSON 数组，不要包裹 markdown 代码块`

export function buildStoryboardPrompt(
  customer: CustomerInfo,
  plan: ContentPlan,
  shotCount: number
): string {
  const corePoints = plan.corePoints.map((p, i) => `${i + 1}. ${p}`).join("\n")
  const industry = (customer.industry as string[]).join("、")

  return `## 内容方案

- 主题：${plan.topic}
- 风格：${plan.style}
- 核心卖点：
${corePoints}
- 口播稿初稿：${plan.scriptDraft}

## 客户信息

- 行业：${industry}
- 内容调性：${customer.contentTone || "未指定"}
- 规避方向：${customer.avoidTopics || "无"}

## 输出 JSON

请输出 ${shotCount} 个镜头，JSON 数组格式：

[
  {
    "shot": "镜头描述（说明展示什么内容）",
    "duration": 4,
    "prompt": "中文 Veo 生视频 prompt，包含主体、构图、运镜、光线、氛围、色调",
    "motion": "运镜描述（推近/平移/固定/缓慢拉远等）"
  }
]`
}

// ==================== 素材图片生成 ====================

export interface MaterialItem {
  purpose: string
  ratio: string
  prompt: string
}

const PLATFORM_COVER_RATIO: Record<string, string> = {
  抖音: "16:9",
  视频号: "16:9",
  快手: "16:9",
  B站: "16:9",
  TikTok: "16:9",
  小红书: "3:4",
}

export const MATERIAL_SYSTEM_PROMPT = `你是一位短视频视觉设计专家，擅长为短视频策划配套的图片素材，并撰写可直接用于 AI 生图的 prompt。

## 任务

根据下方的内容方案，生成配套的图片素材方案，覆盖封面图和视频中穿插的信息卡片/产品图/对比图等。

## 平台封面比例

- 抖音/视频号/快手/B站/TikTok：16:9
- 小红书：3:4

（根据 account.platform 自动匹配）

## 输出规则

1. 封面图必须有且仅有 1 张，要有视觉冲击力和点击欲望
2. 封面图比例按上方平台映射，其余图片按用途选择合适比例（1:1 / 4:3 / 16:9 / 3:4）
3. prompt 用中文，包含：主体、构图、光线、风格、色调
4. 不涉及真人面部
5. 仅输出 JSON 数组，不要包裹 markdown 代码块`

export function buildMaterialPrompt(
  customer: CustomerInfo,
  account: AccountInfo,
  plan: ContentPlan,
  count: number
): string {
  const corePoints = plan.corePoints.map((p, i) => `${i + 1}. ${p}`).join("\n")
  const coverRatio = PLATFORM_COVER_RATIO[account.platform] || "16:9"
  const industry = (customer.industry as string[]).join("、")

  return `## 内容方案

- 主题：${plan.topic}
- 风格：${plan.style}
- 核心卖点：
${corePoints}

## 客户信息

- 行业：${industry}
- 内容方向：${customer.contentFocus}
- 内容调性：${customer.contentTone || "未指定"}
- 规避方向：${customer.avoidTopics || "无"}

## 平台信息

- 平台：${account.platform}
- 封面图比例：${coverRatio}

## 输出 JSON

请输出 ${count} 张图片（其中 1 张封面图、其余按需配置），JSON 数组格式：

[
  {
    "purpose": "封面图",
    "ratio": "${coverRatio}",
    "prompt": "中文 AI 生图 prompt，包含主体、构图、光线、风格、色调"
  },
  {
    "purpose": "知识卡片 / 产品主图 / 对比图 / 场景氛围图",
    "ratio": "根据用途选择（1:1 / 4:3 / 16:9 / 3:4）",
    "prompt": "中文 AI 生图 prompt"
  }
]`
}

// ==================== 热点话题检索（来源层用） ====================

export interface HotspotsInput {
  customerName: string
  industry: string
  contentFocus: string
  coreKeywords: string[]
  targetPositioning: string
  avoidTopics: string
}

export interface HotspotItem {
  rank: number
  title: string
  platform: string
  summary: string
  content: string
  url: string
}

export interface HotspotsResult {
  keywordsExpansion: string[]
  hotspots: HotspotItem[]
  summary: string
  meta: {
    generatedAt: string
    platformsSearched: string[]
    notes: string
  }
}

export const HOTSPOTS_SYSTEM_PROMPT = `你是一位资深的新媒体热点策划师，服务过多个品牌客户，擅长全网捕捉可借势的热点话题，并能精准评估热点与品牌的契合度、借势难度和舆情风险。

# 约束条件（必须遵守）
1. 严禁输出任何触及「规避方向」的话题，即便热度再高。
2. 每条热点必须附真实、可验证的来源链接。若无法获取，明确标注「链接待核实」。
3. 若某平台在检索时数据不足或无法访问，请在输出末尾说明，**不要编造热点**。
4. 全部使用简体中文输出。
5. 发酵时间早于 7 天前的热点不纳入。`

export function buildHotspotsPrompt(input: HotspotsInput): string {
  return `# 客户画像
- 客户名称：${input.customerName}
- 所属行业：${input.industry}
- 内容方向：${input.contentFocus}
- 账号核心关键词：${input.coreKeywords.join("、") || "未填写"}
- 目标定位：${input.targetPositioning || "未填写"}
- 规避方向：${input.avoidTopics || "无"}

# 任务
请结合上述客户画像，检索**过去 7 天内**以下平台的热点话题，筛选出
**与该客户最契合且不触及规避方向的 8 条热点**，并按指定格式输出。

检索平台（按优先级）：
1. 微博热搜 / 抖音热榜 / 小红书热点 / 知乎热榜 / B站热门
2. 行业垂直媒体（请根据"所属行业"自行判断，例如美妆行业可覆盖
   聚美丽、青眼、CBO 等）
3. 微信公众号近期10w+文章
4. 谷歌趋势（海外热点，若客户有出海需求）

# 执行步骤（请严格按顺序执行，并在最终输出前先简要列出）
1. **关键词拓展**：基于客户画像，拓展 3-5 组检索词（行业词 × 场景词 × 人群词）
2. **多平台检索**：按拓展词在上述平台执行搜索
3. **硬性过滤**：先剔除所有触及「规避方向」的话题（这一步优先级最高）
4. **排序输出**：按「相关性 × 热度 ÷ (借势难度 + 风险)」综合排序，取 TOP 8

# 输出格式（严格遵守，不要增减字段）

## 一、检索词拓展
（列出你拓展的 3-5 组关键词）

## 二、热点清单

{
  "keywordsExpansion": [
    "拓展检索词1（行业词，如'抗老精华'）",
    "拓展检索词2（场景词，如'熬夜急救'）",
    "拓展检索词3（人群词，如'职场女性护肤'）"
  ],
  "hotspots": [
    {
      "rank": "排名序号（1-8的整数，按综合评分从高到低）",
      "title": "热点标题（30字以内，一句话概括）",
      "platform": "来源平台（微博/抖音/小红书/知乎/B站/微信公众号/行业媒体）",
      "summary": "事件摘要（100字以内，含背景+冲突点+当前进展）",
      "content": "事件全文（300-600字之内，不能低于300字，需要理清事件脉络）",
      "url": "原文链接（真实可访问URL，无法获取写'链接待核实'，禁止编造）"
    }
  ],
  "summary": "整体建议（3-5句话，含本期热点趋势+优先落地的1-2条及原因）",
  "meta": {
    "generatedAt": "生成时间（ISO 8601格式，如'2026-04-22T10:30:00+08:00'）",
    "platformsSearched": ["实际检索的平台清单（数组，便于排查遗漏）"],
    "notes": "检索异常说明（无异常写'无'，有问题如实汇报，禁止用编造数据凑数）"
  }
}

## 三、总结建议
用 3-5 句话总结本期热点的整体方向，以及建议客户优先落地的 1-2 条。`
}
