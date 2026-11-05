import { Logger } from "@nestjs/common"
import { Prisma, PrismaClient } from "@prisma/client"
import { recordGenerationSuccess } from "./generation-record-success"

describe("successful generation boundary", () => {
  it("logs a failed snapshot in its own transaction without throwing or retrying", async () => {
    const error = new Error("snapshot storage failed")
    const tx = { $queryRaw: jest.fn().mockRejectedValue(error) }
    const client = {
      $transaction: jest.fn((work: (transaction: typeof tx) => Promise<unknown>) => work(tx)),
    }
    const log = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    try {
      await expect(
        recordGenerationSuccess(client as unknown as PrismaClient, "categoryAnalysisRecord", 42)
      ).resolves.toBeUndefined()
      expect(log).toHaveBeenCalledWith(
        "成功快照保存失败 source=categoryAnalysisRecord id=42",
        error.stack
      )
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
      expect(client.$transaction).toHaveBeenCalledTimes(1)
    } finally {
      log.mockRestore()
    }
  })

  it.each([
    ["P2021", "GenerationRecord 表不存在"],
    ["P2028", "生成记录事务超时"],
    ["P2034", "生成记录事务死锁"],
  ])("contains database failure %s without retrying the business", async (code, message) => {
    const error = new Prisma.PrismaClientKnownRequestError(message, {
      code,
      clientVersion: "test",
    })
    const client = { $transaction: jest.fn().mockRejectedValue(error) }
    const log = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    try {
      await expect(
        recordGenerationSuccess(client as unknown as PrismaClient, "asinAuditRecord", "report-id")
      ).resolves.toBeUndefined()
      expect(log).toHaveBeenCalledWith(
        "成功快照保存失败 source=asinAuditRecord id=report-id",
        error.stack
      )
      expect(client.$transaction).toHaveBeenCalledTimes(1)
    } finally {
      log.mockRestore()
    }
  })
})
