import { BillingOrder } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { AllinpayProvider } from "../common/providers/allinpay.provider"
import { PrismaService } from "../prisma/prisma.service"
import { AllinpayPaymentsService } from "./allinpay-payments.service"
import { BillingSettleService } from "./billing-settle.service"

function setup(overrides: Partial<BillingOrder> = {}) {
  const order = {
    id: 1,
    orderNo: "SR1",
    paymentProvider: "ALLINPAY",
    amountCny: new Decimal("30"),
    status: "CREATED",
    channel: null,
    allinpayReqsn: null,
    allinpayTrxid: null,
    ...overrides,
  } as BillingOrder
  const db = {
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { status?: BillingOrder["status"] }
        data: Partial<BillingOrder>
      }) => {
        if (where.status && where.status !== order.status) return { count: 0 }
        Object.assign(order, data)
        return { count: 1 }
      }
    ),
    findUniqueOrThrow: jest.fn(async () => order),
    findMany: jest.fn(async () => [order]),
  }
  const provider = {
    assertConfigured: jest.fn(),
    pay: jest.fn().mockResolvedValue({
      reqsn: "SR1",
      trxid: "T1",
      trxstatus: "0000",
      payinfo: "https://example.com/qr",
    }),
    query: jest.fn(),
    close: jest.fn(),
    verifyFields: jest.fn(),
  }
  const settle = { settleByAllinpay: jest.fn() }
  const service = new AllinpayPaymentsService(
    { billingOrder: db } as unknown as PrismaService,
    provider as unknown as AllinpayProvider,
    settle as unknown as BillingSettleService
  )
  return { service, db, provider, settle, order }
}

it.each([
  ["WECHAT", "W01"],
  ["ALIPAY", "A01"],
  ["CARD", "U01"],
] as const)("%s 创建二维码，先绑定再请求，下单成功不入账", async (channel, paytype) => {
  const { service, provider, db, settle, order } = setup()
  const result = await service.pay(order, channel)
  expect(provider.pay).toHaveBeenCalledWith("SR1", 3000, paytype)
  expect(db.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
    provider.pay.mock.invocationCallOrder[0]
  )
  expect(result.qrImageDataUrl).toMatch(/^data:image\/png;base64,/)
  expect(settle.settleByAllinpay).not.toHaveBeenCalled()
})

it("并发抢占失败不向通联下第二笔单", async () => {
  const { service, provider, db, order } = setup()
  db.updateMany.mockResolvedValueOnce({ count: 0 })
  await expect(service.pay(order, "WECHAT")).rejects.toThrow("处理中")
  expect(provider.pay).not.toHaveBeenCalled()
})

it("结果未知的重试只查询原订单；不得重新下单", async () => {
  const { service, provider, order } = setup({
    channel: "WECHAT",
    status: "PENDING",
    allinpayReqsn: "SR1",
    paymentExpiresAt: new Date(Date.now() + 900000),
  })
  provider.query.mockResolvedValue({ trxstatus: "1001" })
  await expect(service.pay(order, "WECHAT")).rejects.toThrow("勿重复付款")
  expect(provider.pay).not.toHaveBeenCalled()
})

it("已有二维码重试不延长有效期，不重新向通联下单", async () => {
  const expiresAt = new Date(Date.now() + 60000)
  const { service, provider, order } = setup({
    channel: "CARD",
    status: "PENDING",
    allinpayReqsn: "SR1",
    allinpayTrxid: "T1",
    allinpayQrCode: "qr:test",
    paymentExpiresAt: expiresAt,
  })
  provider.query.mockResolvedValue({ reqsn: "SR1", trxid: "T1", trxstatus: "2000" })
  expect((await service.pay(order, "CARD")).expiresAt).toEqual(expiresAt)
  await expect(service.pay(order, "ALIPAY")).rejects.toThrow("绑定")
  expect(provider.pay).not.toHaveBeenCalled()
})

it("到期先查后关，关单成功不能发积分", async () => {
  const { service, provider, settle, order } = setup({
    status: "PENDING",
    allinpayReqsn: "SR1",
    paymentExpiresAt: new Date(Date.now() - 1000),
  })
  provider.query.mockResolvedValue({ reqsn: "SR1", trxid: "T1", trxstatus: "2000" })
  provider.close.mockResolvedValue({ trxstatus: "0000" })
  await service.sync(order)
  expect(provider.query.mock.invocationCallOrder[0]).toBeLessThan(
    provider.close.mock.invocationCallOrder[0]
  )
  expect(order.status).toBe("EXPIRED")
  expect(settle.settleByAllinpay).not.toHaveBeenCalled()
})

it("到期查到已支付则结算；查单异常不置过期", async () => {
  const { service, provider, settle, order } = setup({
    status: "PENDING",
    allinpayReqsn: "SR1",
    paymentExpiresAt: new Date(Date.now() - 1000),
  })
  const paid = { reqsn: "SR1", trxid: "T1", trxstatus: "0000" }
  provider.query.mockResolvedValue(paid)
  await service.sync(order)
  expect(settle.settleByAllinpay).toHaveBeenCalledWith(paid, "query")
  expect(provider.close).not.toHaveBeenCalled()
  provider.query.mockRejectedValue(new Error("network"))
  await expect(service.sync(order)).rejects.toThrow("network")
  expect(order.status).toBe("PENDING")
})

