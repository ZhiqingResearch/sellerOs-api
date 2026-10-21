import type { AuditDetailResponse } from "../types/audit.types"
import { REVIEW_SAMPLES_LIMIT, adaptAuditDetail, extractReviewRows } from "./adapt-audit-detail"

function response(data: Record<string, unknown>): AuditDetailResponse {
  return {
    id: 1,
    url: "https://www.amazon.com/dp/B0TEST1234",
    platform: "AMAZON",
    country: "US",
    asin: "B0TEST1234",
    name: "Test",
    data,
    fetchedAt: "2026-08-25T00:00:00.000Z",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  }
}

describe("adaptAuditDetail A+ 证据", () => {
  it("兼容后端 aplusImages 与带图片的 aplusModules", () => {
    const result = adaptAuditDetail(
      response({
        title: "Test Product",
        aplusImages: ["https://cdn.example.com/a-plus-1.jpg"],
        aplusModules: [
          {
            type: "Brand Story",
            desc: "品牌故事",
            imageUrl: "https://cdn.example.com/a-plus-2.jpg",
          },
        ],
      })
    )

    expect(result.A.aplusImages).toEqual([
      "https://cdn.example.com/a-plus-1.jpg",
      "https://cdn.example.com/a-plus-2.jpg",
    ])
    expect(result.A.aplusModules).toEqual([{ type: "Brand Story", desc: "品牌故事" }])
    expect(result.A.hasAplus).toBe(true)
  })

  it("过滤灰色占位图并兼容 extra.aplus_images", () => {
    const result = adaptAuditDetail(
      response({
        title: "Test Product",
        aplus: ["https://cdn.example.com/grey-pixel.gif"],
        extra: { aplus_images: ["https://cdn.example.com/real-aplus.jpg"] },
      })
    )

    expect(result.A.aplusImages).toEqual(["https://cdn.example.com/real-aplus.jpg"])
  })

  it("提取 imageUrl 主图与 otherImagesUrl 副图并去重", () => {
    const result = adaptAuditDetail(
      response({
        title: "Test Product",
        imageUrl: "https://cdn.example.com/main.jpg",
        otherImagesUrl: [
          "https://cdn.example.com/main.jpg",
          "https://cdn.example.com/side-1.jpg",
          "https://cdn.example.com/side-2.jpg",
        ],
      })
    )

    expect(result.A.productImages).toEqual([
      { url: "https://cdn.example.com/main.jpg", role: "main" },
      { url: "https://cdn.example.com/side-1.jpg", role: "secondary" },
      { url: "https://cdn.example.com/side-2.jpg", role: "secondary" },
    ])
    expect(result.A.imageCount).toBe(3)
  })
})

describe("adaptAuditDetail 品牌与类目路径提取（A1 预检 / 类目覆盖层）", () => {
  it("提取 d.brand 与 d.nodeLabelPath", () => {
    const result = adaptAuditDetail(
      response({
        title: 'Lenovo IdeaPad Slim 3i 15.6" FHD Laptop',
        brand: "Lenovo",
        nodeLabelPath: "Computers & Accessories > Laptops > Traditional Laptops",
      })
    )
    expect(result.A.brand).toBe("Lenovo")
    expect(result.A.categoryPath).toBe("Computers & Accessories > Laptops > Traditional Laptops")
  })

  it("second_title 透传为 A.secondTitle，支持 extra 兜底，缺省下发 null", () => {
    const withExtra = adaptAuditDetail(
      response({ title: "T", second_title: "副标题", extra: { second_title: "extra 副标题" } })
    )
    expect(withExtra.A.secondTitle).toBe("副标题")

    const fromExtra = adaptAuditDetail(
      response({ title: "T", extra: { second_title: "extra 副标题" } })
    )
    expect(fromExtra.A.secondTitle).toBe("extra 副标题")

    const without = adaptAuditDetail(response({ title: "T" }))
    expect(without.A.secondTitle).toBeNull()
  })

  it("extra 兜底与缺省 undefined", () => {
    const withExtra = adaptAuditDetail(
      response({ title: "T", extra: { brand: "Anker", nodeLabelPath: "Electronics > Mini PC" } })
    )
    expect(withExtra.A.brand).toBe("Anker")
    expect(withExtra.A.categoryPath).toBe("Electronics > Mini PC")

    const without = adaptAuditDetail(response({ title: "T" }))
    expect(without.A.brand).toBeUndefined()
    expect(without.A.categoryPath).toBeUndefined()
  })
})

