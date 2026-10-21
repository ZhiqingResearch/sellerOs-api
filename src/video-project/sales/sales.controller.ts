import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard"
import {
  CreateSalesProjectDto,
  GenerateSalesDto,
  SaveSalesMaterialsDto,
  SaveSalesProductDto,
  SaveSalesScriptDto,
} from "./sales.dto"
import { SalesService } from "./sales.service"

interface AuthedRequest {
  user: { id: number; phone: string; roleCode: string | null }
}

@ApiTags("视频创作 - 带货创作")
@ApiBearerAuth()
@Controller("video-project/sales")
@UseGuards(JwtAuthGuard)
export class SalesController {
  constructor(private readonly service: SalesService) {}

  @ApiOperation({
    summary: "新建带货项目",
    description:
      "建 type=ECOMMERCE 的视频项目并初始化带货向导（SalesWorkflow），返回项目 + 空向导。",
  })
  @Post()
  createProject(@Body() dto: CreateSalesProjectDto, @Request() req: AuthedRequest) {
    return this.service.createProject(dto, req.user.id)
  }

  @ApiOperation({
    summary: "读取带货向导状态",
    description:
      "返回整份向导（产品/痛点/素材/脚本配置 + 各分镜及其视频任务状态），用于回显、返回上一步、成片预览轮询。",
  })
  @Get(":projectId")
  getWorkflow(@Param("projectId", ParseIntPipe) projectId: number, @Request() req: AuthedRequest) {
    return this.service.getWorkflow(projectId, req.user.id)
  }

  @ApiOperation({
    summary: "Step1 保存产品 & 痛点",
    description:
      "保存产品图 + 信息源 + 原始输入 + 结构化商品信息 + 痛点（识图/手册/URL/痛点的 AI 解析均由前端完成，后端只存）。仅更新传入字段。",
  })
  @Patch(":projectId/product")
  saveProduct(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: SaveSalesProductDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.saveProduct(projectId, dto, req.user.id)
  }

  @ApiOperation({
    summary: "Step2 保存选素材",
    description:
      "保存数字人 / 场景快照（前端从素材池详情拍平或直传 URL）。字段传 null 表示清除该选择，省略则保持不变。",
  })
  @Patch(":projectId/materials")
  saveMaterials(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: SaveSalesMaterialsDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.saveMaterials(projectId, dto, req.user.id)
  }

  @ApiOperation({
    summary: "Step3 保存脚本（配置 + 分镜）",
    description:
      "保存出片参数（模型/总时长/声音/比例/分辨率）与分镜脚本（前端生成后写回；传入 segments 即全量替换）。",
  })
  @Patch(":projectId/script")
  saveScript(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: SaveSalesScriptDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.saveScript(projectId, dto, req.user.id)
  }

  @ApiOperation({
    summary: "Step4 确认出片（一键成片 / 分段生成）",
    description:
      "成片方式二选一：ONESHOT 一键成片把全部分镜拼接成 1 个全能参考（REFERENCE）任务、整片单视频；SEGMENTED 分段生成对每个分镜各建 1 个任务、可在成片预览按顺序合并。两者均以产品图+数字人肖像+场景图为参考素材，复用视频生成/扣费/转存链路；已成功或运行中的任务幂等跳过，失败/超时/取消可重试。",
  })
  @Post(":projectId/generate")
  generate(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: GenerateSalesDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.generate(projectId, dto, req.user.id)
  }
}
