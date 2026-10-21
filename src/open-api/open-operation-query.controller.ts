import { Body, Controller, HttpCode, Post, Request, UseGuards } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { OpenApiApp } from "@prisma/client"
import { GenerateOperationPlanDto as QueryCompetitorDto } from "./dto/generate-operation-plan.dto"
import { OpenApiAuthGuard } from "./open-api-auth.guard"
import { OpenProductAnalysisService } from "./open-product-analysis.service"

@ApiTags("开放接口-牛牛竞品运营方案")
@Controller("open/operation-plans")
@UseGuards(OpenApiAuthGuard)
export class OpenOperationQueryController {
  constructor(private readonly service: OpenProductAnalysisService) {}

  @Post("query")
  @HttpCode(200)
  @ApiOperation({ summary: "查询竞品历史运营方案详情：外部信号与规则推断，不生成未来计划" })
  query(@Request() req: { openApiApp: OpenApiApp }, @Body() dto: QueryCompetitorDto) {
    return this.service.queryOperations(req.openApiApp, dto.url)
  }
}
