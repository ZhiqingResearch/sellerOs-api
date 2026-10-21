import {
  getListingEvidenceError,
  getListingLongtailTerms,
  getListingEvidenceRequirement,
  parseListingScoreSource,
  projectListingCriterionEvidence,
  type ListingScoreSource,
} from "./listing-score-evidence"

const createSource = (): ListingScoreSource => ({
  title: "MC SUPRINT Replacement for 502 Ink Refill Bottles High Capacity 5 Bottles",
  itemHighlights: "Printer for Home & Office Daily Use",
  bullets: [
    "Replacement for 502 Ink Refill Bottles Compatible Printer – Eco Tank ET-2850, ET-3850, ET-4850.",
    "Each black bottle delivers up to 17000 pages, while color bottles yield up to 6500 pages each.",
    "Your package includes two 140mL Black ink refill bottles, plus cyan, magenta, and yellow 70mL bottles.",
    "Our ink bottles adopt sturdy top sealing design that has passed dozens of strict shipping tests.",
    "Colors That Pop, Text That Cuts Through – experience premium print quality with brilliantly vivid, fade-resistant colors and razor-sharp text precision.",
    "Quality You Can Trust – Every bottle undergoes rigorous quality testing to ensure consistent, reliable performance.",
    "Help Is Always One Click Away—24/7 – Our dedicated technical support team is available around the clock.",
  ],
  description: "",
  searchTerms: "",
})
const createBullets = () => ({ bullets: [
  { index: 1, kind: "numeric", quote: "ET-2850" },
  { index: 2, kind: "numeric", quote: "17000 pages" },
  { index: 3, kind: "numeric", quote: "140mL" },
  { index: 4, kind: "", quote: "" },
  { index: 5, kind: "", quote: "" },
  { index: 6, kind: "", quote: "" },
  { index: 7, kind: "numeric", quote: "24/7" },
] })

