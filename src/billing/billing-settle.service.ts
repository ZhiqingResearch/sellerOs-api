import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import {
  BillingOrder,
  BillingOrderStatus,
  BillingOrderType,
  CreditBucket,
  CreditTxnType,
  Prisma,
  TeamStatus,
} from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { ALLINPAY_TRX_CODES, AllinpayFields } from "../common/providers/allinpay.provider"
import { CreditService } from "../membership/credit.service"
import { PACKAGE_EXPIRE_DAYS } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"
import { TeamPoolService } from "../team/team-pool.service"
import { TeamAuditAction, TeamMemberStatus } from "../team/team.constants"
import { TeamService } from "../team/team.service"
import { BillingMailService } from "./billing-mail.service"
import {
  CustomSnapshot,
  PackSnapshot,
  PersonalToTeamSnapshot,
  PlanSnapshot,
  TeamCustomSnapshot,
  TeamPackSnapshot,
  TeamPlanSnapshot,
  TeamRenewSnapshot,
  TeamSeatUpgradeSnapshot,
  UpgradeSnapshot,
} from "./order-pricing.service"
import { ReceiptsService } from "./receipts.service"
import { STRIPE_CHARGE_CURRENCY, usdFromCents } from "./usd.util"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 订单结算：webhook/主动查单确认收款后的**唯一入账入口**。
 * - 幂等：状态条件更新抢占（CREATED/PENDING/PAID → PAID），重复 webhook/乱序不会重复入账。
 * - 原子：抢占 + 积分动作 + SETTLED 单事务；失败整体回滚，下次事件干净重试。
 * - 金额核对：Stripe 实收 ≠ 订单金额 → 置 ABANDONED 转人工 + 告警，绝不入账。
 */
@Injectable()
export class BillingSettleService {
  private readonly logger = new Logger(BillingSettleService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: CreditService,
    private readonly receipts: ReceiptsService,
    private readonly billingMail: BillingMailService,
    private readonly team: TeamService,
    private readonly teamPool: TeamPoolService
  ) {}

  /**
   * 按 Stripe PaymentIntent 结算对应订单。
   * @param pi { id, amount（实收美分）, currency（实收币种）, orderNo?（metadata 优先，缺省按 stripePaymentIntentId 找单） }
   * @param via webhook | query（主动查单）
   */
  async settleByPaymentIntent(
    pi: { id: string; amount: number; currency?: string | null; orderNo?: string | null },
    via: "webhook" | "query"
  ) {
    const order = await this.prisma.billingOrder.findFirst({
      where: pi.orderNo ? { orderNo: pi.orderNo } : { stripePaymentIntentId: pi.id },
      include: { items: true },
    })
    if (!order) {
      this.logger.warn(`settle: order not found for pi=${pi.id} orderNo=${pi.orderNo ?? "-"}`)
      return { settled: false, reason: "order_not_found" }
    }
    if (order.paymentProvider === "ALLINPAY") return { settled: false, reason: "provider_mismatch" }
    if (order.status === BillingOrderStatus.SETTLED) return { settled: true, already: true }

    // 绑定核对（防串单）：订单已绑定 PI 时，事件 PI 必须与原绑定一致——不一致=别的付款事件
    // 错挂/伪造 orderNo，只告警不结算、**不动订单状态**（订单仍等它自己的那笔付款）
    if (order.stripePaymentIntentId && order.stripePaymentIntentId !== pi.id) {
      this.logger.error(
        `settle PI MISMATCH order=${order.orderNo} bound=${order.stripePaymentIntentId} got=${pi.id} via=${via} → 拒绝结算`
      )
      await this.billingMail.sendAlert(
        `【计费告警】订单 PaymentIntent 不一致 ${order.orderNo}`,
        `<p>订单 ${order.orderNo}（用户 ${order.userId}）原绑定 pi=${order.stripePaymentIntentId}，收到结算事件的 pi=${pi.id}（${via}）。已拒绝结算，订单状态不变，请人工核实是否存在串单/伪造回调。</p>`
      )
      return { settled: false, reason: "pi_mismatch" }
    }

    // 币种核对：人民币计价、Stripe 一律折美元扣款——实收币种非 USD 即无效收款（即使金额数字
    // 碰巧相等也不认），置 ABANDONED 转人工；pi.currency 缺失（旧调用方）跳过本校验
    if (pi.currency != null && pi.currency.toLowerCase() !== STRIPE_CHARGE_CURRENCY) {
      await this.prisma.billingOrder.updateMany({
        where: { id: order.id, status: { notIn: [BillingOrderStatus.SETTLED] } },
        data: { status: BillingOrderStatus.ABANDONED },
      })
      this.logger.error(
        `settle CURRENCY MISMATCH order=${order.orderNo} expect=${STRIPE_CHARGE_CURRENCY} got=${pi.currency} → ABANDONED`
      )
      await this.billingMail.sendAlert(
        `【计费告警】订单实收币种不符 ${order.orderNo}`,
        `<p>订单 ${order.orderNo}（用户 ${order.userId}）应付 ¥${order.amountCny.toString()}（折美元扣款），Stripe 实收币种 ${pi.currency}（pi=${pi.id}），与约定扣款币种 ${STRIPE_CHARGE_CURRENCY} 不一致。已置 ABANDONED，请人工核实处理。</p>`
      )
      return { settled: false, reason: "currency_mismatch" }
    }

    // 金额核对（防篡改/防配置漂移）：实收 ≠ 应付 → 转人工；amountUsdCents 为 null（未走过发起支付）同样按不符处理
    if (order.amountUsdCents == null || pi.amount !== order.amountUsdCents) {
      await this.prisma.billingOrder.updateMany({
        where: { id: order.id, status: { notIn: [BillingOrderStatus.SETTLED] } },
        data: { status: BillingOrderStatus.ABANDONED },
      })
      this.logger.error(
        `settle AMOUNT MISMATCH order=${order.orderNo} expect=${order.amountUsdCents ?? "null"} got=${pi.amount} → ABANDONED`
      )
      await this.billingMail.sendAlert(
        `【计费告警】订单金额不符 ${order.orderNo}`,
        `<p>订单 ${order.orderNo}（用户 ${order.userId}）应付 ¥${order.amountCny.toString()}（实收美元快照 ${order.amountUsdCents == null ? "缺失" : `$${usdFromCents(order.amountUsdCents)}`}），Stripe 实收 $${usdFromCents(pi.amount)}（pi=${pi.id}）。已置 ABANDONED，请人工核实处理。</p>`
      )
      return { settled: false, reason: "amount_mismatch" }
    }

    return this._settleVerified(order, via, pi.id)
  }

