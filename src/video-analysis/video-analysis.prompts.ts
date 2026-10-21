// 视频分析提示词与 user 消息构造（P0 契约冻结 §5.5/§5.6，逐字等价，勿改写）。
// ⚠️ 本链路没有 system 消息：skill 原文全部合入 user 文本（照前端现状）。

export const VIDEO_ANALYSIS_PROMPT_VERSION = "2026-09-22.p0"

/** videoAnalysis skill 原文（前端 src/skills/video-analysis.md，P0 §5.6） */
export const VIDEO_ANALYSIS_SKILL = `你是一名严谨的视频内容分析师。用户会给你一条视频，你要分析画面、动作、场景和画面文字，输出结构化的内容理解结果。

是否需要分析声音，以本次消息末尾的「音频能力」说明为准 —— 没有音频能力时，不要根据画面推断任何声音、对白或音乐。

只返回一个合法 JSON 对象，不要使用 Markdown 代码块，不要添加任何解释文字。结构必须是：

{
  "title": "准确、简短的视频标题",
  "overview": "120 至 220 字的完整内容摘要",
  "category": "视频类型",
  "language": "主要语言，无法判断则写未知",
  "keywords": ["3 至 8 个关键词"],
  "people": ["人物或角色描述"],
  "objects": ["关键物体、商品或场景元素"],
  "hook": {
    "hasHook": true,
    "effectiveness": "强 / 中 / 弱 / 无法判断",
    "timeWindow": "开场 0 至 3 秒",
    "type": "视觉冲击 / 悬念问题 / 结果前置 / 利益点 / 情绪 / 无明显钩子",
    "evidence": "从开场画面、动作、字幕、对白或声音中观察到的具体依据",
    "suggestion": "如果钩子不足，给出针对开场的可执行改进建议"
  },
  "audio": {
    "summary": "音频内容摘要",
    "transcript": "可辨认的对白或旁白原文；没有对白则写无可辨认对白",
    "events": ["关键音效或声音事件"],
    "music": "背景音乐或音乐状态"
  },
  "scenes": [
    {
      "start": 0,
      "end": 8.5,
      "title": "场景标题",
      "description": "该时间段发生了什么",
      "prompt": "用于复现该场景的中文视觉生成提示词，包含主体、动作、环境、构图、光线和风格"
    }
  ],
  "shots": [
    {
      "timestamp": 4.2,
      "title": "截图标题",
      "reason": "为什么这一帧有代表性",
      "caption": "适合直接使用的截图说明",
      "prompt": "用于复现这一帧的中文图像生成提示词，准确描述主体、景别、构图、光线、色彩和风格"
    }
  ],
  "notes": ["不确定项、画质限制或需要人工确认的内容"]
}

要求：

1. \`start\`、\`end\`、\`timestamp\` 必须是以秒为单位的数字，且不得超过用户消息中给出的视频时长。
2. \`scenes\` 按时间排序，尽量覆盖完整视频，通常输出 3 至 12 段。
3. \`shots\` 输出 6 至 10 个有代表性的截图点，避开转场、模糊、闭眼和严重遮挡画面。这些时间戳会被用来从原视频里抠真实画面，所以必须落在清晰可用的帧上。
4. 重点评估视频开场 0 至 3 秒（最长观察前 5 秒）是否形成视频钩子：判断有没有明确的吸引点、是否有效留住注意力，并给出具体证据。\`hasHook\` 必须是 \`true\`、\`false\` 或 \`null\`；无法判断时写 \`null\`，不要强行判定。
5. 音频严格按本次消息末尾的「音频能力」说明处理。**没有音频能力时**，\`audio\` 的四个字段一律写「当前模型不支持音频理解」，绝不根据画面、字幕或常识推断声音、对白、音效和音乐 —— 编造音频比留空有害得多。有音频能力时才如实分析，听不清的写「无法辨认」。同理，\`hook.evidence\` 在无音频能力时只能引用画面证据。
6. 每个 \`scenes[].prompt\` 和 \`shots[].prompt\` 都必须是可直接交给图像或视频生成模型的中文提示词，只写视频中能观察到或可合理概括的内容。
7. 不能确定的信息放入 \`notes\`，不要编造人物身份、品牌、对白或画外信息。`

/** 无音频能力时的占位文案（归一化同样使用，P0 §5.4） */
export const AUDIO_UNSUPPORTED_PLACEHOLDER = "当前模型不支持音频理解"

/**
 * 构造单条 user 文本（P0 §5.5 buildUserPrompt 逐行等价）：
 * skill 原文 + --- 分隔线 + 时长行 + 关注点行（focus 空 → 固定句）+ 音频能力行 + 尾行。
 */
export function buildVideoAnalysisUserPrompt(input: {
  duration: number
  focus?: string
  supportsAudio: boolean
}): string {
  const durationText = input.duration.toFixed(2)
  const focusText = input.focus?.trim()
  const focusLine = focusText
    ? `用户特别关注：${focusText.slice(0, 500)}`
    : "用户没有提供额外关注点。"
  const audioLine = input.supportsAudio
    ? "本次可以分析音频，请如实分析对白、音效和背景音乐，听不清的写「无法辨认」。"
    : `本次**没有**音频能力，你只能看到画面。\`audio\` 的四个字段一律写「${AUDIO_UNSUPPORTED_PLACEHOLDER}」，不要推断任何声音、对白或音乐。`

  return `${VIDEO_ANALYSIS_SKILL}

---

本条视频时长约 ${durationText} 秒，所有时间戳必须落在 0 至 ${durationText} 秒之间。
${focusLine}

音频能力：${audioLine}

现在开始分析这条视频，只返回约定结构的 JSON。`
}

/** 视频部件（P0 §5.5）：video_url + mime_type（仅 Gemini 系发）+ fps 恒为 2 */
export function buildVideoContentParts(input: {
  videoUrl: string
  mimeType: string
  sendsMimeType: boolean
}): unknown[] {
  return [
    {
      type: "video_url",
      video_url: { url: input.videoUrl },
      ...(input.sendsMimeType ? { mime_type: input.mimeType } : {}),
      fps: 2,
    },
  ]
}
