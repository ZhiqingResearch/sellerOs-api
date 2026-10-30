import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { aigcMetadata, parseAigc } from "./aigc-metadata"
import { watermarkBadge } from "./image-label"

const execute = promisify(execFile)

interface VideoProbe {
  streams: Array<{
    codec_type?: string
    width?: number
    height?: number
    duration?: string
    avg_frame_rate?: string
    side_data_list?: Array<{ rotation?: number }>
  }>
  format?: { duration?: string; tags?: Record<string, string> }
}

export async function probeVideo(path: string): Promise<VideoProbe> {
  const { stdout } = await execute(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      path,
    ],
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
  )
  return JSON.parse(stdout) as VideoProbe
}

export async function labelVideo(source: string, directory: string, id: string) {
  const before = await probeVideo(source)
  const video = before.streams.find(item => item.codec_type === "video")
  if (!video?.width || !video.height) throw new Error("生成视频没有可识别画面")
  const rotation =
    video.side_data_list?.find(item => typeof item.rotation === "number")?.rotation ?? 0
  const swap = Math.abs(rotation) % 180 === 90
  const width = swap ? video.height : video.width
  const height = swap ? video.width : video.height
  const original = Object.entries(before.format?.tags ?? {}).find(
    ([key]) => key.toUpperCase() === "AIGC"
  )?.[1]
  const metadata = aigcMetadata(id, parseAigc(original))
  const badge = await watermarkBadge(width, height)
  const badgePath = join(directory, "watermark.png")
  const output = join(directory, "labeled.mp4")
  await writeFile(badgePath, badge.buffer)
  await execute(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-threads",
      "2",
      "-filter_complex_threads",
      "1",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      source,
      "-i",
      badgePath,
      "-filter_complex",
      `[0:v:0][1:v:0]overlay=x=W-w-${badge.margin}:y=H-h-${badge.margin}:format=auto[v]`,
      "-map",
      "[v]",
      "-map",
      "0:a?",
      "-map_metadata",
      "-1",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-pix_fmt",
      width % 2 || height % 2 ? "yuv444p" : "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart+use_metadata_tags",
      "-metadata",
      `AIGC=${JSON.stringify(metadata)}`,
      output,
    ],
    { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 }
  )
  const after = await probeVideo(output)
  const delivered = after.streams.find(item => item.codec_type === "video")
  const embedded = Object.entries(after.format?.tags ?? {}).find(
    ([key]) => key.toUpperCase() === "AIGC"
  )?.[1]
  const duration = Number(before.format?.duration)
  const outputDuration = Number(after.format?.duration)
  if (
    delivered?.width !== width ||
    delivered.height !== height ||
    parseAigc(embedded)?.AIGC.PropagateID !== id ||
    !Number.isFinite(outputDuration) ||
    outputDuration <= 0 ||
    (Number.isFinite(duration) && Math.abs(outputDuration - duration) > 0.25) ||
    after.streams.filter(item => item.codec_type === "audio").length !==
      before.streams.filter(item => item.codec_type === "audio").length
  )
    throw new Error("生成视频标识校验失败")
  return { path: output, metadata, width, height }
}
