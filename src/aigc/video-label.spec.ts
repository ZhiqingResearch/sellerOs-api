import { execFileSync, spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { parseAigc } from "./aigc-metadata"
import { labelVideo, probeVideo } from "./video-label"

const nativeTools =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0
;(nativeTools ? describe : describe.skip)("真实视频文件标识（需要ffmpeg/ffprobe）", () => {
  let directory: string, source: string
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "aigc-test-"))
    source = join(directory, "source.mp4")
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:r=24:d=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      source,
    ])
  })
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it("首尾画面都有像素水印，MP4元数据可回读，音频、尺寸和时长保留", async () => {
    const result = await labelVideo(source, directory, "video-test")
    const probe = await probeVideo(result.path)
    expect(probe.streams.find(item => item.codec_type === "video")).toMatchObject({
      width: 320,
      height: 240,
      avg_frame_rate: "24/1",
    })
    expect(probe.streams.some(item => item.codec_type === "audio")).toBe(true)
    expect(Number(probe.format?.duration)).toBeCloseTo(3, 1)
    expect(parseAigc(probe.format?.tags?.AIGC)?.AIGC).toMatchObject({
      Label: "1",
      PropagateID: "video-test",
    })
    for (const time of [0, 2.5]) {
      const png = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-ss",
        String(time),
        "-i",
        result.path,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
      ])
      const corner = await sharp(png)
        .extract({ left: 305, top: 222, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer()
      expect(corner[2]).toBeLessThan(230)
    }
  })

  it("无效视频不返回可交付文件", async () => {
    await expect(labelVideo(join(directory, "missing"), directory, "invalid")).rejects.toThrow()
  })
})
