import type { ListingEvidence } from "../types/audit.types"
import { resolveAuditCategory } from "./audit-category"

function A(categoryPath?: string): { A: ListingEvidence } {
  return { A: { filled: true, categoryPath } }
}

describe("resolveAuditCategory（类目覆盖层判定）", () => {
  it("hint 显式指定 computer → 直接命中，不看类目路径", () => {
    expect(resolveAuditCategory(A(undefined), "computer")).toBe("computer")
    expect(resolveAuditCategory({ A: { filled: false } }, "computer")).toBe("computer")
  })

  it("类目路径命中整机关键词 → computer", () => {
    expect(resolveAuditCategory(A("Computers & Accessories > Laptops > Traditional Laptops"))).toBe(
      "computer"
    )
    expect(resolveAuditCategory(A("Electronics > Mini PC"))).toBe("computer")
    expect(
      resolveAuditCategory(A("Electronics > Computers & Accessories > Desktops > All-in-Ones"))
    ).toBe("computer")
    expect(resolveAuditCategory(A("Electronics > Chromebooks"))).toBe("computer")
  })

  it("大小写不敏感", () => {
    expect(resolveAuditCategory(A("computers & accessories > laptops"))).toBe("computer")
  })

  it("配件/部件排除：电脑词 + 配件词 → null", () => {
    expect(resolveAuditCategory(A("Laptop Accessories > Bags & Sleeves"))).toBeNull()
    expect(resolveAuditCategory(A("Computers & Accessories > Monitor Stands"))).toBeNull()
    expect(resolveAuditCategory(A("Electronics > Computer Components > Power Supplies"))).toBeNull()
    expect(resolveAuditCategory(A("Laptop Chargers & Adapters"))).toBeNull()
  })

  it("非电脑类目 → null（走通用细则）", () => {
    expect(resolveAuditCategory(A("Home & Kitchen > Coffee Makers"))).toBeNull()
  })

  it("无类目路径（爬虫缺失/旧证据）→ null", () => {
    expect(resolveAuditCategory(A(undefined))).toBeNull()
    expect(resolveAuditCategory(A(""))).toBeNull()
    expect(resolveAuditCategory({ A: { filled: true } })).toBeNull()
  })

  it("hint 非 computer 时忽略，仍按路径判定", () => {
    expect(resolveAuditCategory(A("Computers & Accessories > Laptops"), "other")).toBe("computer")
    expect(resolveAuditCategory(A("Home & Kitchen"), "other")).toBeNull()
  })
})
