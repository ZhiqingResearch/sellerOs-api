import { DomesticBusinessGateway } from "./domestic-business-gateway"
import { Inject, BadGatewayException, ConflictException, Injectable, Logger } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { createHash } from "node:crypto"
import { PrismaService } from "../../prisma/prisma.service"
import { UsageService } from "../../usage/usage.service"
import {
  AiGatewayProvider,
  type AiGatewayBillingUsage,
  type AiGatewayTokenUsage,
} from "../providers/ai-gateway.provider"
import { BusinessAiDto } from "./business-ai.dto"

export type BusinessAiSource = "launch.plan" | "pricing.quote"

interface BusinessAiBillingSnapshot {
  billing: AiGatewayBillingUsage
  tokenUsage?: AiGatewayTokenUsage
}

const BUSINESS_AI_TRANSACTION_MAX_WAIT_MS = 10_000
const BUSINESS_AI_TRANSACTION_TIMEOUT_MS = 60_000

@Injectable()
export class BusinessAiService {
  private readonly logger = new Logger(BusinessAiService.name)

  constructor(
    @Inject(DomesticBusinessGateway) private readonly aiGatewayProvider: AiGatewayProvider,
    private readonly usageService: UsageService,
    private readonly prisma: PrismaService
  ) {}

  async complete(userId: number, source: BusinessAiSource, dto: BusinessAiDto) {
    const replayText = await this._prepareRun(userId, source, dto)
    if (replayText !== null) return { text: replayText, billingHandled: true }

    try {
      if (dto.responseFormat === "json_object") {
        const result = await this.aiGatewayProvider.generateJson<Record<string, unknown>>(
          dto.systemPrompt ?? "",
          dto.userPrompt,
          {
            model: dto.model,
            temperature: dto.temperature,
            resolveBilling: true,
            operationName: `${source} ${dto.operation}`,
          }
        )
        const outputText = JSON.stringify(result.data)
        await this._settleOutput(userId, source, dto, outputText, result.billing, result.tokenUsage)
        return { text: outputText, billingHandled: true }
      }

      let outputText = ""
      for await (const event of this.stream(userId, source, dto, true)) {
        if (event.type === "text") outputText += event.content
      }
      return { text: outputText, billingHandled: true }
    } catch (error) {
      await this._markRunFailed(userId, source, dto, error)
      throw error
    }
  }

  async *stream(userId: number, source: BusinessAiSource, dto: BusinessAiDto, isPrepared = false) {
    if (!isPrepared) {
      const replayText = await this._prepareRun(userId, source, dto)
      if (replayText !== null) {
        yield { type: "text" as const, content: replayText }
        return
      }
    }

    let tokenUsage: AiGatewayTokenUsage | undefined
    let billing: AiGatewayBillingUsage | undefined
    let outputText = ""
    try {
      for await (const event of this.aiGatewayProvider.streamChat(
        dto.systemPrompt ?? "",
        dto.userPrompt,
        {
          model: dto.model,
          temperature: dto.temperature,
          resolveBilling: true,
          operationName: `${source} ${dto.operation}`,
        }
      )) {
        if (event.type === "usage") {
          tokenUsage = event.usage
          continue
        }
        if (event.type === "billing") {
          billing = event.billing
          continue
        }
        if (event.type === "text") outputText += event.content
        yield event
      }
      await this._settleOutput(userId, source, dto, outputText, billing, tokenUsage)
    } catch (error) {
      await this._markRunFailed(userId, source, dto, error)
      throw error
    }
  }

