import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import * as XLSX from "xlsx"
import { AdCleaningProcessor } from "./ad-cleaning.processor"

const HEADERS = [
  "Currency",
  "Campaign Name",
  "Ad Group Name",
  "Targeting",
  "Match Type",
  "Customer Search Term",
  "Impressions",
  "Clicks",
  "Spend",
  "7 Day Total Sales",
  "7 Day Total Orders (#)",
]

describe("AdCleaningProcessor", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ad-cleaning-test-"))
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  const writeInput = (rows: unknown[][]): string => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["Sponsored Products Search Term Report"], [], HEADERS, ...rows]),
      "Search term report"
    )
    const inputPath = join(testDir, "input.xlsx")
    XLSX.writeFile(workbook, inputPath)
    return inputPath
  }

  it("清理搜索词后再聚合，并生成固定的 7 个 Sheet", () => {
    const inputPath = writeInput([
      ["USD", "活动A", "广告组A", "投放A", "broad", '"foo\uFFFC"', 100, 10, 10, 20, 1],
      ["USD", "活动A", "广告组A", "投放A", "广泛", "foo", 50, 2, 2, 0, 0],
      ["USD", "活动A", "广告组A", "投放A", "exact", "bad", 100, 10, 10, 0, 0],
    ])
    const outputPath = join(testDir, "output.xlsx")

    const result = AdCleaningProcessor.process(inputPath, outputPath, "input.xlsx")

    expect(result.stats).toMatchObject({
      sourceSheet: "Search term report",
      currency: "USD",
      sourceRows: 3,
      effectiveRows: 3,
      aggregatedSearchTerms: 2,
      mergedRows: 1,
      cleanedInvisibleChars: 1,
      trimmedWrappingQuotes: 1,
      negativeCandidateCount: 1,
      negativeCandidateSpend: 10,
      verdictCounts: { good: 1, bad: 1, warn: 0, watch: 0, neutral: 0 },
    })
    expect(result.sheetPreviews.map(preview => preview.sheetName)).toEqual([
      "清洗摘要",
      "按广告活动",
      "按广告组",
      "按投放",
      "按匹配类型",
      "搜索词审计",
      "待否定词",
    ])
    const auditPreview = result.sheetPreviews.find(preview => preview.sheetName === "搜索词审计")
    expect(auditPreview).toMatchObject({ totalRows: 2 })
    expect(auditPreview?.headers).toHaveLength(24)
    expect(auditPreview?.rows).toHaveLength(2)
    expect(auditPreview?.rows[0][auditPreview.headers.indexOf("客户搜索词")]).toBe("foo")
    expect(typeof auditPreview?.rows[0][auditPreview.headers.indexOf("花费")]).toBe("number")

    const output = XLSX.readFile(outputPath)
    expect(output.SheetNames).toEqual([
      "清洗摘要",
      "按广告活动",
      "按广告组",
      "按投放",
      "按匹配类型",
      "搜索词审计",
      "待否定词",
    ])

    const livePreview = AdCleaningProcessor.inspectResultBuffer(readFileSync(outputPath))
    expect(livePreview.sheetPreviews.map(preview => preview.sheetName)).toEqual([
      "按广告活动",
      "按广告组",
      "按投放",
      "按匹配类型",
      "搜索词审计",
    ])
    expect(livePreview.stats).toMatchObject({
      sourceRows: 3,
      aggregatedSearchTerms: 2,
      negativeCandidateCount: 1,
    })

    const auditRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(output.Sheets["搜索词审计"])
    const mergedTerm = auditRows.find(row => row["客户搜索词"] === "foo")
    expect(mergedTerm).toMatchObject({
      匹配类型: "broad",
      展示量: 150,
      点击量: 12,
      花费: 12,
      "7天销售额": 20,
      "7天订单数": 1,
      判断: "可收割",
    })

    const negativeRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      output.Sheets["待否定词"]
    )
    expect(negativeRows[0]).toMatchObject({
      客户搜索词: "bad",
      建议否定匹配: "Negative Exact",
      点击量: 10,
      花费: 10,
    })
  })

  it("非空的非法数值使整个文件失败", () => {
    const inputPath = writeInput([
      ["USD", "活动A", "广告组A", "投放A", "exact", "bad number", 1, 1, "abc", 0, 0],
    ])

    expect(() =>
      AdCleaningProcessor.process(inputPath, join(testDir, "output.xlsx"), "input.xlsx")
    ).toThrow("Sheet「Search term report」第 4 行的花费不是有效金额：abc")
  })

  it("自动匹配类型统一输出为英文 auto", () => {
    const inputPath = writeInput([
      ["USD", "活动A", "广告组A", "投放A", "Auto", "term-auto", 1, 0, 0, 0, 0],
      ["USD", "活动A", "广告组A", "投放A", "自动", "term-cn", 1, 0, 0, 0, 0],
      ["USD", "活动A", "广告组A", "投放A", "", "term-blank", 1, 0, 0, 0, 0],
    ])
    const outputPath = join(testDir, "auto-match-type.xlsx")

    AdCleaningProcessor.process(inputPath, outputPath, "input.xlsx")

    const output = XLSX.readFile(outputPath)
    const matchTypeRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      output.Sheets["按匹配类型"]
    )
    expect(matchTypeRows).toHaveLength(1)
    expect(matchTypeRows[0]).toMatchObject({ 匹配类型: "auto", 展示量: 3 })

    const auditRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(output.Sheets["搜索词审计"])
    expect(auditRows).toHaveLength(3)
    expect(auditRows.every(row => row["匹配类型"] === "auto")).toBe(true)
  })

  it("每个 Sheet 的预览最多返回前100条数据并保留总行数", () => {
    const rows = Array.from({ length: 105 }, (_, index) => [
      "USD",
      "活动A",
      "广告组A",
      "投放A",
      "exact",
      `term-${index + 1}`,
      1,
      0,
      0,
      0,
      0,
    ])
    const result = AdCleaningProcessor.process(
      writeInput(rows),
      join(testDir, "preview-limit.xlsx"),
      "input.xlsx"
    )

    const preview = result.sheetPreviews.find(item => item.sheetName === "搜索词审计")
    expect(preview?.totalRows).toBe(105)
    expect(preview?.rows).toHaveLength(100)
    expect(preview?.headers[0]).toBe("广告活动")
  })

  it("缺少必填表头时给出明确错误", () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Campaign Name", "Clicks"],
        ["活动A", 1],
      ]),
      "错误数据"
    )
    const inputPath = join(testDir, "missing-header.xlsx")
    XLSX.writeFile(workbook, inputPath)

    expect(() =>
      AdCleaningProcessor.process(inputPath, join(testDir, "output.xlsx"), "input.xlsx")
    ).toThrow(/未找到完整广告搜索词数据表/)
  })

  it("重复的必填表头不会被误报为缺失字段", () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([HEADERS.concat("点击量")]),
      "重复表头"
    )
    const inputPath = join(testDir, "duplicate-header.xlsx")
    XLSX.writeFile(workbook, inputPath)

    expect(() =>
      AdCleaningProcessor.process(inputPath, join(testDir, "output.xlsx"), "input.xlsx")
    ).toThrow("Sheet「重复表头」第 1 行存在重复字段：点击量")
  })

  it("dimension 被撑到百万行的稀疏文件按真实内容行清洗", () => {
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Sponsored Products Search Term Report"],
      [],
      HEADERS,
      ["USD", "活动A", "广告组A", "投放A", "exact", "term-1", 100, 10, 10, 20, 1],
      ["USD", "活动A", "广告组A", "投放A", "exact", "term-2", 50, 0, 0, 0, 0],
    ])
    // 模拟 WPS 整列套格式：dimension 声明到 1048228 行，但尾部无内容
    sheet["!ref"] = "A1:Q1048228"
    XLSX.utils.book_append_sheet(workbook, sheet, "Search term report")
    const inputPath = join(testDir, "sparse-ref.xlsx")
    XLSX.writeFile(workbook, inputPath)

    const result = AdCleaningProcessor.process(
      inputPath,
      join(testDir, "output.xlsx"),
      "input.xlsx"
    )

    expect(result.stats).toMatchObject({
      sourceRows: 2,
      effectiveRows: 2,
      aggregatedSearchTerms: 2,
    })
  })
})
