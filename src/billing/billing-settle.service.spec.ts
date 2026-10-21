import { Test } from "@nestjs/testing"
import { BillingOrderStatus, BillingOrderType, CreditTxnType } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { CreditService } from "../membership/credit.service"
import { PrismaService } from "../prisma/prisma.service"
import { TeamPoolService } from "../team/team-pool.service"
import { TeamService } from "../team/team.service"
import { BillingMailService } from "./billing-mail.service"
import { BillingSettleService } from "./billing-settle.service"
import { ReceiptsService } from "./receipts.service"

/** 结算：幂等（重复 webhook/乱序）、金额核对、入账动作按类型分发。 */
describe("BillingSettleService", () => {
  let service: BillingSettleService
  let prisma: {
    billingOrder: {
      findFirst: jest.Mock
      findUnique: jest.Mock
      updateMany: jest.Mock
      update: jest.Mock
    }
    team: { findUnique: jest.Mock; update: jest.Mock }
    teamMember: { findMany: jest.Mock; delete: jest.Mock }
    teamAuditLog: { create: jest.Mock }
    user: { findUnique: jest.Mock }
    $transaction: jest.Mock
  }
  let credit: {
    activateDuePlans: jest.Mock
    recordRecharge: jest.Mock
    renewImmediateInTx: jest.Mock
    upgradePlanImmediate: jest.Mock
    transferRechargeLotsToTeam: jest.Mock
    adjust: jest.Mock
  }
  let receipts: { issueForOrder: jest.Mock }
  let mail: { sendAlert: jest.Mock }
  let team: {
    createSelfServeTeam: jest.Mock
    renewTeamImmediateInTx: jest.Mock
    restoreTeam: jest.Mock
    audit: jest.Mock
    findOccupiedTeamId: jest.Mock
  }
  let teamPool: { grantPool: jest.Mock }

  const order = (over: Record<string, unknown> = {}) => ({
    id: 1,
    orderNo: "SR20260820000000001",
    userId: 7,
    type: BillingOrderType.PACK,
    status: BillingOrderStatus.PENDING,
    channel: "WECHAT",
    amountCny: new Decimal("100"),
    fxRate: new Decimal("7.2"),
    amountUsdCents: 1389, // 实收美元（美分）快照：发起支付时落库
    creditsTotal: 1100,
    snapshot: {
      kind: "pack",
      packId: 2,
      priceCny: "100",
      baseCredits: 1000,
      bonusCredits: 100,
    },
    items: [],
    ...over,
  })

  const domesticFields = {
    cusorderid: "SR20260820000000001",
    reqsn: "SR20260820000000001",
    trxid: "TL1",
    trxstatus: "0000",
    trxcode: "VSP501",
    initamt: "10000",
    trxamt: "10000",
  }

  it("通联有效支付沿用积分台账，EXPIRED 的延迟通知仍可结算", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue(
      order({
        paymentProvider: "ALLINPAY",
        allinpayReqsn: domesticFields.cusorderid,
        allinpayTrxid: "TL1",
        status: "EXPIRED",
      })
    )
    expect(await service.settleByAllinpay(domesticFields, "webhook")).toMatchObject({
      settled: true,
    })
    expect(credit.recordRecharge).toHaveBeenCalledTimes(1)
    expect(prisma.billingOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: expect.arrayContaining(["EXPIRED"]) } }),
      })
    )
  })

  it("通联重复通知不重复入账", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue(
      order({ paymentProvider: "ALLINPAY", allinpayTrxid: "TL1", status: "SETTLED" })
    )
    await service.settleByAllinpay(domesticFields, "webhook")
    expect(credit.recordRecharge).not.toHaveBeenCalled()
  })

  it.each(["VSP503", "VSP513", "VSP553"])("通联退款交易 %s 不触发购买入账", async trxcode => {
    expect(await service.settleByAllinpay({ ...domesticFields, trxcode }, "webhook")).toMatchObject(
      { settled: false }
    )
    expect(prisma.billingOrder.findUnique).not.toHaveBeenCalled()
  })

  it.each([{ trxamt: "9999" }, { initamt: "9999" }, { trxamt: "1e4" }])(
    "通联原金额或实收不符转人工",
    async fields => {
      prisma.billingOrder.findUnique.mockResolvedValue(
        order({ paymentProvider: "ALLINPAY", allinpayTrxid: "TL1" })
      )
      expect(
        await service.settleByAllinpay({ ...domesticFields, ...fields }, "query")
      ).toMatchObject({ reason: "amount_mismatch" })
      expect(credit.recordRecharge).not.toHaveBeenCalled()
      expect(mail.sendAlert).toHaveBeenCalled()
    }
  )

  it("通联错绑交易号或支付渠道不入账", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue(
      order({ paymentProvider: "ALLINPAY", allinpayTrxid: "OTHER" })
    )
    await expect(service.settleByAllinpay(domesticFields, "webhook")).rejects.toThrow("绑定")
    prisma.billingOrder.findUnique.mockResolvedValue(
      order({ paymentProvider: "ALLINPAY", allinpayTrxid: "TL1", channel: "CARD" })
    )
    await expect(service.settleByAllinpay(domesticFields, "webhook")).rejects.toThrow("绑定")
    expect(credit.recordRecharge).not.toHaveBeenCalled()
  })

  it("通联也复核个人充值资格，不向已入企业的旧单发积分", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue(
      order({ paymentProvider: "ALLINPAY", allinpayTrxid: "TL1" })
    )
    team.findOccupiedTeamId.mockResolvedValue(10)
    expect(await service.settleByAllinpay(domesticFields, "webhook")).toMatchObject({
      settled: false,
    })
    expect(credit.recordRecharge).not.toHaveBeenCalled()
  })

  it("Stripe 事件不得结算通联订单", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(order({ paymentProvider: "ALLINPAY" }))
    expect(
      await service.settleByPaymentIntent({ id: "pi_1", amount: 1389 }, "webhook")
    ).toMatchObject({ reason: "provider_mismatch" })
    expect(credit.recordRecharge).not.toHaveBeenCalled()
  })

  beforeEach(async () => {
    prisma = {
      billingOrder: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      team: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      // 默认无 DISABLED 成员关系（个人套餐结算的自动移出为 no-op）；相关用例按需覆盖
      teamMember: {
        findMany: jest.fn().mockResolvedValue([]),
        delete: jest.fn().mockResolvedValue({}),
      },
      teamAuditLog: { create: jest.fn().mockResolvedValue({}) },
      // 互斥单结算复核用：P2T 比对个人套餐快照（默认无个人订阅=与「无套餐」快照一致）
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
    }
    credit = {
      activateDuePlans: jest.fn().mockResolvedValue({ activated: 0 }),
      recordRecharge: jest.fn().mockResolvedValue(undefined),
      renewImmediateInTx: jest.fn().mockResolvedValue({ expiresAt: new Date() }),
      upgradePlanImmediate: jest.fn().mockResolvedValue(null),
      transferRechargeLotsToTeam: jest.fn().mockResolvedValue(undefined),
      adjust: jest.fn().mockResolvedValue(undefined),
    }
    receipts = { issueForOrder: jest.fn().mockResolvedValue({}) }
    mail = { sendAlert: jest.fn().mockResolvedValue(undefined) }
    team = {
      createSelfServeTeam: jest.fn().mockResolvedValue({ id: 10, expiresAt: new Date() }),
      renewTeamImmediateInTx: jest.fn().mockResolvedValue({ expiresAt: new Date() }),
      restoreTeam: jest.fn().mockResolvedValue({
        teamId: 10,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() + 30 * 86400000),
        restoredMemberIds: [7],
        skippedMembers: [],
      }),
      audit: jest.fn().mockResolvedValue({}),
      // 互斥单结算复核：默认未归属任何企业（放行）；占用中用例按需覆盖
      findOccupiedTeamId: jest.fn().mockResolvedValue(null),
    }
    teamPool = { grantPool: jest.fn().mockResolvedValue(undefined) }

    const moduleRef = await Test.createTestingModule({
      providers: [
        BillingSettleService,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: credit },
        { provide: ReceiptsService, useValue: receipts },
        { provide: BillingMailService, useValue: mail },
        { provide: TeamService, useValue: team },
        { provide: TeamPoolService, useValue: teamPool },
      ],
    }).compile()
    service = moduleRef.get(BillingSettleService)
  })

  it("PACK 入账：本金进 RECHARGE（永不过期）+ 赠送进 GIFT（30 天）→ SETTLED → 开票", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(order())
    const res = await service.settleByPaymentIntent(
      { id: "pi_1", amount: 1389, orderNo: "SR20260820000000001" },
      "webhook"
    )
    expect(res.settled).toBe(true)
    const call = credit.recordRecharge.mock.calls[0] as unknown as [
      number,
      { lots: { bucket: string; amount: number; expiresAt: Date | null }[] },
      unknown,
    ]
    expect(call[0]).toBe(7)
    expect(call[1].lots[0]).toMatchObject({ bucket: "RECHARGE", amount: 1000, expiresAt: null })
    expect(call[1].lots[1].bucket).toBe("GIFT")
    expect(call[1].lots[1].amount).toBe(100)
    expect(call[1].lots[1].expiresAt).toBeInstanceOf(Date) // 30 天过期
    // 抢占 + SETTLED
    const claim = prisma.billingOrder.updateMany.mock.calls[0] as unknown as [
      { data: { status: string } },
    ]
    expect(claim[0].data.status).toBe("PAID")
    const settled = prisma.billingOrder.update.mock.calls[0] as unknown as [
      { data: { status: string } },
    ]
    expect(settled[0].data.status).toBe("SETTLED")
    expect(receipts.issueForOrder).toHaveBeenCalledWith(1)
  })

  it("幂等：订单已 SETTLED → 直接返回，不走事务", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(order({ status: BillingOrderStatus.SETTLED }))
    const res = await service.settleByPaymentIntent({ id: "pi_1", amount: 1389 }, "webhook")
    expect(res).toMatchObject({ settled: true, already: true })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("幂等：并发事件抢占失败（claim count=0）→ 视为已处理", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(order())
    prisma.billingOrder.updateMany.mockResolvedValue({ count: 0 })
    const res = await service.settleByPaymentIntent({ id: "pi_1", amount: 1389 }, "webhook")
    expect(res).toMatchObject({ settled: true, already: true })
    expect(credit.recordRecharge).not.toHaveBeenCalled()
    expect(receipts.issueForOrder).not.toHaveBeenCalled()
  })

  it("金额不符 → ABANDONED + 告警，绝不入账", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(order())
    const res = await service.settleByPaymentIntent({ id: "pi_1", amount: 9999 }, "webhook")
    expect(res).toMatchObject({ settled: false, reason: "amount_mismatch" })
    const abandoned = prisma.billingOrder.updateMany.mock.calls[0] as unknown as [
      { data: { status: string } },
    ]
    expect(abandoned[0].data.status).toBe("ABANDONED")
    expect(mail.sendAlert).toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("amountUsdCents 为 null（未发起支付）→ 按金额不符处理走告警", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(order({ amountUsdCents: null }))
    const res = await service.settleByPaymentIntent({ id: "pi_1", amount: 1389 }, "webhook")
    expect(res).toMatchObject({ settled: false, reason: "amount_mismatch" })
    expect(mail.sendAlert).toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("防串单：事件 PI 与订单原绑定不一致 → 拒绝结算 + 告警，订单状态不动", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(order({ stripePaymentIntentId: "pi_bound" }))
    const res = await service.settleByPaymentIntent(
      { id: "pi_other", amount: 1389, currency: "usd", orderNo: "SR20260820000000001" },
      "webhook"
    )
    expect(res).toMatchObject({ settled: false, reason: "pi_mismatch" })
    expect(mail.sendAlert).toHaveBeenCalled()
    expect(prisma.billingOrder.updateMany).not.toHaveBeenCalled() // 不动订单状态（不置 ABANDONED）
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(credit.recordRecharge).not.toHaveBeenCalled()
  })

  it("币种不符（实收非 USD）→ ABANDONED + 告警，绝不入账", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(order({ stripePaymentIntentId: "pi_1" }))
    const res = await service.settleByPaymentIntent(
      { id: "pi_1", amount: 1389, currency: "cny", orderNo: "SR20260820000000001" },
      "webhook"
    )
    expect(res).toMatchObject({ settled: false, reason: "currency_mismatch" })
    const abandoned = prisma.billingOrder.updateMany.mock.calls[0] as unknown as [
      { data: { status: string } },
    ]
    expect(abandoned[0].data.status).toBe("ABANDONED")
    expect(mail.sendAlert).toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(credit.recordRecharge).not.toHaveBeenCalled()
  })

  it("币种一致（usd）+ 绑定一致 → 正常结算", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(order({ stripePaymentIntentId: "pi_1" }))
    const res = await service.settleByPaymentIntent(
      { id: "pi_1", amount: 1389, currency: "usd", orderNo: "SR20260820000000001" },
      "webhook"
    )
    expect(res.settled).toBe(true)
    expect(credit.recordRecharge).toHaveBeenCalled()
  })

  it("PLAN_NEW：走立即续费内核（有效期顺延 + 积分立即到账）", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({
        type: BillingOrderType.PLAN_NEW,
        amountUsdCents: 5542,
        snapshot: {
          kind: "plan",
          tier: 2,
          planName: "Plus",
          priceCny: "399",
          packageCredits: 4000,
          giftCredits: 600,
          periodDays: 30,
        },
      })
    )
    await service.settleByPaymentIntent({ id: "pi_1", amount: 5542 }, "webhook")
    const call = credit.renewImmediateInTx.mock.calls[0] as unknown as [
      unknown,
      number,
      { tier: number; packageCredits: number; giftCredits: number },
    ]
    expect(call[1]).toBe(7)
    expect(call[2]).toMatchObject({ tier: 2, packageCredits: 4000, giftCredits: 600 })
  })

  it("PLAN_NEW：购买人是 DISABLED 企业成员 → 自动移出（删成员行 + 审计 actorId=0）；非停用不动", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({
        type: BillingOrderType.PLAN_NEW,
        amountUsdCents: 5542,
        snapshot: {
          kind: "plan",
          tier: 1,
          planName: "Explorer",
          priceCny: "199",
          packageCredits: 2000,
          giftCredits: 200,
          periodDays: 30,
        },
      })
    )
    prisma.teamMember.findMany.mockResolvedValue([{ teamId: 5 }])

    await service.settleByPaymentIntent({ id: "pi_1", amount: 5542 }, "webhook")

    expect(prisma.teamMember.delete).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: 5, userId: 7 } },
    })
    const audit = prisma.teamAuditLog.create.mock.calls[0] as unknown as [
      { data: { teamId: number; actorId: number; action: string; meta: { userId: number } } },
    ]
    expect(audit[0].data).toMatchObject({
      teamId: 5,
      actorId: 0,
      action: "MEMBER_REMOVE",
      meta: { userId: 7 },
    })
  })

  it("PLAN_UPGRADE：整月积分差 + 到期日不变", async () => {
    const expiresAt = new Date(Date.now() + 3 * 86400000).toISOString()
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({
        type: BillingOrderType.PLAN_UPGRADE,
        amountUsdCents: 4166,
        snapshot: {
          kind: "upgrade",
          fromTier: 2,
          toTier: 3,
          planName: "Ultra",
          creditsDiff: 4400,
          packageDiff: 3000,
          giftDiff: 1400,
          expiresAt,
        },
      })
    )
    await service.settleByPaymentIntent({ id: "pi_1", amount: 4166 }, "webhook")
    const call = credit.upgradePlanImmediate.mock.calls[0] as unknown as [
      number,
      { fromTier: number; toTier: number; packageDiff: number; giftDiff: number; expiresAt: Date },
    ]
    expect(call[0]).toBe(7)
    expect(call[1]).toMatchObject({ fromTier: 2, toTier: 3, packageDiff: 3000, giftDiff: 1400 })
    expect(call[1].expiresAt.toISOString()).toBe(expiresAt)
  })

  it("TEAM_PLAN：建队 + 池入账（套餐/赠送）+ 订单回写 teamId", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({
        type: BillingOrderType.TEAM_PLAN,
        amountUsdCents: 19900,
        snapshot: {
          kind: "team_plan",
          teamTier: 2,
          planName: "Flagship",
          seats: 20,
          priceCny: "2999",
          poolPackageCredits: 30000,
          poolGiftCredits: 6000,
          periodDays: 30,
          teamName: "Acme",
        },
      })
    )
    await service.settleByPaymentIntent({ id: "pi_1", amount: 19900 }, "webhook")
    expect(team.createSelfServeTeam).toHaveBeenCalledWith(
      { name: "Acme", adminUserId: 7, tier: 2, seats: 20, periodDays: 30 },
      prisma
    )
    const grant = teamPool.grantPool.mock.calls[0] as unknown as [
      number,
      { packageCredits?: number; giftCredits?: number; type?: CreditTxnType; meta?: unknown },
      unknown,
    ]
    expect(grant[0]).toBe(10)
    // 团队新购：流水类型归「套餐订阅」，meta 带 tier/name 供项目列展示
    expect(grant[1]).toMatchObject({
      packageCredits: 30000,
      giftCredits: 6000,
      type: CreditTxnType.RECHARGE_PLAN,
    })
    expect(grant[1].meta).toMatchObject({ tier: 2, name: "Flagship" })
    // 订单回写 teamId（建队后才知道）
    const updateCalls = prisma.billingOrder.update.mock.calls as unknown as Array<
      [{ data: Record<string, unknown> }]
    >
    const writeBack = updateCalls.find(c => c[0].data.teamId === 10)
    expect(writeBack).toBeTruthy()
    // 快照无 packChoice（老单/keep）→ 不动个人充值批次
    expect(credit.transferRechargeLotsToTeam).not.toHaveBeenCalled()
  })

  it("TEAM_PLAN packChoice=inject：个人 RECHARGE 存量注入共享池（并入结算事务）", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({
        type: BillingOrderType.TEAM_PLAN,
        amountUsdCents: 19900,
        snapshot: {
          kind: "team_plan",
          teamTier: 2,
          planName: "Flagship",
          seats: 20,
          priceCny: "2999",
          poolPackageCredits: 30000,
          poolGiftCredits: 6000,
          periodDays: 30,
          teamName: "Acme",
          packChoice: "inject",
        },
      })
    )
    await service.settleByPaymentIntent({ id: "pi_1", amount: 19900 }, "webhook")
    expect(credit.transferRechargeLotsToTeam).toHaveBeenCalledWith(
      7,
      10,
      expect.objectContaining({ source: "billing.order" }),
      prisma
    )
  })

  it("TEAM_RENEW：ACTIVE → 立即续费入账；GRACE → 恢复 + 本期池积分立即入账", async () => {
    const snap = {
      kind: "team_renew",
      teamId: 10,
      teamTier: 1,
      planName: "Standard",
      priceCny: "1299",
      poolPackageCredits: 10000,
      poolGiftCredits: 1000,
      periodDays: 30,
    }
    // ACTIVE：立即续费（有效期顺延 + 池积分立即入账，由 TeamService 内部完成）
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({ type: BillingOrderType.TEAM_RENEW, amountUsdCents: 9900, teamId: 10, snapshot: snap })
    )
    prisma.team.findUnique.mockResolvedValue({ id: 10, status: "ACTIVE", tier: 1 })
    await service.settleByPaymentIntent({ id: "pi_1", amount: 9900 }, "webhook")
    expect(team.renewTeamImmediateInTx).toHaveBeenCalledWith(
      prisma,
      10,
      expect.objectContaining({ tier: 1, poolPackageCredits: 10000, poolGiftCredits: 1000 }),
      expect.any(Date),
      expect.objectContaining({ source: "billing.order" })
    )
    expect(team.restoreTeam).not.toHaveBeenCalled()

    // GRACE：恢复 + 立即入账
    jest.clearAllMocks()
    prisma.billingOrder.updateMany.mockResolvedValue({ count: 1 })
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma))
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({ type: BillingOrderType.TEAM_RENEW, amountUsdCents: 9900, teamId: 10, snapshot: snap })
    )
    prisma.team.findUnique.mockResolvedValue({ id: 10, status: "GRACE", tier: 1 })
    await service.settleByPaymentIntent({ id: "pi_2", amount: 9900 }, "webhook")
    expect(team.restoreTeam).toHaveBeenCalledWith(10, 30, 7, prisma)
    const grant = teamPool.grantPool.mock.calls[0] as unknown as [
      number,
      { packageCredits?: number; packageExpiresAt?: Date; type?: CreditTxnType },
      unknown,
    ]
    expect(grant[0]).toBe(10)
    expect(grant[1].packageCredits).toBe(10000)
    expect(grant[1].packageExpiresAt).toBeInstanceOf(Date)
    // 恢复续费：流水类型归「套餐订阅」
    expect(grant[1].type).toBe(CreditTxnType.RECHARGE_PLAN)
  })

  it("TEAM_SEAT_UPGRADE：池积分差入账（跟随原到期日）+ 切档/席位 + 审计", async () => {
    const expiresAt = new Date(Date.now() + 10 * 86400000).toISOString()
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({
        type: BillingOrderType.TEAM_SEAT_UPGRADE,
        amountUsdCents: 10000,
        teamId: 10,
        snapshot: {
          kind: "team_seat_upgrade",
          teamId: 10,
          fromTier: 1,
          toTier: 2,
          planName: "Flagship",
          seats: 20,
          creditsDiff: 25000,
          packageDiff: 20000,
          giftDiff: 5000,
          expiresAt,
        },
      })
    )
    prisma.team.findUnique.mockResolvedValue({ id: 10, status: "ACTIVE", tier: 1 })
    await service.settleByPaymentIntent({ id: "pi_1", amount: 10000 }, "webhook")
    const grant = teamPool.grantPool.mock.calls[0] as unknown as [
      number,
      {
        packageCredits?: number
        giftCredits?: number
        packageExpiresAt?: Date
        type?: CreditTxnType
        meta?: unknown
      },
      unknown,
    ]
    expect(grant[1].packageCredits).toBe(20000)
    expect(grant[1].giftCredits).toBe(5000)
    expect(grant[1].packageExpiresAt?.toISOString()).toBe(expiresAt)
    // 席位升级：流水类型归「套餐升级」（RECHARGE_PLAN + meta.upgrade，与个人升级同口径）
    expect(grant[1].type).toBe(CreditTxnType.RECHARGE_PLAN)
    expect(grant[1].meta).toMatchObject({ upgrade: true, tier: 2, fromTier: 1 })
    expect(prisma.team.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { tier: 2, seats: 20 },
    })
    expect(team.audit).toHaveBeenCalledWith(
      prisma,
      10,
      7,
      "TEAM_SEAT_UPGRADE",
      expect.objectContaining({ fromTier: 1, toTier: 2 })
    )
  })

  it("TEAM_SEAT_UPGRADE：套餐档已变化 → 事务回滚并告警", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({
        type: BillingOrderType.TEAM_SEAT_UPGRADE,
        amountUsdCents: 10000,
        teamId: 10,
        snapshot: {
          kind: "team_seat_upgrade",
          teamId: 10,
          fromTier: 1,
          toTier: 2,
          planName: "Flagship",
          seats: 20,
          creditsDiff: 25000,
          expiresAt: new Date().toISOString(),
        },
      })
    )
    prisma.team.findUnique.mockResolvedValue({ id: 10, status: "ACTIVE", tier: 2 })
    await expect(
      service.settleByPaymentIntent({ id: "pi_1", amount: 10000 }, "webhook")
    ).rejects.toThrow("已变化")
    expect(teamPool.grantPool).not.toHaveBeenCalled()
    expect(mail.sendAlert).toHaveBeenCalled()
  })

  it("TEAM_PACK：本金 RECHARGE + 赠送 GIFT 入共享池 + 审计", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({
        type: BillingOrderType.TEAM_PACK,
        amountUsdCents: 5000,
        teamId: 10,
        snapshot: {
          kind: "team_pack",
          teamId: 10,
          packId: 3,
          priceCny: "500",
          baseCredits: 5000,
          bonusCredits: 500,
        },
      })
    )
    await service.settleByPaymentIntent({ id: "pi_1", amount: 5000 }, "webhook")
    const grant = teamPool.grantPool.mock.calls[0] as unknown as [
      number,
      { rechargeCredits?: number; giftCredits?: number; type?: CreditTxnType },
      unknown,
    ]
    expect(grant[0]).toBe(10)
    // 团队充值包：流水类型归「充值包」
    expect(grant[1]).toMatchObject({
      rechargeCredits: 5000,
      giftCredits: 500,
      type: CreditTxnType.RECHARGE_PACK,
    })
    expect(team.audit).toHaveBeenCalledWith(
      prisma,
      10,
      7,
      "POOL_RECHARGE",
      expect.objectContaining({ packId: 3 })
    )
  })

  it("PERSONAL_TO_TEAM：inject → 个人充值包注入共享池；keep → 不动", async () => {
    const snap = {
      kind: "personal_to_team",
      teamTier: 1,
      planName: "Standard",
      seats: 5,
      priceCny: "1299",
      poolPackageCredits: 10000,
      poolGiftCredits: 1000,
      periodDays: 30,
      teamName: null,
      packChoice: "inject",
      offsetCny: "200",
    }
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({
        type: BillingOrderType.PERSONAL_TO_TEAM,
        amountUsdCents: 7900,
        packChoice: "inject",
        snapshot: snap,
      })
    )
    await service.settleByPaymentIntent({ id: "pi_1", amount: 7900 }, "webhook")
    expect(team.createSelfServeTeam).toHaveBeenCalled()
    // 个人转企业：池入账归「套餐订阅」，meta.personalToTeam 标记项目列后缀
    const p2tGrant = teamPool.grantPool.mock.calls[0] as unknown as [
      number,
      { type?: CreditTxnType; meta?: unknown },
      unknown,
    ]
    expect(p2tGrant[1].type).toBe(CreditTxnType.RECHARGE_PLAN)
    expect(p2tGrant[1].meta).toMatchObject({ personalToTeam: true, tier: 1, name: "Standard" })
    expect(credit.transferRechargeLotsToTeam).toHaveBeenCalledWith(
      7,
      10,
      expect.objectContaining({ source: "billing.order" }),
      prisma // 已并入 settle 事务（建队/折抵/清零/返还/结算同生共死）
    )

    jest.clearAllMocks()
    prisma.billingOrder.updateMany.mockResolvedValue({ count: 1 })
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma))
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({
        type: BillingOrderType.PERSONAL_TO_TEAM,
        amountUsdCents: 9900,
        packChoice: "keep",
        snapshot: { ...snap, packChoice: "keep", offsetCny: "0" },
      })
    )
    await service.settleByPaymentIntent({ id: "pi_2", amount: 9900 }, "webhook")
    expect(credit.transferRechargeLotsToTeam).not.toHaveBeenCalled()
    // 快照无 refundCredits（抵扣 ≤ 企业价）→ 不返还
    expect(credit.adjust).not.toHaveBeenCalled()
  })

  it("0 元单（P2T 抵扣 ≥ 企业价）：免支付直接结算 + inject 之后按快照返还 RECHARGE 积分 + 开票", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue(
      order({
        type: BillingOrderType.PERSONAL_TO_TEAM,
        amountCny: new Decimal("0"),
        amountUsdCents: 0,
        creditsTotal: 11000,
        snapshot: {
          kind: "personal_to_team",
          teamTier: 1,
          planName: "Standard",
          seats: 5,
          priceCny: "1299",
          poolPackageCredits: 10000,
          poolGiftCredits: 1000,
          periodDays: 30,
          teamName: null,
          packChoice: "keep",
          offsetCny: "2314",
          appliedOffsetCny: "1299",
          refundCny: "1015",
          refundCredits: 10150,
          personalTier: 3,
          personalPriceCny: "699",
          personalExpiresAt: "2027-01-15T00:00:00.000Z",
          remainingDays: 147.2,
          remainingCredits: "29800",
          factor: "3.3111",
        },
      })
    )
    // 互斥复核：个人套餐状态与建单快照一致（tier=3 / 2027-01-15 到期）才放行
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: 3,
      subscriptionExpiresAt: new Date("2027-01-15T00:00:00.000Z"),
    })
    const res = await service.settleZeroAmountOrder("SR20260820000000001")
    expect(res.settled).toBe(true)
    expect(team.createSelfServeTeam).toHaveBeenCalled()
    // 返还：inject(keep 不注入) 之后 adjust 入个人 RECHARGE；source/sourceRef 关联订单，meta 全套留痕
    const adjustCall = credit.adjust.mock.calls[0] as unknown as [
      number,
      number,
      { source: string; sourceRef: string; meta: Record<string, unknown> },
      unknown,
    ]
    expect(adjustCall[0]).toBe(7)
    expect(adjustCall[1]).toBe(10150)
    expect(adjustCall[2].source).toBe("billing.p2t.refund")
    expect(adjustCall[2].sourceRef).toBe("SR20260820000000001")
    expect(adjustCall[2].meta).toMatchObject({
      reason: "个人套餐转企业套餐差额返还",
      personalTier: 3,
      refundCny: "1015",
      refundCredits: 10150,
    })
    expect(receipts.issueForOrder).toHaveBeenCalledWith(1)
  })

  it("0 元单 packChoice=inject：超额返还注入团队共享池（TEAM_RECHARGE），不写个人户", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue(
      order({
        type: BillingOrderType.PERSONAL_TO_TEAM,
        amountCny: new Decimal("0"),
        amountUsdCents: 0,
        creditsTotal: 11000,
        packChoice: "inject",
        snapshot: {
          kind: "personal_to_team",
          teamTier: 1,
          planName: "Standard",
          seats: 5,
          priceCny: "1299",
          poolPackageCredits: 10000,
          poolGiftCredits: 1000,
          periodDays: 30,
          teamName: null,
          packChoice: "inject",
          offsetCny: "2314",
          appliedOffsetCny: "1299",
          refundCny: "1015",
          refundCredits: 10150,
          personalTier: 3,
          personalPriceCny: "699",
          personalExpiresAt: "2027-01-15T00:00:00.000Z",
          remainingDays: 147.2,
          remainingCredits: "29800",
          factor: "3.3111",
        },
      })
    )
    // 互斥复核：个人套餐状态与建单快照一致（tier=3 / 2027-01-15 到期）才放行
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: 3,
      subscriptionExpiresAt: new Date("2027-01-15T00:00:00.000Z"),
    })
    await service.settleZeroAmountOrder("SR20260820000000001")
    expect(credit.adjust).not.toHaveBeenCalled() // 不走个人户
    // grantPool 两次：① 池套餐/赠送入账 ② 超额返还注入（RECHARGE，p2tRefund 标记）
    const refundGrant = teamPool.grantPool.mock.calls[1] as unknown as [
      number,
      { rechargeCredits?: number; type?: CreditTxnType; meta?: unknown },
      unknown,
    ]
    expect(refundGrant[0]).toBe(10)
    expect(refundGrant[1].rechargeCredits).toBe(10150)
    expect(refundGrant[1].type).toBe(CreditTxnType.TEAM_RECHARGE)
    expect(refundGrant[1].meta).toMatchObject({ p2tRefund: true, refundCny: "1015" })
  })

  it("0 元单：非 0 元拒绝走支付渠道；已入账幂等返回", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue(order()) // amountCny=100
    await expect(service.settleZeroAmountOrder("SR20260820000000001")).rejects.toThrow(
      "非 0 元订单"
    )
    prisma.billingOrder.findUnique.mockResolvedValue(order({ status: BillingOrderStatus.SETTLED }))
    const res = await service.settleZeroAmountOrder("SR20260820000000001")
    expect(res).toEqual({ settled: true, already: true })
    expect(credit.recordRecharge).not.toHaveBeenCalled()
  })

  it("互斥复核：个人套餐单结算时用户已归属企业 → ABANDONED + 告警，不入账", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({
        type: BillingOrderType.PLAN_RENEW,
        snapshot: {
          kind: "plan",
          tier: 2,
          planName: "Plus",
          priceCny: "399",
          packageCredits: 4000,
          giftCredits: 600,
          periodDays: 30,
        },
      })
    )
    team.findOccupiedTeamId.mockResolvedValue(10) // 下单后被拉入企业/已建队
    const res = await service.settleByPaymentIntent(
      { id: "pi_1", amount: 1389, orderNo: "SR20260820000000001" },
      "webhook"
    )
    expect(res).toEqual({ settled: false, reason: "state_changed" })
    expect(prisma.billingOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: { notIn: [BillingOrderStatus.SETTLED] } },
      data: { status: BillingOrderStatus.ABANDONED },
    })
    expect(mail.sendAlert).toHaveBeenCalled()
    expect(credit.renewImmediateInTx).not.toHaveBeenCalled() // 绝不给企业成员恢复个人订阅
  })

  it("互斥复核：个人充值单（PACK）结算时用户已归属企业 → ABANDONED + 告警，不入账（2026-09-01 收口，废 8-29「成员允许个人充值」定稿）", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(order()) // 默认即 PACK 单
    team.findOccupiedTeamId.mockResolvedValue(10) // 下单后支付前被拉入企业/转了企业（PI 已建、旧页面完成支付的尾部竞态）
    const res = await service.settleByPaymentIntent(
      { id: "pi_1", amount: 1389, orderNo: "SR20260820000000001" },
      "webhook"
    )
    expect(res.settled).toBe(false)
    expect(prisma.billingOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: { notIn: [BillingOrderStatus.SETTLED] } },
      data: { status: BillingOrderStatus.ABANDONED },
    })
    expect(mail.sendAlert).toHaveBeenCalled()
    expect(credit.recordRecharge).not.toHaveBeenCalled() // 款已收未入账，转人工退款/补偿
  })

  it("互斥复核：个人充值单（PACK）结算时仍是纯个人 → 正常入账", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(order())
    team.findOccupiedTeamId.mockResolvedValue(null)
    const res = await service.settleByPaymentIntent(
      { id: "pi_1", amount: 1389, orderNo: "SR20260820000000001" },
      "webhook"
    )
    expect(res.settled).toBe(true)
    expect(credit.recordRecharge).toHaveBeenCalled()
  })

  it("互斥复核：P2T 下单后个人续费先到账（快照失真）→ ABANDONED，不按旧快照结算", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({
        type: BillingOrderType.PERSONAL_TO_TEAM,
        amountUsdCents: 7900,
        snapshot: {
          kind: "personal_to_team",
          teamTier: 1,
          planName: "Standard",
          seats: 5,
          priceCny: "1299",
          poolPackageCredits: 10000,
          poolGiftCredits: 1000,
          periodDays: 30,
          teamName: null,
          packChoice: "keep",
          offsetCny: "200",
          appliedOffsetCny: "200",
          refundCny: "0",
          refundCredits: 0,
          personalTier: 2,
          personalPriceCny: "399",
          personalExpiresAt: "2026-09-01T00:00:00.000Z",
          remainingDays: 5,
          remainingCredits: "4600",
          factor: "0.1667",
        },
      })
    )
    // 个人续费先到账：到期日从 09-01 顺延到 10-01 → 与快照不一致
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: 2,
      subscriptionExpiresAt: new Date("2026-10-01T00:00:00.000Z"),
    })
    const res = await service.settleByPaymentIntent({ id: "pi_1", amount: 7900 }, "webhook")
    expect(res).toEqual({ settled: false, reason: "state_changed" })
    expect(team.createSelfServeTeam).not.toHaveBeenCalled() // 不得建队
    expect(mail.sendAlert).toHaveBeenCalled()
  })

  it("互斥复核：P2T 快照与当前个人状态一致 → 正常建队入账", async () => {
    prisma.billingOrder.findFirst.mockResolvedValue(
      order({
        type: BillingOrderType.PERSONAL_TO_TEAM,
        amountUsdCents: 7900,
        snapshot: {
          kind: "personal_to_team",
          teamTier: 1,
          planName: "Standard",
          seats: 5,
          priceCny: "1299",
          poolPackageCredits: 10000,
          poolGiftCredits: 1000,
          periodDays: 30,
          teamName: null,
          packChoice: "keep",
          offsetCny: "200",
          appliedOffsetCny: "200",
          refundCny: "0",
          refundCredits: 0,
          personalTier: 2,
          personalPriceCny: "399",
          personalExpiresAt: "2026-09-01T00:00:00.000Z",
          remainingDays: 5,
          remainingCredits: "4600",
          factor: "0.1667",
        },
      })
    )
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: 2,
      subscriptionExpiresAt: new Date("2026-09-01T00:00:00.000Z"),
    })
    const res = await service.settleByPaymentIntent({ id: "pi_1", amount: 7900 }, "webhook")
    expect(res.settled).toBe(true)
    expect(team.createSelfServeTeam).toHaveBeenCalled()
  })
})