  /** 只能由验签后的通联查询/通知调用；退款、撤销等交易不作为入账依据。 */
  async settleByAllinpay(fields: AllinpayFields, via: "webhook" | "query") {
    if (
      fields.trxstatus !== "0000" ||
      !(Object.values(ALLINPAY_TRX_CODES) as string[]).includes(fields.trxcode)
    ) {
      return { settled: false, reason: "not_payment" }
    }
    const reqsn = via === "webhook" ? fields.cusorderid : fields.reqsn
    if (!reqsn || !fields.trxid) throw new BadRequestException("通联支付通知缺少订单标识")
    const order = await this.prisma.billingOrder.findUnique({ where: { allinpayReqsn: reqsn } })
    if (!order) throw new NotFoundException("通联支付订单不存在")
    if (
      order.paymentProvider !== "ALLINPAY" ||
      !order.channel ||
      ALLINPAY_TRX_CODES[order.channel as keyof typeof ALLINPAY_TRX_CODES] !== fields.trxcode ||
      (order.allinpayTrxid && order.allinpayTrxid !== fields.trxid)
    ) {
      throw new BadRequestException("通联支付绑定不匹配")
    }
    if (order.status === BillingOrderStatus.SETTLED) return { settled: true, already: true }
    if (order.status === BillingOrderStatus.ABANDONED)
      return { settled: false, reason: "manual_review" }
    const expected = new Decimal(order.amountCny).mul(100).toFixed(0)
    if (
      !/^\d+$/.test(fields.initamt ?? "") ||
      !/^\d+$/.test(fields.trxamt ?? "") ||
      new Decimal(fields.initamt).toFixed(0) !== expected ||
      new Decimal(fields.trxamt).toFixed(0) !== expected
    ) {
      const changed = await this.prisma.billingOrder.updateMany({
        where: {
          id: order.id,
          status: { notIn: [BillingOrderStatus.SETTLED, BillingOrderStatus.ABANDONED] },
        },
        data: { status: BillingOrderStatus.ABANDONED },
      })
      if (changed.count)
        await this.billingMail.sendAlert(
          `【计费告警】通联订单金额不符 ${order.orderNo}`,
          `<p>订单 ${order.orderNo} 金额核对失败，已转人工处理，请登录通联后台核实实收与优惠信息。</p>`
        )
      return { settled: false, reason: "amount_mismatch" }
    }
    // 回调可能早于下单响应。CAS 绑定流水，不能覆盖另一笔交易。
    const binding = await this.prisma.billingOrder.updateMany({
      where: { id: order.id, OR: [{ allinpayTrxid: null }, { allinpayTrxid: fields.trxid }] },
      data: { allinpayTrxid: fields.trxid },
    })
    if (binding.count !== 1) throw new BadRequestException("通联交易流水不匹配")
    return this._settleVerified(order, via, fields.trxid, true)
  }

