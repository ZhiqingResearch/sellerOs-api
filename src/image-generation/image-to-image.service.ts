import { gatewayImageDimensions, gatewayOriginalUrl, modelDisplayNames, jsonObject } from "../common/utils/generation-metadata";
// src/image-generation/image-to-image.service.ts
//
// i2i 创建/查询,行为逐条对齐 amazon-agent 的
// src/app/api/ai-creative/image-to-image 路由 + src/server/image/i2i-job-store.ts
// (校验、默认值、错误文案、数量上限、快照契约):
//   POST → {jobId, taskId, traceId, total, items}(立即返回,执行由 DispatchQueue 后台跑)
//   GET  → I2IJobSnapshot(status queued|running|completed|failed 小写、
//           images[{index,typeKey,label,status: pending|ready|failed,url,mimeType,
//           errorMessage}]、tokenUsage 字段名保持);过期/不存在 → null(控制器 404)
//
// 与源路由的差异仅在内部执行位置:引用图创建时上传 Spaces(key 落 request 快照,
// 执行器拉回 base64 喂 provider)、产物由执行器托管 Spaces——用户可见契约不变。

import { HttpException, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { CreationSource } from "../common/types/creation-source";
import { IMAGE_CREATIVE_BUSINESS_TYPE } from "../chetaidou/chetaidou.constants";
import { PrismaService } from "../prisma/prisma.service";
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider";
import { UsageService } from "../usage/usage.service";
import { isImageAspectRatio, normalizeResolutionTier } from "./core/size-adapters";
import { uploadBytesToSpaces } from "./core/storage";
import type { AspectRatio, ImageProviderId, ResolutionTier, TokenUsage } from "./core/types";
import { DispatchQueueService } from "./executor/dispatch-queue.service";
import {
  ImageGenItemRunnerService,
  mimeTypeForUrl,
  type I2IRequestSnapshot,
} from "./executor/image-gen-item-runner.service";
import { loadImageGenerationFixedCredits } from "./models.service";
import { prepareLocalRedraw } from "./local-redraw"
import { LOCAL_REDRAW_CATEGORY, LocalRedrawPlan } from "./local-redraw.constants"
import { resolveGatewayModel } from "./providers/gateway-mapping";

const RETENTION_MS = 30 * 60_000; // 对齐 i2i-job-store 的 30 分钟保留窗口

/** 与 i2i-job-store 的 MAX_I2I_COUNT_BY_PROVIDER 完全一致(逐项 4)。 */
const MAX_I2I_COUNT_BY_PROVIDER: Record<string, number> = {
  "gemini-nano-banana": 4,
  "openai-gpt-image": 4,
  "atlas-gpt": 4,
  "atlas-wan": 4,
  "atlas-seedream": 4,
  "atlas-seedream-pro": 4,
  "apifox-zq2-pro-plus": 4,
  "chadgpt-ru": 4,
  "tokenlab-gpt-image": 4,
};

const DEFAULT_MAX_I2I_COUNT = 4; // 目录直传的动态 model id 同上限(源表逐项 4)

type Mode = "normal" | "batch";

interface I2IForm {
  editMode?: "local-redraw"
  mode: Mode;
  prompt: string;
  /** 可选站点；不传时不注入图上文字语言规则。 */
  market?: string
  /** 逻辑 ID 或目录直传的网关 model id(B4 后均为网关通道)。 */
  provider: string;
  aspectRatio: AspectRatio;
  customAspectW?: number;
  customAspectH?: number;
  resolutionTier: ResolutionTier;
  resolution: string;
  /** normal 模式:同一组引用图生成几张。 */
  count: number;
}

// ─── 对外契约(源路由 CreateJobResponse / I2IJobSnapshot 投影) ───────────────

export interface I2ITaskItem {
  index: number;
  typeKey: string;
  label: string;
}

export type I2ICreateResult =
  | {
      ok: true;
      jobId: string;
      taskId: string;
      traceId: string;
      total: number;
      items: I2ITaskItem[];
      localRedraw?: LocalRedrawPlan;
    }
  | { ok: false; status: number; error: string };

export type I2IJobStatus = "queued" | "running" | "completed" | "failed";
export type I2IJobImageStatus = "pending" | "ready" | "failed";

export interface I2IJobImageSnapshot extends I2ITaskItem {
  originalUrl?: string | null;
  status: I2IJobImageStatus;
  url?: string;
  mimeType?: string;
  gatewayImage?: unknown;
  width?: number | null;
  height?: number | null;
  errorMessage?: string;
}

export interface I2IJobSnapshot {
  modelPublicId?: string | null;
  displayName?: string | null;
  resolutionTier?: string | null;
  jobId: string;
  taskId: string;
  traceId: string;
  status: I2IJobStatus;
  images: I2IJobImageSnapshot[];
  submittedAt: number;
  updatedAt: number;
  completedAt?: number;
  tokenUsage?: TokenUsage;
  mcpUsage?: { totalCalls: number; callDetail: Record<string, never> };
  errorMessage?: string;
  /** 计费统一(2026-09-01):后端执行器已对成功 item 服务端扣费,前端调用方
   *  见此标记跳过自身 usage 上报(见 amazon-agent pollImageToImage)。 */
  serverBilled?: boolean;
  localRedraw?: LocalRedrawPlan;
}

// ─── multipart 文件形状(自有最小接口,避免引入 @types/multer) ───────────────

/** multer(memory storage)解析后的文件;只声明本模块用到的字段。 */
export interface I2IUploadFile {
  fieldname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
  originalname?: string;
}

export interface I2IUploadFiles {
  main?: I2IUploadFile[];
  character?: I2IUploadFile[];
  style?: I2IUploadFile[];
  scene?: I2IUploadFile[];
  refs?: I2IUploadFile[];
  references?: I2IUploadFile[];
}

// ─── 校验(逐条对齐源路由 parseForm,含错误文案) ────────────────────────────

type ParseFormResult = { ok: true; value: I2IForm } | { ok: false; reason: string };

function parseForm(raw: unknown): ParseFormResult {
  if (typeof raw !== "string") {
    return { ok: false, reason: `form field is ${typeof raw}, expected string` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "form field is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "form payload is not an object" };
  }
  const f = parsed as Partial<I2IForm>;
  if (f.editMode !== undefined && (f.editMode !== "local-redraw" || f.mode !== "normal")) {
    return { ok: false, reason: "局部重绘仅支持 mode=normal、editMode=local-redraw" };
  }
  if (f.mode !== "normal" && f.mode !== "batch") {
    return { ok: false, reason: `bad mode: ${JSON.stringify(f.mode)}` };
  }
  if (typeof f.prompt !== "string" || f.prompt.trim().length === 0) {
    return { ok: false, reason: "prompt is empty or non-string" };
  }
  if (
    f.editMode !== "local-redraw" && (typeof f.provider !== "string" ||
    resolveGatewayModel(f.provider) === null)
  ) {
    // B4:退役槽位 400;目录直传的动态 model id 放行,由网关校验。
    return { ok: false, reason: `bad provider: ${JSON.stringify(f.provider)}` };
  }
  if (f.editMode !== "local-redraw" && f.aspectRatio !== "custom" && !isImageAspectRatio(f.aspectRatio)) {
    return { ok: false, reason: `bad aspectRatio: ${JSON.stringify(f.aspectRatio)}` };
  }
  const legacyResolution =
    typeof f.resolution === "string" && f.resolution.trim().length > 0
      ? f.resolution
      : "1024x1024";
  const resolutionTier = normalizeResolutionTier(
    (f as { resolutionTier?: unknown }).resolutionTier,
    legacyResolution,
  );
  const count = typeof f.count === "number" && f.count > 0 ? Math.floor(f.count) : 1;
  return {
    ok: true,
    value: {
      mode: f.mode,
      editMode: f.editMode,
      prompt: f.prompt.trim(),
      market: typeof f.market === "string" && f.market.trim() ? f.market.trim() : undefined,
      provider: f.provider ?? "",
      aspectRatio: f.aspectRatio as AspectRatio,
      customAspectW:
        typeof f.customAspectW === "number" ? f.customAspectW : undefined,
      customAspectH:
        typeof f.customAspectH === "number" ? f.customAspectH : undefined,
      resolutionTier,
      resolution: legacyResolution,
      count: Math.min(count, 10),
    },
  };
}

/** 与 i2i-job-store 的 clampI2ICountForProvider 完全一致;目录直传的
 *  动态 model id 不在表内,取 DEFAULT(源表逐项 4,语义等价)。 */
export function clampI2ICountForProvider(provider: string, count: number): number {
  const normalized = Number.isFinite(count) ? Math.floor(count) : 1;
  const safe = Math.max(normalized, 1);
  return Math.min(safe, MAX_I2I_COUNT_BY_PROVIDER[provider] ?? DEFAULT_MAX_I2I_COUNT);
}

// ─── 输入构建(语义照 buildNormalInputs/buildBatchInputs,多一步 Spaces 上传) ──

interface BuiltInputs {
  mode: Mode;
  /** normal:共享引用图 URL(顺序 main/character/style/scene/refs)。 */
  referenceUrls?: string[];
  /** batch:每 item 一组引用图 URL。 */
  perItemReferenceUrls?: string[][];
  items: I2ITaskItem[];
  hasCharacter?: boolean;
  hasStyle?: boolean;
  hasScene?: boolean;
}

type BuildResult = BuiltInputs | { error: string; status: number };

/** 上传一张引用图到 Spaces(服务身份 transport,authToken 传 "")。 */
async function uploadReference(file: I2IUploadFile): Promise<string> {
  return uploadBytesToSpaces({
    bytes: new Uint8Array(file.buffer),
    mimeType: file.mimetype || "image/png",
    scene: "IMAGE_CREATION_TASK_REF",
    authToken: "",
  });
}

function makeItems(mode: Mode, count: number): I2ITaskItem[] {
  const items: I2ITaskItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      index: i,
      typeKey: `i2i:${mode}:${i}`,
      label: `图 ${i + 1}`,
    });
  }
  return items;
}

