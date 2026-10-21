import axios from "axios"
import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { test } from "node:test"
import * as xlsx from "xlsx"
import { AiGatewayProvider } from "../../src/common/providers/ai-gateway.provider"
import {
  ComparisonValidationFailure,
  generateEvidenceFirstComparison,
  generateValidatedComparison,
  parseEvidenceAssessment,
  parseTitleEvidence,
  retryOperation,
  runListingAudit,
} from "../asin-listing-audit"
import {
  buildTasks,
  encodeCsv,
  finalizeComparison,
  findSourceQuote,
  getComparisonIssues,
  normalizeListing,
  parseCsv,
  readSoldOut,
  restoreComparisonQuotes,
  selectSample,
  validateComparison,
} from "./listing-audit"
import { runTaskPipeline } from "./task-pipeline"

test("拒绝并发参数，避免再次触发爬虫忙碌", async () => {
  await assert.rejects(
    () =>
      runListingAudit([
        "--all-file",
        "not-read.csv",
        "--core-file",
        "not-read.xlsx",
        "--concurrency",
        "3",
      ]),
    /不支持并发/
  )
})

test("服务忙按 5/10/20 秒等待重试，不消耗普通重试预算，且有重试上限", async () => {
  const busyError = {
    isAxiosError: true,
    response: { status: 502, data: { error: { code: "server is busy,please wait" } } },
  }
  let attempts = 0
  const delays: number[] = []
  const result = await retryOperation(
    async () => {
      attempts += 1
      if (attempts <= 3) throw busyError
      return "成功"
    },
    0,
    async delayMs => {
      delays.push(delayMs)
    }
  )
  assert.equal(result, "成功")
  assert.equal(attempts, 4)
  assert.deepEqual(delays, [5000, 10000, 20000])
  attempts = 0
  const boundedDelays: number[] = []
  await assert.rejects(
    () =>
      retryOperation(
        async () => {
          attempts += 1
          throw busyError
        },
        2,
        async delayMs => {
          boundedDelays.push(delayMs)
        }
      ),
    /12 次/
  )
  assert.equal(attempts, 13)
  assert.equal(boundedDelays.length, 12)
  assert.ok(boundedDelays.every(delayMs => delayMs <= 30000))
})

test("爬虫持续忙超过12次仍自动等待恢复，最长退避5分钟且顺序调用", async () => {
  const delays: number[] = []
  let attempts = 0
  let isWaiting = false
  const result = await retryOperation(
    async () => {
      assert.equal(isWaiting, false)
      attempts += 1
      if (attempts <= 15)
        throw {
          isAxiosError: true,
          response: { status: 502, data: { error: { code: "server is busy,please wait" } } },
        }
      return "恢复成功"
    },
    0,
    async delayMs => {
      isWaiting = true
      delays.push(delayMs)
      await Promise.resolve()
      isWaiting = false
    },
    { shouldKeepRetryingBusy: true }
  )
  assert.equal(result, "恢复成功")
  assert.equal(attempts, 16)
  assert.deepEqual(delays.slice(0, 5), [30000, 60000, 120000, 240000, 300000])
  assert.ok(delays.slice(4).every(delayMs => delayMs === 300000))
})

test("用户主动停止可以打断持续退避，不再发出新请求", async () => {
  let shouldStop = false
  let attempts = 0
  await assert.rejects(
    () =>
      retryOperation(
        async () => {
          attempts += 1
          throw { isAxiosError: true, response: { status: 429 } }
        },
        0,
        async delayMs => {
          assert.equal(delayMs, 1000)
          shouldStop = true
        },
        { shouldKeepRetryingBusy: true, shouldStop: () => shouldStop }
      ),
    /用户已停止/
  )
  assert.equal(attempts, 1)
})

test("鉴权失败不重试，普通 500 仍受 retries 限制", async () => {
  let attempts = 0
  await assert.rejects(() =>
    retryOperation(
      async () => {
        attempts += 1
        throw { isAxiosError: true, response: { status: 401 } }
      },
      2,
      async () => {
        assert.fail("401 不应等待重试")
      }
    )
  )
  assert.equal(attempts, 1)
  attempts = 0
  await assert.rejects(() =>
    retryOperation(
      async () => {
        attempts += 1
        throw { isAxiosError: true, response: { status: 500 } }
      },
      2,
      async () => {}
    )
  )
  assert.equal(attempts, 3)
})

test("爬虫连接故障耗尽普通重试后退避恢复，其他调用保持有限重试", async () => {
  const connectionError = { isAxiosError: true, code: "ECONNRESET" }
  let attempts = 0
  const delays: number[] = []
  const result = await retryOperation(
    async () => {
      attempts += 1
      if (attempts <= 9) throw connectionError
      return "恢复"
    },
    2,
    async () => {},
    {
      shouldKeepRetryingConnection: true,
      onConnectionWait: (_, delayMs) => {
        delays.push(delayMs)
      },
    }
  )
  assert.equal(result, "恢复")
  assert.equal(attempts, 10)
  assert.deepEqual(delays, [30000, 60000, 120000, 240000, 300000, 300000, 300000])
  attempts = 0
  await assert.rejects(() =>
    retryOperation(
      async () => {
        attempts += 1
        throw connectionError
      },
      2,
      async () => {}
    )
  )
  assert.equal(attempts, 3)
  for (const error of [
    { isAxiosError: true, code: "ECONNABORTED" },
    { isAxiosError: true, code: "ECONNRESET", response: { status: 400 } },
  ]) {
    await assert.rejects(() =>
      retryOperation(
        async () => {
          throw error
        },
        0,
        async () => {
          assert.fail("非连接故障不能无限等待")
        },
        { shouldKeepRetryingConnection: true }
      )
    )
  }
})

