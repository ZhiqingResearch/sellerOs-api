import type { ProviderGenerateResult } from "../core/types";
// src/image-generation/executor/image-gen-item-runner.service.ts
//
// t2i/i2i(ImageGenJob/ImageGenItem)单图执行器,步骤对齐设计 §5.3:
//   CAS 认领(租约) → 冻结输入重建 provider 调用 → hostImage 托管 →
//   CAS 写结果(WHERE status='RUNNING') → 全图终态时聚合 Job。
// 取消/租约过期后晚到结果被 CAS 前置条件自然挡掉,不会覆盖终态。
// 瞬态失败(2026-09-10 T8):RelayError transient_* 且预算未耗尽时 CAS
// RUNNING→QUEUED(清租约)后按退避档重投本进程执行;permanent_* 与预算
// 耗尽仍直接 FAILED —— 重试参数/鉴权/额度/尺寸能力类失败只会重复扣
// 网关额度。IMAGE_GEN_INPROCESS_RETRY=off 一键回退无重试现状。

import { Inject, Injectable, Logger } from "@nestjs/common";
import { InvokeType } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library";
import {
  FALLBACK_MARKETPLACE_LANGUAGE,
  marketplaceLanguageHead,
  marketplaceLanguageTail,
  resolveMarketplaceLanguage,
} from "../../common/utils/marketplace-language"
import { IMAGE_CREATIVE_BUSINESS_TYPE } from "../../chetaidou/chetaidou.constants";
import { PrismaService } from "../../prisma/prisma.service";
import { CREDIT_PER_CNY } from "../../membership/membership.constants";
import { UsageService } from "../../usage/usage.service";
import { IMAGE_PIPELINE_IDEMPOTENCY_PREFIX } from "../../ai-gateway/ai-gateway-image-callbacks.service";
import { loadImageGenerationFixedCredits } from "../models.service";
import { LOCAL_REDRAW_CATEGORY, LocalRedrawPlan } from "../local-redraw.constants"
import { describeImageError, isTransient, RelayError } from "../core/retry-utils";
import type {
  AspectRatio,
  ImageProvider,
  ProviderGenerateInput,
  ReferenceImageInput,
  ResolutionTier,
  TokenUsage,
} from "../core/types";
import { resolveGatewayModel } from "../providers/gateway-mapping";
import {
  IMAGE_PROVIDER_FACTORY,
  type ImageProviderFactory,
} from "../providers/provider-factory.token";
import { DispatchQueueService } from "./dispatch-queue.service";
import { IMAGE_GENERATE_USAGE_SOURCE } from "./generation-task-runner.service";
import { hostImage } from "./host-image";
import { resolveDeliveredImageDimensions } from "./delivered-image-dimensions";
import { jobDeadlineMs } from "./job-deadline";

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 30_000;
const MAX_ATTEMPTS = 3;
/** 瞬态失败进程内重试退避(按已消耗 attemptNo 取档:1→2s、2→8s;第 3 次
 *  为预算上限不重投,末档为对账重投等后续场景兜底)。 */
const RETRY_BACKOFF_MS = [2_000, 8_000, 30_000];
/** 慢任务观测阈值:超过仅 WARN 积累数据(为二期超时续捞决策),不改行为。 */
const SLOW_GENERATION_MS = 180_000;

const WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

interface T2IRequestSnapshot {
  kind: "TEXT_TO_IMAGE";
  /** 逻辑 ID 或目录直传的网关 model id(B4 后均为网关通道,不收窄联合)。 */
  provider: string;
  modelPublicId?: string;
  prompt: string;
  aspectRatio: AspectRatio;
  resolutionTier: ResolutionTier;
}

/**
 * i2i 请求快照(IMAGE_TO_IMAGE job 的 request JSON),字段语义对齐
 * amazon-agent image-to-image 路由的 I2IForm + buildNormalInputs/
 * buildBatchInputs 产物:引用图已上传 Spaces,这里只存 URL。
 * (type 而非 interface:Prisma InputJsonObject 需要隐式索引签名。)
 */
