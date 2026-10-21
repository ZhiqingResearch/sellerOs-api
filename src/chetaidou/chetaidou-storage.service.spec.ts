import sharp from "sharp"
import { SpacesService } from "../spaces/spaces.service"
import { ChetaidouStorageService } from "./chetaidou-storage.service"

describe("车泰斗图片不设置 PRD 之外的容量上限", () => {
  const service = new ChetaidouStorageService({} as SpacesService)

  it("接受超过原 4096 边长和 16777216 像素的有效图片", async () => {
    const buffer = await sharp({
      create: { width: 4100, height: 4100, channels: 3, background: "white" },
    })
      .png()
      .toBuffer()
    const result = await service.validateImage(buffer)
    expect(result.width).toBe(4100)
    expect(result.height).toBe(4100)
  })

  it("接受超过原上传及导入 10/25 MiB 上限的有效图片字节", async () => {
    const png = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "white" },
    })
      .png()
      .toBuffer()
    const buffer = Buffer.concat([png, Buffer.alloc(26 * 1024 * 1024)])
    const result = await service.validateImage(buffer)
    expect(result.buffer).toBe(buffer)
    expect(result.mime).toBe("image/png")
  })

  it("仍拒绝空文件和伪装图片", async () => {
    await expect(service.validateImage(Buffer.alloc(0))).rejects.toThrow("上传文件为空")
    await expect(service.validateImage(Buffer.from("not-a-real-image"))).rejects.toThrow(
      "仅支持 JPEG/PNG/WebP 图片"
    )
  })
})

describe("车泰斗缩略图与下载", () => {
  it("缩略图不放大、保持比例且 private；签名携带后端文件名", async () => {
    const uploadBuffer = jest.fn().mockResolvedValue(undefined)
    const generateSignedDownloadUrl = jest.fn().mockResolvedValue("signed")
    const storage = new ChetaidouStorageService({
      uploadBuffer,
      generateSignedDownloadUrl,
    } as unknown as SpacesService)
    const buffer = await sharp({
      create: { width: 800, height: 400, channels: 3, background: "white" },
    })
      .png()
      .toBuffer()
    const key = await storage.uploadThumbnail(buffer, "master.png")
    const [thumbnail, storedKey, mime, acl] = uploadBuffer.mock.calls[0] as [
      Buffer,
      string,
      string,
      string,
    ]
    expect(await sharp(thumbnail).metadata()).toMatchObject({
      width: 256,
      height: 128,
      format: "webp",
    })
    expect([key, storedKey, mime, acl]).toEqual([
      "master.png.thumbnail.webp",
      "master.png.thumbnail.webp",
      "image/webp",
      "private",
    ])
    const filename = storage.downloadFilename({
      skuCode: "CS1plus",
      imageNumber: "7",
      taskId: "abcdefgh-long",
      index: 1,
      mime: "image/png",
    })
    expect(filename).toBe("CS1plus_NO7_abcdefgh_1.png")
    await storage.signDownload("output.png", 600, filename)
    expect(generateSignedDownloadUrl).toHaveBeenCalledWith("output.png", 600, filename)
  })
})

describe("车泰斗裁剪公开直传", () => {
  const userId = 7
  const fileKey = "chetaidou/crops/7/c64f5c10-828e-48c8-aabc-e5820a792846.png"
  const url = `https://assets.example/${fileKey}`
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=",
    "base64"
  )
  function setup() {
    const spaces = {
      getPublicUrl: jest.fn((key: string) => `https://assets.example/${key}`),
      generateUploadUrl: jest
        .fn<
          Promise<{ uploadUrl: string; publicUrl: string }>,
          [Parameters<SpacesService["generateUploadUrl"]>[0]]
        >()
        .mockResolvedValue({ uploadUrl: "signed-put", publicUrl: url }),
      getObjectMetadata: jest
        .fn()
        .mockResolvedValue({ contentType: "image/png", metadata: { "owner-id": "7" } }),
      downloadBuffer: jest.fn().mockResolvedValue(png.subarray(0, 33)),
      uploadBuffer: jest.fn(),
      deleteObject: jest.fn(),
    }
    return { spaces, storage: new ChetaidouStorageService(spaces as unknown as SpacesService) }
  }
  it("凭证强制 public-read、PNG 与服务端当前用户元数据", async () => {
    const { storage, spaces } = setup()
    await storage.createCropUpload(userId)
    expect(spaces.generateUploadUrl.mock.calls[0][0]).toMatchObject({
      key: expect.stringMatching(/^chetaidou\/crops\/7\/[\da-f-]{36}\.png$/) as unknown,
      contentType: "image/png",
      acl: "public-read",
      metadata: { "owner-id": "7" },
    })
  })
  it("只读真实 PNG 头获得尺寸，保存无需上传、删除或二次处理", async () => {
    const { storage, spaces } = setup()
    expect(await storage.inspectCropPng(userId, url)).toEqual({
      fileKey,
      width: 1,
      height: 1,
      mime: "image/png",
    })
    expect(spaces.downloadBuffer).toHaveBeenCalledWith(fileKey, "bytes=0-32")
    expect(spaces.uploadBuffer).not.toHaveBeenCalled()
    expect(spaces.deleteObject).not.toHaveBeenCalled()
  })
  it.each([
    url.replace("/7/", "/8/"),
    "https://other.example/a.png",
    `${url}?signature=x`,
    url.replace(".png", ".jpg"),
  ])("拒绝非本人凭证地址 %s，不读取对象", async value => {
    const { storage, spaces } = setup()
    await expect(storage.inspectCropPng(userId, value)).rejects.toThrow("本人裁剪直传")
    expect(spaces.getObjectMetadata).not.toHaveBeenCalled()
  })
  it("仅伪造当前用户路径但没有签名用户元数据时拒绝", async () => {
    const { storage, spaces } = setup()
    spaces.getObjectMetadata.mockResolvedValue({ contentType: "image/png", metadata: {} } as never)
    await expect(storage.inspectCropPng(userId, url)).rejects.toThrow("不属于当前用户")
    expect(spaces.downloadBuffer).not.toHaveBeenCalled()
  })
  it("格式不符、PNG 头损坏与未完成上传均拒绝", async () => {
    const mime = setup()
    mime.spaces.getObjectMetadata.mockResolvedValue({
      contentType: "image/jpeg",
      metadata: { "owner-id": "7" },
    })
    await expect(mime.storage.inspectCropPng(userId, url)).rejects.toThrow("PNG 图片")
    const broken = setup()
    broken.spaces.downloadBuffer.mockResolvedValue(Buffer.from("not-png"))
    await expect(broken.storage.inspectCropPng(userId, url)).rejects.toThrow("有效的裁剪 PNG")
    const missing = setup()
    missing.spaces.getObjectMetadata.mockRejectedValue({ $metadata: { httpStatusCode: 404 } })
    await expect(missing.storage.inspectCropPng(userId, url)).rejects.toThrow("尚未上传完成")
  })
})
