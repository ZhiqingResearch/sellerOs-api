// src/server/image/prd-size-support.test.ts
//
// PRD「图片生成模块需求」尺寸支持矩阵 — Phase 1 (deterministic, no network).
//
// Drives every unique W×H from docs/references/图片生成模块需求.pdf through
// each provider's size adapter + the client-side gpt-image-2 validator, then
// writes a Markdown support report to docs/references/prd-size-support-report.md.
//
// What this phase verifies (without hitting any real model API):
//   1. Does the adapter accept the request, or does it throw (Gemini)?
//   2. What dimensions does the adapter ACTUALLY send to the model?
//   3. Do those dimensions still match the PRD-requested W×H, or did the
//      adapter snap / clamp / re-route to a different tile?
//   4. For gpt-image-2 — does the client-side validator block this size?
//
// The deterministic report is the BASELINE truth ("this is what we WILL ask
// the model for given a PRD size"). Phase 2 (`scripts/run-prd-size-e2e.mjs`)
// runs the live providers and inspects returned image dimensions.
//
// To run only this test:
//   npx vitest run src/server/image/prd-size-support.test.ts
//
// The Markdown output is committed alongside this file as a reproducible
// artifact, so reviewers can diff support-matrix changes across PRs.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  adaptGeminiNanoBananaProSize,
  adaptGptImage2Size,
  adaptWan27ProSize,
  type TargetImageSize,
} from "./size-adapters";
import { GPT_IMAGE_2_LIMITS } from "./gpt-image-2-limits";
import type { ProviderGenerateInput, ResolutionTier } from "./types";

interface PrdSize {
  /** Stable id used in the report's leftmost column. */
  id: string;
  block: "主副图" | "品牌故事" | "普通A+" | "高级A+";
  /** Free-text purpose blurb pulled from the PRD. */
  purpose: string;
  width: number;
  height: number;
  /** True when the PRD itself says "或更高" — implies upscale is permitted. */
  flexibleMin?: boolean;
}

const PRD_SIZES: PrdSize[] = [
  // 板块一：主副图
  { id: "M-01", block: "主副图", purpose: "主图（正方形）",     width: 1600, height: 1600, flexibleMin: true },
  { id: "M-02", block: "主副图", purpose: "副图（正方形）",     width: 1600, height: 1600, flexibleMin: true },
  { id: "M-03", block: "主副图", purpose: "副图（长方形）",     width: 1200, height: 1500, flexibleMin: true },

  // 板块二：品牌故事 (5 unique tiles reused across 10 combos)
  { id: "B-01", block: "品牌故事", purpose: "桌面品牌背景图",   width: 1464, height: 625 },
  { id: "B-02", block: "品牌故事", purpose: "移动端品牌背景图", width: 463,  height: 625 },
  { id: "B-03", block: "品牌故事", purpose: "品牌 Logo 图",     width: 315,  height: 145 },
  { id: "B-04", block: "品牌故事", purpose: "场景图 / Logo",    width: 362,  height: 453 },
  { id: "B-05", block: "品牌故事", purpose: "产品矩阵小图",     width: 166,  height: 182 },

  // 板块三 a：普通 A+ (9 unique tiles)
  { id: "A-01", block: "普通A+",  purpose: "Logo 横幅",         width: 600,  height: 180 },
  { id: "A-02", block: "普通A+",  purpose: "标准横幅 / 三图卖点", width: 970,  height: 300 },
  { id: "A-03", block: "普通A+",  purpose: "大场景图",          width: 970,  height: 600 },
  { id: "A-04", block: "普通A+",  purpose: "标准方图 / 卖点",    width: 300,  height: 300 },
  { id: "A-05", block: "普通A+",  purpose: "四图功能",          width: 220,  height: 200 },
  { id: "A-06", block: "普通A+",  purpose: "侧边栏图文",        width: 300,  height: 400 },
  { id: "A-07", block: "普通A+",  purpose: "规格细节",          width: 300,  height: 175 },
  { id: "A-08", block: "普通A+",  purpose: "对比表竖条",        width: 150,  height: 300 },
  { id: "A-09", block: "普通A+",  purpose: "四宫格细节",        width: 135,  height: 135 },

  // 板块三 b：高级 A+ / Premium A+ (7 unique tiles)
  { id: "P-01", block: "高级A+",  purpose: "Premium 横幅 / Full Image", width: 1464, height: 600 },
  { id: "P-02", block: "高级A+",  purpose: "标准展示图",        width: 600,  height: 450 },
  { id: "P-03", block: "高级A+",  purpose: "Carousel 单屏",     width: 800,  height: 600 },
  { id: "P-04", block: "高级A+",  purpose: "Four Images / 对比图", width: 300, height: 225 },
  { id: "P-05", block: "高级A+",  purpose: "Q&A / 长图",        width: 488,  height: 700 },
  { id: "P-06", block: "高级A+",  purpose: "Comparison Table",  width: 650,  height: 350 },
  { id: "P-07", block: "高级A+",  purpose: "200×225 单元",      width: 200,  height: 225 },
];

