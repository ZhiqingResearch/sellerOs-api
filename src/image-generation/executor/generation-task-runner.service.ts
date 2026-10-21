// src/image-generation/executor/generation-task-runner.service.ts
//
// 主生图(GenerationTask/GeneratedImage)单图执行器 —— 源路由
// amazon-agent src/app/api/ai-creative/generate/route.ts after() 内 generateOne
// 的等价物,步骤逐条对齐:
//   CAS 认领(租约列,与 image-gen-item-runner 同范式)→ 冻结 executionSpec
//   重建 provider 调用(引用图 URL 拉回 base64;legacy 模式逐图重建 prompt;
//   deliveryPlan 生效时传工作尺寸)→ provider 调用 → 交付计划 finalize(失败
//   降级托管 raw 图,不丢已计费图)→ 上传 Spaces → CAS 写 SUCCESS/FAILED
//   (WHERE status='GENERATING')→ 聚合任务(全成功/部分成功 SUCCESS、全失败
//   CANCELLED+"所有图片生成失败",errorMessage 语义照源)→ 终态后 usage 上报:
//   进程内调 UsageService.chargeTokens,口径与源 reportImageGenerationUsage
//   完全一致(source "aicreative.image_generate"、仅成功图、totalTokens<=0 跳过)。
//
// 取消竞态修复(本迁移的目标之一):cancel 事务把 GENERATING 图置 FAILED 后,
// 晚到成功的 settle CAS(WHERE status='GENERATING')count=0 被挡掉,不会复活
// 已取消的图,其 usage 也不计入——源路由的 per-image PATCH 无前置条件,晚到
// 成功会覆盖 FAILED。usage 与源一样只活在进程内(源是 after() 闭包数组),
// 终态聚合时上报一次,进程崩溃即丢失,语义一致。

import { Inject, Injectable, Logger } from "@nestjs/common";
import { InvokeType } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library";
import {
  IMAGE_PIPELINE_IDEMPOTENCY_PREFIX,
  parseImagePipelineIdempotencyKey,
} from "../../ai-gateway/ai-gateway-image-callbacks.service";
import { PrismaService } from "../../prisma/prisma.service";
import { CREDIT_PER_CNY } from "../../membership/membership.constants";
import { UsageService } from "../../usage/usage.service";
import { loadImageGenerationFixedCredits } from "../models.service";
import { LOCAL_REDRAW_CATEGORY, LocalRedrawPlan } from "../local-redraw.constants"
import { finalizeGeneratedImage } from "../core/delivery-finalize";
import type { DeliveryPlan } from "../core/delivery-types";
import { buildImagePrompt } from "../core/prompt-builder";
import { describeImageError } from "../core/retry-utils";
import { uploadBytesToSpaces } from "../core/storage";
import type {
  AspectRatio,
  ImageProvider,
  ImageProviderId,
  ImageTypeKey,
  ProviderGenerateInput,
  ReferenceImageInput,
  ResolutionTier,
  TargetLanguage,
  TokenUsage,
} from "../core/types";
import {
  IMAGE_PROVIDER_FACTORY,
  type ImageProviderFactory,
} from "../providers/provider-factory.token";
import { hostImage } from "./host-image";
import { resolveDeliveredImageDimensions } from "./delivered-image-dimensions";

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 30_000;
const MAX_ATTEMPTS = 3;

const WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

/** usage 上报来源标识(源 TASK_TYPE_TO_SOURCE.IMAGE_GENERATION,照抄)。 */
import { resolveGatewayModel } from "../providers/gateway-mapping";

export const IMAGE_GENERATE_USAGE_SOURCE = "aicreative.image_generate";
/** 对账超时收敛文案(源 = 前端 10 分钟超时时 PATCH 任务的 errorMessage)。 */
export const GENERATION_TIMEOUT_MESSAGE = "任务超过 10 分钟，已自动结束";
/** 全部图片生成失败时的任务 errorMessage(照源 after() 收尾 PATCH)。 */
export const ALL_IMAGES_FAILED_MESSAGE = "所有图片生成失败";
/** 手动取消的任务/图 errorMessage(照源 cancel 路由)。 */
export const CANCELLED_MESSAGE = "已手动取消";

