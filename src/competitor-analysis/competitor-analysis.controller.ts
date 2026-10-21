import { DomesticBusinessModelGuard } from "../common/business-ai/domestic-business-model.guard"
import { Body, Controller, Post, Request, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { CompetitorAnalysisService } from "./competitor-analysis.service"
import { AnalyzeCompetitorsDto } from "./dto/analyze-competitors.dto"
import { SummarizeCompetitorsDto } from "./dto/summarize-competitors.dto"

@ApiTags("竞品分析")
@ApiBearerAuth()
@Controller("competitor-analysis")
@UseGuards(JwtAuthGuard, PermissionsGuard, DomesticBusinessModelGuard)
@RequirePermissions("agent.competitor")
export class CompetitorAnalysisController {
  constructor(private readonly competitorAnalysisService: CompetitorAnalysisService) {}

  @Post("analyze")
  @ApiOperation({ summary: "获取竞品事实数据并通过 AI 中转站生成完整分析" })
  analyze(@Request() request: { user: { id: number } }, @Body() dto: AnalyzeCompetitorsDto) {
    return this.competitorAnalysisService.analyze(request.user.id, dto)
  }

  @Post("profile")
  @ApiOperation({ summary: "独立获取竞品画像分析结果" })
  async analyzeProfile(
    @Request() _request: { user: { id: number } },
    @Body() dto: AnalyzeCompetitorsDto
  ) {
    await this.competitorAnalysisService.assertAffordable(_request.user.id, dto.asins)
    return this.competitorAnalysisService.analyzeProfile(dto)
  }

  @Post("traffic")
  @ApiOperation({ summary: "独立获取流量与广告分析结果" })
  async analyzeTraffic(
    @Request() _request: { user: { id: number } },
    @Body() dto: AnalyzeCompetitorsDto
  ) {
    await this.competitorAnalysisService.assertAffordable(_request.user.id, dto.asins)
    return this.competitorAnalysisService.analyzeTraffic(dto)
  }

  @Post("price-promo")
  @ApiOperation({ summary: "独立获取价格与促销分析结果" })
  async analyzePricePromo(
    @Request() _request: { user: { id: number } },
    @Body() dto: AnalyzeCompetitorsDto
  ) {
    await this.competitorAnalysisService.assertAffordable(_request.user.id, dto.asins)
    return this.competitorAnalysisService.analyzePricePromo(dto)
  }

  @Post("summary")
  @ApiOperation({ summary: "基于三个模块结果生成竞品分析总结" })
  summarize(@Request() request: { user: { id: number } }, @Body() dto: SummarizeCompetitorsDto) {
    return this.competitorAnalysisService.summarize(request.user.id, dto)
  }
}
