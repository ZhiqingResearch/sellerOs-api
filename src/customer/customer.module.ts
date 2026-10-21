import { Module } from "@nestjs/common"
import { AiGatewayModule } from "../ai-gateway/ai-gateway.module"
import { UsageModule } from "../usage/usage.module"
import { CustomerWebhookController } from "./customer-webhook.controller"
import { CustomerController } from "./customer.controller"
import { CustomerService } from "./customer.service"
import { PublicResourceService } from "./public-resource.service"

@Module({
  imports: [AiGatewayModule, UsageModule],
  // CustomerWebhookController 必须排在前面：CustomerController 的
  // @Post(":customerId/avatar|voice") 带参路由会吞掉 /customer/webhook/*
  // 请求并被 JwtAuthGuard 挡成 401。
  controllers: [CustomerWebhookController, CustomerController],
  providers: [CustomerService, PublicResourceService],
  exports: [CustomerService],
})
export class CustomerModule {}
