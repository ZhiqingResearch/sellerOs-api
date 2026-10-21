// 车泰斗素材工作台 — 网关图片回调回执持久化（方案 §6.4）
// 只持久化 ChetaidouCall 回执，不调业务执行器（runner/定时扫描负责后续
// 转存与结算），避免 AiGatewayModule ↔ ChetaidouModule 循环依赖。
// webhook 请求内不下载图片、不等待 LLM；落库成功即 204。
import { Inject, Injectable, Logger } from "@nestjs/common"
import type { ImageTask } from "@zhiqingresearch/ai-ts-sdk"
import { WINSTON_MODULE_NEST_PROVIDER } from "nest-winston"
import { Logger as WinstonLogger } from "winston"
import { CHETAIDOU_CALL_PREFIX } from "../chetaidou/chetaidou.constants"
import { PrismaService } from "../prisma/prisma.service"

/** request_id（= 幂等键）是否属于车泰斗调用 */
export function isChetaidouCallRequestId(requestId: string | null | undefined): boolean {
  return !!requestId?.startsWith(CHETAIDOU_CALL_PREFIX)
}

export function parseChetaidouCallId(requestId: string): string | null {
  if (!requestId.startsWith(CHETAIDOU_CALL_PREFIX)) return null
  const callId = requestId.slice(CHETAIDOU_CALL_PREFIX.length)
  return /^[0-9a-f-]{36}$/i.test(callId) ? callId : null
}

@Injectable()
export class ChetaidouGatewayReceiptService {
  private readonly logger = new Logger(ChetaidouGatewayReceiptService.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly winston: WinstonLogger
  ) {}

  /**
   * 持久化图片任务回执（webhook 终态事件与轮询走同一入口）。
   * - Call 不存在 / kind≠IMAGE：告警并吞掉（true，不重试——Call 在提交前
   *   已落库，找不到即无效事件，不能据回调新建任务）
   * - gatewayTaskId 不匹配：保留首个（单向推进），记录告警
   * - 终态单向推进：FINISHED 不回退；重复回执幂等（receivedAt 只写一次）
   * 返回 false 仅当数据库暂时失败（webhook 应非 2xx 让网关重试）。
   */
  async persistImageTaskReceipt(task: ImageTask, eventId?: string): Promise<boolean> {
    const callId = parseChetaidouCallId(task.request_id ?? "")
    if (!callId) {
      this.logger.warn(`车泰斗回调 request_id 无法解析：${task.request_id}`)
      return true
    }
    try {
      const call = await this.prisma.chetaidouCall.findUnique({ where: { id: callId } })
      if (!call) {
        this.winston.warn?.(`chetaidou 回调找不到 Call`, { callId, eventId })
        this.logger.warn(`chetaidou 回调找不到 Call：${callId}`)
        return true
      }
      if (call.kind !== "IMAGE") {
        this.logger.warn(`chetaidou 回调 Call 非 IMAGE 类型：${callId}(${call.kind})`)
        return true
      }
      const terminal = task.status !== "queued" && task.status !== "running"
      const usage = "usage" in task && task.usage ? task.usage : undefined

      // 终态单向推进：已 FINISHED 的调用只更新重复事件审计，不回退
      if (call.state === "FINISHED") {
        return true
      }
      await this.prisma.chetaidouCall.updateMany({
        where: {
          id: callId,
          state: terminal ? { not: "FINISHED" } : { in: ["PREPARED", "SUBMITTING", "WAITING"] },
          OR: [{ gatewayTaskId: null }, { gatewayTaskId: task.id }],
        },
        data: {
          state: terminal ? "RECEIVED" : "WAITING",
          gatewayTaskId: call.gatewayTaskId ?? task.id,
          gatewayResponse: task as unknown as object,
          usage: usage ? { ...usage, eventId } : { eventId },
          receivedAt: call.receivedAt ?? new Date(),
        },
      })
      return true
    } catch (error) {
      this.logger.error(
        `chetaidou 回执落库失败（网关将重试）：${callId} ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }
}
