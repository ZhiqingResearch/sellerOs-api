import { InvokeType } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { GenerationTaskRunnerService } from "./executor/generation-task-runner.service"
import { ImageGenItemRunnerService } from "./executor/image-gen-item-runner.service"

describe("图片扣费调用方式", () => {
  it.each([
    ["vidflowos", InvokeType.API],
    ["platform", InvokeType.PLATFORM],
    [undefined, InvokeType.PLATFORM],
  ])("来源 %s 的各条执行器计费路径使用 %s", async (source, invokeType) => {
    for (const mode of ["fixed", "amount", "token"] as const) {
      const usage = { chargeModel: jest.fn(), chargeTokens: jest.fn() }
      const taskRunner = new GenerationTaskRunnerService({} as never, jest.fn(), usage as never)
      taskRunner["loadFixedCredits"] = jest
        .fn()
        .mockResolvedValue(mode === "fixed" ? new Decimal(15) : null)
      taskRunner["loadPriceMultiplier"] = jest.fn().mockResolvedValue(new Decimal(3))
      if (mode === "fixed") taskRunner["pushFixedCharge"](31, "0.25", undefined, "image-31")
      if (mode === "amount") taskRunner["pushAmount"](31, "0.25", undefined, "image-31")
      if (mode === "token")
        taskRunner["usageByTask"].set(31, [
          { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        ])
      await taskRunner["reportUsage"]({
        id: 31,
        userId: 7,
        source,
        executionSpec: { provider: "ZQ-Image-3" },
      })
      if (mode === "token") {
        expect(usage.chargeTokens).toHaveBeenCalledWith(
          7,
          expect.objectContaining({ source: "aicreative.image_generate" }),
          { invokeType }
        )
      } else {
        expect(usage.chargeModel).toHaveBeenCalledTimes(1)
        expect(usage.chargeModel).toHaveBeenCalledWith(
          7,
          mode === "fixed" ? "1.5" : "0.25",
          expect.objectContaining({
            invokeType,
            source: "aicreative.image_generate",
            requestId: "charge:image-31",
          })
        )
      }

      usage.chargeModel.mockClear()
      usage.chargeTokens.mockClear()
      const itemRunner = new ImageGenItemRunnerService(
        {} as never,
        jest.fn(),
        usage as never,
        {} as never
      )
      itemRunner["loadFixedCredits"] = jest
        .fn()
        .mockResolvedValue(mode === "fixed" ? new Decimal(15) : null)
      itemRunner["loadPriceMultiplier"] = jest.fn().mockResolvedValue(new Decimal(3))
      const job = {
        id: "job-31",
        userId: 7,
        source,
        kind: "IMAGE_TO_IMAGE",
        request: { provider: "ZQ-Image-3" },
      }
      const result =
        mode === "token"
          ? { tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } }
          : { costAmountCny: "0.25" }
      await itemRunner["reportUsage"](job, result, "image-31")
      if (mode === "token") {
        expect(usage.chargeTokens).toHaveBeenCalledWith(
          7,
          expect.objectContaining({ source: "aicreative.image_generate" }),
          { invokeType }
        )
      } else {
        expect(usage.chargeModel).toHaveBeenCalledTimes(1)
        expect(usage.chargeModel).toHaveBeenCalledWith(
          7,
          mode === "fixed" ? "1.5" : "0.25",
          expect.objectContaining({
            invokeType,
            source: "aicreative.image_generate",
            requestId: "charge:image-31",
          })
        )
      }
    }
  })
})
