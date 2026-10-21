import { usdFromCents } from "./usd.util"

/** 收据快照（开票即冻结，查看/下载/邮件共用此结构渲染） */
export interface ReceiptSnapshot {
  provider?: string // 支付服务快照，旧收据兼容
  receiptNo: string
  orderNo: string | null
  issuedAt: string // ISO
  paidAt: string | null // ISO
  payer: {
    username: string
    level: string // 等级文案（如 "Lv.2 Plus" / "普通用户"）
    account: string // 账号（邮箱或手机号）
    title: string // 抬头（个人订单「用户名（个人）」；团队类订单「用户名（企业）」）
    email: string
  }
  payee: string
  channelLabel: string // 支付方式文案（微信支付 / 支付宝 / 银行卡 / 原支付渠道 / ——（0 元单未实际支付））
  items: {
    name: string
    detail?: string
    qty: number
    amountCny: number // 人民币（元），折抵行为负
    credits: number | null
  }[]
  totalCny: number // 合计人民币（元）
  amountUsdCents: number | null // 实收美元（美分，汇率折算快照）；人工补开为 null
  fxRate: string | null // 汇率快照（1 USD = X CNY）；人工补开为 null
  totalCredits: number
  amountUpper: string // 人民币大写
  note: string // 备注正文（已剔除发票管理文案）
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** 收据时间口径：中文（国内用户）固定东八区；英文（邮箱注册用户）固定美东（自动夏令时）。
 * 容器系统时区是 UTC，不能用 Date 的本地 getter */
const RECEIPT_DTF_ZH = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})
const RECEIPT_DTF_EN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

