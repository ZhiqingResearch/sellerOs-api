
import {
  buildFinalizerOptions,
  chooseStrategy,
  plan,
  resolveDeliverySize,
  resolveWorkingSize,
} from "./delivery-planner";
import { PHASE_1_STRATEGIES } from "./delivery-types";
import { TARGET_SIZE_REGISTRY } from "./target-size-registry";
import type { TargetSizeRequest } from "./delivery-types";

function reqFor(slotId: string, over: Partial<TargetSizeRequest> = {}): TargetSizeRequest {
  const spec = TARGET_SIZE_REGISTRY.find((s) => s.id === slotId)!;
  return {
    targetWidth: spec.width,
    targetHeight: spec.height,
    slotId,
    resolutionTier: "2K",
    ...over,
  };
}

describe("delivery-planner / registry coverage", () => {
  it("registers exactly the 24 PRD slots with unique ids", () => {
    expect(TARGET_SIZE_REGISTRY).toHaveLength(24);
    const ids = new Set(TARGET_SIZE_REGISTRY.map((s) => s.id));
    expect(ids.size).toBe(24);
  });

  it("produces a plan with a Phase-1 strategy for all 24 slots", () => {
    for (const spec of TARGET_SIZE_REGISTRY) {
      const p = plan(reqFor(spec.id)); // default tier 2K
      expect(PHASE_1_STRATEGIES).toContain(p.strategy);
      // Delivered size scales the target ratio up to the tier (long side =
      // max(2048, original long side)); never pinned to the raw spec pixels.
      const expectLong = Math.max(2048, Math.max(spec.width, spec.height));
      expect(Math.max(p.finalizer.targetWidth, p.finalizer.targetHeight)).toBe(expectLong);
      // Aspect ratio preserved within integer-rounding drift.
      expect(p.finalizer.targetWidth / p.finalizer.targetHeight).toBeCloseTo(spec.width / spec.height, 1);
    }
  });

  it("scales delivered size to the tier per the §7.5 reference table", () => {
    // Sampled rows from docs/references/target-size-delivery-system-v2.md §7.5.
    const cases: [number, number, "1K" | "2K", number, number][] = [
      [1464, 625, "1K", 1464, 625], // 大目标：原始长边 1464 > 1024 → 原尺寸
      [1464, 625, "2K", 2048, 874],
      [463, 625, "1K", 759, 1024], // 小目标：放大到档位长边
      [463, 625, "2K", 1517, 2048],
      [600, 180, "2K", 2048, 614],
      [315, 145, "2K", 2048, 943],
      [970, 300, "2K", 2048, 633],
      [1464, 600, "1K", 1464, 600], // 61:25，原始长边 > 1024 → 原尺寸
    ];
    for (const [w, h, tier, ew, eh] of cases) {
      const got = resolveDeliverySize(w, h, tier);
      expect(got).toEqual({ width: ew, height: eh });
    }
  });

  it("never plans a hard crop (nearby_crop) for edge_extend banners", () => {
    const banners = TARGET_SIZE_REGISTRY.filter(
      (s) => s.preferredStrategy === "edge_extend",
    );
    expect(banners.length).toBeGreaterThan(0);
    for (const b of banners) {
      expect(plan(reqFor(b.id)).strategy).toBe("edge_extend");
    }
  });

  it("gives small images a working long side ≥ minWorkingLongSide and ≥ 1024", () => {
    for (const spec of TARGET_SIZE_REGISTRY) {
      const p = plan(reqFor(spec.id, { resolutionTier: "1K" }));
      const longSide = Math.max(p.workingWidth, p.workingHeight);
      expect(longSide).toBeGreaterThanOrEqual(
        Math.max(1024, spec.minWorkingLongSide),
      );
    }
  });
});

