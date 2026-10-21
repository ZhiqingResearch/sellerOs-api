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
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import type { AuthedRequest } from "../material-pool/dto/common.dto"
import {
  BeautyTaskStatsQueryDto,
  CreateBeautyProjectDto,
  CreateBeautyTaskBatchDto,
  QueryBeautyProjectDto,
  QueryBeautyTaskDto,
  RemoveBeautyTasksDto,
  UpdateBeautyProjectDto,
} from "./beauty-workflow.dto"
import { BeautyWorkflowService } from "./beauty-workflow.service"

@ApiTags("批量工作流 - 美妆创作")
@ApiBearerAuth()
@Controller("beauty-project")
@UseGuards(JwtAuthGuard)
export class BeautyWorkflowController {
  constructor(private readonly service: BeautyWorkflowService) {}

  @ApiOperation({ summary: "美妆任务列表" })
  @Get("tasks")
  findAllTasks(@Query() query: QueryBeautyTaskDto, @Request() req: AuthedRequest) {
    return this.service.findAllTasks(query, req.user.id)
  }

  @ApiOperation({ summary: "美妆任务状态计数" })
  @Get("tasks/stats")
  getTaskStats(@Query() query: BeautyTaskStatsQueryDto, @Request() req: AuthedRequest) {
    return this.service.getTaskStats(query, req.user.id)
  }

  @ApiOperation({ summary: "美妆任务详情" })
  @Get("task/:taskId")
  findOneTask(@Param("taskId", ParseIntPipe) taskId: number, @Request() req: AuthedRequest) {
    return this.service.findOneTask(taskId, req.user.id)
  }

  @ApiOperation({ summary: "取消尚未提交上游的美妆任务" })
  @Post("task/:taskId/cancel")
  cancelTask(@Param("taskId", ParseIntPipe) taskId: number, @Request() req: AuthedRequest) {
    return this.service.cancelTask(taskId, req.user.id)
  }

  @ApiOperation({ summary: "删除美妆任务（软删除）" })
  @Delete("task/:taskId")
  deleteTask(@Param("taskId", ParseIntPipe) taskId: number, @Request() req: AuthedRequest) {
    return this.service.deleteTask(taskId, req.user.id)
  }

  @ApiOperation({ summary: "创建美妆项目" })
  @Post()
  createProject(@Body() dto: CreateBeautyProjectDto, @Request() req: AuthedRequest) {
    return this.service.createProject(dto, req.user.id)
  }

  @ApiOperation({ summary: "美妆项目列表" })
  @Get()
  findAllProjects(@Query() query: QueryBeautyProjectDto, @Request() req: AuthedRequest) {
    return this.service.findAllProjects(query, req.user.id)
  }

  @ApiOperation({ summary: "美妆项目详情" })
  @Get(":id")
  findOneProject(@Param("id", ParseIntPipe) projectId: number, @Request() req: AuthedRequest) {
    return this.service.findOneProject(projectId, req.user.id)
  }

  @ApiOperation({ summary: "重命名美妆项目" })
  @Patch(":id")
  updateProject(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: UpdateBeautyProjectDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.updateProject(projectId, dto, req.user.id)
  }

  @ApiOperation({ summary: "删除美妆项目及其任务（软删除）" })
  @Delete(":id")
  deleteProject(@Param("id", ParseIntPipe) projectId: number, @Request() req: AuthedRequest) {
    return this.service.deleteProject(projectId, req.user.id)
  }

  @ApiOperation({
    summary: "批量创建美妆任务",
    description:
      "前端提交最终提示词与参考图；后端按 tasks 创建独立 BeautyTask，并异步提交 AI Gateway，由回调更新任务状态。",
  })
  @Post(":id/tasks/batch")
  createTaskBatch(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: CreateBeautyTaskBatchDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.createTaskBatch(projectId, dto, req.user.id)
  }

  @ApiOperation({ summary: "清理项目内失败、超时和已取消任务" })
  @Post(":id/clear-invalid-tasks")
  clearInvalidTasks(@Param("id", ParseIntPipe) projectId: number, @Request() req: AuthedRequest) {
    return this.service.clearInvalidTasks(projectId, req.user.id)
  }

  @ApiOperation({
    summary: "批量移除项目中的 Beauty 视频（软删除）",
    description: "按 Beauty 任务 ID 批量移除；生成中的视频不可移除，不退款且不立即删除文件。",
  })
  @Post(":id/remove-videos")
  removeVideos(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: RemoveBeautyTasksDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.removeVideos(projectId, dto.taskIds, req.user.id)
  }
}
