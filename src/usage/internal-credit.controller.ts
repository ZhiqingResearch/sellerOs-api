import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common"
import { ApiHeader, ApiOperation, ApiProperty, ApiTags } from "@nestjs/swagger"
import { IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength } from "class-validator"
import { WalletService } from "../membership/wallet.service"
import { PrismaService } from "../prisma/prisma.service"
import { InternalGenerationGuard } from "../video-project/internal-generation.guard"
import { InternalBalanceDto } from "./dto/internal-balance.dto"
import { UsageService } from "./usage.service"

/** 内部扣费入参：手机号映射用户 + 金额 + 模型标识 + 强制幂等键 */
export class InternalChargeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone!: string

  @ApiProperty({ description: "扣费金额（人民币元，字符串）", example: "0.001" })
  @IsString({ message: "扣费金额必须为字符串" })
  @Matches(/^\d+(\.\d+)?$/, { message: "扣费金额必须为数字字符串" })
  costCny!: string

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model!: string

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  requestId!: string

  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>
}

/**
 * 内部扣费接口（VidFlowOS 服务间调用，X-Internal-Token 鉴权，与内部生成接口同一 token）。
 * 复用统一扣费内核 chargeModel：FeatureModule 注册表校验 + UsageLog/积分流水双写 +
 * requestId 幂等（重复提交返回首次结果）+ 企业池/个人路由；透支扣（服务端固定，不暴露）。
 */
@ApiTags("内部扣费（VidFlowOS）")
@ApiHeader({
  name: "X-Internal-Token",
  required: true,
  description: "与视频转发接口相同的内部令牌",
})
@UseGuards(InternalGenerationGuard)
@Controller("internal/credits")
export class InternalCreditController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly wallet: WalletService
  ) {}

  @Get("balance")
  @ApiOperation({
    summary: "按手机号查询钱包（兼容个人与企业）",
    description:
      "返回 /membership/wallet 的完整字段及 userId，保留原额度字段兼容调用方：企业 totalQuota=team.monthlyQuota、remainingQuota=team.myAvailable；个人 totalQuota=null、remainingQuota=total。team.orgName 使用钱包默认组织回落规则",
  })
  async balance(@Query() dto: InternalBalanceDto) {
    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
      select: { id: true },
    })
    if (!user) throw new NotFoundException({ code: "USER_NOT_FOUND", message: "该手机号未注册" })
    return { userId: user.id, ...(await this.wallet.getWalletWithQuota(user.id)) }
  }

  @Post("charge")
  @ApiOperation({
    summary: "按手机号扣积分（透支扣，requestId 幂等）",
    description:
      'body {phone, costCny, model, requestId, meta?}，costCny 为金额字符串（如 "0.001"）；手机号映射用户，余额不足透支扣减；重复 requestId 返回首次结果 duplicate=true 不重复扣',
  })
  async charge(@Body() dto: InternalChargeDto) {
    const costCny = Number(dto.costCny)
    if (!Number.isFinite(costCny)) throw new BadRequestException("扣费金额超出有效范围")

    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone.trim() },
      select: { id: true },
    })
    if (!user) {
      // 对象形式 message：调用方按 message.code 识别并转译为「积分账户不存在」
      throw new NotFoundException({ code: "USER_NOT_FOUND" })
    }

    const result = await this.usage.chargeModel(user.id, costCny, {
      source: "vidflowos.deduct",
      model: dto.model,
      meta: { ...dto.meta, channel: "vidflowos" },
      requestId: dto.requestId,
      allowOverdraft: true,
    })

    return {
      userId: user.id,
      costCny: result.costCny.toString(),
      creditsCharged: result.creditsCharged.toString(),
      balance: result.balance.toString(),
      duplicate: result.duplicate,
      source: result.source,
      requestId: result.requestId,
    }
  }
}
