import { DomesticBusinessModelGuard } from "../common/business-ai/domestic-business-model.guard"
import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  Res,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { HistoryService } from "../history/history.service"
import { ListingAiInvocationDto } from "./dto/listing-ai.dto"
import {
  AnalyzeListingDocumentDto,
  CreateListingDocumentUploadDto,
} from "./dto/listing-document.dto"
import {
  CreateListingGenerationDto,
  FinishListingGenerationDto,
} from "./dto/listing-generation.dto"
import { CreateListingRunDto, UpdateListingRunDto } from "./dto/listing-run.dto"
import { ListingAiPermissionGuard } from "./guards/listing-ai-permission.guard"
import { ListingModelSelectionGuard } from "./guards/listing-model-selection.guard"
import { ListingAiService } from "./listing-ai.service"
import { ListingDocumentService } from "./listing-document.service"
import { ListingGenerationService } from "./listing-generation.service"
import { ListingRunService } from "./listing-run.service"
import { ListingScoreService } from "./listing-score.service"

interface AuthedRequest {
  user: { id: number }
}

const SSE_HEARTBEAT_INTERVAL_MS = 15_000

@ApiTags("Listing 生成")
@ApiBearerAuth()
@Controller("listing")
@UseGuards(JwtAuthGuard, PermissionsGuard, ListingModelSelectionGuard, DomesticBusinessModelGuard)
export class ListingController {
  constructor(
    private readonly listingAiService: ListingAiService,
    private readonly listingDocumentService: ListingDocumentService,
    private readonly listingRunService: ListingRunService,
    private readonly historyService: HistoryService,
    private readonly generationService: ListingGenerationService,
    private readonly scoreService: ListingScoreService
  ) {}

  @Post("generations")
  @RequirePermissions("tool.listing_generate")
  @ApiOperation({ summary: "提交持久化生成任务，同一 attemptId 至多一次模型调用" })
  submitGeneration(@Request() request: AuthedRequest, @Body() dto: CreateListingGenerationDto) {
    return this.generationService.submit(request.user.id, dto)
  }

  @Get("runs/:runId/generations")
  @RequirePermissions("tool.listing_generate")
  @ApiOperation({ summary: "读取本人待处理的模型响应和规则上下文，不返回账单快照" })
  readGenerations(
    @Request() request: AuthedRequest,
    @Param("runId", new ParseUUIDPipe()) runId: string
  ) {
    return this.generationService.read(request.user.id, runId)
  }

  @Post("generations/:attemptId/result")
  @RequirePermissions("tool.listing_generate")
  @ApiOperation({ summary: "完整报告与主生成积分原子提交；部分输出留存但不扣主生成积分" })
  finishGeneration(
    @Request() request: AuthedRequest,
    @Param("attemptId", new ParseUUIDPipe()) attemptId: string,
    @Body() dto: FinishListingGenerationDto
  ) {
    return this.generationService.finish(request.user.id, attemptId, dto)
  }

  @Get("runs/:runId")
  @RequirePermissions("tool.listing_generate")
  @ApiOperation({ summary: "查询本人的生成状态、报告与分步积分，可用于断线恢复" })
  getRun(@Request() request: AuthedRequest, @Param("runId", new ParseUUIDPipe()) runId: string) {
    return this.historyService.findByRunId(runId, request.user.id)
  }

  @Post("runs")
  @RequirePermissions("tool.listing_generate")
  @ApiOperation({ summary: "生成前创建记录，同一 runId 幂等" })
  createRun(@Request() request: AuthedRequest, @Body() dto: CreateListingRunDto) {
    return this.listingRunService.create(request.user.id, dto)
  }

  @Patch("runs/:runId")
  @RequirePermissions("tool.listing_generate")
  @ApiOperation({ summary: "持久化生成终态与已校验报告，失败也保留记录" })
  updateRun(
    @Request() request: AuthedRequest,
    @Param("runId", new ParseUUIDPipe()) runId: string,
    @Body() dto: UpdateListingRunDto
  ) {
    return this.listingRunService.update(request.user.id, runId, dto)
  }

  @Post("ai/complete")
  @UseGuards(ListingAiPermissionGuard)
  @ApiOperation({ summary: "由后端 AI Gateway 执行 Listing 非流式模型调用" })
  completeAi(@Request() request: AuthedRequest, @Body() dto: ListingAiInvocationDto) {
    if (dto.operation === "score" && !dto.runId)
      return this.scoreService.complete(request.user.id, dto)
    return this.listingAiService.complete(request.user.id, dto)
  }

  @Get("score-runs/:requestId")
  @ApiOperation({ summary: "读取本人独立评分的已结算报告，不重新调用模型" })
  readScore(
    @Request() request: AuthedRequest,
    @Param("requestId", new ParseUUIDPipe()) requestId: string
  ) {
    return this.scoreService.read(request.user.id, requestId)
  }

  @Post("ai/stream")
  @UseGuards(ListingAiPermissionGuard)
  @ApiOperation({ summary: "由后端 AI Gateway 执行 Listing 流式模型调用" })
  @ApiProduces("text/event-stream")
  @Header("X-Accel-Buffering", "no")
  async streamAi(
    @Request() request: AuthedRequest,
    @Body() dto: ListingAiInvocationDto,
    @Res() response: Response
  ): Promise<void> {
    response.status(200)
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8")
    response.setHeader("Cache-Control", "no-cache, no-transform")
    response.setHeader("Connection", "keep-alive")
    response.flushHeaders()
    const heartbeatTimer = setInterval(() => {
      if (!response.writableEnded && !response.destroyed) response.write(": heartbeat\n\n")
    }, SSE_HEARTBEAT_INTERVAL_MS)
    heartbeatTimer.unref()

    try {
      const stream =
        dto.operation === "score" && !dto.runId
          ? this.scoreService.stream(request.user.id, dto)
          : this.listingAiService.stream(request.user.id, dto)
      for await (const event of stream) {
        this._writeSse(response, event)
      }
      if (!response.writableEnded && !response.destroyed) response.write("data: [DONE]\n\n")
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Listing AI 调用失败"
      this._writeSse(response, { type: "error", content: message })
    } finally {
      clearInterval(heartbeatTimer)
      response.end()
    }
  }

  @Post("documents/upload-ticket")
  @RequirePermissions("tool.listing_generate")
  @ApiOperation({ summary: "创建 Listing 私有文件直传凭证" })
  createDocumentUploadTicket(
    @Request() request: AuthedRequest,
    @Body() dto: CreateListingDocumentUploadDto
  ) {
    return this.listingDocumentService.createUploadTicket(request.user.id, dto)
  }

  @Post("documents/analyze")
  @RequirePermissions("tool.listing_generate")
  @ApiOperation({ summary: "解析文档或通过签名链接分析已直传的 Listing 图片" })
  analyzeDocument(@Request() request: AuthedRequest, @Body() dto: AnalyzeListingDocumentDto) {
    return this.listingDocumentService.analyze(request.user.id, dto)
  }

  private _writeSse(response: Response, event: object): void {
    if (response.writableEnded || response.destroyed) return
    response.write(`data: ${JSON.stringify(event)}\n\n`)
  }
}
