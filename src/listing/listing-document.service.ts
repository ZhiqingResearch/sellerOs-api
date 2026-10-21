import { DomesticBusinessGateway } from "../common/business-ai/domestic-business-gateway"
import { Inject, BadRequestException, Injectable, Logger } from "@nestjs/common"
import { randomUUID } from "crypto"
import * as path from "path"
import * as XLSX from "xlsx"
import {
  AiGatewayProvider,
  type AiGatewayJsonResult,
} from "../common/providers/ai-gateway.provider"
import { SpacesService } from "../spaces/spaces.service"
import {
  AnalyzeListingDocumentDto,
  CreateListingDocumentUploadDto,
} from "./dto/listing-document.dto"
import { MAX_LISTING_DOCUMENT_BYTES } from "./listing-document.constants"
import { LISTING_DOCUMENT_SYSTEM_PROMPT } from "./listing.prompts"
import type { ListingDocumentFacts } from "./listing.types"

const MAX_EXTRACTED_CHARACTERS = 200_000
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".xlsm"])
const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
}

interface ParsedDocument {
  content: string
  pageCount: number
  warnings: string[]
}

interface DocumentMetadata {
  fileName: string
  mimeType?: string
  fileSize: number
}

@Injectable()
export class ListingDocumentService {
  private readonly logger = new Logger(ListingDocumentService.name)

  constructor(
    private readonly spacesService: SpacesService,
    @Inject(DomesticBusinessGateway) private readonly aiGatewayProvider: AiGatewayProvider
  ) {}

  async createUploadTicket(userId: number, dto: CreateListingDocumentUploadDto) {
    const extension = this._validateDocumentMetadata(dto)
    const mimeType = MIME_BY_EXTENSION[extension]
    const objectKey = `listing-documents/${userId}/${randomUUID()}${extension}`
    const ticket = await this.spacesService.generateUploadUrl({
      key: objectKey,
      contentType: mimeType,
      contentLength: dto.fileSize,
      expiresIn: 600,
      acl: "private",
    })

    return {
      objectKey: ticket.key,
      uploadUrl: ticket.uploadUrl,
      headers: ticket.headers,
      expiresIn: ticket.expiresIn,
    }
  }

  async analyze(userId: number, dto: AnalyzeListingDocumentDto) {
    const extension = this._validateDocumentMetadata(dto)
    this._validateObjectOwnership(userId, dto.objectKey, extension)

    try {
      const metadata = await this.spacesService.getObjectMetadata(dto.objectKey)
      if (metadata.contentLength <= 0) throw new BadRequestException("文件尚未上传完成")
      if (metadata.contentLength > MAX_LISTING_DOCUMENT_BYTES) {
        throw new BadRequestException("云端文件超过 200MB 限制")
      }
      if (metadata.contentLength !== dto.fileSize) {
        throw new BadRequestException("云端文件大小与上传申请不一致")
      }
      const contentType = metadata.contentType?.split(";")[0].trim()
      if (contentType && contentType !== dto.mimeType) {
        throw new BadRequestException("云端文件 MIME 类型与上传申请不一致")
      }

      const safeFileName = path.basename(dto.fileName)
      const buffer = await this.spacesService.downloadBuffer(dto.objectKey)
      this._validateMagicBytes(buffer, extension)
      const parsed = await this._parseDocument(buffer, extension)

      const shouldAnalyzePageImages = extension === ".pdf" && !parsed.content.trim()
      if (!parsed.content.trim() && !shouldAnalyzePageImages) {
        throw new BadRequestException("文档未提取到可读文字")
      }

      const promptParts = [
        dto.documentPrompt?.trim() ? `用户补充要求：${dto.documentPrompt.trim()}` : "",
        `文件名：${safeFileName}`,
        shouldAnalyzePageImages
          ? "请读取下方 PDF 页面图片中的内容并提取商品事实。"
          : "以下是后端解析的文档正文：",
        parsed.content,
      ].filter(Boolean)
      const pageImages = shouldAnalyzePageImages ? await this._renderPdfPages(buffer) : []
      const aiResult: AiGatewayJsonResult<ListingDocumentFacts> =
        await this.aiGatewayProvider.generateJson<ListingDocumentFacts>(
          LISTING_DOCUMENT_SYSTEM_PROMPT,
          promptParts.join("\n\n"),
          {
            model: dto.model,
            operationName: "Listing 文件提取",
            temperature: 0,
            maxOutputTokens: 4_000,
            userContent: pageImages.length
              ? [
                  { type: "text", text: promptParts.join("\n\n") },
                  ...pageImages.map(url => ({ type: "image_url", image_url: { url } })),
                ]
              : undefined,
            isDataValid: data => this._isDocumentFactsValid(data),
          }
        )

      return {
        filename: safeFileName,
        content: JSON.stringify(aiResult.data, null, 2),
        facts: aiResult.data,
        warnings: [
          ...parsed.warnings,
          ...(shouldAnalyzePageImages
            ? [`扫描版 PDF 已转换为页面图片，交给 ${dto.model} 分析`]
            : []),
        ],
        usage: {
          ...aiResult.tokenUsage,
          totalTokens:
            aiResult.tokenUsage.promptTokens +
            aiResult.tokenUsage.completionTokens +
            aiResult.tokenUsage.thinkingTokens,
        },
      }
    } finally {
      await this._deleteTemporaryObject(dto.objectKey)
    }
  }