function fmtDateTime(iso: string | null, lang: ReceiptLang): string {
  if (!iso) return "-"
  const p = Object.fromEntries(
    (lang === "en" ? RECEIPT_DTF_EN : RECEIPT_DTF_ZH)
      .formatToParts(new Date(iso))
      .map(x => [x.type, x.value] as const)
  )
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/** 付款状态勾（纯 CSS）：边框旋转法画勾，零字体依赖、几何位置确定，全链路统一（PDF/网页/邮件正文）。
 * 对齐用 vertical-align:middle（勾块与文字「中对中」，确定性强）；不要用数值 vertical-align——
 * 空 inline-block 基线=底缘，数值偏移在部分邮箱客户端（Edge 的 163/QQ webview）会把勾抬成上标。
 * 历史教训：✔/√ 等字符在容器文泉驿字体下要么无字形（方框）要么画成根号；SVG/inline-table 基线对齐不稳。 */
const CHECK_CSS = `<span style="display:inline-block;width:4px;height:8px;border:solid #1f9d57;border-width:0 2px 2px 0;transform:rotate(45deg);margin:0 6px 0 1px;vertical-align:middle"></span>`

const CSS = `
body{margin:0;background:#f4f5f7;padding:24px}
.rcpt-doc{background:#fff;color:#1a1a1a;border:1px solid #e2e2e2;border-radius:8px;padding:30px 32px;font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","WenQuanYi Zen Hei",Arial,sans-serif;max-width:600px;margin:0 auto;position:relative}
.rcpt-logo{width:42px;height:42px;border-radius:10px;background:linear-gradient(135deg,#f5c869,#e8b04b);color:#fff;font-size:22px;font-weight:800;line-height:42px;text-align:center}
.rcpt-co{font-size:15px;font-weight:800;color:#1a1a1a}
.rcpt-co-sub{font-size:10px;color:#999;margin-top:2px;letter-spacing:.3px}
.rcpt-badge{font-size:11px;font-weight:700;color:#c8901f;border:1px solid #e8b04b;border-radius:6px;padding:4px 8px;letter-spacing:1px}
.rcpt-title{text-align:center;font-size:21px;font-weight:800;letter-spacing:4px;color:#1a1a1a;margin:18px 0 4px}
.rcpt-party-h{font-weight:800;color:#1a1a1a;font-size:12.5px;margin-bottom:3px}
.rcpt-tb{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px}
.rcpt-tb th{background:#faf6ec;border:1px solid #ead9b0;padding:8px 10px;text-align:left;color:#8a6d1f;font-weight:700}
.rcpt-tb td{border:1px solid #eadfc8;padding:9px 10px;color:#333}
.rcpt-tb .c{text-align:center}
.rcpt-tb .r{text-align:right}
.rcpt-tb tfoot td{background:#fbfbfb;font-weight:800;color:#1a1a1a}
.rcpt-upper{font-size:12.5px;color:#444;margin-bottom:16px}
.rcpt-upper b{color:#c8901f}
.rcpt-fx{font-size:11px;color:#999;margin:-10px 0 16px}
.rcpt-note{font-size:10.5px;color:#888;line-height:1.6}
.rcpt-tip{text-align:center;font-size:10px;color:#bbb;margin-top:16px;border-top:1px dashed #ddd;padding-top:10px}
`

/** 收据邮件语言：zh 中文（默认，网页查看/国内用户邮件）；en 英文（邮箱注册用户的收据邮件） */
export type ReceiptLang = "zh" | "en"

/** 收据文案表：zh 与现行版式完全一致；en 供邮箱注册（国际）用户收据邮件使用 */
const L = {
  zh: {
    docTitle: (no: string) => `收据 ${no}`,
    co: "SellerOS 跨境卖家运营平台",
    badge: "收据 RECEIPT",
    title: "会员充值收据",
    receiptNo: "收据编号：",
    issuedAt: "开具日期：",
    payer: "付款方",
    member: "会员：",
    level: "等级：",
    account: "账户：",
    titleLabel: "抬头：",
    email: "邮箱：",
    payee: "收款方",
    channel: "支付方式：",
    status: "状态：",
    paid: "已收款",
    orderNo: "订单号：",
    paidAt: "收款时间：",
    thItem: "项目 / 说明",
    thQty: "数量",
    thAmount: "金额",
    thCredits: "到账积分",
    total: "合计",
    creditsSuffix: "积分",
    amountUpper: "金额大写：",
    fxLine: (usd: string, rate: string) => `实收 $${usd}（汇率 1 USD = ${rate} CNY）`,
    invoiceNote: "本收据为付款凭证，不作为增值税发票使用。",
    tip: "SellerOS · 感谢您的支持",
  },
  en: {
    docTitle: (no: string) => `Receipt ${no}`,
    co: "SellerOS Cross-border Seller Operations Platform",
    badge: "RECEIPT",
    title: "Membership Recharge Receipt",
    receiptNo: "Receipt No.: ",
    issuedAt: "Date Issued: ",
    payer: "Payer",
    member: "Member: ",
    level: "Level: ",
    account: "Account: ",
    titleLabel: "Title: ",
    email: "Email: ",
    payee: "Payee",
    channel: "Payment Method: ",
    status: "Status: ",
    paid: "Paid",
    orderNo: "Order No.: ",
    paidAt: "Payment Time: ",
    thItem: "Item / Description",
    thQty: "Qty",
    thAmount: "Amount",
    thCredits: "Credits",
    total: "Total",
    creditsSuffix: "credits",
    amountUpper: "", // 大写金额是中文收据惯例，英文版省略该行
    fxLine: (usd: string, rate: string) => `Charged $${usd} (FX 1 USD = ${rate} CNY)`,
    invoiceNote: "This receipt serves as proof of payment and does not constitute a VAT invoice.",
    tip: "SellerOS · Thank you for your support",
  },
}

/** 快照内冻结的中文枚举值 → 英文。快照开票即冻结，翻译只能在渲染时做；未收录的值原样保留。 */
const EN_LEVEL: Record<string, string> = {
  普通用户: "Free",
  分销用户: "Distributor",
  企业管理员: "Org Admin",
}
const EN_CHANNEL: Record<string, string> = {
  微信支付: "WeChat Pay",
  支付宝: "Alipay",
  银行卡: "Bank Card",
  "银行卡（云闪付扫码）": "Bank card (UnionPay QR)",
  "原支付渠道（后台人工）": "Original Channel (Manual)",
  "——": "—",
}
const EN_PAYEE: Record<string, string> = {
  "SellerOS 跨境卖家运营平台": "SellerOS Cross-border Seller Operations Platform",
}
const EN_NOTE: Record<string, string> = {
  "套餐积分自到账起 30 天内有效，到期未用完自动清零。":
    "Plan credits are valid for 30 days from credit date and will expire if unused.",
  "充值本金积分永久有效，用多少扣多少；赠送积分 30 天内有效。":
    "Recharge principal credits never expire; bonus credits are valid for 30 days.",
  "积分有效期以账户明细为准。": "Credit validity is subject to your account statement.",
  "本收据为后台人工充值补开凭证，金额以原支付渠道实际收款为准。":
    "This receipt is issued retrospectively for a manual recharge; the amount reflects the actual payment received via the original channel.",
}

/** 抬头后缀（用户名（个人）/（企业））→ 英文 */
const EN_TITLE_SUFFIX: Array<[string, string]> = [
  ["（个人）", " (Individual)"],
  ["（企业）", " (Organization)"],
]

function enTitle(title: string): string {
  for (const [zh, en] of EN_TITLE_SUFFIX) {
    if (title.endsWith(zh)) return title.slice(0, -zh.length) + en
  }
  return title
}

/**
 * 条目 name/detail 的英文模板翻译（渲染时做：快照开票即冻结中文串，改下单链路不覆盖历史收据）。
 * 首选命中制，未命中原样保留（用户数据不翻译）。模板与拼装点一一对应：
 * name → order-pricing.service.ts:369/403/437/552/588/624/721/730/741/857/890、
 *        补开 title → membership/transaction-display.ts:80-118；
 * detail → order-pricing.service.ts:370/404/438/553/589/625/707/722/742/858/891。
 * plan/team 名称本身（Explorer/Plus/Ultra 等）是英文，只翻译中文胶水文本。
 */
const EN_ITEM_PATTERNS: Array<[RegExp, string | ((...groups: string[]) => string)]> = [
  // ==================== name ====================
  [/^(.+) 团队席位升级补差（(.+) → (.+)）$/, "$1 Team Seat Upgrade Difference ($2 → $3)"],
  [/^(.+) 会员升级补差（(.+) → (.+)）$/, "$1 Membership Upgrade Difference ($2 → $3)"],
  [/^(.+) 团队版（(\d+) 席位 · (\d+) 天）$/, "$1 Team Plan ($2 seats · $3 days)"],
  [/^(.+) 会员套餐（(\d+) 天）$/, "$1 Membership Plan ($2 days)"],
  [/^团队充值包（(\d+) 积分）$/, "Team Credit Pack ($1 credits)"],
  [/^团队自定义充值（(\d+) 积分）$/, "Team Custom Recharge ($1 credits)"],
  [/^充值包（(\d+) 积分）$/, "Credit Pack ($1 credits)"],
  [/^自定义充值（(\d+) 积分）$/, "Custom Recharge ($1 credits)"],
  [/^个人套餐折抵$/, "Personal Plan Offset"],
  [/^超出抵扣返还充值积分$/, "Excess Offset Refund Credits"],
  // 组合后缀：内部名称（如「Lv.1 Explorer 月度套餐」）继续走模板翻译
  [/^(.+)【套餐升级】$/, (_, name) => `${enItemText(name)} [Plan Upgrade]`],
  [
    /^(.+)（个人订阅转团队订阅）$/,
    (_, name) => `${enItemText(name)} (Personal to Team Subscription)`,
  ],
  [/^¥([\d.]+) 充值包（(\d+)\+赠(\d+)）$/, "¥$1 Credit Pack ($2 + $3 bonus)"],
  [/^¥([\d.]+) 充值包（(\d+)）$/, "¥$1 Credit Pack ($2)"],
  [/^¥([\d.]+) 自定义充值（(\d+)\+赠(\d+)）$/, "¥$1 Custom Recharge ($2 + $3 bonus)"],
  [/^¥([\d.]+) 自定义充值（(\d+)）$/, "¥$1 Custom Recharge ($2)"],
  [/^邀请注册赠送积分$/, "Invite Signup Bonus Credits"],
  [/^注册赠送积分$/, "Signup Bonus Credits"],
  [/^(.+) 月度套餐$/, "$1 Monthly Plan"],
  // ==================== detail ====================
  [
    /^按剩余 (\d+) 天折算补差，到期日不变（(\d{4}-\d{2}-\d{2}) 到期）；席位 (\d+) → (\d+)$/,
    "Prorated for $1 remaining day(s); expiry unchanged ($2); seats $3 → $4",
  ],
  [
    /^按剩余 (\d+) 天折算补差，到期日不变（(\d{4}-\d{2}-\d{2}) 到期）$/,
    "Prorated for $1 remaining day(s); expiry unchanged ($2)",
  ],
  [
    /^基础 (\d+)（永不过期） *\+ *赠送 (\d+)（30 天有效），入共享池$/,
    "Base $1 (never expires) + bonus $2 (30 days), into shared pool",
  ],
  [/^基础 (\d+)（永不过期），入共享池$/, "Base $1 (never expires), into shared pool"],
  [
    /^基础 (\d+)（永不过期） *\+ *赠送 (\d+)（30 天有效）$/,
    "Base $1 (never expires) + bonus $2 (30 days)",
  ],
  [/^基础 (\d+)（永不过期）$/, "Base $1 (never expires)"],
  [/^赠送 (\d+)（30 天有效）$/, "Bonus $1 (30 days)"],
  [
    /^共享池 套餐 (\d+) \+ 赠送 (\d+)（均 30 天有效）$/,
    "Shared pool: plan $1 + bonus $2 (30 days)",
  ],
  [/^套餐 (\d+) \+ 赠送 (\d+)（均 30 天有效）$/, "Plan $1 + bonus $2 (30 days)"],
  [
    /^个人 (.+) 剩余 (\d+) 天 \/ 套餐积分剩余 (\d+)，按低者折抵$/,
    "Personal $1: $2 day(s) left / $3 plan credits left; offset by the lower",
  ],
  [
    /^抵扣价值 ¥([\d.]+) 超出套餐价格 ¥([\d.]+)，按 1 元=(\d+) 积分返还至(团队共享池|个人充值积分)（永不过期）$/,
    (_, offset, price, perCny, target) =>
      `Offset value ¥${offset} exceeds plan price ¥${price}; refunded at ${perCny} credits per 1 CNY to ${
        target === "团队共享池" ? "Shared Team Pool" : "Personal Recharge Credits"
      } (never expires)`,
  ],
]

function enItemText(text: string): string {
  for (const [re, repl] of EN_ITEM_PATTERNS) {
    if (!re.test(text)) continue
    return typeof repl === "function" ? text.replace(re, repl) : text.replace(re, repl)
  }
  return text
}

/**
 * 渲染完整收据 HTML（独立文档，内联样式）。
 * 版式对齐原型【SellerOS收据_SR20260819142342531.html】；币种人民币（主金额 ¥，附实收美元小字行）；
 * 已剔除「发票管理」文案。前端「查看/下载 PDF」与后端「邮件正文/附件」共用本模板。
 * 布局用 table（不用 flex）：邮箱客户端（QQ邮箱/Gmail App）对 flex 支持差，table 在浏览器/Chromium 里视觉等价。
 * lang="en"：英文标签 + 已知枚举/备注/条目名（enItemText 模板翻译）翻译；用户名等用户数据原样保留，大写金额行省略。
 * 英文金额统一按实付汇率折美元（条目按 fxRate 折算、合计用 amountUsdCents 实收、条目文案里的 ¥N 同步折 $），
 * 汇率小字行不再展示；中文版人民币口径不变。
 */
export function renderReceiptHtml(s: ReceiptSnapshot, lang: ReceiptLang = "zh"): string {
  const t = L[lang]
  const payer = {
    ...s.payer,
    level: lang === "en" ? (EN_LEVEL[s.payer.level] ?? s.payer.level) : s.payer.level,
    title: lang === "en" ? enTitle(s.payer.title) : s.payer.title,
  }
  const payee = lang === "en" ? (EN_PAYEE[s.payee] ?? s.payee) : s.payee
  const channelLabel =
    lang === "en" ? (EN_CHANNEL[s.channelLabel] ?? s.channelLabel) : s.channelLabel
  const note = lang === "en" ? (EN_NOTE[s.note] ?? s.note) : s.note
  // 「勾 + 已收款」整体绿色加粗（对齐原型）；勾为纯 CSS 画，勾块与文字同取 middle 中对齐（全链路统一，零字体依赖）
  const statusInner = `<span style="color:#1f9d57;font-weight:700">${CHECK_CSS}<span style="vertical-align:middle">${t.paid}</span></span>`
  // 英文（邮箱注册用户）收据金额统一按实付汇率折美元展示：快照条目/合计存的是人民币（元），
  // 实收美元只有订单级快照（amountUsdCents 美分 + fxRate）→ 条目按汇率折算，合计直接用实收美元。
  // 无汇率快照（人工补开）的英文收据退回人民币口径（该场景仅国内人工充值，实际不会出现）。
  const usdRate =
    lang === "en" && s.amountUsdCents != null && s.fxRate != null ? Number(s.fxRate) : null
  const usdOfCny = (cny: number) => Math.round((cny / usdRate!) * 100) / 100
  /** 条目文案里的「¥N」（如 ¥100 充值包 / 抵扣价值 ¥380.00）→ 按同汇率折成 $ */
  const enUsdText = (text: string) =>
    usdRate == null
      ? text
      : text.replace(/¥([\d.]+)/g, (_, n) => `$${usdOfCny(Number(n)).toFixed(2)}`)
  const amountCell = (cny: number) =>
    usdRate == null ? `¥${cny.toFixed(2)}` : `$${usdOfCny(cny).toFixed(2)}`
  const totalCell =
    usdRate == null ? `¥${s.totalCny.toFixed(2)}` : `$${usdFromCents(s.amountUsdCents!)}`
  const rows = s.items
    .map(it => {
      const name = lang === "en" ? enUsdText(enItemText(it.name)) : it.name
      const detail = it.detail && lang === "en" ? enUsdText(enItemText(it.detail)) : it.detail
      return `<tr>
<td>${esc(name)}${detail ? `<div style="color:#999;font-size:11px;margin-top:2px">${esc(detail)}</div>` : ""}</td>
<td class="c">${it.qty}</td>
<td class="r">${amountCell(it.amountCny)}</td>
<td class="r">${it.credits == null ? "-" : it.credits}</td>
</tr>`
    })
    .join("\n")
  // 美元模式下金额已是实付美元口径，汇率小字行不再展示（2026-09-07 收口：英文收据统一美元、去掉 total 下的实收/汇率行）
  const fxLine =
    lang === "zh" && s.amountUsdCents != null && s.fxRate != null
      ? `<div class="rcpt-fx">${t.fxLine(usdFromCents(s.amountUsdCents), esc(s.fxRate))}</div>`
      : ""
  const amountUpperLine =
    lang === "zh"
      ? `<div class="rcpt-upper">${t.amountUpper}<b>${esc(s.amountUpper)}</b></div>`
      : ""
  return `<!doctype html><html><head><meta charset="utf-8"><title>${t.docTitle(esc(s.receiptNo))}</title><style>${CSS}</style></head><body>
<div class="rcpt-doc">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr>
    <td valign="top">
      <table cellpadding="0" cellspacing="0" role="presentation"><tr>
        <td class="rcpt-logo" width="42">S</td>
        <td width="11" style="width:11px"></td>
        <td valign="middle">
          <div class="rcpt-co">${esc(t.co)}</div>
          <div class="rcpt-co-sub">Shenzhen SellerOS Technology Co., Ltd.</div>
        </td>
      </tr></table>
    </td>
    <td valign="top" align="right"><span class="rcpt-badge">${t.badge}</span></td>
  </tr></table>
  <div class="rcpt-title">${t.title}</div>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="font-size:12px;color:#666;border-bottom:2px solid #1a1a1a;margin-bottom:14px"><tr>
    <td style="padding-bottom:10px">${t.receiptNo}<b style="color:#1a1a1a">${esc(s.receiptNo)}</b></td>
    <td align="right" style="padding-bottom:10px">${t.issuedAt}${fmtDateTime(s.issuedAt, lang)}</td>
  </tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:14px"><tr>
    <td width="50%" valign="top" style="font-size:12px;color:#444;line-height:1.85;padding-right:7px">
      <div class="rcpt-party-h">${t.payer}</div>
      <div>${t.member}${esc(payer.username)}</div>
      <div>${t.level}${esc(payer.level)}</div>
      <div>${t.account}${esc(payer.account)}</div>
      <div>${t.titleLabel}${esc(payer.title)}</div>
      <div>${t.email}${esc(payer.email)}</div>
    </td>
    <td width="50%" valign="top" style="font-size:12px;color:#444;line-height:1.85;padding-left:7px">
      <div class="rcpt-party-h">${t.payee}</div>
      <div>${esc(payee)}</div>
      <div>${t.channel}${esc(channelLabel)}</div>
      <div>${t.status}${statusInner}</div>
      ${s.orderNo ? `<div>${t.orderNo}${esc(s.orderNo)}</div>` : ""}
      <div>${t.paidAt}${fmtDateTime(s.paidAt, lang)}</div>
    </td>
  </tr></table>
  <table class="rcpt-tb">
    <thead><tr><th>${t.thItem}</th><th class="c">${t.thQty}</th><th class="r">${t.thAmount}</th><th class="r">${t.thCredits}</th></tr></thead>
    <tbody>
${rows}
    </tbody>
    <tfoot><tr><td colspan="2">${t.total}</td><td class="r">${totalCell}</td><td class="r">${s.totalCredits} ${t.creditsSuffix}</td></tr></tfoot>
  </table>
  ${amountUpperLine}
  ${fxLine}
  <div class="rcpt-note">${esc(note).replace(/\n/g, "<br>")}<br>${t.invoiceNote}</div>
  <div class="rcpt-tip">${t.tip}</div>
</div>
</body></html>`
}

/** 由快照字段补全大写金额（开票时调用一次） */
export function withAmountUpper(totalCny: number): string {
  return cnyUppercase(totalCny)
}

// ==================== 人民币大写 ====================

const CN_DIGITS = "零壹贰叁肆伍陆柒捌玖"
const CN_INT_UNITS = ["", "拾", "佰", "仟"]
const CN_GROUP_UNITS = ["", "万", "亿", "兆"]

/** 4 位小节（0~9999）→ 大写（节内零折叠；不带节单位） */
function sectionToChinese(section: number): string {
  let str = ""
  let unitPos = 0
  let zero = true // 节首/遇零标记：抑制重复零与节首零
  while (section > 0) {
    const v = section % 10
    if (v === 0) {
      if (!zero) {
        zero = true
        str = CN_DIGITS[0] + str
      }
    } else {
      zero = false
      str = CN_DIGITS[v] + CN_INT_UNITS[unitPos] + str
    }
    unitPos++
    section = Math.floor(section / 10)
  }
  return str
}

/** 整数部分 → 大写（按万/亿/兆分节，节间补零） */
function intToChinese(n: number): string {
  let unitPos = 0
  let str = ""
  let needZero = false
  while (n > 0) {
    const section = n % 10000
    if (needZero && section !== 0) str = CN_DIGITS[0] + str
    const sectionStr = sectionToChinese(section)
    str = sectionStr + (section !== 0 ? CN_GROUP_UNITS[unitPos] : "") + str
    needZero = section < 1000 && section > 0
    n = Math.floor(n / 10000)
    unitPos++
  }
  return str
}

/**
 * 人民币金额大写（收据用）：199 → "壹佰玖拾玖元整"，199.55 → "壹佰玖拾玖元伍角伍分"。
 * 角分皆 0 补「整」；角为 0 分非 0 且元非 0 补「零」（1.05 → "壹元零伍分"）。
 */
export function cnyUppercase(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("金额必须是非负数字")
  const cents = Math.round(amount * 100)
  const yuan = Math.floor(cents / 100)
  const jiao = Math.floor((cents % 100) / 10)
  const fen = cents % 10
  let result = yuan > 0 ? `${intToChinese(yuan)}元` : ""
  if (jiao === 0 && fen === 0) return `${result === "" ? CN_DIGITS[0] + "元" : result}整`
  if (jiao > 0) result += `${CN_DIGITS[jiao]}角`
  else if (yuan > 0 && fen > 0) result += CN_DIGITS[0]
  if (fen > 0) result += `${CN_DIGITS[fen]}分`
  return result
}
