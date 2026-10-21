
import { isImageAspectRatio, normalizeResolutionTier, resolveTargetImageSize } from "./size-adapters";
import type { ProviderGenerateInput } from "./types";

type SizeInput = Pick<
  ProviderGenerateInput,
  | "aspectRatio"
  | "customAspectW"
  | "customAspectH"
  | "customSizeMode"
  | "resolutionTier"
  | "workingWidth"
  | "workingHeight"
>;

const base: SizeInput = {
  aspectRatio: "custom",
  customAspectW: 970,
  customAspectH: 300,
  customSizeMode: "pixels",
  resolutionTier: "2K",
};

describe("任意图片比例格式", () => {
  it.each(["1:1", "64:51", "2048:614", "2:1", "1:20", "123456:78901"])("允许合法比例 %s", ratio => {
    expect(isImageAspectRatio(ratio)).toBe(true)
  })
  it.each([undefined, null, 1, "custom", "bad", "0:1", "1:0", "-1:2", "1.5:2", "1:2:3", "9007199254740992:1"])("拒绝非法比例 %s", ratio => {
    expect(isImageAspectRatio(ratio)).toBe(false)
  })
})

describe("resolveTargetImageSize / working-size override", () => {
  it("ignores working size when absent (legacy custom-pixels behavior intact)", () => {
    const size = resolveTargetImageSize(base, "generic");
    // No working size → derives from the 970×300 custom pixels.
    expect(size.width).toBe(970);
    expect(size.height).toBe(300);
  });

  it("uses the explicit working size over customAspect when present", () => {
    const size = resolveTargetImageSize(
      { ...base, workingWidth: 2048, workingHeight: 853 },
      "generic",
    );
    expect(size.width).toBe(2048);
    expect(size.height).toBe(853);
    // Decoupled from the 970×300 target entirely.
    expect(size.size).toBe("2048x853");
  });

  it("still applies gpt-image-2 constraints on top of the working size", () => {
    const size = resolveTargetImageSize(
      { ...base, workingWidth: 2050, workingHeight: 855 },
      "gpt-image-2",
    );
    // multipleOf16 snapping applies to the working size.
    expect(size.width % 16).toBe(0);
    expect(size.height % 16).toBe(0);
    expect(size.width * size.height).toBeGreaterThanOrEqual(655_360);
  });

  it("treats zero/partial working size as absent", () => {
    const size = resolveTargetImageSize(
      { ...base, workingWidth: 0, workingHeight: 853 },
      "generic",
    );
    expect(size.width).toBe(970);
    expect(size.height).toBe(300);
  });
});

describe("normalizeResolutionTier / 3K 已下线降档（2026-09-14）", () => {
  it("显式 3K 降档 2K（网关 resolution 枚举仅 1k/2k/4k）", () => {
    expect(normalizeResolutionTier("3K")).toBe("2K");
  });

  it("legacy 分辨率串推导出的 3K 同样降档", () => {
    expect(normalizeResolutionTier(undefined, "2560x1440")).toBe("2K");
    expect(normalizeResolutionTier(undefined, "3072x1728")).toBe("2K");
  });

  it.each(["1K", "2K", "4K"] as const)("%s 原样透传", (tier) => {
    expect(normalizeResolutionTier(tier)).toBe(tier);
  });

  it("非法值仍走原默认（无 fallback → 1K）", () => {
    expect(normalizeResolutionTier("bogus")).toBe("1K");
  });
});
