import {
  adaptAsinPerformanceE,
  adaptKeywordTrafficD,
  sifFmtVol,
  sifHeat,
  sifKwTags,
} from "./adapters"

describe("sifFmtVol", () => {
  it("formats thousands and millions", () => {
    expect(sifFmtVol(245_000)).toBe("245K")
    expect(sifFmtVol(1_200_000)).toBe("1.2M")
    expect(sifFmtVol(500)).toBe("500")
  })
})

describe("sifKwTags", () => {
  it("maps SIF tags to Chinese labels", () => {
    expect(sifKwTags(["isMainKw", "isAccurateKw"])).toEqual(["核心", "功能属性"])
    expect(sifKwTags([])).toEqual(["品类"])
  })
})

describe("sifHeat", () => {
  it("classifies heat from volume and ABA", () => {
    expect(sifHeat(90_000, 1000)).toBe("搜索量高")
    expect(sifHeat(1000, 400)).toBe("购买率较高")
    expect(sifHeat(5000, 2000)).toBe("搜索量中")
  })
})

describe("adaptKeywordTrafficD", () => {
  it("builds kwTop with contribution ratios", () => {
    const D = adaptKeywordTrafficD(
      {
        total: 2,
        startDate: "2026-03-08",
        endDate: "2026-03-14",
        list: [
          {
            asin: "B07KVV8RFF",
            keyword: "wireless earbuds",
            totalScore: 100,
            searchRank: 50,
            keywordTags: ["isMainKw"],
            naturalPositionSeq: [{ date: "2026-03-08", allPageRank: 17 }],
            spPositionSeq: [{ date: "2026-03-08", allPageRank: 19 }],
          },
          {
            asin: "B07KVV8RFF",
            keyword: "bluetooth earbuds",
            totalScore: 50,
            adScore: 10,
          },
        ],
      },
      [{ keyword: "wireless earbuds", estSearchesNum: 245_000, searchesRank: 50 }]
    )

    expect(D.filled).toBe(true)
    expect(D.kwStats?.reversed).toBe(2)
    expect(D.kwTop[0]?.kw).toBe("wireless earbuds")
    expect(D.kwTop[0]?.contribution).toBeCloseTo(66.67, 1)
    expect(D.kwTop[0]?.ranking).toContain("自然17")
    expect(D.kwDetail).toHaveLength(2)
    expect(D.kwDetail[0]?.kw).toBe("wireless earbuds")
  })

  it("sorts kwDetail by search volume descending", () => {
    const D = adaptKeywordTrafficD(
      {
        total: 3,
        list: [
          {
            asin: "B07KVV8RFF",
            keyword: "low vol",
            totalScore: 200,
            searchVolume: 1000,
          },
          {
            asin: "B07KVV8RFF",
            keyword: "high vol",
            totalScore: 50,
            searchVolume: 500_000,
          },
          {
            asin: "B07KVV8RFF",
            keyword: "mid vol",
            totalScore: 100,
            searchVolume: 50_000,
          },
        ],
      },
      [
        { keyword: "low vol", estSearchesNum: 1000 },
        { keyword: "high vol", estSearchesNum: 500_000 },
        { keyword: "mid vol", estSearchesNum: 50_000 },
      ]
    )

    expect(D.kwDetail[0]?.kw).toBe("high vol")
    expect(D.kwDetail[1]?.kw).toBe("mid vol")
    expect(D.kwDetail[2]?.kw).toBe("low vol")
  })
})

describe("adaptAsinPerformanceE", () => {
  it("treats a successful SIF response with null trend data as unavailable evidence", () => {
    expect(() => adaptAsinPerformanceE("B0G2PXBQ7J", [], { list: [] }, null)).not.toThrow()
  })

  it("merges sales, price and trend into E card", () => {
    const E = adaptAsinPerformanceE(
      "B07KVV8RFF",
      [{ asin: "B07KVV8RFF", boughtInPastMonth: 5000 }],
      {
        list: [
          {
            asin: "B07KVV8RFF",
            currentPrice: 39.99,
            listedDate: "2025-03-01",
            pricePriorityTags: ["fast_moving"],
          },
        ],
      },
      {
        dates: ["2026-05-01", "2026-05-02"],
        bsr: [4000, 3672],
        buyboxPrice: [42.99, 39.99],
        couponInfo: [null, -0.2],
      }
    )

    expect(E.filled).toBe(true)
    expect(E.boughtInPastMonth).toBe(5000)
    expect(E.priceBsr.buyboxPrice).toBe(39.99)
    expect(E.priceBsr.bsr).toBe(3672)
    expect(E.priceBsr.bsrTrend).toBe("较上期改善")
    expect(E.priceBsr.coupon).toBe("-20%")
    expect(E.priceBsr.listedDate).toBe("2025-03-01")
  })
})
