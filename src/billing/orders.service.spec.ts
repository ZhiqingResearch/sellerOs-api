import { BadRequestException, NotFoundException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import { BillingOrderType } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { StripeProvider } from "../common/providers/stripe.provider"
import { PrismaService } from "../prisma/prisma.service"
import { AllinpayPaymentsService } from "./allinpay-payments.service"
import { BillingSettleService } from "./billing-settle.service"
import { CreateOrderDto } from "./dto/billing.dto"
import { FxService } from "./fx.service"
import { OrderPricingService } from "./order-pricing.service"
import { OrdersService } from "./orders.service"

const dto: CreateOrderDto = {
  type: BillingOrderType.PLAN_NEW,
  targetTier: 2,
} as CreateOrderDto

const pricingQuote = {
  amountCny: new Decimal("399"),
  creditsTotal: 4600,
  items: [
    {
      name: "Plus 会员套餐（30 天）",
      detail: "套餐 4000 + 赠送 600（均 30 天有效）",
      qty: 1,
      amountCny: new Decimal("399"),
      credits: 4600,
    },
  ],
  snapshot: { kind: "plan" },
}

describe("OrdersService.quote（试算预览）", () => {
  let service: OrdersService
  let prisma: {
    user: { findUnique: jest.Mock }
    billingOrder: { findUnique: jest.Mock; create: jest.Mock }
  }
  let pricing: { quote: jest.Mock }

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ isActive: true }) },
      billingOrder: { findUnique: jest.fn(), create: jest.fn() },
    }
    pricing = { quote: jest.fn().mockResolvedValue(pricingQuote) }
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: AllinpayPaymentsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: OrderPricingService, useValue: pricing },
        { provide: BillingSettleService, useValue: {} },
        { provide: StripeProvider, useValue: {} },
        { provide: FxService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => null } },
      ],
    }).compile()
    service = moduleRef.get(OrdersService)
  })

  it("返回后端算价结果（金额 number 化），不落库", async () => {
    const r = await service.quote(1, dto)
    expect(pricing.quote).toHaveBeenCalledWith(1, dto)
    expect(r).toEqual({
      type: "PLAN_NEW",
      amountCny: 399,
      creditsTotal: 4600,
      expiresAt: null, // mock 报价未带到期时刻 → null（套餐类真实报价有值）
      remainingDays: null, // mock 报价未带折算天数 → null（升级/席位升级/个人转团队真实报价有值）
      items: [
        {
          name: "Plus 会员套餐（30 天）",
          detail: "套餐 4000 + 赠送 600（均 30 天有效）",
          qty: 1,
          amountCny: 399,
          credits: 4600,
        },
      ],
    })
    expect(prisma.billingOrder.create).not.toHaveBeenCalled()
  })

  it.each([BillingOrderType.CUSTOM, BillingOrderType.TEAM_CUSTOM])("%s：海外小额充值在建单前拒绝", async type => {
    pricing.quote.mockResolvedValue({ ...pricingQuote, amountCny: new Decimal("0.1") })
    await expect(service.create(1, { type, amountCny: "0.10" })).rejects.toThrow("小额测试请选择国内支付")
    expect(prisma.billingOrder.create).not.toHaveBeenCalled()
  })

  it("用户不存在 → 404", async () => {
    prisma.user.findUnique.mockResolvedValue(null)
    await expect(service.quote(1, dto)).rejects.toBeInstanceOf(NotFoundException)
  })

  it("账号被禁用 → 400", async () => {
    prisma.user.findUnique.mockResolvedValue({ isActive: false })
    await expect(service.quote(1, dto)).rejects.toBeInstanceOf(BadRequestException)
  })

  it("算价层报错原样透传（如已有有效套餐）", async () => {
    pricing.quote.mockRejectedValue(new BadRequestException("当前已有有效套餐，请使用续费或升级"))
    await expect(service.quote(1, dto)).rejects.toThrow("当前已有有效套餐")
  })
})