@Injectable()
export class ImageToImageService {
  private readonly logger = new Logger(ImageToImageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: DispatchQueueService,
    private readonly runner: ImageGenItemRunnerService,
    private readonly usage: UsageService,
    private readonly gateway: AiGatewayProvider,
  ) {}

  async create(
    input: { form?: unknown; files: I2IUploadFiles; localRedrawResolutionTier?: LocalRedrawPlan["resolutionTier"] },
    userId: number,
    source: CreationSource = "platform",
  ): Promise<I2ICreateResult> {
    const parsedForm = parseForm(input.form);
    if (!parsedForm.ok) {
      return {
        ok: false,
        status: 400,
        error: `Invalid or missing \`form\` field: ${parsedForm.reason}`,
      };
    }

    let localRedraw: LocalRedrawPlan | undefined
    if (parsedForm.value.editMode === "local-redraw") {
      const files = input.files
      if (files.character?.length || files.style?.length || files.scene?.length || files.references?.length) {
        return { ok: false, status: 400, error: "局部重绘请用 main 上传原图，refs 按顺序上传标注图及额外参考图" }
      }
      try {
        localRedraw = await prepareLocalRedraw(this.prisma, [
          ...(files.main ?? []).map(file => file.buffer),
          ...(files.refs ?? []).map(file => file.buffer),
        ], this.gateway, parsedForm.value.prompt, input.localRedrawResolutionTier)
      } catch (error) {
        if (error instanceof HttpException) return { ok: false, status: error.getStatus(), error: error.message }
        throw error
      }
      Object.assign(parsedForm.value, {
        provider: localRedraw.provider, aspectRatio: "custom",
        customAspectW: localRedraw.generationWidth, customAspectH: localRedraw.generationHeight,
        resolution: `${localRedraw.generationWidth}x${localRedraw.generationHeight}`,
        ...(localRedraw.providerApplied ? { resolutionTier: localRedraw.providerApplied.resolution.toUpperCase() } : {}),
      })
    }

    const clamped = clampI2ICountForProvider(parsedForm.value.provider, parsedForm.value.count);
    const form: I2IForm =
      clamped === parsedForm.value.count
        ? parsedForm.value
        : { ...parsedForm.value, count: clamped };
    if (clamped !== parsedForm.value.count) {
      this.logger.warn(
        `[i2i] count_clamped provider=${parsedForm.value.provider} requested=${parsedForm.value.count} effective=${clamped}`,
      );
    }

    const built =
      form.mode === "normal"
        ? await this.buildNormalInputs(form, input.files)
        : await this.buildBatchInputs(input.files);
    if ("error" in built) {
      return { ok: false, status: built.status, error: built.error };
    }

    const total = built.items.length;
    if (total === 0) {
      return { ok: false, status: 400, error: "Nothing to generate" };
    }

    // 固定一口价预检：模型目录行配置 fixedCredits → 按「单价 × 张数」校验余额
    // （不打折口径，与执行器终态扣费同源）；未配置回落现状不预检。实时读库。
    const fixedCredits = await loadImageGenerationFixedCredits(this.usage, form.provider,
      localRedraw ? LOCAL_REDRAW_CATEGORY : undefined);
    if (fixedCredits) {
      try {
        await this.usage.assertExactCreditsAffordable(userId, fixedCredits.mul(total));
      } catch (err) {
        return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const taskId = randomUUID();
    const traceId = randomUUID();
    const jobId = randomUUID();

    const requestDraft: I2IRequestSnapshot = {
      kind: "IMAGE_TO_IMAGE",
      provider: form.provider,
      modelPublicId: resolveGatewayModel(form.provider) ?? form.provider,
      localRedraw,
      prompt: form.prompt,
      market: form.market,
      aspectRatio: form.aspectRatio,
      customAspectW: form.customAspectW,
      customAspectH: form.customAspectH,
      resolutionTier: form.resolutionTier,
      resolution: form.resolution,
      mode: form.mode,
      count: form.count,
      taskId,
      traceId,
      referenceUrls: built.mode === "normal" ? built.referenceUrls : undefined,
      perItemReferenceUrls:
        built.mode === "batch" ? built.perItemReferenceUrls : undefined,
      hasCharacter: built.mode === "normal" ? built.hasCharacter : undefined,
      hasStyle: built.mode === "normal" ? built.hasStyle : undefined,
      hasScene: built.mode === "normal" ? built.hasScene : undefined,
    };
    // JSON 往返剥掉 undefined 键,保持 request 快照干净可序列化。
    const request = JSON.parse(JSON.stringify(requestDraft)) as I2IRequestSnapshot;

    await this.prisma.imageGenJob.create({
      data: {
        id: jobId,
        userId,
        source,
        kind: "IMAGE_TO_IMAGE",
        businessType: IMAGE_CREATIVE_BUSINESS_TYPE,
        status: "QUEUED",
        request,
        // 审计快照列(生成记录视图筛选/分组用),与 request 同源
        model: request.provider,
        prompt: request.prompt,
        traceId,
        expiresAt: new Date(Date.now() + RETENTION_MS),
        items: {
          create: built.items.map((it) => ({
            idx: it.index,
            label: it.label,
            status: "QUEUED",
          })),
        },
      },
    });

    // 立即返回;执行与源路由的 queueMicrotask 一样后台进行,真相已落库。
    const rows = await this.prisma.imageGenItem.findMany({
      where: { jobId },
      orderBy: { idx: "asc" },
      select: { id: true },
    });
    const itemIds = rows.map((row) => row.id);
    // 源路由:openai-gpt-image 逐张串行(settleTasksSequentially),其余并行
    // (Promise.allSettled,单图失败互不影响)。映射到队列:串行 provider 单
    // 任务顺序执行,其余每 item 一个任务(由信号量限并发)。
    if (form.provider === "openai-gpt-image") {
      this.queue.enqueue(async () => {
        for (const itemId of itemIds) {
          await this.runner.executeItem(itemId);
        }
      });
    } else {
      for (const itemId of itemIds) {
        this.queue.enqueue(() => this.runner.executeItem(itemId));
      }
    }

    return { ok: true, jobId, taskId, traceId, total, items: built.items, ...(localRedraw ? { localRedraw } : {}) };
  }

  /** 过期/不存在/非本人 → null(控制器 404);否则投影源路由 I2IJobSnapshot。 */
  async getSnapshot(
    jobId: string,
    userId: number,
    source: CreationSource = "platform",
  ): Promise<I2IJobSnapshot | null> {
    const job = await this.prisma.imageGenJob.findFirst({
      where: { id: jobId, userId, source, kind: "IMAGE_TO_IMAGE" },
      include: { items: { orderBy: { idx: "asc" } } },
    });
    if (!job) return null;
    // expiresAt 可空（CHETAIDOU 恒 null）；旧来源为空视为无效记录
    if (job.expiresAt === null) {
      this.logger.warn(`ImageGenJob ${job.id} 缺少 expiresAt（非通用生图管线记录），按无效处理`);
      return null;
    }
    if (job.expiresAt.getTime() < Date.now()) return null;

    const request = job.request as I2IRequestSnapshot | null;
    const mode: Mode = request?.mode === "batch" ? "batch" : "normal";
    const items = job.items;
    const publicId = jsonObject(request).modelPublicId ?? jsonObject(items.find(i => i.status === "SUCCEEDED")?.gatewayImage).modelPublicId ?? job.model;
    const names = await modelDisplayNames(this.prisma, [publicId]);

    const images: I2IJobImageSnapshot[] = items.map((item) => {
      const base = {
        index: item.idx,
        typeKey: `i2i:${mode}:${item.idx}`,
        label: item.label ?? `图 ${item.idx + 1}`,
      };
      if (item.status === "SUCCEEDED") {
        return {
          ...base,
          status: "ready" as const,
          url: item.url ?? undefined,
          originalUrl: gatewayOriginalUrl(item.gatewayImage),
          mimeType: item.url ? mimeTypeForUrl(item.url) : undefined,
          gatewayImage: item.gatewayImage ?? undefined,
          width: item.width ?? gatewayImageDimensions(item.gatewayImage).width ?? null,
          height: item.height ?? gatewayImageDimensions(item.gatewayImage).height ?? null,
        };
      }
      if (item.status === "FAILED") {
        return {
          ...base,
          status: "failed" as const,
          errorMessage: item.errorMessage ?? undefined,
        };
      }
      return { ...base, status: "pending" as const };
    });

    const allTerminal =
      items.length > 0 &&
      items.every((i) => i.status === "SUCCEEDED" || i.status === "FAILED");
    // 源路由执行器用 allSettled 吞掉单图失败后正常返回,所以单图全挂时
    // Job 仍是 completed("failed" 仅保留给执行器本身的意外崩溃)。
    let status: I2IJobStatus;
    if (allTerminal) {
      status = "completed";
    } else if (items.some((i) => i.status !== "QUEUED")) {
      status = "running";
    } else {
      status = "queued";
    }

    let updatedAt = job.updatedAt.getTime();
    for (const item of items) {
      const t = item.updatedAt.getTime();
      if (t > updatedAt) updatedAt = t;
    }

    const snapshot: I2IJobSnapshot = {
      jobId: job.id,
      taskId: request?.taskId ?? "",
      traceId: request?.traceId ?? job.traceId ?? "",
      status,
      images,
      submittedAt: job.createdAt.getTime(),
      updatedAt,
      serverBilled: true,
      modelPublicId: publicId,
      displayName: names.get(publicId) ?? job.model ?? request?.provider ?? null,
      resolutionTier: request?.localRedraw
        ? request.localRedraw.resolutionTier ?? request.localRedraw.providerApplied?.resolution.toUpperCase() ?? null
        : request?.resolutionTier ?? null,
      ...(request?.localRedraw ? { localRedraw: request.localRedraw } : {}),
    };
    if (allTerminal) {
      snapshot.completedAt = updatedAt;
      snapshot.tokenUsage = normalizeAggregatedUsage(job.tokenUsage);
      snapshot.mcpUsage = { totalCalls: 0, callDetail: {} };
    }
    return snapshot;
  }

  private async buildNormalInputs(form: I2IForm, files: I2IUploadFiles): Promise<BuildResult> {
    const mainFile = files.main?.[0];
    if (!mainFile) {
      return { error: "Main reference image (`main`) is required", status: 400 };
    }
    const characterFile = files.character?.[0];
    const styleFile = files.style?.[0];
    const sceneFile = files.scene?.[0];
    // 自由附加 refs(批量改图回形针/粘贴),排在命名槽位之后随所有产出共享;
    // 与源路由一致静默截断到 10 张。
    const extraRefFiles = (files.refs ?? []).slice(0, 10);
    const sharedReferenceUrls: string[] = [];
    try {
      sharedReferenceUrls.push(await uploadReference(mainFile));
      if (characterFile) {
        sharedReferenceUrls.push(await uploadReference(characterFile));
      }
      if (styleFile) {
        sharedReferenceUrls.push(await uploadReference(styleFile));
      }
      if (sceneFile) {
        sharedReferenceUrls.push(await uploadReference(sceneFile));
      }
      for (const refFile of extraRefFiles) {
        sharedReferenceUrls.push(await uploadReference(refFile));
      }
    } catch {
      return { error: "Failed to read uploaded images", status: 400 };
    }
    return {
      mode: "normal",
      referenceUrls: sharedReferenceUrls,
      items: makeItems("normal", form.count),
      hasCharacter: Boolean(characterFile),
      hasStyle: Boolean(styleFile),
      hasScene: Boolean(sceneFile),
    };
  }

  private async buildBatchInputs(files: I2IUploadFiles): Promise<BuildResult> {
    const filesList = files.references ?? [];
    if (filesList.length === 0) {
      return { error: "At least one `references` file is required", status: 400 };
    }
    if (filesList.length > 10) {
      return { error: "Batch mode supports up to 10 reference images", status: 400 };
    }
    const perItemReferenceUrls: string[][] = [];
    try {
      for (const file of filesList) {
        perItemReferenceUrls.push([await uploadReference(file)]);
      }
    } catch {
      return { error: "Failed to read uploaded images", status: 400 };
    }
    return {
      mode: "batch",
      perItemReferenceUrls,
      items: makeItems("batch", filesList.length),
    };
  }
}

/** 把聚合后的 tokenUsage 记录投影成源路由 sumUsage 的输出形状:
 *  totalTokens 缺省回退 prompt+completion;thinkingTokens 为 0 时省略。 */
function normalizeAggregatedUsage(raw: unknown): TokenUsage {
  const record = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const prompt = num(record.promptTokens);
  const completion = num(record.completionTokens);
  const thinking = num(record.thinkingTokens);
  const total = num(record.totalTokens);
  const aggregated: TokenUsage = {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total || prompt + completion,
  };
  if (thinking > 0) aggregated.thinkingTokens = thinking;
  return aggregated;
}