  async findRun(userId: number, runId: string) {
    return this.prisma.businessAiRun.findFirst({
      where: { userId, runId },
      orderBy: { createdAt: "desc" },
      select: {
        runId: true,
        module: true,
        operation: true,
        model: true,
        status: true,
        outputText: true,
        error: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  }

  private async _prepareRun(
    userId: number,
    source: BusinessAiSource,
    dto: BusinessAiDto
  ): Promise<string | null> {
    if (!dto.runId) {
      await this.usageService.assertFixedModuleAffordable(userId, source)
      return null
    }
    const module = this._moduleFromSource(source)
    const inputHash = this._inputHash(dto)
    const where = {
      userId_module_operation_runId: {
        userId,
        module,
        operation: dto.operation,
        runId: dto.runId,
      },
    }
    const existing = await this.prisma.businessAiRun.findUnique({ where })
    if (existing) return this._resolveExistingRun(existing, userId, source, dto, inputHash)

    await this.usageService.assertFixedModuleAffordable(userId, source)
    try {
      await this.prisma.businessAiRun.create({
        data: {
          userId,
          runId: dto.runId,
          module,
          operation: dto.operation,
          model: dto.model,
          inputHash,
        },
      })
      return null
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error
      }
      const conflict = await this.prisma.businessAiRun.findUnique({ where })
      if (!conflict) throw error
      return this._resolveExistingRun(conflict, userId, source, dto, inputHash)
    }
  }

  private async _resolveExistingRun(
    run: {
      id: number
      inputHash: string
      status: string
      outputText: string | null
      billing: Prisma.JsonValue | null
    },
    userId: number,
    source: BusinessAiSource,
    dto: BusinessAiDto,
    inputHash: string
  ): Promise<string | null> {
    if (run.inputHash !== inputHash) throw new ConflictException("运行号已被其他输入使用")
    if (run.outputText && run.billing && run.status !== "COMPLETED") {
      await this._finalizeStoredRun(run.id, source, dto, run.billing)
      return run.outputText
    }
    if (run.status === "COMPLETED" && run.outputText !== null) return run.outputText
    if (run.status === "RUNNING")
      throw new ConflictException("本次 AI 分析仍在执行，请稍后读取结果")

    await this.usageService.assertFixedModuleAffordable(userId, source)
    const claimed = await this.prisma.businessAiRun.updateMany({
      where: { id: run.id, status: "FAILED", outputText: null },
      data: { status: "RUNNING", error: null },
    })
    if (claimed.count === 0) throw new ConflictException("本次 AI 分析正在恢复，请稍后读取结果")
    return null
  }

  private async _settleOutput(
    userId: number,
    source: BusinessAiSource,
    dto: BusinessAiDto,
    outputText: string,
    billing: AiGatewayBillingUsage | undefined,
    tokenUsage?: AiGatewayTokenUsage
  ): Promise<void> {
    if (!outputText.trim()) throw new BadGatewayException("模型未返回正文，本次未扣积分")
    if (!billing) throw new BadGatewayException("AI 中转站未返回计费结果")
    if (!dto.runId) {
      return
    }

    const module = this._moduleFromSource(source)
    const run = await this.prisma.businessAiRun.findUnique({
      where: {
        userId_module_operation_runId: {
          userId,
          module,
          operation: dto.operation,
          runId: dto.runId,
        },
      },
      select: { id: true },
    })
    if (!run) throw new BadGatewayException("AI 运行记录不存在")
    const billingSnapshot: BusinessAiBillingSnapshot = {
      billing,
      ...(tokenUsage ? { tokenUsage } : {}),
    }
    await this.prisma.businessAiRun.update({
      where: { id: run.id },
      data: {
        status: "READY",
        requestId: billing.requestId,
        outputText,
        billing: billingSnapshot as unknown as Prisma.InputJsonValue,
        error: null,
      },
    })
    await this._finalizeStoredRun(
      run.id,
      source,
      dto,
      billingSnapshot as unknown as Prisma.JsonValue
    )
  }

  private async _finalizeStoredRun(
    runId: number,
    source: BusinessAiSource,
    dto: BusinessAiDto,
    value: Prisma.JsonValue
  ): Promise<void> {
    const snapshot = value as unknown as BusinessAiBillingSnapshot
    const billing = snapshot.billing
    if (!billing?.requestId || !billing.model) throw new BadGatewayException("AI 账单快照不完整")
    // AI 产出仅落存；最终业务结果经校验归档后再按模块固定扣费。
    await this.prisma.$transaction(
      async tx => {
        const usageLogId = null
        await tx.businessAiRun.update({
          where: { id: runId },
          data: { status: "COMPLETED", usageLogId, error: null },
        })
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: BUSINESS_AI_TRANSACTION_MAX_WAIT_MS,
        timeout: BUSINESS_AI_TRANSACTION_TIMEOUT_MS,
      }
    )
    this.logger.debug(
      `AI 运行完成 source=${source} operation=${dto.operation} requestId=${billing.requestId}`
    )
  }

  private async _markRunFailed(
    userId: number,
    source: BusinessAiSource,
    dto: BusinessAiDto,
    error: unknown
  ): Promise<void> {
    if (!dto.runId) return
    await this.prisma.businessAiRun
      .updateMany({
        where: {
          userId,
          module: this._moduleFromSource(source),
          operation: dto.operation,
          runId: dto.runId,
          status: "RUNNING",
        },
        data: {
          status: "FAILED",
          error: (error instanceof Error ? error.message : "AI 分析失败").slice(0, 1000),
        },
      })
      .catch(markError => {
        this.logger.error(
          `AI 运行失败状态保存异常: ${markError instanceof Error ? markError.message : markError}`
        )
      })
  }

  private _moduleFromSource(source: BusinessAiSource): string {
    return source === "launch.plan" ? "promotion-plan" : "smart-pricing"
  }

  private _inputHash(dto: BusinessAiDto): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          systemPrompt: dto.systemPrompt ?? "",
          userPrompt: dto.userPrompt,
          model: dto.model,
          temperature: dto.temperature ?? null,
          responseFormat: dto.responseFormat ?? "text",
        })
      )
      .digest("hex")
  }
}
