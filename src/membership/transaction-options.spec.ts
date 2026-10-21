import { CreditBucket, CreditDirection, CreditTxnType } from "@prisma/client"
import {
  classifyConsumeSource,
  CONSUME_SOURCE_OPTIONS,
  GIFT_COMPENSATE_FILTER,
  RECHARGE_TYPE_OPTIONS,
  rechargeTypeFilterWhere,
  TRANSACTION_BUCKET_OPTIONS,
} from "./transaction-options"

describe("transaction-options", () => {
  it("扣费来源(桶)：首项「全部」(空 value) + RECHARGE/PACKAGE/GIFT，不含 REBATE", () => {
    expect(TRANSACTION_BUCKET_OPTIONS[0]).toEqual({ value: "", label: "全部" })
    expect(TRANSACTION_BUCKET_OPTIONS.map(o => o.value)).toEqual([
      "",
      CreditBucket.RECHARGE,
      CreditBucket.PACKAGE,
      CreditBucket.GIFT,
    ])
    expect(TRANSACTION_BUCKET_OPTIONS.some(o => o.value === CreditBucket.REBATE)).toBe(false)
  })

  it("充值类型：首项「全部」+ 套餐/充值包/自定义/注册赠送/赠送/手动调整/企业池两类", () => {
    expect(RECHARGE_TYPE_OPTIONS[0]).toEqual({ value: "", label: "全部" })
    expect(RECHARGE_TYPE_OPTIONS.map(o => o.value)).toEqual([
      "",
      CreditTxnType.RECHARGE_PLAN,
      CreditTxnType.RECHARGE_PACK,
      CreditTxnType.RECHARGE_CUSTOM,
      CreditTxnType.SIGNUP_BONUS,
      GIFT_COMPENSATE_FILTER, // 伪类型「赠送」（正向补偿发放），与手动调整互斥拆分
      CreditTxnType.MANUAL_ADJUST,
      CreditTxnType.TEAM_RECHARGE,
      CreditTxnType.TEAM_ARCHIVE_RETURN,
    ])
    const labels = Object.fromEntries(RECHARGE_TYPE_OPTIONS.map(o => [o.value, o.label]))
    expect(labels[CreditTxnType.RECHARGE_PLAN]).toBe("套餐订阅")
    expect(labels[GIFT_COMPENSATE_FILTER]).toBe("赠送")
    expect(labels[CreditTxnType.MANUAL_ADJUST]).toBe("手动调整")
    expect(labels[CreditTxnType.TEAM_RECHARGE]).toBe("企业池入账")
  })

  it("rechargeTypeFilterWhere：MANUAL_ADJUST 排除正向补偿、GIFT_COMPENSATE 仅正向补偿、其余类型透传", () => {
    expect(rechargeTypeFilterWhere(GIFT_COMPENSATE_FILTER)).toEqual({
      type: "MANUAL_ADJUST",
      direction: "CREDIT",
      meta: { path: "$.compensation", equals: true },
    })
    expect(rechargeTypeFilterWhere("MANUAL_ADJUST")).toEqual({
      type: "MANUAL_ADJUST",
      NOT: { direction: "CREDIT", meta: { path: "$.compensation", equals: true } },
    })
    expect(rechargeTypeFilterWhere("RECHARGE_PLAN")).toEqual({ type: "RECHARGE_PLAN" })
  })

  it("扣费来源细分：个人 3 + 邀请人 2 + 企业 3（与列表列同枚举）", () => {
    expect(CONSUME_SOURCE_OPTIONS.map(o => o.value)).toEqual([
      "",
      "OWN_PACKAGE",
      "OWN_RECHARGE",
      "OWN_GIFT",
      "INVITER_GIFT",
      "INVITER_RECHARGE",
      "TEAM_PACKAGE",
      "TEAM_RECHARGE",
      "TEAM_GIFT",
    ])
    expect(CONSUME_SOURCE_OPTIONS.map(o => o.label)).toEqual([
      "全部",
      "个人套餐积分",
      "个人充值积分",
      "个人赠送积分",
      "邀请人赠送积分",
      "邀请人充值积分",
      "企业套餐积分",
      "企业充值积分",
      "企业赠送积分",
    ])
  })

  it("classifyConsumeSource：MANUAL_ADJUST 调减按桶/归属归类；调增归 null", () => {
    const D = CreditDirection.DEBIT
    const C = CreditDirection.CREDIT
    const M = CreditTxnType.MANUAL_ADJUST
    // 个人充值转入企业池等 RECHARGE 调减
    expect(classifyConsumeSource(M, CreditBucket.RECHARGE, false, D)).toBe("OWN_RECHARGE")
    expect(classifyConsumeSource(M, CreditBucket.GIFT, false, D)).toBe("OWN_GIFT")
    // 客服补偿扣回：PACKAGE+GIFT 合池扣减行（bucket=null）归「个人套餐积分」
    expect(classifyConsumeSource(M, null, false, D)).toBe("OWN_PACKAGE")
    // 企业侧池调整扣减（teamId 有值，仅动 RECHARGE）归「企业充值积分」
    expect(classifyConsumeSource(M, CreditBucket.RECHARGE, false, D, 10)).toBe("TEAM_RECHARGE")
    // 调增是入账、非扣费行
    expect(classifyConsumeSource(M, null, false, C)).toBeNull()
    expect(classifyConsumeSource(M, CreditBucket.RECHARGE, false, C)).toBeNull()
  })

  it("classifyConsumeSource：TEAM_CONSUME 按桶归企业三桶；CONSUME 归个人/邀请人", () => {
    const D = CreditDirection.DEBIT
    const T = CreditTxnType.TEAM_CONSUME
    expect(classifyConsumeSource(T, CreditBucket.PACKAGE, false, D, 10)).toBe("TEAM_PACKAGE")
    expect(classifyConsumeSource(T, CreditBucket.RECHARGE, false, D, 10)).toBe("TEAM_RECHARGE")
    expect(classifyConsumeSource(T, CreditBucket.GIFT, false, D, 10)).toBe("TEAM_GIFT")
    expect(classifyConsumeSource(T, null, false, D, 10)).toBeNull() // 跨桶异常行不打标
    // 个人消费
    expect(classifyConsumeSource(CreditTxnType.CONSUME, CreditBucket.GIFT, false, D)).toBe(
      "OWN_GIFT"
    )
    // 邀请人池消费
    expect(classifyConsumeSource(CreditTxnType.CONSUME, CreditBucket.PACKAGE, true, D)).toBe(
      "INVITER_GIFT"
    )
  })
})
