// src/image-generation/core/equivalence-runtime.ts
//
// 跨仓库等价性矩阵(后端重放侧运行时)。
//
// fixture 由前端仓库 amazon-agent 的 src/server/image/equivalence-matrix.ts
// 用**当前生产实现**录制(EQUIV_UPDATE=1),本文件用移植实现逐条重放:
//   - 输出(含抛错信息)必须与录制值 deep-equal;
//   - 全矩阵 sha256 必须与 fixture 记录值一致。
// 同步流程:前端重录 → 拷贝 JSON 到本目录 __fixtures__/ → 本仓库跑
// equivalence.spec.ts。两侧分发器语义必须保持一致(仅导入路径不同)。

import { createHash } from "node:crypto";
import {
  buildImageCreationPrompt,
  buildImageCreationPromptStructured,
  buildImagePrompt,
  buildWanEditPrompt,
} from "./prompt-builder";
import {
  GEMINI_SUPPORTED_ASPECTS,
  adaptGeminiNanoBananaProSize,
  adaptGptImage2RelaySize,
  adaptGptImage2Size,
  adaptWan27ProSize,
  normalizeResolutionTier,
  resolveTargetImageSize,
  resolutionTierFromResolution,
} from "./size-adapters";
import { plan } from "./delivery-planner";
import {
  classifyBodyMessage,
  classifyHttpStatus,
  describeImageError,
  friendlyMessage,
  isSizeRelatedError,
  isTransient,
  parseRetryAfterHeader,
} from "./retry-utils";

export interface EquivalenceCase {
  id: string;
  fn: string;
  args: unknown[];
}

export interface EquivalenceCaseResult {
  value?: unknown;
  throws?: string;
}

export interface EquivalenceFixture {
  schema: 1;
  caseCount: number;
  matrixSha256: string;
  cases: Array<EquivalenceCase & { result: EquivalenceCaseResult }>;
}

export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const obj: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        obj[key] = walk((v as Record<string, unknown>)[key]);
      }
      return obj;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function sha256Of(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function makeError(arg: unknown): unknown {
  if (arg && typeof arg === "object" && "__error" in (arg as Record<string, unknown>)) {
    const e = (arg as Record<string, unknown>).__error as Record<string, unknown>;
    return Object.assign(new Error(String(e.message)), {
      status: e.status,
      cause: typeof e.cause === "string" ? e.cause : undefined,
    });
  }
  return arg;
}

export function runCase(fn: string, args: unknown[]): EquivalenceCaseResult {
  try {
    switch (fn) {
      case "buildImagePrompt":
        return { value: buildImagePrompt(args[0] as never) };
      case "buildWanEditPrompt":
        return { value: buildWanEditPrompt(args[0] as never) };
      case "buildImageCreationPrompt":
        return { value: buildImageCreationPrompt(args[0] as never) };
      case "buildImageCreationPromptStructured":
        return {
          value: buildImageCreationPromptStructured(
            args[0] as never,
            (args[1] as never) ?? {},
          ),
        };
      case "resolveTargetImageSize":
        return {
          value: resolveTargetImageSize(args[0] as never, (args[1] as never) ?? "generic"),
        };
      case "adaptGptImage2Size":
        return { value: adaptGptImage2Size(args[0] as never) };
      case "adaptGptImage2RelaySize":
        return { value: adaptGptImage2RelaySize(args[0] as never) };
      case "adaptGeminiNanoBananaProSize":
        return { value: adaptGeminiNanoBananaProSize(args[0] as never) };
      case "adaptWan27ProSize":
        return { value: adaptWan27ProSize(args[0] as never) };
      case "normalizeResolutionTier":
        return { value: normalizeResolutionTier(args[0], args[1] as string | undefined) };
      case "resolutionTierFromResolution":
        return { value: resolutionTierFromResolution(args[0] as string) };
      case "plan":
        return { value: plan(args[0] as never) };
      case "classifyHttpStatus":
        return { value: classifyHttpStatus(args[0] as number) };
      case "classifyBodyMessage":
        return { value: classifyBodyMessage(args[0] as string) };
      case "friendlyMessage":
        return { value: friendlyMessage(args[0] as never) };
      case "isTransient":
        return { value: isTransient(args[0] as never) };
      case "isSizeRelatedError":
        return { value: isSizeRelatedError(makeError(args[0])) };
      case "describeImageError":
        return { value: describeImageError(makeError(args[0])) };
      case "parseRetryAfterHeader":
        return { value: parseRetryAfterHeader(args[0] as string | null) };
      default:
        throw new Error(`unknown fn: ${fn}`);
    }
  } catch (err) {
    return { throws: err instanceof Error ? err.message : String(err) };
  }
}

// 保留导入避免未使用告警:两侧运行时保持同一组符号面。
export const EQUIVALENCE_FN_SURFACE = {
  GEMINI_SUPPORTED_ASPECTS,
  plan,
} as const;
