import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import {
  BillingOrder,
  BillingOrderStatus,
  BillingOrderType,
  PaymentChannel,
  Prisma,
} from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { StripeProvider } from "../common/providers/stripe.provider"
import { exportDateTimeFormatter } from "../common/utils/datetime"
import { PrismaService } from "../prisma/prisma.service"
import { AllinpayPaymentsService } from "./allinpay-payments.service"
import { BillingSettleService } from "./billing-settle.service"
import { genSerialNo, MIN_CUSTOM_RECHARGE_CNY, PAY_TIMEOUT_MS } from "./billing.constants"
import { BillingRecordsQueryDto } from "./dto/billing-records-query.dto"
import { CreateOrderDto, PayOrderDto } from "./dto/billing.dto"
import { FxService } from "./fx.service"
import { OrderPricingService } from "./order-pricing.service"

/** 订单：下单（幂等）→ 发起支付（三渠道）→ 状态轮询/主动查单。 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name)
  private readonly publishableKey: string | null

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: OrderPricingService,
    private readonly settle: BillingSettleService,
    private readonly stripe: StripeProvider,
    private readonly fx: FxService,
    config: ConfigService,
    private readonly allinpay: AllinpayPaymentsService
  ) {
    this.publishableKey = config.get<string>("STRIPE_PUBLISHABLE_KEY") || null
  }

  /**
   * 试算预览：与下单同一算价点（OrderPricingService.quote），只读不落库、无副作用。
   * 确认弹窗金额以此为准，避免「先下单再展示」取消后留下 CREATED 脏单。
   */
  async quote(userId: number, dto: CreateOrderDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true },
    })
    if (!user) throw new NotFoundException("用户不存在")
    if (!user.isActive) throw new BadRequestException("账号已被禁用，无法下单")
    const quote = await this.pricing.quote(userId, dto)
    return {
      type: dto.type,
      amountCny: Number(quote.amountCny),
      creditsTotal: quote.creditsTotal,
      expiresAt: quote.expiresAt?.toISOString() ?? null, // 本次购买后的预计到期时刻；充值类为 null
      remainingDays: quote.remainingDays ?? null, // 折算所用的剩余天数（升级/席位升级/个人转团队）；与 items 明细文案同口径，前端不要自算
      items: quote.items.map(it => ({
        name: it.name,
        detail: it.detail ?? null,
        qty: it.qty,
        amountCny: Number(it.amountCny),
        credits: it.credits,
      })),
    }
  }

  /** 展示用预估；真实支付仍按订单金额与发起支付时的汇率独立计算。 */
  async estimateUsd(amountCny: number) {
    const rate = await this.fx.getUsdCnyRate()
    return {
      amountCny,
      amountUsdCents: this.fx.cnyToUsdCents(new Decimal(amountCny), rate),
      cnyPerUsd: rate.toNumber(),
    }
  }

  private _assertStripeCustomMinimum(
    type: BillingOrderType,
    provider: string | undefined,
    amount: Decimal
  ) {
    if (
      provider !== "ALLINPAY" &&
      (type === BillingOrderType.CUSTOM || type === BillingOrderType.TEAM_CUSTOM) &&
      amount.lessThan(MIN_CUSTOM_RECHARGE_CNY)
    ) {
      throw new BadRequestException("海外支付充值最低 ¥10.00，小额测试请选择国内支付")
    }
  }

  /** 下单：后端重算金额/积分 → 建单 CREATED。idempotencyKey 防重复提交（同键返回已建订单）。 */
  async create(userId: number, dto: CreateOrderDto) {
    if (dto.provider === "ALLINPAY") this.allinpay.assertConfigured()
    if (dto.idempotencyKey) {
      const dup = await this.prisma.billingOrder.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        include: { items: true },
      })
      if (dup) {
        if (dup.userId !== userId) throw new ForbiddenException("幂等键冲突")
        if ((dup.paymentProvider ?? "STRIPE") !== (dto.provider ?? "STRIPE"))
          throw new BadRequestException("幂等键已用于其他支付服务")
        return this.view(dup)
      }
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true },
    })
    if (!user) throw new NotFoundException("用户不存在")
    if (!user.isActive) throw new BadRequestException("账号已被禁用，无法下单")

    const quote = await this.pricing.quote(userId, dto)
    this._assertStripeCustomMinimum(dto.type, dto.provider, quote.amountCny)
    // 订单号 SR+时间戳+3 位随机，唯一冲突重试
    for (let i = 0; i < 5; i++) {
      const orderNo = genSerialNo()
      try {
        const order = await this.prisma.billingOrder.create({
          data: {
            orderNo,
            userId,
            type: dto.type,
            status: BillingOrderStatus.CREATED,
            paymentProvider: dto.provider ?? "STRIPE",
            amountCny: quote.amountCny,
            creditsTotal: quote.creditsTotal,
            teamId: quote.teamId ?? null,
            packChoice: quote.packChoice ?? null,
            receiptEmail: dto.receiptEmail ?? null,
            idempotencyKey: dto.idempotencyKey ?? null,
            snapshot: quote.snapshot as unknown as Prisma.InputJsonValue,
            items: {
              create: quote.items.map(it => ({
                name: it.name,
                detail: it.detail ?? null,
                qty: it.qty,
                amountCny: it.amountCny,
                credits: it.credits,
              })),
            },
          },
          include: { items: true },
        })
        return this.view(order)
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue
        throw e
      }
    }
    throw new Error("订单号生成冲突，请重试")
  }

  /**
   * 发起支付：按渠道创建/确认 PaymentIntent。
   * - WECHAT：confirm 后取 next_action 内嵌 QR（image_data_url），15 分钟有效；
   * - ALIPAY：confirm + return_url，取收银台跳转地址；
   * - CARD：返回 clientSecret，前端 Elements 确认（3DS 自动）。
   * 同订单同渠道重复调用：复用已有 PaymentIntent（Stripe 侧幂等）。
   */
  async pay(userId: number, orderNo: string, dto: PayOrderDto) {
    const order = await this.requireOwnedOrder(userId, orderNo)
    if (order.status === BillingOrderStatus.SETTLED) throw new BadRequestException("订单已入账")
    if (
      order.status === BillingOrderStatus.EXPIRED ||
      order.status === BillingOrderStatus.CANCELLED ||
      order.status === BillingOrderStatus.ABANDONED
    ) {
      throw new BadRequestException("订单已关闭，请重新下单")
    }
    // 个人充值单（PACK/CUSTOM）支付前身份复核（2026-09-01）：下单到支付之间可能已入企业
    // （个人下单→转团队→回头付待付单），此时直接报错、不创建 PaymentIntent 不收款
    if (order.type === BillingOrderType.PACK || order.type === BillingOrderType.CUSTOM) {
      await this.pricing.assertPersonalRechargeAllowed(order.userId)
    }
    // 0 元单（个人转企业抵扣 ≥ 企业价，实付 0）：免支付直接结算，不走 Stripe；channel 传任意值均可
    if (new Decimal(order.amountCny).isZero()) {
      await this.settle.settleZeroAmountOrder(orderNo)
      return { zeroAmount: true, orderNo: order.orderNo, status: BillingOrderStatus.SETTLED }
    }
    if (dto.provider && dto.provider !== (order.paymentProvider ?? "STRIPE")) {
      throw new BadRequestException("订单支付服务已固定，不可切换")
    }
    if (order.paymentProvider === "ALLINPAY") return this.allinpay.pay(order, dto.channel)
    this._assertStripeCustomMinimum(order.type, order.paymentProvider, order.amountCny)
    if (dto.channel === PaymentChannel.ALIPAY && !dto.returnUrl) {
      throw new BadRequestException("支付宝支付缺少 returnUrl")
    }

    const client = this.stripe.client()
    // 已有同渠道 PaymentIntent → 复用（重进支付页/刷新）
    if (order.stripePaymentIntentId && order.channel === dto.channel) {
      const pi = await client.paymentIntents.retrieve(order.stripePaymentIntentId)
      return this.payPayload(order, pi)
    }

    const metadata = { orderNo: order.orderNo }
    // 新建 PaymentIntent：按发起支付时刻汇率把人民币应付折算成美元美分（快照落库 fxRate/amountUsdCents）
    const rate = await this.fx.getUsdCnyRate()
    const usdCents = this.fx.cnyToUsdCents(order.amountCny, rate)
    let pi
    if (dto.channel === PaymentChannel.WECHAT) {
      pi = await client.paymentIntents.create(
        {
          amount: usdCents,
          currency: "usd",
          payment_method_types: ["wechat_pay"],
          payment_method_data: { type: "wechat_pay" }, // confirm 必须指定支付方式，否则 Stripe 报 missing payment method
          payment_method_options: { wechat_pay: { client: "web" } },
          confirm: true,
          metadata,
        },
        { idempotencyKey: `pay-${order.orderNo}-WECHAT` }
      )
    } else if (dto.channel === PaymentChannel.ALIPAY) {
      pi = await client.paymentIntents.create(
        {
          amount: usdCents,
          currency: "usd",
          payment_method_types: ["alipay"],
          payment_method_data: { type: "alipay" }, // 同上
          confirm: true,
          return_url: dto.returnUrl!,
          metadata,
        },
        { idempotencyKey: `pay-${order.orderNo}-ALIPAY` }
      )
    } else {
      pi = await client.paymentIntents.create(
        {
          amount: usdCents,
          currency: "usd",
          payment_method_types: ["card"],
          metadata,
        },
        { idempotencyKey: `pay-${order.orderNo}-CARD` }
      )
    }

    const updated = await this.prisma.billingOrder.update({
      where: { id: order.id },
      data: {
        status: BillingOrderStatus.PENDING,
        channel: dto.channel,
        stripePaymentIntentId: pi.id,
        stripeClientSecret: dto.channel === PaymentChannel.CARD ? pi.client_secret : null,
        fxRate: rate,
        amountUsdCents: usdCents,
      },
      include: { items: true },
    })
    return this.payPayload(updated, pi)
  }

  /** 订单状态轮询/主动查单：未终态时向 Stripe 查询并同步（succeeded → 结算入账）。 */
  async query(userId: number, orderNo: string) {
    const order = await this.requireOwnedOrder(userId, orderNo, { items: true, receipt: true })
    if (order.paymentProvider === "ALLINPAY") {
      await this.allinpay.sync(order)
      return this.requireOwnedOrder(userId, orderNo, { items: true, receipt: true }).then(o =>
        this.view(o)
      )
    }
    const openStatuses: BillingOrderStatus[] = [
      BillingOrderStatus.CREATED,
      BillingOrderStatus.PENDING,
      BillingOrderStatus.PAID,
    ]
    if (order.stripePaymentIntentId && openStatuses.includes(order.status)) {
      const pi = await this.stripe.client().paymentIntents.retrieve(order.stripePaymentIntentId)
      if (pi.status === "succeeded") {
        await this.settle.settleByPaymentIntent(
          {
            id: pi.id,
            amount: pi.amount,
            currency: pi.currency,
            orderNo: pi.metadata?.orderNo ?? order.orderNo,
          },
          "query"
        )
      } else if (pi.status === "canceled") {
        await this.prisma.billingOrder.updateMany({
          where: { id: order.id, status: { not: BillingOrderStatus.SETTLED } },
          data: { status: BillingOrderStatus.CANCELLED },
        })
      }
      return this.requireOwnedOrder(userId, orderNo, { items: true, receipt: true }).then(o =>
        this.view(o)
      )
    }
    return this.view(order)
  }

  /**
   * 按 Stripe PaymentIntent ID 反查订单（只读，不向 Stripe 同步）。
   * 场景：支付回跳地址丢了 orderNo，但 payment_intent 参数必带，前端据此恢复订单后再走 query 轮询。
   */
  async lookupByPaymentIntent(userId: number, paymentIntentId: string) {
    const order = await this.prisma.billingOrder.findFirst({
      where: { userId, stripePaymentIntentId: paymentIntentId },
      include: { items: true, receipt: true },
    })
    if (!order) throw new NotFoundException("订单不存在")
    return this.view(order)
  }

  /** 充值记录（订单视角，按身份过滤一期只含本人；分页） */
  async listMine(
    userId: number,
    page: number,
    pageSize: number,
    filters: BillingRecordsQueryDto = new BillingRecordsQueryDto()
  ) {
    const where = this._recordsWhere(userId, filters)
    const [rows, total] = await Promise.all([
      this.prisma.billingOrder.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { items: true },
      }),
      this.prisma.billingOrder.count({ where }),
    ])
    return {
      items: rows.map(o => this.view(o)),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  /** 与列表共享筛选，取上限 + 1 检测超限，避免静默截断导出结果。 */
  async exportRecords(userId: number, filters: BillingRecordsQueryDto) {
    const rows = await this.prisma.billingOrder.findMany({
      where: this._recordsWhere(userId, filters),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 5001,
    })
    if (rows.length > 5000) throw new BadRequestException("导出最多支持 5000 条，请缩小筛选范围")
    const formatTime = exportDateTimeFormatter(filters.tz)
    const typeLabels: Record<BillingOrderType, string> = {
      PLAN_NEW: "套餐订阅",
      PLAN_RENEW: "套餐续费",
      PLAN_UPGRADE: "套餐升级",
      PACK: "充值包",
      CUSTOM: "自定义充值",
      TEAM_PLAN: "团队版新购",
      TEAM_RENEW: "团队版续费",
      TEAM_SEAT_UPGRADE: "团队席位升级",
      TEAM_PACK: "共享池充值包",
      TEAM_CUSTOM: "共享池自定义充值",
      PERSONAL_TO_TEAM: "个人转团队",
    }
    const channelLabels: Record<PaymentChannel, string> = {
      WECHAT: "微信支付",
      ALIPAY: "支付宝",
      CARD: "银行卡",
      ADMIN: "后台人工",
    }
    const statusLabels: Record<BillingOrderStatus, string> = {
      CREATED: "待支付",
      PENDING: "支付中",
      PAID: "支付中",
      SETTLED: "已到账",
      EXPIRED: "已过期",
      CANCELLED: "已关闭",
      ABANDONED: "已关闭",
    }
    const lines = [
      [
        "订单号",
        "类型",
        "下单时间",
        "支付区域",
        "支付方式",
        "金额（人民币元）",
        "到账积分",
        "状态",
      ],
    ]
    for (const order of rows) {
      lines.push([
        order.orderNo,
        typeLabels[order.type],
        formatTime(order.createdAt),
        order.paymentProvider === "ALLINPAY" ? "国内" : "海外",
        order.paymentProvider === "ALLINPAY" && order.channel === "CARD"
          ? "银行卡（云闪付扫码）"
          : order.channel
            ? channelLabels[order.channel]
            : "—",
        order.amountCny.toFixed(2),
        String(order.creditsTotal),
        statusLabels[order.status],
      ])
    }
    return (
      "\uFEFF" +
      lines
        .map(cells =>
          cells
            .map(value => {
              // CSV 文本不作为表格公式执行；同时处理逗号、引号及换行。
              const safeValue = /^[=+@\-\t\r\n]/.test(value) ? `'${value}` : value
              return `"${safeValue.replace(/"/g, '""')}"`
            })
            .join(",")
        )
        .join("\r\n")
    )
  }

  private _recordsWhere(
    userId: number,
    filters: BillingRecordsQueryDto
  ): Prisma.BillingOrderWhereInput {
    const start = filters.startDate ? new Date(filters.startDate) : undefined
    const end = filters.endDate ? new Date(filters.endDate) : undefined
    if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime()))) {
      throw new BadRequestException("日期格式无效")
    }
    if (start && end && start > end) throw new BadRequestException("起始日期不能晚于结束日期")
    return {
      userId,
      ...(start || end ? { createdAt: { gte: start, lte: end } } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.provider ? { paymentProvider: filters.provider } : {}),
      ...(filters.channel ? { channel: filters.channel } : {}),
    }
  }

  private async requireOwnedOrder(
    userId: number,
    orderNo: string,
    include: { items?: boolean; receipt?: boolean } = { items: true }
  ) {
    const order = await this.prisma.billingOrder.findUnique({ where: { orderNo }, include })
    if (!order || order.userId !== userId) throw new NotFoundException("订单不存在")
    return order
  }

  /** 按渠道从 PaymentIntent 提取前端所需数据 */
  private payPayload(
    order: BillingOrder,
    pi: {
      id: string
      client_secret: string | null
      next_action?: unknown
    }
  ) {
    const base = {
      orderNo: order.orderNo,
      paymentIntentId: pi.id,
      amountUsdCents: order.amountUsdCents,
      fxRate: order.fxRate == null ? null : Number(order.fxRate),
    }
    if (order.channel === PaymentChannel.WECHAT) {
      const next = pi.next_action as {
        wechat_pay_display_qr_code?: { image_data_url?: string; hosted_instructions_url?: string }
      } | null
      return {
        ...base,
        channel: order.channel,
        qrImageDataUrl: next?.wechat_pay_display_qr_code?.image_data_url ?? null,
        expiresAt: new Date(Date.now() + PAY_TIMEOUT_MS),
      }
    }
    if (order.channel === PaymentChannel.ALIPAY) {
      const next = pi.next_action as { alipay_handle_redirect?: { url?: string } } | null
      return {
        ...base,
        channel: order.channel,
        redirectUrl: next?.alipay_handle_redirect?.url ?? null,
      }
    }
    return {
      ...base,
      channel: order.channel,
      clientSecret: pi.client_secret,
      publishableKey: this.publishableKey,
    }
  }

  private view(
    order: BillingOrder & {
      items?: {
        id: number
        name: string
        detail: string | null
        qty: number
        amountCny: Decimal
        credits: number | null
      }[]
      receipt?: { receiptNo: string } | null
    }
  ) {
    return {
      orderNo: order.orderNo,
      type: order.type,
      status: order.status,
      channel: order.channel,
      provider: order.paymentProvider,
      paymentExpiresAt: order.paymentExpiresAt,
      amountCny: Number(order.amountCny), // 元（number）
      fxRate: order.fxRate != null ? Number(order.fxRate) : null, // 支付后才有值
      amountUsdCents: order.amountUsdCents,
      creditsTotal: order.creditsTotal,
      items: (order.items ?? []).map(i => ({
        name: i.name,
        detail: i.detail,
        qty: i.qty,
        amountCny: Number(i.amountCny),
        credits: i.credits,
      })),
      receiptNo: order.receipt?.receiptNo ?? null,
      paidAt: order.paidAt,
      settledAt: order.settledAt,
      createdAt: order.createdAt,
    }
  }
}
