// 车泰斗轻量维护：恢复已收到的结果并补记费用，不重发未知状态的调用。
import { Injectable, Logger } from "@nestjs/common"
import { Cron, CronExpression } from "@nestjs/schedule"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../../prisma/prisma.service"
import { ChetaidouBillingService } from "../chetaidou-billing.service"
import { chetaidouIdeationDeadlineMs, chetaidouTextDeadlineMs } from "../chetaidou.constants"
import { ChetaidouTaskRunnerService } from "./chetaidou-task-runner.service"

@Injectable()
export class ChetaidouReconciliationService {
  private readonly logger = new Logger(ChetaidouReconciliationService.name)
  private running = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: ChetaidouBillingService,
    private readonly runner: ChetaidouTaskRunnerService
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcile(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.markStaleTasks()
      await this.runner.reconcileWaitingTasks()
      await this.reconcilePendingBills()
    } catch (error) {
      this.logger.error(`对账失败：${errMessage(error)}`)
    } finally {
      this.running = false
    }
  }

  /** 只查已知请求的账单；扣费和 SETTLED 标记同事务，重复扫描不重复扣费。 */
  private async reconcilePendingBills(): Promise<void> {
    const waitingTasks = await this.prisma.chetaidouTask.findMany({
      where: { status: "WAITING_RECONCILIATION" },
      select: { id: true },
    })
    const pending = await this.prisma.chetaidouCall.findMany({
      where: {
        billingStatus: { in: ["PENDING", "REVIEW"] },
        AND: [
          {
            OR: [
              { kind: "TEXT", gatewayRequestId: { not: null } },
              { kind: "IMAGE", gatewayTaskId: { not: null } },
            ],
          },
          {
            OR: [
              { outcome: "ACCEPTED" },
              {
                outcome: null,
                // 已有扩展回复先恢复校验，避免核对与查账并发时提前扣除无效结果。
                AND: [
                  {
                    OR: [
                      { kind: "IMAGE" },
                      { targetKey: "identify" },
                      { gatewayResponse: { equals: Prisma.DbNull } },
                    ],
                  },
                ],
                OR: [
                  { state: "UNKNOWN" },
                  { taskId: { in: waitingTasks.map(task => task.id) }, submittedAt: { not: null } },
                ],
              },
            ],
          },
        ],
      },
      // 按上次查账时间轮转，未出账的调用不能长期挡住后面的调用。
      orderBy: { updatedAt: "asc" },
      take: 3,
    })
    for (const call of pending) {
      try {
        const imageUsage =
          call.kind === "IMAGE" ? await this.billing.lookupImageUsage(call.gatewayTaskId!) : null
        const amount = imageUsage
          ? imageUsage.amount
          : await this.billing.lookupTextUsage(call.gatewayRequestId!)
        const imageFailed = imageUsage && ["failed", "canceled"].includes(imageUsage.status)
        if (amount === null && !imageFailed) {
          await this.prisma.chetaidouCall.updateMany({
            where: { id: call.id, billingStatus: { in: ["PENDING", "REVIEW"] } },
            data: {
              ...(Date.now() - (call.submittedAt ?? call.createdAt).getTime() > 30 * 60_000
                ? { billingStatus: "REVIEW" }
                : {}),
              updatedAt: new Date(),
            },
          })
          continue
        }
        await this.prisma.$transaction(
          async tx => {
            if (imageUsage) {
              await this.billing.settleImageInTx(tx, call, amount, imageFailed ? false : "UNKNOWN")
            } else {
              await this.billing.settleTextInTx(tx, { id: call.id, model: call.model }, amount)
            }
          },
          { timeout: 60_000 }
        )
      } catch (error) {
        // 网络或账单异常本轮跳过，继续轮转查账，绝不重发模型请求。
        await this.prisma.chetaidouCall
          .updateMany({
            where: { id: call.id, billingStatus: { in: ["PENDING", "REVIEW"] } },
            data: { updatedAt: new Date() },
          })
          .catch(() => undefined)
        this.logger.warn(`账单查账失败 ${call.id}：${errMessage(error)}`)
      }
    }
  }

  /** 用已有更新时间判断超时；不接管执行，不自动重发供应商请求。 */
  private async markStaleTasks(): Promise<void> {
    const now = Date.now()
    await this.prisma.chetaidouTask.updateMany({
      where: {
        status: "RUNNING",
        id: { notIn: this.runner.activeTaskIds() },
        OR: [
          { type: "IDEATION", updatedAt: { lt: new Date(now - chetaidouIdeationDeadlineMs()) } },
          {
            type: { notIn: ["GENERATE", "CROP", "IDEATION"] },
            updatedAt: { lt: new Date(now - chetaidouTextDeadlineMs()) },
          },
        ],
      },
      data: {
        status: "WAITING_RECONCILIATION",
        errorCode: "CALL_STATUS_UNKNOWN",
        errorMessage: "任务长时间未更新，系统正在核对原调用结果",
      },
    })
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
