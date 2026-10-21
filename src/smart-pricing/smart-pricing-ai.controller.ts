import { DomesticBusinessModelGuard } from "../common/business-ai/domestic-business-model.guard"
import { Body, Controller, Post, Request, Res, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { streamBusinessAi } from "../common/business-ai/business-ai-stream"
import { BusinessAiDto } from "../common/business-ai/business-ai.dto"
import { BusinessAiService } from "../common/business-ai/business-ai.service"

@ApiTags("商品智能定价")
@ApiBearerAuth()
@Controller("smart-pricing/ai")
@UseGuards(JwtAuthGuard, PermissionsGuard, DomesticBusinessModelGuard)
@RequirePermissions("tool.smart_pricing")
export class SmartPricingAiController {
  constructor(private readonly businessAiService: BusinessAiService) {}

  @Post("complete")
  @ApiOperation({ summary: "商品智能定价：后端 AI 分析与积分结算" })
  complete(@Request() request: { user: { id: number } }, @Body() dto: BusinessAiDto) {
    return this.businessAiService.complete(request.user.id, "pricing.quote", dto)
  }

  @Post("stream")
  @ApiProduces("text/event-stream")
  @ApiOperation({ summary: "商品智能定价：后端流式 AI 分析与积分结算" })
  stream(
    @Request() request: { user: { id: number } },
    @Body() dto: BusinessAiDto,
    @Res() response: Response
  ) {
    return streamBusinessAi(response, this.businessAiService, request.user.id, "pricing.quote", dto)
  }
}
