import { BadRequestException, NotFoundException, ValidationPipe } from "@nestjs/common"
import type { WalletService } from "../membership/wallet.service"
import type { PrismaService } from "../prisma/prisma.service"
import { InternalChargeDto, InternalCreditController } from "./internal-credit.controller"
import type { UsageService } from "./usage.service"

function createHarness() {
  const prisma = { user: { findUnique: jest.fn() } }
  const usage = { chargeModel: jest.fn() }
  const controller = new InternalCreditController(
    prisma as unknown as PrismaService,
    usage as unknown as UsageService,
    {} as WalletService
  )
  return { controller, prisma, usage }
}

const dto = {
  phone: "18814486260",
  costCny: "0.35",
  model: "vidflowos-llm",
  requestId: "vidflowos:test:req-001",
  meta: { biz: "copywriting" },
}

describe("InternalCreditController", () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true })

  it.each(["0.35", "1", "1.00", "0.001", "0.123456789"])("接受金额字符串 %s", async costCny => {
    const result = (await pipe.transform(
      { ...dto, costCny },
      { type: "body", metatype: InternalChargeDto }
    )) as InternalChargeDto
    expect(result.costCny).toBe(costCny)
  })

  it.each([0.35, "", "abc", "1.2.3", "1e2", "Infinity", null, undefined])(
    "拒绝非法金额 %s",
    async costCny => {
      await expect(
        pipe.transform({ ...dto, costCny }, { type: "body", metatype: InternalChargeDto })
      ).rejects.toThrow(BadRequestException)
    }
  )

  it("金额转换溢出时拒绝扣费", async () => {
    const { controller, prisma, usage } = createHarness()
    await expect(controller.charge({ ...dto, costCny: "9".repeat(309) })).rejects.toThrow(
      BadRequestException
    )
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("手机号无对应用户抛 404 USER_NOT_FOUND（对象形式 message.code）", async () => {
    const { controller, prisma } = createHarness()
    prisma.user.findUnique.mockResolvedValue(null)

    await expect(controller.charge(dto)).rejects.toThrow(NotFoundException)
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phone: "18814486260" } })
    )
  })

  it("扣费走统一内核：source=vidflowos.deduct + 透支 + requestId 幂等 + meta 附渠道", async () => {
    const { controller, prisma, usage } = createHarness()
    prisma.user.findUnique.mockResolvedValue({ id: 7 })
    usage.chargeModel.mockResolvedValue({
      costCny: 0.35,
      creditsCharged: { toString: () => "3.5" },
      balance: { toString: () => "996.5" },
      breakdown: [],
      source: "vidflowos.deduct",
      sourceLabel: "VidFlowOS 扣费",
      module: null,
      moduleLabel: null,
      model: "vidflowos-llm",
      requestId: "vidflowos:test:req-001",
      duplicate: false,
    })

    const result = await controller.charge(dto)

    expect(usage.chargeModel).toHaveBeenCalledWith(
      7,
      0.35,
      expect.objectContaining({
        source: "vidflowos.deduct",
        model: "vidflowos-llm",
        requestId: "vidflowos:test:req-001",
        allowOverdraft: true,
        meta: { biz: "copywriting", channel: "vidflowos" },
      })
    )
    expect(result).toMatchObject({
      userId: 7,
      costCny: "0.35",
      creditsCharged: "3.5",
      balance: "996.5",
      duplicate: false,
      source: "vidflowos.deduct",
    })
  })

  it("命中幂等键时透传 duplicate=true（本次未重复扣）", async () => {
    const { controller, prisma, usage } = createHarness()
    prisma.user.findUnique.mockResolvedValue({ id: 7 })
    usage.chargeModel.mockResolvedValue({
      costCny: 0.35,
      creditsCharged: { toString: () => "3.5" },
      balance: { toString: () => "996.5" },
      breakdown: [],
      source: "vidflowos.deduct",
      sourceLabel: "VidFlowOS 扣费",
      module: null,
      moduleLabel: null,
      model: "vidflowos-llm",
      requestId: "vidflowos:test:req-001",
      duplicate: true,
    })

    const result = await controller.charge(dto)
    expect(result.duplicate).toBe(true)
  })
})
