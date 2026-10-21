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
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import {
  CreateAccountDto,
  CreateAvatarDto,
  CreateCustomerDto,
  CreateProjectDto,
  CreateSourceDto,
  CreateStrategyDto,
  CreateVoiceDto,
  DeepResearchDto,
  GenerateContentPlanDto,
  GenerateMaterialVariantsDto,
  GenerateProductionDto,
  GenerateStoryboardVideosDto,
  PublishProjectDto,
  QueryAvatarDto,
  QueryCustomerDto,
  QueryGlobalProjectDto,
  QueryMaterialIdsDto,
  QueryProjectDto,
  QueryPublicAvatarDto,
  QueryPublicVoiceDto,
  QueryStoryboardIdsDto,
  QueryTagDto,
  QueryVoiceDto,
  SynthesizeVideoDto,
  UpdateAccountDto,
  UpdateCustomerDto,
  UpdateImageApprovalDto,
  UpdateProjectTopicDto,
} from "./customer.dto"
import { CustomerService } from "./customer.service"
import { PublicResourceService } from "./public-resource.service"

/** JwtAuthGuard 附加的 req.user（参考 auth/strategies/jwt.strategy.ts#validate） */
interface AuthedRequest {
  user: { id: number; phone: string; roleCode: string | null }
}

@ApiTags("客户")
@ApiBearerAuth()
@Controller("customer")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("management.customers")
export class CustomerController {
  constructor(
    private readonly customerService: CustomerService,
    private readonly publicResourceService: PublicResourceService
  ) {}

  // ==================== 标签 ====================

  @ApiOperation({ summary: "获取标签列表" })
  @Get("tags")
  findTags(@Query() query: QueryTagDto) {
    return this.customerService.findTags(query.category)
  }

  // ==================== 统计 ====================

  @ApiOperation({ summary: "获取客户中心统计数据" })
  @Get("stats")
  getStats(@Request() req: AuthedRequest) {
    return this.customerService.getStats(req.user.id)
  }

  @ApiOperation({
    summary: "社媒运营员工作台统计卡片",
    description:
      "已完成项目 = COMPLETED + PUBLISHED，本月增量按 updatedAt 落在当前自然月；发布率 = 已发布 / 已完成；累计生成内容 = 口播稿 + 发布文案 + 分镜视频(SUCCESS) + 素材图片(SUCCESS)；Token 用量暂未接入。",
  })
  @Get("dashboard/stats")
  getDashboardStats(@Request() req: AuthedRequest) {
    return this.customerService.getDashboardStats(req.user.id)
  }

  // ==================== 全局项目列表 ====================

  @ApiOperation({ summary: "获取所有客户的项目列表" })
  @Get("projects")
  findAllProjectsGlobal(@Query() query: QueryGlobalProjectDto, @Request() req: AuthedRequest) {
    return this.customerService.findAllProjectsGlobal(query, req.user.id)
  }

  // ==================== 客户 ====================

  @ApiOperation({ summary: "创建客户" })
  @Post()
  create(@Body() dto: CreateCustomerDto, @Request() req: AuthedRequest) {
    return this.customerService.create(dto, req.user.id)
  }

  @ApiOperation({ summary: "获取客户列表" })
  @Get()
  findAll(@Query() query: QueryCustomerDto, @Request() req: AuthedRequest) {
    return this.customerService.findAll(query, req.user.id)
  }

  // ==================== 账号 ====================

  @ApiOperation({ summary: "创建账号" })
  @Post(":customerId/account")
  createAccount(
    @Param("customerId", ParseIntPipe) customerId: number,
    @Body() dto: CreateAccountDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.createAccount(customerId, dto, req.user.id)
  }

  @ApiOperation({ summary: "获取账号列表" })
  @Get(":customerId/account")
  findAllAccounts(
    @Param("customerId", ParseIntPipe) customerId: number,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.findAllAccounts(customerId, req.user.id)
  }

