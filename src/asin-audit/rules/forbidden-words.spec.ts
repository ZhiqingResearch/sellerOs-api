import { filterForbiddenKeywords, isForbiddenKeyword } from "./forbidden-words"

describe("forbidden-words（禁词红线机械层）", () => {
  it("促销词命中：free shipping / best seller / #1 等", () => {
    expect(isForbiddenKeyword("free shipping case")).toMatch(/促销词/)
    expect(isForbiddenKeyword("Best Seller Laptop")).toMatch(/促销词/)
    expect(isForbiddenKeyword("top rated stand")).toMatch(/促销词/)
    expect(isForbiddenKeyword("laptop stand #1")).toMatch(/促销词/)
    expect(isForbiddenKeyword("money back guarantee")).toMatch(/促销词/)
    expect(isForbiddenKeyword("hot sale aluminum stand")).toMatch(/促销词/)
  })

  it("商标符命中", () => {
    expect(isForbiddenKeyword("ThinkPad™ style")).toMatch(/商标符/)
    expect(isForbiddenKeyword("Apple® style")).toMatch(/商标符/)
  })

  it("静态竞品品牌/型号词：裸写命中，兼容前缀保留", () => {
    expect(isForbiddenKeyword("samsung galaxy cover")).toMatch(/竞品品牌/)
    expect(isForbiddenKeyword("Lenovo ThinkPad E16")).toMatch(/竞品品牌/)
    expect(isForbiddenKeyword("inspiron 15 case")).toMatch(/竞品品牌/)
    // 兼容词出现在品牌词之前 → 保留
    expect(isForbiddenKeyword("case for samsung galaxy")).toBeNull()
    expect(isForbiddenKeyword("compatible with lenovo thinkpad")).toBeNull()
    // 品牌词在前、"for" 在后（非兼容表述）→ 命中
    expect(isForbiddenKeyword("samsung case for men")).toMatch(/竞品品牌/)
    // 非静态品牌词不受限
    expect(isForbiddenKeyword("aluminum laptop stand")).toBeNull()
  })

  it("filterForbiddenKeywords：kept 保序，dropped 带原因", () => {
    const { kept, dropped } = filterForbiddenKeywords([
      "laptop stand",
      "free shipping case",
      "case for samsung galaxy",
      "samsung galaxy cover",
      "aluminum stand",
    ])
    expect(kept).toEqual(["laptop stand", "case for samsung galaxy", "aluminum stand"])
    expect(dropped).toHaveLength(2)
    expect(dropped[0]?.kw).toBe("free shipping case")
    expect(dropped[1]?.reason).toMatch(/竞品品牌/)
  })

  it("空值与空白安全", () => {
    expect(isForbiddenKeyword("")).toBeNull()
    expect(isForbiddenKeyword("   ")).toBeNull()
    expect(filterForbiddenKeywords([]).kept).toEqual([])
  })
})
