import {
  COUNTRY_LANGUAGES,
  FALLBACK_MARKETPLACE_LANGUAGE,
  marketplaceLanguageHead,
  marketplaceLanguageLabel,
  marketplaceLanguageTail,
  resolveMarketplaceLanguage,
} from "./marketplace-language"

describe("marketplace-language", () => {
  describe("resolveMarketplaceLanguage", () => {
    it("解析小写下划线站点码（通用生图前端格式）", () => {
      expect(resolveMarketplaceLanguage("amazon_us")).toEqual({
        site: "AMAZON_US",
        locale: "en-US",
        languageEn: "English",
        languageZh: "英语",
      })
    })

    it("解析大写站点码（AI 拆图格式）并推导非英语商城语言", () => {
      expect(resolveMarketplaceLanguage("AMAZON_MX")).toMatchObject({
        site: "AMAZON_MX",
        locale: "es-MX",
        languageEn: "Spanish",
      })
      expect(resolveMarketplaceLanguage("AMAZON_JP")).toMatchObject({
        locale: "ja-JP",
        languageEn: "Japanese",
      })
    })

    it("平台无关：任意 平台_国家码 都按国家推导（新站点零改动生效）", () => {
      expect(resolveMarketplaceLanguage("walmart_us")).toMatchObject({
        site: "WALMART_US",
        locale: "en-US",
      })
      expect(resolveMarketplaceLanguage("tiktok_mx")).toMatchObject({
        site: "TIKTOK_MX",
        locale: "es-MX",
      })
      expect(resolveMarketplaceLanguage("temu_br")).toMatchObject({
        locale: "pt-BR",
        languageEn: "Portuguese",
      })
    })

    it("归一大小写与连字符分隔", () => {
      expect(resolveMarketplaceLanguage(" Amazon-De ")).toMatchObject({
        site: "AMAZON_DE",
        locale: "de-DE",
        languageEn: "German",
      })
    })

    it("UK 与 GB 别名同映射 en-GB", () => {
      expect(resolveMarketplaceLanguage("AMAZON_UK")?.locale).toBe("en-GB")
      expect(resolveMarketplaceLanguage("AMAZON_GB")?.locale).toBe("en-GB")
    })

    it.each(["ozon_ru", "WILDBERRIES_RU", "Ozon-Ru"])("俄罗斯站点 %s 使用俄语", (site) => {
      expect(resolveMarketplaceLanguage(site)).toMatchObject({
        locale: "ru-RU",
        languageEn: "Russian",
        languageZh: "俄语",
      })
    })

    it("格式不符返回 undefined", () => {
      expect(resolveMarketplaceLanguage("amazon")).toBeUndefined()
      expect(resolveMarketplaceLanguage("amazon_usa")).toBeUndefined()
      expect(resolveMarketplaceLanguage("us")).toBeUndefined()
      expect(resolveMarketplaceLanguage("")).toBeUndefined()
      expect(resolveMarketplaceLanguage(123)).toBeUndefined()
      expect(resolveMarketplaceLanguage(undefined)).toBeUndefined()
    })

    it("国家码查不到返回 undefined", () => {
      expect(resolveMarketplaceLanguage("amazon_zz")).toBeUndefined()
    })
  })

  describe("语言指令", () => {
    it("label 形如 Spanish (es-MX)", () => {
      expect(marketplaceLanguageLabel(resolveMarketplaceLanguage("AMAZON_MX")!)).toBe(
        "Spanish (es-MX)"
      )
    })

    it("head 指令包含语言硬约束与翻译要求", () => {
      const head = marketplaceLanguageHead(resolveMarketplaceLanguage("AMAZON_MX")!)
      expect(head).toContain("LANGUAGE=SPANISH (ES-MX)")
      expect(head).toContain("MUST be written in Spanish only")
      expect(head).toContain("translate all on-image copy into Spanish")
      expect(head.endsWith(" ")).toBe(true)
    })

    it("tail 指令以前导空格开头并复查语言", () => {
      const tail = marketplaceLanguageTail(resolveMarketplaceLanguage("AMAZON_JP")!)
      expect(tail.startsWith(" ")).toBe(true)
      expect(tail).toContain("must be in Japanese (ja-JP)")
    })

    it("兜底常量为英文", () => {
      expect(FALLBACK_MARKETPLACE_LANGUAGE.languageEn).toBe("English")
      expect(FALLBACK_MARKETPLACE_LANGUAGE.locale).toBe("en-US")
      expect(marketplaceLanguageHead(FALLBACK_MARKETPLACE_LANGUAGE)).toContain(
        "MUST be written in English only"
      )
    })
  })

  describe("国家表覆盖", () => {
    it("覆盖全部既有 AI 拆图站点", () => {
      const legacySites = [
        "AMAZON_US",
        "AMAZON_CA",
        "AMAZON_MX",
        "AMAZON_UK",
        "AMAZON_DE",
        "AMAZON_FR",
        "AMAZON_IT",
        "AMAZON_ES",
        "AMAZON_JP",
        "AMAZON_AU",
      ]
      for (const site of legacySites) {
        expect(resolveMarketplaceLanguage(site)).toBeDefined()
      }
    })

    it("表内条目字段完整", () => {
      for (const entry of Object.values(COUNTRY_LANGUAGES)) {
        expect(entry.locale).toMatch(/^[a-z]{2,3}-[A-Za-z]{2,4}$/)
        expect(entry.languageEn.length).toBeGreaterThan(0)
        expect(entry.languageZh.length).toBeGreaterThan(0)
      }
    })
  })
})