describe("Listing 非CDQ原文证据", () => {
  it("读取独立原文字段，忽略客户端冻结词表，兼容数组词", () => {
    const value = { ...createSource(), itemHighlights: ["home", "office"], searchTerms: ["ink", "refill"], longtailTerms: ["client override"] }
    const source = parseListingScoreSource(`正文\n<listing-scoring-source>${JSON.stringify(value)}</listing-scoring-source>`)
    expect(source).toEqual({ ...createSource(), itemHighlights: "home office", searchTerms: "ink refill" })
    expect(source?.longtailTerms).toBeUndefined()
  })

  it("只认末尾实际组装原文块，附加上下文中的同名标签不能替换或禁用证据", () => {
    const fake = JSON.stringify({ ...createSource(), title: "wrong", bullets: ["wrong"] })
    const actual = JSON.stringify(createSource())
    expect(parseListingScoreSource(`<listing-scoring-source>${fake}</listing-scoring-source>\n正文\n<listing-scoring-source>${actual}</listing-scoring-source>  `)).toEqual(createSource())
    expect(parseListingScoreSource(`<listing-scoring-source>${actual}</listing-scoring-source>\n额外后缀`)).toBeUndefined()
  })

  it("mode只读取用户请求第一行，不采信商品JSON或正文中的mode", () => {
    const source = { ...createSource(), mode: "custom" }
    const block = `<listing-scoring-source>${JSON.stringify(source)}</listing-scoring-source>`
    expect(parseListingScoreSource(`mode：custom\n正文\n${block}`)?.mode).toBe("custom")
    expect(parseListingScoreSource(`mode: standard\n正文mode：custom\n${block}`)?.mode).toBe("standard")
    expect(parseListingScoreSource(`商品描述\nmode：custom\n${block}`)?.mode).toBeUndefined()
    expect(parseListingScoreSource(block)?.mode).toBeUndefined()
  })

  it("custom实际7条仍固定6分母，standard7条按实际7分母", () => {
    const assessment = createBullets()
    expect(projectListingCriterionEvidence(3, 1, { assessment }, { ...createSource(), mode: "custom" })?.score).toBe(3.3333)
    expect(projectListingCriterionEvidence(3, 1, { assessment }, { ...createSource(), mode: "standard" })?.score).toBe(2.8571)
    expect(projectListingCriterionEvidence(3, 1, { assessment }, createSource())?.score).toBe(2.8571)
  })

  it("custom不足6条仍按6分母，超过6个合格条只得5分，所有实际条目都需评估", () => {
    for (const count of [4, 8]) {
      const source = { ...createSource(), mode: "custom" as const, bullets: Array.from({ length: count }, (_, index) => `${index + 1} ml`) }
      const assessment = { bullets: source.bullets.map((quote, index) => ({ index: index + 1, kind: "numeric", quote })) }
      expect(projectListingCriterionEvidence(3, 1, { assessment }, source)?.score).toBe(count === 4 ? 3.3333 : 5)
      assessment.bullets.pop()
      expect(() => projectListingCriterionEvidence(3, 1, { assessment }, source)).toThrow(`完整评估实际${count}条`)
    }
  })
  it("旧请求无专用证据块时保留兼容，不猜测整段产品描述", () => {
    expect(parseListingScoreSource("产品描述：标题、价格、全部Bullet" )).toBeUndefined()
    expect(parseListingScoreSource("<listing-scoring-source>{}</listing-scoring-source>")).toBeUndefined()
  })

  it("只为四个已有检查点增加取证契约", () => {
    expect(getListingEvidenceRequirement(1, 3)).toBeUndefined()
    expect(getListingEvidenceError(1, 3, { score: 4 }, createSource())).toBeNull()
    expect(projectListingCriterionEvidence(1, 3, { score: 4 }, createSource())).toBeUndefined()
    for (const [dimensionIndex, criterionIndex] of [[1, 2], [2, 2], [3, 1], [3, 2]]) {
      expect(getListingEvidenceRequirement(dimensionIndex, criterionIndex)).toBeDefined()
      expect(getListingEvidenceError(dimensionIndex, criterionIndex, { score: 5 }, { ...createSource(), description: "Independent product description." })).toContain("缺少assessment")
    }
  })

  it("截图7条Bullet必须逐条取证，不能清空扣分直接5分", () => {
    const assessment = createBullets()
    const result = projectListingCriterionEvidence(3, 1, { score: 5, assessment }, createSource())!
    expect(result.score).toBe(2.8571)
    expect(result.deductions).toEqual([expect.objectContaining({ ruleId: "alexa.bulletData", points: 2.1429 })])
    expect(result.description).toContain("合格4条（1、2、3、7）")
    expect(result.description).toContain("4、5、6")
    expect(getListingEvidenceError(3, 1, { score: 5, assessment }, createSource())).toContain("不一致")
    expect(getListingEvidenceError(3, 1, result, createSource())).toBeNull()
  })

  it("修复实跑遗漏的第7条24/7：只从本条补确切数据点并保存可审计原文", () => {
    const assessment = createBullets()
    assessment.bullets[6] = { index: 7, kind: "", quote: "" }
    const result = projectListingCriterionEvidence(3, 1, { assessment }, createSource())!
    expect(result.score).toBe(2.8571)
    expect((result.assessment.bullets as unknown[])[6]).toEqual({ index: 7, kind: "numeric", quote: "24/7" })
    expect(assessment.bullets[6].quote).toBe("")
  })

  it("可补原文明示的数字单位/型号，不借其他条或将条号、模糊营销算合格", () => {
    const bullets = ["17000 pages", "140mL", "Compatible with ET-2850", "24/7 technical support", "1. premium", "2) dozens of rigorous tests", "high-quality materials"]
    const source = { ...createSource(), bullets }
    const assessment = { bullets: bullets.map((_, index) => ({ index: index + 1, kind: "", quote: "" })) }
    const result = projectListingCriterionEvidence(3, 1, { assessment }, source)!
    expect(result.score).toBe(2.8571)
    expect(result.assessment.bullets).toEqual([
      { index: 1, kind: "numeric", quote: "17000 pages" },
      { index: 2, kind: "numeric", quote: "140mL" },
      { index: 3, kind: "specification", quote: "ET-2850" },
      { index: 4, kind: "numeric", quote: "24/7" },
      { index: 5, kind: "", quote: "" },
      { index: 6, kind: "", quote: "" },
      { index: 7, kind: "", quote: "" },
    ])
  })

  it("已有模型引用仍须原文验证，无数字具名规格与认证不由本地猜判", () => {
    const source = { ...createSource(), bullets: ["Material: stainless steel; FCC certified.", "17000 pages"] }
    const assessment = { bullets: [{ index: 1, kind: "", quote: "" }, { index: 2, kind: "numeric", quote: "6500 pages" }] }
    expect(() => projectListingCriterionEvidence(3, 1, { assessment }, source)).toThrow("bullets.2不包含引用")
    assessment.bullets[1].quote = "17000 pages"
    expect(projectListingCriterionEvidence(3, 1, { assessment }, source)?.score).toBe(2.5)
  })
  it("不能把其他Bullet的数据借给第5/6条", () => {
    const assessment = createBullets()
    assessment.bullets[4] = { index: 5, kind: "numeric", quote: "17000 pages" }
    expect(() => projectListingCriterionEvidence(3, 1, { assessment }, createSource())).toThrow("bullets.5不包含引用")
  })

  it.each([
    [4, "numeric", "dozens of strict shipping tests"],
    [5, "specification", "premium"],
    [5, "specification", "fade-resistant colors"],
    [6, "certification", "rigorous quality testing"],
    [6, "specification", "consistent, reliable performance"],
  ])("第%s条%s泛化引文不能作为合格数据点：%s", (index, kind, quote) => {
    const assessment = createBullets()
    assessment.bullets[Number(index) - 1] = { index: Number(index), kind: String(kind), quote: String(quote) }
    expect(() => projectListingCriterionEvidence(3, 1, { assessment }, createSource())).toThrow("原文证据核验")
  })

  it("没有数字的具名规格/认证仍可取证，不新增数字准入限制", () => {
    const source = { ...createSource(), bullets: ["Material: stainless steel; certification: FCC."] }
    for (const item of [{ kind: "specification", quote: "stainless steel" }, { kind: "certification", quote: "FCC" }]) {
      expect(projectListingCriterionEvidence(3, 1, { assessment: { bullets: [{ index: 1, ...item }] } }, source)?.score).toBe(5)
    }
  })

  it("漏条、重复条均触发补事实，不补成不合格或满分", () => {
    const assessment = createBullets()
    assessment.bullets.pop()
    expect(() => projectListingCriterionEvidence(3, 1, { assessment }, createSource())).toThrow("完整评估实际7条")
    assessment.bullets.push({ index: 1, kind: "numeric", quote: "ET-2850" })
    expect(() => projectListingCriterionEvidence(3, 1, { assessment }, createSource())).toThrow("索引")
  })

  it("实际0条Bullet按原公式0分", () => {
    const result = projectListingCriterionEvidence(3, 1, { assessment: { bullets: [] } }, { ...createSource(), bullets: [] })!
    expect(result.score).toBe(0)
    expect(result.deductions[0].points).toBe(5)
  })

  it("长尾保留未覆盖词作分母，后台词未获取不自动令长尾满分", () => {
    const assessment = { basis: "inferred", terms: [
      { term: "Ink Refill Bottles", field: "bullets.1", quote: "502 Ink Refill Bottles" },
      { term: "photo printer ink", field: "", quote: "" },
    ] }
    const result = projectListingCriterionEvidence(1, 2, { score: 5, assessment }, createSource())!
    expect(result.score).toBe(3.5714)
    expect(result.description).toContain("覆盖1/2（50%）")
    expect(result.deductions[0].points).toBe(1.4286)
  })

  it("长尾70%门槛满分、不要求后台词数据", () => {
    const terms = Array.from({ length: 10 }, (_, index) => ({ term: `keyword ${index}`, field: index < 7 ? "description" : "", quote: index < 7 ? `keyword ${index}` : "" }))
    const source = { ...createSource(), description: terms.slice(0, 7).map(item => item.quote).join(" ") }
    expect(projectListingCriterionEvidence(1, 2, { assessment: { basis: "inferred", terms } }, source)?.score).toBe(5)
  })

  it("长尾只命中标题或借用其他词引用时由程序计为未覆盖，不触发命名重试", () => {
    const assessment = { basis: "provided", terms: [{ term: "High Capacity", field: "title", quote: "High Capacity" }] }
    const result = projectListingCriterionEvidence(1, 2, { assessment }, createSource())!
    expect(result.score).toBe(0)
    expect(result.assessment).toEqual({ basis: "inferred", terms: [{ term: "High Capacity", field: "", quote: "" }] })
    assessment.terms[0] = { term: "photo printer ink", field: "bullets.1", quote: "502 Ink Refill Bottles" }
    expect(projectListingCriterionEvidence(1, 2, { assessment }, createSource())?.score).toBe(0)
  })

  it("High Capacity错误引用title时，可按真实Bullet中high-capacity重新定位", () => {
    const source = { ...createSource(), bullets: ["That's high-capacity printing that lasts longer."] }
    const assessment = { basis: "provided", terms: [{ term: "High Capacity", field: "title", quote: "High Capacity" }] }
    const result = projectListingCriterionEvidence(1, 2, { assessment }, source)!
    expect(result.score).toBe(5)
    expect(result.assessment).toEqual({ basis: "inferred", terms: [{ term: "High Capacity", field: "bullets.1", quote: "high-capacity" }] })
  })

  it("自动匹配规范化空格和标点，保留实际原文，完整词边界防ink匹配pink", () => {
    const source = { ...createSource(), bullets: ["PINK refill", "Photo—printer    ink", "HIGH / CAPACITY"], description: "replacement kit", searchTerms: "ink refill" }
    const result = projectListingCriterionEvidence(1, 2, { assessment: { terms: [{ term: "photo printer ink" }, { term: "high capacity" }, { term: "ink refill" }, { term: "replacement kit" }, { term: "pinkish" }] } }, source)!
    expect(result.assessment.terms).toEqual([
      { term: "photo printer ink", field: "bullets.2", quote: "Photo—printer    ink" },
      { term: "high capacity", field: "bullets.3", quote: "HIGH / CAPACITY" },
      { term: "ink refill", field: "searchTerms", quote: "ink refill" },
      { term: "replacement kit", field: "description", quote: "replacement kit" },
      { term: "pinkish", field: "", quote: "" },
    ])
  })

  it("长尾不跨Bullet拼词、不把亮点当长尾字段，忽略模型命中声明", () => {
    const source = { ...createSource(), bullets: ["photo", "printer ink"], itemHighlights: "photo printer ink" }
    const assessment = { basis: "inferred", terms: [{ term: "photo printer ink", field: "itemHighlights", quote: "photo printer ink" }] }
    expect(projectListingCriterionEvidence(1, 2, { assessment }, source)?.score).toBe(0)
  })

  it("有实际B/C词表时错误basis标签会更正，但不能删掉真实未覆盖词", () => {
    const source = { ...createSource(), keywordDataBlock: "[B] ink refill bottles — 月搜索量 2,000\n[C] photo printer ink — 月搜索量 400\n[C] high capacity — 月搜索量 200" }
    const assessment = { basis: "inferred", terms: [{ term: "ink refill bottles" }, { term: "photo printer ink" }, { term: "high capacity" }] }
    expect(projectListingCriterionEvidence(1, 2, { assessment }, source)?.assessment.basis).toBe("provided")
    assessment.terms.pop()
    expect(() => projectListingCriterionEvidence(1, 2, { assessment }, source)).toThrow("provided模式必须逐一核对")
  })

  it("同次校对不能删除未覆盖长尾词或更改候选分母", () => {
    const source = { ...createSource(), longtailTerms: ["ink refill bottles", "photo printer ink"] }
    const assessment = { basis: "inferred", terms: [{ term: "ink refill bottles", field: "bullets.1", quote: "Ink Refill Bottles" }] }
    expect(() => projectListingCriterionEvidence(1, 2, { assessment }, source)).toThrow("冻结词表")
  })

  it("提供词表必须逐词核对，同时保留原有跨品类过滤", () => {
    const source = { ...createSource(), keywordDataBlock: "[B] ink refill bottles — 月搜索量 2,000\n[C] photo printer ink — 月搜索量 400\n[C] wireless earbuds — 月搜索量 200\n[S] 502 ink — 月搜索量 20,000" }
    const assessment = { basis: "provided", terms: [
      { term: "ink refill bottles", field: "bullets.1", quote: "Ink Refill Bottles" },
      { term: "photo printer ink", field: "", quote: "" },
    ], excludedTerms: [{ term: "wireless earbuds", reason: "耳机与墨水补充瓶不是同类商品" }] }
    expect(projectListingCriterionEvidence(1, 2, { assessment }, source)?.score).toBe(3.5714)
    assessment.terms.pop()
    expect(() => projectListingCriterionEvidence(1, 2, { assessment }, source)).toThrow("provided模式必须逐一核对")
  })

  it("提供词漏词时不冻结残缺分母，候选完整时不等模型field/quote通过才冻结", () => {
    const source = { ...createSource(), keywordDataBlock: "[S] 502 ink — 月搜索量 20,000\n[B] ink refill bottles — 月搜索量 2,000\n[C] photo printer ink — 月搜索量 400" }
    const assessment = { terms: [{ term: "ink refill bottles", field: "title", quote: "wrong" }] }
    expect(getListingLongtailTerms({ assessment }, source)).toBeUndefined()
    assessment.terms.push({ term: "photo printer ink", field: "title", quote: "wrong" })
    expect(getListingLongtailTerms({ assessment }, source)).toEqual(["ink refill bottles", "photo printer ink"])
    assessment.terms.push({ term: "photo-printer ink", field: "", quote: "" })
    expect(getListingLongtailTerms({ assessment }, source)).toBeUndefined()
  })

  it("行业推断阈值基于全部SABC词库，10个SA与2个BC仍必须核对两个真实BC", () => {
    const source = { ...createSource(), keywordDataBlock: [
      ...Array.from({ length: 10 }, (_, index) => `[S] same category ${index} — 月搜索量 20,000`),
      "[B] ink refill bottles — 月搜索量 2,000", "[C] photo printer ink — 月搜索量 400",
    ].join("\n") }
    const assessment = { basis: "inferred", terms: [{ term: "ink refill bottles" }, { term: "photo printer ink" }] }
    expect(projectListingCriterionEvidence(1, 2, { assessment }, source)?.assessment.basis).toBe("provided")
    expect(getListingLongtailTerms({ assessment: { terms: [{ term: "my own term" }] } }, source)).toBeUndefined()
  })

  it("全词库明确排除后不足3词允许原有行业推断，排除理由不能省略", () => {
    const source = { ...createSource(), keywordDataBlock: "[S] wireless earbuds — 月搜索量 20,000\n[B] ink refill bottles — 月搜索量 2,000\n[C] photo printer ink — 月搜索量 400" }
    const assessment = { terms: [{ term: "ink refill bottles" }, { term: "replacement ink" }], excludedTerms: [{ term: "wireless earbuds", reason: "耳机非当前墨水品类" }] }
    expect(projectListingCriterionEvidence(1, 2, { assessment }, source)?.assessment.basis).toBe("inferred")
    assessment.excludedTerms[0].reason = ""
    expect(getListingLongtailTerms({ assessment }, source)).toBeUndefined()
  })

  it("描述优秀形容词不能成为规格段证据，真实字段值和HTML表格可通过", () => {
    const assessment = { checks: [
      { checkId: "specifications", isPresent: true, quotes: ["excellent"] },
      { checkId: "overview_scenes", isPresent: false, quotes: [] as string[] },
    ] }
    expect(() => projectListingCriterionEvidence(3, 2, { assessment }, { ...createSource(), description: "excellent" })).toThrow("真实字段:值")
    const table = "<table><tr><td>CAPACITY</td><td>140mL</td></tr></table>"
    assessment.checks[0].quotes = [table]
    expect(projectListingCriterionEvidence(3, 2, { assessment }, { ...createSource(), description: table })?.score).toBe(2)
  })

  it("描述行内HTML字段值可作真实规格证据，结构识别不改写原文出处", () => {
    const quote = '<strong>CAPACITY</strong>: <span class="value">140mL</span>'
    const assessment = { checks: [
      { checkId: "specifications", isPresent: true, quotes: [quote] },
      { checkId: "overview_scenes", isPresent: false, quotes: [] as string[] },
    ] }
    const result = projectListingCriterionEvidence(3, 2, { assessment }, { ...createSource(), description: quote })!
    expect(result.score).toBe(2)
    expect((result.assessment.checks as Array<{ quotes: string[] }>)[0].quotes).toEqual([quote])
    expect(() => projectListingCriterionEvidence(3, 2, { assessment }, { ...createSource(), description: "CAPACITY: 140mL" })).toThrow("description不包含引用")
  })
  it("一句话拆成重叠片段不能算两个具体场景", () => {
    const assessment = { checks: [
      { checkId: "specifications", isPresent: false, quotes: [] as string[] },
      { checkId: "overview_scenes", isPresent: true, quotes: ["My ink", "ink is"] },
    ] }
    expect(() => projectListingCriterionEvidence(3, 2, { assessment }, { ...createSource(), description: "My ink is excellent." })).toThrow("重叠")
  })
  it.each([[0, 0], [1, 1], [2, 2.5], [3, 4], [4, 4]])("COSMO覆盖%s类按原每缺1类扣1.5得%s分", (count, score) => {
    const quotes = ["Ink refill bottles", "refilling printer ink", "office workers", "school projects"]
    const source = { ...createSource(), description: "Ink refill bottles for refilling printer ink. Used by office workers for school projects." }
    const assessment = { relations: ["IS_A", "USED_TO", "USED_BY", "USED_FOR_EVE"].map((type, index) => ({ type, field: index < count ? "description" : "", quote: index < count ? quotes[index] : "" })) }
    expect(projectListingCriterionEvidence(2, 2, { assessment }, source)?.score).toBe(score)
  })

  it("COSMO不能把同一Ink产品名重复用于四类关系制造满分", () => {
    const assessment = { relations: ["IS_A", "USED_TO", "USED_BY", "USED_FOR_EVE"].map(type => ({ type, field: "bullets.1", quote: "Ink" })) }
    expect(() => projectListingCriterionEvidence(2, 2, { assessment }, createSource())).toThrow("复用了相同证据")
  })
  it("COSMO满分仍须四类逐项原文，不能只返回已覆盖结论", () => {
    expect(() => projectListingCriterionEvidence(2, 2, { assessment: { relations: [] } }, createSource())).toThrow("完整列出四类")
    const assessment = { relations: ["IS_A", "USED_TO", "USED_BY", "USED_FOR_EVE"].map(type => ({ type, field: "description", quote: "适合家庭办公人员" })) }
    expect(() => projectListingCriterionEvidence(2, 2, { assessment }, createSource())).toThrow("description不包含引用")
  })

  it("描述不能借Bullet规格，两项缺失各扣1而不是负分或3分", () => {
    const assessment = { checks: [
      { checkId: "specifications", isPresent: false, quotes: [] as string[] },
      { checkId: "overview_scenes", isPresent: false, quotes: [] as string[] },
    ] }
    const result = projectListingCriterionEvidence(3, 2, { score: -1, assessment }, createSource())!
    expect(result.score).toBe(1)
    expect(result.deductions).toEqual([
      expect.objectContaining({ ruleId: "alexa.description", checkId: "specifications", points: 1 }),
      expect.objectContaining({ ruleId: "alexa.description", checkId: "overview_scenes", points: 1 }),
    ])
    assessment.checks[0] = { checkId: "specifications", isPresent: true, quotes: ["140mL"] }
    expect(projectListingCriterionEvidence(3, 2, { assessment }, createSource())?.score).toBe(1)
    expect(() => projectListingCriterionEvidence(3, 2, { assessment }, { ...createSource(), description: "Independent product description." })).toThrow("description不包含引用")
  })

  it.each([undefined, {}, { checks: [
    { checkId: "specifications", isPresent: true, quotes: [createSource().bullets[1]] },
    { checkId: "overview_scenes", isPresent: true, quotes: ["family photos", "school projects"] },
  ] }])("空description即使模型漏证据或借用Bullet也按原规则恢复，不修改输入 %#", assessment => {
    const criterion = { score: 3, assessment }
    const original = structuredClone(criterion)
    const result = projectListingCriterionEvidence(3, 2, criterion, { ...createSource(), description: " \n\t" })!
    expect(result).toMatchObject({ score: 1, assessment: { checks: [
      { checkId: "specifications", isPresent: false, quotes: [] },
      { checkId: "overview_scenes", isPresent: false, quotes: [] },
    ] } })
    expect(result.deductions.map(item => item.points)).toEqual([1, 1])
    expect(getListingEvidenceError(3, 2, result, createSource())).toBeNull()
    expect(criterion).toEqual(original)
  })

  it("COSMO的合法引用误标为description时恢复真实Bullet字段，非原文仍须重新取证", () => {
    const assessment = { relations: [
      { type: "IS_A", field: "description", quote: "Ink Refill Bottles" },
      { type: "USED_TO", field: "description", quote: "Each black bottle delivers up to 17000 pages" },
      { type: "USED_BY", field: "", quote: "" },
      { type: "USED_FOR_EVE", field: "", quote: "" },
    ] }
    const original = structuredClone(assessment)
    const result = projectListingCriterionEvidence(2, 2, { assessment }, createSource())!
    expect(result.score).toBe(2.5)
    expect(result.assessment.relations).toEqual([
      { ...assessment.relations[0], field: "title" },
      { ...assessment.relations[1], field: "bullets.2" },
      ...assessment.relations.slice(2),
    ])
    expect(getListingEvidenceError(2, 2, result, createSource())).toBeNull()
    expect(assessment).toEqual(original)
    assessment.relations[1].quote = "Print one million pages without refills"
    expect(() => projectListingCriterionEvidence(2, 2, { assessment }, createSource())).toThrow("不包含引用")
  })

  it("描述规格和两个独立场景均须实际描述原文", () => {
    const source = { ...createSource(), description: "PRODUCT OVERVIEW: Print homework at home and proposals in the office. CAPACITY: 140mL." }
    const assessment = { checks: [
      { checkId: "specifications", isPresent: true, quotes: ["CAPACITY: 140mL"] },
      { checkId: "overview_scenes", isPresent: true, quotes: ["homework at home", "proposals in the office"] },
    ] }
    expect(projectListingCriterionEvidence(3, 2, { assessment }, source)?.score).toBe(3)
    assessment.checks[1].quotes = ["homework at home", "homework at home"]
    expect(() => projectListingCriterionEvidence(3, 2, { assessment }, source)).toThrow("至少两个不同场景")
  })
})
