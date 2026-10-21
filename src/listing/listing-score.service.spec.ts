import { INestApplication, Logger, ValidationPipe } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { BusinessAiRun, Prisma } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { HistoryService } from "../history/history.service"
import { PrismaService } from "../prisma/prisma.service"
import { ListingAiPermissionGuard } from "./guards/listing-ai-permission.guard"
import { ListingModelSelectionGuard } from "./guards/listing-model-selection.guard"
import { buildListingScoreSystemPrompt } from "./listing-score-prompt"
import { ListingAiService } from "./listing-ai.service"
import { ListingDocumentService } from "./listing-document.service"
import { ListingGenerationService } from "./listing-generation.service"
import { ListingRunService } from "./listing-run.service"
import * as images from "./listing-score-images"
import { ListingScoreService } from "./listing-score.service"
import { ListingController } from "./listing.controller"

const report = {
  total: 2,
  dimensions: [
    {
      name: "质量",
      score: 2,
      maxScore: 2,
      criteria: [{ name: "完整性", score: 2, maxScore: 2, deductions: [] }],
    },
  ],
  suggestions: ["补充已有信息中的使用场景"],
  potential: "A",
}
const dto = {
  operation: "score" as const,
  model: "ZQ-Think-Pro" as const,
  userPrompt: "商品资料",
  scoreRequestId: "832c13ca-7715-4515-b17a-236fab52a9ba",
}
const brokenReport =
  JSON.stringify({ total: report.total, dimensions: report.dimensions }).slice(0, -1) +
  ',"suggestions":["建议中途截断'

