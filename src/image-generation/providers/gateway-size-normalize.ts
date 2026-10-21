// 网关产物只按用户目标比例中心裁剪；比例一致时不重编码、不按档位缩放。
// 读取或处理失败时保留已生成的原始产物。

import { Logger } from "@nestjs/common";
import sharp from "sharp";
import { cropImageToAspectRatio } from "../../common/utils/image-aspect-crop";
import { resolveTargetImageSize } from "../core/size-adapters";
import type { ProviderGenerateInput } from "../core/types";

const logger = new Logger("GatewaySizeNormalize");

/** 归一输入像素上限,超过保原图 —— 防超大产物全分辨率解码撑爆内存(与
 *  Finalizer 同一约束语境)。默认 20MP:覆盖 Gemini 家族 4K 宽幅实测产物
 *  (21:9@4K = 6336×2688 ≈ 17.03MP,2026-09-10 实测),留 ~23% 余量。env:
 *  IMAGE_GATEWAY_NORMALIZE_MAX_PIXELS。 */
export const DEFAULT_NORMALIZE_MAX_PIXELS = 20_971_520;

export interface NormalizeGatewayImageInput {
  bytes: Buffer;
  targetWidth: number;
  targetHeight: number;
  /** 归一输入上限(像素数);调用方透传 env 值,纯函数不读 env。 */
  maxPixels?: number;
  /** 只裁不放大模式(尺寸能力降档后的交付口径,2026-09-22):目标 = 实测尺寸
   *  按该比例(w/h)裁掉超边,不做任何缩放 —— targetWidth/Height 被忽略。
   *  降档生成的图不允许上采样补回用户原始档位,比例回到目标即可。 */
  cropToRatio?: number;
  /** 兼容旧调用参数，实际统一使用中心裁剪。 */
  cropPosition?: "centre" | "attention"
}

export interface NormalizeGatewayImageResult {
  dataUrl: string;
  /** "WxH" 原始实测(sharp metadata,不信网关回显)。 */
  from: string;
  /** "WxH" 归一后(= 目标)。 */
  to: string;
  /** 中心裁剪与编码操作，供观测日志和 gatewayImage.normalized 下发。 */
  ops: string[];
}

/** T2 目标尺寸:与请求侧口径一致 —— pixels 模式精确 customAspectW×H
 *  (唯一事实源,不混入 working 尺寸),其余(常规 10 档 / custom ratio)按
 *  档位长边 + 比例由 resolveTargetImageSize 推导。 */
export function gatewayNormalizeTargetSize(
  input: Pick<
    ProviderGenerateInput,
    | "aspectRatio"
    | "customAspectW"
    | "customAspectH"
    | "customSizeMode"
    | "resolutionTier"
  >,
): { width: number; height: number } {
  if (
    input.customSizeMode === "pixels" &&
    !!input.customAspectW &&
    input.customAspectW > 0 &&
    !!input.customAspectH &&
    input.customAspectH > 0
  ) {
    return {
      width: Math.round(input.customAspectW),
      height: Math.round(input.customAspectH),
    };
  }
  const target = resolveTargetImageSize(input, "generic");
  return { width: target.width, height: target.height };
}

/** 实测比例一致返回 null；否则中心最大裁剪，异常保留原图。 */
export async function normalizeGatewayImage(
  input: NormalizeGatewayImageInput,
): Promise<NormalizeGatewayImageResult | null> {
  try {
    const meta = await sharp(input.bytes, { failOn: "none" }).metadata();
    const actualWidth = meta.width ?? 0;
    const actualHeight = meta.height ?? 0;
    if (actualWidth <= 0 || actualHeight <= 0) {
      logger.warn(`normalize skipped: unreadable dimensions (metadata)`);
      return null;
    }
    if (
      actualWidth * actualHeight >
      (input.maxPixels ?? DEFAULT_NORMALIZE_MAX_PIXELS)
    ) {
      logger.warn(
        `normalize skipped: input ${actualWidth}x${actualHeight} exceeds maxPixels ${input.maxPixels ?? DEFAULT_NORMALIZE_MAX_PIXELS}`,
      );
      return null;
    }

    const cropped = await cropImageToAspectRatio(
      input.bytes, input.cropToRatio ?? input.targetWidth / input.targetHeight, 1,
    );
    if (!cropped.cropped) return null;
    return {
      dataUrl: `data:${cropped.mimeType};base64,${cropped.bytes.toString("base64")}`,
      from: `${cropped.nativeWidth}x${cropped.nativeHeight}`,
      to: `${cropped.width}x${cropped.height}`,
      ops: cropped.ops,
    };
  } catch (err) {
    logger.warn(
      `normalize failed (keeping original artifact): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export interface GatewayArtifactNormalizeOptions {
  url: string;
  modelId: string;
  input: ProviderGenerateInput;
  cropPosition?: "centre" | "attention";
  /** 兼容历史调用指定目标比例。 */
  cropToRatio?: number;
}

export interface GatewayArtifactNormalizeOutcome {
  url: string;
  mimeType: string;
  /** 落 gatewayImage.normalized,快照原样透传(观测 + 对账)。 */
  normalized: { from: string; to: string; ops: string[] };
}

/** 下载实际产物并检查比例；裁剪结果继续由原有成品保存流程托管。 */
export async function normalizeGatewayArtifact(
  options: GatewayArtifactNormalizeOptions,
): Promise<GatewayArtifactNormalizeOutcome | null> {
  const { url, modelId, input } = options;
  const ratio = input.aspectRatio === "custom" || input.customSizeMode === "pixels"
    ? `${input.customAspectW}:${input.customAspectH}` : input.aspectRatio;
  const [width, height] = ratio.split(":").map(Number);
  let bytes: Buffer;
  try {
    bytes = await downloadArtifactBytes(url);
  } catch (err) {
    logger.warn(
      `normalize skipped: artifact download failed (keeping original url): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const maxPixels = Number(process.env.IMAGE_GATEWAY_NORMALIZE_MAX_PIXELS);
  const result = await normalizeGatewayImage({
    bytes,
    targetWidth: width,
    targetHeight: height,
    cropPosition: options.cropPosition,
    maxPixels: Number.isFinite(maxPixels) && maxPixels > 0 ? maxPixels : undefined,
    ...(options.cropToRatio && options.cropToRatio > 0
      ? { cropToRatio: options.cropToRatio }
      : {}),
  });
  if (!result) return null;
  const mimeType = result.dataUrl.startsWith("data:image/png;")
    ? "image/png"
    : "image/jpeg";
  logger.log(
    `归一化 model=${modelId} from=${result.from} to=${result.to} ops=${result.ops.join("|")}`,
  );
  return {
    url: result.dataUrl,
    mimeType,
    normalized: { from: result.from, to: result.to, ops: result.ops },
  };
}

/** 产物字节获取:data URL 直接 base64 解码;外链服务端 fetch(网关产物
 *  为短时效 URL,必须在本进程内取回)。 */
async function downloadArtifactBytes(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) {
    const base64 = url.split(",")[1] ?? "";
    return Buffer.from(base64, "base64");
  }
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`artifact fetch failed: status=${resp.status}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}
