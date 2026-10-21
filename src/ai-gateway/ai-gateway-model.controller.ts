import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { AiGatewayModelService } from "./ai-gateway-model.service"
import { AiGatewayVideoQuoteDto, QueryAiGatewayModelsDto } from "./dto/ai-gateway-model.dto"

@ApiTags("AI Gateway")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("ai-models")
export class AiGatewayModelController {
  constructor(private readonly service: AiGatewayModelService) {}

  @ApiOperation({ summary: "按模态和分类获取可用模型及能力" })
  @Get()
  findAll(@Query() query: QueryAiGatewayModelsDto) {
    return this.service.findAll(query)
  }

  @ApiOperation({ summary: "获取视频模型单位预估价格（积分/秒或积分/次）" })
  @Post("quote")
  quote(@Body() dto: AiGatewayVideoQuoteDto) {
    return this.service.quote(dto)
  }
}
