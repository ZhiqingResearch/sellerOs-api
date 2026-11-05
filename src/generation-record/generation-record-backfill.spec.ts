/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
// 测试内存委托模拟异构 Prisma 表；生产逻辑由实际同步函数执行。
import { Prisma } from "@prisma/client"
import {
  backfillGenerationRecords,
  generationBackfillWhere,
  parseGenerationBackfillArgs,
} from "../../scripts/backfill-unified-generation-records"
import { memoryClient } from "../../test/generation-record-memory"

const now = new Date("2026-11-05T00:00:00Z")

describe("generation record backfill", () => {
  it("defaults to read-only dry-run and validates explicit modes/parameters", () => {
    const options = parseGenerationBackfillArgs([], now)
    expect(options.apply).toBe(false)
    expect(options.from).toEqual(new Date("2026-10-22T00:00:00Z"))
    expect(() => parseGenerationBackfillArgs(["--apply", "--dry-run"], now)).toThrow()
    expect(() => parseGenerationBackfillArgs(["--function", "toString"], now)).toThrow()
    expect(() =>
      parseGenerationBackfillArgs(["--cursor", "history:9007199254740993"], now)
    ).toThrow()
    expect(() => parseGenerationBackfillArgs(["--cursor", "history:-1"], now)).toThrow()
    expect(() => parseGenerationBackfillArgs(["--from", "bad"], now)).toThrow()
    expect(() => parseGenerationBackfillArgs(["--batch-size", "0"], now)).toThrow()
    expect(
      parseGenerationBackfillArgs(
        ["--apply", "--function", "ASIN_AUDIT", "--cursor", "asinAuditRecord:uuid"],
        now
      ).apply
    ).toBe(true)
  })

  it("includes old ASIN roots with recent revisions and old Listing roots with recent successful operations", () => {
    const options = parseGenerationBackfillArgs([], now)
    expect(generationBackfillWhere("asinAuditRecord", options)).toHaveProperty(
      "OR.1.optimizationRevisions.some.createdAt",
      { gte: options.from, lte: now }
    )
    expect(generationBackfillWhere("history", options)).toHaveProperty(
      "OR.1.listingRun.generations.some.status",
      "COMPLETED"
    )
  })

  it("dry-run reads source batches but never writes or takes row locks", async () => {
    const { tx, data } = memoryClient({
      generationTask: [
        {
          id: 1,
          userId: 7,
          user: { id: 7, username: "运营", phone: "1", orgs: [], roles: [] },
          source: "platform",
          project: { source: "platform" },
          generationMode: "STANDARD",
          groupId: null,
          model: "model-1",
          prompt: "产品",
          status: "SUCCESS",
          createdAt: new Date("2026-11-03T00:00:00Z"),
          deletedAt: null,
          sourceJobId: null,
          generatedImages: [
            { status: "SUCCESS", url: "https://example.com/image", adopted: false },
          ],
        },
      ],
    })
    const options = parseGenerationBackfillArgs(
      ["--dry-run", "--function", "IMAGE", "--batch-size", "2"],
      now
    )
    const stats = await backfillGenerationRecords(tx, options, jest.fn())
    expect(stats.scanned).toBe(1)
    expect(data.generationRecord).toEqual([])
    expect(tx.generationRecord.upsert).not.toHaveBeenCalled()
    expect(tx.generationRecord.updateMany).not.toHaveBeenCalled()
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })
  it("apply is idempotent and reports actual frozen credits rather than later ledger changes", async () => {
    const createdAt = new Date("2026-11-03T00:00:00Z")
    const { tx, data } = memoryClient({
      generationTask: [
        {
          id: 1,
          userId: 7,
          user: { id: 7, username: "运营", phone: "1", orgs: [], roles: [] },
          source: "platform",
          project: { source: "platform" },
          generationMode: "STANDARD",
          groupId: null,
          model: "model-1",
          prompt: "产品",
          status: "SUCCESS",
          createdAt,
          deletedAt: null,
          sourceJobId: null,
          generatedImages: [{ status: "SUCCESS", url: "u", adopted: false }],
        },
      ],
      generationRecord: [
        {
          id: 1n,
          sourceType: "IMAGE",
          sourceId: "1",
          operation: "",
          userId: 7,
          function: "IMAGE",
          credits: new Prisma.Decimal(20),
          occurredAt: createdAt,
        },
      ],
    })
    tx.$transaction = jest.fn((work: any) => work(tx))
    const options = parseGenerationBackfillArgs(["--apply", "--function", "IMAGE"], now)
    const first = await backfillGenerationRecords(tx, options, jest.fn())
    const second = await backfillGenerationRecords(tx, options, jest.fn())
    expect(first.knownCredits).toBe("20")
    expect(second.knownCredits).toBe("20")
    expect(data.generationRecord).toHaveLength(1)
    expect(data.generationRecord[0].credits.toString()).toBe("20")
  })
})
