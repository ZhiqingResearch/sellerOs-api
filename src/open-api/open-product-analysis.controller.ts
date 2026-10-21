import { Body, Controller, HttpCode, Post, Request, UseGuards } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { OpenApiApp } from "@prisma/client"
import { GenerateOperationPlanDto } from "./dto/generate-operation-plan.dto"
import { OpenApiAuthGuard } from "./open-api-auth.guard"
import { OpenProductAnalysisService } from "./open-product-analysis.service"

@ApiTags("开放接口-牛牛商品分析")
@Controller("open/products")
@UseGuards(OpenApiAuthGuard)
export class OpenProductAnalysisController {
  constructor(private readonly service: OpenProductAnalysisService) {}

  @Post("analysis")
  @HttpCode(200)
  @ApiOperation({
    summary: "仅传商品链接查询价格、销量、历史价格曲线及历史运营甘特，不生成未来方案",
  })
  query(@Request() req: { openApiApp: OpenApiApp }, @Body() dto: GenerateOperationPlanDto) {
    return this.service.query(req.openApiApp, dto.url)
  }
}
