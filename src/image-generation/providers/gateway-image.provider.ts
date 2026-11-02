import { gatewayImageDimensions } from "../../common/utils/generation-metadata";
// Gateway 图片适配器（2026-09-10 起走 callback 模式）：提交带 callback:true，
// 终态以网关 image.task 回调为主信号（webhook → AiGatewayImageCallbacksService
// 进程内直递执行器），稀疏轮询兜底（回调丢失/本地开发无公网回调/多副本
// 回调落在别的副本时退化为纯轮询，行为正确只是慢）。
// 所有尺寸按 aspect_ratio + resolution 交给网关；交付仅按实际比例中心裁剪。

import { HttpException, Logger } from "@nestjs/common";
import type { ImageTask, ImageTaskRequest } from "@zhiqingresearch/ai-ts-sdk";
import { randomUUID } from "node:crypto";
import { buildCenterCropDirective, centerCropSafeRatio } from "../../common/utils/image-crop-safe-prompt";
import { resolveGatewayImageSizing } from "../../ai-gateway/gateway-native-image-sizing";
import type { AiGatewayProvider } from "../../ai-gateway/ai-gateway.provider";
import {
  AiGatewayImageCallbacksService,
  IMAGE_PIPELINE_IDEMPOTENCY_PREFIX,
} from "../../ai-gateway/ai-gateway-image-callbacks.service";
import {
  GatewaySizingIntent,
  resolveGatewaySizingIntent,
} from "../../ai-gateway/gateway-image-sizing";
import {
  RelayError,
  SIZE_ERROR_MESSAGE,
  classifyHttpStatus,
  friendlyMessage,
  isSizeRelatedError,
  sleep,
} from "../core/retry-utils";
import { uploadBytesToSpaces, uploadRemoteUrlToSpaces } from "../core/storage"
import { finalizeLocalRedraw } from "../local-redraw"
import type { ImageProvider, ProviderGenerateInput, ProviderGenerateResult } from "../core/types";
import {
  normalizeGatewayArtifact,
} from "./gateway-size-normalize";
/** backstop 轮询间隔（回调为主信号，轮询只兜丢失；env
 *  IMAGE_GATEWAY_CALLBACK_BACKSTOP_MS，下限 1s）。 */
const DEFAULT_BACKSTOP_POLL_MS = 15_000;
const DEFAULT_POLL_DEADLINE_MS = 480_000;

/** 成功态收窄（submitAndWait 只返回 succeeded，保住 result/usage 的联合窄化）。 */
type SucceededImageTask = Extract<ImageTask, { status: "succeeded" }>;

const logger = new Logger("GatewayImageProvider");

function toGatewayRequest(
  modelId: string,
  input: ProviderGenerateInput,
  sizing: GatewaySizingIntent,
  cropSafeRatio: string | null = null,
): ImageTaskRequest {
  const refs = input.referenceImages.map((reference) => {
    const url = reference.url?.trim();
    if (!url) {
      throw new RelayError(
        "permanent_validation",
        "参考图片缺少可用地址，请重新上传后重试",
        "网关图片请求的参考图缺少 URL，已阻止提交以避免丢失参考图",
      );
    }
    return { url };
  });
  const request: Record<string, unknown> = {
    model: modelId,
    prompt: cropSafeRatio ? `${input.prompt}\n\n${buildCenterCropDirective(cropSafeRatio)}` : input.prompt,
    operation: refs.length > 0 ? "edit" : "generate",
    n: 1,
    response_format: "url",
    // 2026-09-10 轮询改 callback:终态经 webhook(AiGatewayImageCallbacksService)
    // 直递执行器;backstop 轮询兜回调丢失。
    callback: true,
    strict: false,
    ...sizing,
  };
  if (refs.length > 0) {
    request.reference_images = refs;
  }
  return request as unknown as ImageTaskRequest;
}