describe("OrdersService.pay（发起支付）", () => {
  const order = {
    id: 1,
    orderNo: "SR1",
    userId: 1,
    type: BillingOrderType.PACK,
    status: "CREATED",
    channel: null,
    stripePaymentIntentId: null,
    amountCny: new Decimal("199"),
    creditsTotal: 300,
    items: [],
    createdAt: new Date(),
  }

  let service: OrdersService
  let create: jest.Mock
  let update: jest.Mock
  let settleZero: jest.Mock
  let assertPersonalRecharge: jest.Mock
  let prisma: { billingOrder: { findUnique: jest.Mock } }

  beforeEach(async () => {
    create = jest.fn()
    settleZero = jest.fn().mockResolvedValue({ settled: true })
    assertPersonalRecharge = jest.fn().mockResolvedValue(undefined) // 默认纯个人（放行）
    update = jest
      .fn()
      .mockImplementation(({ data }) => Promise.resolve({ ...order, ...data, items: [] }))
    prisma = {
      billingOrder: {
        findUnique: jest.fn().mockResolvedValue({ ...order, items: [] }),
      },
    }
    const prismaMock = {
      user: { findUnique: jest.fn() },
      billingOrder: {
        ...prisma.billingOrder,
        create: jest.fn(),
        update,
      },
    }
    const stripe = { client: () => ({ paymentIntents: { create, retrieve: jest.fn() } }) }
    const fx = {
      getUsdCnyRate: jest.fn().mockResolvedValue(new Decimal("7.2")),
      cnyToUsdCents: jest.fn().mockReturnValue(2764),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: AllinpayPaymentsService, useValue: {} },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: OrderPricingService,
          useValue: { assertPersonalRechargeAllowed: assertPersonalRecharge },
        },
        { provide: BillingSettleService, useValue: { settleZeroAmountOrder: settleZero } },
        { provide: StripeProvider, useValue: stripe },
        { provide: FxService, useValue: fx },
        { provide: ConfigService, useValue: { get: () => "pk_test_x" } },
      ],
    }).compile()
    service = moduleRef.get(OrdersService)
  })

  it("0 元单（个人转企业抵扣 ≥ 企业价）：免支付直接结算，不调 Stripe", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue({
      ...order,
      amountCny: new Decimal("0"),
      items: [],
    })
    const r = (await service.pay(1, "SR1", { channel: "WECHAT" } as never)) as {
      zeroAmount: boolean
      status: string
    }
    expect(settleZero).toHaveBeenCalledWith("SR1")
    expect(r.zeroAmount).toBe(true)
    expect(r.status).toBe("SETTLED")
    expect(create).not.toHaveBeenCalled() // 未创建 PaymentIntent
  })

  it("微信：confirm 必须带 payment_method_data=wechat_pay，返回二维码", async () => {
    create.mockResolvedValue({
      id: "pi_1",
      client_secret: "sec",
      next_action: { wechat_pay_display_qr_code: { image_data_url: "data:image/png;base64,xx" } },
    })
    const r = await service.pay(1, "SR1", { channel: "WECHAT" } as never)
    const params = (create.mock.calls as unknown[][])[0][0] as Record<string, unknown>
    expect(params.payment_method_types).toEqual(["wechat_pay"])
    expect(params.payment_method_data).toEqual({ type: "wechat_pay" })
    expect(params.confirm).toBe(true)
    expect(params.amount).toBe(2764)
    expect(params.currency).toBe("usd")
    expect(r).toMatchObject({ amountUsdCents: 2764, fxRate: 7.2 })
    expect((r as { qrImageDataUrl: string }).qrImageDataUrl).toBe("data:image/png;base64,xx")
  })

  it("支付宝：带 payment_method_data=alipay + return_url，返回跳转地址", async () => {
    create.mockResolvedValue({
      id: "pi_2",
      client_secret: "sec",
      next_action: { alipay_handle_redirect: { url: "https://stripe.com/redirect" } },
    })
    const r = await service.pay(1, "SR1", {
      channel: "ALIPAY",
      returnUrl: "https://our.site/pay/result",
    } as never)
    const params = (create.mock.calls as unknown[][])[0][0] as Record<string, unknown>
    expect(params.payment_method_types).toEqual(["alipay"])
    expect(params.payment_method_data).toEqual({ type: "alipay" })
    expect(params.return_url).toBe("https://our.site/pay/result")
    expect((r as { redirectUrl: string }).redirectUrl).toBe("https://stripe.com/redirect")
  })

  it("支付宝缺 returnUrl → 400，不调 Stripe", async () => {
    await expect(service.pay(1, "SR1", { channel: "ALIPAY" } as never)).rejects.toThrow(
      "支付宝支付缺少 returnUrl"
    )
    expect(create).not.toHaveBeenCalled()
  })

  it("银行卡：不 confirm、不带 payment_method_data，返回 clientSecret + publishableKey", async () => {
    create.mockResolvedValue({ id: "pi_3", client_secret: "sec_card" })
    const r = await service.pay(1, "SR1", { channel: "CARD" } as never)
    const params = (create.mock.calls as unknown[][])[0][0] as Record<string, unknown>
    expect(params.payment_method_types).toEqual(["card"])
    expect(params.payment_method_data).toBeUndefined()
    expect(params.confirm).toBeUndefined()
    expect(r).toMatchObject({ clientSecret: "sec_card", publishableKey: "pk_test_x" })
  })

  it("个人充值单支付前身份复核（2026-09-01）：PACK/CUSTOM 调守卫，已入企业 → 400 不创建 PaymentIntent", async () => {
    assertPersonalRecharge.mockRejectedValue(
      new BadRequestException(
        "你已归属企业团队，不可购买个人充值；如需积分请联系企业管理员充值企业共享池"
      )
    )
    await expect(service.pay(1, "SR1", { channel: "WECHAT" } as never)).rejects.toThrow(
      "你已归属企业团队"
    )
    expect(assertPersonalRecharge).toHaveBeenCalledWith(1) // order.userId
    expect(create).not.toHaveBeenCalled() // 未创建 PaymentIntent，不收款
  })

  it("非个人充值单（PLAN_NEW 等）不触发该复核", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue({
      ...order,
      type: BillingOrderType.PLAN_NEW,
      items: [],
    })
    create.mockResolvedValue({ id: "pi_9", client_secret: "s" })
    await service.pay(1, "SR1", { channel: "CARD" } as never)
    expect(assertPersonalRecharge).not.toHaveBeenCalled()
  })
})

