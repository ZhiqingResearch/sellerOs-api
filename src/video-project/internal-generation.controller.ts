import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { AiGatewayModelService } from "../ai-gateway/ai-gateway-model.service"
import { AiGatewayVideoQuoteDto } from "../ai-gateway/dto/ai-gateway-model.dto"
import { CreateInternalVideoTaskDto } from "./dto/create-internal-video-task.dto"
import { QueryInternalGenerationModelsDto } from "./dto/query-internal-generation-models.dto"
import { InternalGenerationGuard } from "./internal-generation.guard"
import { InternalGenerationService } from "./internal-generation.service"

/**
 * VidFlowOS 内部生成代理接口（X-Internal-Token 鉴权，非用户 JWT）。
 * 生成/生命周期/预检/扣费全部复用本平台现有链路；代办任务 source="vidflowos"。
 */
@ApiTags("内部生成代理（VidFlowOS）")
@UseGuards(InternalGenerationGuard)
@Controller("internal/generation")
export class InternalGenerationController {
  constructor(
    private readonly service: InternalGenerationService,
    private readonly models: AiGatewayModelService
  ) {}

  @Post("video-tasks")
  @ApiOperation({
    summary: "代提交视频任务",
    description:
      "body {phone, category, request}；手机号映射用户，预检不足 400（透传所需积分），任务行 source=vidflowos、vidflowos 专属 Key 提交网关",
  })
  createVideoTask(@Body() input: CreateInternalVideoTaskDto) {
    return this.service.createVideoTask(input)
  }

  @Get("video-tasks/:taskId")
  @ApiOperation({
    summary: "代办任务查询（含读时对账）",
    description:
      "返回 {status, resultUrl, errorMessage, costCny, creditsCharged, durationSec, resolution}；扣费留痕取自 UsageLog（requestId=gateway:{gatewayTaskId}）",
  })
  getVideoTask(@Param("taskId", ParseIntPipe) taskId: number) {
    return this.service.getVideoTask(taskId)
  }

  @Post("video-tasks/:taskId/cancel")
  @ApiOperation({ summary: "代办任务取消（vidflowos Key 调网关取消）" })
  cancelVideoTask(@Param("taskId", ParseIntPipe) taskId: number) {
    return this.service.cancelVideoTask(taskId)
  }

  @Get("models")
  @ApiOperation({ summary: "模型目录（只读，供 VidFlowOS 前端动态表单与美妆模型挑选）" })
  findModels(@Query() query: QueryInternalGenerationModelsDto) {
    return this.models.findAll(query)
  }

  @Post("models/quote")
  @ApiOperation({ summary: "视频模型单位报价（VidFlowOS 前端展示积分/秒或积分/次）" })
  quote(@Body() dto: AiGatewayVideoQuoteDto) {
    return this.models.quote(dto)
  }
}
