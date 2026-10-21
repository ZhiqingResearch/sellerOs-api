import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import {
  CompleteRpaTaskDto,
  CreateRpaCreationProjectDto,
  CreateRpaCreationTaskDto,
  QueryRpaCreationProjectDto,
  QueryRpaCreationTaskDto,
  RemoveRpaResultsDto,
  RpaCreationTaskStatsDto,
  UpdateRpaCreationProjectDto,
} from "./rpa-creation.dto"
import { RpaCreationService } from "./rpa-creation.service"

interface AuthedRequest {
  user: { id: number; phone: string; roleCode: string | null }
}

@ApiTags("图片/视频创作 - 影刀 RPA")
@ApiBearerAuth()
@Controller("rpa-creation")
@UseGuards(JwtAuthGuard)
export class RpaCreationController {
  constructor(private readonly service: RpaCreationService) {}

  @ApiOperation({ summary: "RPA 图片/视频创作能力矩阵" })
  @Get("capabilities")
  getCapabilities() {
    return this.service.getCapabilities()
  }

  @ApiOperation({ summary: "任务中心列表" })
  @Get("tasks")
  findAllTasks(@Query() query: QueryRpaCreationTaskDto, @Request() req: AuthedRequest) {
    return this.service.findAllTasks(query, req.user.id)
  }

  @ApiOperation({ summary: "任务中心状态计数" })
  @Get("tasks/stats")
  getTaskStats(@Query() query: RpaCreationTaskStatsDto, @Request() req: AuthedRequest) {
    return this.service.getTaskStats(query, req.user.id)
  }

  @ApiOperation({ summary: "任务详情" })
  @Get("tasks/:id")
  findOneTask(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.findOneTask(id, req.user.id)
  }

  @ApiOperation({ summary: "重试任务中的失败输出" })
  @Post("tasks/:id/retry")
  retryTask(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.retryTask(id, req.user.id)
  }

  @ApiOperation({ summary: "新建 RPA 创作项目" })
  @Post("projects")
  createProject(@Body() dto: CreateRpaCreationProjectDto, @Request() req: AuthedRequest) {
    return this.service.createProject(dto, req.user.id)
  }

  @ApiOperation({ summary: "RPA 创作项目列表" })
  @Get("projects")
  findAllProjects(@Query() query: QueryRpaCreationProjectDto, @Request() req: AuthedRequest) {
    return this.service.findAllProjects(query, req.user.id)
  }

  @ApiOperation({ summary: "RPA 创作项目详情" })
  @Get("projects/:id")
  findOneProject(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.findOneProject(id, req.user.id)
  }

  @ApiOperation({ summary: "重命名 RPA 创作项目" })
  @Patch("projects/:id")
  updateProject(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateRpaCreationProjectDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.updateProject(id, dto, req.user.id)
  }

  @ApiOperation({ summary: "删除 RPA 创作项目及其任务（软删除）" })
  @Delete("projects/:id")
  deleteProject(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.deleteProject(id, req.user.id)
  }

  @ApiOperation({ summary: "清理项目无效图片/视频（软删除）" })
  @Post("projects/:id/clear-invalid-results")
  clearInvalidResults(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.clearInvalidResults(id, req.user.id)
  }

  @ApiOperation({
    summary: "批量移除项目中的 RPA 图片/视频结果（软删除）",
    description: "按输出结果 ID 批量移除；等待中或生成中的结果不可移除，不退款且不立即删除文件。",
  })
  @Post("projects/:id/remove-results")
  removeResults(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RemoveRpaResultsDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.removeResults(id, dto.outputIds, req.user.id)
  }

  @ApiOperation({ summary: "创建任务并异步提交影刀 RPA" })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "前端为每次用户提交生成的唯一键，防止重复创建任务",
  })
  @Post("projects/:id/tasks")
  createTask(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: CreateRpaCreationTaskDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Request() req: AuthedRequest
  ) {
    return this.service.createTask(id, dto, req.user.id, idempotencyKey)
  }
}

@ApiTags("图片/视频创作 - RPA 内部回调")
@Controller("rpa-creation/internal")
export class RpaCreationInternalController {
  constructor(private readonly service: RpaCreationService) {}

  @ApiOperation({
    summary: "RPA 上报最终结果",
    description: "首次生成按输出席位顺序回填；重试时仅按顺序回填本轮失败输出。",
  })
  @ApiHeader({ name: "Authorization", required: true, description: "Bearer 回调令牌" })
  @Post("tasks/:requestId/complete")
  completeTask(
    @Param("requestId") requestId: string,
    @Headers("authorization") authorization: string | undefined,
    @Body() dto: CompleteRpaTaskDto
  ) {
    return this.service.completeTask(requestId, authorization, dto)
  }
}