/** 统一比例、档位和默认质量，并保留完整请求校验。 */
async function gatewaySizing(
  gateway: AiGatewayProvider,
  modelId: string,
  input: ProviderGenerateInput,
): Promise<GatewaySizingIntent | null> {
  let snapshot: Awaited<ReturnType<AiGatewayProvider["fetchModelSnapshot"]>>;
  try {
    snapshot = await gateway.fetchModelSnapshot(modelId, "images.generations");
  } catch (err) {
    throw gatewayCallError("查询生图模型能力", err);
  }
  if (!snapshot || snapshot.detail.modality !== "image") {
    throw new RelayError("permanent_validation", "生图模型未就绪，请稍后重试", modelId);
  }
  try {
    const ratio = input.aspectRatio === "custom"
      ? `${input.customAspectW}:${input.customAspectH}` : input.aspectRatio;
    const sizing = resolveGatewayImageSizing(
      snapshot, ratio, input.resolutionTier,
      toGatewayRequest(modelId, input, {}) as unknown as Record<string, unknown>,
    );
    if (!sizing) throw new RelayError("permanent_validation", "生图参数不符合模型配置", modelId);
    return sizing;
  } catch (err) {
    if (err instanceof RelayError) throw err;
    if (err instanceof HttpException && err.getStatus() === 400)
      throw new RelayError("permanent_validation", err.message, errorText(err));
    throw new RelayError("permanent_validation", "生图模型参数配置无效，请联系管理员同步模型", errorText(err));
  }
}

const NO_ROUTE_ERROR_RE = /no\s+(upstream\s+route|priced\s+image\s+task\s+route)/i;

