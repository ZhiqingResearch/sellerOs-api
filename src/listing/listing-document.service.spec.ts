import { BadRequestException } from "@nestjs/common"
import * as XLSX from "xlsx"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { SpacesService } from "../spaces/spaces.service"
import { ListingDocumentService } from "./listing-document.service"

describe("ListingDocumentService", () => {
  interface UploadOptions {
    acl: string
    contentLength: number
    expiresIn: number
    key: string
  }

  interface GenerateJsonOptions {
    model?: string
    userContent?: unknown
  }

  type GenerateJson = (
    systemPrompt: string,
    userPrompt: string,
    options?: GenerateJsonOptions
  ) => Promise<unknown>

  const generatedUploadOptions: UploadOptions[] = []
  const generateUploadUrl = jest.fn((options: UploadOptions) => {
    generatedUploadOptions.push(options)
    return Promise.resolve({
      uploadUrl: "https://spaces.example/upload",
      publicUrl: "https://spaces.example/private",
      key: options.key,
      headers: { "x-amz-acl": "private", "Content-Type": "application/pdf" },
      expiresIn: 600,
    })
  })
  const getObjectMetadata = jest.fn()
  const downloadBuffer = jest.fn()
  const generateSignedDownloadUrl = jest
    .fn()
    .mockResolvedValue("https://spaces.example/private-file?signature=test")
  const deleteObject = jest.fn().mockResolvedValue(undefined)
  const spacesService = {
    generateUploadUrl,
    getObjectMetadata,
    downloadBuffer,
    generateSignedDownloadUrl,
    deleteObject,
  }
  const generateJson = jest.fn<GenerateJson>()
  const aiGatewayProvider = { generateJson }
  let service: ListingDocumentService

  beforeEach(() => {
    jest.clearAllMocks()
    generatedUploadOptions.length = 0
    service = new ListingDocumentService(
      spacesService as unknown as SpacesService,
      aiGatewayProvider as unknown as AiGatewayProvider
    )
  })

  it("生成用户隔离且 private 的文档直传凭证", async () => {
    const result = await service.createUploadTicket(7, {
      fileName: "manual.pdf",
      mimeType: "application/pdf",
      fileSize: 1024,
    })

    const uploadOptions = generatedUploadOptions[0]
    expect(uploadOptions.key).toMatch(/^listing-documents\/7\/[0-9a-f-]{36}\.pdf$/)
    expect(uploadOptions).toEqual(
      expect.objectContaining({ acl: "private", contentLength: 1024, expiresIn: 600 })
    )
    expect(result.objectKey).toBe(uploadOptions.key)
    expect(result).not.toHaveProperty("publicUrl")
  })

  it("拒绝后端解析器不支持的旧版 Office 格式", async () => {
    await expect(
      service.createUploadTicket(7, {
        fileName: "legacy.doc",
        mimeType: "application/msword",
        fileSize: 1024,
      })
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("允许为超过 50MB 且不超过 200MB 的文档创建上传凭证", async () => {
    const fileSize = 51 * 1024 * 1024

    await service.createUploadTicket(7, {
      fileName: "large.pdf",
      mimeType: "application/pdf",
      fileSize,
    })

    expect(generatedUploadOptions[0]).toEqual(
      expect.objectContaining({ contentLength: fileSize })
    )
  })

  it("拒绝为超过 200MB 的文档创建上传凭证", async () => {
    await expect(
      service.createUploadTicket(7, {
        fileName: "oversized.pdf",
        mimeType: "application/pdf",
        fileSize: 200 * 1024 * 1024 + 1,
      })
    ).rejects.toThrow("文档不能超过 200MB")
    expect(generateUploadUrl).not.toHaveBeenCalled()
  })

  it("拒绝分析其他用户目录下的对象", async () => {
    await expect(
      service.analyze(7, {
        objectKey: "listing-documents/8/550e8400-e29b-41d4-a716-446655440000.pdf",
        fileName: "manual.pdf",
        mimeType: "application/pdf",
        fileSize: 1024,
        model: "ZQ-Think-Flash",
      })
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(getObjectMetadata).not.toHaveBeenCalled()
  })

  it.each(["xlsx", "xlsm"] as const)("从私有对象下载 %s、提取事实并清理临时文件", async extension => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Product", "Mouse"],
        ["DPI", "1600"],
      ]),
      "Specs"
    )
    const fileBuffer = XLSX.write(workbook, { type: "buffer", bookType: extension }) as Buffer
    const objectKey = `listing-documents/7/550e8400-e29b-41d4-a716-446655440000.${extension}`
    const mimeType = extension === "xlsm" ? "application/vnd.ms-excel.sheet.macroEnabled.12" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    getObjectMetadata.mockResolvedValue({
      contentLength: fileBuffer.length,
      contentType: mimeType,
    })
    downloadBuffer.mockResolvedValue(fileBuffer)
    generateJson.mockResolvedValue({
      data: {
        productName: "Mouse",
        features: ["1600 DPI"],
        sellingPoints: ["Precise tracking"],
        warnings: [],
      },
      tokenUsage: {
        promptTokens: 10,
        completionTokens: 5,
        thinkingTokens: 0,
      },
    })

    const result = await service.analyze(7, {
      objectKey,
      fileName: `specs.${extension}`,
      mimeType,
      fileSize: fileBuffer.length,
      model: "ZQ-Think-Pro",
    })

    expect(result.filename).toBe(`specs.${extension}`)
    expect(result.facts).toEqual(expect.objectContaining({ productName: "Mouse" }))
    expect(generateJson).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Product,Mouse"),
      expect.objectContaining({
        model: "ZQ-Think-Pro",
      })
    )
    expect(deleteObject).toHaveBeenCalledWith(objectKey)
  })

  it.each(["qwen3.8-max", "MiniMax-M3"])("扫描 PDF 转为页图后使用所选模型 %s", async model => {
    const buffer = Buffer.from("%PDF-1.4 synthetic")
    const objectKey = "listing-documents/7/550e8400-e29b-41d4-a716-446655440000.pdf"
    getObjectMetadata.mockResolvedValue({ contentLength: buffer.length, contentType: "application/pdf" })
    downloadBuffer.mockResolvedValue(buffer)
    const internals = service as unknown as {
      _parseDocument(buffer: Buffer, extension: string): Promise<{ content: string; pageCount: number; warnings: string[] }>
      _renderPdfPages(buffer: Buffer): Promise<string[]>
    }
    jest.spyOn(internals, "_parseDocument").mockResolvedValue({ content: "", pageCount: 1, warnings: [] })
    const pages = jest.spyOn(internals, "_renderPdfPages").mockResolvedValue(["data:image/png;base64,cGFnZQ=="])
    generateJson.mockResolvedValue({ data: { features: [], sellingPoints: [], warnings: [] }, tokenUsage: { promptTokens: 1, completionTokens: 1, thinkingTokens: 0 } })
    await service.analyze(7, { objectKey, fileName: "test.pdf", mimeType: "application/pdf", fileSize: buffer.length, model })
    expect(pages).toHaveBeenCalledWith(buffer)
    expect(generateJson).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ model, userContent: expect.arrayContaining([{ type: "image_url", image_url: { url: "data:image/png;base64,cGFnZQ==" } }]) }))
    expect(generateSignedDownloadUrl).not.toHaveBeenCalled()
    expect(deleteObject).toHaveBeenCalledWith(objectKey)
  })

  it("拒绝创建图片上传凭证", async () => {
    await expect(
      service.createUploadTicket(7, {
        fileName: "mouse.webp",
        mimeType: "image/webp",
        fileSize: 1024,
      })
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(generateUploadUrl).not.toHaveBeenCalled()
  })
})
