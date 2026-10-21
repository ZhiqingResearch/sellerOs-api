import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { CompetitorAnalysisRecordService } from "./competitor-analysis-record.service"
import { CreateCompetitorAnalysisRecordDto } from "./dto/create-competitor-analysis-record.dto"
import { QueryCompetitorAnalysisRecordDto } from "./dto/query-competitor-analysis-record.dto"
import { UpdateCompetitorAnalysisReportPdfDto } from "./dto/update-competitor-analysis-report-pdf.dto"

@ApiTags("竞品分析记录")
@ApiBearerAuth()
@Controller("competitor-analysis/records")
@UseGuards(JwtAuthGuard)
export class CompetitorAnalysisRecordController {
  constructor(private readonly service: CompetitorAnalysisRecordService) {}

  @Post()
  @ApiOperation({ summary: "归档当前用户的完整竞品分析结果" })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateCompetitorAnalysisRecordDto) {
    return this.service.create(req.user.id, dto)
  }

  @Get()
  @ApiOperation({ summary: "分页查询当前用户的竞品分析记录" })
  findAll(
    @Request() req: { user: { id: number } },
    @Query() query: QueryCompetitorAnalysisRecordDto
  ) {
    return this.service.findAll(req.user.id, query)
  }

  @Patch(":recordId/report-pdf")
  @ApiOperation({ summary: "回写或覆盖当前用户竞品分析报告的 PDF URL" })
  updateReportPdf(
    @Request() req: { user: { id: number } },
    @Param("recordId", new ParseUUIDPipe({ version: "4" })) recordId: string,
    @Body() dto: UpdateCompetitorAnalysisReportPdfDto
  ) {
    return this.service.updateReportPdf(req.user.id, recordId, dto.reportPdfUrl)
  }

  @Get(":recordId")
  @ApiOperation({ summary: "查询完整竞品分析记录快照" })
  findOne(
    @Request() req: { user: { id: number } },
    @Param("recordId", new ParseUUIDPipe({ version: "4" })) recordId: string
  ) {
    return this.service.findOne(req.user.id, recordId)
  }

  @Delete(":recordId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "软删除当前用户的竞品分析记录" })
  remove(
    @Request() req: { user: { id: number } },
    @Param("recordId", new ParseUUIDPipe({ version: "4" })) recordId: string
  ) {
    return this.service.remove(req.user.id, recordId)
  }
}