function isNoRouteErrorText(text: string): boolean {
  return NO_ROUTE_ERROR_RE.test(text);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 路由缺失类错误 → 尺寸能力上限 RelayError;非路由错误返回 null
 *  (由调用方继续走常规分类)。 */
function routeLimitError(action: string, err: unknown): RelayError | null {
  const text = errorText(err);
  if (isSizeRelatedError(text) || isNoRouteErrorText(text)) {
    return new RelayError(
      "permanent_validation",
      SIZE_ERROR_MESSAGE,
      `${action}: 仍无可用路由: ${text}`,
    );
  }
  return null;
}

/** 等终态:网关 image.task 回调为主信号(webhook → callbacks hub 进程内
 * 直递),稀疏 backstop 轮询兜回调丢失/无公网回调的本地环境;deadline
 * 到点先做最后一次查询再判超时(保留原「截止即终态」的竞态语义,只是
 * 查询从退避轮询变成稀疏兜底)。 */
async function waitForTerminalTask(
  gateway: AiGatewayProvider,
  submitted: ImageTask,
  callbacks: AiGatewayImageCallbacksService | undefined,
): Promise<ImageTask> {
  const deadline =
    Date.now() +
    (Number(process.env.IMAGE_GATEWAY_POLL_TIMEOUT_MS) || DEFAULT_POLL_DEADLINE_MS);
  const backstopMs = Math.max(
    1_000,
    Number(process.env.IMAGE_GATEWAY_CALLBACK_BACKSTOP_MS) || DEFAULT_BACKSTOP_POLL_MS,
  );

  // side-channel:回调在 deadline 边缘 resolve 时,race 之外也能取到
  let viaCallback: ImageTask | null = null;
  const notified = callbacks?.waitForTerminal(submitted.id) ?? null;
  notified?.then((task) => {
    viaCallback = task;
  });

  const pollOnce = async (): Promise<ImageTask | null> => {
    try {
      const task = await gateway.getImageTask(submitted.id);
      return task.status === "queued" || task.status === "running" ? null : task;
    } catch (err) {
      // 网络/网关抖动按瞬态,继续等;鉴权/任务不存在立即失败(照旧)。
      if (err instanceof HttpException) {
        const status = err.getStatus();
        if (status === 401 || status === 403 || status === 404) {
          throw gatewayCallError("查询图片任务", err);
        }
      }
      return null;
    }
  };

  try {
    while (Date.now() < deadline) {
      const winner = await Promise.race([
        ...(notified
          ? [notified.then((task) => ({ task }))]
          : []),
        sleep(backstopMs).then(() => ({ task: null as ImageTask | null })),
      ]);
      if (winner.task) return winner.task;
      const polled = await pollOnce();
      if (polled) return polled;
    }
    if (viaCallback) return viaCallback;
    const final = await pollOnce();
    if (final) return final;
    throw new RelayError(
      "transient_timeout",
      friendlyMessage("transient_timeout"),
      `gateway task ${submitted.id} terminal wait deadline exceeded (callback + backstop)`,
    );
  } finally {
    callbacks?.release(submitted.id);
  }
}

/** 网关终态 → RelayError(走 core 的重试分类与用户文案)。 */
function terminalTaskError(task: ImageTask): RelayError {  if (task.status === "expired") {
    return new RelayError(
      "transient_timeout",
      friendlyMessage("transient_timeout"),
      `gateway task expired: ${task.id}`,
    );
  }
  if (task.status === "canceled") {
    return new RelayError(
      "permanent_validation",
      "生成任务已取消",
      `gateway task canceled: ${task.id}`,
    );
  }
  // failed —— 先看消息:尺寸/比例类(含路由缺失)是模型
  // 能力上限,归 permanent + 归一文案,不再按 type 一刀切落"图像服务繁忙";
  // 其余按 TaskError 的 type/code 粗分类,details 全量进日志。
  // (ImageTask 联合在循环后不再窄化,这里按终态形状取 error。)
  const err = (task as { error?: { type?: string; code?: string; message?: string } })
    .error;
  if (isSizeRelatedError(err?.message ?? "") || isNoRouteErrorText(err?.message ?? "")) {
    return new RelayError(
      "permanent_validation",
      SIZE_ERROR_MESSAGE,
      `gateway task failed: ${task.id} type=${err?.type ?? "unknown"} code=${err?.code ?? "unknown"} message=${err?.message ?? ""}`,
    );
  }
  const kind =
    err?.type === "invalid_request_error"
      ? "permanent_validation"
      : "transient_server";
  return new RelayError(
    kind,
    friendlyMessage(kind),
    `gateway task failed: ${task.id} type=${err?.type ?? "unknown"} code=${err?.code ?? "unknown"} message=${err?.message ?? ""}`,
  );
}

/** AiGatewayProvider 抛出的 Nest HttpException → RelayError(分类保口径)。 */
function gatewayCallError(action: string, err: unknown): RelayError {
  if (err instanceof RelayError) return err;
  const status = err instanceof HttpException ? err.getStatus() : undefined;
  const kind = classifyHttpStatus(status ?? 0);
  const details = `${action}: ${err instanceof Error ? err.message : String(err)}`;
  return new RelayError(kind, friendlyMessage(kind), details, status);
}

export function createGatewayImageProvider(
  gateway: AiGatewayProvider,
  modelId: string,
  callbacks?: AiGatewayImageCallbacksService,
): ImageProvider {
  return {
    id: modelId,
    async generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult> {
      if (input.localRedraw && modelId !== input.localRedraw.provider) {
        throw new RelayError("permanent_validation", "局部重绘模型配置不一致", "局部重绘必须使用任务快照中冻结的模型")
      }
      const sizing = input.localRedraw
        ? {
            ...input.localRedraw.providerApplied,
            ...resolveGatewaySizingIntent({
              aspectRatio: `${input.localRedraw.sourceWidth}:${input.localRedraw.sourceHeight}`,
              resolutionTier: input.localRedraw.resolutionTier ?? input.resolutionTier,
            }),
          }
        : await gatewaySizing(gateway, modelId, input) ?? {};
      const idempotencyKey = input.idempotencyKey ?? `${IMAGE_PIPELINE_IDEMPOTENCY_PREFIX}once:${randomUUID()}`;
      const cropSafeRatio = input.localRedraw ? null : centerCropSafeRatio(
        input.aspectRatio === "custom" || input.customSizeMode === "pixels"
          ? `${input.customAspectW}:${input.customAspectH}` : input.aspectRatio,
        sizing.aspect_ratio,
        input.aspectRatio === "custom" || input.customSizeMode === "pixels",
      );

      const submitAndWait = async (
        attemptSizing: GatewaySizingIntent,
        attemptKey: string,
      ): Promise<SucceededImageTask> => {
        let task: ImageTask;
        try {
          task = await gateway.createImageTask(
            toGatewayRequest(modelId, input, attemptSizing, cropSafeRatio),
            attemptKey,
          );
        } catch (err) {
          throw routeLimitError("提交图片任务", err) ?? gatewayCallError("提交图片任务", err);
        }
        if (task.status === "queued" || task.status === "running") {
          task = await waitForTerminalTask(gateway, task, callbacks);
        }
        if (task.status !== "succeeded") {
          throw terminalTaskError(task);
        }
        return task;
      };

      const recovered = input.resumeTaskId ? await gateway.getImageTask(input.resumeTaskId) : null;
      if (recovered && recovered.status !== "succeeded") throw terminalTaskError(recovered);
      const task = recovered ?? await submitAndWait(sizing, idempotencyKey);

      // 同时保留网关回显供日志对账和结果展示。
      if (task.adaptation) {
        logger.log(
          `网关就近适配 task=${task.id} requested=${JSON.stringify(task.adaptation.requested)} actual=${JSON.stringify(task.adaptation.actual)} changes=${task.adaptation.changes.join("; ")}`,
        );
      }
      const images = (
        task.result as { images?: Array<{ url: string; metadata?: Record<string, unknown> }> }
      )?.images;
      const url = images?.[0]?.url;
      if (!url) {
        throw new RelayError(
          "permanent_validation",
          friendlyMessage("permanent_validation"),
          `gateway task ${task.id} succeeded but returned no image artifact`,
        );
      }
      const metadata = images?.[0]?.metadata;
      await input.onGenerated?.(task.id);
      const dimensions = gatewayImageDimensions({ metadata, adaptation: task.adaptation });
      const { width, height } = dimensions;
      const result: ProviderGenerateResult = {
        url,
        mimeType: "image/png",
        gatewayTaskId: task.id,
        gatewayImage: {
          modelPublicId: modelId,
          ratioDelivery: true,
          ...(width ? { width } : {}),
          ...(height ? { height } : {}),
          ...(dimensions.nativeWidth ? { nativeWidth: dimensions.nativeWidth } : {}),
          ...(dimensions.nativeHeight ? { nativeHeight: dimensions.nativeHeight } : {}),
          ...(task.adaptation ? { adaptation: task.adaptation } : {}),
          ...(metadata ? { metadata } : {}),
        },
      };
      // D4 决议:amount(CNY Decimal 字符串)由执行器走
      // chargeGatewayUsageInTransaction;token 字段网关不提供,保持空。
      if (task.usage && task.usage.currency === "CNY") {
        result.costAmountCny = task.usage.amount;
      }
      // 原图单独转存；留存失败不改变既有成品交付，也不重新发起收费生成。
      try {
        const originalUrl = await uploadRemoteUrlToSpaces({
          url, scene: "IMAGE_CREATION_OUTPUT", authToken: "", labelId: `gateway:${task.id}:original`,
          signal: input.signal ?? AbortSignal.timeout(30_000),
        });
        result.gatewayImage = { ...result.gatewayImage, originalUrl };
      } catch {
        logger.warn({ event: "image_generation.original_save_failed", gatewayTaskId: task.id, modelPublicId: modelId });
      }
      if (input.localRedraw) {
        // 只重试已有产物的交付，不重提模型；按源图比例交付失败时不返回比例错误的成品。
        let lastError: unknown
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch(url, { signal: input.signal ?? AbortSignal.timeout(30_000) })
            if (!response.ok) throw new Error(`下载生成结果失败: ${response.status}`)
            const finalized = await finalizeLocalRedraw(new Uint8Array(await response.arrayBuffer()), input.localRedraw)
            result.url = await uploadBytesToSpaces({ bytes: finalized.bytes, mimeType: finalized.mimeType, scene: "IMAGE_CREATION_OUTPUT", authToken: "", labelId: `gateway:${task.id}:output` })
            result.mimeType = finalized.mimeType
            result.gatewayImage = { ...result.gatewayImage,
              width: finalized.width, height: finalized.height,
              nativeWidth: finalized.native.width, nativeHeight: finalized.native.height,
              normalized: {
                from: `${finalized.native.width}x${finalized.native.height}`,
                to: `${finalized.width}x${finalized.height}`,
                ops: finalized.ops,
              },
            }
            return result
          } catch (error) {
            lastError = error
            if (attempt < 2) await sleep(1000 * (attempt + 1))
          }
        }
        const message = lastError instanceof Error ? lastError.message : "交付处理失败"
        throw new RelayError("permanent_validation", `局部重绘交付失败：${message}`, message)
      }
      const normalized = await normalizeGatewayArtifact({ url, modelId, input });
      if (normalized) {
        result.url = normalized.url;
        result.mimeType = normalized.mimeType;
        result.gatewayImage = {
          ...result.gatewayImage,
          nativeWidth: dimensions.nativeWidth ?? Number(normalized.normalized.from.split("x")[0]),
          nativeHeight: dimensions.nativeHeight ?? Number(normalized.normalized.from.split("x")[1]),
          width: Number(normalized.normalized.to.split("x")[0]),
          height: Number(normalized.normalized.to.split("x")[1]),
          normalized: normalized.normalized,
        };
      }
      return result;
    },
  };
}
