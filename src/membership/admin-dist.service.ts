import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { CreditBucket, CreditTxnType, Prisma, TeamStatus } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PaginationDto } from "../common/dto/pagination.dto"
import { beijingMonthStart } from "../common/utils/datetime"
import { quantize4 } from "../common/utils/decimal"
import { maskPhone } from "../common/utils/mask"
import { PrismaService } from "../prisma/prisma.service"
import { QueryDistTreeDto, UpdateRebateRulesDto } from "./dto/admin-dist.dto"
import { DEFAULT_LEVEL2_REBATE_RATE } from "./membership.constants"

/** 全局返利规则单行 id（固定 1） */
const RULE_ID = 1

/** 返利成本试算：样本窗口（近 30 天消耗）与样本上限（防大库全量回放拖垮内存） */
const PREVIEW_SAMPLE_DAYS = 30
const PREVIEW_SAMPLE_LIMIT = 5000

/**
 * 后台分销管理：全局返利规则（RebateRule 单行）+ 分销关系树（两级，含本月消耗/返利聚合）+ CSV 导出。
 * 返利结算内核见 CreditService.settleRebatesInTx，本服务只做配置维护与只读聚合。
 */
@Injectable()
export class AdminDistService {
  private readonly logger = new Logger(AdminDistService.name)

  constructor(private readonly prisma: PrismaService) {}

  // ==================== 返利规则 ====================

  /** 读全局返利规则；表为空返回默认值（不落库），默认值与 RebateRule schema 一致。 */
  async getRebateRules() {
    const row = await this.prisma.rebateRule.findFirst({ orderBy: { id: "asc" } })
    if (!row) {
      return { corpCounts: true, maxLayers: 2, perInviterCap: null, perConsumeCapPct: null }
    }
    return this.presentRule(row)
  }

  /** 更新全局返利规则：upsert 单行（id=1），至少传一项；显式传 null = 清除该封顶/不限层级。 */
  async updateRebateRules(dto: UpdateRebateRulesDto) {
    const data: {
      corpCounts?: boolean
      maxLayers?: number | null
      perInviterCap?: number | null
      perConsumeCapPct?: number | null
    } = {}
    if (dto.corpCounts !== undefined) data.corpCounts = dto.corpCounts
    if (dto.maxLayers !== undefined) data.maxLayers = dto.maxLayers
    if (dto.perInviterCap !== undefined) data.perInviterCap = dto.perInviterCap
    if (dto.perConsumeCapPct !== undefined) data.perConsumeCapPct = dto.perConsumeCapPct
    if (Object.keys(data).length === 0) throw new BadRequestException("至少传一项配置")

    const row = await this.prisma.rebateRule.upsert({
      where: { id: RULE_ID },
      create: { id: RULE_ID, ...data },
      update: data,
    })
    return this.presentRule(row)
  }

