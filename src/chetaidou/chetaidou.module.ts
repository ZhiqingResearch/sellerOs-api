import { ChetaidouResultService } from "./chetaidou-result.service"
// 车泰斗素材工作台 — 模块组装
// 复用：AiGateway（多模态/图片网关 + 回执服务）、Usage（扣费）、Spaces（全局）。
// 回执服务在 AiGatewayModule 侧注册（只依赖 Prisma），避免循环依赖。
import { Module } from "@nestjs/common"
import { AiGatewayModule } from "../ai-gateway/ai-gateway.module"
import { AuthModule } from "../auth/auth.module"
import { UsageModule } from "../usage/usage.module"
import { ChetaidouAdminController } from "./chetaidou-admin.controller"
import { ChetaidouAdminService } from "./chetaidou-admin.service"
import { ChetaidouBillingService } from "./chetaidou-billing.service"
import { ChetaidouContextService } from "./chetaidou-context.service"
import { ChetaidouImageOptionsService } from "./chetaidou-image-options.service"
import { ChetaidouStorageService } from "./chetaidou-storage.service"
import { ChetaidouController } from "./chetaidou.controller"
import { ChetaidouService } from "./chetaidou.service"
import { ChetaidouImageRunnerService } from "./executor/chetaidou-image-runner.service"
import { ChetaidouReconciliationService } from "./executor/chetaidou-reconciliation.service"
import { ChetaidouTaskRunnerService } from "./executor/chetaidou-task-runner.service"

@Module({
  imports: [AuthModule, AiGatewayModule, UsageModule],
  controllers: [ChetaidouController, ChetaidouAdminController],
  providers: [
    ChetaidouStorageService,
    ChetaidouContextService,
    ChetaidouBillingService,
    ChetaidouImageOptionsService,
    ChetaidouService,
    ChetaidouResultService,
    ChetaidouAdminService,
    ChetaidouTaskRunnerService,
    ChetaidouImageRunnerService,
    ChetaidouReconciliationService,
  ],
  exports: [ChetaidouService],
})
export class ChetaidouModule {}