  @ApiOperation({ summary: "获取账号详情" })
  @Get("account/:id")
  findOneAccount(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.customerService.findOneAccount(id, req.user.id)
  }

  @ApiOperation({ summary: "修改账号信息" })
  @Patch("account/:id")
  updateAccount(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateAccountDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.updateAccount(id, dto, req.user.id)
  }

  @ApiOperation({ summary: "删除账号" })
  @Delete("account/:id")
  removeAccount(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.customerService.removeAccount(id, req.user.id)
  }

  @ApiOperation({ summary: "重新生成账号规划方案" })
  @Post("account/:id/regenerate-strategy")
  regenerateAccountStrategy(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.customerService.regenerateAccountStrategy(id, req.user.id)
  }

  // ==================== 形象 ====================

  @ApiOperation({
    summary: "获取曦灵文件上传签名（供形象前端直传）",
    description:
      "返回 { authorization, uploadUrl, expireAt }。前端 POST multipart/form-data 到 uploadUrl（Header 携带 Authorization），字段：file、providerType=OPEN_CUSTOMIZATION_2D_GENERAL、sourceFileName，响应里拿到 fileId，再调 POST /customer/:customerId/avatar。音色仍走 trainingUrl，后端代上传，前端无需调此接口。",
  })
  @Get("xiling/upload-auth")
  getXilingUploadAuth() {
    return this.customerService.getXilingUploadAuth()
  }

  @ApiOperation({ summary: "克隆形象（fileId 由前端直传曦灵后获得）" })
  @Post(":customerId/avatar")
  createAvatar(
    @Param("customerId", ParseIntPipe) customerId: number,
    @Body() dto: CreateAvatarDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.createAvatar(customerId, dto, req.user.id)
  }

  @ApiOperation({ summary: "获取客户形象列表（支持按 status 筛选）" })
  @Get(":customerId/avatar")
  findAllAvatars(
    @Param("customerId", ParseIntPipe) customerId: number,
    @Query() query: QueryAvatarDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.findAllAvatars(customerId, req.user.id, query.status)
  }

  @ApiOperation({ summary: "删除形象（软删除，已引用的历史视频不受影响）" })
  @Delete("avatar/:id")
  removeAvatar(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.customerService.removeAvatar(id, req.user.id)
  }

  // ==================== 音色 ====================

  @ApiOperation({ summary: "克隆音色" })
  @Post(":customerId/voice")
  createVoice(
    @Param("customerId", ParseIntPipe) customerId: number,
    @Body() dto: CreateVoiceDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.createVoice(customerId, dto, req.user.id)
  }

  @ApiOperation({ summary: "获取客户音色列表（支持按 status 筛选）" })
  @Get(":customerId/voice")
  findAllVoices(
    @Param("customerId", ParseIntPipe) customerId: number,
    @Query() query: QueryVoiceDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.findAllVoices(customerId, req.user.id, query.status)
  }

  @ApiOperation({ summary: "删除音色（软删除，已引用的历史视频不受影响）" })
  @Delete("voice/:id")
  removeVoice(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.customerService.removeVoice(id, req.user.id)
  }

  // ==================== 公共形象 ====================

  @ApiOperation({
    summary: "浏览公共形象（弹窗 picker）",
    description:
      "从本地 PublicAvatar 镜像表读，TTL=24h 自动懒刷新；refresh=true 强制同步刷新一次。支持按性别/年龄/姿态/背景/人像类型/画面比例筛选，name 模糊搜索走 q 参数。已下架（isActive=false）不返回。",
  })
  @Get("public-avatars")
  listPublicAvatars(@Query() query: QueryPublicAvatarDto) {
    return this.publicResourceService.listPublicAvatars(query)
  }