/** gatewayTaskIds 列的元素形状(generate 管线任务级网关任务关联快照) */
type GatewayTaskLink = {
  gatewayTaskId: string;
  imageId: number | null;
  attemptNo: number | null;
};

/** 反序列化防御:列里只认带字符串 gatewayTaskId 的元素,形状异常直接丢弃 */
function parseGatewayTaskLinks(value: unknown): GatewayTaskLink[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (it): it is GatewayTaskLink =>
      !!it &&
      typeof it === "object" &&
      typeof (it as { gatewayTaskId?: unknown }).gatewayTaskId === "string",
  );
}

/** generate.service 冻结进 GenerationTask.executionSpec 的执行规格。
 *  (type 而非 interface:Prisma InputJsonObject 需要隐式索引签名。) */
export type GenerationExecutionSpec = {
  kind: "IMAGE_CREATIVE_GENERATE";
  localRedraw?: LocalRedrawPlan;
  mode: "product-image" | "image-creation";
  provider: ImageProviderId;
  modelPublicId?: string;
  /** 任务级编译 prompt(image-creation 的最终稿;legacy 为 items[0] 编译稿)。 */
  taskPrompt: string;
  /** prompt 编译用的目标尺寸串(如 "1024x1024")。 */
  promptResolution: string;
  /** 重建 provider 输入 / legacy 逐图 prompt 所需的表单快照。 */
  form: {
    productName: string;
    categoryL1: string;
    categoryL2: string;
    productDescription?: string;
    aspectRatio: AspectRatio;
    customAspectW?: number;
    customAspectH?: number;
    customSizeMode?: "ratio" | "pixels";
    resolutionTier: ResolutionTier;
    resolution: string;
    targetLanguage: TargetLanguage;
    hasDetailImage: boolean;
    hasStructureImage: boolean;
  };
  /** 逐图条目(order 对位 GeneratedImage.order)。 */
  items: Array<{ order: number; typeKey: string; imageType: string }>;
  /** 引用图 URL,顺序契约 [...urlMains, ...fileMains, ...attachedRefs, logo]。 */
  referenceUrls?: string[];
  mainCount: number;
  paperclipAttachedCount: number;
  brandLogoAppended: boolean;
  /** 显式像素目标时的交付计划(工作尺寸 + Finalizer 选项);ratio 请求无。 */
  deliveryPlan?: DeliveryPlan;
};

/** 源 route.ts 的 sumUsage:totalTokens 缺省回退 prompt+completion,
 *  thinkingTokens 为 0 时省略。 */
function sumUsage(list: TokenUsage[]): TokenUsage {
  let prompt = 0;
  let completion = 0;
  let thinking = 0;
  let total = 0;
  for (const u of list) {
    prompt += u.promptTokens || 0;
    completion += u.completionTokens || 0;
    thinking += u.thinkingTokens || 0;
    total += u.totalTokens ?? 0;
  }
  const aggregated: TokenUsage = {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total || prompt + completion,
  };
  if (thinking > 0) aggregated.thinkingTokens = thinking;
  return aggregated;
}

/** 引用图 URL → provider 的 ReferenceImageInput(拉取 Spaces 字节转 base64)。
 *  与 image-gen-item-runner 的同名私有 helper 同实现(该文件不导出,这里保持
 *  副本以不动 t2i/i2i 既有文件)。 */
async function referenceInputFromUrl(url: string): Promise<ReferenceImageInput> {
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`reference image fetch failed: status=${resp.status}`);
  }
  const mimeType =
    resp.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const base64 = Buffer.from(await resp.arrayBuffer()).toString("base64");
  // 网关通过 URL 接收参考图；直连 provider 继续使用 base64。
  return { mimeType, base64, url };
}