function fixture(outputs = [JSON.stringify(report)]) {
  let row: BusinessAiRun | null = null
  const matches = (where: Record<string, unknown>) => {
    if (!row) return false
    if (typeof where.status === "string" && row.status !== where.status) return false
    if (
      where.status &&
      typeof where.status === "object" &&
      !(where.status as { in: string[] }).in.includes(row.status)
    )
      return false
    const key = where.userId_module_operation_runId as { userId: number; runId: string } | undefined
    return !key || (key.userId === row.userId && key.runId === row.runId)
  }
  const table = {
    findUnique: jest.fn(async ({ where }) => (matches(where) ? structuredClone(row) : null)),
    findUniqueOrThrow: jest.fn(async () => structuredClone(row!)),
    create: jest.fn(async ({ data }) => {
      if (row)
        throw new Prisma.PrismaClientKnownRequestError("duplicate", {
          code: "P2002",
          clientVersion: "6",
        })
      row = {
        ...data,
        id: 1,
        status: "RUNNING",
        outputText: null,
        billing: null,
        requestId: null,
        usageLogId: null,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      return structuredClone(row!)
    }),
    update: jest.fn(async ({ data }) => {
      row = { ...row!, ...data, updatedAt: new Date() }
      return structuredClone(row!)
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      if (!matches(where)) return { count: 0 }
      row = { ...row!, ...data, updatedAt: new Date() }
      return { count: 1 }
    }),
  }
  let attempt = 0
  const streamChat = jest.fn(async function* () {
    const index = attempt++
    yield { type: "text", content: outputs[index] ?? "bad output" }
    yield {
      type: "billing",
      billing: {
        model: "ZQ-Think-Flash",
        costCny: index === 0 ? "0.13" : "0.03",
        currency: "CNY",
        requestId: `request-${index}`,
        requestIds: [`request-${index}`],
      },
    }
  })
  const chargeSavedOutput = jest.fn().mockResolvedValue(null)
  const tx = {
    businessAiRun: table,
    usageLog: { findUnique: jest.fn().mockResolvedValue({ id: 9 }) },
  }
  const prisma = {
    ...tx,
    $transaction: jest.fn(async callback => {
      const before = structuredClone(row)
      try {
        return await callback(tx)
      } catch (error) {
        row = before
        throw error
      }
    }),
  }
  const service = new ListingScoreService(
    prisma as unknown as PrismaService,
    { streamChat } as unknown as AiGatewayProvider,
    { chargeSavedOutput, assertAffordable: jest.fn().mockResolvedValue(undefined) } as unknown as ListingAiService
  )
  return { service, streamChat, chargeSavedOutput, table, prisma, row: () => row! }
}

describe("独立评分持久化、恢复与结算", () => {
  beforeEach(() => jest.spyOn(images, "prepareListingScoreImages").mockResolvedValue(undefined))
  afterEach(() => jest.restoreAllMocks())

  it("新CDQ规则差异不拦截，保留细则并按已有分数汇总，只调用一次及幂等结算", async () => {
    const raw = {
      scoreVersion: "cdq-2026-09-16", total: 100, potential: "S级", suggestions: [],
      dimensions: [[30, 25, 20, 15, 5, 5], [7, 7, 5, 4, 2], [10, 6, 4], [7, 5, 3]].map((limits, index) => ({
        name: ["CDQ完整性", "关键词覆盖", "COSMO", "Alexa"][index],
        maxScore: [40, 25, 20, 15][index], weight: [40, 25, 20, 15][index], score: [40, 25, 20, 15][index],
        criteria: limits.map(maxScore => ({ name: "评分项", description: "已核验", maxScore, score: maxScore,
          status: "VERIFIED", deductions: [] as unknown[] })),
      })),
    }
    Object.assign(raw.dimensions[0].criteria[3], { score: 11,
      deductions: [{ points: 4, ruleId: "image.count", evidence: "副图2张", reason: "副图数量不足" }] })
    const f = fixture([JSON.stringify(raw)])
    const input = { ...dto, scoreMarket: "amazon_us" }
    const result = await f.service.complete(3, input)
    const delivered = JSON.parse(result.text)
    expect(delivered.dimensions[0].criteria).toEqual(raw.dimensions[0].criteria)
    expect(delivered.dimensions.slice(1)).toEqual(raw.dimensions.slice(1))
    expect(delivered.dimensions[0]).toMatchObject({ score: 38.4, cdq: {
      applicableMax: 100, effectiveMax: 100, earnedScore: 96, normalizedScore: 96, evidenceCoverage: 1,
    } })
    expect(delivered.total).toBe(98.4)
    expect(delivered.validationStatus).toBe("BEST_EFFORT")
    expect(f.row()).toMatchObject({ status: "COMPLETED", error: null })
    expect(f.streamChat.mock.calls[0][0]).toContain("禁止跨项使用ruleId")
    expect(f.streamChat.mock.calls[0][0]).toContain("CDQ汇总、百分制得分及40分贡献由后端按细则得分和既定状态计算")
    expect(f.streamChat.mock.calls[0][2]).toMatchObject({ temperature: 0 })
    expect(await f.service.complete(3, input)).toEqual(result)
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.row().billing).not.toHaveProperty("repairs")
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput.mock.calls[0][2].requestId).toBe("request-0")
  })

  it("生产完整报告存在矛盾或个别描述缺失也直接交付，重连不再次生成或收费", async () => {
    const raw = readFileSync(join(__dirname, "fixtures/listing-score-20260915.json"), "utf8")
    const f = fixture([raw])
    const input = { ...dto, scoreMarket: "amazon_us", userPrompt: "mode：standard\n原始商品内容" }
    const result = await f.service.complete(3, input)
    const original = JSON.parse(raw)
    const delivered = JSON.parse(result.text)
    expect(delivered.dimensions).toEqual(original.dimensions)
    expect(delivered.total).toBe(original.total)
    expect(delivered.validationStatus).toBe("BEST_EFFORT")
    expect(f.row()).toMatchObject({ status: "COMPLETED", outputText: raw, error: null })
    expect(f.row().billing).not.toHaveProperty("repairs")
    expect(await f.service.read(3, input.scoreRequestId)).toMatchObject({ status: "COMPLETED", text: result.text })
    expect(await f.service.complete(3, input)).toEqual(result)
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput.mock.calls[0][2].requestId).toBe("request-0")
  })

  it("不传评分市场时也不因完整报告的校验差异进入重复校对", async () => {
    const raw = readFileSync(join(__dirname, "fixtures/listing-score-20260915.json"), "utf8")
    const f = fixture([raw, "不应发生校对调用"])
    const result = await f.service.complete(3, dto)
    expect(JSON.parse(result.text).dimensions).toEqual(JSON.parse(raw).dimensions)
    expect(JSON.parse(result.text).validationStatus).toBe("BEST_EFFORT")
    expect(await f.service.complete(3, dto)).toEqual(result)
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.row()).toMatchObject({ status: "COMPLETED", outputText: raw, error: null })
    expect(f.row().billing).not.toHaveProperty("repairs")
  })

  it("真实失败报告的规则差异仅留诊断，读取与重连始终返回已完成报告", async () => {
    const savedFailure = JSON.parse(readFileSync(join(__dirname, "fixtures/listing-score-failure-20260916.json"), "utf8"))
    const f = fixture([savedFailure.original])
    const input = { ...dto, scoreMarket: "amazon_us" }
    const result = await f.service.complete(3, input)
    const delivered = JSON.parse(result.text)
    const original = JSON.parse(savedFailure.original)
    expect(delivered.dimensions[0].criteria).toEqual(original.dimensions[0].criteria)
    expect(delivered.dimensions.slice(1)).toEqual(original.dimensions.slice(1))
    expect(delivered.dimensions[0]).toMatchObject({ score: 33, cdq: {
      applicableMax: 100, effectiveMax: 80, earnedScore: 66, normalizedScore: 82.5, evidenceCoverage: 0.8,
    } })
    expect(delivered.total).toBe(81.5833)
    expect(delivered.validationStatus).toBe("BEST_EFFORT")
    expect(delivered).not.toHaveProperty("validationWarnings")
    expect(f.row()).toMatchObject({ status: "COMPLETED", error: null })
    expect(await f.service.read(3, input.scoreRequestId)).toMatchObject({ status: "COMPLETED", text: result.text })
    expect(await f.service.complete(3, input)).toEqual(result)
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })

  it("生成、保存、扣费、重放，同一请求只调用和扣费一次", async () => {
    const f = fixture()
    expect(JSON.parse((await f.service.complete(3, dto)).text)).toEqual(report)
    expect(f.row().outputText).toBe(JSON.stringify(report))
    expect(f.row().usageLogId).toBe(9)
    expect(JSON.parse((await f.service.complete(3, dto)).text)).toEqual(report)
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
    await expect(f.service.read(4, dto.scoreRequestId)).rejects.toThrow("不存在")
    await expect(f.service.complete(3, { ...dto, userPrompt: "另一商品" })).rejects.toThrow(
      "其他输入"
    )
  })

  it("复现生产截断：只修复一次、保留两份证据、只收首次评分费用", async () => {
    const f = fixture([brokenReport, JSON.stringify(report)])
    const result = JSON.parse((await f.service.complete(3, dto)).text)
    expect(f.streamChat.mock.calls[0][0]).toBe(buildListingScoreSystemPrompt(undefined, dto.userPrompt))
    expect(result.dimensions).toEqual(report.dimensions)
    expect(result.recoveryNotice).toContain("未额外")
    expect(f.streamChat).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        model: dto.model,
        modelConfigKey: "AI_GATEWAY_LISTING_SCORE_MODEL",
      })
    )
    expect(f.row().outputText).toBe(brokenReport)
    expect(f.row().billing).toMatchObject({
      hasRepairStarted: true,
      repair: { outputText: JSON.stringify(report), billing: { requestId: "request-1" } },
    })
    expect(f.chargeSavedOutput).toHaveBeenCalledWith(
      3,
      "score",
      expect.objectContaining({ costCny: "0.13", requestId: "request-0" }),
      undefined,
      expect.anything(),
      undefined,
      undefined,
      dto.scoreRequestId
    )
    await f.service.complete(3, dto)
    expect(f.streamChat).toHaveBeenCalledTimes(2)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })

  it("已有格式修复先本地完成，不增加上游费用", async () => {
    const f = fixture([JSON.stringify(report).replace('"total":2,', '"total":2 ')])
    await f.service.complete(3, dto)
    expect(f.streamChat).toHaveBeenCalledTimes(1)
  })

  it("修复仅返回缺失评级时，服务端合并已有完整评分和建议", async () => {
    const { potential: _potential, ...completed } = report
    const truncated = JSON.stringify(completed).slice(0, -1) + ',"potential":"'
    const f = fixture([truncated, '{"potential":"A"}'])
    const result = JSON.parse((await f.service.complete(3, dto)).text)
    expect(result.dimensions).toEqual(report.dimensions)
    expect(result.suggestions).toEqual(report.suggestions)
    expect(f.streamChat).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.stringContaining('"requestedFields":["potential"]'),
      expect.anything()
    )
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })

  it.each(["无 JSON", '{"total":2,"dimensions":['])(
    "缺少评分核心时留存失败，不付费补造: %s",
    output => {
      return (async () => {
        const f = fixture([output])
        await expect(f.service.complete(3, dto)).rejects.toThrow()
        expect(f.row().status).toBe("FAILED")
        expect(f.row().outputText).toBe(output)
        await expect(f.service.complete(3, dto)).rejects.toThrow()
        expect(f.streamChat).toHaveBeenCalledTimes(1)
        expect(f.chargeSavedOutput).not.toHaveBeenCalled()
      })()
    }
  )

  it("格式修复仍不可展示时留存原始证据，重连不重复请求或扣费", async () => {
    const f = fixture([brokenReport, brokenReport])
    await expect(f.service.complete(3, dto)).rejects.toThrow()
    await expect(f.service.complete(3, dto)).rejects.toThrow()
    expect(f.row().status).toBe("FAILED")
    expect(f.row().billing).toMatchObject({ repair: { outputText: brokenReport } })
    expect(f.streamChat).toHaveBeenCalledTimes(2)
    expect(f.chargeSavedOutput).not.toHaveBeenCalled()
  })

  it("格式恢复已可展示但分数不一致时也交付，不再以语义差异拦截", async () => {
    const recovered = { ...report, total: 1 }
    const f = fixture([brokenReport, JSON.stringify(recovered)])
    const result = await f.service.complete(3, dto)
    const delivered = JSON.parse(result.text)
    expect(delivered.dimensions).toEqual(recovered.dimensions)
    expect(delivered.total).toBe(2)
    expect(delivered.recoveryNotice).toContain("未额外收取修复积分")
    expect(f.row()).toMatchObject({ status: "COMPLETED", outputText: brokenReport, error: null })
    expect(f.row().billing).toMatchObject({ repair: { outputText: JSON.stringify(recovered) } })
    expect(await f.service.complete(3, dto)).toEqual(result)
    expect(f.streamChat).toHaveBeenCalledTimes(2)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })

  it("结算回滚保留 READY，恢复只重试原账单", async () => {
    const f = fixture()
    f.chargeSavedOutput.mockRejectedValueOnce(new Error("数据库暂时不可用"))
    await expect(f.service.complete(3, dto)).rejects.toThrow("数据库暂时")
    expect(f.row().status).toBe("READY")
    await f.service.complete(3, dto)
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.row().status).toBe("COMPLETED")
  })

  it("并发同请求只允许一个生成；败方不能把胜方状态标失败", async () => {
    const f = fixture()
    const results = await Promise.allSettled([
      f.service.complete(3, dto),
      f.service.complete(3, dto),
    ])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.row().status).toBe("COMPLETED")
  })

  it("重复 20 轮，每轮 40 个同号并发，始终只生成一次、结算一次", async () => {
    for (let round = 0; round < 20; round++) {
      const f = fixture()
      const input = { ...dto, scoreRequestId: randomUUID() }
      const results = await Promise.allSettled(
        Array.from({ length: 40 }, () => f.service.complete(3, input))
      )
      expect(results.some(result => result.status === "fulfilled")).toBe(true)
      expect(f.streamChat).toHaveBeenCalledTimes(1)
      expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
      expect(f.row().status).toBe("COMPLETED")
    }
  })
})

