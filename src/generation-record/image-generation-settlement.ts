import { Logger } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { parseImagePipelineIdempotencyKey } from "../ai-gateway/ai-gateway-image-callbacks.service"
import { jsonObject } from "../common/utils/generation-metadata"

/** 只写原有 JSON 的内部结算证据；缺字段=旧数据，null=未知/结算失败，字符串含 0=已确认。 */
export async function markGeneratedImageSettlement(
  prisma: Pick<Prisma.TransactionClient, "generatedImage">,
  taskId: number,
  gatewayTaskId: string | undefined,
  credits: string | null,
  scope: { requestId?: string; wholeTask?: boolean } = {}
) {
  const parsed = scope.requestId ? parseImagePipelineIdempotencyKey(scope.requestId) : null
  const childId =
    parsed?.owner === String(taskId) && Number.isSafeInteger(parsed.childId) ? parsed.childId : null
  if (!gatewayTaskId && !childId && !scope.wholeTask) return
  try {
    const rows = await prisma.generatedImage.findMany({
      where: {
        taskId,
        status: "SUCCESS",
        ...(childId ? { id: childId } : gatewayTaskId ? { providerJobId: gatewayTaskId } : {}),
      },
      select: { id: true, deliveryMeta: true },
    })
    for (const row of rows)
      await prisma.generatedImage.updateMany({
        where: { id: row.id, status: "SUCCESS" },
        data: {
          deliveryMeta: { ...jsonObject(row.deliveryMeta), generationRecordCredits: credits },
        },
      })
  } catch (error) {
    new Logger("GenerationRecordSettlement").error(
      `图片结算证据保存失败 taskId=${taskId} gatewayTaskId=${gatewayTaskId ?? ""}`,
      error instanceof Error ? error.stack : String(error)
    )
  }
}