  /**
   * 返利成本试算（2026-08-31，不落库）：按「当前库真实数据 + 草稿规则参数」回放近 30 天消耗，预计返利成本。
   * 口径与 CreditService.settleRebatesInTx 对齐：CONSUME 沿消费者个人邀请链、TEAM_CONSUME 沿 Team.invitedById
   * 企业邀请链（corpCounts=false 时企业段只计入消耗分母、不计返利）；计酬闸门 rebateEnabled/isActive/
   * deriveCanInvite 逐层判定；金额最多 4 位小数（2026-08-31 起不抹零）；单笔封顶等比缩放（共用 quantize4）；
   * perInviterCap 按样本窗口内模拟累计近似自然月封顶（试算为估计值，非承诺口径）。
   * highRisk：预计返利/消耗 > 50%（产品 TC_DIST_093 高成本线）。
   * maxLayers 传 null = 不限层级（上溯到底）；byInviter 按团队长拆明细（预计返利合计 + 参与计酬消耗者去重人数，降序）。
   * 对账口径（2026-09-03 bug30）：明细量化到最多 2 位小数，顶部 rebateTotal = 量化后明细之和，前端原样展示即可对账。
   */
  async previewRebateRules(dto: UpdateRebateRulesDto) {
    const current = await this.getRebateRules() // perConsumeCapPct 为 string|null
    const effective = {
      corpCounts: dto.corpCounts ?? current.corpCounts,
      // maxLayers：显式传 null = 不限层级（2026-09-01 bug15）；未传沿用当前规则
      maxLayers: dto.maxLayers !== undefined ? dto.maxLayers : current.maxLayers,
      perInviterCap: dto.perInviterCap !== undefined ? dto.perInviterCap : current.perInviterCap,
      perConsumeCapPct:
        dto.perConsumeCapPct !== undefined
          ? dto.perConsumeCapPct == null
            ? null
            : new Decimal(dto.perConsumeCapPct)
          : current.perConsumeCapPct == null
            ? null
            : new Decimal(current.perConsumeCapPct),
    }

    const since = new Date(Date.now() - PREVIEW_SAMPLE_DAYS * 24 * 3600 * 1000)
    const txns = await this.prisma.creditTransaction.findMany({
      where: {
        createdAt: { gte: since },
        type: { in: [CreditTxnType.CONSUME, CreditTxnType.TEAM_CONSUME] },
      },
      orderBy: { id: "asc" },
      take: PREVIEW_SAMPLE_LIMIT + 1, // 多取 1 条判断是否截断
      select: { userId: true, teamId: true, type: true, amount: true },
    })
    const sampleTruncated = txns.length > PREVIEW_SAMPLE_LIMIT
    if (sampleTruncated) txns.length = PREVIEW_SAMPLE_LIMIT

    // 用户图一次装载内存索引（链上溯 + 计酬闸门所需字段 + 团队长明细用户名；用户表量级小）
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        username: true,
        invitedById: true,
        rebateRate: true,
        level2RebateRate: true,
        rebateEnabled: true,
        isActive: true,
        canInvite: true, // 计酬闸门读落库值（2026-09-01 起落库制，废上级开关派生）
      },
    })
    const userBy = new Map(users.map(u => [u.id, u]))
    // 企业段链起点：Team.invitedById 快照（成员个人邀请关系不影响企业段归属）
    const teams = await this.prisma.team.findMany({ select: { id: true, invitedById: true } })
    const teamInviterBy = new Map(teams.map(t => [t.id, t.invitedById]))

    const zero = () => new Decimal(0)
    let consumeTotal = zero()
    const monthlyByInviter = new Map<number, Decimal>() // perInviterCap 窗口内模拟累计
    // 团队长明细（2026-09-01 bug15 原型）：每位团队长预计返利合计 + 参与计酬的消耗者去重人数；
    // 顶部预计返利不再独立累加，= 量化后明细之和（2026-09-03 bug30 对账口径）
    const byInviter = new Map<number, { rebate: Decimal; consumers: Set<number> }>()

    for (const txn of txns) {
      consumeTotal = consumeTotal.plus(txn.amount)
      const isTeamSegment = txn.type === CreditTxnType.TEAM_CONSUME
      if (isTeamSegment && !effective.corpCounts) continue // 企业段不计佣，只计入消耗分母
      // 链起点：企业段=企业邀请人快照；个人段=消费者本人上级
      let nextInviterId = isTeamSegment
        ? txn.teamId != null
          ? (teamInviterBy.get(txn.teamId) ?? null)
          : null
        : (userBy.get(txn.userId)?.invitedById ?? null)
      const chain: { userId: number; rate: Decimal }[] = []
      let layer = 0
      // maxLayers=null → 不限层级，沿邀请链上溯到底
      while (
        nextInviterId != null &&
        (effective.maxLayers == null || layer < effective.maxLayers)
      ) {
        const inviter = userBy.get(nextInviterId)
        if (!inviter) break
        layer++
        if (inviter.rebateEnabled && inviter.isActive && inviter.canInvite) {
          const rate =
            layer === 1
              ? new Decimal(inviter.rebateRate)
              : new Decimal(inviter.level2RebateRate ?? DEFAULT_LEVEL2_REBATE_RATE)
          chain.push({ userId: inviter.id, rate })
        }
        nextInviterId = inviter.invitedById
      }
      if (!chain.length) continue

      const base = new Decimal(txn.amount)
      // 与结算内核同口径（2026-08-31 起不抹零）：最多 4 位小数，封顶超限时等比缩放
      let rebates = chain.map(c => ({
        ...c,
        amount: quantize4(base.mul(c.rate)),
      }))
      if (effective.perConsumeCapPct) {
        const cap = base.mul(effective.perConsumeCapPct)
        const total = rebates.reduce((s, r) => s.plus(r.amount), zero())
        if (total.greaterThan(cap) && total.greaterThan(0)) {
          const factor = cap.div(total)
          rebates = rebates.map(r => ({ ...r, amount: quantize4(r.amount.mul(factor)) }))
        }
      }
      if (effective.perInviterCap != null) {
        const cap = new Decimal(effective.perInviterCap)
        rebates = rebates.map(r => {
          const used = monthlyByInviter.get(r.userId) ?? zero()
          const room = Decimal.max(cap.minus(used), zero())
          const amount = Decimal.min(r.amount, room)
          monthlyByInviter.set(r.userId, used.plus(amount))
          return { ...r, amount }
        })
      }
      // 团队长明细累计：金额>0 才算「参与计酬」（被闸门跳过/封顶截到 0 的不计人数）
      for (const r of rebates) {
        if (r.amount.lessThanOrEqualTo(0)) continue
        const agg = byInviter.get(r.userId) ?? { rebate: zero(), consumers: new Set<number>() }
        agg.rebate = agg.rebate.plus(r.amount)
        agg.consumers.add(txn.userId)
        byInviter.set(r.userId, agg)
      }
    }

    // 展示对账口径（2026-09-03 bug30）：团队长明细量化到最多 2 位小数（>2 位才 ROUND_HALF_UP，整数/少位原样），
    // 顶部「预计返利」= 量化后明细之和——接口返回值保证 总额 ≡ 明细合计，前端原样展示即可逐项对账（勿再二次取整）
    const displayRows = [...byInviter.entries()].map(([uid, agg]) => {
      const rebate =
        agg.rebate.decimalPlaces() > 2
          ? agg.rebate.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          : agg.rebate
      return {
        userId: uid,
        username: userBy.get(uid)?.username ?? null,
        consumerCount: agg.consumers.size,
        rebate,
      }
    })
    const rebateTotal = displayRows.reduce((s, r) => s.plus(r.rebate), zero())
    const rebatePct = consumeTotal.greaterThan(0) ? rebateTotal.div(consumeTotal) : null
    const highRisk = rebatePct != null && rebatePct.greaterThan(0.5)
    const pctText = rebatePct ? rebatePct.mul(100).toFixed(1) : ""
    return {
      sampleDays: PREVIEW_SAMPLE_DAYS,
      sampleSize: txns.length,
      sampleTruncated,
      consumeTotal: consumeTotal.toString(),
      rebateTotal: rebateTotal.toString(),
      rebatePct: rebatePct?.toFixed(4) ?? null,
      highRisk,
      riskMessage: highRisk
        ? `按当前参数，近 ${PREVIEW_SAMPLE_DAYS} 天预计返利占消耗 ${pctText}%，已超过 50% 高成本线，请检查返利层数/单笔封顶配置`
        : null,
      // 团队长明细（按预计返利降序）：参与计酬人数 = 为其贡献返利的消耗者去重数（含企业池消耗成员）
      byInviter: displayRows
        .map(r => ({
          userId: r.userId,
          username: r.username,
          consumerCount: r.consumerCount,
          rebateTotal: r.rebate.toString(),
        }))
        .sort((a, b) => new Decimal(b.rebateTotal).cmp(new Decimal(a.rebateTotal))),
      effectiveRule: {
        corpCounts: effective.corpCounts,
        maxLayers: effective.maxLayers, // null = 不限层级
        perInviterCap: effective.perInviterCap,
        perConsumeCapPct: effective.perConsumeCapPct?.toString() ?? null,
      },
    }
  }

  // ==================== 分销关系树 ====================

  /**
   * 分销关系树：根用户本体 + 一级列表（直接 invitees，含本月消耗/本月为根贡献返利/各自二级数，
   * 每条内嵌二级列表并按 page/pageSize 分页）。根节点带本人 monthConsumed/monthRebateEarned、
   * 二级节点带 monthRebateContributed（2026-08-31 补，树内数字可与顶部总收益对账）。
   * 一级/二级节点均带按钮数据五件套（2026-08-31 补）：canInvite（本人独立开关原始值）/discount/
   * rebateRate（邀请配置弹窗回显初值）/rebate（可提现余额，REBATE 桶剩余）/rebateEarned（累计返利入账）——
   * 前端据此放开节点操作按钮：邀请配置 depth≤1，返利提现 canInvite || rebate>0。
   * 徽章数据（2026-08-31 第六批，根+一级+二级同口径）：effectiveCanInvite（有效邀请权 = 本人 canInvite
   * 落库值；2026-09-01 起落库制，上级开关批量写入/收回，读侧不再派生）/isActive（已停用）/team（占用中企业 {id,name,role}，个人=null）/
   * monthTeamConsumed（本月企业池消耗，>0 渲染「消耗来自企业共享池」）/rebateAttribution（本月返利归属
   * [{userId,username,amount}]：一级→根、二级→一级上级+根，实付口径，>0 才有行）；根另带 level1Total（下线数）。
   * 顶层 networkCount/networkMonthConsumed = 树卡片头部「团队 N 人 / 计费消耗」（不含根，按筛选后口径）。
   * 本月口径：北京自然月（与钱包「本月已用」、返利月封顶同切点）；消耗 = CONSUME + TEAM_CONSUME。
   */
  async getTree(query: QueryDistTreeDto) {
    const { page, pageSize } = query
    const tree = await this.loadTree(query.userId, query.scope ?? "all")
    return {
      user: tree.user,
      // 返利去向标注：corpCounts 开关下企业池消耗是否计返利（全局开关，逐行同值）
      corpCounts: tree.corpCounts,
      // 网络合计（树卡片头部「团队 N 人 / 计费消耗」，不含根；按筛选后口径）
      networkCount: tree.networkCount,
      networkMonthConsumed: tree.networkMonthConsumed,
      networkTotalConsumed: tree.networkTotalConsumed, // 累计版（2026-09-01 bug14/15）
      level1: tree.level1.map(l1 => {
        const total = l1.level2All.length
        const start = (page - 1) * pageSize
        return {
          id: l1.id,
          username: l1.username,
          phone: l1.phone, // 已在 loadTree 脱敏
          monthConsumed: l1.monthConsumed,
          monthTeamConsumed: l1.monthTeamConsumed,
          monthRebateContributed: l1.monthRebateContributed,
          totalConsumed: l1.totalConsumed, // 累计三件套（bug14/15）
          totalTeamConsumed: l1.totalTeamConsumed,
          totalRebateContributed: l1.totalRebateContributed,
          canInvite: l1.canInvite, // 按钮数据五件套（loadTree 注释有口径说明）
          discount: l1.discount,
          rebateRate: l1.rebateRate,
          rebate: l1.rebate,
          rebateEarned: l1.rebateEarned,
          effectiveCanInvite: l1.effectiveCanInvite, // 徽章数据（2026-08-31 第六批）
          isActive: l1.isActive,
          team: l1.team,
          rebateAttribution: l1.rebateAttribution,
          level2Total: l1.level2Total,
          corpCounts: tree.corpCounts,
          level2: {
            items: l1.level2All
              .slice(start, start + pageSize)
              .map(l2 => ({ ...l2, corpCounts: tree.corpCounts })),
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
          },
        }
      }),
    }
  }

  /**
   * 用量看板「邀请分销概览」（产品 §8 P7）：4 张汇总卡 + 分销代理明细表。
   * 汇总口径（全量累计，不分月）：inviterCount=可邀请用户数（canInvite=true）；
   * invitedTotal=实际已建号的被邀请用户数（与名额已用同口径）；inviteeConsumed=全部被邀用户
   * （invitedById != null，任意层级）的累计消耗（CONSUME+TEAM_CONSUME）；rebateTotal=累计返利入账（REBATE_IN）。
   * 明细行（按返利倒序，内存分页——分销代理量级小）：invitedCount=直接下级数；
   * inviteeConsumed=其直接下级累计消耗；rebateEarned=其累计返利入账（含二级层）。
   */
  async getDashboard(query: PaginationDto) {
    const { page, pageSize } = query
    const zero = () => new Prisma.Decimal(0)
    const [inviterCount, invitedTotal, inviteeConsumedAgg, rebateTotalAgg, inviters] =
      await Promise.all([
        this.prisma.user.count({ where: { canInvite: true } }),
        this.prisma.user.count({ where: { invitedById: { not: null } } }),
        this.prisma.creditTransaction.aggregate({
          where: {
            type: { in: [CreditTxnType.CONSUME, CreditTxnType.TEAM_CONSUME] },
            user: { invitedById: { not: null } },
          },
          _sum: { amount: true },
        }),
        this.prisma.creditTransaction.aggregate({
          where: { type: CreditTxnType.REBATE_IN },
          _sum: { amount: true },
        }),
        this.prisma.user.findMany({
          where: { canInvite: true },
          select: { id: true, username: true, phone: true, rebateRate: true, discount: true },
          orderBy: { id: "asc" },
        }),
      ])

    const inviterIds = inviters.map(u => u.id)
    // 直接下级（id→邀请人映射）+ 下级消耗聚合 + 邀请人返利聚合
    const invitees = inviterIds.length
      ? await this.prisma.user.findMany({
          where: { invitedById: { in: inviterIds } },
          select: { id: true, invitedById: true },
        })
      : []
    const inviteeIds = invitees.map(u => u.id)
    const [consumeRows, rebateRows] = await Promise.all([
      inviteeIds.length
        ? this.prisma.creditTransaction.groupBy({
            by: ["userId"],
            where: {
              userId: { in: inviteeIds },
              type: { in: [CreditTxnType.CONSUME, CreditTxnType.TEAM_CONSUME] },
            },
            _sum: { amount: true },
          })
        : [],
      inviterIds.length
        ? this.prisma.creditTransaction.groupBy({
            by: ["userId"],
            where: { userId: { in: inviterIds }, type: CreditTxnType.REBATE_IN },
            _sum: { amount: true },
          })
        : [],
    ])
    const consumedByInvitee = new Map<number, Prisma.Decimal>()
    for (const r of consumeRows) consumedByInvitee.set(r.userId, r._sum.amount ?? zero())
    const rebateByInviter = new Map<number, Prisma.Decimal>()
    for (const r of rebateRows) rebateByInviter.set(r.userId, r._sum.amount ?? zero())
    // 归并到邀请人：人数 + 下级消耗
    const invitedCountBy = new Map<number, number>()
    const inviteeConsumedBy = new Map<number, Prisma.Decimal>()
    for (const inv of invitees) {
      if (inv.invitedById == null) continue
      invitedCountBy.set(inv.invitedById, (invitedCountBy.get(inv.invitedById) ?? 0) + 1)
      inviteeConsumedBy.set(
        inv.invitedById,
        (inviteeConsumedBy.get(inv.invitedById) ?? zero()).plus(
          consumedByInvitee.get(inv.id) ?? zero()
        )
      )
    }

    const rows = inviters
      .map(u => ({
        userId: u.id,
        username: u.username,
        phone: maskPhone(u.phone), // 默认脱敏（全号走 GET /users/:id/phone 审计接口）
        invitedCount: invitedCountBy.get(u.id) ?? 0,
        inviteeConsumed: (inviteeConsumedBy.get(u.id) ?? zero()).toString(),
        rebateEarned: (rebateByInviter.get(u.id) ?? zero()).toString(),
        rebateRate: u.rebateRate.toString(),
        discount: u.discount.toString(),
      }))
      .sort((a, b) => Number(b.rebateEarned) - Number(a.rebateEarned)) // 返利倒序

    const total = rows.length
    const start = (page - 1) * pageSize
    return {
      summary: {
        inviterCount,
        invitedTotal,
        inviteeConsumed: (inviteeConsumedAgg._sum.amount ?? zero()).toString(),
        rebateTotal: (rebateTotalAgg._sum.amount ?? zero()).toString(),
      },
      items: rows.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  // ==================== 邀请配置弹窗扩展数据（2026-08-31） ====================

  /**
   * `GET admin/dist/users/:id/invite-rebate-detail`：邀请配置弹窗一次下发扩展数据——
   * ① rebate 汇总（关闭邀请确认弹窗：累计返利/已提现/尚未提现）；
   * ② network 一/二级人数（「名下 N 位一级下级（团队共 M 人）」）；
   * ③ corpKids「下级进企业后仍计返利」逐人列表：我的直接下级中的占用中企业管理员
   *   （member ACTIVE/DISABLED + team ACTIVE/GRACE）；enabled=生效值（本人 corpPassUp ?? 全局 corpCounts，
   *   逐人设定优先于全局），overridden=是否单独设定过；
   * ④ upstreamRebateRate「给上一级的比例」只读：无上级 null；有上级取其 level2RebateRate（null→全局默认 0.10）。
   */
  async getInviteRebateDetail(userId: number) {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, invitedById: true },
    })
    if (!me) throw new NotFoundException("用户不存在")

    const zero = () => new Prisma.Decimal(0)
    const occupyingAdmin = {
      role: "ADMIN" as const,
      status: { in: ["ACTIVE", "DISABLED"] },
      team: { status: { in: [TeamStatus.ACTIVE, TeamStatus.GRACE] } },
    }
    const [
      ruleRow,
      earnedAgg,
      withdrawnAgg,
      availableAgg,
      level1Count,
      level2Count,
      corpKidRows,
      upstream,
    ] = await Promise.all([
      this.prisma.rebateRule.findFirst({ orderBy: { id: "asc" } }),
      this.prisma.creditTransaction.aggregate({
        where: { userId, type: CreditTxnType.REBATE_IN },
        _sum: { amount: true },
      }),
      this.prisma.creditTransaction.aggregate({
        where: { userId, type: CreditTxnType.REBATE_WITHDRAW },
        _sum: { amount: true },
      }),
      this.prisma.creditLot.aggregate({
        where: { userId, bucket: CreditBucket.REBATE, status: "ACTIVE", remaining: { gt: 0 } },
        _sum: { remaining: true },
      }),
      this.prisma.user.count({ where: { invitedById: userId } }),
      this.prisma.user.count({ where: { invitedBy: { invitedById: userId } } }),
      this.prisma.user.findMany({
        where: { invitedById: userId, teamMemberships: { some: occupyingAdmin } },
        orderBy: { id: "asc" },
        select: {
          id: true,
          username: true,
          corpPassUp: true,
          teamMemberships: {
            where: occupyingAdmin,
            select: { team: { select: { id: true, name: true } } },
          },
        },
      }),
      me.invitedById != null
        ? this.prisma.user.findUnique({
            where: { id: me.invitedById },
            select: { level2RebateRate: true },
          })
        : null,
    ])

    const corpCounts = ruleRow?.corpCounts ?? true
    return {
      rebate: {
        earned: (earnedAgg._sum.amount ?? zero()).toString(),
        withdrawn: (withdrawnAgg._sum.amount ?? zero()).toString(),
        available: (availableAgg._sum.remaining ?? zero()).toString(),
      },
      network: { level1Count, level2Count },
      corpKids: corpKidRows.map(u => ({
        userId: u.id,
        username: u.username,
        teamId: u.teamMemberships[0]?.team.id ?? null,
        teamName: u.teamMemberships[0]?.team.name ?? null,
        enabled: u.corpPassUp ?? corpCounts, // 生效值：逐人设定优先，未设定跟随全局
        overridden: u.corpPassUp != null,
      })),
      upstreamRebateRate:
        me.invitedById == null
          ? null
          : (
              upstream?.level2RebateRate ?? new Prisma.Decimal(DEFAULT_LEVEL2_REBATE_RATE)
            ).toString(),
    }
  }

  /** 关系树 CSV 导出（带 BOM，Excel 中文不乱码；转义风格与收据/团队用量导出一致；全量不分页） */
  async exportCsv(userId: number) {
    const tree = await this.loadTree(userId)
    const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    const yn = tree.corpCounts ? "是" : "否"
    const lines = ["层级,用户ID,用户名,上级,本月消耗积分,本月贡献返利,二级人数,企业池消耗计返利"]
    lines.push(
      ["本体", String(tree.user.id), escape(tree.user.username), "", "", "", "", yn].join(",")
    )
    for (const l1 of tree.level1) {
      lines.push(
        [
          "一级",
          String(l1.id),
          escape(l1.username),
          escape(tree.user.username),
          l1.monthConsumed,
          l1.monthRebateContributed,
          String(l1.level2Total),
          yn,
        ].join(",")
      )
      for (const l2 of l1.level2All) {
        lines.push(
          [
            "二级",
            String(l2.id),
            escape(l2.username),
            escape(l1.username),
            l2.monthConsumed,
            "",
            "",
            yn,
          ].join(",")
        )
      }
    }
    return "﻿" + lines.join("\n")
  }

  /**
   * 全局分销关系 CSV 导出（2026-09-02 bug29，原型对齐）：分销管理范围内**全部网络**一次导出。
   * 字段与顺序按原型：姓名、手机号、邀请人、身份、直接下线、消耗、返利归属、企业归属。
   * 口径与关系树节点完全一致（复用 loadTree 聚合）：消耗=全历史累计（企业管理员含本企业全队池卷起）、
   * 返利归属=全历史实付多级受益人精确金额（4dp 不截断，rebateAttribution.totalAmount）；
   * 手机号脱敏与页面/个人订阅导出同口径。空归属「—」，个人计费「个人计费」。
   */
  async exportAllCsv() {
    const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    // 网络根 = 无邀请人且名下有被邀请人（被邀请人的下级归属其顶层上级的网络，与关系树同口径）
    const roots = await this.prisma.user.findMany({
      where: { invitedById: null, invitees: { some: {} } },
      orderBy: { id: "asc" },
      select: { id: true },
    })
    // 直接下线数：一次性全表按邀请人分组（两级封顶下二级应为 0，但按真实数据出，不假设）
    const kidsGroup = await this.prisma.user.groupBy({
      by: ["invitedById"],
      where: { invitedById: { not: null } },
      _count: { _all: true },
    })
    const kidsBy = new Map(kidsGroup.map(k => [k.invitedById as number, k._count._all]))

    const identity = (u: { canInvite: boolean }, isRoot: boolean) =>
      isRoot && u.canInvite ? "团队长" : u.canInvite ? "可邀请" : "普通"
    const attributionText = (attr: { username: string; totalAmount: string }[]) =>
      attr.length ? attr.map(a => `${a.username}+${a.totalAmount}`).join(" / ") : "—"
    const teamText = (team: { name: string | null } | null) =>
      team ? (team.name ?? "未命名团队") : "个人计费"

    const lines = ["姓名,手机号,邀请人,身份,直接下线,消耗,返利归属,企业归属"]
    for (const root of roots) {
      const tree = await this.loadTree(root.id)
      lines.push(
        [
          escape(tree.user.username),
          tree.user.phone,
          "—",
          identity(tree.user, true),
          String(kidsBy.get(tree.user.id) ?? 0),
          tree.user.totalConsumed,
          "—", // 根无上游
          teamText(tree.user.team),
        ].join(",")
      )
      for (const l1 of tree.level1) {
        lines.push(
          [
            escape(l1.username),
            l1.phone,
            escape(tree.user.username),
            identity(l1, false),
            String(kidsBy.get(l1.id) ?? 0),
            l1.totalConsumed,
            escape(attributionText(l1.rebateAttribution)),
            teamText(l1.team),
          ].join(",")
        )
        for (const l2 of l1.level2All) {
          lines.push(
            [
              escape(l2.username),
              l2.phone,
              escape(l1.username),
              identity(l2, false),
              String(kidsBy.get(l2.id) ?? 0),
              l2.totalConsumed,
              escape(attributionText(l2.rebateAttribution)),
              teamText(l2.team),
            ].join(",")
          )
        }
      }
    }
    this.logger.log(`exportAllCsv roots=${roots.length} rows=${lines.length - 1}`)
    return "﻿" + lines.join("\n")
  }

  // ==================== 内部工具 ====================

  private presentRule(row: {
    corpCounts: boolean
    maxLayers: number | null
    perInviterCap: number | null
    perConsumeCapPct: Prisma.Decimal | null
  }) {
    return {
      corpCounts: row.corpCounts,
      maxLayers: row.maxLayers,
      perInviterCap: row.perInviterCap,
      perConsumeCapPct: row.perConsumeCapPct?.toString() ?? null,
    }
  }

  /**
   * 装载完整关系树（二级不分页，供 getTree 切片 / exportCsv 全量导出共用）。
   * scope=成员范围筛选（2026-08-31）：all=全部；inviter=仅可邀请（= 本人 canInvite 落库值，
   * 2026-09-01 起落库制无派生）；team=仅已进企业（占用中：ACTIVE/DISABLED 成员 +
   * ACTIVE/GRACE 团队，与用户管理 hasTeam 同口径）；personal=仅个人计费。不匹配的一级成员若含匹配的
   * 二级成员仍保留作上下文；level2All/level2Total 按筛选后计。导出始终全量（all）。
   */
  private async loadTree(userId: number, scope: "all" | "inviter" | "team" | "personal" = "all") {
    // 占用中企业身份（成员 ACTIVE/DISABLED + 团队 ACTIVE/GRACE）——节点企业徽章/team scope 共用
    const occupyingMemberSelect = {
      role: true,
      status: true,
      team: { select: { id: true, name: true, status: true } },
    } as const
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        phone: true,
        rebateRate: true,
        level2RebateRate: true,
        rebateEnabled: true,
        inviteQuota: true,
        canInvite: true, // 根节点徽章 + scope=inviter 时一级成员派生判定用
        isActive: true, // 「已停用」徽章（2026-08-31 第六批）
        subInviteAllowed: true, // 下级可继续邀请（邀请配置弹窗回显；此前 PATCH 可写但读接口不返回）
        teamMemberships: { select: occupyingMemberSelect }, // 「企业管理员·团队名」徽章
      },
    })
    if (!user) throw new NotFoundException("用户不存在")

    const now = new Date()
    // 本月消耗/返利：北京自然月口径（与返利月封顶、钱包本月已用同切点）
    const monthStart = beijingMonthStart(now)
    const zero = () => new Prisma.Decimal(0)

    const [ruleRow, inviteQuotaUsed, level1Users] = await Promise.all([
      this.prisma.rebateRule.findFirst({ orderBy: { id: "asc" } }),
      // 已用名额 = 实际建号的直接下级数（含手机号自助注册）
      this.prisma.user.count({ where: { invitedById: userId } }),
      this.prisma.user.findMany({
        where: { invitedById: userId },
        orderBy: { id: "asc" },
        select: {
          id: true,
          username: true,
          phone: true,
          canInvite: true,
          isActive: true,
          discount: true, // 邀请配置弹窗回显（2026-08-31 补）
          rebateRate: true, // 同上
          teamMemberships: { select: occupyingMemberSelect },
        },
      }),
    ])
    const corpCounts = ruleRow?.corpCounts ?? true
    const level1Ids = level1Users.map(u => u.id)

    const level2Users = level1Ids.length
      ? await this.prisma.user.findMany({
          where: { invitedById: { in: level1Ids } },
          orderBy: { id: "asc" },
          select: {
            id: true,
            username: true,
            phone: true,
            invitedById: true,
            canInvite: true,
            isActive: true,
            discount: true, // 同一级，邀请配置弹窗回显
            rebateRate: true, // 同上
            teamMemberships: { select: occupyingMemberSelect },
          },
        })
      : []
    const allIds = [...level1Ids, ...level2Users.map(u => u.id)]

    // 占用中企业成员行（成员 ACTIVE/DISABLED + 团队 ACTIVE/GRACE）——team scope / 企业徽章 / 池卷起共用
    type MembershipRow = {
      role: string
      status: string
      team: { id: number; name: string | null; status: string }
    }
    const occupyingMembership = (u: { teamMemberships: MembershipRow[] }) =>
      u.teamMemberships.find(
        m =>
          (m.status === "ACTIVE" || m.status === "DISABLED") &&
          (m.team.status === TeamStatus.ACTIVE || m.team.status === TeamStatus.GRACE)
      )
    // 树内「占用中企业管理员」节点的企业 id 集（2026-09-01：池消耗/池返利向上卷起到管理员节点）
    const adminTeamIds = [
      ...new Set(
        [user, ...level1Users, ...level2Users]
          .map(u => occupyingMembership(u))
          .filter((m): m is MembershipRow => !!m && m.role === "ADMIN")
          .map(m => m.team.id)
      ),
    ]

    const [
      consumeRows,
      rebatePairRows,
      rootRebateAgg,
      rebateLotRows,
      rebateEarnedRows,
      poolConsumeRows,
      poolRebateRows,
      consumeTotalRows,
      rebatePairTotalRows,
      rootRebateTotalAgg,
      poolConsumeTotalRows,
      poolRebateTotalRows,
    ] = await Promise.all([
      // 本月消耗（含根用户本人）：按 用户×类型 分组——个人 CONSUME 与企业池 TEAM_CONSUME 拆开，
      // 节点据此渲染「消耗来自企业共享池」标注（monthTeamConsumed>0，2026-08-31 第六批）
      this.prisma.creditTransaction.groupBy({
        by: ["userId", "type"],
        where: {
          userId: { in: [...allIds, userId] },
          type: { in: [CreditTxnType.CONSUME, CreditTxnType.TEAM_CONSUME] },
          createdAt: { gte: monthStart },
        },
        _sum: { amount: true },
      }),
      // 本月返利归属（收款人×消费者 成对聚合）：一级→根、二级→其一级上级+根；
      // 节点「返利归属」列取实付口径（REBATE_IN.relatedUserId=消费者），monthRebateContributed 同源于此
      allIds.length
        ? this.prisma.creditTransaction.groupBy({
            by: ["userId", "relatedUserId"],
            where: {
              userId: { in: [userId, ...level1Ids] },
              type: CreditTxnType.REBATE_IN,
              relatedUserId: { in: allIds },
              createdAt: { gte: monthStart },
            },
            _sum: { amount: true },
          })
        : [],
      // 根节点本月实得返利合计（B20：全网络贡献，含一级+二级）
      this.prisma.creditTransaction.aggregate({
        where: { userId, type: CreditTxnType.REBATE_IN, createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      // 返利可提现余额（REBATE 桶 ACTIVE 批次剩余合计）——树节点「返利提现」按钮显示条件与额度（2026-08-31 补）
      allIds.length
        ? this.prisma.creditLot.groupBy({
            by: ["userId"],
            where: {
              userId: { in: allIds },
              bucket: CreditBucket.REBATE,
              status: "ACTIVE",
              remaining: { gt: 0 },
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            _sum: { remaining: true },
          })
        : [],
      // 累计返利入账（REBATE_IN 全量，不分月）——提现弹窗「累计入账/已提现」展示用（2026-08-31 补）
      allIds.length
        ? this.prisma.creditTransaction.groupBy({
            by: ["userId"],
            where: { userId: { in: allIds }, type: CreditTxnType.REBATE_IN },
            _sum: { amount: true },
          })
        : [],
      // 树内企业管理员节点的本月池消耗（TEAM_CONSUME 按企业聚合，全队含本人；2026-09-01 卷起）
      adminTeamIds.length
        ? this.prisma.creditTransaction.groupBy({
            by: ["teamId"],
            where: {
              teamId: { in: adminTeamIds },
              type: CreditTxnType.TEAM_CONSUME,
              createdAt: { gte: monthStart },
            },
            _sum: { amount: true },
          })
        : [],
      // 本月池段返利（REBATE_IN 带 teamId，2026-09-01 起结算时写入）按 收款人×企业 聚合——
      // 卷起到企业管理员节点的「返利归属」（消费者本人可能不在树内，不能按 relatedUserId 归）
      adminTeamIds.length
        ? this.prisma.creditTransaction.groupBy({
            by: ["userId", "teamId"],
            where: {
              teamId: { in: adminTeamIds },
              type: CreditTxnType.REBATE_IN,
              userId: { in: [userId, ...level1Ids] },
              createdAt: { gte: monthStart },
            },
            _sum: { amount: true },
          })
        : [],
      // ===== 累计口径（2026-09-01 bug14/15：树统计列由「本月」改「累计」，total* 与 month* 并存） =====
      // 累计消耗（含根本人）：个人 CONSUME + 企业池 TEAM_CONSUME 全历史，按 用户×类型
      this.prisma.creditTransaction.groupBy({
        by: ["userId", "type"],
        where: {
          userId: { in: [...allIds, userId] },
          type: { in: [CreditTxnType.CONSUME, CreditTxnType.TEAM_CONSUME] },
        },
        _sum: { amount: true },
      }),
      // 累计返利归属（收款人×消费者 成对，全历史；不按自然月过滤、不按现行规则追溯重算）
      allIds.length
        ? this.prisma.creditTransaction.groupBy({
            by: ["userId", "relatedUserId"],
            where: {
              userId: { in: [userId, ...level1Ids] },
              type: CreditTxnType.REBATE_IN,
              relatedUserId: { in: allIds },
            },
            _sum: { amount: true },
          })
        : [],
      // 根节点累计实得返利合计（全历史）
      this.prisma.creditTransaction.aggregate({
        where: { userId, type: CreditTxnType.REBATE_IN },
        _sum: { amount: true },
      }),
      // 树内企业管理员节点的累计池消耗（全队含本人）
      adminTeamIds.length
        ? this.prisma.creditTransaction.groupBy({
            by: ["teamId"],
            where: { teamId: { in: adminTeamIds }, type: CreditTxnType.TEAM_CONSUME },
            _sum: { amount: true },
          })
        : [],
      // 累计池段返利（收款人×企业，全历史；存量行 teamId=null 不参与——backfill-rebate-team-id 回填）
      adminTeamIds.length
        ? this.prisma.creditTransaction.groupBy({
            by: ["userId", "teamId"],
            where: {
              teamId: { in: adminTeamIds },
              type: CreditTxnType.REBATE_IN,
              userId: { in: [userId, ...level1Ids] },
            },
            _sum: { amount: true },
          })
        : [],
    ])

    const consumedBy = new Map<number, Prisma.Decimal>()
    const teamConsumedBy = new Map<number, Prisma.Decimal>()
    for (const r of consumeRows) {
      const amt = r._sum.amount ?? zero()
      consumedBy.set(r.userId, (consumedBy.get(r.userId) ?? zero()).plus(amt))
      if (r.type === CreditTxnType.TEAM_CONSUME) {
        teamConsumedBy.set(r.userId, (teamConsumedBy.get(r.userId) ?? zero()).plus(amt))
      }
    }
    // 返利归属成对表：key = `${收款人}:${消费者}`
    const rebatePairBy = new Map<string, Prisma.Decimal>()
    for (const r of rebatePairRows) {
      if (r.relatedUserId != null) {
        rebatePairBy.set(`${r.userId}:${r.relatedUserId}`, r._sum.amount ?? zero())
      }
    }
    const rebateBalanceBy = new Map<number, Prisma.Decimal>()
    for (const r of rebateLotRows) rebateBalanceBy.set(r.userId, r._sum.remaining ?? zero())
    const rebateEarnedBy = new Map<number, Prisma.Decimal>()
    for (const r of rebateEarnedRows) rebateEarnedBy.set(r.userId, r._sum.amount ?? zero())
    // 池卷起表（2026-09-01）：企业本月池消耗合计；池返利按 `${收款人}:${teamId}` 成对
    const poolConsumeByTeam = new Map<number, Prisma.Decimal>()
    for (const r of poolConsumeRows) {
      if (r.teamId != null) poolConsumeByTeam.set(r.teamId, r._sum.amount ?? zero())
    }
    const poolRebateBy = new Map<string, Prisma.Decimal>()
    for (const r of poolRebateRows) {
      if (r.teamId != null) poolRebateBy.set(`${r.userId}:${r.teamId}`, r._sum.amount ?? zero())
    }
    // ===== 累计映射（bug14/15，全历史） =====
    const totalConsumedBy = new Map<number, Prisma.Decimal>()
    const teamTotalConsumedBy = new Map<number, Prisma.Decimal>()
    for (const r of consumeTotalRows) {
      const amt = r._sum.amount ?? zero()
      totalConsumedBy.set(r.userId, (totalConsumedBy.get(r.userId) ?? zero()).plus(amt))
      if (r.type === CreditTxnType.TEAM_CONSUME) {
        teamTotalConsumedBy.set(r.userId, (teamTotalConsumedBy.get(r.userId) ?? zero()).plus(amt))
      }
    }
    const rebatePairTotalBy = new Map<string, Prisma.Decimal>() // `${收款人}:${消费者}`
    for (const r of rebatePairTotalRows) {
      if (r.relatedUserId != null) {
        rebatePairTotalBy.set(`${r.userId}:${r.relatedUserId}`, r._sum.amount ?? zero())
      }
    }
    const poolConsumeTotalByTeam = new Map<number, Prisma.Decimal>()
    for (const r of poolConsumeTotalRows) {
      if (r.teamId != null) poolConsumeTotalByTeam.set(r.teamId, r._sum.amount ?? zero())
    }
    const poolRebateTotalBy = new Map<string, Prisma.Decimal>() // `${收款人}:${teamId}`
    for (const r of poolRebateTotalRows) {
      if (r.teamId != null)
        poolRebateTotalBy.set(`${r.userId}:${r.teamId}`, r._sum.amount ?? zero())
    }
    const level2ByParent = new Map<number, typeof level2Users>()
    for (const u of level2Users) {
      if (u.invitedById == null) continue
      const list = level2ByParent.get(u.invitedById) ?? []
      list.push(u)
      level2ByParent.set(u.invitedById, list)
    }

    // scope 匹配判定（all 直接全放行，不触碰团队/权限字段）
    const occupying = (u: { teamMemberships: MembershipRow[] }) => !!occupyingMembership(u)
    // 节点企业徽章数据（2026-08-31 第六批）：占用中成员 → { id, name, role }；个人计费 → null
    const teamBadge = (u: { teamMemberships: MembershipRow[] }) => {
      const m = occupyingMembership(u)
      return m ? { id: m.team.id, name: m.team.name ?? "未命名团队", role: m.role } : null
    }
    // 返利归属行：实付给某上级的返利 = 个人段（relatedUserId=节点本人）+ 企业管理员节点的池段
    // （teamId=其企业，REBATE_IN 落 teamId，2026-09-01 起；消费者可能不在树内，按企业归）。
    // amount=本月、totalAmount=累计（bug14/15）；两者都 ≤0 才不下发（0 是噪音）
    const attribution = (
      to: { id: number; username: string },
      fromId: number,
      teamId?: number | null
    ) => {
      const monthAmt = (rebatePairBy.get(`${to.id}:${fromId}`) ?? zero()).plus(
        teamId != null ? (poolRebateBy.get(`${to.id}:${teamId}`) ?? zero()) : zero()
      )
      const totalAmt = (rebatePairTotalBy.get(`${to.id}:${fromId}`) ?? zero()).plus(
        teamId != null ? (poolRebateTotalBy.get(`${to.id}:${teamId}`) ?? zero()) : zero()
      )
      if (monthAmt.lte(0) && totalAmt.lte(0)) return []
      return [
        {
          userId: to.id,
          username: to.username,
          amount: monthAmt.toString(),
          totalAmount: totalAmt.toString(),
        },
      ]
    }
    // 节点的「企业池消耗」：企业管理员 = 本企业全队池消耗（含本人池消耗，卷起成员）；
    // 其余节点 = 本人 TEAM_CONSUME。本月版 →「消耗来自企业共享池」标注；累计版 → 累计列展示
    const nodeTeamConsumed = (u: { id: number; teamMemberships: MembershipRow[] }) => {
      const m = occupyingMembership(u)
      if (m && m.role === "ADMIN") return poolConsumeByTeam.get(m.team.id) ?? zero()
      return teamConsumedBy.get(u.id) ?? zero()
    }
    const nodeTotalTeamConsumed = (u: { id: number; teamMemberships: MembershipRow[] }) => {
      const m = occupyingMembership(u)
      if (m && m.role === "ADMIN") return poolConsumeTotalByTeam.get(m.team.id) ?? zero()
      return teamTotalConsumedBy.get(u.id) ?? zero()
    }
    // 节点的「消耗」列（2026-09-01 修订）：企业管理员 = 本人个人消耗 + 本企业全队池消耗
    //（池合计含本人池行，先剔除本人池行防双计；monthTeamConsumed/totalTeamConsumed 是它的池子集，做标注用）；
    // 其余节点 = 本人消耗（个人 + 本人池行）
    const nodeMonthConsumed = (u: { id: number; teamMemberships: MembershipRow[] }) => {
      const own = consumedBy.get(u.id) ?? zero()
      const m = occupyingMembership(u)
      if (m && m.role === "ADMIN") {
        return own
          .minus(teamConsumedBy.get(u.id) ?? zero())
          .plus(poolConsumeByTeam.get(m.team.id) ?? zero())
      }
      return own
    }
    const nodeTotalConsumed = (u: { id: number; teamMemberships: MembershipRow[] }) => {
      const own = totalConsumedBy.get(u.id) ?? zero()
      const m = occupyingMembership(u)
      if (m && m.role === "ADMIN") {
        return own
          .minus(teamTotalConsumedBy.get(u.id) ?? zero())
          .plus(poolConsumeTotalByTeam.get(m.team.id) ?? zero())
      }
      return own
    }
    // 节点的企业 id（仅占用中企业管理员；池返利归属/池消耗卷起用）
    const adminTeamIdOf = (u: { teamMemberships: MembershipRow[] }) => {
      const m = occupyingMembership(u)
      return m && m.role === "ADMIN" ? m.team.id : null
    }
    // 可邀请 = 本人 canInvite 落库值（2026-09-01 起落库制：上级开「下级可继续邀请」时已批量写入一级下级，
    // 收回时已批量清库；读侧不再派生，一级/二级同口径）
    type L1Row = (typeof level1Users)[number]
    type L2Row = (typeof level2Users)[number]
    const matchScope = (u: L1Row | L2Row) => {
      if (scope === "inviter") return u.canInvite
      if (scope === "team") return occupying(u)
      if (scope === "personal") return !occupying(u)
      return true
    }

    const level1 = level1Users
      .filter(
        // 不匹配的一级成员若含匹配的二级成员仍保留作上下文（否则二级会成孤儿节点）
        u => matchScope(u) || (level2ByParent.get(u.id) ?? []).some(l2 => matchScope(l2))
      )
      .map(u => {
        const l2Matched = (level2ByParent.get(u.id) ?? []).filter(l2 => matchScope(l2))
        const adTid = adminTeamIdOf(u) // 占用中企业管理员 → 其企业 id（池卷起）
        return {
          id: u.id,
          username: u.username,
          phone: maskPhone(u.phone), // 下级手机号默认脱敏（2026-08-30 补，前端 PhoneCell 渲染）
          monthConsumed: nodeMonthConsumed(u).toString(), // 企业管理员=本人个人+全队池（2026-09-01 修订）
          // 企业管理员节点=本企业全队池消耗（2026-09-01 卷起）；其余=本人池消耗
          monthTeamConsumed: nodeTeamConsumed(u).toString(),
          // 本月为根贡献返利 = 本人个人段 + （企业管理员）本企业池段
          monthRebateContributed: (rebatePairBy.get(`${userId}:${u.id}`) ?? zero())
            .plus(adTid != null ? (poolRebateBy.get(`${userId}:${adTid}`) ?? zero()) : zero())
            .toString(),
          // 累计版（2026-09-01 bug14/15：树统计列由「本月」改「累计」，全历史、不按自然月过滤）
          totalConsumed: nodeTotalConsumed(u).toString(), // 企业管理员=本人个人+全队池；其余=本人（个人+本人池）
          totalTeamConsumed: nodeTotalTeamConsumed(u).toString(), // 累计池消耗（管理员=全队）
          totalRebateContributed: (rebatePairTotalBy.get(`${userId}:${u.id}`) ?? zero())
            .plus(adTid != null ? (poolRebateTotalBy.get(`${userId}:${adTid}`) ?? zero()) : zero())
            .toString(), // 累计为根贡献返利 = 个人段+池段
          // 邀请配置/返利提现按钮数据（2026-08-31 补）：canInvite=本人独立开关原始值
          // （派生权限口径不变，前端按 canInvite || rebate>0 给提现按钮）；discount/rebateRate 回显弹窗初值；
          // rebate=可提现余额（REBATE 桶剩余），rebateEarned=累计返利入账（REBATE_IN 全量）
          canInvite: u.canInvite,
          discount: u.discount.toString(),
          rebateRate: u.rebateRate.toString(),
          rebate: (rebateBalanceBy.get(u.id) ?? zero()).toString(),
          rebateEarned: (rebateEarnedBy.get(u.id) ?? zero()).toString(),
          // 徽章数据（2026-08-31 第六批）：有效邀请权（一级含根派生）/停用/企业身份/返利归属
          effectiveCanInvite: u.canInvite, // 有效邀请权=落库值（2026-09-01 起落库制）
          isActive: u.isActive,
          team: teamBadge(u),
          rebateAttribution: attribution(user, u.id, adTid), // 一级 → 根（含池段卷起；amount=本月/totalAmount=累计）
          level2Total: l2Matched.length,
          level2All: l2Matched.map(l2 => {
            const adTid2 = adminTeamIdOf(l2)
            return {
              id: l2.id,
              username: l2.username,
              phone: maskPhone(l2.phone), // 同上，脱敏
              monthConsumed: nodeMonthConsumed(l2).toString(), // 同一级口径（管理员节点含全队池）
              monthTeamConsumed: nodeTeamConsumed(l2).toString(),
              // 该二级成员本月贡献给根用户的返利 = 本人个人段 + （企业管理员）本企业池段
              monthRebateContributed: (rebatePairBy.get(`${userId}:${l2.id}`) ?? zero())
                .plus(adTid2 != null ? (poolRebateBy.get(`${userId}:${adTid2}`) ?? zero()) : zero())
                .toString(),
              totalConsumed: nodeTotalConsumed(l2).toString(),
              totalTeamConsumed: nodeTotalTeamConsumed(l2).toString(),
              totalRebateContributed: (rebatePairTotalBy.get(`${userId}:${l2.id}`) ?? zero())
                .plus(
                  adTid2 != null ? (poolRebateTotalBy.get(`${userId}:${adTid2}`) ?? zero()) : zero()
                )
                .toString(),
              canInvite: l2.canInvite, // 同一级：按钮数据五件套
              discount: l2.discount.toString(),
              rebateRate: l2.rebateRate.toString(),
              rebate: (rebateBalanceBy.get(l2.id) ?? zero()).toString(),
              rebateEarned: (rebateEarnedBy.get(l2.id) ?? zero()).toString(),
              effectiveCanInvite: l2.canInvite, // 落库值（二级不再开下级，网络两级封顶）
              isActive: l2.isActive,
              team: teamBadge(l2),
              // 二级 → 其一级上级 + 根（实付口径，含池段卷起；amount=本月/totalAmount=累计）
              rebateAttribution: [
                ...attribution(u, l2.id, adTid2),
                ...attribution(user, l2.id, adTid2),
              ],
            }
          }),
        }
      })

    // 网络合计（树卡片头部「团队 N 人 / 计费消耗」，不含根本人；按筛选后口径与展示一致，2026-08-31 第六批）
    const networkCount = level1.reduce((n, l1) => n + 1 + l1.level2Total, 0)
    // 网络消耗合计（2026-09-07 bug30 复修）：同一笔企业池消耗只计一次——企业管理员节点已卷起全队池，
    // 同企业成员节点的本人池行不再重复计入（此前直接加总节点值，管理员+成员同企业在树时池消耗双计）；
    // 管理员不在树内时无卷起，按成员本人池行计。月版/累计版同口径
    const keptL1 = level1Users.filter(
      u => matchScope(u) || (level2ByParent.get(u.id) ?? []).some(l2 => matchScope(l2))
    )
    const keptNodes = [
      ...keptL1,
      ...keptL1.flatMap(u => (level2ByParent.get(u.id) ?? []).filter(l2 => matchScope(l2))),
    ]
    const adminTeamIdsInTree = new Set<number>()
    for (const u of keptNodes) {
      const m = occupyingMembership(u)
      if (m && m.role === "ADMIN") adminTeamIdsInTree.add(m.team.id)
    }
    const networkConsumedOf = (
      ownBy: Map<number, Prisma.Decimal>, // 本人消耗（个人段+本人池行）
      ownPoolBy: Map<number, Prisma.Decimal>, // 本人池行
      teamPoolBy: Map<number, Prisma.Decimal> // 全队池合计
    ) => {
      let total = zero()
      const poolCountedTeams = new Set<number>() // 同企业多管理员行时池也只卷一次
      for (const u of keptNodes) {
        const m = occupyingMembership(u)
        const own = ownBy.get(u.id) ?? zero()
        if (m && m.role === "ADMIN" && !poolCountedTeams.has(m.team.id)) {
          // 管理员节点：本人个人段 + 本企业全队池（卷起）
          poolCountedTeams.add(m.team.id)
          total = total
            .plus(own.minus(ownPoolBy.get(u.id) ?? zero()))
            .plus(teamPoolBy.get(m.team.id) ?? zero())
        } else if (m && adminTeamIdsInTree.has(m.team.id)) {
          // 同企业管理员已在树内卷起池 → 只计本人个人段
          total = total.plus(own.minus(ownPoolBy.get(u.id) ?? zero()))
        } else {
          total = total.plus(own)
        }
      }
      return total.toString()
    }
    const networkMonthConsumed = networkConsumedOf(consumedBy, teamConsumedBy, poolConsumeByTeam)
    // 累计版网络消耗（bug14/15：卡片头部「本月消耗」改「累计消耗」）
    const networkTotalConsumed = networkConsumedOf(
      totalConsumedBy,
      teamTotalConsumedBy,
      poolConsumeTotalByTeam
    )

    return {
      user: {
        id: user.id,
        username: user.username,
        phone: maskPhone(user.phone), // 默认脱敏（全号走 GET /users/:id/phone 审计接口）
        rebateRate: user.rebateRate.toString(),
        level2RebateRate: user.level2RebateRate?.toString() ?? null,
        rebateEnabled: user.rebateEnabled,
        inviteQuota: user.inviteQuota,
        inviteQuotaUsed,
        subInviteAllowed: user.subInviteAllowed,
        // 根节点徽章同下级口径（2026-08-31 第六批）：可邀请/已停用/企业管理员·团队名/下线数
        canInvite: user.canInvite,
        effectiveCanInvite: user.canInvite, // 根无上级，有效邀请权=本人开关落库值
        isActive: user.isActive,
        team: teamBadge(user),
        level1Total: level1.length, // 「下线 N」徽章（直接下级数，按筛选后口径）
        // 根节点本人本月消耗 + 本月实得返利（2026-08-31 补，与下级节点同口径渲染）
        monthConsumed: nodeMonthConsumed(user).toString(), // 根是企业管理员时=本人个人+本企业全队池
        monthTeamConsumed: nodeTeamConsumed(user).toString(), // 根是企业管理员时=本企业全队池消耗
        monthRebateEarned: (rootRebateAgg._sum.amount ?? zero()).toString(),
        // 累计版（bug14/15）：根本人累计消耗 + 累计池消耗 + 累计实得返利
        totalConsumed: nodeTotalConsumed(user).toString(),
        totalTeamConsumed: nodeTotalTeamConsumed(user).toString(),
        totalRebateEarned: (rootRebateTotalAgg._sum.amount ?? zero()).toString(),
      },
      corpCounts,
      networkCount, // 团队 N 人（一级+二级，不含根；按筛选后口径）
      networkMonthConsumed, // 网络计费消耗·本月（一级+二级本月消耗合计，不含根）
      networkTotalConsumed, // 网络计费消耗·累计（bug14/15）
      level1,
    }
  }
}
