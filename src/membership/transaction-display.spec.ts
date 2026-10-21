import { CreditBucket, CreditDirection, CreditTxnType, ScheduledPlanStatus } from "@prisma/client"
import {
  collectScheduledPlanIds,
  deriveLifecycle,
  describeTransaction,
} from "./transaction-display"

describe("describeTransaction", () => {
  it("套餐：项目=Lv.x 名称 月度套餐、类型=套餐订阅、金额取 meta.priceCny", () => {
    expect(
      describeTransaction({
        type: CreditTxnType.RECHARGE_PLAN,
        source: "admin.recharge.plan",
        meta: { tier: 2, name: "Plus", priceCny: 399 },
      })
    ).toEqual({
      category: "套餐订阅",
      title: "Lv.2 Plus 月度套餐",
      amountCny: 399,
      status: "COMPLETED",
    })
  })

  it("套餐升级：meta.upgrade → 类型=套餐升级、项目末尾加【套餐升级】、金额取差价 priceCny", () => {
    expect(
      describeTransaction({
        type: CreditTxnType.RECHARGE_PLAN,
        source: "admin.recharge.plan",
        meta: { tier: 3, name: "Ultra", upgrade: true, fromTier: 2, priceCny: 30 },
      })
    ).toEqual({
      category: "套餐升级",
      title: "Lv.3 Ultra 月度套餐【套餐升级】",
      amountCny: 30,
      status: "COMPLETED",
    })
  })

  it("套餐：无套餐名回退 Lvx 月度套餐", () => {
    expect(
      describeTransaction({
        type: CreditTxnType.RECHARGE_PLAN,
        source: "admin.recharge.plan",
        meta: { tier: 3, priceCny: 699 },
      }).title
    ).toBe("Lv.3 月度套餐")
  })

  it("充值包：项目=¥x 充值包（本金+赠送）、类型=充值包、金额取 priceCny", () => {
    expect(
      describeTransaction({
        type: CreditTxnType.RECHARGE_PACK,
        source: "admin.recharge.pack",
        meta: { packId: 2, priceCny: 1000, baseCredits: 10000, bonusCredits: 2500 },
      })
    ).toEqual({
      category: "充值包",
      title: "¥1000 充值包（10000+赠2500）",
      amountCny: 1000,
      status: "COMPLETED",
    })
  })

  it("自定义充值：项目=¥x 自定义充值（本金+赠送）", () => {
    expect(
      describeTransaction({
        type: CreditTxnType.RECHARGE_CUSTOM,
        source: "admin.recharge.custom",
        meta: { priceCny: 200, baseCredits: 2000, bonusCredits: 200 },
      }).title
    ).toBe("¥200 自定义充值（2000+赠200）")
  })

  it("老数据无 meta.priceCny：本金桶(RECHARGE)按积分÷10 反推充值金额", () => {
    const d = describeTransaction({
      type: CreditTxnType.RECHARGE_CUSTOM,
      source: "admin.recharge.custom",
      meta: null,
      amount: "20000",
      bucket: CreditBucket.RECHARGE,
    })
    expect(d.amountCny).toBe(2000)
    expect(d.title).toBe("¥2000 自定义充值") // 无本金/赠送明细时不带后缀
  })

  it("注册赠送：邀请注册=邀请注册赠送积分 / 后台建号=注册赠送积分、类型=注册赠送、金额 null", () => {
    expect(
      describeTransaction({ type: CreditTxnType.SIGNUP_BONUS, source: "invite.signup", meta: null })
    ).toEqual({
      category: "注册赠送",
      title: "邀请注册赠送积分",
      amountCny: null,
      status: "COMPLETED",
    })
    expect(
      describeTransaction({ type: CreditTxnType.SIGNUP_BONUS, source: "admin.create", meta: null })
        .title
    ).toBe("注册赠送积分")
  })

  it("手动调额：类型=项目均固定「手动调整」、不把备注塞进 title、金额 null", () => {
    const d = describeTransaction({
      type: CreditTxnType.MANUAL_ADJUST,
      source: "admin.recharge.manual",
      meta: { reason: "客诉补偿" },
    })
    expect(d.category).toBe("手动调整")
    expect(d.title).toBe("手动调整") // 备注在 meta.reason，不再混进 title
    expect(d.amountCny).toBeNull()
    expect(
      describeTransaction({ type: CreditTxnType.MANUAL_ADJUST, source: null, meta: null }).title
    ).toBe("手动调整")
  })

  it("企业池调整（teamId 有值）：项目=「企业池调整」（与筛选项 label 一致）", () => {
    const d = describeTransaction({
      type: CreditTxnType.MANUAL_ADJUST,
      source: "admin.team.adjust",
      meta: null,
      teamId: 10,
      direction: CreditDirection.DEBIT,
    })
    expect(d.category).toBe("手动调整")
    expect(d.title).toBe("企业池调整")
  })

  it("企业归档积分清零（EXPIRE + source=team.archive）：项目=「企业归档积分清零」", () => {
    expect(
      describeTransaction({ type: CreditTxnType.EXPIRE, source: "team.archive", meta: null })
    ).toEqual({
      category: "清零",
      title: "企业归档积分清零",
      amountCny: null,
      status: "COMPLETED",
    })
    // 日常到期清零不受影响
    expect(
      describeTransaction({ type: CreditTxnType.EXPIRE, source: "system.expire", meta: null }).title
    ).toBe("套餐积分清零")
  })

  it("客服补偿：meta.compensation=true 的 MANUAL_ADJUST 显示为 赠送/后台积分发放", () => {
    const d = describeTransaction({
      type: CreditTxnType.MANUAL_ADJUST,
      source: "客服补偿赠送",
      meta: { compensation: true, giftCredits: 500, reason: "投诉补偿" },
    })
    expect(d.category).toBe("赠送")
    expect(d.title).toBe("后台积分发放")
    expect(d.amountCny).toBeNull()
  })

  it("后台积分扣减（负数调整/DEBIT）：显示为 手动调整/后台积分扣减，不再标「赠送」", () => {
    const byDirection = describeTransaction({
      type: CreditTxnType.MANUAL_ADJUST,
      direction: CreditDirection.DEBIT,
      source: "客服补偿赠送",
      meta: { compensation: true, giftCredits: -10, reason: "多扣追回" },
    })
    expect(byDirection.category).toBe("手动调整")
    expect(byDirection.title).toBe("后台积分扣减")
    // 老数据无 direction 时按 meta.giftCredits<0 兜底
    const byMeta = describeTransaction({
      type: CreditTxnType.MANUAL_ADJUST,
      source: "客服补偿赠送",
      meta: { compensation: true, giftCredits: -10 },
    })
    expect(byMeta.title).toBe("后台积分扣减")
  })

  it("消费：类型=消费、source 走精确映射表得中文模块名", () => {
    const d = describeTransaction({
      type: CreditTxnType.CONSUME,
      source: "listing.generate",
      meta: null,
    })
    expect(d.category).toBe("消费")
    expect(d.title).toBe("Listing 生成")
    // 之前漏映射、直接显示英文 source 的来源，现在走共享精确表得中文名
    expect(
      describeTransaction({ type: CreditTxnType.CONSUME, source: "llm.generic", meta: null }).title
    ).toBe("通用 LLM")
    expect(
      describeTransaction({
        type: CreditTxnType.CONSUME,
        source: "aicreative.image_generate",
        meta: null,
      }).title
    ).toBe("图片生成")
    expect(
      describeTransaction({ type: CreditTxnType.CONSUME, source: "listing.score", meta: null })
        .title
    ).toBe("Listing 打分")
    // 完全未知的来源仍原样保留，便于排查
    expect(
      describeTransaction({ type: CreditTxnType.CONSUME, source: "weird.unknown", meta: null })
        .title
    ).toBe("weird.unknown")
  })

  it("清零/返利/提现：固定中文 + 金额 null", () => {
    expect(describeTransaction({ type: CreditTxnType.EXPIRE, source: null, meta: null })).toEqual({
      category: "清零",
      title: "套餐积分清零",
      amountCny: null,
      status: "COMPLETED",
    })
    expect(
      describeTransaction({ type: CreditTxnType.REBATE_IN, source: null, meta: null }).title
    ).toBe("邀请返利")
    expect(
      describeTransaction({ type: CreditTxnType.REBATE_WITHDRAW, source: null, meta: null }).title
    ).toBe("返利提现")
  })

  it("充值类无 priceCny 且非本金桶 → amountCny null（历史记录）", () => {
    expect(
      describeTransaction({ type: CreditTxnType.RECHARGE_PACK, source: null, meta: null }).amountCny
    ).toBeNull()
  })

  it("个人充值积分转入企业共享池（inject 扣减行）：meta.injectToTeamId → 专属项目名", () => {
    expect(
      describeTransaction({
        type: CreditTxnType.MANUAL_ADJUST,
        source: "billing.order",
        meta: { orderNo: "SR123", injectToTeamId: 11 },
      })
    ).toEqual({
      category: "手动调整",
      title: "个人充值积分转入企业共享池",
      amountCny: null,
      status: "COMPLETED",
    })
  })

  it.each([CreditTxnType.MANUAL_ADJUST, CreditTxnType.TEAM_RECHARGE])(
    "成员赠送转移 %s：显示赠送积分转入企业，金额为空",
    type => {
      expect(
        describeTransaction({ type, source: "team.member.gift.transfer", meta: null })
      ).toEqual({
        category: type === CreditTxnType.TEAM_RECHARGE ? "企业池入账" : "手动调整",
        title: "个人赠送积分转入企业共享池",
        amountCny: null,
        status: "COMPLETED",
      })
    }
  )

  it("企业池入账：类型=企业池入账，平台定制/个人余额注入给专属项目名，在线单金额取 priceCny", () => {
    expect(
      describeTransaction({
        type: CreditTxnType.TEAM_RECHARGE,
        source: "admin.team.custom",
        meta: null,
      })
    ).toEqual({
      category: "企业池入账",
      title: "平台定制开通·企业共享池",
      amountCny: null,
      status: "COMPLETED",
    })
    expect(
      describeTransaction({
        type: CreditTxnType.TEAM_RECHARGE,
        source: "billing.order",
        meta: { injectedFromPersonal: true },
      }).title
    ).toBe("个人余额注入·企业共享池")
    expect(
      describeTransaction({
        type: CreditTxnType.TEAM_RECHARGE,
        source: "billing.order",
        meta: { priceCny: 500 },
      })
    ).toEqual({
      category: "企业池入账",
      title: "企业共享池入账",
      amountCny: 500,
      status: "COMPLETED",
    })
  })

  it("个人转企业：套餐订阅 + 项目带「（个人订阅转团队订阅）」后缀", () => {
    expect(
      describeTransaction({
        type: CreditTxnType.RECHARGE_PLAN,
        source: "billing.order",
        meta: { tier: 2, name: "团队版", personalToTeam: true, priceCny: 1299 },
      })
    ).toEqual({
      category: "套餐订阅",
      title: "Lv.2 团队版 月度套餐（个人订阅转团队订阅）",
      amountCny: 1299,
      status: "COMPLETED",
    })
  })

  it("个人转企业差额返还：类型=手动调整，项目=个人套餐转企业套餐差额返还，金额 null", () => {
    expect(
      describeTransaction({
        type: CreditTxnType.MANUAL_ADJUST,
        source: "billing.p2t.refund",
        meta: { refundCny: "1015", refundCredits: 10150 },
      })
    ).toEqual({
      category: "手动调整",
      title: "个人套餐转企业套餐差额返还",
      amountCny: null,
      status: "COMPLETED",
    })
  })

  it("超额返还注入共享池：类型=企业池入账，项目=个人转企业超额折抵返还·企业共享池", () => {
    expect(
      describeTransaction({
        type: CreditTxnType.TEAM_RECHARGE,
        source: "billing.p2t.refund",
        meta: { p2tRefund: true, refundCny: "1015", refundCredits: 10150 },
      }).title
    ).toBe("个人转企业超额折抵返还·企业共享池")
  })

  it("企业归档退回：类型=企业池退回、金额 null", () => {
    expect(
      describeTransaction({ type: CreditTxnType.TEAM_ARCHIVE_RETURN, source: null, meta: null })
    ).toEqual({
      category: "企业池退回",
      title: "企业归档退回·充值池积分",
      amountCny: null,
      status: "COMPLETED",
    })
  })

  it("状态：退款未上线，统一 COMPLETED", () => {
    expect(
      describeTransaction({ type: CreditTxnType.RECHARGE_PACK, source: null, meta: null }).status
    ).toBe("COMPLETED")
  })
})

