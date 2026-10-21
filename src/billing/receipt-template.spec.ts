import { ReceiptSnapshot, renderReceiptHtml } from "./receipt-template"

/** 收据模板：中文时间固定东八区、英文（邮箱注册用户）固定美东（EDT=UTC-4，8 月夏令时）；付款状态勾全链路统一纯 CSS 画（零字体依赖），「✓ 已收款」整体绿色加粗。 */
describe("renderReceiptHtml", () => {
  const snap: ReceiptSnapshot = {
    receiptNo: "SR202608220001",
    orderNo: "SR20260822065643305",
    issuedAt: "2026-08-22T10:00:00.000Z", // UTC
    paidAt: "2026-08-22T02:30:00.000Z", // UTC
    payer: {
      username: "张明",
      level: "Lv.1 Explorer",
      account: "zhang@x.com",
      title: "张明（个人）",
      email: "zhang@x.com",
    },
    payee: "SellerOS 跨境卖家运营平台",
    channelLabel: "微信支付",
    items: [{ name: "Explorer 会员套餐（30 天）", qty: 1, amountCny: 199, credits: 2200 }],
    totalCny: 199,
    amountUsdCents: 2959,
    fxRate: "6.7250",
    totalCredits: 2200,
    amountUpper: "壹佰玖拾玖元整",
    note: "套餐积分自到账起 30 天内有效。",
  }

  it("中文收据时间按东八区格式化（UTC+8，不受容器 UTC 时区影响）", () => {
    const html = renderReceiptHtml(snap)
    expect(html).toContain("开具日期：2026-08-22 18:00") // 10:00 UTC + 8
    expect(html).toContain("收款时间：2026-08-22 10:30") // 02:30 UTC + 8
  })

  it("英文收据时间按美东格式化（8 月 EDT=UTC-4）", () => {
    const html = renderReceiptHtml(snap, "en")
    expect(html).toContain("Date Issued: 2026-08-22 06:00") // 10:00 UTC - 4
    expect(html).toContain("Payment Time: 2026-08-21 22:30") // 02:30 UTC - 4（跨日）
  })

  it("收款时间为空显示 -", () => {
    const html = renderReceiptHtml({ ...snap, paidAt: null })
    expect(html).toContain("收款时间：-")
  })

  it("付款状态勾：纯 CSS 画勾（零字体依赖、全链路统一），「✓ 已收款」整体绿色加粗", () => {
    const html = renderReceiptHtml(snap)
    expect(html).toContain("已收款")
    expect(html).toContain("transform:rotate(45deg)") // 边框旋转法
    // 「勾 已收款」整体包在绿色加粗 span 里
    expect(html).toMatch(/<span style="color:#1f9d57;font-weight:700">[^√]*已收款<\/span>/)
    expect(html).not.toContain("<svg")
    expect(html).not.toContain("√")
    expect(html).not.toContain("✔")
    expect(html).not.toContain("inline-table")
  })

  it("布局用 table（不用 flex）：邮箱客户端对 flex 支持差", () => {
    const html = renderReceiptHtml(snap)
    expect(html).toContain('role="presentation"')
    expect(html).not.toContain("display:flex")
  })
})

