import sharp from "sharp"
import { resolveDeliveredImageDimensions } from "./delivered-image-dimensions"

describe("最终交付文件尺寸兜底", () => {
  const originalFetch = global.fetch
  const fetchMock = jest.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock
  })
  afterEach(() => {
    global.fetch = originalFetch
  })

  it("已有完整宽高时不下载文件", async () => {
    const known = { width: 2048, height: 1365 }
    expect(await resolveDeliveredImageDimensions("https://cdn.example/final.png", known)).toBe(
      known
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(["png", "jpeg", "webp"] as const)(
    "从 %s 文件头读取真实尺寸，缺一边时整对实测",
    async format => {
      const bytes = await sharp({
        create: { width: 357, height: 211, channels: 3, background: "white" },
      })
        .toFormat(format)
        .toBuffer()
      fetchMock.mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(bytes) })
      expect(
        await resolveDeliveredImageDimensions("https://cdn.example/final", { width: 1024 })
      ).toEqual({ width: 357, height: 211 })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each(["http", "invalid-image", "timeout"])(
    "探测失败仍保留已生成图片的尺寸状态：%s",
    async failure => {
      if (failure === "http") fetchMock.mockResolvedValue({ ok: false, status: 403 })
      else if (failure === "invalid-image")
        fetchMock.mockResolvedValue({
          ok: true,
          arrayBuffer: () => Promise.resolve(Buffer.from("invalid")),
        })
      else fetchMock.mockRejectedValue(new Error("请求超时"))
      const known = {}
      expect(await resolveDeliveredImageDimensions("https://cdn.example/final", known)).toBe(known)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it("继承任务取消信号，并为下载设置超时信号", async () => {
    const controller = new AbortController()
    controller.abort()
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      expect(init.signal?.aborted).toBe(true)
      return Promise.reject(new Error("任务已取消"))
    })
    expect(
      await resolveDeliveredImageDimensions("https://cdn.example/final", {}, controller.signal)
    ).toEqual({})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