describe("独立评分本地 HTTP / SSE 故障注入", () => {
  let app: INestApplication
  let baseUrl: string
  let f: ReturnType<typeof fixture>

  beforeEach(async () => {
    f = fixture([brokenReport, JSON.stringify(report)])
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    const builder = Test.createTestingModule({
      controllers: [ListingController],
      providers: [
        { provide: ListingScoreService, useValue: f.service },
        ...[
          ListingAiService,
          ListingDocumentService,
          ListingGenerationService,
          ListingRunService,
          HistoryService,
        ].map(provide => ({ provide, useValue: {} })),
      ],
    })
    for (const guard of [JwtAuthGuard, PermissionsGuard, ListingAiPermissionGuard, ListingModelSelectionGuard])
      builder.overrideGuard(guard).useValue({ canActivate: () => true })
    const moduleRef = await builder.compile()
    app = moduleRef.createNestApplication({ logger: false })
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    app.use((request: { user: { id: number } }, _response: unknown, next: () => void) => {
      request.user = { id: 3 }
      next()
    })
    await app.listen(0, "127.0.0.1")
    baseUrl = await app.getUrl()
  })

  afterEach(async () => {
    await app?.close()
    jest.restoreAllMocks()
  })

  const post = (base: string, input = dto, signal?: AbortSignal) =>
    fetch(`${base}/api/listing/ai/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    })

  it("截断输出经真实路由与 SSE 恢复；重放响应不重复调用或扣费", async () => {
    const response = await post(baseUrl)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("data: [DONE]")
    expect(body).toContain("未额外收取修复积分")
    const saved = await (
      await fetch(`${baseUrl}/api/listing/score-runs/${dto.scoreRequestId}`)
    ).json()
    expect(saved.status).toBe("COMPLETED")
    expect(JSON.parse(saved.text).dimensions).toEqual(report.dimensions)
    expect(f.row().outputText).toBe(brokenReport)
    await (await post(baseUrl)).text()
    expect(f.streamChat).toHaveBeenCalledTimes(2)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })

  it("真实矛盾报告经SSE直接交付，不发送校验拦截错误也不调用校对", async () => {
    const original = readFileSync(join(__dirname, "fixtures/listing-score-20260915.json"), "utf8")
    f.streamChat.mockImplementation(async function* () {
      yield { type: "text", content: original }
      yield { type: "billing", billing: {
        model: "ZQ-Think-Flash", costCny: "0.13", currency: "CNY",
        requestId: "request-0", requestIds: ["request-0"],
      } }
    })
    const input = { ...dto, scoreMarket: "amazon_us" }
    const body = await (await post(baseUrl, input)).text()
    expect(body).not.toContain('"type":"error"')
    expect(body).toContain("data: [DONE]")
    const saved = await (await fetch(`${baseUrl}/api/listing/score-runs/${dto.scoreRequestId}`)).json()
    expect(saved.status).toBe("COMPLETED")
    expect(JSON.parse(saved.text).dimensions).toEqual(JSON.parse(original).dimensions)
    expect(JSON.parse(saved.text).validationStatus).toBe("BEST_EFFORT")
    expect(f.row().error).toBeNull()
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput.mock.calls[0][2].requestId).toBe("request-0")
    await (await post(baseUrl, input)).text()
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })

  it("客户端中途实际断开 TCP/SSE 后，服务端继续保存；重连读回同一报告", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const originalStream = f.streamChat.getMockImplementation()!
    f.streamChat.mockImplementation(async function* () {
      await gate
      yield* originalStream()
    })
    const abort = new AbortController()
    const response = await post(baseUrl, dto, abort.signal)
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("score_run")
    abort.abort()
    await reader.cancel().catch(() => undefined)
    release()
    let status = "RUNNING"
    for (let attempt = 0; attempt < 100; attempt++) {
      const saved = await (
        await fetch(`${baseUrl}/api/listing/score-runs/${dto.scoreRequestId}`)
      ).json()
      status = saved.status
      if (status === "COMPLETED") break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(status).toBe("COMPLETED")
    expect(f.row().outputText).toBe(brokenReport)
    expect(f.streamChat).toHaveBeenCalledTimes(2)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
    const replay = await (await post(baseUrl)).text()
    expect(replay).toContain("data: [DONE]")
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })

  it("结算失败返回 SSE error 且无 DONE，READY 原样恢复后只提交一次成功结算", async () => {
    f.chargeSavedOutput.mockRejectedValueOnce(new Error("模拟事务故障"))
    const first = await (await post(baseUrl)).text()
    expect(first).toContain('"type":"error"')
    expect(first).not.toContain("data: [DONE]")
    expect(f.row().status).toBe("READY")
    const recovered = await (await post(baseUrl)).text()
    expect(recovered).toContain("data: [DONE]")
    expect(f.row().status).toBe("COMPLETED")
    expect(f.streamChat).toHaveBeenCalledTimes(2)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(2) // 首次抛错回滚，第二次成功。
    await (await post(baseUrl)).text()
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(2)
  })
})