it.each([
  ["3045", "超时未支付"],
  ["3045", "交易未支付"],
  ["3045", "其他失败原因"],
  ["3050", "交易已被撤销"],
  ["3088", "交易未支付"],
  ["3099", "渠道商户错误"],
  ["3999", "其他错误"],
])("查单确认交易失败 %s/%s 后结束订单，不再关单、不发积分", async (trxstatus, errmsg) => {
  const { service, provider, settle, db, order } = setup({
    status: "PENDING",
    allinpayReqsn: "SR1",
    allinpayTrxid: "T1",
    paymentExpiresAt: new Date(Date.now() - 3 * 86400000),
  })
  provider.query.mockResolvedValue({ reqsn: "SR1", trxid: "T1", trxstatus, errmsg })
  provider.close.mockRejectedValue(new Error("已失败的交易无法重复关闭"))
  await service.sync(order)
  expect(order.status).toBe("EXPIRED")
  expect(order.expiredAt).toBeInstanceOf(Date)
  expect(db.updateMany).toHaveBeenCalledWith({
    where: { id: 1, paymentProvider: "ALLINPAY", status: "PENDING" },
    data: { status: "EXPIRED", expiredAt: expect.any(Date) },
  })
  expect(provider.close).not.toHaveBeenCalled()
  expect(settle.settleByAllinpay).not.toHaveBeenCalled()
})

it.each(["2000", "2008", "", "9999", "3045invalid"])(
  "有效期内的处理中/未知状态 %s 不误判失败",
  async trxstatus => {
    const { service, provider, db, order } = setup({
      status: "PENDING",
      allinpayReqsn: "SR1",
      allinpayTrxid: "T1",
      paymentExpiresAt: new Date(Date.now() + 60000),
    })
    provider.query.mockResolvedValue({ reqsn: "SR1", trxid: "T1", trxstatus })
    await service.sync(order)
    expect(db.updateMany).not.toHaveBeenCalled()
    expect(provider.close).not.toHaveBeenCalled()
  }
)

it.each([
  { reqsn: "OTHER", trxid: "T1" },
  { reqsn: "SR1", trxid: "OTHER" },
  { reqsn: "SR1", trxid: "" },
])("失败返回的订单绑定不一致时不关本单 %j", async binding => {
  const { service, provider, db, order } = setup({
    status: "PENDING",
    allinpayReqsn: "SR1",
    allinpayTrxid: "T1",
    paymentExpiresAt: new Date(Date.now() - 1000),
  })
  provider.query.mockResolvedValue({ ...binding, trxstatus: "3045" })
  await expect(service.sync(order)).rejects.toThrow("不匹配")
  expect(db.updateMany).not.toHaveBeenCalled()
  expect(provider.close).not.toHaveBeenCalled()
})

it("超时但仍处理中，关单请求失败时保留待核实状态", async () => {
  const { service, provider, db, order } = setup({
    status: "PENDING",
    allinpayReqsn: "SR1",
    allinpayTrxid: "T1",
    paymentExpiresAt: new Date(Date.now() - 1000),
  })
  provider.query.mockResolvedValue({ reqsn: "SR1", trxid: "T1", trxstatus: "2000" })
  provider.close.mockRejectedValue(new Error("network"))
  await expect(service.sync(order)).rejects.toThrow("network")
  expect(db.updateMany).not.toHaveBeenCalled()
  expect(order.status).toBe("PENDING")
})

it("查单期间成功回调已入账，失败结果不能覆盖 SETTLED", async () => {
  const { service, provider, order } = setup({
    status: "PENDING",
    allinpayReqsn: "SR1",
    allinpayTrxid: "T1",
  })
  provider.query.mockImplementation(async () => {
    order.status = "SETTLED"
    return { reqsn: "SR1", trxid: "T1", trxstatus: "3045" }
  })
  await service.sync(order)
  expect(order.status).toBe("SETTLED")
  expect(order.expiredAt).toBeUndefined()
})

it("定时补查能自动收尾遗留 3045 订单，重复执行不重复更新终态", async () => {
  const { service, provider, db, order } = setup({
    status: "PENDING",
    allinpayReqsn: "SR1",
    allinpayTrxid: "T1",
    paymentExpiresAt: new Date(Date.now() - 3 * 86400000),
  })
  provider.query.mockResolvedValue({
    reqsn: "SR1",
    trxid: "T1",
    trxstatus: "3045",
    errmsg: "交易未支付",
  })
  await service.reconcile()
  expect(order.status).toBe("EXPIRED")
  const expiredAt = order.expiredAt
  db.findMany.mockResolvedValueOnce([])
  await service.reconcile()
  expect(order.expiredAt).toEqual(expiredAt)
  expect(provider.query).toHaveBeenCalledTimes(1)
  expect(provider.close).not.toHaveBeenCalled()
})