describe("OrdersService.lookupByPaymentIntent（回跳丢 orderNo 反查）", () => {
  const order = {
    id: 1,
    orderNo: "SR9",
    userId: 1,
    type: BillingOrderType.PACK,
    status: "PENDING",
    channel: "ALIPAY",
    stripePaymentIntentId: "pi_abc",
    amountCny: new Decimal("30"),
    fxRate: null,
    amountUsdCents: null,
    creditsTotal: 300,
    items: [],
    receipt: null,
    paidAt: null,
    settledAt: null,
    createdAt: new Date("2026-08-26T00:00:00Z"),
  }

  let service: OrdersService
  let findFirst: jest.Mock

  beforeEach(async () => {
    findFirst = jest.fn().mockResolvedValue({ ...order })
    const prisma = { billingOrder: { findFirst } }
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: AllinpayPaymentsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: OrderPricingService, useValue: {} },
        { provide: BillingSettleService, useValue: {} },
        { provide: StripeProvider, useValue: {} },
        { provide: FxService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => null } },
      ],
    }).compile()
    service = moduleRef.get(OrdersService)
  })

  it("按 pi + userId 反查并返回订单视图", async () => {
    const r = await service.lookupByPaymentIntent(1, "pi_abc")
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: 1, stripePaymentIntentId: "pi_abc" },
      include: { items: true, receipt: true },
    })
    expect(r).toMatchObject({ orderNo: "SR9", status: "PENDING", channel: "ALIPAY" })
  })

  it("查不到（含别人的单）→ 404", async () => {
    findFirst.mockResolvedValue(null)
    await expect(service.lookupByPaymentIntent(1, "pi_abc")).rejects.toBeInstanceOf(
      NotFoundException
    )
  })
})
