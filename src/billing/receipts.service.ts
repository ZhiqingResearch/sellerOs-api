import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import {
  BillingOrder,
  BillingOrderItem,
  BillingOrderType,
  CreditDirection,
  CreditTxnType,
  MembershipLevel,
  PaymentChannel,
  Prisma,
} from "@prisma/client"
import { exportDateTimeFormatter } from "../common/utils/datetime"
import { describeTransaction } from "../membership/transaction-display"
import { PrismaService } from "../prisma/prisma.service"
import { BillingMailService } from "./billing-mail.service"
import { CLAIMABLE_RECEIPT_TYPES, genSerialNo } from "./billing.constants"
import { ReceiptPdfService } from "./receipt-pdf.service"
import type { ReceiptLang } from "./receipt-template"
import { ReceiptSnapshot, renderReceiptHtml, withAmountUpper } from "./receipt-template"

const CHANNEL_LABEL: Record<PaymentChannel, string> = {
  [PaymentChannel.WECHAT]: "微信支付",
  [PaymentChannel.ALIPAY]: "支付宝",
  [PaymentChannel.CARD]: "银行卡",
  [PaymentChannel.ADMIN]: "原支付渠道（后台人工）",
}

const LEVEL_LABEL: Record<MembershipLevel, string> = {
  [MembershipLevel.NONE]: "普通用户",
  [MembershipLevel.LV1]: "Lv.1 Explorer",
  [MembershipLevel.LV2]: "Lv.2 Plus",
  [MembershipLevel.LV3]: "Lv.3 Ultra",
  [MembershipLevel.FOUNDER]: "普通用户",
  [MembershipLevel.INVITER]: "分销用户",
}

/**
 * 团队类订单（付款人=企业管理员）：收据「等级」栏不看个人 membershipLevel
 * （加入企业即注销个人订阅，恒为 NONE→「普通用户」），固定展示「企业管理员」。
 */
const TEAM_ORDER_TYPES: ReadonlySet<BillingOrderType> = new Set([
  BillingOrderType.TEAM_PLAN,
  BillingOrderType.TEAM_RENEW,
  BillingOrderType.TEAM_SEAT_UPGRADE,
  BillingOrderType.TEAM_PACK,
  BillingOrderType.TEAM_CUSTOM,
  BillingOrderType.PERSONAL_TO_TEAM,
])

