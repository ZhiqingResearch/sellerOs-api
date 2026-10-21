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
import {
  CreateImageProjectDto,
  CreateProductImageDto,
  CreateTaskDto,
  QueryImageProjectDto,
  QueryTaskDto,
  RemoveGeneratedImagesDto,
  UpdateGeneratedImageDto,
  UpdateImageProjectDto,
  UpdateProductImageDto,
  UpdateTaskDto,
  UpsertBrandIdentityDto,
  UpsertProductProfileDto,
} from "./image-project.dto"
import { ImageProjectService } from "./image-project.service"

interface AuthedRequest {
  user: { id: number; phone: string; roleCode: string | null }
}

@ApiTags("图片创作")
@ApiBearerAuth()
@Controller("image-project")
@UseGuards(JwtAuthGuard)
export class ImageProjectController {
  constructor(private readonly service: ImageProjectService) {}

  // -----------------------------------------------------------------
  // 静态路径必须放在 /:id 之前，避免被参数路由吞掉
  // -----------------------------------------------------------------

  // ==================== 任务（全局列表） ====================

  @ApiOperation({ summary: "任务列表（当前用户）" })
  @Get("tasks")
  findAllTasks(@Query() query: QueryTaskDto, @Request() req: AuthedRequest) {
    return this.service.findAllTasks(query, req.user.id)
  }

  // ==================== 任务（单条） ====================

  @ApiOperation({ summary: "任务详情" })
  @Get("task/:taskId")
  findOneTask(@Param("taskId", ParseIntPipe) taskId: number, @Request() req: AuthedRequest) {
    return this.service.findOneTask(taskId, req.user.id)
  }

  @ApiOperation({ summary: "更新任务（状态 / 错误信息）" })
  @Patch("task/:taskId")
  updateTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body() dto: UpdateTaskDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.updateTask(taskId, dto, req.user.id)
  }

  @ApiOperation({ summary: "删除任务（软删除）" })
  @Delete("task/:taskId")
  deleteTask(@Param("taskId", ParseIntPipe) taskId: number, @Request() req: AuthedRequest) {
    return this.service.deleteTask(taskId, req.user.id)
  }

  // ==================== 产品图（单条操作） ====================

  @ApiOperation({ summary: "更新产品图" })
  @Patch("product-image/:imageId")
  updateProductImage(
    @Param("imageId", ParseIntPipe) imageId: number,
    @Body() dto: UpdateProductImageDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.updateProductImage(imageId, dto, req.user.id)
  }

  @ApiOperation({ summary: "删除产品图（软删除）" })
  @Delete("product-image/:imageId")
  deleteProductImage(
    @Param("imageId", ParseIntPipe) imageId: number,
    @Request() req: AuthedRequest
  ) {
    return this.service.deleteProductImage(imageId, req.user.id)
  }

  // ==================== 生成图席位 ====================

  @ApiOperation({ summary: "更新生成图（URL / 状态 / 采纳）" })
  @Patch("generated-image/:imageId")
  updateGeneratedImage(
    @Param("imageId", ParseIntPipe) imageId: number,
    @Body() dto: UpdateGeneratedImageDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.updateGeneratedImage(imageId, dto, req.user.id)
  }

  @ApiOperation({ summary: "删除生成图（软删除）" })
  @Delete("generated-image/:imageId")
  deleteGeneratedImage(
    @Param("imageId", ParseIntPipe) imageId: number,
    @Request() req: AuthedRequest
  ) {
    return this.service.deleteGeneratedImage(imageId, req.user.id)
  }

  // ==================== 项目 ====================

  @ApiOperation({ summary: "创建图片创作项目" })
  @Post()
  createProject(@Body() dto: CreateImageProjectDto, @Request() req: AuthedRequest) {
    return this.service.createProject(dto, req.user.id)
  }

  @ApiOperation({ summary: "项目列表" })
  @Get()
  findAllProjects(@Query() query: QueryImageProjectDto, @Request() req: AuthedRequest) {
    return this.service.findAllProjects(query, req.user.id)
  }

  @ApiOperation({ summary: "项目详情（含产品资料 / 品牌基因 / 产品图）" })
  @Get(":id")
  findOneProject(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.findOneProject(id, req.user.id)
  }

  @ApiOperation({ summary: "更新项目" })
  @Patch(":id")
  updateProject(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateImageProjectDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.updateProject(id, dto, req.user.id)
  }

  @ApiOperation({ summary: "删除项目（软删除）" })
  @Delete(":id")
  deleteProject(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.deleteProject(id, req.user.id)
  }

  @ApiOperation({ summary: "清理项目无效图片（取消 + 失败 + 超时，软删除）" })
  @Post(":id/clear-invalid-images")
  clearInvalidImages(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.clearInvalidImages(id, req.user.id)
  }

  // 兼容旧路径 clear-failed-tasks，行为同 clear-invalid-images
  @ApiOperation({ summary: "兼容旧路径：清理项目无效图片（取消 + 失败 + 超时，软删除）" })
  @Post(":id/clear-failed-tasks")
  clearFailedTasks(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.clearInvalidImages(id, req.user.id)
  }

  @ApiOperation({
    summary: "批量移除项目中的生成图片（软删除）",
    description: "按生成图片 ID 批量移除；生成中的图片不可移除，不退款且不立即删除文件。",
  })
  @Post(":id/remove-images")
  removeImages(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RemoveGeneratedImagesDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.removeImages(id, dto.imageIds, req.user.id)
  }

  // ==================== 产品资料（1:1 upsert） ====================

  @ApiOperation({ summary: "查询产品资料" })
  @Get(":id/product-profile")
  getProductProfile(@Param("id", ParseIntPipe) projectId: number, @Request() req: AuthedRequest) {
    return this.service.getProductProfile(projectId, req.user.id)
  }

  @ApiOperation({
    summary: "保存产品资料（upsert）",
    description:
      "前端三件套（AI 读图 / PDF / URL）解析完成后调用此接口直接写回；localizations 按 locale 增量合并。",
  })
  @Patch(":id/product-profile")
  upsertProductProfile(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: UpsertProductProfileDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.upsertProductProfile(projectId, dto, req.user.id)
  }

  // ==================== 品牌基因 ====================

  @ApiOperation({ summary: "查询品牌基因" })
  @Get(":id/brand-identity")
  getBrandIdentity(@Param("id", ParseIntPipe) projectId: number, @Request() req: AuthedRequest) {
    return this.service.getBrandIdentity(projectId, req.user.id)
  }

  @ApiOperation({ summary: "保存品牌基因（upsert）" })
  @Patch(":id/brand-identity")
  upsertBrandIdentity(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: UpsertBrandIdentityDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.upsertBrandIdentity(projectId, dto, req.user.id)
  }

  // ==================== 产品图（项目下创建 / 列表） ====================

  @ApiOperation({ summary: "添加产品图" })
  @Post(":id/product-image")
  createProductImage(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: CreateProductImageDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.createProductImage(projectId, dto, req.user.id)
  }

  @ApiOperation({ summary: "产品图列表" })
  @Get(":id/product-image")
  findAllProductImages(
    @Param("id", ParseIntPipe) projectId: number,
    @Request() req: AuthedRequest
  ) {
    return this.service.findAllProductImages(projectId, req.user.id)
  }

  // ==================== 任务（项目下创建） ====================

  @ApiOperation({
    summary: "创建生图任务",
    description: "AI 调用在前端完成；后端只负责保存。任务字段 + generatedImages 数组一次落库。",
  })
  @Post(":id/task")
  createTask(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: CreateTaskDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.createTask(projectId, dto, req.user.id)
  }
}
