import { Logger } from "@nestjs/common"
import { Prisma, PrismaClient } from "@prisma/client"
import { GenerationSource, syncGenerationSource } from "./generation-record-sync"

/** 仅在业务事务提交后调用；快照使用独立事务，失败不能影响已完成的业务。 */
export async function recordGenerationSuccess(
  client: PrismaClient,
  source: GenerationSource,
  id: string | number,
  options?: { credits?: Prisma.Decimal | string | number; modelPublicId?: string }
): Promise<void> {
  try {
    await client.$transaction(
      tx => syncGenerationSource(tx, source, id, { ...options, requireSettlement: true }),
      { timeout: 30000 }
    )
  } catch (error) {
    new Logger("GenerationRecord").error(
      `成功快照保存失败 source=${source} id=${id}`,
      error instanceof Error ? error.stack : String(error)
    )
  }
}
