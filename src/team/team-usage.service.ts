import { Injectable } from "@nestjs/common"
import { CreditTxnType, UsageLog } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { labelForSource } from "../usage/usage-source-labels"
import { QueryUsageDto } from "./dto/console.dto"

export interface UsageAggregateRow {
  key: string // 维度键（member=userId 字符串 / source / model）
  label: string // 展示名（成员姓名 / 功能标识 / 模型名）
  /** 成员维度行的成员状态（ACTIVE/DISABLED/ARCHIVED/REMOVED=已移出）；非 member 维度为 null */
  memberStatus: string | null
  calls: number // 调用次数（UsageLog 行数）
  credits: Decimal // 消耗积分合计（UsageLog.credits，旧数据为 null 按 0 计）
  costCny: Decimal // 人民币成本合计
}

export interface UsageAggregateResult {
  dimension: QueryUsageDto["dimension"]
  range: { startDate: Date; endDate: Date }
  total: { calls: number; credits: Decimal; costCny: Decimal }
  /** 池维度本月实际扣减（TEAM_CONSUME 流水合计，billing-truth；区间同上） */
  poolConsumed: Decimal
  rows: UsageAggregateRow[]
}

/** 单次聚合扫描的 UsageLog 行数上限（团队席位有限，月度行数远低于此） */
const USAGE_SCAN_LIMIT = 20000

/**
 * 用量分析：聚合团队成员的 UsageLog（按成员/功能/模型）+ CreditTransaction(teamId) 的
 * TEAM_CONSUME 流水（池实际扣减），并提供 CSV 导出（BOM + 转义，与收据导出同风格）。
 */
