import { Injectable, Optional } from "@nestjs/common"
import { PrismaService } from "../prisma/prisma.service"
import {
  WorkbenchPeriod,
  WorkbenchPeriodQueryDto,
  WorkbenchRecentOutputsQueryDto,
} from "./dto/workbench-query.dto"
import {
  WorkbenchOutputItem,
  workbenchOutputQueries,
  WorkbenchOutputQuery,
} from "./workbench-outputs"

/** 周期 → 滚动窗口起点天数；null=全部不限时间 */
const PERIOD_DAYS: Record<WorkbenchPeriod, number | null> = {
  [WorkbenchPeriod.ALL]: null,
  [WorkbenchPeriod.LAST_7_DAYS]: 7,
  [WorkbenchPeriod.LAST_30_DAYS]: 30,
}

function resolveSince(period: WorkbenchPeriod): Date | null {
  const days = PERIOD_DAYS[period]
  return days === null ? null : new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

/** 卖家工作台：扇出聚合各功能产出（查询定义集中在 workbench-outputs.ts），不加表不改现有功能模块 */
@Injectable()
export class WorkbenchService {
  private readonly queries: WorkbenchOutputQuery[]

  constructor(
    prisma: PrismaService,
    // @Optional()：该参数的反射类型是 Array，Nest 无法解析；注入不到时走默认值组装
    @Optional() queries: WorkbenchOutputQuery[] = workbenchOutputQueries(prisma)
  ) {
    this.queries = queries
  }

  /** 总览：汇总卡片（累计产出/覆盖功能/最近一次）+ 功能使用分布，一次并发 count 扫描同源返回 */
  async getOverview(userId: number, query: WorkbenchPeriodQueryDto) {
    const since = resolveSince(query.period)
    const counts = await Promise.all(this.queries.map(q => q.count(userId, since)))

    // 无使用记录（count=0）的功能不下发，分布卡片只展示用过的功能
    const distribution = this.queries
      .map((query, index) => ({
        featureKey: query.key,
        label: query.label,
        count: counts[index],
      }))
      .filter(item => item.count > 0)
      .sort((a, b) => b.count - a.count)

    const totalOutputs = counts.reduce((sum, count) => sum + count, 0)
    const featuresCovered = counts.filter(count => count > 0).length
    // 「最近一次」卡片不随周期筛选（原型三个页签下均显示全时间最近一次），固定按全时间口径取
    const lastOutputAt = await this.resolveLastOutputAt(userId)

    return {
      period: query.period,
      totalOutputs,
      featuresCovered,
      // 功能总数（含未使用的），供「覆盖功能 X/Y」分母使用；distribution 只含 count>0 的功能
      totalFeatures: this.queries.length,
      lastOutputAt,
      distribution,
    }
  }

  /** 最近产出：各功能取最新 limit 条，内存合并按时间倒序截断 */
  async getRecentOutputs(userId: number, query: WorkbenchRecentOutputsQueryDto) {
    const since = resolveSince(query.period)
    const chunks = await Promise.all(this.queries.map(q => q.latest(userId, since, query.limit)))
    const items: WorkbenchOutputItem[] = chunks
      .flat()
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, query.limit)
    return { items }
  }

  /** 全时间最近一次产出时间；无任何产出时返回 null */
  private async resolveLastOutputAt(userId: number): Promise<string | null> {
    const chunks = await Promise.all(this.queries.map(q => q.latest(userId, null, 1)))
    const latest = chunks
      .flat()
      .reduce<WorkbenchOutputItem | null>(
        (max, item) => (max === null || item.occurredAt > max.occurredAt ? item : max),
        null
      )
    return latest ? latest.occurredAt.toISOString() : null
  }
}