  @ApiOperation({
    summary: "把公共形象添加到客户",
    description:
      "在 Avatar 表插入一行 kind=PUBLIC 的绑定；figureId 指向 PublicAvatar。已软删除的旧绑定会被复活。百度已下架（镜像 isActive=false）时返回 400，重复绑定返回 409。",
  })
  @Post(":customerId/public-avatar/:figureId")
  bindPublicAvatar(
    @Param("customerId", ParseIntPipe) customerId: number,
    @Param("figureId") figureId: string,
    @Request() req: AuthedRequest
  ) {
    return this.publicResourceService.bindAvatarToCustomer(customerId, figureId, req.user.id)
  }

  // ==================== 公共音色 ====================

  @ApiOperation({
    summary: "浏览公共音色（弹窗 picker）",
    description:
      "百度 /tts/persons 只返回少量字段；age/style/language/capability/feature/latency 由本地启发式标签推断（见 voice-tagger.ts）。TTL=24h 懒刷新。",
  })
  @Get("public-voices")
  listPublicVoices(@Query() query: QueryPublicVoiceDto) {
    return this.publicResourceService.listPublicVoices(query)
  }

  @ApiOperation({
    summary: "把公共音色添加到客户",
    description:
      "在 Voice 表插入一行 kind=PUBLIC 的绑定；perId 指向 PublicVoice。已软删除的旧绑定会被复活。",
  })
  @Post(":customerId/public-voice/:perId")
  bindPublicVoice(
    @Param("customerId", ParseIntPipe) customerId: number,
    @Param("perId") perId: string,
    @Request() req: AuthedRequest
  ) {
    return this.publicResourceService.bindVoiceToCustomer(customerId, perId, req.user.id)
  }

  // ==================== 项目 ====================

  @ApiOperation({ summary: "创建项目" })
  @Post(":customerId/project")
  createProject(
    @Param("customerId", ParseIntPipe) customerId: number,
    @Body() dto: CreateProjectDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.createProject(customerId, dto, req.user.id)
  }

  @ApiOperation({ summary: "获取项目列表" })
  @Get(":customerId/project")
  findAllProjects(
    @Param("customerId", ParseIntPipe) customerId: number,
    @Query() query: QueryProjectDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.findAllProjects(customerId, query, req.user.id)
  }

  @ApiOperation({ summary: "获取项目详情" })
  @Get("project/:id")
  findOneProject(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.customerService.findOneProject(id, req.user.id)
  }

  @ApiOperation({
    summary: "发布项目（COMPLETED / PUBLISHED 均可调用）",
    description:
      "COMPLETED 首次发布会把状态推进到 PUBLISHED；PUBLISHED 状态下可再次调用以覆盖发布时间或发布链接。publishedAt / publishUrl 未传则保留原值。",
  })
  @Post("project/:id/publish")
  publishProject(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: PublishProjectDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.publishProject(id, req.user.id, dto.publishedAt, dto.publishUrl)
  }

  @ApiOperation({
    summary: "修改项目主题",
    description: "同时更新 project.name 和 production.topic，保证列表和生产层标题一致",
  })
  @Patch("project/:id/topic")
  updateProjectTopic(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateProjectTopicDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.updateProjectTopic(id, dto.topic, req.user.id)
  }

  @ApiOperation({ summary: "删除项目" })
  @Delete("project/:id")
  removeProject(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.customerService.removeProject(id, req.user.id)
  }

  // ==================== 深度调研 ====================

  @ApiOperation({
    summary: "启动深度调研（异步，项目级，覆盖上一次结果）",
    description:
      "立即返回 source 快照（status=GENERATING），后端 fire-and-forget 调 Gemini Deep Research，完成后结果写入 source.content。同一项目再次调用会覆盖上一次结果。前端用 GET /customer/project/:projectId/deep-search 轮询状态。",
  })
  @Post("project/:projectId/deep-search")
  startDeepResearch(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: DeepResearchDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.startDeepResearch(projectId, dto.query, req.user.id)
  }

