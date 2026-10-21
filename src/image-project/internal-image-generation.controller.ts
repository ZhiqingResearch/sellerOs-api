import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { InternalGenerationGuard } from "../video-project/internal-generation.guard"
import { InternalCreateAiSplitTaskDto } from "./internal-ai-split.dto"
import {
  InternalImageGenerationService,
  type InternalArchiveI2IInput,
  type InternalCreateImageTaskInput,
  type InternalCreatePortraitTaskInput,
} from "./internal-image-generation.service"

/**
 * VidFlowOS 内部图片生成代理接口（X-Internal-Token 鉴权，与视频/扣费同一 token）。
 * 三条管线：通用生图 / 人像创作 / AI 拆图。
 */
@ApiTags("内部图片生成（VidFlowOS）")
@UseGuards(InternalGenerationGuard)
@Controller("internal/generation/image")
export class InternalImageGenerationController {
  constructor(private readonly service: InternalImageGenerationService) {}

  // ═══════════ 通用生图 ═══════════

  @Post("tasks")
  @ApiOperation({
    summary: "代提交通用生图任务",
    description:
      "body {phone, request: {model, prompt, count, aspectRatio, referenceImageUrls?, negativePrompt?}}；手机号映射用户，一口价预检，vidflowos Key 提交网关，webhook 收敛扣费",
  })
  createGeneralTask(@Body() input: InternalCreateImageTaskInput) {
    return this.service.createGeneralTask(input)
  }

  // ═══════════ 人像创作 ═══════════

  @Post("portrait-tasks")
  @ApiOperation({
    summary: "代提交人像创作任务",
    description: "body {phone, request: <PortraitCreationService DTO>}；代理到现有 Service 全链路（校验/尺寸计划/预检/Runner）",
  })
  createPortraitTask(@Body() input: InternalCreatePortraitTaskInput) {
    return this.service.createPortraitTask(input)
  }

  // ═══════════ AI 拆图 ═══════════

  @Post("ai-split-tasks")
  @ApiOperation({
    summary: "代提交 AI 拆图任务组",
    description:
      "body {phone, request: {competitorReferences: DIRECT_URL[], productSnapshot, ...生成参数}}；当前商品只使用本次请求快照，本地素材 ID 不跨系统解析",
  })
  createAiSplitTasks(@Body() input: InternalCreateAiSplitTaskDto) {
    return this.service.createAiSplitTasks(input)
  }

  // ═══════════ 批量改图归档 ═══════════

  @Post("i2i-archive")
  @ApiOperation({
    summary: "批量改图成品归档（sourceJobId 回链 + 计费挂账去重）",
    description:
      "body {phone, request: <CreateTaskDto 形状>}；request.sourceJobId 回写 ImageGenJob.taskId，" +
      "生成记录视图把该 job 的扣费积分挂到入库行并隐藏原 IMAGEGEN 行；" +
      "幂等：job 已归档过时返回 {taskId, duplicate: true} 不重复建行",
  })
  archiveI2I(@Body() input: InternalArchiveI2IInput) {
    return this.service.archiveI2I(input)
  }

  // ═══════════ 统一查询（三种任务共用） ═══════════

  @Get("tasks/:taskId")
  @ApiOperation({
    summary: "查询图片任务（含读时对账 + 扣费留痕）",
    description:
      "返回 {status, errorMessage, aiSplitStage, costCny, creditsCharged, images: [{id, status, url, width, height}]}",
  })
  getImageTask(@Param("taskId", ParseIntPipe) taskId: number) {
    return this.service.getImageTask(taskId)
  }
}
