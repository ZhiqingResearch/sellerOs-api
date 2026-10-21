import { AUDIO_UNSUPPORTED_PLACEHOLDER } from "./video-analysis.prompts"

/**
 * VideoAnalysisResult 归一化（P0 契约冻结 §5.4）：
 * - 每字段必存在（前端零判空）
 * - scenes ≤ 20、shots ≤ 12；shots 不足时从 scenes 派生补齐（补齐后总量上限 8）
 * - 所有时间戳 clamp 到 [0, duration]
 * - 无音频能力的模型 audio.supported=false 且四字段为占位文案
 *
 * 派生补齐规则：shots 少于 6（skill 要求 6–10）时，按时间序从 scenes 中点派生
 * （跳过与现有 timestamp 距离 < 0.5s 的场景），补齐到 6，总量不超过 8。
 * 规则细节联调时对照前端 normalize.ts 校准（P0 §8）。
 */

export interface VideoAnalysisScene {
  start: number
  end: number
  title: string
  description: string
  prompt: string
}

export interface VideoAnalysisShot {
  timestamp: number
  title: string
  reason: string
  caption: string
  prompt: string
}

export interface VideoAnalysisResult {
  title: string
  overview: string
  category: string
  language: string
  keywords: string[]
  people: string[]
  objects: string[]
  notes: string[]
  hook: {
    hasHook: boolean | null
    effectiveness: string
    timeWindow: string
    type: string
    evidence: string
    suggestion: string
  }
  audio: {
    supported: boolean
    summary: string
    transcript: string
    events: string[]
    music: string
  }
  scenes: VideoAnalysisScene[]
  shots: VideoAnalysisShot[]
}

const MAX_SCENES = 20
const MAX_SHOTS = 12
const MIN_SHOTS = 6
const DERIVED_SHOTS_CAP = 8
const SHOT_MIN_SPACING_SEC = 0.5

const clamp = (value: number, duration: number): number =>
  Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), duration)

const asString = (value: unknown): string => (typeof value === "string" ? value : "")

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

export function normalizeVideoAnalysisResult(
  raw: unknown,
  duration: number,
  supportsAudio: boolean
): VideoAnalysisResult {
  const source = (raw ?? {}) as Record<string, unknown>
  const hook = (source.hook ?? {}) as Record<string, unknown>
  const audio = (source.audio ?? {}) as Record<string, unknown>

  const scenes = asStringMappedScenes(source.scenes, duration)
  const shots = asNormalizedShots(source.shots, duration)

  return {
    title: asString(source.title),
    overview: asString(source.overview),
    category: asString(source.category),
    language: asString(source.language),
    keywords: asStringArray(source.keywords),
    people: asStringArray(source.people),
    objects: asStringArray(source.objects),
    notes: asStringArray(source.notes),
    hook: {
      hasHook: hook.hasHook === true ? true : hook.hasHook === false ? false : null,
      effectiveness: asString(hook.effectiveness),
      timeWindow: asString(hook.timeWindow),
      type: asString(hook.type),
      evidence: asString(hook.evidence),
      suggestion: asString(hook.suggestion),
    },
    audio: supportsAudio
      ? {
          supported: true,
          summary: asString(audio.summary),
          transcript: asString(audio.transcript),
          events: asStringArray(audio.events),
          music: asString(audio.music),
        }
      : {
          supported: false,
          summary: AUDIO_UNSUPPORTED_PLACEHOLDER,
          transcript: AUDIO_UNSUPPORTED_PLACEHOLDER,
          events: [AUDIO_UNSUPPORTED_PLACEHOLDER],
          music: AUDIO_UNSUPPORTED_PLACEHOLDER,
        },
    scenes,
    shots: fillShotsFromScenes(shots, scenes, duration),
  }
}

function asStringMappedScenes(value: unknown, duration: number): VideoAnalysisScene[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): VideoAnalysisScene => {
      const scene = (item ?? {}) as Record<string, unknown>
      const start = clamp(Number(scene.start), duration)
      const end = clamp(Number(scene.end), duration)
      return {
        start,
        end: Math.max(start, end),
        title: asString(scene.title),
        description: asString(scene.description),
        prompt: asString(scene.prompt),
      }
    })
    .slice(0, MAX_SCENES)
}

function asNormalizedShots(value: unknown, duration: number): VideoAnalysisShot[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): VideoAnalysisShot => {
      const shot = (item ?? {}) as Record<string, unknown>
      return {
        timestamp: clamp(Number(shot.timestamp), duration),
        title: asString(shot.title),
        reason: asString(shot.reason),
        caption: asString(shot.caption),
        prompt: asString(shot.prompt),
      }
    })
    .slice(0, MAX_SHOTS)
}

/** shots 不足（< 6）时按时间序从 scenes 中点派生补齐到 6，总量上限 8 */
function fillShotsFromScenes(
  shots: VideoAnalysisShot[],
  scenes: VideoAnalysisScene[],
  duration: number
): VideoAnalysisShot[] {
  const filled = [...shots]
  if (filled.length >= MIN_SHOTS || scenes.length === 0) return filled

  const sortedScenes = [...scenes].sort((a, b) => a.start - b.start)
  for (const scene of sortedScenes) {
    if (filled.length >= DERIVED_SHOTS_CAP || filled.length >= MIN_SHOTS) break
    const midpoint = clamp((scene.start + scene.end) / 2, duration)
    if (filled.some(shot => Math.abs(shot.timestamp - midpoint) < SHOT_MIN_SPACING_SEC)) continue
    filled.push({
      timestamp: midpoint,
      title: scene.title,
      reason: "从场景分段派生的代表性截图点",
      caption: scene.description,
      prompt: scene.prompt,
    })
  }
  return filled
}
