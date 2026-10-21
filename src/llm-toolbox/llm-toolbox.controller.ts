// LLM 工具箱三件套入口。响应体/状态码/错误文案逐字段对齐前端 BFF 源路由
// （P0 契约冻结 §1.4/§4.1）：
//   POST /api/llm-toolbox/enhance-prompt  → {enhanced, tokenUsage?, billingHandled}
//   POST /api/llm-toolbox/translate-prompt → {translated, tokenUsage?, billingHandled}
//   POST /api/llm-toolbox/image-inference  → {visualDescription, structuredPrompt, raw, ...}
//   错误统一 HTTP 4xx/5xx + {"error": message}（勿改成 200 包络）。
// 注意：@Controller("toolbox") 已被 src/toolbox 占用，路由前缀用 llm-toolbox。

import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  HttpException,
  Post,
  Request,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common"
import { FileInterceptor } from "@nestjs/platform-express"
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { EnhancePromptDto, TranslatePromptDto } from "./dto/llm-toolbox.dto"
import { LlmToolboxService, UploadedImage } from "./llm-toolbox.service"

interface AuthedRequest {
  user: { id: number }
}

/** 本模块 service 层抛出的、文案已冻结的 400（不能被 multipart 兜底改写） */
const KNOWN_BAD_REQUEST_MESSAGES = new Set([
  "`prompt` is required",
  "Reference image (`image`) is required",
  "Failed to read reference image",
])

/**
 * 错误包络对齐前端源路由：{"error": message}（P0 §1.4），绕开全局
 * {statusCode, message, timestamp} 包络。multipart 解析失败的 400 改写为
 * 冻结文案 "Invalid multipart/form-data body"；超限 413 给出大小提示。
 */
@Catch()
export class ToolboxErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<Response>()
    const req = ctx.getRequest<{ headers?: Record<string, string | string[]> }>()

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      let message = this.extractMessage(exception)
      const contentType = String(req?.headers?.["content-type"] ?? "").toLowerCase()
      if (
        status === 400 &&
        contentType.includes("multipart/form-data") &&
        !KNOWN_BAD_REQUEST_MESSAGES.has(message)
      ) {
        message = "Invalid multipart/form-data body"
      }
      if (status === 413) {
        message = "图片大小超过 10MB 上限"
      }
      res.status(status).json({ error: message })
      return
    }

    const message = exception instanceof Error ? exception.message : "Internal Server Error"
    res.status(500).json({ error: message })
  }

  private extractMessage(exception: HttpException): string {
    const body = exception.getResponse()
    if (typeof body === "string") return body
    const message = (body as { message?: unknown }).message
    if (typeof message === "string") return message
    if (Array.isArray(message) && typeof message[0] === "string") return message[0]
    return exception.message
  }
}

@ApiTags("LLM 工具箱")
@ApiBearerAuth()
@Controller("llm-toolbox")
@UseGuards(JwtAuthGuard)
@UseFilters(ToolboxErrorFilter)
export class LlmToolboxController {
  constructor(private readonly service: LlmToolboxService) {}

  @Post("enhance-prompt")
  @ApiOperation({
    summary: "一键润色（一口价优先，未配置时按实际账单扣费，billingHandled=false 表示扣费降级）",
  })
  enhance(@Request() req: AuthedRequest, @Body() dto: EnhancePromptDto) {
    return this.service.enhance(req.user.id, dto)
  }

  @Post("translate-prompt")
  @ApiOperation({ summary: "中英互译（direction 缺省/拼错回落 zh-to-en）" })
  translate(@Request() req: AuthedRequest, @Body() dto: TranslatePromptDto) {
    return this.service.translate(req.user.id, dto)
  }

  @Post("image-inference")
  @ApiOperation({ summary: "由图推理（multipart image，≤10MB）" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["image"],
      properties: { image: { type: "string", format: "binary" } },
    },
  })
  @UseInterceptors(FileInterceptor("image", { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  imageInference(@Request() req: AuthedRequest, @UploadedFile() file: UploadedImage | undefined) {
    return this.service.imageInference(req.user.id, file)
  }
}