describe("deriveLifecycle / collectScheduledPlanIds", () => {
  const now = new Date("2026-06-24T00:00:00.000Z")
  const past = "2026-06-01T00:00:00.000Z"
  const future = "2026-12-01T00:00:00.000Z"

  it("collectScheduledPlanIds：只收带 scheduled 标记且有 planId 的", () => {
    const ids = collectScheduledPlanIds([
      { meta: { scheduled: true, scheduledPlanId: 9 } },
      { meta: { scheduled: true } }, // 无 planId
      { meta: { scheduledPlanId: 5 } }, // 无 scheduled 标记
      { meta: null },
    ])
    expect(ids).toEqual([9])
  })

  it("待生效：关联 ScheduledPlan 仍 PENDING → scheduled=true、effectiveAt=activateAt、expired=false", () => {
    const r = deriveLifecycle(
      { meta: { scheduled: true, scheduledPlanId: 9, activateAt: future, expiresAt: future } },
      new Map([[9, ScheduledPlanStatus.PENDING]]),
      now
    )
    expect(r).toEqual({ scheduled: true, expired: false, effectiveAt: future })
  })

  it("续费已激活且到期：ScheduledPlan ACTIVATED + meta.expiresAt 已过 → expired=true、scheduled=false", () => {
    const r = deriveLifecycle(
      { meta: { scheduled: true, scheduledPlanId: 9, activateAt: past, expiresAt: past } },
      new Map([[9, ScheduledPlanStatus.ACTIVATED]]),
      now
    )
    expect(r).toEqual({ scheduled: false, expired: true, effectiveAt: null })
  })

  it("升级记录已过期：无 scheduledPlanId、meta.expiresAt 已过 → expired=true", () => {
    const r = deriveLifecycle({ meta: { upgrade: true, expiresAt: past } }, new Map(), now)
    expect(r.expired).toBe(true)
    expect(r.scheduled).toBe(false)
  })

  it("生效中：meta.expiresAt 还在未来 → scheduled/expired 都 false", () => {
    const r = deriveLifecycle({ meta: { expiresAt: future } }, new Map(), now)
    expect(r).toEqual({ scheduled: false, expired: false, effectiveAt: null })
  })

  it("无到期信息（消费/手动调整等）：两者都 false", () => {
    expect(deriveLifecycle({ meta: null }, new Map(), now)).toEqual({
      scheduled: false,
      expired: false,
      effectiveAt: null,
    })
  })
})