  @ApiOperation({
    summary: "获取项目的深度调研状态（供前端轮询）",
    description: "Source 类型不是 DEEP_RESEARCH 或尚未发起过调研时返回 null。",
  })
  @Get("project/:projectId/deep-search")
  findLatestDeepResearch(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.findLatestDeepResearch(projectId, req.user.id)
  }

  @ApiOperation({
    summary: "搜索匹配热点（供来源层挑选 HOT_TOPIC）",
    description:
      "结合项目所属客户 + 账号画像调 Gemini（带 Google Search 工具），返回近 7 天 TOP 8 热点及综合建议。同步阻塞。",
  })
  @Post("project/:projectId/search-hotspots")
  searchHotspots(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.searchHotspots(projectId, req.user.id)
  }

  // ==================== 来源 ====================

  @ApiOperation({ summary: "保存来源（不存在则创建，存在则更新）" })
  @Post("project/:projectId/source")
  saveSource(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: CreateSourceDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.saveSource(projectId, dto, req.user.id)
  }

  // ==================== 方案 ====================

  @ApiOperation({ summary: "保存方案（不存在则创建，存在则更新）" })
  @Post("project/:projectId/strategy")
  saveStrategy(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: CreateStrategyDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.saveStrategy(projectId, dto, req.user.id)
  }

  @ApiOperation({ summary: "AI 一键生成方案内容" })
  @Post("project/:projectId/strategy/generate")
  generateContentPlan(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: GenerateContentPlanDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.generateContentPlan(
      projectId,
      dto.integrationType,
      dto.targetDurationSec,
      req.user.id
    )
  }

  // ==================== 生产层 AI 生成 ====================

  @ApiOperation({
    summary: "AI 生成口播稿",
    description:
      "isAuto=true 时若已有口播稿直接返回（不调用 AI）；isAuto=false（默认）则重新生成，未合成视频的历史稿会被覆盖。",
  })
  @Post("production/generate-script")
  generateScript(@Body() dto: GenerateProductionDto, @Request() req: AuthedRequest) {
    return this.customerService.generateScript(dto.projectId, dto.isAuto ?? false, req.user.id)
  }

  @ApiOperation({
    summary: "AI 生成发布文案",
    description:
      "isAuto=true 时若已有发布文案直接返回（不调用 AI）；isAuto=false（默认）则重新生成并覆盖原有文案。",
  })
  @Post("production/generate-copywriting")
  generateCopyWriting(@Body() dto: GenerateProductionDto, @Request() req: AuthedRequest) {
    return this.customerService.generateCopyWriting(dto.projectId, dto.isAuto ?? false, req.user.id)
  }

  @ApiOperation({ summary: "合成数字人视频" })
  @Post("production/synthesize-video")
  synthesizeVideo(@Body() dto: SynthesizeVideoDto, @Request() req: AuthedRequest) {
    return this.customerService.synthesizeVideo(dto, req.user.id)
  }

  // ==================== 分镜头 ====================

  @ApiOperation({ summary: "AI 生成分镜头提示词（默认 3 个，已存在则直接返回不覆盖）" })
  @Post("project/:projectId/storyboards/generate")
  generateStoryboards(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.generateStoryboards(projectId, req.user.id)
  }

