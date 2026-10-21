import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from "@nestjs/common"
import { Cron, CronExpression } from "@nestjs/schedule"
import { BillingOrder, BillingOrderStatus, PaymentChannel } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { toDataURL } from "qrcode"
import {
  ALLINPAY_PAY_TYPES,
  AllinpayFields,
  AllinpayProvider,
} from "../common/providers/allinpay.provider"
import { PrismaService } from "../prisma/prisma.service"
import { BillingSettleService } from "./billing-settle.service"
import { PAY_TIMEOUT_MS } from "./billing.constants"

/** 一笔国内订单只能绑定一种支付方式；请求结果未知时查询原订单，不重新收费。 */
@Injectable()
export class AllinpayPaymentsService {
  private readonly logger = new Logger(AllinpayPaymentsService.name)
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: AllinpayProvider,
    private readonly settle: BillingSettleService
  ) {}

  assertConfigured() {
    this.provider.assertConfigured()
  }

  async pay(order: BillingOrder, channel: PaymentChannel) {
    this.provider.assertConfigured()
    if (channel === PaymentChannel.ADMIN) throw new BadRequestException("不支持的支付方式")
    if (order.channel && order.channel !== channel)
      throw new ConflictException("该订单已绑定支付方式，请先完成原订单")
    if (order.allinpayReqsn) {
      await this.sync(order)
      const latest = await this.prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } })
      if (latest.status !== BillingOrderStatus.PENDING)
        throw new ConflictException("订单状态已更新，请查询支付结果")
      return this._payload(latest)
    }
    const expiresAt = new Date(Date.now() + PAY_TIMEOUT_MS)
    // 在外部请求之前持久化商户订单号。并发只有一个请求能发起下单，回调抢先到也可以找到绑定。
    const claim = await this.prisma.billingOrder.updateMany({
      where: {
        id: order.id,
        paymentProvider: "ALLINPAY",
        status: BillingOrderStatus.CREATED,
        allinpayReqsn: null,
      },
      data: {
        channel,
        allinpayReqsn: order.orderNo,
        paymentExpiresAt: expiresAt,
        status: BillingOrderStatus.PENDING,
      },
    })
    if (claim.count !== 1) throw new ConflictException("订单支付处理中，请稍后查询")
    const response = await this.provider.pay(
      order.orderNo,
      new Decimal(order.amountCny).mul(100).toNumber(),
      ALLINPAY_PAY_TYPES[channel]
    )
    if (response.reqsn !== order.orderNo || !response.trxid)
      throw new BadGatewayException("通联订单绑定异常，请查询原订单")
    // 扫码下单的 0000 仅表示下单成功，不表示收款成功。
    if (response.trxstatus !== "0000" || !response.payinfo) {
      throw new BadGatewayException("二维码暂未生成，请查询原订单状态后重试")
    }
    await this.prisma.billingOrder.updateMany({
      where: {
        id: order.id,
        status: BillingOrderStatus.PENDING,
        OR: [{ allinpayTrxid: null }, { allinpayTrxid: response.trxid }],
      },
      data: { allinpayTrxid: response.trxid, allinpayQrCode: response.payinfo },
    })
    const latest = await this.prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } })
    if (latest.status !== BillingOrderStatus.PENDING)
      throw new ConflictException("订单状态已更新，请查询支付结果")
    return this._payload(latest)
  }

  async notify(payload: unknown) {
    const fields = this.provider.verifyFields(payload)
    if (fields.trxstatus === "0000") await this.settle.settleByAllinpay(fields, "webhook")
    // 不把退款/撤销通知当作支付成功；失败通知也不能覆盖已成功的订单。
    return "success"
  }

  async sync(order: BillingOrder) {
    if (
      !order.allinpayReqsn ||
      order.status === BillingOrderStatus.SETTLED ||
      order.status === BillingOrderStatus.ABANDONED
    )
      return
    const fields = await this.provider.query(order.allinpayReqsn, order.allinpayTrxid)
    if (fields.trxstatus === "1001") {
      // 下单请求可能仍在途，仅在完整有效期后处理不存在的交易。
      if (order.paymentExpiresAt && order.paymentExpiresAt.getTime() + 60000 < Date.now())
        await this._expire(order.id)
      return
    }
    this._assertBinding(order, fields)
    if (fields.trxstatus === "0000") {
      await this.settle.settleByAllinpay(fields, "query")
      return
    }
    // 官方交易结果码约定：3xxx 均为交易失败（3045 的原因由 errmsg 描述）。
    // 仅处理已验签且绑定匹配的原支付查单结果；失败交易无需再次关单，
    // 否则已超时未支付的 3045 会因重复关单失败一直滞留在 PENDING。
    // https://prodoc.allinpay.com/doc/2320/
    if (/^3\d{3}$/.test(fields.trxstatus ?? "")) {
      await this._expire(order.id)
      return
    }
    if (order.paymentExpiresAt && order.paymentExpiresAt.getTime() <= Date.now()) {
      // 先查后关；关单返回 0000 是关单成功，绝不能作为支付成功入账。
      const closed = await this.provider.close(order.allinpayReqsn, order.allinpayTrxid)
      if (closed.trxstatus === "0000") await this._expire(order.id)
    }
  }

  /** 定时补查：页面关闭或回调丢失时仍能对账；失败保留 PENDING 留待下一轮。 */
  @Cron(CronExpression.EVERY_5_MINUTES, { waitForCompletion: true })
  async reconcile() {
    const orders = await this.prisma.billingOrder.findMany({
      where: {
        paymentProvider: "ALLINPAY",
        status: BillingOrderStatus.PENDING,
        allinpayReqsn: { not: null },
      },
      orderBy: { updatedAt: "asc" },
      take: 100,
    })
    for (const order of orders) {
      try {
        await this.sync(order)
      } catch {
        this.logger.warn(`通联查单待重试 order=${order.orderNo}`)
      }
      // 公平轮转，避免异常旧单占满每批次；有效期独立字段，不随 updatedAt 延长。
      await this.prisma.billingOrder.updateMany({
        where: { id: order.id, status: BillingOrderStatus.PENDING },
        data: { updatedAt: new Date() },
      })
    }
  }

  private _assertBinding(order: BillingOrder, fields: AllinpayFields) {
    if (
      fields.reqsn !== order.allinpayReqsn ||
      !fields.trxid ||
      (order.allinpayTrxid && fields.trxid !== order.allinpayTrxid)
    ) {
      throw new BadGatewayException("通联查询订单不匹配")
    }
  }

  private async _expire(id: number) {
    await this.prisma.billingOrder.updateMany({
      where: { id, paymentProvider: "ALLINPAY", status: BillingOrderStatus.PENDING },
      data: { status: BillingOrderStatus.EXPIRED, expiredAt: new Date() },
    })
  }

  private async _payload(order: BillingOrder) {
    if (!order.allinpayQrCode || !order.paymentExpiresAt)
      throw new ConflictException("支付结果确认中，请稍后查询原订单，勿重复付款")
    if (order.paymentExpiresAt.getTime() <= Date.now())
      throw new ConflictException("二维码已过期，正在确认订单关闭状态")
    return {
      orderNo: order.orderNo,
      provider: "ALLINPAY" as const,
      channel: order.channel,
      qrImageDataUrl: await toDataURL(order.allinpayQrCode, {
        width: 320,
        margin: 4,
        errorCorrectionLevel: "M",
      }),
      expiresAt: order.paymentExpiresAt,
    }
  }
}
