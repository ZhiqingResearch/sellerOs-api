import { collectAuditUserIds, describeAuditLog } from "./audit-description"

/** 审计描述：action + meta → 中文文案；用户名经 nameOf 解析。 */
describe("describeAuditLog", () => {
  const nameOf = (id: number | null) => (id === 74 ? "test008" : id === 7 ? "boss" : null)

  it("成员动作：用户名解析 + 新开账号标记", () => {
    expect(describeAuditLog("MEMBER_ADD", { userId: 74, created: false }, nameOf)).toBe(
      "添加成员「test008」加入团队"
    )
    expect(describeAuditLog("MEMBER_ADD", { userId: 74, created: true }, nameOf)).toBe(
      "添加成员「test008」加入团队（并开通新账号）"
    )
    expect(describeAuditLog("MEMBER_REMOVE", { userId: 74 }, nameOf)).toBe("移除成员「test008」")
    expect(describeAuditLog("MEMBER_STATUS", { userId: 74, status: "DISABLED" }, nameOf)).toBe(
      "停用成员「test008」"
    )
    expect(describeAuditLog("MEMBER_STATUS", { userId: 74, status: "ACTIVE" }, nameOf)).toBe(
      "启用成员「test008」"
    )
    expect(describeAuditLog("MEMBER_ROLE", { userId: 74, role: "ADMIN" }, nameOf)).toBe(
      "将「test008」设为管理员"
    )
    // 解析不到用户名退化为「成员」
    expect(describeAuditLog("MEMBER_REMOVE", { userId: 999 }, nameOf)).toBe("移除成员「成员」")
  })

  it("配额调整：有变更前值给「由 x 调整为 y」，无则只给新值；null=不限", () => {
    expect(
      describeAuditLog(
        "QUOTA_UPDATE",
        { memberUserId: 74, monthlyQuota: 1000, monthlyQuotaBefore: 800 },
        nameOf
      )
    ).toBe("将「test008」月度上限由 800 调整为 1000")
    expect(describeAuditLog("QUOTA_UPDATE", { memberUserId: 74, monthlyQuota: 1000 }, nameOf)).toBe(
      "将「test008」月度上限调整为 1000"
    )
    expect(
      describeAuditLog(
        "QUOTA_UPDATE",
        { memberUserId: 74, monthlyQuota: null, monthlyQuotaBefore: 800 },
        nameOf
      )
    ).toBe("将「test008」月度上限由 800 调整为 不限")
    expect(describeAuditLog("QUOTA_BATCH", { monthlyQuota: 1000, affected: 3 }, nameOf)).toBe(
      "批量设置成员月度上限为 1000（3 人）"
    )
  })

  it("团队生命周期与池动作", () => {
    expect(describeAuditLog("TEAM_CREATE", { source: "SELF" }, nameOf)).toBe(
      "创建企业团队（自助购买）"
    )
    expect(describeAuditLog("TEAM_CREATE", { name: "星辰科技" }, nameOf)).toBe(
      "创建企业团队「星辰科技」（平台定制）"
    )
    expect(describeAuditLog("TEAM_RENEW", { tier: 1, immediate: true }, nameOf)).toBe("团队续费")
    expect(describeAuditLog("TEAM_RENEW", { scheduledPlanId: 21 }, nameOf)).toBe("排队续费到期激活")
    expect(describeAuditLog("TEAM_GRACE", {}, nameOf)).toBe("团队到期，进入宽限期")
    expect(describeAuditLog("TEAM_ARCHIVE", { returnedToAdmin: "700" }, nameOf)).toBe(
      "团队归档，充值池 700 积分退回管理员个人户"
    )
    expect(describeAuditLog("TEAM_ARCHIVE", { returnedToAdmin: "0" }, nameOf)).toBe("团队归档")
    expect(
      describeAuditLog(
        "TEAM_SEAT_UPGRADE",
        { fromTier: 1, toTier: 2, seats: 20, creditsDiff: 25000 },
        nameOf
      )
    ).toBe("席位档升级 Lv.1 → Lv.2（20 席位）")
    expect(
      describeAuditLog("POOL_RECHARGE", { rechargeCredits: 5000, bonusCredits: 500 }, nameOf)
    ).toBe("共享池充值：充值积分 +5000，赠送 +500")
  })

  it("平台调整与设置", () => {
    expect(
      describeAuditLog("TEAM_ADJUST", { rechargeCreditsDelta: 500, extendDays: 30 }, nameOf)
    ).toBe("平台调整：充值积分 +500，有效期延长 30 天")
    expect(describeAuditLog("TEAM_ADJUST", { rechargeCreditsDelta: -200 }, nameOf)).toBe(
      "平台调整：充值积分 -200"
    )
    expect(
      describeAuditLog("SETTINGS_UPDATE", { from: { name: "旧名" }, to: { name: "新名" } }, nameOf)
    ).toBe("团队名称由「旧名」改为「新名」")
    expect(
      describeAuditLog("SETTINGS_UPDATE", { from: { name: "同名" }, to: { name: "同名" } }, nameOf)
    ).toBe("修改团队设置")
  })

  it("未知 action 原样返回；collectAuditUserIds 收集并过滤空值", () => {
    expect(describeAuditLog("SOME_FUTURE_ACTION", {}, nameOf)).toBe("SOME_FUTURE_ACTION")
    expect(collectAuditUserIds({ memberUserId: 74, userId: 7, previousAdminId: 1 })).toEqual([
      74, 7, 1,
    ])
    expect(collectAuditUserIds({ monthlyQuota: 100 })).toEqual([])
    expect(collectAuditUserIds(null)).toEqual([])
  })
})
