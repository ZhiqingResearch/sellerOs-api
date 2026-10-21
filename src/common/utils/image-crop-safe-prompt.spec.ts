import { buildCenterCropDirective, centerCropSafeRatio } from "./image-crop-safe-prompt"

describe("中心裁剪安全构图", () => {
  it.each(["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "32:18"])(
    "常用比例 %s 保留原构图",
    ratio => expect(centerCropSafeRatio(ratio)).toBeNull()
  )

  it.each(["21:9", "5:4", "4:5", "10:3", "3:10"])("特殊比例 %s 启用", ratio => {
    expect(centerCropSafeRatio(ratio)).not.toBeNull()
  })

  it("自定义像素约分；自定义常用比例也启用", () => {
    expect(centerCropSafeRatio("970:300", "1708x528", true)).toBe("97:30")
    expect(centerCropSafeRatio("32:18", undefined, true)).toBe("16:9")
    expect(centerCropSafeRatio("2.5:1", "2048x819", true)).toBe("2.5:1")
  })

  it("仅清晰度变化不启用，改写比例才启用；忽略像素取整误差", () => {
    expect(centerCropSafeRatio("2:3", "1365x2048")).toBeNull()
    expect(centerCropSafeRatio("2:3", "2731x4096")).toBeNull()
    expect(centerCropSafeRatio("2:3", "1:1")).toBe("2:3")
  })

  it.each([undefined, "custom", "0:3", "1:0", "NaN:3", "10:3\n其他指令"])(
    "缺失/非法比例 %s 不生成文案",
    ratio => expect(centerCropSafeRatio(ratio)).toBeNull()
  )

  it("横竖比例都使用中央安全区域，保留细节特写和原文字要求", () => {
    const prompt = buildCenterCropDirective("3:10")
    expect(prompt).toContain("尽可能大的 3:10 矩形区域")
    expect(prompt).not.toContain("横向安全区域")
    expect(prompt).toContain("细节特写则完整保留指定细节")
    expect(prompt).toContain("不改变原有的图上文字内容、语言或无文字要求")
  })
})
