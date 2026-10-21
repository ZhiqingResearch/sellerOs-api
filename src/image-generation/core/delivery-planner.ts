// Delivery Planner — pure, side-effect-free. Maps a TargetSizeRequest to a
// DeliveryPlan (provider + working size + strategy + finalizer options).
// All I/O (generation, upload, PATCH) stays in the route's after() runner.
//
// See docs/references/target-size-delivery-system-v2.md §6.

import { GEMINI_SUPPORTED_ASPECTS } from "./size-adapters";
import type { ImageProviderId, ResolutionTier } from "./types";
import { getTargetSizeSpec } from "./target-size-registry";
import {
  PHASE_1_STRATEGIES,
  type DeliveryPlan,
  type DeliveryStrategy,
  type FinalizerOptions,
  type FitMode,
  type TargetSizeRequest,
  type TargetSizeSpec,
} from "./delivery-types";

const TIER_LONG_SIDE: Record<ResolutionTier, number> = {
  "1K": 1024,
  "2K": 2048,
  "3K": 3072,
  "4K": 4096,
};

/** Wan-2.7-Pro has no W×H control and its output ratio follows the first
 *  reference image (see prd-size-support-report.md §4). So a near-target
 *  working ratio is NOT achievable — restrict it to crop/pad strategies. */
const WAN_ALLOWED_STRATEGIES: ReadonlySet<DeliveryStrategy> = new Set([
  "white_pad",
  "padded_crop",
  "nearby_crop",
]);

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

function aspectLabel(width: number, height: number): string {
  const d = gcd(width, height);
  return `${width / d}:${height / d}`;
}

/** Choose the strategy for a slot. Precedence (v2 §6.1, fixes v1's dead code):
 *  1. explicit user fitMode  2. spec.preferredStrategy  3. feature heuristic. */
export function chooseStrategy(
  spec: TargetSizeSpec,
  req: TargetSizeRequest,
): DeliveryStrategy {
  const byFitMode: Partial<Record<FitMode, DeliveryStrategy>> = {
    fill: "nearby_crop",
    preserve_subject: spec.allowWhitePadding ? "white_pad" : "padded_crop",
    extend_background: "edge_extend", // Phase 2+ may upgrade to outpaint
    layout: "edge_extend", // Phase 1 has no layout_compose yet → banner fallback
  };
  if (req.fitMode && req.fitMode !== "auto" && byFitMode[req.fitMode]) {
    return byFitMode[req.fitMode]!;
  }

  if (spec.preferredStrategy && isPhase1(spec.preferredStrategy)) {
    return spec.preferredStrategy;
  }

  const ratio = spec.width / spec.height;
  const pixels = spec.width * spec.height;
  const isSmall = pixels < 655_360;
  const isWide = ratio > 2.4;
  const isTall = ratio < 0.42;

  if (spec.contentIntent === "logo") {
    return "white_pad";
  }
  if ((isWide || isTall) && spec.backgroundIntent !== "white") {
    return "edge_extend";
  }
  if (isSmall && spec.allowWhitePadding) {
    return "padded_crop";
  }
  return "nearby_crop";
}

function isPhase1(strategy: DeliveryStrategy): boolean {
  return PHASE_1_STRATEGIES.includes(strategy);
}

/** Provider selection (v2 §6.2). Reads Gemini's real capability set instead of
 *  a hand-copied list, so it can't drift from size-adapters. */
export function chooseProvider(
  spec: TargetSizeSpec,
  req: TargetSizeRequest,
): ImageProviderId {
  if (req.providerPreference) return req.providerPreference;
  const label = aspectLabel(spec.width, spec.height);
  if (GEMINI_SUPPORTED_ASPECTS.has(label)) return "gemini-nano-banana";
  return "apifox-zq2-pro-plus";
}

/** Max working aspect we ask any provider for. Past ~2.4 gpt-image-2 gets
 *  uncomfortable (its hard cap is 3:1) and extreme banners look bad. Targets
 *  wider than this are generated at a comfortable ratio and reach their true
 *  shape via the Finalizer (edge_extend pads the sides, white_pad/padded_crop
 *  pad/crop) — so the working ratio NEVER needs to match an extreme target. */
const MAX_WORKING_RATIO = 2.4;

/** Compute the working size to request from the provider (v2 §6.3). The working
 *  image is an intermediate — Finalizer guarantees the final target — so this
 *  uses the target ratio clamped into the provider's comfort zone, at a long
 *  side bumped up for "small target → big generation → downscale". gpt-family
 *  providers honor this via resolveTargetImageSize; Gemini/Wan ignore W×H. */