describe("adaptAuditDetail 评论原文抽样（B.reviewSamples）", () => {
  it("透传 date/rating/title（含常见别名键），无正文的条目跳过、缺失字段省略对应键", () => {
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.999)
    const result = adaptAuditDetail(
      response({
        title: "T",
        rating: 4.2,
        reviewCount: 100,
        review: {
          comment_list: [
            {
              name: "A",
              date: "2026-08-27",
              star: 5,
              title: "Great sound",
              comment: "Bass is punchy",
            },
            { name: "B", rating: "2.0 out of 5 stars", summary: "Battery", content: "Dies fast" },
            { name: "C", comment: "   " },
          ],
        },
      })
    )

    randomSpy.mockRestore()
    expect(result.B.reviewSamples).toEqual([
      { date: "2026-08-27", rating: 5, title: "Great sound", text: "Bass is punchy" },
      { rating: "2.0 out of 5 stars", title: "Battery", text: "Dies fast" },
    ])
  })

  it("抽样条数 1~REVIEW_SAMPLES_LIMIT 随机（沿爬虫顺序截前 N 条）；commentList 别名兼容；无评论缺省字段", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ comment: `评论${i}` }))

    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.999) // → 取 10 条
    const truncated = adaptAuditDetail(response({ review: { comment_list: many } }))
    expect(truncated.B.reviewSamples).toHaveLength(REVIEW_SAMPLES_LIMIT)
    expect(truncated.B.reviewSamples?.[0]).toEqual({ text: "评论0" })

    randomSpy.mockReturnValue(0) // → 取 1 条
    const minimal = adaptAuditDetail(response({ review: { comment_list: many } }))
    expect(minimal.B.reviewSamples).toEqual([{ text: "评论0" }])
    randomSpy.mockRestore()

    const alt = adaptAuditDetail(response({ review: { commentList: [{ comment: "别名键" }] } }))
    expect(alt.B.reviewSamples).toEqual([{ text: "别名键" }])

    const none = adaptAuditDetail(response({ title: "T" }))
    expect(none.B.reviewSamples).toBeUndefined()
  })
})

describe("adaptAuditDetail P 卡 overviews 版式与描述噪音清洗", () => {
  it("服装类页面无参数表时，extra.overviews 键值对并入 P 卡 Product Details 组", () => {
    const result = adaptAuditDetail(
      response({
        title: "PRETTYGARDEN 2026 Blazers for Women Business Casual",
        product_information: null,
        extra: {
          overviews: {
            Origin: "Imported",
            "Fabric type": "Shell:97%Polyester+3%Elastane+Lining:100%Polyester",
            "Care instructions": "Machine Wash",
          },
        },
      })
    )

    expect(result.P.filled).toBe(true)
    expect(result.P.groups).toEqual([
      {
        name: "Product Details",
        fields: [
          { k: "Origin", v: "Imported" },
          { k: "Fabric type", v: "Shell:97%Polyester+3%Elastane+Lining:100%Polyester" },
          { k: "Care instructions", v: "Machine Wash" },
        ],
      },
    ])
  })

  it("与参数表并存时合并进 P 卡，重名键（大小写不敏感）去重", () => {
    const result = adaptAuditDetail(
      response({
        title: "T",
        product_information: {
          "Technical Details": [
            ["Brand", "PRETTYGARDEN"],
            ["Material", "Polyester"],
          ],
        },
        extra: {
          overviews: {
            brand: "重名应被跳过",
            "Care instructions": "Machine Wash",
          },
        },
      })
    )

    expect(result.P.groups).toEqual([
      {
        name: "Technical Details",
        fields: [
          { k: "Brand", v: "PRETTYGARDEN" },
          { k: "Material", v: "Polyester" },
        ],
      },
      {
        name: "Product Details",
        fields: [{ k: "Care instructions", v: "Machine Wash" }],
      },
    ])
  })

  it("描述剔除 This is a modal window 弹窗噪音行（含大小写变体），保留真实文案", () => {
    const result = adaptAuditDetail(
      response({
        title: "T",
        description:
          "This is a modal window.\nClassic Women's Blazer with Long Sleeves\nthis is a modal window\n\nFitted Silhouette",
      })
    )

    expect(result.A.description).toBe("Classic Women's Blazer with Long Sleeves\nFitted Silhouette")
  })
})

describe("extractReviewRows 下载原始评论 8 列", () => {
  it("按定稿字段名精确取值，值统一转字符串，按爬虫顺序逐条输出", () => {
    const rows = extractReviewRows(
      response({
        review: {
          comment_list: [
            {
              name: "Toy Monique",
              date: "2026-08-27",
              star: 5,
              title: "Great sound",
              comment: "Bass is punchy",
              verified: true,
              usefulNumber: 3,
              variant: "Black",
            },
          ],
        },
      })
    )
    expect(rows).toEqual([
      ["Toy Monique", "2026-08-27", "5", "Great sound", "Bass is punchy", "true", "3", "Black"],
    ])
  })

  it("买家列 customer 字段优先（2026-09 爬虫改名），name 兼容旧缓存；两者并存取 customer", () => {
    const rows = extractReviewRows(
      response({
        review: {
          comment_list: [
            { customer: "New Key", name: "Old Key", comment: "c1" },
            { name: "Old Only", comment: "c2" },
          ],
        },
      })
    )
    expect(rows).toEqual([
      ["New Key", "", "", "", "c1", "", "", ""],
      ["Old Only", "", "", "", "c2", "", "", ""],
    ])
  })

  it("content 别名兼容；未来字段缺失输出空串但列数不变；非对象/整行全空的条目跳过", () => {
    const rows = extractReviewRows(
      response({
        reviews: {
          commentList: [{ name: "B", content: "旧字段" }, "脏数据", null, { comment: "   " }],
        },
      })
    )
    expect(rows).toEqual([["B", "", "", "", "旧字段", "", "", ""]])
  })

  it("comment_list 整体缺失 → 空数组", () => {
    expect(extractReviewRows(response({ title: "T" }))).toEqual([])
  })
})
