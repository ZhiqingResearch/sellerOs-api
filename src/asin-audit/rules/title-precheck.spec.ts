import type { ListingEvidence, ProductParamsEvidence } from "../types/audit.types"
import { precheckBrandInTitle, resolveListingBrand } from "./title-precheck"

describe("title-precheck（A1 品牌词机械预检）", () => {
  it("A 卡 brand 在标题中 → inTitle=true，给出 1-based 词序号（大小写不敏感）", () => {
    const A: ListingEvidence = {
      filled: true,
      title: 'Lenovo IdeaPad Slim 3i 15.6" FHD Laptop Computer, Quad-Core Intel N150',
      brand: "Lenovo",
    }
    const r = precheckBrandInTitle(A)
    expect(r).toEqual({ brand: "Lenovo", inTitle: true, position: 1 })

    const mid: ListingEvidence = {
      filled: true,
      title: "AC Reinvented Anker 737 Power Bank",
      brand: "Anker",
    }
    expect(precheckBrandInTitle(mid)?.position).toBe(3)
  })

  it("brand 在标题中未出现 → inTitle=false", () => {
    const A: ListingEvidence = {
      filled: true,
      title: "Slim 3i 15.6 FHD Laptop Computer",
      brand: "Lenovo",
    }
    expect(precheckBrandInTitle(A)).toEqual({ brand: "Lenovo", inTitle: false, position: null })
  })

  it("A 卡无 brand 时回退 P 卡 Brand/品牌 属性", () => {
    const A: ListingEvidence = { filled: true, title: "Lenovo IdeaPad Slim 3i" }
    const P: ProductParamsEvidence = {
      filled: true,
      groups: [
        {
          name: "其它信息",
          fields: [
            { k: "ASIN", v: "B0XXXX" },
            { k: "Brand", v: "Lenovo" },
          ],
        },
      ],
    }
    expect(resolveListingBrand(A, P)).toBe("Lenovo")
    expect(precheckBrandInTitle(A, P)?.inTitle).toBe(true)
  })

  it("无 brand（A/P 均无）或无标题 → 不预检返回 null", () => {
    expect(precheckBrandInTitle({ filled: true, title: "no brand here" })).toBeNull()
    expect(precheckBrandInTitle({ filled: true, brand: "Lenovo" })).toBeNull()
  })

  it("品牌词只做包含检查：子串命中即可（如 AnkerUV 命中 Anker）", () => {
    const A: ListingEvidence = {
      filled: true,
      title: "AnkerUV Sanitizer Case",
      brand: "Anker",
    }
    expect(precheckBrandInTitle(A)?.inTitle).toBe(true)
  })
})
