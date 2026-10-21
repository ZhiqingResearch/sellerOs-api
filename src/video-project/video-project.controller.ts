import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { AiGatewayVideoRequestDto } from "../ai-gateway/dto/ai-gateway-model.dto"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import {
  CreateMotionControlBatchDto,
  CreateVideoProjectDto,
  QueryVideoProjectDto,
  QueryVideoTaskDto,
  RemoveVideoTasksDto,
  UpdateVideoProjectDto,
  VideoTaskStatsQueryDto,
} from "./video-project.dto"
import { VideoProjectService } from "./video-project.service"

interface AuthedRequest {
  user: { id: number; phone: string; roleCode: string | null }
}

@ApiTags("视频创作 - 通用创作")
@ApiBearerAuth()
@Controller("video-project")
@UseGuards(JwtAuthGuard)
export class VideoProjectController {
  constructor(private readonly service: VideoProjectService) {}

  // -----------------------------------------------------------------
  // 静态路径（tasks / task/...）必须放在 /:id 之前，避免被参数路由吞掉
  // -----------------------------------------------------------------

  // ==================== 任务中心 / 生成 ====================

  @ApiOperation({ summary: "任务中心列表（当前用户，可按项目 / 状态筛选）" })
  @Get("tasks")
  findAllTasks(@Query() query: QueryVideoTaskDto, @Request() req: AuthedRequest) {
    return this.service.findAllTasks(query, req.user.id)
  }

  @ApiOperation({
    summary: "任务中心状态计数（运行中 / 已完成 / 超时 / 已取消 / 失败 + 总数）",
    description: "任务中心标头与筛选 Tab 的计数；可选 projectId 限定到某项目。",
  })
  @Get("tasks/stats")
  taskStats(@Query() query: VideoTaskStatsQueryDto, @Request() req: AuthedRequest) {
    return this.service.getTaskStats(query, req.user.id)
  }

  @ApiOperation({ summary: "任务详情（轮询拿 status / resultUrl）" })
  @Get("task/:taskId")
  findOneTask(@Param("taskId", ParseIntPipe) taskId: number, @Request() req: AuthedRequest) {
    return this.service.findOneTask(taskId, req.user.id)
  }

  @ApiOperation({ summary: "请求取消运行中的任务" })
  @Post("task/:taskId/cancel")
  cancelTask(@Param("taskId", ParseIntPipe) taskId: number, @Request() req: AuthedRequest) {
    return this.service.cancelTask(taskId, req.user.id)
  }

  @ApiOperation({ summary: "删除任务（软删除）" })
  @Delete("task/:taskId")
  deleteTask(@Param("taskId", ParseIntPipe) taskId: number, @Request() req: AuthedRequest) {
    return this.service.deleteTask(taskId, req.user.id)
  }

  // ==================== 项目 ====================

  @ApiOperation({ summary: "新建视频项目" })
  @Post()
  createProject(@Body() dto: CreateVideoProjectDto, @Request() req: AuthedRequest) {
    return this.service.createProject(dto, req.user.id)
  }

  @ApiOperation({ summary: "项目列表（含视频数）" })
  @Get()
  findAllProjects(@Query() query: QueryVideoProjectDto, @Request() req: AuthedRequest) {
    return this.service.findAllProjects(query, req.user.id)
  }

  @ApiOperation({ summary: "项目详情（含任务列表）" })
  @Get(":id")
  findOneProject(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.findOneProject(id, req.user.id)
  }

  @ApiOperation({ summary: "重命名项目" })
  @Patch(":id")
  updateProject(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateVideoProjectDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.updateProject(id, dto, req.user.id)
  }

  @ApiOperation({ summary: "删除项目（软删除，连带任务）" })
  @Delete(":id")
  deleteProject(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.deleteProject(id, req.user.id)
  }

  @ApiOperation({ summary: "清理项目无效视频（取消 + 失败 + 超时；成功视频永久保留）" })
  @Post(":id/clear-invalid-tasks")
  clearInvalidTasks(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.clearInvalidTasks(id, req.user.id)
  }

  @ApiOperation({
    summary: "批量移除项目中的视频（软删除）",
    description: "通用视频、带货视频和动作克隆共用；生成中的视频不可移除，不退款且不立即删除文件。",
  })
  @Post(":id/remove-videos")
  removeVideos(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RemoveVideoTasksDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.removeVideos(id, dto.taskIds, req.user.id)
  }

  // ==================== 任务（项目下创建并触发生成） ====================

  @ApiOperation({
    summary: "创建 AI Gateway 视频生成任务",
    description:
      "前端传模型分类、publicId 和完整生成参数；后端强制覆盖 model、开启回调，并按 Gateway 报价校验余额。",
  })
  @Post(":id/task")
  createTask(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: AiGatewayVideoRequestDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.createTask(projectId, dto, req.user.id)
  }

  @ApiOperation({
    summary: "动作复刻批量创建任务（多动作视频 × 多目标图）",
    description:
      "用于视频创作 / 工具站 / 动作复刻。后端按动作视频与目标图的笛卡尔积拆成多条 MOTION_CONTROL 类 Gateway 任务（模型取目录中唯一启用的动作复刻模型），并复用任务中心轮询、回调落库与按 usage 扣费逻辑。",
  })
  @Post(":id/motion-control/batch")
  createMotionControlBatch(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: CreateMotionControlBatchDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.createMotionControlBatch(projectId, dto, req.user.id)
  }
}
