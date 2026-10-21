// Target-size registry — the 24 PRD slots from prd-size-support-report.md,
// registered as built-in specs (Phase 1). Code constants for now; can migrate
// to DB later without changing the planner/finalizer contract.
//
// `preferredStrategy` follows the "Phase 1 策略" column of
// docs/references/target-size-delivery-system-v2.md §10. Banners use
// `edge_extend` (deterministic, no hard crop) until Phase 2's outpaint/layout.

import type { TargetSizeSpec } from "./delivery-types";

const BANNER_SAFE_AREA = { x: 0.06, y: 0.12, width: 0.88, height: 0.76 };

export const TARGET_SIZE_REGISTRY: TargetSizeSpec[] = [
  // ── 主副图 ──────────────────────────────────────────────────────────
  {
    id: "M-01", section: "main", width: 1600, height: 1600,
    usage: "main", backgroundIntent: "white", contentIntent: "product",
    preferredStrategy: "native", allowWhitePadding: true, allowSubjectCrop: false,
    minWorkingLongSide: 2048, notes: "主图正方形，白底商品优先",
  },
  {
    id: "M-02", section: "main", width: 1600, height: 1600,
    usage: "secondary", backgroundIntent: "white", contentIntent: "product",
    preferredStrategy: "native", allowWhitePadding: true, allowSubjectCrop: false,
    minWorkingLongSide: 2048, notes: "副图正方形",
  },
  {
    id: "M-03", section: "main", width: 1200, height: 1500,
    usage: "secondary", backgroundIntent: "white", contentIntent: "product",
    preferredStrategy: "native", allowWhitePadding: true, allowSubjectCrop: false,
    minWorkingLongSide: 2048, notes: "副图 4:5",
  },

  // ── 品牌故事 ────────────────────────────────────────────────────────
  {
    id: "B-01", section: "brand_story", width: 1464, height: 625,
    usage: "brand_background", backgroundIntent: "brand", contentIntent: "background",
    preferredStrategy: "edge_extend", allowWhitePadding: false, allowSubjectCrop: false,
    minWorkingLongSide: 2048, safeArea: BANNER_SAFE_AREA, notes: "桌面品牌背景，超宽避免硬裁",
  },
  {
    id: "B-02", section: "brand_story", width: 463, height: 625,
    usage: "brand_background", backgroundIntent: "brand", contentIntent: "background",
    preferredStrategy: "padded_crop", allowWhitePadding: false, allowSubjectCrop: false,
    minWorkingLongSide: 1024, notes: "移动端竖向背景，主体安全区靠中上",
  },
  {
    id: "B-03", section: "brand_story", width: 315, height: 145,
    usage: "brand_logo", backgroundIntent: "white", contentIntent: "logo",
    preferredStrategy: "white_pad", allowWhitePadding: true, allowSubjectCrop: false,
    minWorkingLongSide: 1024, notes: "品牌 Logo 图",
  },
  {
    id: "B-04", section: "brand_story", width: 362, height: 453,
    usage: "secondary", backgroundIntent: "scene", contentIntent: "lifestyle",
    preferredStrategy: "padded_crop", allowWhitePadding: false, allowSubjectCrop: false,
    minWorkingLongSide: 1024, notes: "小竖图，保主体完整",
  },
  {
    id: "B-05", section: "brand_story", width: 166, height: 182,
    usage: "thumbnail", backgroundIntent: "white", contentIntent: "product",
    preferredStrategy: "white_pad", allowWhitePadding: true, allowSubjectCrop: false,
    minWorkingLongSide: 1024, notes: "产品矩阵小图，大图生成后缩小",
  },

  // ── 普通 A+ ─────────────────────────────────────────────────────────
  {
    id: "A-01", section: "standard_aplus", width: 600, height: 180,
    usage: "aplus_banner", backgroundIntent: "white", contentIntent: "logo",
    preferredStrategy: "white_pad", allowWhitePadding: true, allowSubjectCrop: false,
    minWorkingLongSide: 1536, notes: "Logo 横条，保留结构和留白",
  },
  {
    id: "A-02", section: "standard_aplus", width: 970, height: 300,
    usage: "aplus_banner", backgroundIntent: "brand", contentIntent: "background",
    preferredStrategy: "edge_extend", allowWhitePadding: false, allowSubjectCrop: false,
    minWorkingLongSide: 1536, safeArea: BANNER_SAFE_AREA, notes: "标准横幅",
  },
  {
    id: "A-03", section: "standard_aplus", width: 970, height: 600,
    usage: "aplus_detail", backgroundIntent: "scene", contentIntent: "lifestyle",
    preferredStrategy: "nearby_crop", allowWhitePadding: false, allowSubjectCrop: true,
    minWorkingLongSide: 1536, notes: "大场景图，接近 16:10",
  },
  {
    id: "A-04", section: "standard_aplus", width: 300, height: 300,
    usage: "aplus_square", backgroundIntent: "white", contentIntent: "product",
    preferredStrategy: "padded_crop", allowWhitePadding: true, allowSubjectCrop: false,
    minWorkingLongSide: 1024, notes: "标准方图，生成高分后缩小",
  },
  {
    id: "A-05", section: "standard_aplus", width: 220, height: 200,
    usage: "aplus_square", backgroundIntent: "white", contentIntent: "product",
    preferredStrategy: "padded_crop", allowWhitePadding: true, allowSubjectCrop: false,
    minWorkingLongSide: 1024, notes: "四图功能，近方形",
  },
  {
    id: "A-06", section: "standard_aplus", width: 300, height: 400,
    usage: "aplus_detail", backgroundIntent: "scene", contentIntent: "lifestyle",
    preferredStrategy: "native", allowWhitePadding: false, allowSubjectCrop: true,
    minWorkingLongSide: 1024, notes: "侧边栏图文，3:4",
  },
  {
    id: "A-07", section: "standard_aplus", width: 300, height: 175,
    usage: "aplus_detail", backgroundIntent: "white", contentIntent: "detail",
    preferredStrategy: "padded_crop", allowWhitePadding: true, allowSubjectCrop: false,
    minWorkingLongSide: 1024, notes: "规格细节小横图",
  },
  {
    id: "A-08", section: "standard_aplus", width: 150, height: 300,
    usage: "comparison", backgroundIntent: "white", contentIntent: "detail",
    preferredStrategy: "padded_crop", allowWhitePadding: true, allowSubjectCrop: false,
    minWorkingLongSide: 1024, notes: "对比表竖条，安全区严格",
  },
  {
    id: "A-09", section: "standard_aplus", width: 135, height: 135,
    usage: "aplus_detail", backgroundIntent: "white", contentIntent: "detail",
    preferredStrategy: "padded_crop", allowWhitePadding: true, allowSubjectCrop: false,
    minWorkingLongSide: 1024, notes: "四宫格细节，高分生成后缩小",
  },

  // ── 高级 A+ ─────────────────────────────────────────────────────────
  {
    id: "P-01", section: "premium_aplus", width: 1464, height: 600,
    usage: "premium_banner", backgroundIntent: "brand", contentIntent: "background",
    preferredStrategy: "edge_extend", allowWhitePadding: false, allowSubjectCrop: false,
    minWorkingLongSide: 2048, safeArea: BANNER_SAFE_AREA, notes: "Premium 横幅满版",
  },
  {
    id: "P-02", section: "premium_aplus", width: 600, height: 450,
    usage: "premium_carousel", backgroundIntent: "scene", contentIntent: "lifestyle",
    preferredStrategy: "native", allowWhitePadding: false, allowSubjectCrop: true,
    minWorkingLongSide: 1536, notes: "标准展示图，4:3",
  },
  {
    id: "P-03", section: "premium_aplus", width: 800, height: 600,
    usage: "premium_carousel", backgroundIntent: "scene", contentIntent: "lifestyle",
    preferredStrategy: "native", allowWhitePadding: false, allowSubjectCrop: true,
    minWorkingLongSide: 1536, notes: "Carousel 单屏，4:3",
  },
  {
    id: "P-04", section: "premium_aplus", width: 300, height: 225,
    usage: "aplus_square", backgroundIntent: "white", contentIntent: "product",
    preferredStrategy: "padded_crop", allowWhitePadding: true, allowSubjectCrop: false,
    minWorkingLongSide: 1024, notes: "Four Images，4:3 小图",
  },
  {
    id: "P-05", section: "premium_aplus", width: 488, height: 700,
    usage: "aplus_detail", backgroundIntent: "scene", contentIntent: "infographic",
    preferredStrategy: "nearby_crop", allowWhitePadding: false, allowSubjectCrop: true,
    minWorkingLongSide: 1536, notes: "Q&A 长图，竖向内容",
  },
  {
    id: "P-06", section: "premium_aplus", width: 650, height: 350,
    usage: "comparison", backgroundIntent: "brand", contentIntent: "layout",
    preferredStrategy: "edge_extend", allowWhitePadding: false, allowSubjectCrop: false,
    minWorkingLongSide: 1536, notes: "Comparison Table，通常有表格/文案空间",
  },
  {
    id: "P-07", section: "premium_aplus", width: 200, height: 225,
    usage: "aplus_square", backgroundIntent: "white", contentIntent: "product",
    preferredStrategy: "padded_crop", allowWhitePadding: true, allowSubjectCrop: false,
    minWorkingLongSide: 1024, notes: "小单元图，保主体完整",
  },
];

const REGISTRY_BY_ID = new Map(TARGET_SIZE_REGISTRY.map((s) => [s.id, s]));

export function getTargetSizeSpec(slotId: string): TargetSizeSpec | undefined {
  return REGISTRY_BY_ID.get(slotId);
}
