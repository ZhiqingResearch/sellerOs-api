import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import {
  AiSplitImageIdsDto,
  AiSplitUploadUrlDto,
  CreateAiSplitTaskDto,
  CreateAiSplitTemplateTaskDto,
  QueryAiSplitCompetitorImagesDto,
  QueryAiSplitTasksDto,
  RetryAiSplitTaskDto,
  SaveAiSplitResultsToTemplateDto,
  ValidateAiSplitReferenceUrlDto,
} from "./ai-split.dto"
import { AiSplitService } from "./ai-split.service"

interface AuthedRequest {
  user: { id: number; phone: string; roleCode: string | null }
}

@ApiTags("图片创作-AI 拆图")
@ApiBearerAuth()
@Controller("image-project")
@UseGuards(JwtAuthGuard)
export class AiSplitController {
  constructor(private readonly service: AiSplitService) {}

  @ApiOperation({
    summary:
      "查询 AI 拆图任务组（groupId 返回单组详情；projectId 返回该项目全部任务组，时间倒序、最新组带 isLatest）",
  })
  @Get("ai-split/tasks")
  findTaskGroup(@Query() query: QueryAiSplitTasksDto, @Request() req: AuthedRequest) {
    return this.service.getTaskGroup(query, req.user.id)
  }

  @ApiOperation({ summary: "重试 AI 拆图失败图片（不重复多模态分析）" })
  @Post("ai-split/tasks/:taskId/retry")
  @HttpCode(HttpStatus.ACCEPTED)
  retryTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body() dto: RetryAiSplitTaskDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.retryTask(taskId, dto, req.user.id)
  }

  @ApiOperation({ summary: "批量下载 AI 拆图成功图片清单" })
  @Post("ai-split/results/batch-download")
  batchDownload(@Body() dto: AiSplitImageIdsDto, @Request() req: AuthedRequest) {
    return this.service.batchDownload(dto, req.user.id)
  }

  @ApiOperation({ summary: "把 AI 拆图成功图片保存为新模板或追加到已有模板" })
  @Post("ai-split/results/save-template")
  saveToTemplate(@Body() dto: SaveAiSplitResultsToTemplateDto, @Request() req: AuthedRequest) {
    return this.service.saveToTemplate(dto, req.user.id)
  }

  @ApiOperation({ summary: "查询可作为竞品参考图的已有素材" })
  @Get(":projectId/ai-split/competitor-images")
  listCompetitorImages(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: QueryAiSplitCompetitorImagesDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.listCompetitorImages(projectId, query, req.user.id)
  }

  @ApiOperation({ summary: "获取 AI 拆图竞品图 Spaces 预签名上传地址" })
  @Post(":projectId/ai-split/upload-url")
  createUploadUrl(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: AiSplitUploadUrlDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.createUploadUrl(projectId, dto, req.user.id)
  }

  @ApiOperation({ summary: "校验 AI 拆图直接图片地址" })
  @Post(":projectId/ai-split/validate-reference-url")
  validateReferenceUrl(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: ValidateAiSplitReferenceUrlDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.validateReferenceUrl(projectId, dto, req.user.id)
  }

  @ApiOperation({ summary: "创建 AI 拆图任务组" })
  @Post(":projectId/ai-split/tasks")
  @HttpCode(HttpStatus.ACCEPTED)
  createTasks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: CreateAiSplitTaskDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.createTasks(projectId, dto, req.user.id)
  }

  @ApiOperation({ summary: "在新 SKU 上复用 AI 拆图模板（从 Workflow 2 开始）" })
  @Post(":projectId/ai-split/templates/:templateId/tasks")
  @HttpCode(HttpStatus.ACCEPTED)
  createTasksFromTemplate(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() dto: CreateAiSplitTemplateTaskDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.createTasksFromTemplate(projectId, templateId, dto, req.user.id)
  }
}
