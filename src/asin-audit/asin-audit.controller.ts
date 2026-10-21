import {
  BadRequestException,
  Body,
  Controller,
  Header,
  Post,
  Request,
  Res,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { AsinAuditModels } from "./asin-audit.models"
import { AuditOptimizeService } from "./audit-optimize.service"
import { AuditScoreService } from "./audit-score.service"
import { OptimizeRequestDto } from "./dto/optimize.dto"
import { ReviewPainPointsDto } from "./dto/review-pain-points.dto"
import { ScoreRequestDto } from "./dto/score.dto"
import { ReviewPainPointsService } from "./review-pain-points.service"

interface AuthedRequest {
  user: { id: number }
}

const SSE_HEARTBEAT_INTERVAL_MS = 15_000

@ApiTags("ASIN 审计")
@ApiBearerAuth()
@Controller("asin-audit")
@UseGuards(JwtAuthGuard)
export class AsinAuditController {
  constructor(
    private readonly models: AsinAuditModels,
    private readonly painPointsService: ReviewPainPointsService,
    private readonly scoreService: AuditScoreService,
    private readonly optimizeService: AuditOptimizeService
  ) {}

  /**
   * 评论痛点：非流式模型调用——先跑完整链路（清洗/模型/解析/计费），全部成功后才开 SSE；
   * 开流前错误走全局过滤器返回 HTTP 状态码（与 Web route 契约一致）。
   */
  @Post("review-pain-points")
  @ApiProduces("text/event-stream")
  @Header("X-Accel-Buffering", "no")
  @ApiOperation({ summary: "评论 Top 5 痛点（非流式模型调用，SSE 返回 usage/result/[DONE]）" })
  async reviewPainPoints(
    @Request() request: AuthedRequest,
    @Body() dto: ReviewPainPointsDto,
    @Res() response: Response
  ): Promise<void> {
    await this.models.assertEnabled(dto.model)
    const outcome = await this.painPointsService.run(dto, request.user.id)

    response.status(200)
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8")
    response.setHeader("Cache-Control", "no-cache, no-transform")
    response.setHeader("Connection", "keep-alive")
    response.flushHeaders()

    if (outcome.tokenUsage) {
      this._writeSse(response, { type: "usage", usage: outcome.tokenUsage })
    }
    this._writeSse(response, {
      type: "result",
      data: outcome.painPoints,
      billingHandled: outcome.billingHandled,
      requestId: outcome.requestId,
    })
    response.write("data: [DONE]\n\n")
    response.end()
  }

  /** 审计打分：开流前校验（400）→ 先发中文占位 thinking → 流式透传 → usage → result → [DONE] */
  @Post("score")
  @ApiProduces("text/event-stream")
  @Header("X-Accel-Buffering", "no")
  @ApiOperation({ summary: "审计打分（流式：thinking/text/usage/result/[DONE]）" })
  async score(
    @Request() request: AuthedRequest,
    @Body() dto: ScoreRequestDto,
    @Res() response: Response
  ): Promise<void> {
    await this.models.assertEnabled(dto.model)
    this.assertEvidenceAsin(dto.evidence)

    await this.openStream(response, () => this.scoreService.stream(dto, request.user.id), {
      initialThinking: "正在分析审计证据…",
      requestId: dto.clientRequestId ?? null,
    })
  }

  /** 优化交付物：开流前校验（evidence.asin + score 必填）→ 流式透传 → usage → result → [DONE] */
  @Post("optimize")
  @ApiProduces("text/event-stream")
  @Header("X-Accel-Buffering", "no")
  @ApiOperation({ summary: "优化交付物（流式：thinking/text/usage/result/[DONE]）" })
  async optimize(
    @Request() request: AuthedRequest,
    @Body() dto: OptimizeRequestDto,
    @Res() response: Response
  ): Promise<void> {
    await this.models.assertEnabled(dto.model)
    this.assertEvidenceAsin(dto.evidence)
    if (!dto.score || typeof dto.score !== "object" || Array.isArray(dto.score)) {
      throw new BadRequestException("score 必填（需先完成 Step2 打分）")
    }

    await this.openStream(response, () => this.optimizeService.stream(dto, request.user.id), {
      requestId: dto.clientRequestId ?? null,
    })
  }

  private assertEvidenceAsin(evidence: Record<string, unknown>): void {
    const asin = evidence?.asin
    if (typeof asin !== "string" || !asin.trim()) {
      throw new BadRequestException("evidence 必填（需先完成 Step1 取证）")
    }
  }

  /** 流式端点骨架：开流 → 心跳 → 透传事件 → [DONE]；开流后错误发 error 事件终止（不发 result/[DONE]） */
  private async openStream(
    response: Response,
    events: () => AsyncGenerator<object>,
    options: { initialThinking?: string; requestId: string | null }
  ): Promise<void> {
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
      if (options.initialThinking) {
        this._writeSse(response, { type: "thinking", content: options.initialThinking })
      }
      for await (const event of events()) {
        this._writeSse(response, event)
      }
      response.write("data: [DONE]\n\n")
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "ASIN 审计调用失败"
      const code =
        error && typeof error === "object" && "response" in error
          ? (error.response as { code?: string } | undefined)?.code
          : undefined
      this._writeSse(response, {
        type: "error",
        message,
        ...(code ? { code } : {}),
        requestId: options.requestId,
      })
    } finally {
      clearInterval(heartbeatTimer)
      response.end()
    }
  }

  private _writeSse(response: Response, event: object): void {
    response.write(`data: ${JSON.stringify(event)}\n\n`)
  }
}
