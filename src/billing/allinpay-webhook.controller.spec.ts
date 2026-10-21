import { ValidationPipe } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { NestExpressApplication } from "@nestjs/platform-express"
import { Test } from "@nestjs/testing"
import { BillingOrderStatus, PaymentChannel } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { generateKeyPairSync, sign } from "node:crypto"
import request from "supertest"
import { App } from "supertest/types"
import { AllinpayProvider } from "../common/providers/allinpay.provider"
import { CreditService } from "../membership/credit.service"
import { PrismaService } from "../prisma/prisma.service"
import { TeamPoolService } from "../team/team-pool.service"
import { TeamService } from "../team/team.service"
import { AllinpayPaymentsService } from "./allinpay-payments.service"
import { AllinpayWebhookController } from "./allinpay-webhook.controller"
import { BillingMailService } from "./billing-mail.service"
import { BillingSettleService } from "./billing-settle.service"
import { ReceiptsService } from "./receipts.service"

// 隔离模拟：不导入 AppModule、不读取 .env、不连接数据库、不请求通联。
// HTTP 控制器、验签及结算使用实际实现；积分持久化/事务/邮件使用内存替身。
const merchantKeys = generateKeyPairSync("rsa", { modulusLength: 2048 })
const gatewayKeys = generateKeyPairSync("rsa", { modulusLength: 2048 })
const CALLBACK_PATH = "/api/billing/webhooks/allinpay"

function createOrder() {
  return {
    id: 1,
    orderNo: "SIMULATED_ORDER_1",
    userId: 7,
    type: "PACK",
    status: BillingOrderStatus.PENDING as BillingOrderStatus,
    channel: PaymentChannel.WECHAT as PaymentChannel,
    paymentProvider: "ALLINPAY",
    allinpayReqsn: "SIMULATED_ORDER_1",
    allinpayTrxid: "SIMULATED_TRADE_1" as string | null,
    amountCny: new Decimal(100),
    snapshot: { packId: 2, baseCredits: 1000, bonusCredits: 100 },
    paidAt: null as Date | null,
    settledAt: null as Date | null,
  }
}

function signNotification(overrides: Record<string, string> = {}, isWrongSigner = false) {
  const fields = {
    cusid: "SIMULATED_MERCHANT",
    appid: "SIMULATED_APP",
    cusorderid: "SIMULATED_ORDER_1",
    trxid: "SIMULATED_TRADE_1",
    trxstatus: "0000",
    trxcode: "VSP501",
    initamt: "10000",
    trxamt: "10000",
    signtype: "RSA",
    // 验证 form 编码和未知字段不会被全局 whitelist 丢弃。
    futureField: "模拟回调 + & 中文",
    ...overrides,
  }
  const content = Object.entries(fields)
    .filter(([, value]) => value !== "")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&")
  return {
    ...fields,
    sign: sign(
      "RSA-SHA1",
      Buffer.from(content),
      isWrongSigner ? merchantKeys.privateKey : gatewayKeys.privateKey
    ).toString("base64"),
  }
}

type TestOrder = ReturnType<typeof createOrder>
type OrderWhere = {
  id?: number
  allinpayReqsn?: string
  status?: { in?: BillingOrderStatus[]; notIn?: BillingOrderStatus[] }
  OR?: { allinpayTrxid: string | null }[]
}
type CreditLot = { bucket: string; amount: number; expiresAt: Date | null }

