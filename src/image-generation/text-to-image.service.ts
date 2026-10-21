import { gatewayImageDimensions, gatewayOriginalUrl, modelDisplayNames, jsonObject } from "../common/utils/generation-metadata";
// src/image-generation/text-to-image.service.ts
//
// t2i 创建/查询,行为逐条对齐 amazon-agent 的
// src/app/api/ai-creative/text-to-image 路由(校验、默认值、消息、快照契约):
//   POST → { jobId }(立即返回,执行由 DispatchQueue 后台跑)
//   GET  → { status: pending|done|error, url?, error?, usage? };过期/不存在 404

import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { IMAGE_CREATIVE_BUSINESS_TYPE } from "../chetaidou/chetaidou.constants";
import { PrismaService } from "../prisma/prisma.service";
import { UsageService } from "../usage/usage.service";
import type { AspectRatio, ResolutionTier } from "./core/types";
import { DispatchQueueService } from "./executor/dispatch-queue.service";
import { ImageGenItemRunnerService } from "./executor/image-gen-item-runner.service";
import { loadImageGenerationFixedCredits } from "./models.service";
import { isImageAspectRatio } from "./core/size-adapters";
import { resolveGatewayModel } from "./providers/gateway-mapping";

const RETENTION_MS = 30 * 60_000; // 与 Next t2i-job-store 的 30 分钟保留一致

const VALID_RESOLUTION_TIERS = new Set<ResolutionTier>(["1K", "2K", "4K"]);

export interface TextToImageBody {
  provider?: string;
  prompt?: string;
  negativePrompt?: string;
  aspectRatio?: string;
  resolutionTier?: string;
}

export type CreateResult =
  | { ok: true; jobId: string }
  | { ok: false; status: number; error: string };

export interface T2ISnapshot {
  status: "pending" | "done" | "error";
  url?: string;
  error?: string;
  usage?: unknown;
  gatewayImage?: unknown;
  width?: number | null;
  originalUrl?: string | null;
  height?: number | null;
  modelPublicId?: string | null;
  displayName?: string | null;
  resolutionTier?: string | null;
  /** 计费统一(2026-09-01):后端执行器已对成功图服务端扣费,前端调用方
   *  见此标记跳过自身 usage 上报(见 amazon-agent pollTextToImage)。 */
  serverBilled?: boolean;
}

@Injectable()
export class TextToImageService {
  private readonly logger = new Logger(TextToImageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: DispatchQueueService,
    private readonly runner: ImageGenItemRunnerService,
    private readonly usage: UsageService,
  ) {}

  async create(body: TextToImageBody, userId: number): Promise<CreateResult> {
    // 校验逻辑与消息逐条对齐 Next 路由。B4(2026-09-10)网关单通道:
    // 退役槽位(无网关对应)400;目录直传的动态 model id 放行,由网关校验。
    const provider = body.provider;
    if (typeof provider !== "string" || resolveGatewayModel(provider) === null) {
      return {
        ok: false,
        status: 400,
        error: `Unsupported provider: ${String(provider)}`,
      };
    }

    const basePrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!basePrompt) {
      return { ok: false, status: 400, error: "`prompt` is required" };
    }

    // Providers 无独立负向输入——并入正向 prompt(与 Next 路由一致)。
    const negative =
      typeof body.negativePrompt === "string" ? body.negativePrompt.trim() : "";
    const prompt = negative
      ? `${basePrompt}\n\nNegative prompt: ${negative}`
      : basePrompt;

    const aspectRatio: AspectRatio =
      isImageAspectRatio(body.aspectRatio)
        ? body.aspectRatio
        : "16:9";
    // 3K 已被网关下线(2026-09-14 全目录 resolution 枚举仅 1k/2k/4k):显式
    // 降档 2K 兼容存量前端(其余非法值照源路由默认 2K)。
    const resolutionTier: ResolutionTier =
      body.resolutionTier === "3K"
        ? "2K"
        : typeof body.resolutionTier === "string" &&
            VALID_RESOLUTION_TIERS.has(body.resolutionTier as ResolutionTier)
          ? (body.resolutionTier as ResolutionTier)
          : "2K";

    // 固定一口价预检：模型目录行配置 fixedCredits → 按「单价 × 张数(此处 1)」
    // 校验余额（不打折口径，与执行器终态扣费同源）；未配置回落现状不预检。
    const fixedCredits = await loadImageGenerationFixedCredits(this.usage, provider);
    if (fixedCredits) {
      try {
        await this.usage.assertExactCreditsAffordable(userId, fixedCredits);
      } catch (err) {
        return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const jobId = randomUUID();
    await this.prisma.imageGenJob.create({
      data: {
        id: jobId,
        userId,
        kind: "TEXT_TO_IMAGE",
        businessType: IMAGE_CREATIVE_BUSINESS_TYPE,
        status: "RUNNING",
        request: {
          kind: "TEXT_TO_IMAGE",
        businessType: IMAGE_CREATIVE_BUSINESS_TYPE,
          provider,
          modelPublicId: resolveGatewayModel(provider) ?? provider,
          prompt,
          aspectRatio,
          resolutionTier,
        },
        // 审计快照列(生成记录视图筛选/分组用),与 request 同源
        model: provider,
        prompt,
        expiresAt: new Date(Date.now() + RETENTION_MS),
        items: {
          create: [{ idx: 0, status: "QUEUED" }],
        },
      },
    });

    // 立即返回;执行与 Next 的 after() 一样后台进行,但真相已落库。
    const item = await this.prisma.imageGenItem.findFirst({
      where: { jobId },
      select: { id: true },
    });
    this.queue.enqueue(() => this.runner.executeItem(item!.id));

    return { ok: true, jobId };
  }

  /** 过期或不存在 → null(控制器 404);否则投影快照。 */
  async getSnapshot(jobId: string): Promise<T2ISnapshot | null> {
    const job = await this.prisma.imageGenJob.findUnique({
      where: { id: jobId, source: "platform", kind: "TEXT_TO_IMAGE" },
      include: { items: { orderBy: { idx: "asc" } } },
    });
    if (!job) return null;
    // expiresAt 可空（CHETAIDOU 恒 null）；旧来源为空视为无效记录
    if (job.expiresAt === null) {
      this.logger.warn(`ImageGenJob ${job.id} 缺少 expiresAt（非通用生图管线记录），按无效处理`);
      return null;
    }
    if (job.expiresAt.getTime() < Date.now()) return null;

    const item = job.items[0];
    if (!item) return { status: "pending" };
    if (item.status === "SUCCEEDED") {
      const request = jsonObject(job.request);
      const publicId = request.modelPublicId ?? jsonObject(item.gatewayImage).modelPublicId ?? job.model;
      const names = await modelDisplayNames(this.prisma, [publicId]);
      return {
        status: "done",
        url: item.url!,
        originalUrl: gatewayOriginalUrl(item.gatewayImage),
        usage: item.usage ?? undefined,
        gatewayImage: item.gatewayImage ?? undefined,
        width: item.width ?? gatewayImageDimensions(item.gatewayImage).width ?? null,
        height: item.height ?? gatewayImageDimensions(item.gatewayImage).height ?? null,
        modelPublicId: publicId,
        displayName: names.get(publicId) ?? job.model ?? request.provider ?? null,
        resolutionTier: request.resolutionTier ?? null,
        serverBilled: true,
      };
    }
    if (item.status === "FAILED") {
      return { status: "error", error: item.errorMessage ?? "生成失败" };
    }
    return { status: "pending" };
  }
}
