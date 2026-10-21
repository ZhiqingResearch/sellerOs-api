// Image Finalizer — deterministic sharp post-processing that enforces the
// delivery system's hard contract: output pixels === target W×H, always.
//
// Runs inside the route's after() runner, between provider.generate() and the
// Spaces upload, within imageGenSemaphore (sharp holds full-res buffers).
// See docs/references/target-size-delivery-system-v2.md §7.

import sharp from "sharp";

import type { FinalizerOptions } from "./delivery-types";

export interface FinalizeResult {
  buffer: Buffer;
  width: number;
  height: number;
  format: "jpeg" | "png" | "webp";
}

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

function encode(
  pipeline: sharp.Sharp,
  opts: FinalizerOptions,
): sharp.Sharp {
  switch (opts.outputFormat) {
    case "png":
      return pipeline.png();
    case "webp":
      return pipeline.webp({ quality: opts.quality });
    case "jpeg":
    default:
      return pipeline.jpeg({ quality: opts.quality });
  }
}

/** edge_extend: place the foreground (contained, untouched) over a blurred
 *  cover-fit copy of itself. Deterministic banner fill — no provider outpaint.
 */
async function finalizeEdgeExtend(
  input: Buffer | Uint8Array,
  opts: FinalizerOptions,
): Promise<Buffer> {
  const { targetWidth: w, targetHeight: h } = opts;
  const normalized = await sharp(input, { failOn: "none" })
    .rotate()
    .toColorspace("srgb")
    .png()
    .toBuffer();

  const foreground = await sharp(normalized)
    .resize({ width: w, height: h, fit: "inside", withoutEnlargement: false })
    .toBuffer();

  const background = await sharp(normalized)
    .resize({ width: w, height: h, fit: "cover", position: "centre" })
    .blur(24)
    .toBuffer();

  let pipeline = sharp(background)
    .composite([{ input: foreground, gravity: "centre" }])
    .flatten({ background: WHITE });
  if (opts.sharpen) pipeline = pipeline.sharpen();

  return encode(pipeline, opts).toBuffer();
}

async function finalizeResize(
  input: Buffer | Uint8Array,
  opts: FinalizerOptions,
): Promise<Buffer> {
  const { targetWidth: w, targetHeight: h } = opts;
  let pipeline = sharp(input, { failOn: "none" }).rotate().toColorspace("srgb");

  const wantsWhite = opts.background.type === "white";
  const keepAlpha =
    opts.outputFormat === "png" && opts.background.type === "transparent";

  // For jpeg / white backgrounds, flatten BEFORE resize so any source alpha
  // doesn't encode as black (the v1 nearby_crop sample's bug).
  if (!keepAlpha) {
    pipeline = pipeline.flatten({ background: WHITE });
  }

  const background = wantsWhite ? WHITE : { r: 255, g: 255, b: 255, alpha: 0 };
  pipeline = pipeline.resize({
    width: w,
    height: h,
    fit: opts.fit === "contain" ? "contain" : "cover",
    position: opts.anchor === "attention" ? sharp.strategy.attention : "centre",
    background,
  });

  if (opts.sharpen) pipeline = pipeline.sharpen();

  return encode(pipeline, opts).toBuffer();
}

/** Resolve a "auto" background by probing the source's alpha channel: a
 *  transparent source stays transparent (png), an opaque one flattens to white
 *  (jpeg). No-op for explicit backgrounds. */
async function resolveAutoBackground(
  input: Buffer | Uint8Array,
  opts: FinalizerOptions,
): Promise<FinalizerOptions> {
  if (opts.background.type !== "auto") return opts;
  const meta = await sharp(input, { failOn: "none" }).metadata();
  if (meta.hasAlpha) {
    return { ...opts, background: { type: "transparent" }, outputFormat: "png" };
  }
  return {
    ...opts,
    background: { type: "white", color: "#FFFFFF" },
    outputFormat: opts.outputFormat === "png" ? "jpeg" : opts.outputFormat,
  };
}

/** Apply the plan's Finalizer options. Output is ALWAYS exactly
 *  targetWidth × targetHeight. */
export async function finalize(
  input: Buffer | Uint8Array,
  rawOpts: FinalizerOptions,
): Promise<FinalizeResult> {
  const opts = await resolveAutoBackground(input, rawOpts);
  const buffer =
    opts.fit === "extend"
      ? await finalizeEdgeExtend(input, opts)
      : await finalizeResize(input, opts);

  // Re-read to report the real emitted dimensions (the QA contract reads these).
  const meta = await sharp(buffer).metadata();
  return {
    buffer,
    width: meta.width ?? opts.targetWidth,
    height: meta.height ?? opts.targetHeight,
    format: opts.outputFormat,
  };
}

export interface SizeQaResult {
  status: "pass" | "fail";
  width: number;
  height: number;
  message?: string;
}

/** Phase 1 QA hard contract: emitted pixels must equal the target (v2 §8.1). */
export function verifyDeliverySize(
  result: FinalizeResult,
  opts: FinalizerOptions,
): SizeQaResult {
  const ok =
    result.width === opts.targetWidth && result.height === opts.targetHeight;
  return ok
    ? { status: "pass", width: result.width, height: result.height }
    : {
        status: "fail",
        width: result.width,
        height: result.height,
        message: `expected ${opts.targetWidth}x${opts.targetHeight}, got ${result.width}x${result.height}`,
      };
}
