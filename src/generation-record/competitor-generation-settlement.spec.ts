/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
// 结算使用内存财务替身；真实成功钩子、来源映射和不可变写入完整运行。
import { Prisma } from "@prisma/client"
import { memoryClient } from "../../test/generation-record-memory"
import { CompetitorAnalysisService } from "../competitor-analysis/competitor-analysis.service"
import { recordGenerationSuccess } from "./generation-record-success"

describe("competitor archive before settlement", () => {
  it.each([undefined, "run-not-a-uuid", "00000000-0000-4000-8000-000000000001"])(
    "defers the archived record until actual fees settle, runId=%s",
    async runId => {
      const createdAt = new Date("2026-11-03T00:00:00Z")
      const root = {
        id: "report",
        userId: 7,
        title: "竞品报告",
        clientRequestId: "initial",
        reportPdfUrl: null,
        createdAt,
        deletedAt: null,
      }
      const { tx, data } = memoryClient({
        competitorAnalysisRecord: [root],
        businessAiRun: runId
          ? [
              {
                id: 1,
                userId: 7,
                module: "competitor-analysis",
                runId,
                operation: "summary",
                status: "READY",
                outputText: "{}",
                model: "model-1",
                createdAt,
              },
            ]
          : [],
      })
      tx.$transaction = jest.fn((work: any) => work(tx))
      const usage = {
        chargeFixedModule: jest.fn(async (_userId: number, _source: string, params: any) => {
          const previous = data.usageLog.find(log => log.requestId === params.requestId)
          if (previous) return { creditsCharged: previous.credits }
          const log = {
            id: data.usageLog.length + 1,
            userId: 7,
            source: "competitor.research",
            requestId: params.requestId,
            meta: params.meta,
            createdAt,
            credits: new Prisma.Decimal("15.25"),
          }
          data.usageLog.push(log)
          return { creditsCharged: log.credits }
        }),
      }
      const records = {
        create: jest.fn(async (_userId: number, dto: any, options: any) => {
          root.clientRequestId = dto.clientRequestId
          if (!options?.deferGenerationRecord)
            await recordGenerationSuccess(tx, "competitorAnalysisRecord", root.id)
          return { recordId: root.id }
        }),
      }
      const service = new CompetitorAnalysisService(
        {} as any,
        {} as any,
        usage as any,
        tx,
        records as any
      )
      const dto = { runId, country: "US", asins: ["B000000001"] }
      await service["_archiveSummaryRecord"](7, dto as any, { insights: [], rankings: [] })
      expect(records.create.mock.calls[0][2]).toEqual({ deferGenerationRecord: true })
      expect(data.generationRecord).toHaveLength(0)
      const billing = {
        model: "model-1",
        requestId: "gateway-request",
        requestIds: ["gateway-request"],
        costCny: "1",
      }
      await service["_finalizeSummaryRun"](7, dto as any, billing as any, {} as any, root.id)
      expect(data.generationRecord).toHaveLength(1)
      expect(data.generationRecord[0].credits.toString()).toBe("15.25")
      expect(data.generationRecord[0].modelPublicId).toBe("model-1")
      expect(data.usageLog[0].meta.recordId).toBe(root.id)
      await service["_finalizeSummaryRun"](7, dto as any, billing as any, {} as any, root.id)
      expect(data.generationRecord).toHaveLength(1)
      expect(data.usageLog).toHaveLength(1)
    }
  )
})