@Injectable()
export class GenerationTaskRunnerService {
  private readonly logger = new Logger(GenerationTaskRunnerService.name);
  /** taskId → 成功图 token usage(进程内,对齐源 after() 的闭包数组;
   *  任务终态时聚合上报一次)。 */
  private readonly usageByTask = new Map<number, TokenUsage[]>();
  private readonly amountByTask = new Map<
    number,
    Array<{ amount: string; gatewayTaskId?: string; chargeRequestId?: string }>
  >();
  /** taskId → 成功图固定价扣费条目（每张一条，与 amount/token 收集无关——
   *  一口价模式按成功图计费，0 元/缺 usage 的成功图也要扣）。flush 时按
   *  当时的目录固定价配置决定走固定价还是按量。 */
  private readonly fixedChargesByTask = new Map<
    number,
    Array<{ amount: string | null; gatewayTaskId?: string; chargeRequestId?: string }>
  >();
  /** taskId → 执行中的 AbortController(取消注册表;cancel 事务后 abort,
   *  等价源 generation-registry 的 registerGeneration/abortGeneration)。 */
  private readonly abortControllers = new Map<number, Set<AbortController>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMAGE_PROVIDER_FACTORY)
    private readonly providerFactory: ImageProviderFactory,
    private readonly usage: UsageService,
  ) {}

  get maxAttempts(): number {
    return MAX_ATTEMPTS;
  }

  /** 执行一张生成图;未认领成功(已被取消/终态/他人持有租约/超过次数)时静默返回。 */
  async executeGeneratedImage(imageId: number): Promise<void> {
    const now = new Date();
    const claimed = await this.prisma.generatedImage.updateMany({
      where: {
        id: imageId,
        status: "GENERATING",
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        attemptNo: { lt: MAX_ATTEMPTS },
      },
      data: {
        leaseOwner: WORKER_ID,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        attemptNo: { increment: 1 },
      },
    });
    if (claimed.count === 0) return;

    const image = await this.prisma.generatedImage.findUnique({
      where: { id: imageId },
      include: { task: true },
    });
    if (!image || !image.task) return;
    const task = image.task;

    // 任务已被取消(取消事务本应已把本图置 FAILED;认领发生在取消前)→ 不再执行。
    if (task.status !== "GENERATING") {
      await this.prisma.generatedImage.updateMany({
        where: { id: imageId, status: "GENERATING" },
        data: {
          status: "FAILED",
          errorMessage:
            task.status === "CANCELLED" || task.cancelRequested
              ? CANCELLED_MESSAGE
              : GENERATION_TIMEOUT_MESSAGE,
        },
      });
      return;
    }
    // 超 deadline → 图 FAILED(超时语义)+ 聚合收敛。
    if (task.deadlineAt && task.deadlineAt.getTime() < Date.now()) {
      await this.prisma.generatedImage.updateMany({
        where: { id: imageId, status: "GENERATING" },
        data: { status: "FAILED", errorMessage: GENERATION_TIMEOUT_MESSAGE },
      });
      await this.aggregateTask(task.id);
      return;
    }

    const spec = task.executionSpec as GenerationExecutionSpec | null;
    if (!spec || spec.kind !== "IMAGE_CREATIVE_GENERATE") {
      await this.prisma.generatedImage.updateMany({
        where: { id: imageId, status: "GENERATING" },
        data: { status: "FAILED", errorMessage: "生成任务缺少执行规格" },
      });
      await this.aggregateTask(task.id);
      return;
    }

    const abortController = new AbortController();
    this.registerAbort(task.id, abortController);

    const heartbeat = setInterval(() => {
      void this.prisma.generatedImage
        .updateMany({
          where: {
            id: imageId,
            status: "GENERATING",
            leaseOwner: WORKER_ID,
          },
          data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
        })
        .catch(() => undefined);
    }, HEARTBEAT_MS);

    try {
      const provider: ImageProvider = this.providerFactory(spec.provider);
      const item = spec.items.find((it) => it.order === image.order) ?? spec.items[0];
      const input = await this.buildProviderInput(spec, item, abortController.signal);
      // 稳定幂等键(轨道 B):网关防重复提交/计费。前缀统一
      // IMAGE_PIPELINE_IDEMPOTENCY_PREFIX(原 `gen:`,2026-09-10 统一——
      // webhook 据此识别管线任务的晚到回调)。
      input.idempotencyKey = `${IMAGE_PIPELINE_IDEMPOTENCY_PREFIX}${task.id}:${imageId}:${image.attemptNo ?? 0}`;
      const result = await provider.generate(input);
      const rawUrl = result.url;

      // 交付计划 finalize + 上传;照源:finalize 失败降级托管 raw 图,绝不丢
      // 已生成(已计费)的图,尺寸不达标仅告警。
      let spacesUrl: string | undefined;
      let deliveredWidth = result.gatewayImage?.width;
      let deliveredHeight = result.gatewayImage?.height;
      if (rawUrl && spec.deliveryPlan && !result.gatewayImage?.nativeSizing && !result.gatewayImage?.ratioDelivery) {
        try {
          const fin = await finalizeGeneratedImage(
            rawUrl,
            spec.deliveryPlan,
            abortController.signal,
          );
          spacesUrl = await uploadBytesToSpaces({
            bytes: fin.bytes,
            mimeType: fin.mimeType,
            scene: "IMAGE_CREATION_OUTPUT",
            authToken: "",
          });
          deliveredWidth = fin.width;
          deliveredHeight = fin.height;
        } catch (finErr) {
          spacesUrl = await hostImage(rawUrl);
          this.logger.warn(
            `[product-image:${task.id}] image_finalize_failed order=${image.order} strategy=${spec.deliveryPlan.strategy} message=${finErr instanceof Error ? finErr.message : String(finErr)}`,
          );
        }
      } else if (rawUrl) {
        spacesUrl = spec.localRedraw ? rawUrl : await hostImage(rawUrl);
      }

      if (spacesUrl) {
        const dimensions = await resolveDeliveredImageDimensions(
          spacesUrl,
          { width: deliveredWidth, height: deliveredHeight },
          abortController.signal,
        );
        deliveredWidth = dimensions.width;
        deliveredHeight = dimensions.height;
      }

      // CAS settle:仅当图仍 GENERATING(未被取消/超时收敛)才可见。取消后
      // 晚到的成功在这里被挡住(count=0),usage 也不计入——取消竞态修复点。
      const settled = await this.prisma.generatedImage.updateMany({
        where: { id: imageId, status: "GENERATING" },
        data: {
          url: spacesUrl,
          originalUrl: result.gatewayImage?.originalUrl,
          status: "SUCCESS",
          errorMessage: null,
          width: deliveredWidth,
          height: deliveredHeight,
          nativeWidth: result.gatewayImage?.nativeWidth ?? result.gatewayImage?.width,
          nativeHeight: result.gatewayImage?.nativeHeight ?? result.gatewayImage?.height,
          // 审计:图片行 ↔ 网关任务关联(AI_SPLIT/人像行同款字段;此前 generate
          // 行只活在计费 meta 里,任务中心排障要绕道 UsageLog)。
          ...(result.gatewayTaskId ? { providerJobId: result.gatewayTaskId } : {}),
          deliveryMeta: result.gatewayImage
            ? JSON.parse(JSON.stringify({ gatewayImage: result.gatewayImage }))
            : undefined,
        },
      });
      if (settled.count > 0) {
        // 固定一口价候选条目：每张成功图无条件收集（0 元/缺 usage 也扣一口价），
        // flush 时若目录未配固定价则整条丢弃走按量。
        this.pushFixedCharge(task.id, result.costAmountCny ?? null, result.gatewayTaskId, input.idempotencyKey);
        // D4 决议:网关 amount(CNY)与 token 折算互斥——网关结果只有 amount,
        // 直连结果只有 token;分别入账,由 flush 统一扣。
        if (result.costAmountCny != null) {
          this.pushAmount(
            task.id,
            result.costAmountCny,
            result.gatewayTaskId,
            input.idempotencyKey,
          );
        } else if (result.tokenUsage) {
          this.pushUsage(task.id, result.tokenUsage);
        }
      }
    } catch (err) {
      const message = describeImageError(err);
      this.logger.error(`[product-image:${task.id}] image_failed order=${image.order}: ${message}`);
      await this.prisma.generatedImage.updateMany({
        where: { id: imageId, status: "GENERATING" },
        data: { status: "FAILED", errorMessage: message },
      });
    } finally {
      clearInterval(heartbeat);
      this.unregisterAbort(task.id, abortController);
      await this.aggregateTask(task.id).catch(() => undefined);
    }
  }

  /** 聚合任务终态(照源 after() 收尾):全部图终态时,任一成功 → SUCCESS,
   *  全失败 → CANCELLED+"所有图片生成失败";超 deadlineAt → TIMEOUT。任务已
   *  被取消/超时置终态时不再改状态(CAS WHERE status='GENERATING'),只补报
   *  已成功图的 usage。 */
  async aggregateTask(taskId: number): Promise<void> {
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      include: { generatedImages: { orderBy: { order: "asc" } } },
    });
    if (!task) return;
    const images = task.generatedImages;
    const allTerminal =
      images.length > 0 &&
      images.every((i) => i.status === "SUCCESS" || i.status === "FAILED");
    if (!allTerminal) return;

    if (task.status === "GENERATING") {
      const timedOut = Boolean(task.deadlineAt && task.deadlineAt.getTime() < Date.now());
      const anySuccess = images.some((i) => i.status === "SUCCESS");
      await this.prisma.generationTask.updateMany({
        where: { id: taskId, status: "GENERATING" },
        data: timedOut
          ? { status: "TIMEOUT", errorMessage: GENERATION_TIMEOUT_MESSAGE }
          : anySuccess
            ? { status: "SUCCESS", errorMessage: null }
            : { status: "CANCELLED", errorMessage: ALL_IMAGES_FAILED_MESSAGE },
      });
    }
    await this.reportUsage(task);
    await this.refreshPortraitProject(task);
  }

  /** cancel 事务后的收尾:abort 本进程该任务全部在途执行(取消注册表)+
   *  上报取消前已成功图的 usage(源 after() 被 abort 后同样走收尾上报)。
   *  返回是否真的中止了在途执行(源 abortGeneration 的返回值语义)。 */
  async onTaskCancelled(taskId: number): Promise<boolean> {
    const aborted = this.abortTaskExecutions(taskId);
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
    });
    if (task) {
      await this.reportUsage(task);
      await this.refreshPortraitProject(task);
    }
    return aborted;
  }

  private async refreshPortraitProject(task: {
    type: string
    projectId: number
    executionSpec: unknown
  }): Promise<void> {
    if (
      task.type !== "PORTRAIT" ||
      !(task.executionSpec as GenerationExecutionSpec | null)?.localRedraw
    )
      return
    const [running, successful] = await Promise.all([
      this.prisma.generationTask.count({
        where: { projectId: task.projectId, status: "GENERATING", deletedAt: null },
      }),
      this.prisma.generatedImage.count({
        where: {
          status: "SUCCESS",
          deletedAt: null,
          task: { projectId: task.projectId, deletedAt: null },
        },
      }),
    ])
    await this.prisma.imageProject.updateMany({
      where: { id: task.projectId, status: { not: "ARCHIVED" }, deletedAt: null },
      data: { status: running > 0 ? "GENERATING" : successful > 0 ? "COMPLETED" : "DRAFT" },
    })
  }

  /** 中止本进程该任务的全部在途执行;无注册(其它实例/已结束)返回 false。 */
  abortTaskExecutions(taskId: number): boolean {
    const set = this.abortControllers.get(taskId);
    if (!set || set.size === 0) return false;
    for (const controller of set) {
      controller.abort();
    }
    return true;
  }

  /** 单图 provider 输入,逐条对齐源 generateOne:
   *  - image-creation 用冻结的 taskPrompt;legacy 逐图重建(promptOverride
   *    不参与执行,照源 generateOne 的分支);
   *  - 引用图按 executionSpec.referenceUrls 拉回 base64,顺序契约不动;
   *  - deliveryPlan 生效时传 workingWidth/workingHeight(gpt 家族生效,
   *    Gemini/Wan 忽略)。 */
  private async buildProviderInput(
    spec: GenerationExecutionSpec,
    item: { imageType: string } | undefined,
    signal: AbortSignal,
  ): Promise<ProviderGenerateInput> {
    const referenceImages = await Promise.all(
      (spec.referenceUrls ?? []).map((url) => referenceInputFromUrl(url)),
    );

    let prompt: string;
    if (spec.mode === "image-creation") {
      prompt = spec.taskPrompt;
    } else {
      // atlas-wan 的 edit-prompt 分支随 B4 direct 退役移除(槽位已下线)。
      prompt = buildImagePrompt({
        centerCrop: spec.deliveryPlan && spec.deliveryPlan.finalizer.fit !== "cover" ? false : undefined,
        productName: spec.form.productName,
        categoryL1: spec.form.categoryL1,
        categoryL2: spec.form.categoryL2,
        productDescription: spec.form.productDescription,
        imageType: (item?.imageType ?? "") as ImageTypeKey,
        aspectRatio: spec.form.aspectRatio,
        customAspectW: spec.form.customAspectW,
        customAspectH: spec.form.customAspectH,
        resolution: spec.promptResolution,
        hasDetailImage: spec.form.hasDetailImage,
        hasStructureImage: spec.form.hasStructureImage,
        targetLanguage: spec.form.targetLanguage,
      });
    }

    return {
      centerCrop: spec.deliveryPlan && spec.deliveryPlan.finalizer.fit !== "cover" ? false : undefined,
      referenceImages,
      prompt,
      ...(spec.localRedraw ? { localRedraw: spec.localRedraw } : {}),
      aspectRatio: spec.form.aspectRatio,
      customAspectW: spec.form.customAspectW,
      customAspectH: spec.form.customAspectH,
      customSizeMode: spec.form.customSizeMode,
      resolutionTier: spec.form.resolutionTier,
      resolution: spec.form.resolution,
      authToken: "",
      signal,
      ...(spec.deliveryPlan
        ? {
            workingWidth: spec.deliveryPlan.workingWidth,
            workingHeight: spec.deliveryPlan.workingHeight,
          }
        : {}),
    };
  }

  /** 终态后的 usage 上报:口径与源 reportImageGenerationUsage 完全一致 ——
   *  仅成功图(失败/被取消挡掉的图在 settle 前就被丢弃)、totalTokens<=0 跳过
   *  (记 warn)、source 固定 "aicreative.image_generate"、meta 携带
   *  {taskId, provider, imageCount}。上报失败只记日志不上抛。 */
  private async reportUsage(task: {
    id: number;
    userId: number;
    source?: string
    executionSpec: unknown;
  }): Promise<void> {
    const invokeType = task.source === "vidflowos" ? InvokeType.API : InvokeType.PLATFORM
    const specProvider =
      (task.executionSpec as GenerationExecutionSpec | null)?.provider ?? "";

    // 固定一口价模式：模型目录行配置 fixedCredits → 每张成功图精确扣一口价
    // （与网关账单金额无关，0 元/缺 usage 的成功图也扣），不再走按量金额与
    // token 扣费；未配置回落按量（读取失败按 null 续跑按量）。
    const category = (task.executionSpec as GenerationExecutionSpec | null)?.localRedraw ? LOCAL_REDRAW_CATEGORY : undefined
    const fixedCredits = await this.loadFixedCredits(specProvider, category);
    if (fixedCredits) {
      const fixedEntries = this.fixedChargesByTask.get(task.id) ?? [];
      this.fixedChargesByTask.delete(task.id);
      // 按量收集作废，避免固定价模式下双扣
      this.amountByTask.delete(task.id);
      this.usageByTask.delete(task.id);
      await this.persistGatewayTaskLinks(
        task.id,
        fixedEntries.map((e) => ({
          gatewayTaskId: e.gatewayTaskId,
          chargeRequestId: e.chargeRequestId,
        })),
      );
      for (const entry of fixedEntries) {
        try {
          await this.usage.chargeModel(task.userId, fixedCredits.div(CREDIT_PER_CNY).toString(), {
            source: IMAGE_GENERATE_USAGE_SOURCE,
            invokeType,
            model: specProvider,
            exactCredits: fixedCredits.toString(),
            meta: {
              taskId: task.id,
              provider: specProvider,
              gatewayTaskId: entry.gatewayTaskId ?? "",
              imageCount: 1,
              pricingMode: "fixed",
              fixedCredits: fixedCredits.toString(),
              gatewayAmountCny: entry.amount ?? "0",
            },
            requestId: entry.chargeRequestId ? `charge:${entry.chargeRequestId}` : undefined,
            allowOverdraft: true,
          })
          this.logger.log(
            `[generate] fixed-price charged: taskId=${task.id} credits=${fixedCredits.toString()} gatewayAmount=${entry.amount ?? "0"}CNY`,
          );
        } catch (err) {
          this.logger.error(
            `[generate] failed to charge fixed price: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return;
    }

    const amounts = this.amountByTask.get(task.id) ?? [];
    this.amountByTask.delete(task.id);
    const usages = this.usageByTask.get(task.id) ?? [];
    this.usageByTask.delete(task.id);

    // 网关 amount 口径(D4):逐笔走公共扣款 v2(chargeModel) —— 注册表校验 +
    // model 维度用量统计 + requestId 幂等 + 企业用户混合扣费;计费倍率与其他
    // 模块同口径取 AiGatewayModel.priceMultiplier,costCny 记真实金额。
    // 失败仅记日志(best-effort)。
    const priceMultiplier = amounts.length
      ? await this.loadPriceMultiplier(specProvider, category)
      : new Decimal(1);
    // 任务级网关任务关联快照(审计/对账):flush 点集齐本任务全部网关任务 id,先于
    // 逐笔扣费写入(扣费失败不影响关联落库)。
    await this.persistGatewayTaskLinks(task.id, amounts);
    for (const entry of amounts) {
      if (!(Number(entry.amount) > 0)) {
        this.logger.warn(
          `[generate] skip gateway charge: non-positive amount=${entry.amount} taskId=${task.id}`,
        );
        continue;
      }
      try {
        await this.usage.chargeModel(task.userId, entry.amount, {
          source: IMAGE_GENERATE_USAGE_SOURCE,
          invokeType,
          model: specProvider,
          meta: {
            taskId: task.id,
            provider: specProvider,
            gatewayTaskId: entry.gatewayTaskId ?? "",
            imageCount: 1,
            // 对账快照(与老 webhook 路径同口径):credits = gatewayAmountCny × priceMultiplier
            gatewayAmountCny: entry.amount,
            priceMultiplier: priceMultiplier.toString(),
          },
          requestId: entry.chargeRequestId
            ? `charge:${entry.chargeRequestId}`
            : undefined,
          allowOverdraft: true,
          creditMultiplier: priceMultiplier,
        });
        this.logger.log(
          `[generate] gateway usage reported: taskId=${task.id} amount=${entry.amount}CNY`,
        );
      } catch (err) {
        this.logger.error(
          `[generate] failed to charge gateway usage: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (usages.length === 0) return;

    const usage = sumUsage(usages);
    const total = usage.totalTokens ?? 0;
    const provider =
      (task.executionSpec as GenerationExecutionSpec | null)?.provider ?? "";
    const meta = { taskId: task.id, provider, imageCount: usages.length };
    if (total <= 0) {
      this.logger.warn(
        `[generate] skip usage report: totalTokens=${total} — provider returned no token usage (meta=${JSON.stringify(meta)})`,
      );
      return;
    }
    try {
      await this.usage.chargeTokens(
        task.userId,
        {
          promptTokens: usage.promptTokens ?? 0,
          completionTokens: usage.completionTokens ?? 0,
          thinkingTokens: usage.thinkingTokens,
          source: IMAGE_GENERATE_USAGE_SOURCE,
          meta,
        },
        { invokeType }
      )
      this.logger.log(
        `[generate] usage reported: totalTokens=${total} (meta=${JSON.stringify(meta)})`,
      );
    } catch (err) {
      this.logger.error(
        `[generate] failed to report token usage: ${err instanceof Error ? err.message : String(err)}`,
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
        `[generate] failed to load price multiplier (fallback 1): ${err instanceof Error ? err.message : String(err)}`,
      );
      return new Decimal(1);
    }
  }

  /** 固定一口价(积分/张):AiGatewayModel.fixedCredits(IMAGE_GENERATION 行),
   *  逻辑 ID 先经 resolveGatewayModel 解析。未配置/查询失败返回 null 续跑
   *  按量口径 —— 实时读库,改库对下一笔 flush 即时生效。 */
  private loadFixedCredits(provider: string, category?: string): Promise<Decimal | null> {
    return loadImageGenerationFixedCredits(this.usage, provider, category);
  }

  /** 收集一张成功图的固定价扣费条目(与按量 amount/token 收集并行、无条件;
   *  flush 时按目录是否配置 fixedCredits 决定用哪套口径)。 */
  private pushFixedCharge(
    taskId: number,
    amount: string | null,
    gatewayTaskId?: string,
    chargeRequestId?: string,
  ): void {
    const list = this.fixedChargesByTask.get(taskId) ?? [];
    list.push({ amount, gatewayTaskId, chargeRequestId });
    this.fixedChargesByTask.set(taskId, list);
  }

  /** 任务级网关任务关联快照(审计/对账):1 任务 N 图 = N 网关任务,单值
   *  gatewayTaskId 唯一列装不下,全量落 gatewayTaskIds;恰好 1 个时单值列
   *  同步冗余。读-合-写幂等(重试后再 flush 不丢先前 attempt 的关联)。
   *  best-effort:失败仅记日志(对 webhook 控制流惰性——imggen: 回调在
   *  applyImageTask 之前就被吞掉,不会误触老路径幂等语义)。 */
  private async persistGatewayTaskLinks(
    taskId: number,
    amounts: Array<{ gatewayTaskId?: string; chargeRequestId?: string }>,
  ): Promise<void> {
    const fresh = new Map<string, GatewayTaskLink>();
    for (const entry of amounts) {
      if (!entry.gatewayTaskId || fresh.has(entry.gatewayTaskId)) continue;
      const parsed = entry.chargeRequestId
        ? parseImagePipelineIdempotencyKey(entry.chargeRequestId)
        : null;
      fresh.set(entry.gatewayTaskId, {
        gatewayTaskId: entry.gatewayTaskId,
        imageId: parsed?.childId ?? null,
        attemptNo: parsed?.attemptNo ?? null,
      });
    }
    if (fresh.size === 0) return;
    try {
      const current = await this.prisma.generationTask.findUnique({
        where: { id: taskId },
        select: { gatewayTaskIds: true, gatewayTaskId: true },
      });
      const merged = parseGatewayTaskLinks(current?.gatewayTaskIds);
      for (const link of fresh.values()) {
        if (!merged.some(l => l.gatewayTaskId === link.gatewayTaskId)) merged.push(link);
      }
      await this.prisma.generationTask.updateMany({
        where: { id: taskId },
        data: {
          gatewayTaskIds: JSON.parse(JSON.stringify(merged)),
          ...(merged.length === 1 && !current?.gatewayTaskId
            ? { gatewayTaskId: merged[0].gatewayTaskId }
            : {}),
        },
      });
    } catch (err) {
      this.logger.warn(
        `[generate] failed to persist gateway task links (audit-only): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 网关 amount(CNY Decimal 字符串)按图收集,flush 时经
   *  chargeGatewayUsageInTransaction 结算(source 统一 aicreative.image_generate)。 */
  private pushAmount(
    taskId: number,
    amount: string,
    gatewayTaskId?: string,
    chargeRequestId?: string,
  ): void {
    const list = this.amountByTask.get(taskId) ?? [];
    list.push({ amount, gatewayTaskId, chargeRequestId });
    this.amountByTask.set(taskId, list);
  }

  private pushUsage(taskId: number, usage: TokenUsage): void {
    const list = this.usageByTask.get(taskId) ?? [];
    list.push(usage);
    this.usageByTask.set(taskId, list);
  }

  private registerAbort(taskId: number, controller: AbortController): void {
    let set = this.abortControllers.get(taskId);
    if (!set) {
      set = new Set();
      this.abortControllers.set(taskId, set);
    }
    set.add(controller);
  }

  private unregisterAbort(taskId: number, controller: AbortController): void {
    const set = this.abortControllers.get(taskId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) this.abortControllers.delete(taskId);
  }
}
