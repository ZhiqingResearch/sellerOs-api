/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
// 测试内存委托模拟异构 Prisma 表；生产逻辑由实际同步函数执行。
import { Prisma } from "@prisma/client"
import { memoryClient } from "../../test/generation-record-memory"
import { publicGenerationMetadata } from "../common/utils/generation-metadata"
import { markGeneratedImageSettlement } from "./image-generation-settlement"

describe("internal image settlement evidence", () => {
  it("never marks all task children merely because an individual callback lacks gateway ID", async () => {
    const { tx } = memoryClient()
    await markGeneratedImageSettlement(tx, 1, undefined, "5")
    expect(tx.generatedImage.findMany).not.toHaveBeenCalled()
    expect(tx.generatedImage.updateMany).not.toHaveBeenCalled()
  })

  it("uses the original idempotency child identifier when gateway ID is absent", async () => {
    const children = [1, 2].map(id => ({
      id,
      taskId: 10,
      status: "SUCCESS",
      deliveryMeta: { width: 100 },
    }))
    const { tx, data } = memoryClient({ generatedImage: children })
    await markGeneratedImageSettlement(tx, 10, undefined, "0", { requestId: "imggen:10:2:0" })
    expect(data.generatedImage[0].deliveryMeta).toEqual({ width: 100 })
    expect(data.generatedImage[1].deliveryMeta).toEqual({
      width: 100,
      generationRecordCredits: "0",
    })
    await markGeneratedImageSettlement(tx, 10, undefined, "9", { requestId: "imggen:999:1:0" })
    expect(data.generatedImage[0].deliveryMeta).toEqual({ width: 100 })
  })

  it("allows task-wide evidence only for an explicitly scoped batch", async () => {
    const { tx, data } = memoryClient({
      generatedImage: [
        { id: 1, taskId: 10, status: "SUCCESS", deliveryMeta: {} },
        { id: 2, taskId: 10, status: "FAILED", deliveryMeta: {} },
      ],
    })
    await markGeneratedImageSettlement(tx, 10, undefined, null, { wholeTask: true })
    expect(data.generatedImage[0].deliveryMeta).toEqual({ generationRecordCredits: null })
    expect(data.generatedImage[1].deliveryMeta).toEqual({})
  })

  it("strips private evidence without changing public metadata, Date or Decimal values", () => {
    const createdAt = new Date(),
      price = new Prisma.Decimal("0.3")
    expect(
      publicGenerationMetadata({
        createdAt,
        price,
        deliveryMeta: {
          width: 100,
          generationRecordCredits: "3",
          gatewayImage: { model: "m", generationRecordCredits: null },
        },
      })
    ).toEqual({ createdAt, price, deliveryMeta: { width: 100, gatewayImage: { model: "m" } } })
  })
})
