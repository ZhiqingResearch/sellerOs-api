import type {
  AspectRatio,
  ProviderGenerateInput,
  ResolutionTier,
} from "./types";

export interface TargetImageSize {
  width: number;
  height: number;
  size: string;
  aspectRatio: string;
  resolutionTier: ResolutionTier;
  longestSide: number;
}

export interface GptImage2SizeParams {
  size: string;
  quality: "medium" | "high";
  targetSize: TargetImageSize;
}

export interface GptImage2RelaySizeParams {
  selectedModel: string;
  aspectRatio: string;
  targetSize: TargetImageSize;
}

export interface GeminiNanoBananaProSizeParams {
  aspectRatio: string;
  imageSize: ResolutionTier;
}

export interface Wan27ProSizeParams {
  width: number;
  height: number;
  targetSize: TargetImageSize;
}

const TIER_LONG_SIDE: Record<ResolutionTier, number> = {
  "1K": 1024,
  "2K": 2048,
  "3K": 3072,
  "4K": 4096,
};

export const GEMINI_SUPPORTED_ASPECTS = new Set([
  "1:1",
  "1:4",
  "1:8",
  "2:3",
  "3:2",
  "3:4",
  "4:1",
  "4:3",
  "4:5",
  "5:4",
  "8:1",
  "9:16",
  "16:9",
  "21:9",
]);

const GPT_MAX_EDGE = 3840;
const GPT_MIN_PIXELS = 655_360;
const GPT_MAX_PIXELS = 8_294_400;
const GPT_MULTIPLE = 16;

/** 校验比例格式，不按模型能力或固定枚举限制比例，保留调用方原值。 */
export function isImageAspectRatio(value: unknown): value is `${number}:${number}` {
  return typeof value === "string" && /^[1-9]\d*:[1-9]\d*$/.test(value) &&
    value.split(":").every(part => Number.isSafeInteger(Number(part)));
}

export function isResolutionTier(value: unknown): value is ResolutionTier {
  return value === "1K" || value === "2K" || value === "3K" || value === "4K";
}

export function resolutionTierFromResolution(resolution: string): ResolutionTier {
  const match = /^(\d+)x(\d+)$/.exec(resolution.trim());
  if (!match) return "1K";
  const longest = Math.max(Number(match[1]), Number(match[2]));
  if (longest >= 3584) return "4K";
  if (longest >= 2560) return "3K";
  if (longest >= 1536) return "2K";
  return "1K";
}

export function normalizeResolutionTier(
  raw: unknown,
  fallbackResolution?: string,
): ResolutionTier {
  const tier = isResolutionTier(raw)
    ? raw
    : fallbackResolution
      ? resolutionTierFromResolution(fallbackResolution)
      : "1K";
  // 3K 已被网关下线（2026-09-14 全目录 resolution 枚举仅 1k/2k/4k）：入口
  // 统一降档 2K（保守——不让用户多花 4K 档的钱），前端档位下拉同步下线中；
  // ResolutionTier 类型与 TIER_LONG_SIDE 保留 3K 以服务存量 DB 快照。
  return tier === "3K" ? "2K" : tier;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function aspectParts(
  aspectRatio: AspectRatio,
  customAspectW?: number,
  customAspectH?: number,
): { w: number; h: number; label: string } {
  if (aspectRatio === "custom") {
    const w = customAspectW && customAspectW > 0 ? customAspectW : 1;
    const h = customAspectH && customAspectH > 0 ? customAspectH : 1;
    const d = gcd(w, h);
    return { w: w / d, h: h / d, label: `${w / d}:${h / d}` };
  }
  const [w, h] = aspectRatio.split(":").map(Number);
  return { w, h, label: aspectRatio };
}

function sizeString(width: number, height: number): string {
  return `${width}x${height}`;
}

function dimensionsForLongestSide(
  ratioW: number,
  ratioH: number,
  longestSide: number,
): { width: number; height: number } {
  if (ratioW >= ratioH) {
    return {
      width: longestSide,
      height: Math.round(longestSide * (ratioH / ratioW)),
    };
  }
  return {
    width: Math.round(longestSide * (ratioW / ratioH)),
    height: longestSide,
  };
}

function floorToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.floor(value / multiple) * multiple);
}

function ceilToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple);
}

function scaleDimensions(
  width: number,
  height: number,
  scale: number,
  snap: "floor" | "ceil",
): { width: number; height: number } {
  const fn = snap === "floor" ? floorToMultiple : ceilToMultiple;
  return {
    width: fn(width * scale, GPT_MULTIPLE),
    height: fn(height * scale, GPT_MULTIPLE),
  };
}

function constrainForGptImage2(width: number, height: number): {
  width: number;
  height: number;
} {
  let w = width;
  let h = height;
  const longest = Math.max(w, h);
  if (longest > GPT_MAX_EDGE) {
    ({ width: w, height: h } = scaleDimensions(w, h, GPT_MAX_EDGE / longest, "floor"));
  } else {
    w = floorToMultiple(w, GPT_MULTIPLE);
    h = floorToMultiple(h, GPT_MULTIPLE);
  }

  let pixels = w * h;
  if (pixels > GPT_MAX_PIXELS) {
    ({ width: w, height: h } = scaleDimensions(
      w,
      h,
      Math.sqrt(GPT_MAX_PIXELS / pixels),
      "floor",
    ));
    pixels = w * h;
  }

  if (pixels < GPT_MIN_PIXELS) {
    ({ width: w, height: h } = scaleDimensions(
      w,
      h,
      Math.sqrt(GPT_MIN_PIXELS / pixels),
      "ceil",
    ));
  }

  while (w * h > GPT_MAX_PIXELS || Math.max(w, h) > GPT_MAX_EDGE) {
    if (w >= h) w -= GPT_MULTIPLE;
    else h -= GPT_MULTIPLE;
  }

  return { width: w, height: h };
}