function gcd(a: number, b: number): number {
  let x = Math.abs(a), y = Math.abs(b);
  while (y) { const t = y; y = x % y; x = t; }
  return x || 1;
}

function simplifiedAspect(w: number, h: number): string {
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

function asRatio(w: number, h: number): number {
  return Math.max(w, h) / Math.min(w, h);
}

function makeInput(size: PrdSize, tier: ResolutionTier = "2K"):
  Pick<ProviderGenerateInput, "aspectRatio" | "customAspectW" | "customAspectH"
       | "customSizeMode" | "resolutionTier"> {
  return {
    aspectRatio: "custom",
    customAspectW: size.width,
    customAspectH: size.height,
    customSizeMode: "pixels",
    resolutionTier: tier,
  };
}

interface RowResult {
  size: PrdSize;
  aspect: string;
  ratio: number;
  pixels: number;

  /** Would the client-side W×H validator block this if a user typed it in? */
  clientGate: "pass" | "block-multipleOf16" | "block-maxEdge"
              | "block-maxRatio" | "block-minPixels" | "block-maxPixels";

  /** Adapter outcomes — `null` when the adapter threw, otherwise the
   *  TargetImageSize it would forward to the model. */
  gptImage2: { ok: true; out: TargetImageSize; exactMatch: boolean }
           | { ok: false; reason: string };
  gemini:    { ok: true; out: TargetImageSize; exactMatch: boolean }
           | { ok: false; reason: string };
  wan:       { ok: true; out: TargetImageSize; size: "1K" | "2K";
               exactMatch: boolean }
           | { ok: false; reason: string };
}

function classifyClientGate(size: PrdSize): RowResult["clientGate"] {
  const { width, height } = size;
  const L = GPT_IMAGE_2_LIMITS;
  if (width % L.multipleOf !== 0 || height % L.multipleOf !== 0)
    return "block-multipleOf16";
  if (Math.max(width, height) > L.maxEdge) return "block-maxEdge";
  if (asRatio(width, height) > L.maxAspectRatio) return "block-maxRatio";
  if (width * height < L.minPixels) return "block-minPixels";
  if (width * height > L.maxPixels) return "block-maxPixels";
  return "pass";
}

function exact(out: TargetImageSize, size: PrdSize): boolean {
  return out.width === size.width && out.height === size.height;
}

function evaluate(size: PrdSize): RowResult {
  const aspect = simplifiedAspect(size.width, size.height);
  const ratio = asRatio(size.width, size.height);
  const pixels = size.width * size.height;
  const clientGate = classifyClientGate(size);

  // gpt-image-2 (relay) — adapter always returns; just measure how close.
  let gptOut: RowResult["gptImage2"];
  try {
    const { targetSize } = adaptGptImage2Size(makeInput(size));
    gptOut = { ok: true, out: targetSize, exactMatch: exact(targetSize, size) };
  } catch (err) {
    gptOut = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // Gemini Nano Banana Pro — throws on unsupported aspect.
  let geminiOut: RowResult["gemini"];
  try {
    const r = adaptGeminiNanoBananaProSize(makeInput(size));
    geminiOut = {
      ok: true,
      out: {
        width: 0, height: 0, size: "n/a (aspect+tier)",
        aspectRatio: r.aspectRatio, resolutionTier: r.imageSize, longestSide: 0,
      },
      exactMatch: false, // Gemini delivers aspect+tier, not exact W×H.
    };
  } catch (err) {
    geminiOut = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // Wan-2.7-Pro — never rejects, always returns ≤ 2K square-snapped (64).
  let wanOut: RowResult["wan"];
  try {
    const r = adaptWan27ProSize(makeInput(size));
    const wanTier: "1K" | "2K" =
      Math.max(r.width, r.height) <= 1024 ? "1K" : "2K";
    wanOut = {
      ok: true,
      out: r.targetSize,
      size: wanTier,
      exactMatch: exact(r.targetSize, size),
    };
  } catch (err) {
    wanOut = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  return { size, aspect, ratio, pixels, clientGate,
           gptImage2: gptOut, gemini: geminiOut, wan: wanOut };
}

const results: RowResult[] = [];

describe("PRD size support matrix (Phase 1 — static)", () => {
  it.each(PRD_SIZES)("$id  $width×$height  $purpose", (size) => {
    const r = evaluate(size);
    results.push(r);

    // Strong assertions on adapter invariants — these MUST hold regardless of
    // input. A regression here breaks every provider.
    if (r.gptImage2.ok) {
      const o = r.gptImage2.out;
      expect(o.width  % 16).toBe(0);
      expect(o.height % 16).toBe(0);
      expect(o.width * o.height).toBeGreaterThanOrEqual(GPT_IMAGE_2_LIMITS.minPixels);
      expect(o.width * o.height).toBeLessThanOrEqual(GPT_IMAGE_2_LIMITS.maxPixels);
      expect(Math.max(o.width, o.height)).toBeLessThanOrEqual(3840);
    }
    if (r.wan.ok) {
      expect(r.wan.out.width  % 64).toBe(0);
      expect(r.wan.out.height % 64).toBe(0);
      expect(Math.max(r.wan.out.width, r.wan.out.height)).toBeLessThanOrEqual(2048);
    }
  });

  afterAll(() => {
    const path = join(process.cwd(),
      "docs/references/prd-size-support-report.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderReport(results));
    console.log(`[prd-size-support] report → ${path}`);
  });
});

// ── Report renderer ────────────────────────────────────────────────────────

function renderReport(rows: RowResult[]): string {
  const totals = {
    gptNative: 0, gptAdapted: 0, gptRejected: 0,
    gemNative: 0, gemRejected: 0,
    wanNative: 0, wanAdapted: 0,
    clientPass: 0, clientBlock: 0,
  };
  for (const r of rows) {
    if (r.clientGate === "pass") totals.clientPass++; else totals.clientBlock++;
    if (r.gptImage2.ok) {
      if (r.gptImage2.exactMatch) totals.gptNative++;
      else totals.gptAdapted++;
    } else totals.gptRejected++;
    if (r.gemini.ok) totals.gemNative++; else totals.gemRejected++;
    if (r.wan.ok) {
      if (r.wan.exactMatch) totals.wanNative++; else totals.wanAdapted++;
    }
  }

  const fmt = (n: number) => `${n}/${rows.length} (${Math.round(n / rows.length * 100)}%)`;

  const tableRows = rows.map((r) => {
    const g = r.gptImage2;
    const e = r.gemini;
    const w = r.wan;
    const gStr = g.ok
      ? `${g.out.width}×${g.out.height}${g.exactMatch ? " ✅" : " 🟡"}`
      : `❌ ${g.reason.slice(0, 28)}`;
    const eStr = e.ok ? `✅ ${e.out.aspectRatio} @ ${e.out.resolutionTier}`
                      : `❌ ${e.reason.slice(0, 32)}`;
    const wStr = w.ok
      ? `${w.out.width}×${w.out.height} (${w.size})${w.exactMatch ? " ✅" : " 🟡"}`
      : `❌ ${w.reason.slice(0, 28)}`;
    const gate = r.clientGate === "pass" ? "✅" : `❌ ${r.clientGate.replace("block-","")}`;
    return `| ${r.size.id} | ${r.size.block} | ${r.size.width}×${r.size.height}`
         + ` | ${r.aspect} | ${r.size.purpose} | ${gate}`
         + ` | ${gStr} | ${eStr} | ${wStr} |`;
  }).join("\n");

  return `# PRD 图片尺寸支持矩阵 — Phase 1 (静态分析)

> 由 \`src/server/image/prd-size-support.test.ts\` 自动生成，请勿手工编辑。
> 重新生成：\`npx vitest run src/server/image/prd-size-support.test.ts\`

## 总览

| 通道 | 原生命中 (✅) | 适配后命中 (🟡) | 拒绝 (❌) |
|---|---|---|---|
| **客户端 W×H 校验**（用户在 UI 直接输入此尺寸） | ${fmt(totals.clientPass)} | — | ${fmt(totals.clientBlock)} |
| **gpt-image-2 / relay** | ${fmt(totals.gptNative)} | ${fmt(totals.gptAdapted)} | ${fmt(totals.gptRejected)} |
| **Gemini Nano Banana Pro (ZQ-Image-1)** | ${fmt(totals.gemNative)} | — | ${fmt(totals.gemRejected)} |
| **Wan-2.7-Pro (ZQ-Image-Spicy)** | ${fmt(totals.wanNative)} | ${fmt(totals.wanAdapted)} | — |

记号定义：
- **✅ 原生**：模型 API 直接接受目标 W×H，且适配器输出与 PRD 尺寸像素级一致。
- **🟡 适配后**：适配器没有拒绝，但模型实际生成的尺寸 ≠ PRD 目标尺寸（被 16 的倍数、像素下限、最长边等约束 snap 过）。前端拿到图片后**仍需要做后处理裁切 / 缩放**才能落到 PRD 目标尺寸。
- **❌ 拒绝**：适配器抛错或客户端校验不通过。Gemini 上 ❌ 表示请求的比例不在其枚举内；Wan 不在此列（无 W×H 字段）。

## 详细矩阵

| ID | 板块 | PRD 尺寸 | 简化比例 | 用途 | UI W×H 校验 | gpt-image-2 适配输出 | Gemini Nano 适配输出 | Wan-2.7-Pro 适配输出 |
|---|---|---|---|---|---|---|---|---|
${tableRows}

## 已观察到的几类共性问题

1. **窄长条 (10:3 / 970:300)**：超过 gpt-image-2 的 \`maxAspectRatio: 3\` 限制，客户端 UI 直接拒绝。后端适配器目前没有这条硬检查，会继续返回一个 snap 过的尺寸 — 这是潜在静默劣化点（参见适配器中 \`constrainForGptImage2\`，仅按像素/边长收敛，不按比例）。
2. **像素 < 655,360 的小图（A+ / 矩阵小图）**：gpt-image-2 的 \`minPixels\` 会强制放大到至少 ~810×810 等；PRD 目标尺寸只能靠后处理 downscale 得到。
3. **Gemini 比例枚举严格**：任何非 1:1 / 4:3 / 4:5 / 9:16 / 16:9 / 21:9 等枚举值的 PRD 尺寸都会被适配器在请求阶段抛出 \`ZQ-Image-1 暂不支持自定义比例\`。Gemini 通道实际不可用的尺寸需要走 gpt-image-2 或 Wan。
4. **Wan-2.7-Pro 无 W×H 字段**：永远是 1K/2K 整图、比例随首图而定。任何 PRD 尺寸用 Wan 都属于"生成大图 → 后裁切"流程，不可能像素级命中。

## Phase 2 — 端到端真实生成

Phase 1 仅验证适配器层；模型可能在 API 层进一步劣化输出 (例如 Wan 不一定真的回 2048×2048)。
跑 \`scripts/run-prd-size-e2e.mjs\` (需 \`GEMINI_API_KEY\` / \`ATLASCLOUD_API_KEY\` /
relay 凭证 + 一张参考图)，会对每个 (尺寸, 模型) 真实生成 1 张，并用 \`sharp\` 读返回
图片的 metadata 校验维度，最终覆盖追加到本报告底部。
`;
}
