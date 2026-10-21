import { tagPublicVoice } from "./voice-tagger"

describe("tagPublicVoice", () => {
  describe("年龄识别", () => {
    it("优先匹配具体年龄段", () => {
      expect(tagPublicVoice({ name: "童声小明" }).age).toBe("少年")
      expect(tagPublicVoice({ name: "中年大叔" }).age).toBe("中年")
      expect(tagPublicVoice({ name: "奶奶慈祥" }).age).toBe("老年")
      expect(tagPublicVoice({ name: "少女娇羞" }).age).toBe("青少年")
    })

    it("通用词汇（小哥/妹子/主播/Anchor）兜底为青年", () => {
      expect(tagPublicVoice({ name: "沪普小哥" }).age).toBe("青年")
      expect(tagPublicVoice({ name: "长沙妹子" }).age).toBe("青年")
      expect(tagPublicVoice({ name: "English Anchor" }).age).toBe("青年")
    })

    it("完全无法识别时返回 undefined", () => {
      expect(tagPublicVoice({ name: "LMV_10579" }).age).toBeUndefined()
    })
  })

  describe("风格识别", () => {
    it("权威专业 = 主持/新闻/权威", () => {
      expect(tagPublicVoice({ name: "权威主播" }).style).toBe("权威专业")
      expect(tagPublicVoice({ name: "新闻播报员" }).style).toBe("权威专业")
    })

    it("活力激情 = 活力/热情/青春", () => {
      expect(tagPublicVoice({ name: "青岛小哥", describe: "活力激情" }).style).toBe("活力激情")
    })

    it("亲和陪伴 = 温柔/知性/温暖", () => {
      expect(tagPublicVoice({ name: "温柔女主播" }).style).toBe("亲和陪伴")
    })
  })

  describe("语言识别", () => {
    it("沪普/川普/湾湾 → 中文 + 方言", () => {
      const langs = tagPublicVoice({ name: "沪普小哥" }).language
      expect(langs).toContain("中文")
      expect(langs).toContain("方言")
    })

    it("粤语单独作为独立维度", () => {
      const langs = tagPublicVoice({ name: "广州男生", describe: "粤语" }).language
      expect(langs).toContain("粤语")
    })

    it("English Anchor → 英语（不额外加中文）", () => {
      const langs = tagPublicVoice({ name: "English Anchor" }).language
      expect(langs).toContain("英语")
      expect(langs).not.toContain("中文")
    })

    it("French Voice → 法语", () => {
      expect(tagPublicVoice({ name: "French Voice" }).language).toContain("法语")
    })

    it("无明显语种特征 → 默认 中文", () => {
      expect(tagPublicVoice({ name: "LMV_10579" }).language).toEqual(["中文"])
    })
  })

  describe("能力识别（version + 关键字）", () => {
    it("version=V2 → 超拟", () => {
      expect(tagPublicVoice({ name: "X", version: "V2" }).capability).toBe("超拟")
    })

    it("version=LITE → 精品", () => {
      expect(tagPublicVoice({ name: "X", version: "LITE" }).capability).toBe("精品")
    })
  })

  describe("特征识别", () => {
    it("温润柔和", () => {
      expect(tagPublicVoice({ name: "温柔女声" }).feature).toBe("温润柔和")
    })

    it("清透明亮", () => {
      expect(tagPublicVoice({ name: "清脆童音" }).feature).toBe("清透明亮")
    })

    it("低沉磁性", () => {
      expect(tagPublicVoice({ name: "磁性男声", describe: "浑厚低沉" }).feature).toBe("低沉磁性")
    })
  })

  describe("延时识别", () => {
    it("LITE → 超低时延", () => {
      expect(tagPublicVoice({ name: "X", version: "LITE" }).latency).toBe("超低时延")
    })

    it("V2 → 低时延", () => {
      expect(tagPublicVoice({ name: "X", version: "V2" }).latency).toBe("低时延")
    })

    it("无 version → 无延时标签", () => {
      expect(tagPublicVoice({ name: "X" }).latency).toBeUndefined()
    })
  })

  describe("集成：模拟真实百度数据", () => {
    it("沪普小哥 V2", () => {
      const r = tagPublicVoice({ name: "沪普小哥", version: "V2" })
      expect(r).toMatchObject({
        age: "青年",
        language: expect.arrayContaining(["中文", "方言"]),
        capability: "超拟",
        latency: "低时延",
      })
    })

    it("温柔女主播 LITE", () => {
      const r = tagPublicVoice({ name: "温柔女主播", version: "LITE" })
      expect(r).toMatchObject({
        age: "青年",
        style: "亲和陪伴",
        feature: "温润柔和",
        capability: "精品",
        latency: "超低时延",
      })
    })

    it("权威主播", () => {
      const r = tagPublicVoice({ name: "权威主播" })
      expect(r).toMatchObject({
        age: "青年",
        style: "权威专业",
      })
    })
  })
})
