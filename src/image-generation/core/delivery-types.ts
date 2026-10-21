// Target-size delivery system — shared types (Phase 1).
//
// See docs/references/target-size-delivery-system-v2.md. The delivery pipeline
// decouples three sizes that v1 conflated:
//   - target  : the business size the user wants (e.g. 970×300)
//   - working : the size we actually ask the provider to generate
//   - delivery : what Finalizer emits — ALWAYS === target (hard contract)
//
// Phase 1 ships the deterministic strategies only (native / nearby_crop /
// padded_crop / white_pad / edge_extend). outpaint / layout_compose /
// tile_extend are declared here but planned for Phase 2+.

import type { ImageProviderId, ResolutionTier } from "./types";

export type ImageSlotUsage =
  | "main"
  | "secondary"
  | "brand_background"
  | "brand_logo"
  | "aplus_banner"
  | "aplus_square"
  | "aplus_detail"
  | "premium_banner"
  | "premium_carousel"
  | "comparison"
  | "thumbnail"
  | "custom";

export type BackgroundIntent = "white" | "transparent" | "scene" | "brand" | "auto";

export type ContentIntent =
  | "product"
  | "logo"
  | "lifestyle"
  | "background"
  | "infographic"
  | "layout"
  | "detail";

export type DeliveryStrategy =
  | "native"
  | "nearby_crop"
  | "padded_crop"
  | "white_pad"
  | "edge_extend" // Phase 1 banner fallback (deterministic; replaces v1's hard crop)
  | "outpaint" // Phase 2
  | "layout_compose" // Phase 2
  | "tile_extend"; // Phase 4

/** Strategies Finalizer can actually execute today. The planner must only ever
 *  emit one of these; Phase 2+ strategies degrade to a Phase 1 fallback until
 *  their implementations land. */
export const PHASE_1_STRATEGIES: readonly DeliveryStrategy[] = [
  "native",
  "nearby_crop",
  "padded_crop",
  "white_pad",
  "edge_extend",
] as const;

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TargetSizeSpec {
  id: string;
  section: "main" | "brand_story" | "standard_aplus" | "premium_aplus" | "custom";
  width: number;
  height: number;
  usage: ImageSlotUsage;
  backgroundIntent: BackgroundIntent;
  contentIntent: ContentIntent;
  /** When set, locks the strategy. When omitted, `chooseStrategy` derives one
   *  from the spec's features — this optionality is what makes the heuristic
   *  reachable (v1's required field made the heuristic dead code). */
  preferredStrategy?: DeliveryStrategy;
  allowWhitePadding: boolean;
  allowSubjectCrop: boolean;
  minWorkingLongSide: 1024 | 1536 | 2048 | 3072 | 4096;
  safeArea?: NormalizedRect; // Phase 1: prompt hint only, no deterministic consumer
  notes?: string;
}

export type FitMode =
  | "auto"
  | "fill"
  | "preserve_subject"
  | "extend_background"
  | "layout";

export interface TargetSizeRequest {
  targetWidth: number;
  targetHeight: number;
  /** Registry slot id (e.g. "A-02"); when present its spec is used as the base. */
  slotId?: string;
  fitMode?: FitMode;
  providerPreference?: ImageProviderId;
  resolutionTier: ResolutionTier;
}

export type FinalizerFit = "cover" | "contain" | "extend";

export type FinalizerAnchor = "center" | "attention";

export interface FinalizerOptions {
  targetWidth: number;
  targetHeight: number;
  fit: FinalizerFit;
  anchor: FinalizerAnchor;
  // "auto" defers the white-vs-transparent decision to Finalizer, which probes
  // the source's alpha channel (used for custom-pixel requests that carry no
  // explicit backgroundIntent — preserves transparency instead of flattening).
  background: { type: "white" | "transparent" | "edge_extend" | "auto"; color?: string };
  sharpen: boolean;
  outputFormat: "jpeg" | "png" | "webp";
  quality: number;
}

export interface DeliveryPlan {
  target: { width: number; height: number; aspectRatio: string; slotId?: string };
  provider: ImageProviderId;
  workingWidth: number;
  workingHeight: number;
  strategy: DeliveryStrategy;
  finalizer: FinalizerOptions;
  fallbackStrategies: DeliveryStrategy[];
  warnings: string[];
}
