// src/image-generation/internal-image-to-image.controller.ts
//
// VidFlowOS 内部批量改图（image-to-image）代理接口。multipart 二进制直转
// 给现有 ImageToImageService（校验/一口价预检/Spaces 上传/DispatchQueue 执行/
// 服务端按成功张数扣费全复用，零新逻辑），手机号映射用户后与公开接口同一
// userId 口径，内部入口额外限定 source=vidflowos。
// 不挂公开侧 InvalidMultipartFilter——内部调用方走全局 {statusCode, message}
// 包络，vidflowos 按 message 透传文案（与 LLM 工具箱内部接口同一契约）。

import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { InternalGenerationGuard } from "../video-project/internal-generation.guard";
import { ImageToImageService, type I2IUploadFiles } from "./image-to-image.service";
import { readImageUsage } from "./image-usage"
import { LocalRedrawPlan } from "./local-redraw.constants"
import { imageMetadata, modelDisplayNames } from "../common/utils/generation-metadata"

@ApiTags("内部批量改图（VidFlowOS）")
@ApiHeader({ name: "X-Internal-Token", required: true, description: "与视频转发接口相同的内部令牌" })
@UseGuards(InternalGenerationGuard)
@Controller("internal/generation/image/i2i")
export class InternalImageToImageController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly i2i: ImageToImageService,
  ) {}

  @Post()
  @ApiOperation({
    summary: "代发起批量/单图改图（multipart）",
    description:
      "multipart {phone, form(JSON 字符串文本字段), main/character/style/scene(各1) refs/references(各≤30) 文件}；" +
      "form.market 可选（如 tiktok_mx），传入后使用站点语言规则，未传保持原行为；" +
      "返回 {jobId, taskId, traceId, total, items} 原样透传；30 分钟内可轮询快照",
  })
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "main", maxCount: 1 },
        { name: "character", maxCount: 1 },
        { name: "style", maxCount: 1 },
        { name: "scene", maxCount: 1 },
        { name: "refs", maxCount: 30 },
        { name: "references", maxCount: 30 },
      ],
      { limits: { fileSize: 50 * 1024 * 1024, files: 40 } },
    ),
  )
  async create(
    @UploadedFiles() files: I2IUploadFiles,
    @Req() req: Request,
  ): Promise<{
    jobId: string;
    taskId: string;
    traceId: string;
    total: number;
    items: Array<{ index: number; typeKey: string; label: string }>;
    localRedraw?: LocalRedrawPlan;
  }> {
    const body = req.body as Record<string, unknown> | undefined;
    const user = await this.mapUser(String(body?.phone ?? ""));
    const result = await this.i2i.create({ form: body?.form, files }, user.id, "vidflowos");
    if (!result.ok) {
      if (result.status === 503) throw new HttpException(result.error, result.status);
      throw new BadRequestException(result.error);
    }
    return {
      jobId: result.jobId,
      taskId: result.taskId,
      traceId: result.traceId,
      total: result.total,
      items: result.items,
      ...(result.localRedraw ? { localRedraw: result.localRedraw } : {}),
    };
  }

  @Get(":jobId")
  @ApiQuery({ name: "phone", description: "发起用户手机号（job 归属校验）", required: true })
  @ApiOperation({
    summary: "查询改图 job 快照",
    description: "返回 I2IJobSnapshot 原样透传；过期（30 分钟）/不存在/非本人 → 404",
  })
  async get(@Param("jobId") jobId: string, @Query("phone") phone: string) {
    const user = await this.mapUser(String(phone ?? ""));
    const snapshot = await this.i2i.getSnapshot(jobId, user.id, "vidflowos");
    if (!snapshot) {
      throw new NotFoundException("Job not found");
    }
    return snapshot;
  }

  @Get(":jobId/usage")
  @ApiQuery({ name: "phone", required: true })
  @ApiOperation({ summary: "查询改图使用回执（不受产物快照 30 分钟窗口限制，不触发扣费）" })
  async getUsage(@Param("jobId") jobId: string, @Query("phone") phone: string) {
    const user = await this.mapUser(String(phone ?? ""))
    const job = await this.prisma.imageGenJob.findFirst({
      where: { id: jobId, userId: user.id, source: "vidflowos", kind: "IMAGE_TO_IMAGE" },
      include: { items: { orderBy: { idx: "asc" } } },
    })
    if (!job) throw new NotFoundException("Job not found")
    const terminal =
      job.items.length > 0 &&
      job.items.every(item => item.status === "SUCCEEDED" || item.status === "FAILED")
    const firstSuccess = job.items.find(item => item.status === "SUCCEEDED")
    const status = terminal
      ? firstSuccess
        ? "SUCCESS"
        : "FAILED"
      : job.status === "FAILED"
        ? "FAILED"
        : "GENERATING"
    const modelPublicId = imageMetadata({ model: job.model, executionSpec: job.request }).modelPublicId ?? job.model
    const names = await modelDisplayNames(this.prisma, [modelPublicId])
    return {
      status,
      displayName: names.get(modelPublicId ?? "") ?? null,
      resultUrl: firstSuccess?.url ?? null,
      errorMessage:
        status === "FAILED"
          ? (job.items.find(item => item.errorMessage)?.errorMessage ?? "图片生成失败")
          : null,
      ...(await readImageUsage(this.prisma, user.id, { jobId })),
    }
  }

  /** 手机号映射用户（与内部扣费/生成接口同款：404 + USER_NOT_FOUND 供调用方转译） */
  private async mapUser(phone: string) {
    const user = await this.prisma.user.findUnique({
      where: { phone: phone.trim() },
      select: { id: true },
    });
    if (!user) throw new NotFoundException({ code: "USER_NOT_FOUND" });
    return user;
  }
}
