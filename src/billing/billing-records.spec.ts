import { BadRequestException, ValidationPipe } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import { Decimal } from "@prisma/client/runtime/library"
import { StripeProvider } from "../common/providers/stripe.provider"
import { PrismaService } from "../prisma/prisma.service"
import { AllinpayPaymentsService } from "./allinpay-payments.service"
import { BillingSettleService } from "./billing-settle.service"
import { BillingRecordsQueryDto } from "./dto/billing-records-query.dto"
import { FxService } from "./fx.service"
import { OrderPricingService } from "./order-pricing.service"
import { OrdersService } from "./orders.service"

describe("支付记录筛选与导出", () => {
  let service: OrdersService
  const prisma = { billingOrder: { findMany: jest.fn(), count: jest.fn() } }
  const filters: BillingRecordsQueryDto = {
    page: 2,
    pageSize: 10,
    type: "PACK",
    provider: "ALLINPAY",
    channel: "CARD",
    startDate: "2026-10-14T16:00:00.000Z",
    endDate: "2026-10-15T15:59:59.999Z",
  }
  beforeEach(async () => {
    jest.resetAllMocks()
    prisma.billingOrder.findMany.mockResolvedValue([])
    prisma.billingOrder.count.mockResolvedValue(23)
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => null } },
        ...[
          OrderPricingService,
          BillingSettleService,
          StripeProvider,
          FxService,
          AllinpayPaymentsService,
        ].map(provide => ({ provide, useValue: {} })),
      ],
    }).compile()
    service = moduleRef.get(OrdersService)
  })

  it("筛选在数据库分页前执行，列表和总数都限定本人及全部条件", async () => {
    const result = await service.listMine(42, 2, 10, filters)
    const where = {
      userId: 42,
      type: "PACK",
      paymentProvider: "ALLINPAY",
      channel: "CARD",
      createdAt: { gte: new Date(filters.startDate!), lte: new Date(filters.endDate!) },
    }
    expect(prisma.billingOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where, skip: 10, take: 10 })
    )
    expect(prisma.billingOrder.count).toHaveBeenCalledWith({ where })
    expect(result).toMatchObject({ total: 23, page: 2, totalPages: 3 })
  })

  it("不带筛选仍只返回本人记录", async () => {
    await service.listMine(42, 1, 10)
    expect(prisma.billingOrder.count).toHaveBeenCalledWith({ where: { userId: 42 } })
  })

  it("拒绝倒置日期，未查询数据库", async () => {
    await expect(
      service.listMine(42, 1, 10, {
        ...filters,
        startDate: filters.endDate,
        endDate: filters.startDate,
      })
    ).rejects.toThrow("起始日期不能晚于结束日期")
    expect(prisma.billingOrder.findMany).not.toHaveBeenCalled()
  })

  it("导出复用筛选，忽略分页并显示国内云闪付、中文类型及北京时间", async () => {
    prisma.billingOrder.findMany.mockResolvedValue([
      {
        orderNo: '=HYPERLINK("x")',
        type: "PACK",
        status: "SETTLED",
        paymentProvider: "ALLINPAY",
        channel: "CARD",
        amountCny: new Decimal("0.1"),
        creditsTotal: 1,
        createdAt: new Date("2026-10-14T16:30:00Z"),
      },
    ])
    const csv = await service.exportRecords(42, filters)
    const args = prisma.billingOrder.findMany.mock.calls[0][0]
    expect(args.where).toMatchObject({
      userId: 42,
      type: "PACK",
      paymentProvider: "ALLINPAY",
      channel: "CARD",
    })
    expect(args.skip).toBeUndefined()
    expect(args.take).toBe(5001)
    expect(csv.startsWith("\uFEFF")).toBe(true)
    expect(csv).toContain("2026-10-15 00:30:00")
    expect(csv).toContain('"国内","银行卡（云闪付扫码）","0.10","1","已到账"')
    expect(csv).toContain('"\'=HYPERLINK(""x"")"')
  })

  it("超过上限明确报错，不悄悄丢失记录", async () => {
    prisma.billingOrder.findMany.mockResolvedValue(Array(5001).fill({}))
    await expect(service.exportRecords(42, filters)).rejects.toThrow("请缩小筛选范围")
  })

  it("查询 DTO 经全局白名单后保留筛选且转换分页", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true })
    const result = await pipe.transform(
      { ...filters, page: "2", userId: 999 },
      { type: "query", metatype: BillingRecordsQueryDto }
    )
    expect(result).toMatchObject(filters)
    expect(result.userId).toBeUndefined()
    for (const invalid of [
      { provider: "OTHER" },
      { channel: "ANY" },
      { type: "ANY" },
      { startDate: "2026-02-31T00:00:00Z" },
      { startDate: "2026-10-15" },
    ]) {
      await expect(
        pipe.transform(invalid, { type: "query", metatype: BillingRecordsQueryDto })
      ).rejects.toBeInstanceOf(BadRequestException)
    }
  })
})