export type I2IRequestSnapshot = {
  kind: "IMAGE_TO_IMAGE";
  localRedraw?: LocalRedrawPlan;
  /** 逻辑 ID 或目录直传的网关 model id(同 T2IRequestSnapshot)。 */
  provider: string;
  modelPublicId?: string;
  /** 去空白的用户 prompt;角色/风格/场景附加段由执行器拼接(照源路由)。 */
  prompt: string;
  market?: string
  aspectRatio: AspectRatio;
  customAspectW?: number;
  customAspectH?: number;
  resolutionTier: ResolutionTier;
  resolution: string;
  mode: "normal" | "batch";
  /** normal 模式的张数(provider 上限 clamp 后的生效值,仅存档)。 */
  count?: number;
  /** normal:全体 item 共享的引用图 URL(顺序 main/character/style/scene/refs)。 */
  referenceUrls?: string[];
  /** batch:每个 item 一组引用图 URL(与 item.idx 对位)。 */
  perItemReferenceUrls?: string[][];
  hasCharacter?: boolean;
  hasStyle?: boolean;
  hasScene?: boolean;
  /** 源路由响应/快照的 taskId/traceId(UUID 字符串,非 image-project 任务)。 */
  taskId?: string;
  traceId?: string;
};

export type ImageGenRequestSnapshot = T2IRequestSnapshot | I2IRequestSnapshot;

/** 由托管后的 Spaces URL 反推 mimeType(与 extensionForMime 的扩展名一一对应),
 *  快照投影用它还原源路由 I2IJobImageSnapshot.mimeType。 */