@Injectable()
export class TeamUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async aggregate(teamId: number, query: QueryUsageDto): Promise<UsageAggregateResult> {
    const range = this.resolveRange(query)
    const members = await this.prisma.teamMember.findMany({
      where: { teamId },
      include: { user: { select: { id: true, username: true } } },
    })
    // 已移出成员：移出即删成员行，按区间内企业池扣减流水（TEAM_CONSUME.userId）找回
    // 「用过企业积分」的已移出用户——成员维度要带他们，功能/模型维度与合计也要算上
    const poolConsumers = await this.prisma.creditTransaction.findMany({
      where: {
        teamId,
        type: CreditTxnType.TEAM_CONSUME,
        createdAt: { gte: range.startDate, lte: range.endDate },
      },
      select: { userId: true },
      distinct: ["userId"],
    })
    const memberIds = new Set(members.map(m => m.userId))
    const removedIds = poolConsumers.map(c => c.userId).filter(id => !memberIds.has(id))
    const removedUsers = removedIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: removedIds } },
          select: { id: true, username: true },
        })
      : []
    // 成员维度 label 只放姓名；成员状态走结构化字段 memberStatus：
    // 在职/停用/归档取成员行原值，已移出（成员行已删）记 REMOVED
    const nameOf = new Map<number, string>([
      ...removedUsers.map(u => [u.id, u.username] as const),
      ...members.map(m => [m.userId, m.user.username] as const),
    ])
    const statusOf = new Map<number, string>([
      ...removedIds.map(id => [id, "REMOVED"] as const),
      ...members.map(m => [m.userId, m.status] as const),
    ])
    const userIds = [...memberIds, ...removedIds]

    const empty = { calls: 0, credits: new Decimal(0), costCny: new Decimal(0) }
    if (!userIds.length) {
      return {
        dimension: query.dimension,
        range,
        total: empty,
        poolConsumed: new Decimal(0),
        rows: [],
      }
    }

    const [logs, poolAgg] = await Promise.all([
      this.prisma.usageLog.findMany({
        where: { userId: { in: userIds }, createdAt: { gte: range.startDate, lte: range.endDate } },
        select: { userId: true, source: true, credits: true, cost: true, meta: true },
        orderBy: { createdAt: "asc" },
        take: USAGE_SCAN_LIMIT,
      }),
      this.prisma.creditTransaction.aggregate({
        where: {
          teamId,
          type: CreditTxnType.TEAM_CONSUME,
          createdAt: { gte: range.startDate, lte: range.endDate },
        },
        _sum: { amount: true },
      }),
    ])

    const byKey = new Map<string, UsageAggregateRow>()
    const total = { calls: 0, credits: new Decimal(0), costCny: new Decimal(0) }
    for (const log of logs) {
      const { key, label } = this.dimensionKey(log, query.dimension, nameOf)
      let row = byKey.get(key)
      if (!row) {
        row = {
          key,
          label,
          memberStatus: query.dimension === "member" ? (statusOf.get(log.userId) ?? null) : null,
          calls: 0,
          credits: new Decimal(0),
          costCny: new Decimal(0),
        }
        byKey.set(key, row)
      }
      const credits = log.credits ?? new Decimal(0)
      row.calls++
      row.credits = row.credits.plus(credits)
      row.costCny = row.costCny.plus(log.cost)
      total.calls++
      total.credits = total.credits.plus(credits)
      total.costCny = total.costCny.plus(log.cost)
    }
    // 模型维度：key 是模型 code，label 换 AiModel 目录的显示名（如 gemini-3.1-pro → Gemini 3.1 Pro）；
    // 目录没有（底座直传的业务模型 id/历史值）保留原文
    if (query.dimension === "model") {
      const codes = [...byKey.keys()].filter(k => k !== "__unknown__")
      if (codes.length) {
        const models = await this.prisma.aiModel.findMany({
          where: { code: { in: codes } },
          select: { code: true, name: true },
        })
        const nameOfModel = new Map(models.map(m => [m.code, m.name] as const))
        for (const row of byKey.values()) {
          const name = nameOfModel.get(row.key)
          if (name) row.label = name
        }
      }
    }
    const rows = [...byKey.values()].sort((a, b) => (b.credits.greaterThan(a.credits) ? 1 : -1))

    return {
      dimension: query.dimension,
      range,
      total,
      poolConsumed: poolAgg._sum.amount ?? new Decimal(0),
      rows,
    }
  }

  /** CSV 导出（带 BOM，Excel 中文不乱码；转义风格与收据导出一致）。成本统一两位小数（与页面 toFixed(2) 同口径）。 */
  async exportCsv(teamId: number, query: QueryUsageDto): Promise<string> {
    const result = await this.aggregate(teamId, query)
    const dimLabel = { member: "成员", source: "功能", model: "模型" }[result.dimension]
    const withStatus = result.dimension === "member"
    const statusLabel: Record<string, string> = {
      ACTIVE: "在职",
      DISABLED: "已停用",
      ARCHIVED: "已归档",
      REMOVED: "已移出",
    }
    const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    const lines = [
      withStatus
        ? `${dimLabel},状态,调用次数,消耗积分,成本(元)`
        : `${dimLabel},调用次数,消耗积分,成本(元)`,
    ]
    for (const r of result.rows) {
      const cells = [
        escape(r.label),
        ...(withStatus ? [statusLabel[r.memberStatus ?? ""] ?? r.memberStatus ?? ""] : []),
        String(r.calls),
        r.credits.toString(),
        r.costCny.toFixed(2),
      ]
      lines.push(cells.join(","))
    }
    lines.push(
      [
        "合计",
        ...(withStatus ? [""] : []),
        String(result.total.calls),
        result.total.credits.toString(),
        result.total.costCny.toFixed(2),
      ].join(",")
    )
    return "﻿" + lines.join("\n")
  }

  /** 时间区间：缺省本月 1 号至今（与钱包「本月已用」同口径，服务器本地时区） */
  private resolveRange(query: QueryUsageDto): { startDate: Date; endDate: Date } {
    const now = new Date()
    const startDate = query.startDate
      ? new Date(query.startDate)
      : new Date(now.getFullYear(), now.getMonth(), 1)
    const endDate = query.endDate ? new Date(query.endDate) : now
    return { startDate, endDate }
  }

  /** 维度键提取：成员=userId（label 取姓名）；功能=source；模型=meta.model */
  private dimensionKey(
    log: Pick<UsageLog, "userId" | "source" | "meta">,
    dimension: QueryUsageDto["dimension"],
    nameOf: Map<number, string>
  ): { key: string; label: string } {
    if (dimension === "member") {
      const key = String(log.userId)
      return { key, label: nameOf.get(log.userId) ?? `用户#${log.userId}` }
    }
    if (dimension === "source") {
      const key = log.source ?? "__unknown__"
      // label 走全系统统一的 source→中文功能名注册表（二级功能口径，与积分明细「项目」列同源）
      return { key, label: log.source ? labelForSource(log.source) : "未标注" }
    }
    const model = (log.meta as { model?: string } | null)?.model
    return { key: model ?? "__unknown__", label: model ?? "未标注" }
  }
}