test("连接故障退避可被用户停止，停止后不再请求", async () => {
  let shouldStop = false
  let attempts = 0
  await assert.rejects(
    () =>
      retryOperation(
        async () => {
          attempts += 1
          throw { isAxiosError: true, code: "ECONNRESET" }
        },
        0,
        async delayMs => {
          assert.equal(delayMs, 1000)
          shouldStop = true
        },
        { shouldKeepRetryingConnection: true, shouldStop: () => shouldStop }
      ),
    /用户已停止/
  )
  assert.equal(attempts, 1)
})

test("CSV 保留引号、逗号、换行、空字段和 BOM", () => {
  const rows = [
    ["ASIN", "标题", "描述"],
    ["B0FJRSWWF3", '15.6" laptop, silver', "line1\nline2"],
    ["B0FD38WBGS", "", ""],
  ]
  assert.deepEqual(parseCsv(encodeCsv(rows)), rows)
  assert.throws(() => parseCsv('a,"unfinished'), /未闭合/)
  assert.throws(() => parseCsv('a,"value"junk'), /异常/)
  assert.match(encodeCsv([['=HYPERLINK("http://example.test")']]), /'=HYPERLINK/)
})

test("按站点 + ASIN 去重、保留回填行号、所有重复行标记核心", () => {
  const tasks = buildTasks(
    [
      { ASIN: "b0fjrswwf3", 店铺: "A-US-123" },
      { ASIN: "B0FJRSWWF3", 店铺: "B-US" },
      { ASIN: "B0FJRSWWF3", 店铺: "T-Tropicall-MX" },
    ],
    new Set(["B0FJRSWWF3"]),
    "US"
  )
  assert.equal(tasks.length, 2)
  assert.deepEqual(tasks[0].rowIndexes, [0, 1])
  assert.equal(tasks[1].url, "https://www.amazon.com.mx/dp/B0FJRSWWF3")
  assert.ok(tasks.every(task => task.isCore))
  assert.throws(() => buildTasks([{ ASIN: "=RUN()", 店铺: "US" }], new Set(), "US"), /非法/)
})

test("小样本同时覆盖核心与普通 ASIN", () => {
  const tasks = buildTasks(
    [
      { ASIN: "B0FJRSWWF3", 店铺: "A-US" },
      { ASIN: "B0FD38WBGS", 店铺: "B-US" },
      { ASIN: "B0F1CHW25Q", 店铺: "B-US" },
    ],
    new Set(["B0FJRSWWF3"]),
    "US"
  )
  assert.deepEqual(
    selectSample(tasks, 2).map(task => task.isCore),
    [true, false]
  )
  assert.equal(selectSample(tasks, 100).length, 3)
})

test("字符串和数组描述统一，空值不会变成 undefined/[object Object] 文本", () => {
  assert.deepEqual(
    normalizeListing({
      title: " A ",
      bullets: [],
      keyFeatures: [" B "],
      description: [" D ", null, "E"],
    }),
    { title: "A", bullets: ["B"], description: "D\nE" }
  )
  assert.deepEqual(normalizeListing({ title: {}, description: {} }), {
    title: "",
    bullets: [],
    description: "",
  })
})

test("售罄 true/false/未知三态，不能按价格缺失推断售罄", () => {
  assert.equal(readSoldOut({ sold_out: true }), true)
  assert.equal(readSoldOut({ sold_out: false }), false)
  assert.equal(readSoldOut({ sold_out: "false" }), false)
  assert.equal(readSoldOut({ price: "" }), null)
  assert.equal(readSoldOut({ sold_out: "unavailable" }), null)
})

const listing = {
  title: "Laptop 32GB RAM 1TB SSD",
  bullets: ["16GB RAM installed"],
  description: "1TB SSD",
}
const contradiction = {
  hasContradiction: true,
  contradictions: [
    {
      field: "bullets" as const,
      titleQuote: "32GB RAM",
      contentQuote: "16GB RAM",
      explanation: "内存容量不一致",
    },
  ],
  reason: "发现明确冲突",
}

test("矛盾必须引用实际对应标题和正文，拒绝捏造/串字段证据", () => {
  assert.ok(validateComparison(contradiction, listing))
  assert.equal(
    validateComparison(
      {
        ...contradiction,
        contradictions: [{ ...contradiction.contradictions[0], titleQuote: "64GB" }],
      },
      listing
    ),
    false
  )
  assert.equal(
    validateComparison(
      {
        ...contradiction,
        contradictions: [{ ...contradiction.contradictions[0], field: "description" }],
      },
      listing
    ),
    false
  )
  assert.equal(validateComparison({ ...contradiction, contradictions: [] }, listing), false)
  assert.equal(validateComparison({ ...contradiction, hasContradiction: false }, listing), false)
  assert.equal(validateComparison({ ...contradiction, hasContradiction: "false" }, listing), false)
})

test("定位真实故障：正文误作标题、跨行拼接、跨 bullet 拼接仍拒绝", () => {
  const source = {
    title: "Laptop 32GB RAM 1TB SSD",
    bullets: ["16GB RAM installed", "512GB SSD"],
    description: "RAM Installed Size: 16GB\nRAM Technology: DDR4\nHard Disk Size: 512GB",
  }
  const response = {
    ...contradiction,
    contradictions: [
      {
        field: "description",
        titleQuote: "16GB RAM installed",
        contentQuote: "RAM Installed Size: 16GB\nHard Disk Size: 512GB",
        explanation: "内存与硬盘不一致",
      },
    ],
  }
  assert.deepEqual(
    getComparisonIssues(response, source).map(issue => issue.code),
    ["title_quote_not_found", "content_quote_not_found"]
  )
  assert.equal(
    validateComparison(
      {
        ...response,
        contradictions: [
          {
            ...response.contradictions[0],
            field: "bullets",
            titleQuote: "32GB RAM",
            contentQuote: "16GB RAM installed\n512GB SSD",
          },
        ],
      },
      source
    ),
    false
  )
  const corrected = {
    ...response,
    contradictions: [
      {
        ...response.contradictions[0],
        titleQuote: "32GB RAM",
        contentQuote: "RAM Installed Size: 16GB",
      },
      {
        ...response.contradictions[0],
        titleQuote: "1TB SSD",
        contentQuote: "Hard Disk Size: 512GB",
      },
    ],
  }
  assert.ok(validateComparison(corrected, source))
})

test("兼容真实 Samsung 引用的窄空格、NBSP、换行和连续空白，并还原保存原文", () => {
  const source = {
    title: "Samsung Galaxy Book4, 4TB\u00a0SSD",
    bullets: ["RAM & Storage: In its top configuration with 16\u202fGB RAM and 2\u202fTB SSD"],
    description: "RAM:\t16 GB\r\n\r\nStorage: 2 TB",
  }
  const result = {
    ...contradiction,
    contradictions: [
      {
        ...contradiction.contradictions[0],
        titleQuote: "4TB SSD",
        contentQuote: "16 GB RAM and 2 TB SSD",
      },
    ],
  }
  assert.ok(validateComparison(result, source))
  const restored = restoreComparisonQuotes(result, source)
  assert.equal(restored.contradictions[0].titleQuote, "4TB\u00a0SSD")
  assert.equal(restored.contradictions[0].contentQuote, "16\u202fGB RAM and 2\u202fTB SSD")
  assert.equal(result.contradictions[0].titleQuote, "4TB SSD", "不修改保存的原始模型回答")
  assert.equal(findSourceQuote(source.description, "RAM: 16 GB Storage: 2 TB"), source.description)
})

test("空白兼容不允许改数值、改单位、删词、跨 bullet 或把正文当标题", () => {
  const source = {
    title: "Dell 27 All-in-One Touchscreen Desktop PC",
    bullets: ["64GB Memory", "2 TB SSD"],
    description: "32\u202fGB RAM installed",
  }
  assert.equal(
    validateComparison(
      {
        ...contradiction,
        contradictions: [
          {
            ...contradiction.contradictions[0],
            titleQuote: "64GB Memory",
            contentQuote: "64GB Memory",
          },
        ],
      },
      source
    ),
    false
  )
  for (const quote of [
    "16 GB RAM installed",
    "32 TB RAM installed",
    "32 GB installed",
    "32GB RAM installed",
  ]) {
    assert.equal(findSourceQuote(source.description, quote), undefined)
  }
  assert.equal(
    validateComparison(
      {
        ...contradiction,
        contradictions: [
          {
            ...contradiction.contradictions[0],
            titleQuote: "Dell 27",
            contentQuote: "64GB Memory 2 TB SSD",
          },
        ],
      },
      source
    ),
    false
  )
  assert.equal(
    findSourceQuote("32GB\nMemory", "32GB.* Memory"),
    undefined,
    "引用的正则字符只能作为文字"
  )
  assert.equal(findSourceQuote("1\nTB", " \t\n"), undefined)
  assert.equal(findSourceQuote("CPU (7)\t[AI]+", "CPU (7) [AI]+"), "CPU (7)\t[AI]+")
})

test("初判和复核只因空白不同直接通过且向下游返回真实原文，不消耗重试", async () => {
  const source = {
    ...listing,
    title: "Laptop 32GB\u00a0RAM 1TB SSD",
    bullets: ["16GB\u202fRAM installed"],
  }
  for (const stage of ["comparison", "verification"] as const) {
    let attempts = 0
    const gateway = {
      generateJson: async () => {
        attempts += 1
        return {
          data: contradiction,
          model: "mock",
          requestId: null,
          tokenUsage: { promptTokens: 1, completionTokens: 1, thinkingTokens: 0 },
        }
      },
    } as unknown as Pick<AiGatewayProvider, "generateJson">
    const response = await generateValidatedComparison({
      gateway,
      listing: source,
      model: "mock",
      retries: 2,
      stage,
      draft: contradiction,
      onValidationFailure: () => assert.fail("纯空白差异不应报错"),
      wait: async () => assert.fail("不应因格式差异重试"),
    })
    assert.equal(attempts, 1)
    assert.equal(response.data.contradictions[0].titleQuote, "32GB\u00a0RAM")
    assert.equal(response.data.contradictions[0].contentQuote, "16GB\u202fRAM")
  }
})

test("标题证据必须源自标题并完整覆盖规格，正文判断必须覆盖全部编号", () => {
  const evidence = parseTitleEvidence({ quotes: ["Laptop", "32GB RAM", "1TB SSD"] }, listing.title)
  assert.throws(() => parseTitleEvidence({ quotes: ["Laptop", "1TB SSD"] }, listing.title), /遗漏/)
  assert.throws(
    () => parseTitleEvidence({ quotes: [listing.title, "Thunderbolt 5"] }, listing.title),
    /不存在/
  )
  const assessments = evidence.map(item => ({
    evidenceId: item.id,
    hasContradiction: false,
    contradictions: [],
    reason: "该标题属性没有明确冲突",
  }))
  assert.throws(
    () => parseEvidenceAssessment({ assessments: assessments.slice(1) }, evidence, listing),
    /遗漏/
  )
  assert.throws(
    () =>
      parseEvidenceAssessment(
        { assessments: [assessments[0], assessments[0], assessments[2]] },
        evidence,
        listing
      ),
    /重复/
  )
  assert.throws(
    () =>
      parseEvidenceAssessment(
        { assessments: [{ ...assessments[0], evidenceId: 99 }, ...assessments.slice(1)] },
        evidence,
        listing
      ),
    /不存在/
  )
  const result = parseEvidenceAssessment(
    {
      assessments: assessments.map(item =>
        item.evidenceId === 2
          ? {
              ...item,
              hasContradiction: true,
              contradictions: [
                { field: "bullets", contentQuote: "16GB RAM", explanation: "32GB与16GB冲突" },
              ],
            }
          : item
      ),
    },
    evidence,
    listing
  )
  assert.equal(result.contradictions[0].titleQuote, "32GB RAM")
  assert.equal(result.hasContradiction, true)
})

test("标题先行只传标题提取，所有结论独立复核，可纠正漏判与误判", async () => {
  for (const [isDraftPositive, shouldConfirm] of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ]) {
    let calls = 0
    const evidence = parseTitleEvidence(
      { quotes: ["Laptop", "32GB RAM", "1TB SSD"] },
      listing.title
    )
    const gateway = {
      generateJson: async (_system: string, user: string) => {
        calls++
        const payload = JSON.parse(user).input
        let data: unknown
        if (calls === 1) {
          assert.deepEqual(payload, { title: listing.title }, "提取阶段禁止看到正文")
          data = { quotes: evidence.map(item => item.quote) }
        } else {
          assert.deepEqual(payload.titleEvidence, evidence)
          if (calls === 3 && isDraftPositive)
            assert.equal(payload.draft.contradictions[0].titleQuote, "32GB RAM")
          data = {
            assessments: evidence.map(item => ({
              evidenceId: item.id,
              hasContradiction: item.id === 2 && (calls === 2 ? isDraftPositive : shouldConfirm),
              contradictions:
                item.id === 2 && (calls === 2 ? isDraftPositive : shouldConfirm)
                  ? [{ field: "bullets", contentQuote: "16GB RAM", explanation: "内存数值不一致" }]
                  : [],
              reason: "重新比对该标题属性和正文",
            })),
          }
        }
        return {
          data,
          model: "mock",
          requestId: null,
          tokenUsage: { promptTokens: 1, completionTokens: 1, thinkingTokens: 0 },
        }
      },
    } as unknown as Pick<AiGatewayProvider, "generateJson">
    const result = await generateEvidenceFirstComparison({
      gateway,
      listing,
      model: "mock",
      retries: 2,
      onValidationFailure: () => assert.fail("有效证据不应失败"),
      wait: async () => {},
    })
    assert.equal(calls, 3)
    assert.equal(result.comparison.hasContradiction, shouldConfirm)
    assert.equal(result.comparison.contradictions.length, shouldConfirm ? 1 : 0)
  }
})

