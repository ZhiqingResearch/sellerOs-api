import { Body, Controller, Header, Post, Request, Res, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard"
import { AsinAuditModels } from "../asin-audit.models"
import { EvidenceRequestDto } from "../dto/evidence.dto"
import { ReviewDownloadDto } from "../dto/review-download.dto"
import { ReviewAnalysisService } from "../review-analysis.service"
import { EvidenceService } from "./evidence.service"

interface AuthedRequest {
  user: { id: number }
}

const SSE_HEARTBEAT_INTERVAL_MS = 15_000

/**
 * ASIN 审计取证（合成版）：一次 SSE 返回六卡（A/P/B 爬虫 + C/D/E SIF/MCP + B 卡 AI 痛点）。
 * 开流前错误（参数/白名单）→ HTTP 状态码；开流后失败（SIF 主请求）→ error 事件终止。
 */
@ApiTags("ASIN 审计")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("asin-audit")
export class AsinAuditEvidenceController {
  constructor(
    private readonly models: AsinAuditModels,
    private readonly evidenceService: EvidenceService,
    private readonly reviewAnalysisService: ReviewAnalysisService
  ) {}

  @Post("evidence")
  @ApiProduces("text/event-stream")
  @Header("X-Accel-Buffering", "no")
  @ApiOperation({ summary: "ASIN 审计取证（六卡合一：A/P/B 爬虫 + C/D/E SIF/MCP + B 卡痛点）" })
  async evidence(
    @Request() request: AuthedRequest,
    @Body() dto: EvidenceRequestDto,
    @Res() response: Response
  ): Promise<void> {
    await this.models.assertEnabled(dto.model)
    const resolved = this.evidenceService.resolve(dto)

    response.status(200)
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8")
    response.setHeader("Cache-Control", "no-cache, no-transform")
    response.setHeader("Connection", "keep-alive")
    response.flushHeaders()
    const heartbeatTimer = setInterval(() => {
      if (!response.writableEnded) response.write(": heartbeat\n\n")
    }, SSE_HEARTBEAT_INTERVAL_MS)
    heartbeatTimer.unref()

    try {
      await this.evidenceService.run(dto, resolved, request.user.id, ev =>
        this._writeSse(response, ev)
      )
      response.write("data: [DONE]\n\n")
    } catch (error: unknown) {
      const { message, code } = this.evidenceService.toErrorEvent(error)
      this._writeSse(response, {
        type: "error",
        message,
        ...(code !== undefined ? { code } : {}),
        requestId: dto.clientRequestId ?? null,
      })
    } finally {
      clearInterval(heartbeatTimer)
      response.end()
    }
  }

  @Post("reviews/download")
  @ApiProduces("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  @ApiOperation({
    summary: "下载原始评论（B 卡评论分析数据源 review.comment_list 导出 xlsx，纯读取不扣积分）",
  })
  async downloadReviews(@Body() dto: ReviewDownloadDto, @Res() response: Response): Promise<void> {
    const file = await this.reviewAnalysisService.downloadRawReviews(dto)
    response.status(200)
    response.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.asciiFilename}"; filename*=UTF-8''${encodeURIComponent(file.utf8Filename)}`
    )
    response.setHeader("Content-Length", String(file.buffer.length))
    response.end(file.buffer)
  }

  private _writeSse(response: Response, event: object): void {
    response.write(`data: ${JSON.stringify(event)}\n\n`)
  }
}
