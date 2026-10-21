import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { OpenApiApp, OpenOperationPlanRequest } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { OPERATION_PLAN_REPAIR_VERSION, parseOperationPlans } from "./operation-plan-result"
import { OperationPlanInput } from "./operation-plan.types"
import { parseSingleOperationPlan, SINGLE_PLAN_REPAIR_VERSION } from "./single-operation-plan"

/** 仅保留旧快照读取兼容；不再执行生成、取数或扣费。 */
@Injectable()
export class OpenOperationPlanService {
  constructor(private readonly prisma: PrismaService) {}

  async findOne(app: OpenApiApp, requestId: string) {
    this._assertEnabled(app)
    const record = await this.prisma.openOperationPlanRequest.findUnique({
      where: { appId_requestId: { appId: app.appId, requestId } },
    })
    if (!record) throw new NotFoundException("运营计划请求不存在")
    if (record.result) return this._completedResponse(record)
    const findRun = (runId: string) =>
      this.prisma.businessAiRun.findUnique({
        where: {
          userId_module_operation_runId: {
            userId: record.billingUserId,
            module: "promotion-plan",
            operation: "generate",
            runId,
          },
        },
        select: { status: true, outputText: true },
      })
    const input = record.input as unknown as OperationPlanInput
    const repairVersion =
      input.schemaVersion === 2 ? SINGLE_PLAN_REPAIR_VERSION : OPERATION_PLAN_REPAIR_VERSION
    const run = (await findRun(`${record.runId}:${repairVersion}`)) ?? (await findRun(record.runId))
    let status = !run ? "PENDING" : run.status === "FAILED" ? "FAILED" : "RUNNING"
    if (run?.outputText != null && ["READY", "COMPLETED"].includes(run.status)) {
      try {
        if (input.schemaVersion === 2) parseSingleOperationPlan(run.outputText, input)
        else parseOperationPlans(run.outputText, input)
        status = "AWAITING_SETTLEMENT"
      } catch {
        status = "INVALID_RESULT"
      }
    }
    return { requestId, status, billingHandled: false, result: null }
  }

  private _assertEnabled(app: OpenApiApp) {
    if (!app.isNiuniuOperationPlanEnabled)
      throw new ForbiddenException("当前接入方未开通牛牛运营计划接口")
  }

  private _completedResponse(record: OpenOperationPlanRequest) {
    return {
      requestId: record.requestId,
      status: "COMPLETED",
      billingHandled: true,
      result: record.result,
    }
  }
}
