import { productHardConstraints } from "./chetaidou-product-constraints"

describe("产品硬条件传递", () => {
  it("只编号确认事实中的通用硬条件，不锁定拆解观察或条件规则", () => {
    expect(
      productHardConstraints({
        hardConstraints: [" 保留中部货篮。 ", "", null, "不加把手篮。"],
        conditionalRules: [{ rule: "停车撑放下", appliesWhen: "停车" }],
        unknowns: ["隐藏侧未知"],
      })
    ).toEqual([
      { constraintId: "fact_hard_1", sourceText: "保留中部货篮。" },
      { constraintId: "fact_hard_4", sourceText: "不加把手篮。" },
    ])
    for (const content of [null, [], {}, { hardConstraints: null }])
      expect(productHardConstraints(content)).toEqual([])
  })
})