  @ApiOperation({ summary: "新增空白分镜头（最多 5 个，前端后续填写后调用生成接口）" })
  @Post("project/:projectId/storyboard")
  createStoryboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.createStoryboard(projectId, req.user.id)
  }

  @ApiOperation({ summary: "删除分镜头" })
  @Delete("storyboard/:id")
  removeStoryboard(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.customerService.removeStoryboard(id, req.user.id)
  }

  @ApiOperation({
    summary: "批量生成分镜头席位视频（AI Gateway，2 席位/镜头，异步）",
    description:
      "请求体为分镜头列表，单条生成传 1 项，一键全部生成传多项。每项回写 duration、prompt 和首尾帧垫图（shot/motion 保留 AI 初始值不覆盖），再提交 AI Gateway。立即返回所有受影响分镜头的快照（status=GENERATING），前端用 GET /customer/storyboards?ids=1,2,3 轮询状态。",
  })
  @Post("storyboards/generate-videos")
  generateStoryboardVideos(
    @Body() dto: GenerateStoryboardVideosDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.generateStoryboardVideos(dto.items, req.user.id)
  }

  @ApiOperation({
    summary: "按 ID 批量获取分镜头（含席位视频状态，供前端轮询）",
    description: "ids 支持逗号分隔字符串（如 ?ids=1,2,3）或重复参数（?ids=1&ids=2）。",
  })
  @Get("storyboards")
  findStoryboardsByIds(@Query() query: QueryStoryboardIdsDto, @Request() req: AuthedRequest) {
    return this.customerService.findStoryboardsByIds(query.ids, req.user.id)
  }

  @ApiOperation({ summary: "标记/取消采纳分镜头席位视频（仅 SUCCESS 可采纳）" })
  @Patch("storyboard/video/:id")
  updateStoryboardVideoApproval(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateImageApprovalDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.updateStoryboardVideoApproval(id, dto.approved, req.user.id)
  }

  // ==================== 素材图片 ====================

  @ApiOperation({ summary: "AI 生成素材图片提示词（默认 5 个，已存在则直接返回不覆盖）" })
  @Post("project/:projectId/materials/generate")
  generateMaterials(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.generateMaterials(projectId, req.user.id)
  }

  @ApiOperation({ summary: "新增空白素材图片（最多 8 个，前端后续填写后调用生成接口）" })
  @Post("project/:projectId/material")
  createMaterial(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.createMaterial(projectId, req.user.id)
  }

  @ApiOperation({ summary: "删除素材图片 prompt" })
  @Delete("material/:id")
  removeMaterial(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.customerService.removeMaterial(id, req.user.id)
  }

  @ApiOperation({
    summary: "批量生成素材图片席位（Nano Banana，4 席位/素材，异步）",
    description:
      "请求体为素材图列表，单条生成传 1 项，一键全部生成传多项。每项仅回写 prompt 和垫图（purpose/ratio 保留 AI 初始值不覆盖），再触发 Nano Banana。立即返回所有受影响素材图的快照（席位 status=GENERATING），前端用 GET /customer/materials?ids=1,2,3 轮询状态。",
  })
  @Post("materials/generate-images")
  generateMaterialVariants(
    @Body() dto: GenerateMaterialVariantsDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.generateMaterialVariants(dto.items, req.user.id)
  }

  @ApiOperation({
    summary: "按 ID 批量获取素材图（含席位图片状态，供前端轮询）",
    description: "ids 支持逗号分隔字符串（如 ?ids=1,2,3）或重复参数（?ids=1&ids=2）。",
  })
  @Get("materials")
  findMaterialsByIds(@Query() query: QueryMaterialIdsDto, @Request() req: AuthedRequest) {
    return this.customerService.findMaterialsByIds(query.ids, req.user.id)
  }

  @ApiOperation({ summary: "标记/取消采纳素材图片席位" })
  @Patch("material/variant/:id")
  updateMaterialVariantApproval(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateImageApprovalDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.updateMaterialVariantApproval(id, dto.approved, req.user.id)
  }

  // ==================== 客户详情（通配路由放最后，避免吞掉 public-avatars 等静态路径） ====================

  @ApiOperation({ summary: "获取客户详情" })
  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.customerService.findOne(id, req.user.id)
  }

  @ApiOperation({ summary: "修改客户信息" })
  @Patch(":id")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateCustomerDto,
    @Request() req: AuthedRequest
  ) {
    return this.customerService.update(id, dto, req.user.id)
  }

  @ApiOperation({ summary: "重新生成客户运营方案" })
  @Post(":id/regenerate-strategy")
  regenerateStrategy(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.customerService.regenerateStrategy(id, req.user.id)
  }
}
