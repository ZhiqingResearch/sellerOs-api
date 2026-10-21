import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { hasPermission, PermissionsGuard } from "../auth/guards/permissions.guard"
import { PermissionCacheService } from "../auth/services/permission-cache.service"
import { AnalysisRecordService } from "./analysis-record.service"
import { CreateAnalysisRecordDto } from "./dto/create-analysis-record.dto"
import { QueryAnalysisRecordDto } from "./dto/query-analysis-record.dto"
import { SaveAnalysisStepDto } from "./dto/save-analysis-step.dto"

@ApiTags("选品分析记录")
@ApiBearerAuth()
@Controller("product-selection/analysis-records")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("tool.flow_workbench")
export class AnalysisRecordController {
  constructor(
    private readonly service: AnalysisRecordService,
    private readonly permissionCache: PermissionCacheService
  ) {}

  @Post()
  @ApiOperation({ summary: "创建分析并保存第1步" })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateAnalysisRecordDto) {
    return this.service.create(req.user.id, dto)
  }

  @Put(":analysisId/steps/:stepNo")
  @ApiOperation({ summary: "新增或更新指定步骤结果" })
  saveStep(
    @Request() req: { user: { id: number } },
    @Param("analysisId", new ParseUUIDPipe({ version: "4" })) analysisId: string,
    @Param("stepNo", ParseIntPipe) stepNo: number,
    @Body() dto: SaveAnalysisStepDto
  ) {
    return this.service.saveStep(req.user.id, analysisId, stepNo, dto)
  }

  @Get()
  @RequirePermissions()
  @ApiOperation({ summary: "分页查询当前用户的选品分析记录" })
  async findAll(@Request() req: { user: { id: number } }, @Query() query: QueryAnalysisRecordDto) {
    const keys = await this.permissionCache.getForUser(req.user.id)
    const hasSelectionAccess = hasPermission(keys, "tool.flow_workbench")
    const hasCategoryAccess =
      Boolean(query.includeCategoryAnalysis) && hasPermission(keys, "tool.category_analysis")
    if (!hasSelectionAccess && !hasCategoryAccess) {
      throw new ForbiddenException("缺少选品工具或类目分析权限")
    }
    return this.service.findAll(req.user.id, query, { hasSelectionAccess, hasCategoryAccess })
  }

  @Get(":analysisId")
  @ApiOperation({ summary: "查询分析详情及全部有效步骤" })
  findOne(
    @Request() req: { user: { id: number } },
    @Param("analysisId", new ParseUUIDPipe({ version: "4" })) analysisId: string
  ) {
    return this.service.findOne(req.user.id, analysisId)
  }

  @Delete(":analysisId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "软删除选品分析记录" })
  remove(
    @Request() req: { user: { id: number } },
    @Param("analysisId", new ParseUUIDPipe({ version: "4" })) analysisId: string
  ) {
    return this.service.remove(req.user.id, analysisId)
  }
}