test("标题提取持续编造证据时按预算停止并保存错误，不能转成无矛盾", async () => {
  let calls = 0
  const failures: ComparisonValidationFailure[] = []
  const gateway = {
    generateJson: async () => {
      calls++
      return {
        data: { quotes: [listing.title, "Thunderbolt 5"] },
        model: "mock",
        requestId: null,
        tokenUsage: { promptTokens: 1, completionTokens: 1, thinkingTokens: 0 },
      }
    },
  } as unknown as Pick<AiGatewayProvider, "generateJson">
  await assert.rejects(
    () =>
      generateEvidenceFirstComparison({
        gateway,
        listing,
        model: "mock",
        retries: 2,
        onValidationFailure: failure => failures.push(failure),
        wait: async () => {},
      }),
    /不存在于 TITLE/
  )
  assert.equal(calls, 3)
  assert.equal(failures.length, 3)
  assert.ok(failures.every(failure => failure.stage === "title_evidence"))
})

test("结构缺失与引用错误分别诊断，任何非法值不能直接判无矛盾", () => {
  for (const value of [
    null,
    [],
    "false",
    {},
    { hasContradiction: "false", reason: "说明", contradictions: [] },
  ])
    assert.ok(getComparisonIssues(value, listing).length)
  assert.deepEqual(
    getComparisonIssues(
      { hasContradiction: false, reason: "说明", contradictions: [{}] },
      listing
    ).map(issue => issue.code),
    ["judgment_mismatch"]
  )
  assert.equal(
    getComparisonIssues({ ...contradiction, contradictions: [] }, listing)[0].code,
    "missing_evidence"
  )
  const evidence = { ...contradiction.contradictions[0], field: "TITLE", explanation: "" }
  assert.deepEqual(
    getComparisonIssues({ ...contradiction, contradictions: [evidence] }, listing).map(
      issue => issue.code
    ),
    ["invalid_field", "missing_text"]
  )
})