export function resolveTargetImageSize(
  input: Pick<
    ProviderGenerateInput,
    | "aspectRatio"
    | "customAspectW"
    | "customAspectH"
    | "customSizeMode"
    | "resolutionTier"
    | "workingWidth"
    | "workingHeight"
  >,
  policy: "generic" | "gpt-image-2" = "generic",
): TargetImageSize {
  // Target-size delivery: an explicit working size (from the Delivery Planner)
  // wins over aspectRatio/customAspect — it IS the size we want generated. The
  // policy constraints below (gpt multipleOf16/minPixels) still apply on top.
  const hasWorking =
    !!input.workingWidth &&
    input.workingWidth > 0 &&
    !!input.workingHeight &&
    input.workingHeight > 0;

  const isCustomPixels =
    input.aspectRatio === "custom" &&
    input.customSizeMode === "pixels" &&
    !!input.customAspectW &&
    !!input.customAspectH;

  let width: number;
  let height: number;
  let label: string;

  if (hasWorking) {
    width = Math.round(input.workingWidth!);
    height = Math.round(input.workingHeight!);
    const d = gcd(width, height);
    label = `${width / d}:${height / d}`;
  } else if (isCustomPixels) {
    width = Math.round(input.customAspectW!);
    height = Math.round(input.customAspectH!);
    const d = gcd(width, height);
    label = `${width / d}:${height / d}`;
  } else {
    const parts = aspectParts(
      input.aspectRatio,
      input.customAspectW,
      input.customAspectH,
    );
    const long = TIER_LONG_SIDE[input.resolutionTier];
    ({ width, height } = dimensionsForLongestSide(parts.w, parts.h, long));
    label = parts.label;
  }

  if (policy === "gpt-image-2") {
    ({ width, height } = constrainForGptImage2(width, height));
  }

  return {
    width,
    height,
    size: sizeString(width, height),
    aspectRatio: label,
    resolutionTier: input.resolutionTier,
    longestSide: Math.max(width, height),
  };
}

export function adaptGeminiNanoBananaProSize(
  input: Pick<
    ProviderGenerateInput,
    | "aspectRatio"
    | "customAspectW"
    | "customAspectH"
    | "customSizeMode"
    | "resolutionTier"
  >,
): GeminiNanoBananaProSizeParams {
  const aspect = aspectParts(
    input.aspectRatio,
    input.customAspectW,
    input.customAspectH,
  ).label;
  if (!GEMINI_SUPPORTED_ASPECTS.has(aspect)) {
    throw new Error(`ZQ-Image-1 暂不支持自定义比例 ${aspect}，请改用常用比例`);
  }
  return {
    aspectRatio: aspect,
    imageSize: input.resolutionTier,
  };
}

export function adaptGptImage2RelaySize(
  input: Pick<
    ProviderGenerateInput,
    | "aspectRatio"
    | "customAspectW"
    | "customAspectH"
    | "customSizeMode"
    | "resolutionTier"
  >,
): GptImage2RelaySizeParams {
  const targetSize = resolveTargetImageSize(input, "gpt-image-2");
  // The relay only ships 1K/2K/4K SKUs; 3K shares the 4K SKU since its
  // longest side (3072px) exceeds the 2K SKU's ~1024px ceiling.
  const selectedModel =
    input.resolutionTier === "4K" || input.resolutionTier === "3K"
      ? "gpt-image-2-4k"
      : input.resolutionTier === "2K"
        ? "gpt-image-2-2k"
        : "gpt-image-2";
  return {
    selectedModel,
    aspectRatio: targetSize.aspectRatio,
    targetSize,
  };
}

export function adaptGptImage2Size(
  input: Pick<
    ProviderGenerateInput,
    | "aspectRatio"
    | "customAspectW"
    | "customAspectH"
    | "customSizeMode"
    | "resolutionTier"
  >,
): GptImage2SizeParams {
  const targetSize = resolveTargetImageSize(input, "gpt-image-2");
  return {
    size: targetSize.size,
    quality: input.resolutionTier === "1K" ? "medium" : "high",
    targetSize,
  };
}

export function adaptWan27ProSize(
  input: Pick<
    ProviderGenerateInput,
    | "aspectRatio"
    | "customAspectW"
    | "customAspectH"
    | "customSizeMode"
    | "resolutionTier"
  >,
): Wan27ProSizeParams {
  const targetSize = resolveTargetImageSize(input, "generic");
  const snap64 = (n: number) => Math.max(64, Math.round(n / 64) * 64);
  const width = snap64(targetSize.width);
  const height = snap64(targetSize.height);
  return {
    width,
    height,
    targetSize: {
      ...targetSize,
      width,
      height,
      size: sizeString(width, height),
      longestSide: Math.max(width, height),
    },
  };
}
