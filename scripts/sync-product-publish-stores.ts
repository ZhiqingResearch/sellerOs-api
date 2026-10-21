import { ConfigService } from "@nestjs/config"
import { ProductPublishFeishuSyncStatus, ProductPublishFeishuSyncTrigger } from "@prisma/client"
import { FeishuProvider } from "../src/common/providers/feishu.provider"
import { validateEnvironment } from "../src/config/env.validation"
import { PrismaService } from "../src/prisma/prisma.service"
import { ProductPublishStoreSyncService } from "../src/product-publish/product-publish-store-sync.service"

async function main(): Promise<void> {
  validateEnvironment(process.env)

  const prisma = new PrismaService()
  const config = new ConfigService(process.env)
  const feishu = new FeishuProvider(config)
  const syncService = new ProductPublishStoreSyncService(prisma, feishu)

  await prisma.$connect()
  try {
    // 兼容 db push 环境：先补齐缺失的初始分类，再同步店铺及店铺分类映射。
    await syncService.onModuleInit()
    const result = await syncService.syncFromFeishu(ProductPublishFeishuSyncTrigger.MANUAL)
    console.log(JSON.stringify(result, null, 2))

    const deploymentCheckPassed =
      result.status === ProductPublishFeishuSyncStatus.SUCCESS &&
      result.total > 0 &&
      result.skipped === 0
    if (!deploymentCheckPassed) {
      console.error("首次同步验收未通过：必须为 SUCCESS、记录数大于 0 且 skipped=0。")
      process.exitCode = 1
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`一键上架店铺初始化同步失败：${message}`)
  process.exitCode = 1
})
