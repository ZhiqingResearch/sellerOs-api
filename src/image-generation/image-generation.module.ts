// src/image-generation/image-generation.module.ts
//
// 通用生图后端模块(Track A)。初始化时把 core/storage 的预签名 transport
// 接到 SpacesService(服务身份),此后 core 内所有 Spaces 上传不再依赖
// 用户 token,也不发起 HTTP 自环。
// 主生图(generate)直接进程内复用 ImageProjectService(建任务/归属校验)
// 与 UsageService(终态 usage 上报),不经 HTTP 自调。

import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { AiGatewayModule } from "../ai-gateway/ai-gateway.module";
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider";
import { AiGatewayImageCallbacksService } from "../ai-gateway/ai-gateway-image-callbacks.service";
import { ImageProjectModule } from "../image-project/image-project.module";
import { SpacesModule } from "../spaces/spaces.module";
import { SpacesService } from "../spaces/spaces.service";
import { UsageModule } from "../usage/usage.module";
import type { ImageProvider } from "./core/types";
import {
  IMAGE_PROVIDER_FACTORY,
} from "./providers/provider-factory.token";
import { DispatchQueueService } from "./executor/dispatch-queue.service";
import { ImageGenItemRunnerService } from "./executor/image-gen-item-runner.service";
import { GenerationTaskRunnerService } from "./executor/generation-task-runner.service";
import { ReconciliationService } from "./executor/reconciliation.service";
import { spacesServiceTransport } from "./executor/spaces-transport";
import { setSpacesPresignTransport } from "./core/storage";
import { TextToImageController } from "./text-to-image.controller";
import { TextToImageService } from "./text-to-image.service";
import { ImageToImageController } from "./image-to-image.controller";
import { ImageToImageService } from "./image-to-image.service";
import { InternalImageToImageController } from "./internal-image-to-image.controller";
import { GenerateController } from "./generate.controller";
import { LocalRedrawController, LocalRedrawAuthGuard } from "./local-redraw.controller"
import { LocalRedrawService } from "./local-redraw.service"
import { GenerateService } from "./generate.service";
import { ImageGenerationModelsController } from "./models.controller";
import { ImageGenerationModelsService } from "./models.service";
import { createGatewayImageProvider } from "./providers/gateway-image.provider";
import { resolveGatewayModel } from "./providers/gateway-mapping";

/**
 * B4(2026-09-10)网关单通道工厂:逻辑 ID 经映射表解析、目录直传的
 * model id 原样透传,均走网关适配器;退役槽位(映射返回 null)在服务层
 * 入口已 400,这里兜执行期晚到的存量快照(直接抛错由 catch 收敛 FAILED)。
 * 终态走 callback(hub 由 webhook 分发),适配器内稀疏轮询兜底。
 */
function makeProviderFactory(
  gateway: AiGatewayProvider,
  callbacks: AiGatewayImageCallbacksService,
) {
  return (id: string): ImageProvider => {
    const modelId = resolveGatewayModel(id);
    if (!modelId) {
      throw new Error(`Unsupported provider: ${id}`);
    }
    return createGatewayImageProvider(gateway, modelId, callbacks);
  };
}

@Injectable()
class StorageTransportInitializer implements OnModuleInit {
  constructor(private readonly spaces: SpacesService) {}
  onModuleInit(): void {
    setSpacesPresignTransport(spacesServiceTransport(this.spaces));
  }
}

@Module({
  imports: [SpacesModule, ImageProjectModule, UsageModule, AiGatewayModule],
  controllers: [
    TextToImageController,
    ImageToImageController,
    InternalImageToImageController,
    GenerateController,
    LocalRedrawController,
    ImageGenerationModelsController,
  ],
  providers: [
    {
      provide: IMAGE_PROVIDER_FACTORY,
      useFactory: makeProviderFactory,
      inject: [AiGatewayProvider, AiGatewayImageCallbacksService],
    },
    StorageTransportInitializer,
    DispatchQueueService,
    ImageGenItemRunnerService,
    GenerationTaskRunnerService,
    ReconciliationService,
    TextToImageService,
    ImageToImageService,
    GenerateService,
    LocalRedrawService,
    LocalRedrawAuthGuard,
    ImageGenerationModelsService,
  ],
})
export class ImageGenerationModule {}
