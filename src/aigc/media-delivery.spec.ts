import axios from "axios"
import { readFile, writeFile } from "node:fs/promises"
import { Readable } from "node:stream"
import { aigcMetadata } from "./aigc-metadata"
import { deliverVideo } from "./media-delivery"
import { labelVideo } from "./video-label"

jest.mock("axios")
jest.mock("./video-label", () => ({ labelVideo: jest.fn() }))
jest.mock("../common/utils/public-media-url", () => ({
  publicMediaDownloadAgent: jest.fn(() => Promise.resolve({ destroy: jest.fn() })),
}))

describe("视频交付失败只重试已有文件", () => {
  it("私有源文件保留，失败不公开；恢复复用源文件，完成后重复回调不再处理", async () => {
    const objects = new Map<string, { data: Buffer; metadata: Record<string, string> }>()
    const spaces = {
      getObjectMetadata: jest.fn((key: string) => {
        const value = objects.get(key)
        return value
          ? Promise.resolve({ metadata: value.metadata })
          : Promise.reject({ $metadata: { httpStatusCode: 404 } })
      }),
      getPublicUrl: jest.fn((key: string) => `https://cdn.example/${key}`),
      uploadFile: jest.fn(
        async (path: string, key: string, _mime: string, _acl: string, metadata = {}) => {
          objects.set(key, { data: await readFile(path), metadata })
          return `https://cdn.example/${key}`
        }
      ),
      downloadObjectToFile: jest.fn((key: string, path: string) =>
        writeFile(path, objects.get(key)!.data)
      ),
    }
    jest
      .mocked(axios.get)
      .mockResolvedValue({ data: Readable.from([Buffer.from("private video source")]) })
    jest.mocked(labelVideo).mockRejectedValueOnce(new Error("ffmpeg unavailable"))
    await expect(
      deliverVideo(spaces as never, "https://vendor.example/video.mp4", "retry-test")
    ).rejects.toMatchObject({ code: "AIGC_DELIVERY_FAILED" })
    expect(spaces.uploadFile).toHaveBeenCalledTimes(1)
    expect(spaces.uploadFile.mock.calls[0][3]).toBe("private")
    jest
      .mocked(labelVideo)
      .mockImplementationOnce((path, _directory, id) =>
        Promise.resolve({ path, metadata: aigcMetadata(id), width: 320, height: 240 })
      )
    const delivered = await deliverVideo(
      spaces as never,
      "https://vendor.example/video.mp4",
      "retry-test"
    )
    expect(delivered).toContain("/aigc/videos/v1/")
    expect(axios.get).toHaveBeenCalledTimes(1)
    expect(spaces.downloadObjectToFile).toHaveBeenCalledTimes(1)
    expect(spaces.uploadFile.mock.calls[1][3]).toBe("public-read")
    await expect(
      deliverVideo(spaces as never, "https://vendor.example/video.mp4", "retry-test")
    ).resolves.toBe(delivered)
    expect(labelVideo).toHaveBeenCalledTimes(2)
  })
})
