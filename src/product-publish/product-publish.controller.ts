import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Request,
  Sse,
  UseGuards,
  type MessageEvent,
} from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"
import type { Observable } from "rxjs"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PaginationDto } from "../common/dto/pagination.dto"
import { ProductPublishEventsService } from "./product-publish-events.service"
import { ProductPublishRpaService } from "./product-publish-rpa.service"
import { ProductPublishStoreService } from "./product-publish-store.service"
import {
  CompleteProductPublishTaskDto,
  CreateProductPublishTaskDto,
  ProductPublishRpaCallbackDto,
  QueryProductPublishRecordsDto,
  SpreadsheetUploadUrlDto,
  SubmitProductPublishDto,
  UpdateProductPublishTaskDto,
  WashImageLinksDto,
} from "./product-publish.dto"
import { ProductPublishService } from "./product-publish.service"

interface AuthedRequest {
  user: { id: number; phone: string; roleCode: string | null }
}

@ApiTags("一键上架 RPA 内部回调")
@Controller("product-publish/internal/rpa")
export class ProductPublishRpaInternalController {
  constructor(private readonly rpaService: ProductPublishRpaService) {}

  @Post("results")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "接收一键上架 RPA 处理结果",
    description:
      "供 RPA 服务调用的内部回调，不使用 JWT。请求必须携带 X-API-Key，业务结果按店铺和任务参数关联；request_id 可选。",
  })
  @ApiHeader({
    name: "X-API-Key",
    required: true,
    description: "一键上架 RPA 独立回调密钥",
  })
  @ApiOkResponse({ description: "回调已成功校验并处理" })
  @ApiBadRequestResponse({ description: "回调协议、字段组合或业务数据不合法" })
  @ApiUnauthorizedResponse({ description: "X-API-Key 缺失或不正确" })
  handleResult(
    @Headers("x-api-key") apiKey: string | undefined,
    @Body() dto: ProductPublishRpaCallbackDto
  ) {
    return this.rpaService.handleCallback(apiKey, dto)
  }
}

@ApiTags("一键上架")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("product-publish")
export class ProductPublishController {
  constructor(
    private readonly service: ProductPublishService,
    private readonly storeService: ProductPublishStoreService,
    private readonly rpaService: ProductPublishRpaService,
    private readonly eventsService: ProductPublishEventsService
  ) {}

  @ApiOperation({
    summary: "订阅一键上架实时事件",
    description:
      "Bearer JWT 鉴权的 SSE 长连接。RPA 查询结果回调落库后推送 product-publish-refresh-completed 事件。",
  })
  @ApiProduces("text/event-stream")
  @Header("X-Accel-Buffering", "no")
  @Sse("events")
  events(@Request() req: AuthedRequest): Observable<MessageEvent> {
    return this.eventsService.streamForUser(req.user.id)
  }

  @ApiOperation({ summary: "获取一级分类及对应模板 URL" })
  @Get("classifications")
  getClassifications() {
    return this.service.getClassifications()
  }

  @ApiOperation({ summary: "获取可用店铺、店铺分类及对应模板 URL" })
  @Get("stores")
  findStores() {
    return this.storeService.findAllActive()
  }

  @ApiOperation({ summary: "创建一键上架草稿" })
  @Post("tasks")
  createTask(@Body() dto: CreateProductPublishTaskDto, @Request() req: AuthedRequest) {
    return this.service.createTask(dto, req.user.id)
  }

  @ApiOperation({ summary: "草稿数量" })
  @Get("tasks/draft-count")
  countDrafts(@Request() req: AuthedRequest) {
    return this.service.countDrafts(req.user.id)
  }

  @ApiOperation({ summary: "草稿列表" })
  @Get("tasks/drafts")
  findDrafts(@Query() query: PaginationDto, @Request() req: AuthedRequest) {
    return this.service.findDrafts(query.page, query.pageSize, req.user.id)
  }

  @ApiOperation({ summary: "通过 taskId 查询任务" })
  @Get("tasks/:taskId")
  findTask(@Param("taskId") taskId: string, @Request() req: AuthedRequest) {
    return this.service.findTask(taskId, req.user.id)
  }

  @ApiOperation({ summary: "增量保存一键上架任务" })
  @Patch("tasks/:taskId")
  updateTask(
    @Param("taskId") taskId: string,
    @Body() dto: UpdateProductPublishTaskDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.updateTask(taskId, dto, req.user.id)
  }

  @ApiOperation({ summary: "生成最终表格的 Spaces 预签名上传 URL" })
  @Post("tasks/:taskId/spreadsheet-upload-url")
  spreadsheetUploadUrl(
    @Param("taskId") taskId: string,
    @Body() dto: SpreadsheetUploadUrlDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.generateSpreadsheetUploadUrl(taskId, dto, req.user.id)
  }

  @ApiOperation({ summary: "完成任务并保存最终表格链接" })
  @Post("tasks/:taskId/complete")
  completeTask(
    @Param("taskId") taskId: string,
    @Body() dto: CompleteProductPublishTaskDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.completeTask(taskId, dto, req.user.id)
  }

  @ApiOperation({ summary: "提交 Amazon 上架任务" })
  @Post("tasks/:taskId/publish")
  @HttpCode(HttpStatus.ACCEPTED)
  submitPublish(
    @Param("taskId") taskId: string,
    @Body() dto: SubmitProductPublishDto,
    @Request() req: AuthedRequest
  ) {
    return this.rpaService.submitPublish(taskId, dto.fileUrl, dto.skus, req.user.id)
  }

  @ApiOperation({ summary: "主动刷新 Amazon 上架处理结果" })
  @Post("tasks/:taskId/publish/refresh")
  @HttpCode(HttpStatus.ACCEPTED)
  refreshPublishResult(@Param("taskId") taskId: string, @Request() req: AuthedRequest) {
    return this.rpaService.refreshPublishResult(taskId, req.user.id)
  }

  @ApiOperation({ summary: "使用薄荷图床批量洗图片链接（顺序处理）" })
  @Post("tasks/:taskId/wash-image-links")
  washImageLinks(
    @Param("taskId") taskId: string,
    @Body() dto: WashImageLinksDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.washImageLinks(taskId, dto, req.user.id)
  }

  @ApiOperation({ summary: "上架记录列表" })
  @Get("records")
  findRecords(@Query() query: QueryProductPublishRecordsDto, @Request() req: AuthedRequest) {
    return this.service.findRecords(query, req.user.id)
  }

  @ApiOperation({ summary: "删除上架记录（软删除）" })
  @Delete("records/:taskId")
  deleteRecord(@Param("taskId") taskId: string, @Request() req: AuthedRequest) {
    return this.service.deleteRecord(taskId, req.user.id)
  }
}