describe("通联回调 HTTP 隔离模拟", () => {
  let app: NestExpressApplication
  let order: TestOrder
  let lots: CreditLot[]
  let recordRecharge: jest.Mock
  let issueReceipt: jest.Mock
  let sendAlert: jest.Mock
  let findOccupiedTeamId: jest.Mock
  let fetchMock: jest.SpyInstance

  function matchesOrder(where: OrderWhere) {
    return (
      (where.id === undefined || where.id === order.id) &&
      (where.allinpayReqsn === undefined || where.allinpayReqsn === order.allinpayReqsn) &&
      (!where.status?.in || where.status.in.includes(order.status)) &&
      (!where.status?.notIn || !where.status.notIn.includes(order.status)) &&
      (!where.OR || where.OR.some(binding => binding.allinpayTrxid === order.allinpayTrxid))
    )
  }

  function postNotification(fields = signNotification()) {
    return request(app.getHttpServer() as App)
      .post(CALLBACK_PATH)
      .type("form")
      .send(fields)
  }

  beforeEach(async () => {
    order = createOrder()
    lots = []
    fetchMock = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("模拟禁止外部请求"))
    recordRecharge = jest.fn((_userId: number, input: { lots: CreditLot[] }) => {
      lots.push(...input.lots)
      return Promise.resolve()
    })
    issueReceipt = jest.fn().mockResolvedValue({})
    sendAlert = jest.fn().mockResolvedValue(undefined)
    findOccupiedTeamId = jest.fn().mockResolvedValue(null)
    const billingOrder = {
      findUnique: jest.fn(({ where }: { where: OrderWhere }) =>
        Promise.resolve(matchesOrder(where) ? { ...order } : null)
      ),
      updateMany: jest.fn(({ where, data }: { where: OrderWhere; data: Partial<TestOrder> }) => {
        if (!matchesOrder(where)) return Promise.resolve({ count: 0 })
        Object.assign(order, data)
        return Promise.resolve({ count: 1 })
      }),
      update: jest.fn(({ data }: { data: Partial<TestOrder> }) => {
        Object.assign(order, data)
        return Promise.resolve({ ...order })
      }),
    }
    const prisma = {
      billingOrder,
      $transaction: async (
        callback: (tx: { billingOrder: typeof billingOrder }) => Promise<unknown>
      ) => {
        const previousOrder = { ...order }
        const previousLots = [...lots]
        try {
          return await callback({ billingOrder })
        } catch (error) {
          order = previousOrder
          lots = previousLots
          throw error
        }
      },
    }
    const provider = new AllinpayProvider(
      new ConfigService({
        ALLINPAY_ENABLED: "true",
        ALLINPAY_CUSID: "SIMULATED_MERCHANT",
        ALLINPAY_APPID: "SIMULATED_APP",
        ALLINPAY_API_ORIGIN: "https://gateway.invalid",
        ALLINPAY_NOTIFY_URL: `https://callback.invalid${CALLBACK_PATH}`,
        ALLINPAY_PAYEE: "隔离测试商户",
        ALLINPAY_PRIVATE_KEY: merchantKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
        ALLINPAY_PUBLIC_KEY: gatewayKeys.publicKey.export({ type: "spki", format: "pem" }),
      })
    )
    provider.assertConfigured()
    const settle = new BillingSettleService(
      prisma as unknown as PrismaService,
      { recordRecharge } as unknown as CreditService,
      { issueForOrder: issueReceipt } as unknown as ReceiptsService,
      { sendAlert } as unknown as BillingMailService,
      { findOccupiedTeamId } as unknown as TeamService,
      {} as TeamPoolService
    )
    const payments = new AllinpayPaymentsService(
      prisma as unknown as PrismaService,
      provider,
      settle
    )
    const moduleRef = await Test.createTestingModule({
      controllers: [AllinpayWebhookController],
      providers: [{ provide: AllinpayPaymentsService, useValue: payments }],
    }).compile()
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false })
    app.setGlobalPrefix("api")
    app.useBodyParser("urlencoded", { extended: true })
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.init()
  })

  afterEach(async () => {
    try {
      if (app) await app.close()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      jest.restoreAllMocks()
    }
  })

  it.each([
    [PaymentChannel.WECHAT, "VSP501"],
    [PaymentChannel.ALIPAY, "VSP511"],
    [PaymentChannel.CARD, "VSP551"],
  ])(
    "%s 成功通知：验签、核对、入账并返回纯文本 success；重发不重复入账",
    async (channel, trxcode) => {
      order.channel = channel
      const fields = signNotification({ trxcode })
      await postNotification(fields)
        .expect(200)
        .expect("Content-Type", /text\/plain/)
        .expect("success")
      expect(order.status).toBe(BillingOrderStatus.SETTLED)
      expect(lots).toEqual([
        { bucket: "RECHARGE", amount: 1000, expiresAt: null },
        { bucket: "GIFT", amount: 100, expiresAt: expect.any(Date) as Date },
      ])
      expect(recordRecharge).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ sourceRef: "SIMULATED_ORDER_1" }),
        expect.anything()
      )
      await postNotification(fields).expect(200).expect("success")
      expect(recordRecharge).toHaveBeenCalledTimes(1)
      expect(issueReceipt).toHaveBeenCalledTimes(1)
    }
  )

  it("错误签名和签名后篡改金额均返回 400，不改变订单和积分", async () => {
    await postNotification(signNotification({}, true)).expect(400)
    await postNotification({ ...signNotification(), trxamt: "1" }).expect(400)
    expect(order.status).toBe(BillingOrderStatus.PENDING)
    expect(recordRecharge).not.toHaveBeenCalled()
  })

  it.each([
    { cusid: "OTHER_MERCHANT" },
    { appid: "OTHER_APP" },
    { trxid: "OTHER_TRADE" },
    { trxcode: "VSP551" },
  ])("有效签名但商户或交易绑定不符 %j：拒绝入账", async fields => {
    await postNotification(signNotification(fields)).expect(400)
    expect(order.status).toBe(BillingOrderStatus.PENDING)
    expect(recordRecharge).not.toHaveBeenCalled()
  })

  it("不存在的订单返回 404，不创建订单或积分", async () => {
    await postNotification(signNotification({ cusorderid: "UNKNOWN_ORDER" })).expect(404)
    expect(recordRecharge).not.toHaveBeenCalled()
  })

  it("有效签名但金额不符：转人工、告警，不入账", async () => {
    await postNotification(signNotification({ trxamt: "9999" }))
      .expect(200)
      .expect("success")
    expect(order.status).toBe(BillingOrderStatus.ABANDONED)
    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(recordRecharge).not.toHaveBeenCalled()
  })

  it.each([{ trxstatus: "2000" }, { trxcode: "VSP503" }])(
    "非支付成功通知 %j 不入账",
    async fields => {
      await postNotification(signNotification(fields)).expect(200).expect("success")
      expect(order.status).toBe(BillingOrderStatus.PENDING)
      expect(recordRecharge).not.toHaveBeenCalled()
    }
  )

  it("回调早于下单响应时绑定流水；EXPIRED 订单收到成功通知仍可入账", async () => {
    order.allinpayTrxid = null
    order.status = BillingOrderStatus.EXPIRED
    await postNotification().expect(200).expect("success")
    expect(order.allinpayTrxid).toBe("SIMULATED_TRADE_1")
    expect(order.status).toBe(BillingOrderStatus.SETTLED)
    expect(recordRecharge).toHaveBeenCalledTimes(1)
  })

  it("入账异常返回 500，模拟事务回滚；同一通知重试成功", async () => {
    recordRecharge.mockRejectedValueOnce(new Error("模拟积分持久化失败"))
    await postNotification().expect(500)
    expect(order.status).toBe(BillingOrderStatus.PENDING)
    expect(lots).toEqual([])
    expect(issueReceipt).not.toHaveBeenCalled()
    await postNotification().expect(200).expect("success")
    expect(order.status).toBe(BillingOrderStatus.SETTLED)
    expect(lots.reduce((sum, lot) => sum + lot.amount, 0)).toBe(1100)
    expect(issueReceipt).toHaveBeenCalledTimes(1)
  })

  it("下单后加入企业：回调转人工，不向个人发放积分", async () => {
    findOccupiedTeamId.mockResolvedValue(10)
    await postNotification().expect(200).expect("success")
    expect(order.status).toBe(BillingOrderStatus.ABANDONED)
    expect(recordRecharge).not.toHaveBeenCalled()
    expect(sendAlert).toHaveBeenCalledTimes(1)
  })
})
