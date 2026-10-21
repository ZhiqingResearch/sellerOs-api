import { PrismaClient } from "@prisma/client"
import { FEATURE_MODULE_DEFINITIONS } from "../../src/usage/feature-module-definitions"

// 功能模块注册表（扣费/统计的功能口径单一事实来源）：v2/对外扣费的 source 校验、用量分析「功能」维度、
// 积分明细「项目」列、source-options 下拉全部从 FeatureModule 表派生。
// 新增功能修改 src/usage/feature-module-definitions.ts 后跑 `tsx prisma/seed.ts features`；
// 下线功能只把数据库 active 置 false，勿删行，历史流水仍引用 source。
// module = 一级目录 key（9 大菜单：selection/listing/competitor/asin_audit/pricing/launch_plan/ad_opt/img/video）；
// 不归菜单的历史功能/其他项目功能 module=null。
export async function seedFeatures(prisma: PrismaClient) {
  for (const feature of FEATURE_MODULE_DEFINITIONS) {
    await prisma.featureModule.upsert({
      where: { source: feature.source },
      // 不覆盖 active：下线状态由人工置 false，seed 不复活
      update: {
        label: feature.label,
        module: feature.module,
        moduleLabel: feature.moduleLabel,
        sortOrder: feature.sortOrder,
      },
      create: feature,
    })
  }
  return { features: FEATURE_MODULE_DEFINITIONS.length }
}