  private async _settleVerified(
    order: BillingOrder,
    via: "webhook" | "query",
    tradeId: string,
    isAllinpay = false
  ) {
    // 互斥单结算前复核：下单到收款之间身份/个人套餐状态可能已变化（交叉支付、webhook 乱序、
    // 他人拉入企业等），按旧快照入账必然出错——命中即置 ABANDONED 转人工，绝不入账
    const stale = await this.guardExclusiveOrderState(order)
    if (stale) return stale

    // 读时兜底：套餐类入账前先把到期待生效套餐激活（队尾计算口径一致）
    if (order.type === BillingOrderType.PLAN_NEW || order.type === BillingOrderType.PLAN_RENEW) {
      await this.credit.activateDuePlans(order.userId)
    }
    if (order.type === BillingOrderType.PLAN_UPGRADE) {
      await this.credit.activateDuePlans(order.userId)
    }

    const now = new Date()
    try {
      const committed = await this.prisma.$transaction(
        async tx => {
          // 抢占：只有从 未终态 抢到 PAID 的事务才往下入账；并发/重复事件 count=0 → 放弃
          const claim = await tx.billingOrder.updateMany({
            where: {
              id: order.id,
              status: {
                in: [
                  BillingOrderStatus.CREATED,
                  BillingOrderStatus.PENDING,
                  BillingOrderStatus.PAID,
                  ...(isAllinpay ? [BillingOrderStatus.EXPIRED] : []),
                ],
              },
            },
            data: { status: BillingOrderStatus.PAID, paidAt: now },
          })
          if (claim.count !== 1) return false

          await this.applyCredits(tx, order, now)
          await tx.billingOrder.update({
            where: { id: order.id },
            data: { status: BillingOrderStatus.SETTLED, settledAt: now },
          })
          return true
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
      )
      if (!committed) {
        if (!isAllinpay) return { settled: true, already: true }
        const latest = await this.prisma.billingOrder.findUnique({ where: { id: order.id } })
        return { settled: latest?.status === BillingOrderStatus.SETTLED, already: true }
      }
    } catch (e) {
      // 事务回滚：订单保持原状态，下次事件可干净重试；同时告警（积分动作失败需人工关注）
      this.logger.error(
        `settle tx failed order=${order.orderNo}: ${(e as Error).message}`,
        (e as Error).stack
      )
      await this.billingMail.sendAlert(
        `【计费告警】订单入账失败 ${order.orderNo}`,
        `<p>订单 ${order.orderNo}（用户 ${order.userId}，类型 ${order.type}）已收款（trade=${tradeId}）但入账事务失败：${(e as Error).message}。系统将由后续事件重试；如持续失败请人工处理。</p>`
      )
      throw e
    }

    this.logger.log(`settled order=${order.orderNo} type=${order.type} via=${via}`)
    // 开票 + 收据邮件（失败不阻塞记账）
    await this.receipts.issueForOrder(order.id).catch(e => {
      this.logger.warn(`issueForOrder failed order=${order.orderNo}: ${(e as Error).message}`)
    })
    return { settled: true }
  }

  /** PaymentIntent 被取消：对应订单置 CANCELLED（已入账不动）。幂等。 */
  async cancelByPaymentIntent(paymentIntentId: string) {
    await this.prisma.billingOrder.updateMany({
      where: {
        stripePaymentIntentId: paymentIntentId,
        status: { in: [BillingOrderStatus.CREATED, BillingOrderStatus.PENDING] },
      },
      data: { status: BillingOrderStatus.CANCELLED },
    })
    return { cancelled: true }
  }

  /**
   * 0 元单免支付直接入账（个人转企业抵扣 ≥ 企业价，实付 0 不走 Stripe）。
   * 与 settleByPaymentIntent 同一幂等/事务口径：状态抢占 + applyCredits + SETTLED 单事务；
   * 金额核对天然成立（无 Stripe 实收）；照常开票（¥0 收据留凭证），开票失败不阻塞。
   */
  async settleZeroAmountOrder(orderNo: string) {
    const order = await this.prisma.billingOrder.findUnique({
      where: { orderNo },
      include: { items: true },
    })
    if (!order) throw new NotFoundException("订单不存在")
    if (order.status === BillingOrderStatus.SETTLED) return { settled: true, already: true }
    if (Number(order.amountCny) !== 0) throw new BadRequestException("非 0 元订单，请走支付渠道")
    // 与 settleByPaymentIntent 同一互斥单复核（0 元单不走 Stripe，更要防旧快照错结）
    const stale = await this.guardExclusiveOrderState(order)
    if (stale) return stale
    const now = new Date()
    try {
      const committed = await this.prisma.$transaction(
        async tx => {
          // 抢占：只有从未终态抢到 PAID 的事务才往下入账；重复调用/并发 count=0 → 放弃
          const claim = await tx.billingOrder.updateMany({
            where: {
              id: order.id,
              status: {
                in: [
                  BillingOrderStatus.CREATED,
                  BillingOrderStatus.PENDING,
                  BillingOrderStatus.PAID,
                ],
              },
            },
            data: { status: BillingOrderStatus.PAID, paidAt: now },
          })
          if (claim.count !== 1) return false
          await this.applyCredits(tx, order, now)
          await tx.billingOrder.update({
            where: { id: order.id },
            data: { status: BillingOrderStatus.SETTLED, settledAt: now },
          })
          return true
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
      )
      if (!committed) return { settled: true, already: true }
    } catch (e) {
      this.logger.error(
        `zero-amount settle tx failed order=${orderNo}: ${(e as Error).message}`,
        (e as Error).stack
      )
      await this.billingMail.sendAlert(
        `【计费告警】0 元单入账失败 ${orderNo}`,
        `<p>订单 ${orderNo}（用户 ${order.userId}，类型 ${order.type}）实付 0 但入账事务失败：${(e as Error).message}。请人工处理。</p>`
      )
      throw e
    }
    this.logger.log(`settled zero-amount order=${orderNo} type=${order.type}`)
    await this.receipts.issueForOrder(order.id).catch(e => {
      this.logger.warn(`issueForOrder failed order=${orderNo}: ${(e as Error).message}`)
    })
    return { settled: true }
  }

  /** 按订单类型执行积分入账（全部走 CreditService，不绕过批次台账；在结算事务内） */
  private async applyCredits(tx: Prisma.TransactionClient, order: BillingOrder, now: Date) {
    const sourceRef = order.orderNo
    const meta = {
      orderNo: order.orderNo,
      channel: order.channel,
      paymentProvider: order.paymentProvider,
      priceCny: Number(order.amountCny), // 人民币（元）；transaction-display 读 meta.priceCny 展示
    }
    switch (order.type) {
      case BillingOrderType.PLAN_NEW:
      case BillingOrderType.PLAN_RENEW: {
        const snap = order.snapshot as unknown as PlanSnapshot
        // 立即生效（2026-08-25 起废排队制）：有效期顺延 + 积分立即到账 + 立即切档
        await this.credit.renewImmediateInTx(
          tx,
          order.userId,
          {
            tier: snap.tier,
            planName: snap.planName,
            priceCny: new Decimal(snap.priceCny),
            packageCredits: snap.packageCredits,
            giftCredits: snap.giftCredits,
            periodDays: snap.periodDays,
          },
          now,
          { source: "billing.order", sourceRef, meta }
        )
        // 停用（DISABLED）成员购买个人套餐 → 已是个人订阅用户，自动移出企业（同事务）
        await this.removeDisabledMembershipsInTx(tx, order.userId)
        return
      }
      case BillingOrderType.PLAN_UPGRADE: {
        const snap = order.snapshot as unknown as UpgradeSnapshot
        await this.credit.upgradePlanImmediate(
          order.userId,
          {
            fromTier: snap.fromTier,
            toTier: snap.toTier,
            planName: snap.planName,
            packageDiff: snap.packageDiff,
            giftDiff: snap.giftDiff,
            expiresAt: new Date(snap.expiresAt),
          },
          { source: "billing.order", sourceRef, meta },
          tx
        )
        return
      }
      case BillingOrderType.PACK: {
        const snap = order.snapshot as unknown as PackSnapshot
        // 本金 RECHARGE（永不过期）+ 赠送 GIFT（30 天）
        await this.credit.recordRecharge(
          order.userId,
          {
            type: CreditTxnType.RECHARGE_PACK,
            source: "billing.order",
            sourceRef,
            lots: [
              { bucket: CreditBucket.RECHARGE, amount: snap.baseCredits, expiresAt: null },
              {
                bucket: CreditBucket.GIFT,
                amount: snap.bonusCredits,
                expiresAt: new Date(now.getTime() + PACKAGE_EXPIRE_DAYS * DAY_MS),
              },
            ],
            meta: {
              packId: snap.packId,
              baseCredits: snap.baseCredits,
              bonusCredits: snap.bonusCredits,
              ...meta,
            },
          },
          tx
        )
        return
      }
      case BillingOrderType.CUSTOM: {
        const snap = order.snapshot as unknown as CustomSnapshot
        // 本金 RECHARGE（永不过期）+ 赠送 GIFT（30 天）
        await this.credit.recordRecharge(
          order.userId,
          {
            type: CreditTxnType.RECHARGE_CUSTOM,
            source: "billing.order",
            sourceRef,
            lots: [
              { bucket: CreditBucket.RECHARGE, amount: snap.baseCredits, expiresAt: null },
              {
                bucket: CreditBucket.GIFT,
                amount: snap.bonusCredits,
                expiresAt: new Date(now.getTime() + PACKAGE_EXPIRE_DAYS * DAY_MS),
              },
            ],
            meta: {
              baseCredits: new Decimal(snap.baseCredits).toDecimalPlaces(0).toNumber(),
              bonusCredits: new Decimal(snap.bonusCredits).toNumber(),
              ...meta,
            },
          },
          tx
        )
        return
      }
      case BillingOrderType.TEAM_PLAN: {
        const snap = order.snapshot as unknown as TeamPlanSnapshot
        // 建队（joinTeam 同口径：终止购买人个人套餐/赠送 + 取消其个人排队单）+ 池入账 + 回写订单 teamId
        const team = await this.team.createSelfServeTeam(
          {
            name: snap.teamName,
            adminUserId: order.userId,
            tier: snap.teamTier,
            seats: snap.seats,
            periodDays: snap.periodDays,
          },
          tx
        )
        await this.teamPool.grantPool(
          team.id,
          {
            ownerUserId: order.userId,
            packageCredits: snap.poolPackageCredits,
            giftCredits: snap.poolGiftCredits,
            source: "billing.order",
            sourceRef,
            type: CreditTxnType.RECHARGE_PLAN, // 充值记录归「套餐订阅」
            meta: {
              tier: snap.teamTier,
              name: snap.planName,
              expiresAt: team.expiresAt.toISOString(),
              ...meta,
            },
          },
          tx
        )
        // 个人充值包(RECHARGE)存量去向（与 P2T 同口径）：inject=全部注入共享池（个人批次清零留痕）；
        // keep/老快照无此字段=留在个人户。必须并入 settle 事务：建队/池入账/注入/结算同生共死
        if (snap.packChoice === "inject") {
          await this.credit.transferRechargeLotsToTeam(
            order.userId,
            team.id,
            { source: "billing.order", meta },
            tx
          )
        }
        await tx.billingOrder.update({ where: { id: order.id }, data: { teamId: team.id } })
        return
      }
      case BillingOrderType.PERSONAL_TO_TEAM: {
        const snap = order.snapshot as unknown as PersonalToTeamSnapshot
        const team = await this.team.createSelfServeTeam(
          {
            name: snap.teamName,
            adminUserId: order.userId,
            tier: snap.teamTier,
            seats: snap.seats,
            periodDays: snap.periodDays,
          },
          tx
        )
        await this.teamPool.grantPool(
          team.id,
          {
            ownerUserId: order.userId,
            packageCredits: snap.poolPackageCredits,
            giftCredits: snap.poolGiftCredits,
            source: "billing.order",
            sourceRef,
            type: CreditTxnType.RECHARGE_PLAN, // 充值记录归「套餐订阅」
            meta: {
              tier: snap.teamTier,
              name: snap.planName,
              personalToTeam: true, // 项目列加「（个人订阅转团队订阅）」后缀
              expiresAt: team.expiresAt.toISOString(),
              ...meta,
            },
          },
          tx
        )
        // 个人充值包积分去向：inject=全部注入共享池（个人批次清零留痕）；keep=留在个人户
        if (snap.packChoice === "inject") {
          await this.credit.transferRechargeLotsToTeam(
            order.userId,
            team.id,
            {
              source: "billing.order",
              meta,
            },
            tx // 必须并入 settle 事务：建队/折抵/清零/返还/结算同生共死
          )
        }
        // 抵扣价值超出企业价的部分：按 1 元=10 积分返还（永不过期）。去向与个人充值包同一选择（原型③
        // 「我的积分去哪了」二选一）：inject=注入团队共享池（TEAM_RECHARGE 企业池入账）；keep=留个人
        // RECHARGE（MANUAL_ADJUST 手动调整）。必须在 inject 之后写——选 keep 时先写会被 inject 吸进池里
        if (snap.refundCredits > 0) {
          const refundMeta = {
            reason: "个人套餐转企业套餐差额返还",
            orderNo: order.orderNo,
            personalTier: snap.personalTier, // 原套餐等级
            personalPriceCny: snap.personalPriceCny, // 原套餐月费
            remainingDays: snap.remainingDays, // 剩余时间（天）
            remainingCredits: snap.remainingCredits, // 参与折算的剩余积分
            factor: snap.factor, // 折算系数
            offsetCny: snap.offsetCny, // 可抵扣金额
            teamPriceCny: snap.priceCny, // 企业套餐价格
            refundCny: snap.refundCny, // 超出金额
            refundCredits: snap.refundCredits, // 返还积分
          }
          if (snap.packChoice === "inject") {
            await this.teamPool.grantPool(
              team.id,
              {
                ownerUserId: order.userId,
                rechargeCredits: snap.refundCredits,
                source: "billing.p2t.refund",
                sourceRef,
                type: CreditTxnType.TEAM_RECHARGE, // 非付款入账，归「企业池入账」
                meta: { ...refundMeta, p2tRefund: true },
              },
              tx
            )
          } else {
            await this.credit.adjust(
              order.userId,
              snap.refundCredits,
              { source: "billing.p2t.refund", sourceRef, meta: refundMeta },
              tx
            )
          }
        }
        await tx.billingOrder.update({ where: { id: order.id }, data: { teamId: team.id } })
        return
      }
      case BillingOrderType.TEAM_RENEW: {
        const snap = order.snapshot as unknown as TeamRenewSnapshot
        const team = await tx.team.findUnique({ where: { id: snap.teamId } })
        if (!team) throw new Error(`团队 ${snap.teamId} 不存在，无法续费入账`)
        if (team.status === TeamStatus.ACTIVE) {
          // 在期续费立即生效（2026-08-25 起废排队制）：团队有效期顺延 + 本期池积分立即入账
          await this.team.renewTeamImmediateInTx(
            tx,
            snap.teamId,
            {
              tier: snap.teamTier,
              planName: snap.planName,
              poolPackageCredits: snap.poolPackageCredits,
              poolGiftCredits: snap.poolGiftCredits,
              periodDays: snap.periodDays,
            },
            now,
            { source: "billing.order", sourceRef, meta }
          )
        } else if (team.status === TeamStatus.GRACE || team.status === TeamStatus.ARCHIVED) {
          // 宽限/归档续费 = 恢复动作立即生效 + 本期池积分立即入账
          const restored = await this.team.restoreTeam(
            snap.teamId,
            snap.periodDays,
            order.userId,
            tx
          )
          await this.teamPool.grantPool(
            snap.teamId,
            {
              ownerUserId: order.userId,
              packageCredits: snap.poolPackageCredits,
              giftCredits: snap.poolGiftCredits,
              packageExpiresAt: restored.expiresAt,
              source: "billing.order",
              sourceRef,
              type: CreditTxnType.RECHARGE_PLAN, // 充值记录归「套餐订阅」
              meta: {
                tier: snap.teamTier,
                name: snap.planName,
                expiresAt: restored.expiresAt.toISOString(),
                ...meta,
              },
            },
            tx
          )
        } else {
          throw new Error(`团队 ${snap.teamId} 已被平台停用，无法续费入账`)
        }
        return
      }
      case BillingOrderType.TEAM_SEAT_UPGRADE: {
        const snap = order.snapshot as unknown as TeamSeatUpgradeSnapshot
        const team = await tx.team.findUnique({ where: { id: snap.teamId } })
        if (!team || team.status !== TeamStatus.ACTIVE) {
          throw new Error(`团队 ${snap.teamId} 状态已变化，无法升席位入账`)
        }
        if (team.tier !== snap.fromTier) {
          throw new Error(`团队 ${snap.teamId} 套餐档已变化，请重新下单`)
        }
        // 整月池积分差一次补齐（套餐差 PACKAGE + 赠送差 GIFT，过期时间=原到期日），切档 + 席位，到期日不变
        if (snap.packageDiff > 0 || snap.giftDiff > 0) {
          await this.teamPool.grantPool(
            snap.teamId,
            {
              ownerUserId: order.userId,
              packageCredits: snap.packageDiff,
              giftCredits: snap.giftDiff,
              packageExpiresAt: new Date(snap.expiresAt),
              source: "billing.order",
              sourceRef,
              type: CreditTxnType.RECHARGE_PLAN, // 升级补差：充值记录归「套餐升级」
              meta: {
                tier: snap.toTier,
                name: snap.planName,
                upgrade: true,
                fromTier: snap.fromTier,
                expiresAt: snap.expiresAt,
                ...meta,
              },
            },
            tx
          )
        }
        await tx.team.update({
          where: { id: snap.teamId },
          data: { tier: snap.toTier, seats: snap.seats },
        })
        await this.team.audit(tx, snap.teamId, order.userId, TeamAuditAction.TEAM_SEAT_UPGRADE, {
          orderNo: order.orderNo,
          fromTier: snap.fromTier,
          toTier: snap.toTier,
          seats: snap.seats,
          creditsDiff: snap.creditsDiff,
        })
        return
      }
      case BillingOrderType.TEAM_PACK: {
        const snap = order.snapshot as unknown as TeamPackSnapshot
        // 本金 RECHARGE（永不过期）+ 赠送 GIFT（30 天），入共享池
        await this.teamPool.grantPool(
          snap.teamId,
          {
            ownerUserId: order.userId,
            rechargeCredits: snap.baseCredits,
            giftCredits: snap.bonusCredits,
            source: "billing.order",
            sourceRef,
            type: CreditTxnType.RECHARGE_PACK, // 充值记录归「充值包」
            meta: {
              packId: snap.packId,
              baseCredits: snap.baseCredits,
              bonusCredits: snap.bonusCredits,
              ...meta,
            },
          },
          tx
        )
        await this.team.audit(tx, snap.teamId, order.userId, TeamAuditAction.POOL_RECHARGE, {
          orderNo: order.orderNo,
          kind: snap.kind,
          packId: snap.packId,
          rechargeCredits: snap.baseCredits,
          bonusCredits: snap.bonusCredits,
        })
        return
      }
      case BillingOrderType.TEAM_CUSTOM: {
        const snap = order.snapshot as unknown as TeamCustomSnapshot
        const base = Number(new Decimal(snap.baseCredits).toDecimalPlaces(4))
        const bonus = Number(snap.bonusCredits)
        // 本金 RECHARGE（永不过期）+ 赠送 GIFT（30 天），入共享池
        await this.teamPool.grantPool(
          snap.teamId,
          {
            ownerUserId: order.userId,
            rechargeCredits: base,
            giftCredits: bonus,
            source: "billing.order",
            sourceRef,
            type: CreditTxnType.RECHARGE_CUSTOM, // 充值记录归「自定义充值」
            meta: { baseCredits: base, bonusCredits: bonus, ...meta },
          },
          tx
        )
        await this.team.audit(tx, snap.teamId, order.userId, TeamAuditAction.POOL_RECHARGE, {
          orderNo: order.orderNo,
          kind: snap.kind,
          rechargeCredits: base,
          bonusCredits: bonus,
        })
        return
      }
      default:
        throw new Error(`订单类型 ${String(order.type)} 不支持结算`)
    }
  }

  /**
   * 银行卡 dispute（拒付）反记账：扣回已入账积分（余额不足记负批次欠账）+ 告警通知平台。
   * 一期不自动封号（风险 R5）。重复事件幂等：按 meta.disputeChargeId 去重。
   */
  async handleDisputeCreated(charge: {
    id: string
    paymentIntentId: string | null
    amount: number
  }) {
    const order = charge.paymentIntentId
      ? await this.prisma.billingOrder.findFirst({
          where: { stripePaymentIntentId: charge.paymentIntentId },
        })
      : null
    if (!order) {
      this.logger.warn(`dispute: order not found for charge=${charge.id}`)
      return
    }
    // 幂等：已反记账过该 charge 直接跳过（meta.disputeChargeId 去重；少量候选行内存过滤）
    const dupCandidates = await this.prisma.creditTransaction.findMany({
      where: {
        userId: order.userId,
        type: CreditTxnType.MANUAL_ADJUST,
        source: "billing.dispute",
      },
      select: { meta: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    })
    const dup = dupCandidates.some(
      r => (r.meta as Record<string, unknown> | null)?.disputeChargeId === charge.id
    )
    if (dup) return

    if (order.status === BillingOrderStatus.SETTLED && order.creditsTotal) {
      await this.credit.reverseCredits(order.userId, order.creditsTotal, {
        source: "billing.dispute",
        meta: { disputeChargeId: charge.id, orderNo: order.orderNo, reason: "银行卡拒付反记账" },
      })
      this.logger.error(
        `dispute reversal order=${order.orderNo} user=${order.userId} credits=${order.creditsTotal} charge=${charge.id}`
      )
    }
    await this.billingMail.sendAlert(
      `【计费告警】银行卡拒付 ${order.orderNo}`,
      `<p>订单 ${order.orderNo}（用户 ${order.userId}，金额 ¥${order.amountCny.toString()}${order.amountUsdCents == null ? "" : ` / $${usdFromCents(order.amountUsdCents)}`}）发生拒付（charge=${charge.id}）。${order.status === BillingOrderStatus.SETTLED ? `已反记账扣回 ${order.creditsTotal ?? 0} 积分。` : "订单未入账，无需反记账。"}请在 Stripe Dashboard 跟进争议，并评估是否停用该用户。</p>`
    )
  }

  /**
   * 互斥订单结算前复核（2026-08-27，QA 并发单 bug）：下单到收款之间，账号身份或个人套餐
   * 状态可能已变化（个人续费与转团队交叉支付、webhook 乱序、被他人拉入企业等），
   * 此时仍按建单快照入账必然出错——命中即置 ABANDONED 转人工（款已收，人工退款/补偿），绝不入账。
   * 返回 null = 放行；否则返回 { settled:false, reason }。
   * - 建队单（TEAM_PLAN/PERSONAL_TO_TEAM）：结算时用户已归属占用中企业 → 拒（createSelfServeTeam 也会拦，但那样订单卡 PENDING 反复重试）
   * - PERSONAL_TO_TEAM 额外比对个人套餐快照：tier/到期时刻任一变化（续费/升级先到账）→ 拒（折抵价值已失真）
   * - 个人套餐单（PLAN_NEW/RENEW/UPGRADE）：结算时用户已归属占用中企业 → 拒（防给企业成员恢复个人订阅）
   *   （DISABLED 成员不算占用中，不影响其「购买个人套餐自动移出企业」规则）
   * - 个人充值单（PACK/CUSTOM）：结算时用户已归属占用中企业 → 拒（2026-09-01 产品收口，作废
   *   2026-08-29「成员允许个人充值」定稿：成员积分一律管理员充池；下单/发起支付已同源拦截，
   *   本复核兜「PI 已建→入企业→旧页面完成支付」的尾部竞态）
   */
  private async guardExclusiveOrderState(
    order: BillingOrder
  ): Promise<{ settled: false; reason: string } | null> {
    const teamFounding =
      order.type === BillingOrderType.TEAM_PLAN || order.type === BillingOrderType.PERSONAL_TO_TEAM
    const personalPlan =
      order.type === BillingOrderType.PLAN_NEW ||
      order.type === BillingOrderType.PLAN_RENEW ||
      order.type === BillingOrderType.PLAN_UPGRADE
    const personalRecharge =
      order.type === BillingOrderType.PACK || order.type === BillingOrderType.CUSTOM
    if (!teamFounding && !personalPlan && !personalRecharge) return null

    const occupiedTeamId = await this.team.findOccupiedTeamId(order.userId)
    if (occupiedTeamId != null) {
      return this.abandonStaleOrder(
        order,
        teamFounding
          ? `下单后用户已加入企业团队（team=${occupiedTeamId}），建队单不再适用`
          : personalRecharge
            ? `结算时用户已归属企业团队（team=${occupiedTeamId}），个人充值单不再适用（2026-09-01 收口：企业成员不可个人充值）`
            : `结算时用户已归属企业团队（team=${occupiedTeamId}），个人套餐不再适用`
      )
    }

    if (order.type === BillingOrderType.PERSONAL_TO_TEAM) {
      const snap = order.snapshot as unknown as PersonalToTeamSnapshot
      const user = await this.prisma.user.findUnique({
        where: { id: order.userId },
        select: { subscriptionTier: true, subscriptionExpiresAt: true },
      })
      const snapTier = snap.personalTier ?? null
      const snapExpiresAt = snap.personalExpiresAt
        ? new Date(snap.personalExpiresAt).getTime()
        : null
      const curTier = user?.subscriptionTier ?? null
      const curExpiresAt = user?.subscriptionExpiresAt?.getTime() ?? null
      if (curTier !== snapTier || curExpiresAt !== snapExpiresAt) {
        return this.abandonStaleOrder(
          order,
          `下单后个人套餐状态已变化（快照 tier=${snapTier ?? "无"}/expires=${snap.personalExpiresAt ?? "无"}，` +
            `当前 tier=${curTier ?? "无"}/expires=${user?.subscriptionExpiresAt?.toISOString() ?? "无"}；` +
            "如个人续费/升级先到账），折抵快照已失真，不得按旧快照结算"
        )
      }
    }
    return null
  }

  /** 互斥复核命中：置 ABANDONED（已 SETTLED 不动）+ 告警转人工（款已收未入账，需人工退款/补偿） */
  private async abandonStaleOrder(order: BillingOrder, reason: string) {
    await this.prisma.billingOrder.updateMany({
      where: { id: order.id, status: { notIn: [BillingOrderStatus.SETTLED] } },
      data: { status: BillingOrderStatus.ABANDONED },
    })
    this.logger.error(
      `settle STATE CHANGED order=${order.orderNo} type=${order.type}: ${reason} → ABANDONED`
    )
    await this.billingMail.sendAlert(
      `【计费告警】订单状态已变化拒绝结算 ${order.orderNo}`,
      `<p>订单 ${order.orderNo}（用户 ${order.userId}，类型 ${order.type}，金额 ¥${order.amountCny.toString()}）结算前复核未通过：${reason}。已置 ABANDONED；款项已收但未入账，请人工核实退款或补偿。</p>`
    )
    return { settled: false as const, reason: "state_changed" }
  }

  /**
   * 停用（DISABLED）成员购买个人套餐后自动移出企业（2026-08-27 产品规则）：
   * 该成员已是个人订阅用户，删除成员关系（释放席位）+ 审计（actorId=0 系统）。
   * 仅处理 DISABLED；ACTIVE 成员不触碰（其在企业内消费走混合扣费，个人购买入口另行约束）。
   * 在个人套餐订单（PLAN_NEW/PLAN_RENEW）结算事务内调用，与套餐激活同生共死。
   */
  private async removeDisabledMembershipsInTx(tx: Prisma.TransactionClient, userId: number) {
    const rows = await tx.teamMember.findMany({
      where: { userId, status: TeamMemberStatus.DISABLED },
      select: { teamId: true },
    })
    for (const r of rows) {
      await tx.teamMember.delete({ where: { teamId_userId: { teamId: r.teamId, userId } } })
      await tx.teamAuditLog.create({
        data: {
          teamId: r.teamId,
          actorId: 0, // 系统动作
          action: TeamAuditAction.MEMBER_REMOVE,
          meta: { userId, reason: "停用成员购买个人套餐，自动移出企业" },
        },
      })
      this.logger.log(`auto-remove disabled member user=${userId} team=${r.teamId}（购买个人套餐）`)
    }
  }
}
