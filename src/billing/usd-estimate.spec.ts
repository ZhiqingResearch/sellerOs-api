import { ConfigService } from "@nestjs/config"
import { validate } from "class-validator"
import { FxService } from "./fx.service"
import { OrdersService } from "./orders.service"
import { UsdEstimateDto } from "./dto/usd-estimate.dto"

describe("美元付款预估", () => {
  const createOrder = jest.fn()
  const createPayment = jest.fn()
  const getCnyUsdBaseRate = jest.fn()
  let orders: OrdersService

  beforeEach(() => {
    jest.clearAllMocks()
    getCnyUsdBaseRate.mockResolvedValue(0.14)
    const fx = new FxService({ getCnyUsdBaseRate } as never)
    orders = new OrdersService(
      { billingOrder: { create: createOrder } } as never,
      {} as never, {} as never, { createPaymentIntent: createPayment } as never,
      fx, new ConfigService(), {} as never
    )
  })

  it("复用收款汇率与美分舍入，只试算不建单或发起付款", async () => {
    expect(await orders.estimateUsd(399)).toEqual({
      amountCny: 399, amountUsdCents: 5586, cnyPerUsd: expect.closeTo(1 / 0.14),
    })
    expect((await orders.estimateUsd(10.05)).amountUsdCents).toBe(141)
    expect(getCnyUsdBaseRate).toHaveBeenCalledTimes(1)
    expect(createOrder).not.toHaveBeenCalled()
    expect(createPayment).not.toHaveBeenCalled()
  })

  it("未达到海外最低付款金额时沿用支付校验", async () => {
    await expect(orders.estimateUsd(0.1)).rejects.toThrow("最低限额")
  })

  it("汇率不可用时返回错误，不虚构美元金额", async () => {
    getCnyUsdBaseRate.mockRejectedValue(new Error("unavailable"))
    await expect(orders.estimateUsd(399)).rejects.toThrow("汇率服务暂不可用")
  })

  it.each([-1, 0, 1.001, Infinity, "399", 100000000])("拒绝非法金额 %s", async (amountCny) => {
    expect((await validate(Object.assign(new UsdEstimateDto(), { amountCny }))).length).toBeGreaterThan(0)
  })
})
