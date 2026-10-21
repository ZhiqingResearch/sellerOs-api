import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { InvokeType, OpenApiApp } from "@prisma/client"
import { CreditService } from "../membership/credit.service"
import { PrismaService } from "../prisma/prisma.service"
import { FeatureRegistryService } from "../usage/feature-registry.service"
import { UsageService } from "../usage/usage.service"
import { OpenDeductDto } from "./dto/open-deduct.dto"
import { OpenApiAuthGuard } from "./open-api-auth.guard"

/**
 * 对外开放-积分扣费（其他项目服务间调用）：AppId + HMAC 签名鉴权（见 OpenApiAuthGuard），
 * 手机号对齐平台用户表。扣费内核与对内 v2（POST /usage/deduct/v2）完全同源。
 */
@ApiTags("开放接口-积分扣费")
@Controller("open/credit")
@UseGuards(OpenApiAuthGuard)
export class OpenCreditController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly credit: CreditService,
    private readonly features: FeatureRegistryService
  ) {}

  @Post("deduct")
  @ApiOperation({
    summary: "扣费（手机号对齐用户；requestId 幂等必填；meta 自动附带 appId 渠道标记）",
  })
  async deduct(@Request() req: { openApiApp: OpenApiApp }, @Body() dto: OpenDeductDto) {
    const app = req.openApiApp
    if (app.perCallMaxCny != null && dto.costCny > Number(app.perCallMaxCny)) {
      throw new BadRequestException(`超过单笔扣费上限（${app.perCallMaxCny.toString()} 元）`)
    }
    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
      select: { id: true },
    })
    if (!user) throw new NotFoundException("该手机号未注册")

    const result = await this.usage.chargeModel(user.id, dto.costCny, {
      source: dto.source,
      model: dto.model,
      requestId: dto.requestId,
      invokeType: InvokeType.API,
      meta: { ...(dto.meta ?? {}), appId: app.appId },
    })
    return { userId: user.id, ...result }
  }

  @Get("balance")
  @ApiOperation({
    summary:
      "查询用户可消费积分余额（路由口径：归属占用中企业则含共享池合计，2026-09-01 起），扣费前预检",
  })
  async balance(@Query("phone") phone: string) {
    if (!phone) throw new BadRequestException("缺少 phone 参数")
    const user = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } })
    if (!user) throw new NotFoundException("该手机号未注册")
    // 路由口径（与 deduct 的 consumeRouted 一致）：企业成员=个人可消费+企业池合计，否则个人三桶
    const balance = await this.credit.getConsumableBalanceRouted(user.id)
    return { userId: user.id, balance: balance.toString() }
  }

  @Get("features")
  @ApiOperation({ summary: "可用功能模块清单（FeatureModule active 行，含一级目录归属）" })
  async featureList() {
    await this.features.ensureFresh()
    return this.features.list()
  }
}
