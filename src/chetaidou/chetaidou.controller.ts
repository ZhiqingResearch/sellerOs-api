import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { ChetaidouResultService } from "./chetaidou-result.service"
import { InpaintResultDto, SaveResultTemplateDto, SaveResultMaterialDto } from "./dto/chetaidou-result.dto"
// 车泰斗素材工作台 — C 端接口（方案 §5.1/§5.2）
import {
  Body,
  BadRequestException,
  UploadedFiles,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common"
import { FileInterceptor, FileFieldsInterceptor } from "@nestjs/platform-express"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { ChetaidouService } from "./chetaidou.service"
import {
  AcknowledgeDto,
  AdjustmentListQueryDto,
  ApplyTaskDto,
  BreakdownRetryDto,
  ChetaidouResultIdsDto,
  ComposeAnswersDto,
  CreateTaskDto,
  ImageListQueryDto,
  ResultListQueryDto,
  RetryTaskDto,
  SaveChetaidouCropDto,
  TaskListQueryDto,
  TaskStatusQueryDto,
  UpdateDraftDto,
  WorkspaceMutationDto,
} from "./dto/chetaidou.dto"

interface AuthedRequest extends Request {
  user: { id: number; phone: string; role: string }
}

/** multipart 上传的母版文件（memoryStorage；字节校验在 service） */
interface UploadedMaster {
  buffer: Buffer
  originalname: string
  mimetype: string
  size: number
}

@ApiTags("chetaidou")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("tool.ai_creative_studio.chetaidou")
@Controller("chetaidou")
export class ChetaidouController {
  constructor(private readonly service: ChetaidouService, private readonly results: ChetaidouResultService) {}

  @Post("results/:resultId/inpaint")
  @HttpCode(202)
  @ApiOperation({ summary: "对成功成品局部重绘，保留原图并创建新生图任务" })
  @UseInterceptors(FileFieldsInterceptor([{ name: "annotatedImage", maxCount: 1 }, { name: "references" }]))
  async inpaint(@Request() req: AuthedRequest, @Param("resultId", ParseIntPipe) id: number,
    @Body("form") raw: string, @UploadedFiles() files: { annotatedImage?: UploadedMaster[]; references?: UploadedMaster[] }) {
    let value: unknown
    try { value = JSON.parse(raw) } catch { throw new BadRequestException("form 必须是有效 JSON") }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("form 必须是对象")
    const dto = plainToInstance(InpaintResultDto, value)
    const errors = await validate(dto, { whitelist: true, forbidUnknownValues: true })
    if (errors.length) throw new BadRequestException({ message: "局部重绘参数不合法", details: errors.map(e => ({ property: e.property, constraints: e.constraints, children: e.children })) })
    return this.results.inpaint(req.user.id, id, dto, files?.annotatedImage?.[0]!, files?.references)
  }

  @Post("results/:resultId/save-to-template")
  @HttpCode(200)
  @ApiOperation({ summary: "将成品持久保存到个人模板，支持新建和追加" })
  saveResultTemplate(@Request() req: AuthedRequest, @Param("resultId", ParseIntPipe) id: number, @Body() dto: SaveResultTemplateDto) {
    return this.results.saveTemplate(req.user.id, id, dto)
  }

  @Post("results/:resultId/save-to-material-pool")
  @HttpCode(200)
  @ApiOperation({ summary: "将成品持久保存到本人素材池" })
  saveResultMaterial(@Request() req: AuthedRequest, @Param("resultId", ParseIntPipe) id: number, @Body() dto: SaveResultMaterialDto) {
    return this.results.saveMaterial(req.user.id, id, dto)
  }

  @Get("config")
  @ApiOperation({ summary: "工作台配置（站点/模式/限制/能力/模型就绪）" })
  async getConfig() {
    return this.service.getConfig()
  }

  @Get("skus")
  @ApiOperation({ summary: "SKU 列表（首期仅 CS1plus）" })
  async listSkus() {
    return this.service.listSkus()
  }

  @Get("skus/:skuId/images")
  @ApiOperation({ summary: "母版列表（预置 ∪ 本人上传）" })
  async listImages(
    @Request() req: AuthedRequest,
    @Param("skuId", ParseIntPipe) skuId: number,
    @Query() query: ImageListQueryDto
  ) {
    return this.service.listImages(req.user.id, skuId, {
      keyword: query.keyword,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    })
  }

  @Post("skus/:skuId/images")
  @HttpCode(202)
  @ApiOperation({
    summary: "上传新母版（multipart file + idempotencyKey + title），自动创建拆解任务",
  })
  @UseInterceptors(FileInterceptor("file"))
  async uploadImage(
    @Request() req: AuthedRequest,
    @Param("skuId", ParseIntPipe) skuId: number,
    @UploadedFile() file: UploadedMaster | undefined,
    @Body() body: { idempotencyKey: string; title?: string }
  ) {
    if (!file?.buffer?.length) {
      return {
        statusCode: 400,
        code: "FILE_UNSUPPORTED",
        message: "缺少上传文件",
      }
    }
    return this.service.uploadImage(req.user.id, skuId, file, body)
  }

  @Get("images/:id")
  @ApiOperation({ summary: "母版详情 + 当前拆解" })
  async getImage(@Request() req: AuthedRequest, @Param("id", ParseIntPipe) id: number) {
    return this.service.getImage(req.user.id, id)
  }

  @Delete("images/:id")
  @HttpCode(200)
  @ApiOperation({ summary: "移除本人上传的母版（逻辑移除，重复请求幂等，保留历史任务与结果）" })
  async removeImage(@Request() req: AuthedRequest, @Param("id", ParseIntPipe) id: number) {
    return this.service.removeImage(req.user.id, id)
  }

  @Post("images/:id/acknowledge")
  @ApiOperation({ summary: "AI 拆解已读确认" })
  async acknowledge(
    @Request() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: AcknowledgeDto
  ) {
    return this.service.acknowledge(req.user.id, id, dto.breakdownId, dto.draftRevision)
  }

  @Get("images/:id/draft")
  @ApiOperation({ summary: "读取草稿" })
  async getDraft(@Request() req: AuthedRequest, @Param("id", ParseIntPipe) id: number) {
    return this.service.getDraft(req.user.id, id)
  }

  @Put("images/:id/draft")
  @ApiOperation({ summary: "保存草稿（CAS revision，不匹配 409）" })
  async putDraft(
    @Request() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateDraftDto
  ) {
    return this.service.putDraft(req.user.id, id, {
      revision: dto.revision,
      workspaceId: dto.workspaceId,
      settings: dto.settings as never,
      selections: dto.selections,
      customDimensions: dto.customDimensions,
    })
  }

  @Post("images/:id/draft/reset")
  @HttpCode(200)
  @ApiOperation({ summary: "新建空白调整，恢复默认，不创建历史" })
  resetDraft(
    @Request() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: WorkspaceMutationDto
  ) {
    return this.service.resetDraft(
      req.user.id,
      id,
      dto as { workspaceId: string; revision: number }
    )
  }

  @Get("images/:id/adjustments")
  @ApiOperation({ summary: "本人母版的调整历史" })
  listAdjustments(
    @Request() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Query() query: AdjustmentListQueryDto
  ) {
    return this.service.listAdjustments(req.user.id, id, query)
  }

  @Get("images/:id/adjustments/:adjustmentId")
  @ApiOperation({ summary: "调整历史完整状态及任务" })
  getAdjustment(
    @Request() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Param("adjustmentId", ParseUUIDPipe) adjustmentId: string
  ) {
    return this.service.getAdjustment(req.user.id, id, adjustmentId)
  }

  @Post("images/:id/adjustments/:adjustmentId/restore")
  @HttpCode(200)
  @ApiOperation({ summary: "恢复历史为当前工作副本，不调用模型、不扣费" })
  restoreAdjustment(
    @Request() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Param("adjustmentId", ParseUUIDPipe) adjustmentId: string,
    @Body() dto: WorkspaceMutationDto
  ) {
    return this.service.restoreAdjustment(
      req.user.id,
      id,
      adjustmentId,
      dto as { workspaceId: string; revision: number }
    )
  }

  @Get("skus/:skuId/filter-options")
  @ApiOperation({ summary: "全部站点及当前 SKU 可见母版筛选项" })
  filterOptions(@Request() req: AuthedRequest, @Param("skuId", ParseIntPipe) skuId: number) {
    return this.service.filterOptions(req.user.id, skuId)
  }

  @Post("images/:id/breakdown/retry")
  @ApiOperation({ summary: "重试拆解（仅上传图；同图进行中 409）" })
  async retryBreakdown(
    @Request() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: BreakdownRetryDto
  ) {
    return this.service.retryBreakdown(req.user.id, id, dto.idempotencyKey)
  }

  @Post("tasks")
  @HttpCode(202)
  @ApiOperation({
    summary: "创建任务（IDEATION/REFRESH_GROUP/DIVERGE/COMPOSE/GENERATE；幂等键去重）",
  })
  async createTask(@Request() req: AuthedRequest, @Body() dto: CreateTaskDto) {
    return this.service.createTask(req.user.id, dto)
  }

  @Get("tasks")
  @ApiOperation({ summary: "本人根任务列表（status/type/skuId + 分页）" })
  async listTasks(@Request() req: AuthedRequest, @Query() query: TaskListQueryDto) {
    return this.service.listTasks(req.user.id, {
      status: query.status,
      site: query.site,
      type: query.type,
      skuId: query.skuId,
      imageId: query.imageId,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    })
  }

  // 静态路由必须在 :id 之前声明
  @Get("tasks/status")
  @ApiOperation({ summary: "批量任务状态快照（轻量轮询）" })
  async tasksStatus(@Request() req: AuthedRequest, @Query() query: TaskStatusQueryDto) {
    const ids = (query.ids ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
    return this.service.tasksStatus(req.user.id, ids)
  }

  @Get("tasks/:id")
  @ApiOperation({ summary: "任务详情（状态/进度/子项摘要；不含内部快照）" })
  async getTask(@Request() req: AuthedRequest, @Param("id") id: string) {
    return this.service.getTask(req.user.id, id)
  }

  @Get("tasks/:id/output")
  @ApiOperation({ summary: "已校验业务产物（组合/刷新/发散/拆解/生图项）" })
  async getTaskOutput(@Request() req: AuthedRequest, @Param("id") id: string) {
    return this.service.getTaskOutput(req.user.id, id)
  }

  @Get("tasks/:id/groups/:groupId")
  @ApiOperation({ summary: "维度组完整 options（按组加载）" })
  async getTaskGroup(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
    @Param("groupId") groupId: string
  ) {
    return this.service.getTaskGroup(req.user.id, id, groupId)
  }

  @Post("tasks/:id/retry")
  @ApiOperation({ summary: "定向重试（仅失败维/失败图）" })
  async retryTask(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
    @Body() dto: RetryTaskDto
  ) {
    return this.service.retryTask(req.user.id, id, dto)
  }

  @Post("tasks/:id/cancel")
  @ApiOperation({ summary: "取消（仅未发出的工作；已发供应商不保证终止）" })
  async cancelTask(@Request() req: AuthedRequest, @Param("id") id: string) {
    return this.service.cancelTask(req.user.id, id)
  }

  @Post("tasks/:id/apply")
  @ApiOperation({ summary: "应用有效刷新/发散产物到草稿（不重新调用模型）" })
  async applyTask(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
    @Body() dto: ApplyTaskDto
  ) {
    return this.service.applyTask(req.user.id, id, dto.draftRevision, dto.workspaceId)
  }

  @Post("tasks/:id/discard")
  @HttpCode(200)
  @ApiOperation({ summary: "放弃未应用的发散结果（幂等，不撤销已发生费用）" })
  async discardTask(@Request() req: AuthedRequest, @Param("id") id: string) {
    return this.service.discardTask(req.user.id, id)
  }

  @Get("compositions/:id")
  @ApiOperation({ summary: "组合详情（:id = COMPOSE 根任务 ID）" })
  async getComposition(@Request() req: AuthedRequest, @Param("id") id: string) {
    return this.service.getComposition(req.user.id, id)
  }

  @Get("compositions/:id/prompt")
  @ApiOperation({ summary: "完整英文编辑指令（折叠展示用，只读）" })
  async getCompositionPrompt(@Request() req: AuthedRequest, @Param("id") id: string) {
    return this.service.getCompositionPrompt(req.user.id, id)
  }

  @Post("compositions/:id/answers")
  @HttpCode(202)
  @ApiOperation({ summary: "提交全部冲突答案（触发新一轮组合检查，新建 COMPOSE 根任务）" })
  async submitAnswers(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
    @Body() dto: ComposeAnswersDto
  ) {
    return this.service.submitAnswers(req.user.id, id, dto)
  }

  @Get("skus/:skuId/results")
  @ApiOperation({ summary: "预览墙（按 SKU，含占位/失败位）" })
  async listResults(
    @Request() req: AuthedRequest,
    @Param("skuId", ParseIntPipe) skuId: number,
    @Query() query: ResultListQueryDto
  ) {
    return this.service.listResults(req.user.id, skuId, {
      site: query.site,
      imageId: query.imageId,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    })
  }

  @Post("crops/upload-url")
  @HttpCode(200)
  @ApiOperation({ summary: "生成前端裁剪 PNG 的公开直传凭证" })
  async cropUploadUrl(@Request() req: AuthedRequest) {
    return this.service.cropUploadUrl(req.user.id)
  }

  @Post("results/:id/crops")
  @HttpCode(200)
  @ApiOperation({ summary: "保存前端裁剪的 PNG 到预览墙（不生成、不扣费）" })
  async saveCrop(
    @Request() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: SaveChetaidouCropDto
  ) {
    return this.service.saveCrop(req.user.id, id, dto.url, dto.idempotencyKey)
  }

  @Get("results/:id/download")
  @ApiOperation({ summary: "下载（resultId = ImageGenItem.id；签名短时效）" })
  async downloadResult(@Request() req: AuthedRequest, @Param("id", ParseIntPipe) id: number) {
    return this.service.downloadResult(req.user.id, id)
  }

  @Post("skus/:skuId/results/batch-download")
  @HttpCode(200)
  @ApiOperation({ summary: "批量下载预览墙成功图片清单（短时签名，不返回 ZIP）" })
  async batchDownloadResults(
    @Request() req: AuthedRequest,
    @Param("skuId", ParseIntPipe) skuId: number,
    @Body() dto: ChetaidouResultIdsDto
  ) {
    return this.service.batchDownloadResults(req.user.id, skuId, dto.resultIds)
  }

  @Post("skus/:skuId/results/batch-delete")
  @HttpCode(200)
  @ApiOperation({ summary: "批量软删除预览墙终态图片（幂等，不退款、不立即删除文件）" })
  async batchDeleteResults(
    @Request() req: AuthedRequest,
    @Param("skuId", ParseIntPipe) skuId: number,
    @Body() dto: ChetaidouResultIdsDto
  ) {
    return this.service.batchDeleteResults(req.user.id, skuId, dto.resultIds)
  }
}
