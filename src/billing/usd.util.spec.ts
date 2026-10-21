import { usdFromCents } from "./usd.util"

describe("usdFromCents（美分 → 美元字符串）", () => {
  it("常规转换", () => {
    expect(usdFromCents(1299)).toBe("12.99")
    expect(usdFromCents(5)).toBe("0.05")
    expect(usdFromCents(0)).toBe("0.00")
    expect(usdFromCents(-500)).toBe("-5.00")
    expect(usdFromCents(1000000)).toBe("10000.00")
  })
})