/** 收据（开票即冻结快照；查看=网页渲染，下载=前端 PDF，邮件=后端 PDF 附件）。 */
@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger(ReceiptsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: ReceiptPdfService,
    private readonly billingMail: BillingMailService,
    private readonly config: ConfigService
  ) {}

  /**
   * 订单 SETTLED 后开票 + 发收据邮件（失败只告警不阻塞记账；可经 resend 重发）。
   * 幂等：订单已有收据直接返回。
   */
  async issueForOrder(orderId: number) {
    const order = await this.prisma.billingOrder.findUnique({
      where: { id: orderId },
      include: { items: true, receipt: true, user: true },
    })
    if (!order) throw new NotFoundException("订单不存在")
    if (order.receipt) return order.receipt

    const snapshot = this.buildOrderSnapshot(order)
    const receipt = await this.createWithRetry({
      orderId: order.id,
      userId: order.userId,
      email: snapshot.payer.email,
      amountCny: snapshot.totalCny,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    })
    if (snapshot.payer.email) {
      await this.sendReceiptEmail(receipt.id).catch(e => {
        // 邮件/PDF 失败不阻塞记账：留 emailedAt=null，用户/后台可重发
        this.logger.warn(
          `sendReceiptEmail failed receipt=${receipt.receiptNo}: ${(e as Error).message}`
        )
      })
    }
    return receipt
  }

  /** 补开：对本人的人工充值流水（后台 admin.recharge.* 入账、无收据的）现开收据；email 可指定接收邮箱 */
  async claimFromTransaction(userId: number, transactionId: number, email?: string) {
    const txn = await this.prisma.creditTransaction.findUnique({ where: { id: transactionId } })
    if (!txn || txn.userId !== userId) throw new NotFoundException("流水不存在")
    if (txn.direction !== CreditDirection.CREDIT) throw new BadRequestException("该流水不可开收据")
    // 仅「真实收款」的后台人工充值可开收据；手动调整（admin.recharge.manual）无付款事实，一律拒绝
    if (!(CLAIMABLE_RECEIPT_TYPES as readonly string[]).includes(txn.type)) {
      throw new BadRequestException(
        txn.type === CreditTxnType.MANUAL_ADJUST
          ? "手动调整不属于付款交易，不可开收据"
          : "该流水不可开收据"
      )
    }
    if (!txn.source?.startsWith("admin.recharge.")) {
      throw new BadRequestException("仅后台人工充值的流水支持补开收据")
    }
    const manualRef = `txn:${txn.id}`
    const existing = await this.prisma.receipt.findFirst({ where: { manualRef } })
    if (existing) return existing

    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new NotFoundException("用户不存在")
    const receiptEmail = email ?? user.receiptEmail ?? user.email ?? ""
    const d = describeTransaction(txn)
    const meta = (txn.meta ?? {}) as Record<string, unknown>
    const amountCny = typeof meta.priceCny === "number" ? meta.priceCny : 0
    const snapshot: ReceiptSnapshot = {
      receiptNo: "", // 占位，createWithRetry 前替换
      orderNo: null,
      issuedAt: new Date().toISOString(),
      paidAt: txn.createdAt.toISOString(),
      payer: {
        username: user.username,
        level: LEVEL_LABEL[user.membershipLevel],
        account: user.email || user.phone,
        title: `${user.username}（个人）`,
        email: receiptEmail,
      },
      payee: "SellerOS 跨境卖家运营平台",
      channelLabel: CHANNEL_LABEL[PaymentChannel.ADMIN],
      items: [
        {
          name: d.title,
          qty: 1,
          amountCny,
          credits: txn.amount.toDecimalPlaces(0).toNumber(),
        },
      ],
      totalCny: amountCny,
      amountUsdCents: null, // 人工充值无在线支付，无美元实收/汇率快照
      fxRate: null,
      totalCredits: txn.amount.toDecimalPlaces(0).toNumber(),
      amountUpper: withAmountUpper(amountCny),
      note: "本收据为后台人工充值补开凭证，金额以原支付渠道实际收款为准。",
    }
    const receipt = await this.createWithRetry({
      manualRef,
      userId,
      email: snapshot.payer.email,
      amountCny,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    })
    if (snapshot.payer.email) {
      await this.sendReceiptEmail(receipt.id).catch(e => {
        this.logger.warn(
          `sendReceiptEmail(claim) failed receipt=${receipt.receiptNo}: ${(e as Error).message}`
        )
      })
    }
    return receipt
  }

  /** 我的收据列表（分页） */
  async listMine(userId: number, page: number, pageSize: number) {
    const where = { userId }
    const [rows, total] = await Promise.all([
      this.prisma.receipt.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          receiptNo: true,
          orderId: true,
          email: true,
          amountCny: true,
          emailedAt: true,
          createdAt: true,
          snapshot: true,
        },
      }),
      this.prisma.receipt.count({ where }),
    ])
    const items = rows.map(r => {
      const s = r.snapshot as unknown as ReceiptSnapshot
      return {
        receiptNo: r.receiptNo,
        orderNo: s.orderNo,
        title: s.items[0]?.name ?? "充值收据",
        amountCny: Number(r.amountCny),
        channelLabel: s.channelLabel,
        provider: s.provider ?? "STRIPE",
        email: r.email,
        emailedAt: r.emailedAt,
        createdAt: r.createdAt,
      }
    })
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }

  /** 收据详情（含全部正文字段，供查看页/前端下载 PDF） */
  async getMine(userId: number, receiptNo: string) {
    const receipt = await this.prisma.receipt.findUnique({ where: { receiptNo } })
    if (!receipt || receipt.userId !== userId) throw new NotFoundException("收据不存在")
    return {
      receiptNo: receipt.receiptNo,
      email: receipt.email,
      amountCny: Number(receipt.amountCny),
      emailedAt: receipt.emailedAt,
      createdAt: receipt.createdAt,
      snapshot: receipt.snapshot,
    }
  }

  /** 收据网页渲染 HTML（查看/打印/前端下载 PDF 共用模板） */
  async renderMineHtml(userId: number, receiptNo: string): Promise<string> {
    const receipt = await this.prisma.receipt.findUnique({ where: { receiptNo } })
    if (!receipt || receipt.userId !== userId) throw new NotFoundException("收据不存在")
    return renderReceiptHtml(receipt.snapshot as unknown as ReceiptSnapshot)
  }

  /** 重发收据邮件；email 传入时改发新邮箱并回写收据接收邮箱（正文快照不变） */
  async resend(userId: number, receiptNo: string, email?: string) {
    const receipt = await this.prisma.receipt.findUnique({ where: { receiptNo } })
    if (!receipt || receipt.userId !== userId) throw new NotFoundException("收据不存在")
    if (email) {
      await this.prisma.receipt.update({ where: { id: receipt.id }, data: { email } })
    } else if (!receipt.email) {
      throw new BadRequestException("该收据无接收邮箱，请传入 email 指定接收邮箱")
    }
    return this.sendReceiptEmail(receipt.id)
  }

  /** 默认收据邮箱（收据中心展示）：用户设置的 receiptEmail，回落账号 email；均无 = 空串 */
  async getDefaultEmail(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, receiptEmail: true },
    })
    if (!user) throw new NotFoundException("用户不存在")
    return { email: user.receiptEmail || user.email || "" }
  }

  /** 设置默认收据邮箱（空串 = 清除，回落账号邮箱）；之后下单/补开不指定邮箱时用它 */
  async setDefaultEmail(userId: number, email: string) {
    const trimmed = email.trim()
    await this.prisma.user.update({
      where: { id: userId },
      data: { receiptEmail: trimmed || null },
    })
    return this.getDefaultEmail(userId)
  }

  /**
   * 收据 CSV 导出（带 BOM，Excel 中文不乱码），最多 5000 行。
   * 开具时间按 tz（IANA 时区名，如 Asia/Shanghai）格式化为 YYYY-MM-DD HH:mm:ss；缺省/非法回落 Asia/Shanghai。
   */
  async exportCsv(userId: number, tz?: string): Promise<string> {
    const rows = await this.prisma.receipt.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 5000,
    })
    const formatIssuedAt = issuedAtFormatter(tz)
    const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    const lines = ["收据编号,订单号,开具时间,项目,支付方式,金额,接收邮箱,是否发送"]
    for (const r of rows) {
      const s = r.snapshot as unknown as ReceiptSnapshot
      lines.push(
        [
          r.receiptNo,
          s.orderNo ?? "",
          formatIssuedAt(r.createdAt),
          escape(s.items[0]?.name ?? ""),
          escape(s.channelLabel),
          Number(r.amountCny).toFixed(2),
          escape(r.email),
          r.emailedAt ? "已发送" : "未发送",
        ].join(",")
      )
    }
    return "﻿" + lines.join("\n")
  }

  /** 生成 PDF 附件并邮寄；成功回写 emailedAt。邮箱注册用户（有 EmailAccount 行）用英文收据邮件 */
  private async sendReceiptEmail(receiptId: number) {
    const receipt = await this.prisma.receipt.findUnique({ where: { id: receiptId } })
    if (!receipt) throw new NotFoundException("收据不存在")
    const snapshot = receipt.snapshot as unknown as ReceiptSnapshot
    // EmailAccount 有行 = 邮箱注册用户（与 AuthEmailService 找回密码的权限闸门口径一致）
    const isEmailUser =
      (await this.prisma.emailAccount.findUnique({
        where: { userId: receipt.userId },
        select: { id: true },
      })) != null
    const lang: ReceiptLang = isEmailUser ? "en" : "zh"
    // 正文与附件同一模板同一渲染：勾为纯 CSS（QQ/163 邮箱正文实测正常），「✓ 已收款」整体绿色加粗
    const htmlMail = renderReceiptHtml(snapshot, lang)
    const pdfBuffer = this.pdf.available
      ? await this.pdf.renderPdf(renderReceiptHtml(snapshot, lang)).catch(e => {
          this.logger.warn(`renderPdf failed ${receipt.receiptNo}: ${(e as Error).message}`)
          return null
        })
      : null
    const result = await this.billingMail.sendReceiptMail({
      to: receipt.email,
      subject: isEmailUser
        ? `[SellerOS] Payment Receipt ${receipt.receiptNo}`
        : `【SellerOS】充值收据 ${receipt.receiptNo}`,
      html: htmlMail,
      pdfBuffer,
      pdfFilename: `receipt-${receipt.receiptNo}.pdf`,
    })
    await this.prisma.receipt.update({
      where: { id: receipt.id },
      data: { emailedAt: new Date() },
    })
    return { emailed: true, ...result }
  }

  /** 开票落库：收据编号 SR+时间戳+3 位随机，唯一冲突重试 5 次 */
  private async createWithRetry(data: {
    orderId?: number
    manualRef?: string
    userId: number
    email: string
    amountCny: number
    snapshot: Prisma.InputJsonValue
  }) {
    for (let i = 0; i < 5; i++) {
      const receiptNo = genSerialNo()
      try {
        // 快照内的 receiptNo 与行保持一致
        const snapshot = { ...(data.snapshot as unknown as ReceiptSnapshot), receiptNo }
        return await this.prisma.receipt.create({
          data: { ...data, receiptNo, snapshot: snapshot as unknown as Prisma.InputJsonValue },
        })
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue
        throw e
      }
    }
    throw new Error("收据编号生成冲突，请重试")
  }

  /** 由订单 + 明细 + 用户构建冻结快照 */
  private buildOrderSnapshot(
    order: BillingOrder & {
      items: BillingOrderItem[]
      user: {
        username: string
        email: string | null
        receiptEmail: string | null
        phone: string
        membershipLevel: MembershipLevel
      }
    }
  ): Omit<ReceiptSnapshot, "receiptNo"> & { receiptNo: string } {
    const totalCredits = order.creditsTotal ?? order.items.reduce((s, i) => s + (i.credits ?? 0), 0)
    return {
      receiptNo: "", // createWithRetry 时替换
      orderNo: order.orderNo,
      issuedAt: new Date().toISOString(),
      paidAt: (order.paidAt ?? order.settledAt ?? new Date()).toISOString(),
      payer: {
        username: order.user.username,
        level: TEAM_ORDER_TYPES.has(order.type)
          ? "企业管理员"
          : LEVEL_LABEL[order.user.membershipLevel],
        account: order.user.email || order.user.phone,
        title: TEAM_ORDER_TYPES.has(order.type)
          ? `${order.user.username}（企业）`
          : `${order.user.username}（个人）`,
        // 回落链：下单指定 > 默认收据邮箱（收据中心设置）> 账号邮箱
        email: order.receiptEmail || order.user.receiptEmail || order.user.email || "",
      },
      payee:
        order.paymentProvider === "ALLINPAY"
          ? this.config.get<string>("ALLINPAY_PAYEE")!
          : "SellerOS 跨境卖家运营平台",
      provider: order.paymentProvider,
      // 0 元单（个人转企业抵扣 ≥ 企业价）免支付直接结算、无支付渠道 → 「——」（与支付记录同口径）；
      // 有 channel 的在线支付单按渠道文案
      channelLabel:
        order.paymentProvider === "ALLINPAY" && order.channel === "CARD"
          ? "银行卡（云闪付扫码）"
          : order.channel
            ? CHANNEL_LABEL[order.channel]
            : "——",
      items: order.items.map(i => ({
        name: i.name,
        detail: i.detail ?? undefined,
        qty: i.qty,
        amountCny: Number(i.amountCny),
        credits: i.credits,
      })),
      totalCny: Number(order.amountCny),
      amountUsdCents: order.amountUsdCents, // 实收美元（美分，发起支付时落库的汇率折算快照）
      fxRate: order.fxRate?.toString() ?? null,
      totalCredits,
      amountUpper: withAmountUpper(Number(order.amountCny)),
      note: receiptNote(order.type),
    }
  }
}

/** 开具时间格式化器：YYYY-MM-DD HH:mm:ss，按 IANA 时区名；非法时区回落默认时区 */
const issuedAtFormatter = exportDateTimeFormatter

/** 收据备注（按订单类型说明积分有效期；不含发票管理文案） */
function receiptNote(type: BillingOrder["type"]): string {
  switch (type) {
    case "PLAN_NEW":
    case "PLAN_RENEW":
    case "PLAN_UPGRADE":
      return "套餐积分自到账起 30 天内有效，到期未用完自动清零。"
    case "PACK":
    case "CUSTOM":
      return "充值本金积分永久有效，用多少扣多少；赠送积分 30 天内有效。"
    default:
      return "积分有效期以账户明细为准。"
  }
}