test("初判和复核均记录失败返回，重试反馈具体原因并保留真实矛盾", async () => {
  for (const stage of ["comparison", "verification"] as const) {
    let attempts = 0
    const failures: ComparisonValidationFailure[] = []
    const invalid = {
      ...contradiction,
      contradictions: [{ ...contradiction.contradictions[0], titleQuote: "16GB RAM installed" }],
    }
    const gateway = {
      generateJson: async (system: string, user: string, options: { isDataValid?: unknown }) => {
        attempts += 1
        assert.equal(options.isDataValid, undefined, "在本地校验，避免 Provider 丢掉失败正文")
        if (attempts === 2) {
          const payload = JSON.parse(user)
          assert.match(system, /不能跳过中间行再拼接/)
          assert.deepEqual(payload.listing, listing)
          assert.deepEqual(payload.correction.previousResult, invalid)
          assert.equal(payload.correction.issues[0].path, "contradictions[0].titleQuote")
          if (stage === "verification") assert.deepEqual(payload.draft, contradiction)
        }
        return {
          data: attempts === 1 ? invalid : contradiction,
          model: "mock",
          requestId: "test",
          tokenUsage: { promptTokens: 1, completionTokens: 1, thinkingTokens: 0 },
        }
      },
    } as unknown as Pick<AiGatewayProvider, "generateJson">
    const result = await generateValidatedComparison({
      gateway,
      listing,
      model: "mock",
      retries: 2,
      stage,
      draft: stage === "verification" ? contradiction : undefined,
      wait: async () => {},
      onValidationFailure: failure => {
        failures.push(failure)
      },
    })
    assert.equal(attempts, 2)
    assert.deepEqual(result.data, contradiction)
    assert.equal(failures.length, 1)
    assert.equal(failures[0].stage, stage)
    assert.deepEqual(failures[0].response.data, invalid)
  }
})