/** 英文收据：邮箱注册用户的收据邮件用；标签 + 已知枚举翻译，用户数据原样保留。 */
describe("renderReceiptHtml（英文收据）", () => {
  const snap: ReceiptSnapshot = {
    receiptNo: "SR202608220001",
    orderNo: "SR20260822065643305",
    issuedAt: "2026-08-22T10:00:00.000Z",
    paidAt: "2026-08-22T02:30:00.000Z",
    payer: {
      username: "张明",
      level: "普通用户",
      account: "zhang@x.com",
      title: "张明（个人）",
      email: "zhang@x.com",
    },
    payee: "SellerOS 跨境卖家运营平台",
    channelLabel: "微信支付",
    items: [{ name: "Explorer 会员套餐（30 天）", qty: 1, amountCny: 199, credits: 2200 }],
    totalCny: 199,
    amountUsdCents: 2959,
    fxRate: "6.7250",
    totalCredits: 2200,
    amountUpper: "壹佰玖拾玖元整",
    note: "充值本金积分永久有效，用多少扣多少；赠送积分 30 天内有效。",
  }

  it("en：标签与已知枚举值全英文，大写金额行省略，时间仍东八区", () => {
    const html = renderReceiptHtml(snap, "en")
    expect(html).toContain("<title>Receipt SR202608220001</title>")
    expect(html).toContain("Membership Recharge Receipt")
    expect(html).toContain("Receipt No.: <b")
    expect(html).toContain("Date Issued: 2026-08-22 06:00")
    expect(html).toContain("Payment Time: 2026-08-21 22:30")
    expect(html).toContain("Payer")
    expect(html).toContain("Member: 张明")
    expect(html).toContain("Level: Free")
    expect(html).toContain("Title: 张明 (Individual)")
    expect(html).toContain("Email: zhang@x.com")
    expect(html).toContain("Payee")
    expect(html).toContain("SellerOS Cross-border Seller Operations Platform")
    expect(html).toContain("Payment Method: WeChat Pay")
    expect(html).toContain("Status: ")
    expect(html).toContain("Paid")
    expect(html).toContain("Order No.: SR20260822065643305")
    expect(html).toContain("Item / Description")
    expect(html).toContain("Qty")
    expect(html).toContain("Amount")
    expect(html).toContain("Credits")
    expect(html).toContain("Total")
    expect(html).toContain("2200 credits")
    // 英文收据金额统一美元：条目按汇率折算、合计用实收美元快照，汇率小字行去掉
    expect(html).toContain("$29.59") // 199 / 6.7250
    expect(html).not.toContain("¥199.00")
    expect(html).not.toContain("Charged $")
    expect(html).not.toContain("FX 1 USD")
    expect(html).toContain("Explorer Membership Plan (30 days)") // 条目名模板翻译
    expect(html).toContain(
      "Recharge principal credits never expire; bonus credits are valid for 30 days."
    )
    expect(html).toContain(
      "This receipt serves as proof of payment and does not constitute a VAT invoice."
    )
    expect(html).toContain("Thank you for your support")
    // 中文惯例内容不出现
    expect(html).not.toContain("已收款")
    expect(html).not.toContain("金额大写")
  })

  it("en：未收录的枚举值/用户数据原样保留（不做翻译）", () => {
    const html = renderReceiptHtml(
      {
        ...snap,
        channelLabel: "Stripe",
        note: "积分有效期以账户明细为准。",
        items: [{ name: "自研商品套装", qty: 1, amountCny: 199, credits: 2200 }],
      },
      "en"
    )
    expect(html).toContain("Payment Method: Stripe")
    expect(html).toContain("Credit validity is subject to your account statement.")
    expect(html).toContain("自研商品套装") // 未收录模板的条目名是用户数据，保留原样
  })

  it("en：条目 name/detail 按中文模板翻译（充值包/升级补差/团队版/折抵/返还/补开）", () => {
    const html = renderReceiptHtml(
      {
        ...snap,
        items: [
          {
            name: "充值包（2000 积分）",
            detail: "基础 1800（永不过期）+ 赠送 200（30 天有效）",
            qty: 1,
            amountCny: 199,
            credits: 2000,
          },
          {
            name: "Lv.2 Plus 会员升级补差（Lv.1 Explorer → Lv.2 Plus）",
            detail: "按剩余 12 天折算补差，到期日不变（2026-09-10 到期）",
            qty: 1,
            amountCny: 80,
            credits: 800,
          },
          {
            name: "Lv.3 Ultra 团队版（10 席位 · 365 天）",
            detail: "共享池 套餐 30000 + 赠送 5000（均 30 天有效）",
            qty: 1,
            amountCny: 3600,
            credits: 35000,
          },
          {
            name: "Lv.3 Ultra 团队席位升级补差（Lv.2 Plus → Lv.3 Ultra）",
            detail: "按剩余 30 天折算补差，到期日不变（2026-10-01 到期）；席位 5 → 10",
            qty: 1,
            amountCny: 1000,
            credits: 10000,
          },
          {
            name: "个人套餐折抵",
            detail: "个人 Lv.1 Explorer 剩余 20 天 / 套餐积分剩余 500，按低者折抵",
            qty: 1,
            amountCny: -99,
            credits: null,
          },
          {
            name: "超出抵扣返还充值积分",
            detail:
              "抵扣价值 ¥380.00 超出套餐价格 ¥360.00，按 1 元=10 积分返还至团队共享池（永不过期）",
            qty: 1,
            amountCny: 0,
            credits: 200,
          },
          {
            name: "团队自定义充值（2500 积分）",
            detail: "基础 2000（永不过期） + 赠送 500（30 天有效），入共享池",
            qty: 1,
            amountCny: 200,
            credits: 2500,
          },
          // 自定义充值无赠送档：detail 只有「基础 …（永不过期）」（个人/团队两种尾巴）
          {
            name: "自定义充值（20000 积分）",
            detail: "基础 20000（永不过期）",
            qty: 1,
            amountCny: 2000,
            credits: 20000,
          },
          {
            name: "团队自定义充值（20000 积分）",
            detail: "基础 20000（永不过期），入共享池",
            qty: 1,
            amountCny: 2000,
            credits: 20000,
          },
          { name: "¥100 充值包（1000+赠200）", qty: 1, amountCny: 100, credits: 1200 },
          { name: "Lv.1 Explorer 月度套餐【套餐升级】", qty: 1, amountCny: 199, credits: 2200 },
          { name: "邀请注册赠送积分", qty: 1, amountCny: 0, credits: 200 },
        ],
      },
      "en"
    )
    expect(html).toContain("Credit Pack (2000 credits)")
    expect(html).toContain("Base 1800 (never expires) + bonus 200 (30 days)")
    expect(html).toContain("Lv.2 Plus Membership Upgrade Difference (Lv.1 Explorer → Lv.2 Plus)")
    expect(html).toContain("Prorated for 12 remaining day(s); expiry unchanged (2026-09-10)")
    expect(html).toContain("Lv.3 Ultra Team Plan (10 seats · 365 days)")
    expect(html).toContain("Shared pool: plan 30000 + bonus 5000 (30 days)")
    expect(html).toContain("Lv.3 Ultra Team Seat Upgrade Difference (Lv.2 Plus → Lv.3 Ultra)")
    expect(html).toContain(
      "Prorated for 30 remaining day(s); expiry unchanged (2026-10-01); seats 5 → 10"
    )
    expect(html).toContain("Personal Plan Offset")
    expect(html).toContain(
      "Personal Lv.1 Explorer: 20 day(s) left / 500 plan credits left; offset by the lower"
    )
    expect(html).toContain("Excess Offset Refund Credits")
    expect(html).toContain(
      "Offset value $56.51 exceeds plan price $53.53; refunded at 10 credits per 1 CNY to Shared Team Pool (never expires)"
    )
    expect(html).toContain("Team Custom Recharge (2500 credits)")
    expect(html).toContain("Base 2000 (never expires) + bonus 500 (30 days), into shared pool")
    // 无赠送档：金额列同步折美元（2000 / 6.7250 = 297.40）
    expect(html).toContain("Custom Recharge (20000 credits)")
    expect(html).toContain("Base 20000 (never expires)</div>")
    expect(html).toContain("Base 20000 (never expires), into shared pool")
    expect(html).toContain("$14.87 Credit Pack (1000 + 200 bonus)") // 条目名里的 ¥100 同步折美元
    expect(html).toContain("Lv.1 Explorer Monthly Plan [Plan Upgrade]")
    expect(html).toContain("Invite Signup Bonus Credits")
  })

  it("zh 默认参数与历史输出一致（回归）", () => {
    const html = renderReceiptHtml(snap)
    expect(html).toContain("会员充值收据")
    expect(html).toContain("金额大写：<b>壹佰玖拾玖元整</b>")
    expect(html).toContain("Explorer 会员套餐（30 天）") // zh 条目名不做翻译
  })
})
