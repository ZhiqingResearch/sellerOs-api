import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common"
import { InvokeType, OpenApiApp, Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { createHash } from "crypto"
import { PrismaService } from "../prisma/prisma.service"
import { SkillsKeysService } from "../skills-keys/skills-keys.service"
import { FeatureRegistryService } from "../usage/feature-registry.service"
import { ChargeModelResult, UsageService } from "../usage/usage.service"
import { isKeybCostCny, KeybDeductDto } from "./dto/keyb-deduct.dto"

const LOG_SELECT = {
  userId: true,
  cost: true,
  credits: true,
  balanceAfter: true,
  source: true,
  meta: true,
} satisfies Prisma.UsageLogSelect

type StoredCharge = Prisma.UsageLogGetPayload<{ select: typeof LOG_SELECT }>
type KeybIdentity = Awaited<ReturnType<SkillsKeysService["resolveForDeduction"]>>

interface ChargeIdentity {
  version: 1
  appId: string
  projectCode: string
  externalProjectId: string
  userId: number
  requestId: string
  costCny: string
  source: string
  model: string
  fingerprint: string
}

function hashTuple(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

/** 不包含 KeyB / 凭证轮换版本：正常重试不因换 Key 而产生第二笔扣费。 */
export function keybInternalRequestId(
  appId: string,
  projectCode: string,
  requestId: string
): string {
  return `kb:${hashTuple([appId, projectCode, requestId]).slice(0, 60)}`
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 接入适配层：识别人、校验载荷与历史归属；扣费事务完全交给既有 chargeModel。 */
@Injectable()
export class KeybCreditService {
  private readonly logger = new Logger(KeybCreditService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly keys: SkillsKeysService,
    private readonly features: FeatureRegistryService
  ) {}

  async deduct(app: OpenApiApp, keyB: string, dto: KeybDeductDto): Promise<ChargeModelResult> {
    try {
      const cost = this.validateParameters(dto, keyB)
      const identity = await this.keys.resolveForDeduction(keyB, app.appId)
      const charge = this.chargeIdentity(app.appId, identity, dto, cost)
      const internalRequestId = keybInternalRequestId(
        app.appId,
        identity.projectCode,
        dto.requestId
      )
      const existing = await this.findCharge(internalRequestId)
      if (existing) return this.replay(existing, charge)

      // 已成功的同编号重试不受后来下调的限额影响；新消费沿用既有接入方配置。
      if (app.perCallMaxCny != null && cost.gt(app.perCallMaxCny)) {
        throw new BadRequestException({
          code: "KEYB_PER_CALL_LIMIT",
          message: `超过单笔扣费上限（${app.perCallMaxCny.toString()} 元）`,
        })
      }

      // 仅记录首次展示标签快照；source 的是否可用仍由 chargeModel 的注册表校验负责。
      await this.features.ensureFresh()
      const feature = this.features.get(dto.source)
      const result = await this.usage.chargeModel(identity.userId, cost, {
        source: dto.source,
        model: dto.model,
        requestId: internalRequestId,
        invokeType: InvokeType.API,
        meta: {
          ...(dto.meta ?? {}),
          appId: app.appId,
          keybCharge: {
            ...charge,
            sourceLabel: feature?.label ?? dto.source,
            moduleLabel: feature?.moduleLabel ?? null,
          },
        },
      })
      if (result.duplicate) {
        // 并发赢家可能使用另一用户或载荷，不能信任内核 duplicate 中回显的本次参数。
        const committed = await this.findCharge(internalRequestId)
        if (!committed) throw this.unavailable()
        return this.replay(committed, charge)
      }
      return { ...result, requestId: dto.requestId }
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error
      // Prisma 异常可能包含调用参数；禁止将原异常传给全局日志/响应。
      this.logger.error("KeyB 扣费暂不可用，请使用原消费编号核查后重试")
      throw this.unavailable()
    }
  }

  private validateParameters(dto: KeybDeductDto, keyB: string): Decimal {
    if (!isKeybCostCny(dto.costCny)) this.invalidParameters()
    for (const [value, max] of [
      [dto.source, 50],
      [dto.model, 100],
      [dto.requestId, 128],
    ] as const) {
      if (!this.safeText(value, max, keyB)) this.invalidParameters()
    }
    if (dto.meta !== undefined) {
      const meta = objectValue(dto.meta)
      if (!meta) this.invalidParameters()
      for (const [name, value] of Object.entries(meta)) {
        if (!["taskId", "gatewayTaskId", "channel"].includes(name)) this.invalidParameters()
        if (name !== "channel" && typeof value === "number") {
          if (!Number.isSafeInteger(value) || value < 0) this.invalidParameters()
        } else if (!this.safeText(value, name === "channel" ? 32 : 128, keyB)) {
          this.invalidParameters()
        }
      }
    }
    return new Decimal(dto.costCny)
  }

  private safeText(value: unknown, max: number, keyB: string): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= max &&
      value.trim() === value &&
      !/\p{Cc}/u.test(value) &&
      !/(?:zk-|sk_|bearer\s)/i.test(value) &&
      (!keyB || !value.includes(keyB))
    )
  }

  private chargeIdentity(
    appId: string,
    identity: KeybIdentity,
    dto: KeybDeductDto,
    cost: Decimal
  ): ChargeIdentity {
    const charge = {
      version: 1 as const,
      appId,
      projectCode: identity.projectCode,
      externalProjectId: identity.externalProjectId,
      userId: identity.userId,
      requestId: dto.requestId,
      costCny: cost.toFixed(),
      source: dto.source,
      model: dto.model,
    }
    return { ...charge, fingerprint: hashTuple(Object.values(charge)) }
  }

  private findCharge(requestId: string) {
    return this.prisma.usageLog.findUnique({ where: { requestId }, select: LOG_SELECT })
  }

  private replay(row: StoredCharge, expected: ChargeIdentity): ChargeModelResult {
    const meta = objectValue(row.meta)
    const stored = objectValue(meta?.keybCharge)
    if (
      !stored ||
      Object.entries(expected).some(([name, value]) => stored[name] !== value) ||
      row.userId !== expected.userId ||
      !row.cost.eq(expected.costCny) ||
      row.source !== expected.source ||
      meta?.model !== expected.model ||
      row.credits === null ||
      typeof stored.sourceLabel !== "string" ||
      !(typeof stored.moduleLabel === "string" || stored.moduleLabel === null) ||
      !(typeof meta?.module === "string" || meta?.module === null)
    ) {
      throw new ConflictException({
        code: "KEYB_REQUEST_CONFLICT",
        message: "该消费编号已用于其他用户或不同扣费参数，请核查原消费记录",
      })
    }
    return {
      costCny: row.cost,
      creditsCharged: row.credits,
      balance: row.balanceAfter,
      breakdown: [],
      source: row.source,
      sourceLabel: stored.sourceLabel,
      module: meta.module,
      moduleLabel: stored.moduleLabel,
      model: meta.model,
      requestId: expected.requestId,
      duplicate: true,
    }
  }

  private invalidParameters(): never {
    throw new BadRequestException({
      code: "KEYB_INVALID_PARAMETERS",
      message: "扣费参数不正确，辅助信息仅支持 taskId、gatewayTaskId、channel，且不得包含敏感凭证",
    })
  }

  private unavailable() {
    return new ServiceUnavailableException({
      code: "KEYB_CHARGE_UNAVAILABLE",
      message: "扣费结果暂无法确认，请保留原消费编号核查后重试",
    })
  }
}