  private _validateDocumentMetadata(dto: DocumentMetadata): string {
    if (path.basename(dto.fileName) !== dto.fileName) {
      throw new BadRequestException("文件名无效")
    }
    const extension = path.extname(dto.fileName).toLowerCase()
    if (!DOCUMENT_EXTENSIONS.has(extension)) {
      throw new BadRequestException("仅支持 PDF、DOCX、XLSX、XLSM 文件")
    }
    if (dto.fileSize <= 0 || dto.fileSize > MAX_LISTING_DOCUMENT_BYTES) {
      throw new BadRequestException("文档不能超过 200MB")
    }
    const expectedMimeType = MIME_BY_EXTENSION[extension]
    if (dto.mimeType?.trim() && dto.mimeType.trim() !== expectedMimeType) {
      throw new BadRequestException("文件扩展名与 MIME 类型不匹配")
    }
    return extension
  }

  private _validateObjectOwnership(userId: number, objectKey: string, extension: string): void {
    const escapedExtension = extension.replace(".", "\\.")
    const objectKeyPattern = new RegExp(
      `^listing-documents/${userId}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}${escapedExtension}$`
    )
    if (!objectKeyPattern.test(objectKey)) {
      throw new BadRequestException("无权访问该 Listing 文档")
    }
  }

  private async _deleteTemporaryObject(objectKey: string): Promise<void> {
    try {
      await this.spacesService.deleteObject(objectKey)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(`Listing 临时文档清理失败 key=${objectKey} message=${message}`)
    }
  }

  private _validateMagicBytes(buffer: Buffer, extension: string): void {
    if (extension === ".pdf" && buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new BadRequestException("文件内容不是有效 PDF")
    }
    if (
      [".docx", ".xlsx", ".xlsm"].includes(extension) &&
      buffer.subarray(0, 2).toString("ascii") !== "PK"
    ) {
      throw new BadRequestException("Office 文件内容无效")
    }
  }

  private async _renderPdfPages(buffer: Buffer): Promise<string[]> {
    const { PDFParse } = await import("pdf-parse")
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getScreenshot({ desiredWidth: 1600, imageDataUrl: true, imageBuffer: false })
      const pages = result.pages.map(page => page.dataUrl)
      if (!pages.length || pages.some(page => !page)) throw new BadRequestException("PDF 页面无法解析")
      return pages
    } finally {
      await parser.destroy()
    }
  }

  private async _parseDocument(buffer: Buffer, extension: string): Promise<ParsedDocument> {
    if (extension === ".docx") {
      const mammoth = await import("mammoth")
      const result = await mammoth.extractRawText({ buffer })
      return this._normalizeParsedDocument(
        result.value,
        0,
        result.messages.map(item => item.message)
      )
    }
    if (extension === ".xlsx" || extension === ".xlsm") {
      // 只读取工作表数据，不提取 VBA，也不执行宏。
      const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, bookVBA: false })
      const sheetNames = workbook.SheetNames.slice(0, 20)
      const contents = sheetNames.map(sheetName => {
        const sheet = workbook.Sheets[sheetName]
        return `## ${sheetName}\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}`
      })
      const warnings = workbook.SheetNames.length > 20 ? ["工作表超过 20 个，仅解析前 20 个"] : []
      return this._normalizeParsedDocument(contents.join("\n\n"), 0, warnings)
    }

    const { PDFParse } = await import("pdf-parse")
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getText({ pageJoiner: "" })
      return this._normalizeParsedDocument(result.text, result.total, [])
    } finally {
      await parser.destroy()
    }
  }

  private _normalizeParsedDocument(
    rawContent: string,
    pageCount: number,
    initialWarnings: string[]
  ): ParsedDocument {
    const normalizedContent = rawContent
      .split("\u0000")
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim()
    const isTruncated = normalizedContent.length > MAX_EXTRACTED_CHARACTERS
    return {
      content: normalizedContent.slice(0, MAX_EXTRACTED_CHARACTERS),
      pageCount,
      warnings: [
        ...initialWarnings.filter(Boolean),
        ...(isTruncated ? [`文档超过 ${MAX_EXTRACTED_CHARACTERS} 字符，已截断`] : []),
      ],
    }
  }

  private _isDocumentFactsValid(data: ListingDocumentFacts): boolean {
    return (
      !!data &&
      typeof data === "object" &&
      Array.isArray(data.features) &&
      Array.isArray(data.sellingPoints) &&
      Array.isArray(data.warnings)
    )
  }
}