export function resolveWorkingSize(
  spec: TargetSizeSpec,
  req: TargetSizeRequest,
): { width: number; height: number } {
  const ratio = clamp(
    spec.width / spec.height,
    1 / MAX_WORKING_RATIO,
    MAX_WORKING_RATIO,
  );
  const longSide = Math.max(
    spec.width,
    spec.height,
    spec.minWorkingLongSide,
    TIER_LONG_SIDE[req.resolutionTier],
  );
  return ratio >= 1
    ? { width: longSide, height: Math.round(longSide / ratio) }
    : { width: Math.round(longSide * ratio), height: longSide };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Compute the DELIVERED (final) pixel size for a target ratio at a tier
 *  (PRD §7.2 / §7.5). Output longest side = max(tier long side, the target's
 *  OWN longest side):
 *    - 小目标（原始长边 < 档位）→ 放大到档位长边（如 463×625 @2K → 1517×2048）。
 *    - 大目标（原始长边 ≥ 档位）→ 直接输出原始交付尺寸，绝不缩到档位以下
 *      （如 1464×625 @1K → 1464×625）。
 *  The other side follows the exact target ratio, rounded (≤1px drift is
 *  expected and matches the §7.5 reference table). The Finalizer enforces these
 *  exact pixels; working size (≥ this) is generated then cropped/padded down. */
export function resolveDeliverySize(
  targetWidth: number,
  targetHeight: number,
  tier: ResolutionTier,
): { width: number; height: number } {
  const origLong = Math.max(targetWidth, targetHeight);
  const outLong = Math.max(TIER_LONG_SIDE[tier], origLong);
  const f = outLong / origLong;
  return {
    width: Math.round(targetWidth * f),
    height: Math.round(targetHeight * f),
  };
}

/** Map a strategy + spec to deterministic Finalizer options. */
/** Background for content strategies (white_pad / padded_crop / nearby_crop /
 *  native). "transparent" keeps alpha; "auto" defers to Finalizer's alpha probe
 *  (so custom-pixel requests don't flatten a transparent source to white);
 *  everything else pads/crops on white. */
function contentBackground(spec: TargetSizeSpec): FinalizerOptions["background"] {
  if (spec.backgroundIntent === "transparent") return { type: "transparent" };
  if (spec.backgroundIntent === "auto") return { type: "auto" };
  return { type: "white", color: "#FFFFFF" };
}

export function buildFinalizerOptions(
  spec: TargetSizeSpec,
  strategy: DeliveryStrategy,
  /** The delivered pixel size (from resolveDeliverySize). Defaults to the spec's
   *  raw dimensions so direct callers/tests that only care about strategy→fit
   *  mapping keep working; plan() passes the tier-scaled size. */
  delivery: { width: number; height: number } = {
    width: spec.width,
    height: spec.height,
  },
): FinalizerOptions {
  // "auto" defaults to jpeg here; Finalizer upgrades it to png iff the source
  // actually carries alpha. "transparent" forces png up front.
  const outputFormat =
    spec.backgroundIntent === "transparent" ? ("png" as const) : ("jpeg" as const);
  const base = {
    targetWidth: delivery.width,
    targetHeight: delivery.height,
    outputFormat,
    quality: 92,
  };
  switch (strategy) {
    case "white_pad":
      return {
        ...base,
        fit: "contain",
        anchor: "center",
        background: contentBackground(spec),
        sharpen: false,
      };
    case "padded_crop":
      return {
        ...base,
        fit: "cover",
        anchor: "center", // no saliency guesswork — preserve subject centrally
        background: contentBackground(spec),
        sharpen: true,
      };
    case "nearby_crop":
      return {
        ...base,
        fit: "cover",
        anchor: "attention",
        background: contentBackground(spec),
        sharpen: true,
      };
    case "edge_extend":
      return {
        ...base,
        fit: "extend",
        anchor: "center",
        background: { type: "edge_extend" },
        sharpen: false,
      };
    case "native":
    default:
      return {
        ...base,
        fit: "cover",
        anchor: "center",
        background: contentBackground(spec),
        sharpen: true,
      };
  }
}

/** Synthesize a spec for a custom (non-registry) W×H request. */
function specFromRequest(req: TargetSizeRequest): TargetSizeSpec {
  return {
    id: "custom",
    section: "custom",
    width: req.targetWidth,
    height: req.targetHeight,
    usage: "custom",
    backgroundIntent: "auto",
    contentIntent: "product",
    allowWhitePadding: true,
    allowSubjectCrop: false,
    minWorkingLongSide: 1024,
  };
}

/** Build the full DeliveryPlan for a request. Pure. */
export function plan(req: TargetSizeRequest): DeliveryPlan {
  const spec = (req.slotId && getTargetSizeSpec(req.slotId)) || specFromRequest(req);
  const warnings: string[] = [];
  const provider = chooseProvider(spec, req);

  let strategy = chooseStrategy(spec, req);

  // Wan can't honor a working ratio → collapse to a crop/pad strategy.
  if (provider === "atlas-wan" && !WAN_ALLOWED_STRATEGIES.has(strategy)) {
    const collapsed: DeliveryStrategy = spec.allowWhitePadding
      ? "white_pad"
      : "padded_crop";
    warnings.push(
      `provider atlas-wan cannot honor working ratio; strategy ${strategy} → ${collapsed}`,
    );
    strategy = collapsed;
  }

  const { width: workingWidth, height: workingHeight } = resolveWorkingSize(
    spec,
    req,
  );

  // Delivered size scales the target ratio up to the requested tier (never
  // below the target's own size) — see resolveDeliverySize / PRD §7.5.
  const delivery = resolveDeliverySize(
    spec.width,
    spec.height,
    req.resolutionTier,
  );

  const fallbackStrategies = buildFallbacks(strategy, spec);

  return {
    target: {
      width: delivery.width,
      height: delivery.height,
      aspectRatio: aspectLabel(spec.width, spec.height),
      slotId: spec.id === "custom" ? undefined : spec.id,
    },
    provider,
    workingWidth,
    workingHeight,
    strategy,
    finalizer: buildFinalizerOptions(spec, strategy, delivery),
    fallbackStrategies,
    warnings,
  };
}

function buildFallbacks(
  strategy: DeliveryStrategy,
  spec: TargetSizeSpec,
): DeliveryStrategy[] {
  switch (strategy) {
    case "native":
      return ["nearby_crop"];
    case "nearby_crop":
      return ["padded_crop"];
    case "edge_extend":
      return [spec.allowWhitePadding ? "white_pad" : "padded_crop"];
    case "padded_crop":
      return [spec.allowWhitePadding ? "white_pad" : "nearby_crop"];
    default:
      return [];
  }
}