test("重复无效证据耗尽预算后仍失败，不无限重试或静默转否", async () => {
  let attempts = 0
  const failures: ComparisonValidationFailure[] = []
  const gateway = {
    generateJson: async () => {
      attempts += 1
      return {
        data: { ...contradiction, contradictions: [] },
        model: "mock",
        requestId: null,
        tokenUsage: { promptTokens: 1, completionTokens: 1, thinkingTokens: 0 },
      }
    },
  } as unknown as Pick<AiGatewayProvider, "generateJson">
  await assert.rejects(
    () =>
      generateValidatedComparison({
        gateway,
        listing,
        model: "mock",
        retries: 2,
        stage: "comparison",
        wait: async () => {},
        onValidationFailure: failure => {
          failures.push(failure)
        },
      }),
    /AI 初判校验失败：contradictions true 判断必须至少有一条矛盾证据/
  )
  assert.equal(attempts, 3)
  assert.deepEqual(
    failures.map(failure => failure.attempt),
    [1, 2, 3]
  )
})

test("缺描述仅比对五点、缺五点仅比对描述；仅缺标题或两项正文都空时无法判断", () => {
  const noConflict = { hasContradiction: false, contradictions: [], reason: "未发现矛盾" }
  assert.equal(finalizeComparison(noConflict, listing).hasContradiction, false)
  assert.equal(
    finalizeComparison(noConflict, { ...listing, description: "" }).hasContradiction,
    false
  )
  assert.equal(
    finalizeComparison(contradiction, { ...listing, description: "" }).hasContradiction,
    true
  )
  assert.match(
    finalizeComparison(noConflict, { ...listing, description: "" }).reason,
    /比对范围：BULLET POINTS 与 TITLE/
  )
  assert.equal(finalizeComparison(noConflict, { ...listing, bullets: [] }).hasContradiction, false)
  assert.match(
    finalizeComparison(noConflict, { ...listing, bullets: [] }).reason,
    /比对范围：PRODUCT DESCRIPTION 与 TITLE/
  )
  assert.equal(
    finalizeComparison(noConflict, { ...listing, bullets: [], description: " " }).hasContradiction,
    null
  )
  assert.equal(finalizeComparison(noConflict, { ...listing, title: " " }).hasContradiction, null)
})

