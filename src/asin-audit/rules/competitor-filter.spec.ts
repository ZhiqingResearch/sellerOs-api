import { filterCompetitorCandidates } from "./competitor-filter"

const laptopTarget = {
  title: "HP Essential Laptop 2026, Intel CPU, 128GB Storage, Windows 11 Home",
  brand: "HP",
}

describe("filterCompetitorCandidates（C 卡竞品配件/周边过滤）", () => {
  it("笔记本目标：打印纸/墨盒/支架/电源线剔除，真笔记本按源顺序保留", () => {
    const { kept, dropped } = filterCompetitorCandidates(
      [
        {
          asin: "B0PAPER001",
          title: "HP Printer Paper | 8.5 x 11 Paper | Copy & Print 20 lb | 500 Sheets",
          nodeLabelPath: "Office Products:Office Products:Paper",
        },
        {
          asin: "B0LAPTOP01",
          title: "HP 15.6 Laptop, Intel Core i5, 8GB RAM, 256GB SSD, Windows 11",
          nodeLabelPath: "Electronics:Computers & Accessories:Laptops:Traditional Laptops",
        },
        {
          asin: "B0STAND002",
          title: "BESIGN LS03 Aluminum Laptop Stand, Ergonomic Detachable Computer Stand",
          nodeLabelPath: "Electronics:Laptop Accessories:Stands & Holders",
        },
        {
          asin: "B0LAPTOP03",
          title: "Microsoft Surface Laptop (2026), 13.8-inch Premium Performance Laptop",
        },
        {
          asin: "B0CORD004",
          title: "3 Prong AC Laptop Power Cord 5Ft Universal Power Cable",
        },
      ],
      laptopTarget,
      3
    )
    expect(kept.map(k => k.asin)).toEqual(["B0LAPTOP01", "B0LAPTOP03"])
    expect(dropped.map(d => d.asin)).toEqual(["B0PAPER001", "B0STAND002", "B0CORD004"])
    expect(dropped[0].reason).toContain("printer")
    expect(dropped[1].reason).toContain("stand")
  })

  it("配件目标（笔记本包）：共享任一配件词的同配件竞品放行，不误杀", () => {
    const sleeveTarget = { title: "MOSISO Laptop Sleeve Bag Compatible with MacBook 13 inch" }
    const { kept, dropped } = filterCompetitorCandidates(
      [
        { asin: "B0SLEEVE01", title: "Case Star Laptop Sleeve Case Cover for 13 inch Notebook" },
        { asin: "B0TOTE002", title: "Laptop Tote Bag for Women 15.6 inch" },
        { asin: "B0PAPER03", title: "HP Printer Paper 8.5 x 11 Ream" },
      ],
      sleeveTarget,
      3
    )
    expect(kept.map(k => k.asin)).toEqual(["B0SLEEVE01", "B0TOTE002"])
    expect(dropped.map(d => d.asin)).toEqual(["B0PAPER03"])
  })

  it("候选无标题且无类目路径 → 剔除", () => {
    const { kept, dropped } = filterCompetitorCandidates([{ asin: "B0NOTITLE1" }], laptopTarget, 3)
    expect(kept).toEqual([])
    expect(dropped).toEqual([{ asin: "B0NOTITLE1", reason: "无标题与类目信息，无法判定品类" }])
  })

  it("目标参照缺失（title/brand 均空）→ 不过滤原样放行，交由调用方降级", () => {
    const candidates = [
      { asin: "B0PAPER01", title: "HP Printer Paper 8.5 x 11" },
      { asin: "B0LAPTOP2", title: "Acer Chromebook Plus 515 Laptop" },
    ]
    const { kept, dropped } = filterCompetitorCandidates(candidates, {}, 3)
    expect(kept.map(k => k.asin)).toEqual(["B0PAPER01", "B0LAPTOP2"])
    expect(dropped).toEqual([])
  })

  it("limit 截断：干净候选超过 3 个取前 3（保持源顺序），dropped 为空", () => {
    const candidates = [
      { asin: "B0LAP00001", title: "Laptop A 15.6 inch" },
      { asin: "B0LAP00002", title: "Laptop B 14 inch" },
      { asin: "B0LAP00003", title: "Laptop C 16 inch" },
      { asin: "B0LAP00004", title: "Laptop D 17 inch" },
    ]
    const { kept, dropped } = filterCompetitorCandidates(candidates, laptopTarget, 3)
    expect(kept.map(k => k.asin)).toEqual(["B0LAP00001", "B0LAP00002", "B0LAP00003"])
    expect(dropped).toEqual([])
  })

  it("类目路径兜底：标题干净但类目路径命中配件词 → 剔除", () => {
    const { kept, dropped } = filterCompetitorCandidates(
      [
        {
          asin: "B0BAG00001",
          title: "Premium Water-Resistant Carrier for 15.6 Inch Notebooks",
          nodeLabelPath: "Electronics:Laptop Accessories:Bags & Sleeves",
        },
      ],
      laptopTarget,
      3
    )
    expect(kept).toEqual([])
    expect(dropped[0].reason).toContain("sleeve")
  })
})