export function mimeTypeForUrl(url: string): string {
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function sumUsage(
  usages: Array<Record<string, unknown> | null | undefined>,
): Record<string, number> {
  const sum: Record<string, number> = {};
  for (const u of usages) {
    if (!u) continue;
    for (const [k, v] of Object.entries(u)) {
      if (typeof v === "number") sum[k] = (sum[k] ?? 0) + v;
    }
  }
  return sum;
}

@Injectable()
export class ImageGenItemRunnerService {
  private readonly logger = new Logger(ImageGenItemRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMAGE_PROVIDER_FACTORY)
    private readonly providerFactory: ImageProviderFactory,
    private readonly usage: UsageService,
    private readonly queue: DispatchQueueService,
  ) {}

  get maxAttempts(): number {
    return MAX_ATTEMPTS;
  }

  /** 执行一个 item;未认领成功(他人持有/已终态/超过次数)时静默返回。 */
  async executeItem(itemId: number): Promise<void> {
    const now = new Date();
    const claimed = await this.prisma.imageGenItem.updateMany({
      where: {
        id: itemId,
        status: { in: ["QUEUED", "RUNNING"] },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        attemptNo: { lt: MAX_ATTEMPTS },
        // 来源隔离：旧 runner 只认领通用生图管线（CHETAIDOU 由车泰斗 runner 处理）
        job: { businessType: IMAGE_CREATIVE_BUSINESS_TYPE },
      },
      data: {
        leaseOwner: WORKER_ID,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        attemptNo: { increment: 1 },
        status: "RUNNING",
      },
    });
    if (claimed.count === 0) return;

    const item = await this.prisma.imageGenItem.findUnique({
      where: { id: itemId },
      include: { job: true },
    });
    if (!item || !item.job) return;
    const job = item.job;
    if (job.businessType !== IMAGE_CREATIVE_BUSINESS_TYPE) return;

    // Job 已终态或已过保留窗口 → 不再执行,由对账收敛/清理。
    if (
      job.status === "COMPLETED" ||
      job.status === "FAILED" ||
      // expiresAt 可空（CHETAIDOU 恒 null；旧管线已在来源处隔离，此处兜底判空）
      job.expiresAt === null ||
      job.expiresAt.getTime() < Date.now()
    ) {
      await this.prisma.imageGenItem.updateMany({
        where: { id: itemId, status: "RUNNING" },
        data: { status: "FAILED", errorMessage: "生成超时，请重试" },
      });
      await this.aggregateJob(job.id);
      return;
    }

    const heartbeat = setInterval(() => {
      void this.prisma.imageGenItem
        .updateMany({
          where: {
            id: itemId,
            status: "RUNNING",
            leaseOwner: WORKER_ID,
          },
          data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
        })
        .catch(() => undefined);
    }, HEARTBEAT_MS);
    const attemptStartedAt = Date.now();
    let deliveryPending = Boolean(item.deliverySource || item.providerJobId);

    try {
      const provider: ImageProvider = this.providerFactory(
        (job.request as ImageGenRequestSnapshot | null)?.provider ??
          "gemini-nano-banana",
      );
      const input = await this.buildProviderInput(
        job.request as ImageGenRequestSnapshot | null,
        item.idx,
      );
      // 稳定幂等键(轨道 B):认领后的 item 行携带最新 attemptNo。前缀统一
      // IMAGE_PIPELINE_IDEMPOTENCY_PREFIX(webhook 据此识别管线任务的晚到回调)。
      input.idempotencyKey = `${IMAGE_PIPELINE_IDEMPOTENCY_PREFIX}${job.id}:${item.id}:${item.attemptNo ?? 0}`;
      input.resumeTaskId = item.providerJobId ?? undefined;
      input.onGenerated = async (taskId) => {
        deliveryPending = true;
        await this.prisma.imageGenItem.updateMany({
          where: { id: itemId, status: "RUNNING", leaseOwner: WORKER_ID },
          data: { providerJobId: taskId },
        });
      };
      const result = item.deliverySource as unknown as ProviderGenerateResult | null ?? await provider.generate(input);
      deliveryPending = true;
      if (!result.url.startsWith("data:")) await this.prisma.imageGenItem.updateMany({
        where: { id: itemId, status: "RUNNING", leaseOwner: WORKER_ID },
        data: { deliverySource: JSON.parse(JSON.stringify(result)) as import("@prisma/client").Prisma.InputJsonValue },
      });
      const elapsedMs = Date.now() - attemptStartedAt;
      if (elapsedMs > SLOW_GENERATION_MS) {
        this.logger.warn(
          `[image-gen] slow generation: item=${itemId} job=${job.id} provider=${provider.id} attempt=${item.attemptNo ?? 1} ms=${elapsedMs}`,
        );
      }
      const url = input.localRedraw ? result.url : await this.hostArtifactWithRetry(result.url, itemId, job.id);
      const dimensions = await resolveDeliveredImageDimensions(url, {
        width: result.gatewayImage?.width,
        height: result.gatewayImage?.height,
      });
      // CAS:只有仍处于 RUNNING(未被取消/未超时收敛)才可见。gatewayImage
      // 注入 gatewayTaskId(审计:任务↔网关任务关联此前只活在计费 meta 里)。
      const gatewayImagePayload = {
        ...(result.gatewayImage ?? {}),
        ...(result.gatewayTaskId ? { gatewayTaskId: result.gatewayTaskId } : {}),
      };
      const settled = await this.prisma.imageGenItem.updateMany({
        where: { id: itemId, status: "RUNNING" },
        data: {
          status: "SUCCEEDED",
          url,
          width: dimensions.width,
          height: dimensions.height,
          // 列级基座任务关联(对账可走 SQL 索引;generate 链路图片行同款字段)
          ...(result.gatewayTaskId ? { providerJobId: result.gatewayTaskId } : {}),
          ...(Object.keys(gatewayImagePayload).length > 0
            ? { gatewayImage: JSON.parse(JSON.stringify(gatewayImagePayload)) }
            : {}),
          usage: result.tokenUsage ? JSON.parse(JSON.stringify(result.tokenUsage)) : undefined,
          errorMessage: null,
        },
      });
      // 计费统一(2026-09-01):本执行器赢得 settle 的成功图由服务端扣积分,
      // source 与 generate 执行器/前端 IMAGE_GENERATION 一致(aicreative.
      // image_generate)。快照携带 serverBilled:true,前端调用方见标记即跳过
      // 自身上报,无双重扣费窗口。best-effort:计费失败只记日志,不影响图片。
      if (settled.count > 0) {
        await this.reportUsage(job, result, input.idempotencyKey);
      }
    } catch (err) {
      const message = describeImageError(err);
      const kind = err instanceof RelayError ? err.kind : null;
      const attemptNo = item.attemptNo ?? 1;
      const elapsedMs = Date.now() - attemptStartedAt;
      const transient = deliveryPending || (kind !== null && isTransient(kind));

      // 瞬态且预算未耗尽 → CAS 退回 QUEUED(清租约,认领 CAS 立即可再认领),
      // 按退避档重投本进程;CAS 输(取消/对账抢先)则落常规失败收敛。
      // deadline 守卫:Job 过墙钟 deadline 不再重投(前端超时已先生效,
      // 晚成功不可见,重投只会多花网关额度)。
      if (
        transient &&
        attemptNo < MAX_ATTEMPTS &&
        (deliveryPending || this.inProcessRetryEnabled()) &&
        Date.now() - job.createdAt.getTime() < jobDeadlineMs(job.kind)
      ) {
        const requeued = await this.prisma.imageGenItem.updateMany({
          where: { id: itemId, status: "RUNNING", leaseOwner: WORKER_ID },
          data: { status: "QUEUED", leaseOwner: null, leaseExpiresAt: null },
        });
        if (requeued.count > 0) {
          const backoffMs =
            RETRY_BACKOFF_MS[Math.min(attemptNo - 1, RETRY_BACKOFF_MS.length - 1)];
          this.logger.warn(
            `[image-gen] transient failure, requeueing: item=${itemId} job=${job.id} provider=${(job.request as ImageGenRequestSnapshot | null)?.provider ?? ""} attempt=${attemptNo} kind=${kind} ms=${elapsedMs} backoffMs=${backoffMs} message=${message}`,
          );
          const timer = setTimeout(() => {
            this.queue.enqueue(() => this.executeItem(itemId));
          }, backoffMs);
          // 不阻塞进程退出;对账 Cron 兜底丢失的重投(租约已清,可重认领)。
          timer.unref?.();
          return;
        }
      }

      const retryNote =
        transient && attemptNo >= MAX_ATTEMPTS && this.inProcessRetryEnabled()
          ? `（已自动重试 ${attemptNo - 1} 次）`
          : "";
      this.logger.error(
        `[image-gen] item ${itemId} (job ${job.id}) failed: kind=${kind ?? "unknown"} attempt=${attemptNo} ms=${elapsedMs}: ${message}`,
      );
      await this.prisma.imageGenItem.updateMany({
        where: { id: itemId, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "FAILED", errorMessage: message + retryNote },
      });
    } finally {
      clearInterval(heartbeat);
      await this.aggregateJob(job.id).catch(() => undefined);
    }
  }

  /** 进程内瞬态重试开关:IMAGE_GEN_INPROCESS_RETRY(默认 on,off = 回退
   *  无重试现状;测基线/排查时用它隔离重试行为)。 */
  private inProcessRetryEnabled(): boolean {
    return String(process.env.IMAGE_GEN_INPROCESS_RETRY ?? "on").toLowerCase() !== "off";
  }

  /** 产物托管带原位重试(2026-09-10):Spaces 偶发抖动(实测 NoSuchBucket
   *  404 等瞬态)只重传产物本身 —— 不回滚整个 provider 调用、不重开网关
   *  任务、不双花额度(T8 的 executeItem 级重投对这类"图已生成、托管失败"
   *  是纯浪费)。重试沿用原 url:data URL 重传新 key,远端 URL 重新转存。
   *  连败 3 次(1+2)仍失败才上抛走 FAILED 收敛。 */
  private async hostArtifactWithRetry(
    url: string,
    itemId: number,
    jobId: string,
  ): Promise<string> {
    const delays = [1_000, 3_000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
      }
      try {
        return await hostImage(url, "", `imagegen:${jobId}:${itemId}`);
      } catch (err) {
        lastErr = err;
        this.logger.warn(
          `[image-gen] host attempt ${attempt + 1} failed (item=${itemId} job=${jobId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    throw lastErr;
  }

  /** 服务端计费:成功 item 的 token 用量经 UsageService 扣积分。口径照
   *  generate 执行器:totalTokens 缺失时回退 prompt+completion,回退后仍
   *  <=0 跳过并告警;best-effort(失败仅记日志,不影响图片可见性)。source
   *  三链路统一为 aicreative.image_generate。 */
  private async reportUsage(
    job: { id: string; userId: number; kind: string; source?: string; request: unknown },
    result: { tokenUsage?: TokenUsage | null; costAmountCny?: string; gatewayTaskId?: string },
    chargeRequestId?: string,
  ): Promise<void> {
    const invokeType = job.source === "vidflowos" ? InvokeType.API : InvokeType.PLATFORM
    const provider =
      (job.request as ImageGenRequestSnapshot | null)?.provider ?? "";

    // 固定一口价模式：模型目录行配置 fixedCredits → 本张成功图精确扣一口价
    // （与网关账单金额无关，0 元/缺 usage 也扣）；未配置回落按量。
    const request = job.request as ImageGenRequestSnapshot | null
    const category = request?.kind === "IMAGE_TO_IMAGE" && request.localRedraw ? LOCAL_REDRAW_CATEGORY : undefined
    const fixedCredits = await this.loadFixedCredits(provider, category);
    if (fixedCredits) {
      try {
        await this.usage.chargeModel(job.userId, fixedCredits.div(CREDIT_PER_CNY).toString(), {
          source: IMAGE_GENERATE_USAGE_SOURCE,
          invokeType,
          model: provider,
          exactCredits: fixedCredits.toString(),
          meta: {
            jobId: job.id,
            kind: job.kind,
            gatewayTaskId: result.gatewayTaskId ?? "",
            imageCount: 1,
            pricingMode: "fixed",
            fixedCredits: fixedCredits.toString(),
            gatewayAmountCny: result.costAmountCny ?? "0",
          },
          requestId: chargeRequestId ? `charge:${chargeRequestId}` : undefined,
          allowOverdraft: true,
        })
        this.logger.log(
          `[image-gen] fixed-price charged: job=${job.id} kind=${job.kind} credits=${fixedCredits.toString()} gatewayAmount=${result.costAmountCny ?? "0"}CNY`,
        );
      } catch (err) {
        this.logger.error(
          `[image-gen] failed to charge fixed price: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    // 网关 amount(CNY)口径,走公共扣款 v2(chargeModel):注册表校验 +
    // model 维度用量统计 + requestId 幂等 + 企业用户混合扣费;计费倍率与
    // 其他模块同口径取 AiGatewayModel.priceMultiplier,UsageLog 的 costCny
    // 仍记真实金额。best-effort:失败仅记日志。
    if (result.costAmountCny != null) {
      if (!(Number(result.costAmountCny) > 0)) {
        this.logger.warn(
          `[image-gen] skip gateway charge: non-positive amount=${result.costAmountCny} job=${job.id}`,
        );
        return;
      }
      const priceMultiplier = await this.loadPriceMultiplier(provider, category);
      try {
        await this.usage.chargeModel(job.userId, result.costAmountCny, {
          source: IMAGE_GENERATE_USAGE_SOURCE,
          invokeType,
          model: provider,
          meta: {
            jobId: job.id,
            kind: job.kind,
            gatewayTaskId: result.gatewayTaskId ?? "",
            imageCount: 1,
            // 对账快照(与老 webhook 路径同口径):credits = gatewayAmountCny × priceMultiplier
            gatewayAmountCny: result.costAmountCny,
            priceMultiplier: priceMultiplier.toString(),
          },
          requestId: chargeRequestId ? `charge:${chargeRequestId}` : undefined,
          allowOverdraft: true,
          creditMultiplier: priceMultiplier,
        });
        this.logger.log(
          `[image-gen] gateway usage reported: job=${job.id} kind=${job.kind} amount=${result.costAmountCny}CNY`,
        );
      } catch (err) {
        this.logger.error(
          `[image-gen] failed to charge gateway usage: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    const usage = result.tokenUsage ?? null;
    if (!usage) return;
    const prompt = usage.promptTokens ?? 0;
    const completion = usage.completionTokens ?? 0;
    const total = usage.totalTokens || prompt + completion;
    const meta = {
      jobId: job.id,
      kind: job.kind,
      provider,
      imageCount: 1,
      gatewayTaskId: result.gatewayTaskId ?? "",
    };
    if (total <= 0) {
      this.logger.warn(
        `[image-gen] skip usage report: totalTokens=${total} — provider returned no token usage (meta=${JSON.stringify(meta)})`,
      );
      return;
    }
    try {
      await this.usage.chargeTokens(
        job.userId,
        {
          promptTokens: prompt,
          completionTokens: completion,
          thinkingTokens: usage.thinkingTokens,
          source: IMAGE_GENERATE_USAGE_SOURCE,
          meta,
        },
        { invokeType }
      )
      this.logger.log(
        `[image-gen] usage reported: job=${job.id} kind=${job.kind} totalTokens=${total}`,
      );
    } catch (err) {
      this.logger.error(
        `[image-gen] failed to report token usage: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 计费倍率(与其他模块同口径):AiGatewayModel.priceMultiplier,逻辑 ID
   *  先经 resolveGatewayModel 解析到网关 model,direct 槽位/目录缺行一律按
   *  1(safeMultiplier)。查询失败按 1 续跑只记日志 —— 本路径 best-effort,
   *  与逐笔扣费同一口径,保证 reportUsage 永不上抛。 */
  private async loadPriceMultiplier(provider: string, category?: string): Promise<Decimal> {
    try {
      const model = resolveGatewayModel(provider) ?? provider
      return await (category ? this.usage.gatewayPriceMultiplier(model, category) : this.usage.gatewayPriceMultiplier(model));
    } catch (err) {
      this.logger.error(
        `[image-gen] failed to load price multiplier (fallback 1): ${err instanceof Error ? err.message : String(err)}`,
      );
      return new Decimal(1);
    }
  }

  /** 固定一口价(积分/张):AiGatewayModel.fixedCredits(IMAGE_GENERATION 行),
   *  逻辑 ID 先经 resolveGatewayModel 解析。未配置/查询失败返回 null 续跑
   *  按量口径 —— 实时读库,改库对下一笔成功图即时生效。 */
  private loadFixedCredits(provider: string, category?: string): Promise<Decimal | null> {
    return loadImageGenerationFixedCredits(this.usage, provider, category);
  }

  /** 聚合 Job 终态:全部 item 终态时,任一成功 → COMPLETED,否则 FAILED。 */
  async aggregateJob(jobId: string): Promise<void> {
    const items = await this.prisma.imageGenItem.findMany({
      where: { jobId },
      select: { status: true, usage: true },
    });
    const all =
      items.length > 0 && items.every((i) => i.status === "SUCCEEDED" || i.status === "FAILED");
    if (!all) return;
    const anySuccess = items.some((i) => i.status === "SUCCEEDED");
    await this.prisma.imageGenJob.updateMany({
      where: { id: jobId, status: { in: ["QUEUED", "RUNNING"] } },
      data: {
        status: anySuccess ? "COMPLETED" : "FAILED",
        tokenUsage: sumUsage(items.map((i) => i.usage as Record<string, unknown> | null)),
      },
    });
  }

  private async buildProviderInput(
    snapshot: ImageGenRequestSnapshot | null,
    itemIdx: number,
  ): Promise<ProviderGenerateInput> {
    if (!snapshot) {
      throw new Error("unsupported job kind");
    }
    if (snapshot.kind === "IMAGE_TO_IMAGE") {
      return this.buildI2IProviderInput(snapshot, itemIdx);
    }
    if (snapshot.kind !== "TEXT_TO_IMAGE") {
      throw new Error("unsupported job kind");
    }
    return {
      referenceImages: [],
      prompt: snapshot.prompt,
      aspectRatio: snapshot.aspectRatio,
      resolutionTier: snapshot.resolutionTier,
      resolution: "1024x1024",
      authToken: "",
    };
  }

  /**
   * i2i 单图 provider 输入,逐条对齐源路由 executeImageToImageJob 的
   * generateOne:引用图按 item 取(batch 对位/normal 共享)、prompt 附加
   * 角色/风格/场景要求段(normal 模式且对应文件存在时)。
   */
  private async buildI2IProviderInput(
    snapshot: I2IRequestSnapshot,
    itemIdx: number,
  ): Promise<ProviderGenerateInput> {
    const urls =
      snapshot.mode === "batch"
        ? (snapshot.perItemReferenceUrls?.[itemIdx] ?? [])
        : (snapshot.referenceUrls ?? []);
    const referenceImages = await Promise.all(urls.map((url) => referenceInputFromUrl(url)));

    let promptExt = "";
    if (snapshot.mode === "normal" && !snapshot.localRedraw) {
      if (snapshot.hasCharacter) promptExt += "。附加要求：请确保画面中包含参考图中的人物/模特，使其自然地展示或与产品互动。";
      if (snapshot.hasStyle) promptExt += "。附加要求：请参考提供的“细节/风格”参考图来渲染产品的质感、光影或整体画面的美术风格。";
      if (snapshot.hasScene) promptExt += "。附加要求：请参考提供的“结构/场景”参考图来构建画面背景和空间关系。";
    }

    let prompt = snapshot.prompt + promptExt
    if (snapshot.market && !snapshot.localRedraw) {
      const language = resolveMarketplaceLanguage(snapshot.market) ?? FALLBACK_MARKETPLACE_LANGUAGE
      prompt = `${marketplaceLanguageHead(language)}${prompt}${marketplaceLanguageTail(language)}`
    }

    return {
      referenceImages,
      prompt,
      ...(snapshot.localRedraw ? { localRedraw: snapshot.localRedraw } : {}),
      aspectRatio: snapshot.aspectRatio,
      customAspectW: snapshot.customAspectW,
      customAspectH: snapshot.customAspectH,
      resolutionTier: snapshot.resolutionTier,
      resolution: snapshot.resolution,
      authToken: "",
    };
  }
}

/** 引用图 URL → provider 的 ReferenceImageInput(拉取 Spaces 字节转 base64)。 */
async function referenceInputFromUrl(url: string): Promise<ReferenceImageInput> {
  // 保留 url:网关适配器 MediaReference 直传(免 base64 往返);直连 provider 忽略。
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`reference image fetch failed: status=${resp.status}`);
  }
  const mimeType =
    resp.headers.get("content-type")?.split(";")[0]?.trim() ||
    mimeTypeForUrl(url);
  const base64 = Buffer.from(await resp.arrayBuffer()).toString("base64");
  return { mimeType, base64, url };
}