describe("delivery-planner / chooseStrategy precedence (v1 dead-code regression)", () => {
  it("explicit fitMode overrides preferredStrategy", () => {
    const spec = TARGET_SIZE_REGISTRY.find((s) => s.id === "A-02")!; // edge_extend
    // fill → nearby_crop, beating the slot's edge_extend default
    expect(chooseStrategy(spec, reqFor("A-02", { fitMode: "fill" }))).toBe(
      "nearby_crop",
    );
    // preserve_subject on a non-white-padding banner → padded_crop
    expect(
      chooseStrategy(spec, reqFor("A-02", { fitMode: "preserve_subject" })),
    ).toBe("padded_crop");
  });

  it("auto fitMode falls through to preferredStrategy", () => {
    const spec = TARGET_SIZE_REGISTRY.find((s) => s.id === "A-02")!;
    expect(chooseStrategy(spec, reqFor("A-02", { fitMode: "auto" }))).toBe(
      "edge_extend",
    );
  });

  it("derives a strategy when preferredStrategy is absent (heuristic reachable)", () => {
    const custom: TargetSizeRequest = {
      targetWidth: 970,
      targetHeight: 300,
      resolutionTier: "2K",
      // no slotId → synthesized spec has no preferredStrategy; ratio 3.23 wide
    };
    const p = plan(custom);
    expect(p.strategy).toBe("edge_extend"); // wide + non-white → edge_extend
  });
});

describe("delivery-planner / provider + Wan constraint", () => {
  it("routes a Gemini-native ratio to gemini-nano-banana", () => {
    // A-04 is 300×300 = 1:1, which Gemini supports natively
    expect(plan(reqFor("A-04")).provider).toBe("gemini-nano-banana");
  });

  it("collapses Wan to a crop/pad strategy and warns", () => {
    const p = plan(reqFor("A-02", { providerPreference: "atlas-wan" }));
    expect(p.provider).toBe("atlas-wan");
    expect(["white_pad", "padded_crop", "nearby_crop"]).toContain(p.strategy);
    expect(p.strategy).not.toBe("edge_extend");
    expect(p.warnings.join(" ")).toContain("atlas-wan");
  });
});

describe("delivery-planner / working size", () => {
  it("clamps an extreme banner's working ratio into the provider comfort zone", () => {
    const spec = TARGET_SIZE_REGISTRY.find((s) => s.id === "A-02")!; // 970×300, 3.23
    const { width, height } = resolveWorkingSize(spec, reqFor("A-02"));
    const workingRatio = width / height;
    // Clamped to MAX_WORKING_RATIO (2.4) — well off the 3.23 target; the
    // Finalizer (edge_extend) pads the sides out to the real banner width.
    // Allow a hair of drift from integer pixel rounding (2048/853 ≈ 2.401).
    expect(workingRatio).toBeLessThan(970 / 300);
    expect(workingRatio).toBeLessThanOrEqual(2.41);
  });

  it("bumps a small square target to a big working canvas (big-gen → downscale)", () => {
    const spec = TARGET_SIZE_REGISTRY.find((s) => s.id === "A-09")!; // 135×135
    const { width, height } = resolveWorkingSize(spec, reqFor("A-09", { resolutionTier: "1K" }));
    expect(width).toBe(height); // 1:1 preserved
    expect(Math.max(width, height)).toBeGreaterThanOrEqual(1024);
  });
});

describe("delivery-planner / finalizer options", () => {
  it("white_pad → contain + white, no sharpen", () => {
    const spec = TARGET_SIZE_REGISTRY.find((s) => s.id === "B-03")!;
    const f = buildFinalizerOptions(spec, "white_pad");
    expect(f.fit).toBe("contain");
    expect(f.background.type).toBe("white");
    expect(f.sharpen).toBe(false);
  });

  it("edge_extend → extend fit", () => {
    const spec = TARGET_SIZE_REGISTRY.find((s) => s.id === "A-02")!;
    expect(buildFinalizerOptions(spec, "edge_extend").fit).toBe("extend");
  });

  it("nearby_crop → cover + attention", () => {
    const spec = TARGET_SIZE_REGISTRY.find((s) => s.id === "A-03")!;
    const f = buildFinalizerOptions(spec, "nearby_crop");
    expect(f.fit).toBe("cover");
    expect(f.anchor).toBe("attention");
  });
});