test("缓存重试集成：不抓取，初判/复核诊断立即落盘，最终才写成功结果", async () => {
  const directory = mkdtempSync(resolve("temp/asin-audit-test-"))
  const allPath = join(directory, "input.csv")
  const corePath = join(directory, "core.xlsx")
  const outDir = join(directory, "output")
  const stateDir = join(outDir, ".state")
  const taskKey = "US-B000000001"
  // 仅用于离线测试的合成输入。
  writeFileSync(
    allPath,
    encodeCsv([
      ["ASIN", "店铺", "标题"],
      ["B000000001", "A-US", "旧标题"],
    ])
  )
  const workbook = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(
    workbook,
    xlsx.utils.aoa_to_sheet([["ASIN"], ["B000000001"]]),
    "核心"
  )
  writeFileSync(corePath, xlsx.write(workbook, { type: "buffer", bookType: "xlsx" }))
  mkdirSync(join(stateDir, "snapshots"), { recursive: true })
  writeFileSync(
    join(stateDir, "snapshots", `${taskKey}-audit.json`),
    JSON.stringify({
      taskKey,
      endpoint: "audit",
      listing,
      raw: { ...listing, sold_out: false },
      isSoldOut: false,
      fetchedAt: "2026-09-10T00:00:00Z",
      fetchMs: 1,
    })
  )
  const originalPost = axios.post
  const originalGenerate = Object.getOwnPropertyDescriptor(
    AiGatewayProvider.prototype,
    "generateJson"
  )!
  const originalKey = process.env.AI_GATEWAY_API_KEY
  const originalExitCode = process.exitCode
  const diagnosticPath = join(stateDir, "validation-failures", `${taskKey}.json`)
  const invalid = {
    ...contradiction,
    contradictions: [{ ...contradiction.contradictions[0], titleQuote: "64GB RAM" }],
  }
  let calls = 0
  let fetches = 0
  let shouldReturnValid = false
  axios.post = (async () => {
    fetches += 1
    throw new Error("本测试禁止爬虫")
  }) as typeof axios.post
  process.env.AI_GATEWAY_API_KEY = "test-only-not-a-secret"
  Object.defineProperty(AiGatewayProvider.prototype, "generateJson", {
    configurable: true,
    writable: true,
    value: async () => {
      calls += 1
      if (calls === 2 || calls === 4) {
        const diagnostic = JSON.parse(readFileSync(diagnosticPath, "utf8"))
        assert.equal(diagnostic.isResolved, false)
        assert.equal(diagnostic.failures.length, calls / 2)
        assert.deepEqual(diagnostic.failures.at(-1).response.data, invalid)
        assert.equal(existsSync(join(stateDir, "checks", `${taskKey}.json`)), false)
      }
      return {
        data: shouldReturnValid ? contradiction : calls % 2 ? invalid : contradiction,
        model: "mock",
        requestId: null,
        tokenUsage: { promptTokens: 1, completionTokens: 1, thinkingTokens: 0 },
      }
    },
  })
  try {
    await runListingAudit([
      "--all-file",
      allPath,
      "--core-file",
      corePath,
      "--out",
      outDir,
      "--mode",
      "run",
      "--asins",
      "B000000001",
      "--retries",
      "1",
      "--env-file",
      join(directory, "missing.env"),
    ])
    assert.equal(calls, 4)
    assert.equal(fetches, 0)
    const diagnostic = JSON.parse(readFileSync(diagnosticPath, "utf8"))
    assert.equal(diagnostic.isResolved, true)
    assert.deepEqual(
      diagnostic.failures.map((failure: ComparisonValidationFailure) => failure.stage),
      ["comparison", "verification"]
    )
    const result = JSON.parse(readFileSync(join(stateDir, "checks", `${taskKey}.json`), "utf8"))
    assert.equal(result.status, "completed")
    assert.equal(result.comparison.hasContradiction, true)
    assert.equal(result.comparisonValidationVersion, 2)
    const rows = parseCsv(readFileSync(join(outDir, "results.csv"), "utf8"))
    assert.equal(rows[1][rows[0].indexOf("listing内容是否与标题矛盾")], "是")
    shouldReturnValid = true
    writeFileSync(
      join(stateDir, "checks", `${taskKey}.json`),
      JSON.stringify({ ...result, status: "failed" })
    )
    writeFileSync(diagnosticPath, JSON.stringify({ ...diagnostic, isResolved: false }))
    await runListingAudit([
      "--all-file",
      allPath,
      "--core-file",
      corePath,
      "--out",
      outDir,
      "--mode",
      "run",
      "--asins",
      "B000000001",
      "--retry-failed",
      "--env-file",
      join(directory, "missing.env"),
    ])
    assert.equal(calls, 6)
    assert.equal(fetches, 0)
    const resolved = JSON.parse(readFileSync(diagnosticPath, "utf8"))
    assert.equal(resolved.isResolved, true, "新一轮直接成功也要更新历史诊断状态")
    assert.deepEqual(resolved.failures, diagnostic.failures)
  } finally {
    axios.post = originalPost
    Object.defineProperty(AiGatewayProvider.prototype, "generateJson", originalGenerate)
    if (originalKey === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = originalKey
    process.exitCode = originalExitCode
  }
})

test("批处理集成：缺货跳过模型但保留核心快照、库存未知正常处理、失败隔离与断点重试", async () => {
  mkdirSync(resolve("temp"), { recursive: true })
  const directory = mkdtempSync(resolve("temp/asin-audit-test-"))
  const allPath = join(directory, "input.csv"),
    corePath = join(directory, "core.xlsx"),
    outDir = join(directory, "output")
  // 仅供软件测试的合成输入，不是用户交付表格。
  writeFileSync(
    allPath,
    encodeCsv([
      ["ASIN", "店铺", "标题", "listing内容是否与标题矛盾", "listing内容矛盾点"],
      ["B000000001", "A-US", "原表旧标题", "", ""],
      ["B000000001", "B-US", "原表重复行", "", ""],
      ["B000000002", "A-US", "旧标题", "", ""],
      ["B000000002", "A-MX", "旧标题", "", ""],
      ["B000000003", "A-US", "旧标题", "", ""],
      ["B000000004", "A-US", "缺货核心", "", ""],
      ["B000000005", "A-US", "缺货普通", "", ""],
      ["B000000006", "A-US", "库存未知", "", ""],
    ])
  )
  const workbook = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(
    workbook,
    xlsx.utils.aoa_to_sheet([["ASIN"], ["B000000001"], ["B000000004"]]),
    "核心"
  )
  writeFileSync(corePath, xlsx.write(workbook, { type: "buffer", bookType: "xlsx" }))
  const originalPost = axios.post
  const originalGenerate = Object.getOwnPropertyDescriptor(
    AiGatewayProvider.prototype,
    "generateJson"
  )!
  const originalKey = process.env.AI_GATEWAY_API_KEY
  const originalExitCode = process.exitCode
  let fetchCount = 0,
    modelCount = 0,
    verificationCount = 0,
    shouldFail = true
  let previousMappedCsv: string | undefined
  let releaseModels: () => void
  const modelsReady = new Promise<void>(resolveModels => {
    releaseModels = resolveModels
  })
  process.env.AI_GATEWAY_API_KEY = "test-only-not-a-secret"
  Object.defineProperty(axios, "post", {
    configurable: true,
    writable: true,
    value: async (url: string, body: { url: string }) => {
      assert.ok(url.endsWith("/audit"), "所有 ASIN 都应抓取 audit 获取售罄字段")
      fetchCount += 1
      const liveRows = parseCsv(readFileSync(join(outDir, "current-results.csv"), "utf8"))
      const mappedPath = join(outDir, "results.csv")
      assert.equal(
        existsSync(mappedPath) ? readFileSync(mappedPath, "utf8") : undefined,
        previousMappedCsv,
        "处理期间不映射或改写 results.csv"
      )
      if (fetchCount === 1) assert.equal(liveRows.length, 1, "未处理时实时表只有表头")
      if (fetchCount === 2) {
        await new Promise<void>(resolveTurn => setImmediate(resolveTurn))
        assert.ok(modelCount > 0, "AI 正在处理第一条时已开始抓取第二条")
        assert.equal(liveRows.length, 1, "尚未完成 AI 的记录不冒充已完成")
        assert.ok(existsSync(join(outDir, "core/US-B000000001.json")), "核心数据抓完立即保存")
      }
      if (fetchCount === 3) releaseModels()
      if (fetchCount === 7) {
        assert.equal(liveRows.find(row => row[1] === "B000000003")![5], "失败")
        for (const asin of ["B000000004", "B000000005"]) {
          const row = liveRows.find(row => row[1] === asin)!
          assert.equal(row[3], "未判断")
          assert.equal(row[liveRows[0].indexOf("是否缺货")], "是")
        }
      }
      const savedResults = readdirSync(join(outDir, ".state/checks")).filter(name =>
        name.endsWith(".json")
      )
      assert.equal(
        liveRows.length - 1,
        savedResults.length,
        "每个已完成结果在下一次抓取前写入实时表"
      )
      const asin = body.url.split("/").at(-1)!
      if (asin === "B000000003" && shouldFail) throw new Error("模拟爬虫暂时失败")
      return {
        data: {
          code: 200,
          data: {
            productId: asin,
            url: body.url,
            title: asin === "B000000005" ? "" : listing.title,
            bullets: asin === "B000000001" ? listing.bullets : ["32GB RAM"],
            description: asin === "B000000002" && body.url.includes("amazon.com/") ? "" : "1TB SSD",
            sold_out: ["B000000004", "B000000005"].includes(asin)
              ? true
              : asin === "B000000006"
                ? undefined
                : false,
            QA: [{ q: "问题", a: "回答" }],
            futureField: { preserve: true },
          },
        },
      }
    },
  })
  Object.defineProperty(AiGatewayProvider.prototype, "generateJson", {
    configurable: true,
    writable: true,
    value: async (_system: string, user: string) => {
      modelCount += 1
      await modelsReady
      const payload = JSON.parse(user)
      if (payload.draft) verificationCount += 1
      const text = payload.listing ?? payload
      return {
        data:
          text.bullets[0] === "16GB RAM installed"
            ? contradiction
            : { hasContradiction: false, contradictions: [], reason: "未发现矛盾" },
        model: "mock",
        requestId: null,
        tokenUsage: { promptTokens: 1, completionTokens: 1, thinkingTokens: 0 },
      }
    },
  })
  const args = [
    "--all-file",
    allPath,
    "--core-file",
    corePath,
    "--out",
    outDir,
    "--mode",
    "run",
    "--all",
    "--retries",
    "0",
    "--env-file",
    join(directory, "nonexistent.env"),
  ]
  const readOutput = (name: string) =>
    JSON.parse(readFileSync(join(outDir, name.startsWith("core/") ? "" : ".state", name), "utf8"))
  try {
    await runListingAudit(args)
    assert.equal(process.exitCode, 1)
    assert.equal(fetchCount, 7)
    assert.equal(modelCount, 5)
    assert.equal(verificationCount, 1)
    const summary = readOutput("summary.json")
    assert.deepEqual(
      [
        summary.completed,
        summary.failed,
        summary.unknown,
        summary.contradictions,
        summary.noContradictions,
        summary.out_of_stock,
      ],
      [4, 1, 0, 1, 3, 2]
    )
    const core = readOutput("core/US-B000000001.json")
    assert.deepEqual(core.raw.futureField, { preserve: true })
    assert.equal(core.currentListing.isSoldOut, false)
    assert.equal(core.raw.QA[0].a, "回答")
    assert.equal(readOutput("snapshots/US-B000000002-audit.json").raw, undefined)
    const soldOutCore = readOutput("core/US-B000000004.json")
    assert.equal(soldOutCore.raw.sold_out, true)
    assert.equal(soldOutCore.currentListing.isSoldOut, true)
    assert.deepEqual(soldOutCore.raw.futureField, { preserve: true })
    for (const asin of ["B000000004", "B000000005"]) {
      const result = readOutput(`checks/US-${asin}.json`)
      assert.equal(result.status, "out_of_stock")
      assert.equal(result.comparison, undefined)
      assert.equal(result.tokenUsage, undefined)
      assert.equal(result.verification, undefined)
    }
    assert.equal(readOutput("snapshots/US-B000000006-audit.json").isSoldOut, null)
    const rows = parseCsv(readFileSync(join(outDir, "results.csv"), "utf8"))
    assert.equal(rows.length, 9)
    assert.equal(rows[1][2], "原表旧标题")
    assert.equal(rows[2][2], "原表重复行")
    assert.equal(rows[1][3], "是")
    assert.equal(rows[2][3], "是")
    assert.equal(rows[3][3], "否")
    assert.match(
      readOutput("checks/US-B000000002.json").comparison.reason,
      /比对范围：BULLET POINTS 与 TITLE/
    )
    assert.equal(rows[4][3], "否")
    assert.equal(rows[5][3], "未判断")
    assert.equal(rows[6][3], "未判断")
    assert.equal(rows[7][3], "未判断")
    const stockColumn = rows[0].indexOf("是否缺货")
    assert.ok(stockColumn >= 0)
    assert.equal(rows[0].includes("是否售罄"), false)
    assert.equal(rows[1][stockColumn], "否")
    assert.equal(rows[6][stockColumn], "是")
    assert.equal(rows[7][stockColumn], "是")
    assert.equal(rows[8][stockColumn], "未知")
    assert.ok(rows.slice(1).every(row => row[3] !== "缺货"))
    assert.equal(rows[6][4], "")
    assert.equal(rows[7][4], "")
    assert.equal(rows[8][3], "否")
    assert.ok(!existsSync(join(outDir, ".state", "run.lock")))
    assert.deepEqual(readdirSync(outDir).sort(), [
      ".state",
      "core",
      "current-results.csv",
      "results.csv",
    ])
    const currentRows = parseCsv(readFileSync(join(outDir, "current-results.csv"), "utf8"))
    assert.equal(currentRows.length, 8)
    assert.deepEqual(
      currentRows.filter(row => row[1] === "B000000002").map(row => row[0]),
      ["US", "MX"]
    )
    process.exitCode = undefined
    await runListingAudit(args)
    assert.equal(fetchCount, 7)
    assert.equal(modelCount, 5)
    shouldFail = false
    process.exitCode = undefined
    previousMappedCsv = readFileSync(join(outDir, "results.csv"), "utf8")
    await runListingAudit([...args, "--retry-failed"])
    assert.equal(fetchCount, 8)
    assert.equal(modelCount, 6)
    assert.equal(readOutput("summary.json").failed, 0)
    assert.equal(readOutput("summary.json").completed, 5)
    assert.equal(readOutput("summary.json").out_of_stock, 2)
    const retriedRows = parseCsv(readFileSync(join(outDir, "current-results.csv"), "utf8"))
    assert.equal(retriedRows.length, 8, "重试替换旧结果，不增加重复行")
    assert.equal(retriedRows.find(row => row[1] === "B000000003")![3], "否")
    assert.equal(
      parseCsv(readFileSync(join(outDir, "results.csv"), "utf8"))[5][3],
      "否",
      "结束后更新源表映射"
    )
    assert.equal(process.exitCode, undefined)
    const exportArgs = [...args]
    exportArgs[exportArgs.indexOf("run")] = "export"
    await runListingAudit(exportArgs)
    assert.equal(fetchCount, 8, "本地导出不调用爬虫")
    assert.equal(modelCount, 6, "本地导出不调用模型")
  } finally {
    axios.post = originalPost
    Object.defineProperty(AiGatewayProvider.prototype, "generateJson", originalGenerate)
    if (originalKey === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = originalKey
    process.exitCode = originalExitCode
  }
})

test("流水线：抓取始终串行、AI最多2条并行、队列有上限且逐条处理恰好一次", async () => {
  let fetchActive = 0,
    maxFetchActive = 0,
    aiActive = 0,
    maxAiActive = 0,
    maxQueued = 0
  let hasOverlap = false
  const handled: number[] = []
  await runTaskPipeline({
    tasks: Array.from({ length: 12 }, (_, index) => index),
    workerCount: 2,
    queueLimit: 3,
    shouldStop: () => false,
    prepare: async task => {
      fetchActive += 1
      maxFetchActive = Math.max(maxFetchActive, fetchActive)
      if (aiActive) hasOverlap = true
      await new Promise<void>(resolveTurn => setImmediate(resolveTurn))
      fetchActive -= 1
      return task
    },
    process: async item => {
      aiActive += 1
      maxAiActive = Math.max(maxAiActive, aiActive)
      await new Promise(resolveDelay => setTimeout(resolveDelay, 5))
      handled.push(item)
      aiActive -= 1
    },
    onProgress: queued => {
      maxQueued = Math.max(maxQueued, queued)
    },
  })
  assert.equal(maxFetchActive, 1)
  assert.equal(maxAiActive, 2)
  assert.equal(hasOverlap, true)
  assert.equal(maxQueued, 3)
  assert.deepEqual(
    handled.sort((left, right) => left - right),
    Array.from({ length: 12 }, (_, index) => index)
  )
})

test("流水线：消费者写入失败后停止领取，等待在途抓取结束再抛错", async () => {
  let shouldStop = false,
    hasFetchEnded = false,
    fetchCount = 0
  let releaseFetch: () => void
  const fetchReady = new Promise<void>(resolveFetch => {
    releaseFetch = resolveFetch
  })
  await assert.rejects(
    runTaskPipeline({
      tasks: [1, 2, 3, 4],
      workerCount: 2,
      queueLimit: 2,
      shouldStop: () => shouldStop,
      prepare: async task => {
        fetchCount += 1
        if (task === 2) {
          await fetchReady
          hasFetchEnded = true
        }
        return task
      },
      process: async () => {
        throw new Error("模拟结果文件被占用")
      },
      onFailure: () => {
        shouldStop = true
        releaseFetch()
      },
    }),
    /模拟结果文件被占用/
  )
  assert.equal(fetchCount, 2)
  assert.equal(hasFetchEnded, true)
})

test("流水线：用户停止后保留未消费任务，不再领取新任务", async () => {
  let shouldStop = false
  const handled: number[] = []
  let fetchCount = 0
  await runTaskPipeline({
    tasks: [1, 2, 3, 4, 5, 6],
    workerCount: 1,
    queueLimit: 2,
    shouldStop: () => shouldStop,
    prepare: async task => {
      fetchCount += 1
      return task
    },
    process: async item => {
      await new Promise<void>(resolveTurn => setImmediate(resolveTurn))
      handled.push(item)
      shouldStop = true
    },
  })
  assert.deepEqual(handled, [1])
  assert.ok(fetchCount < 6)
})
