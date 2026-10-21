import { Module } from "@nestjs/common"
import { AiGatewayModule } from "../ai-gateway/ai-gateway.module"
import { UsageModule } from "../usage/usage.module"
import { AiGatewayPortraitImageGenerator } from "./ai-gateway-portrait-image.generator"
import { AiSplitTaskRunner } from "./ai-split-task.runner"
import { AiSplitController } from "./ai-split.controller"
import { AiSplitService } from "./ai-split.service"
import { AiSplitValidator } from "./ai-split.validator"
import { BrandKitController } from "./brand-kit.controller"
import { BrandKitService } from "./brand-kit.service"
import { ImageProjectController } from "./image-project.controller"
import { ImageProjectService } from "./image-project.service"
import { ImageCropController } from "./image-crop.controller"
import { ImageCropService } from "./image-crop.service"
import { ImageTemplateController } from "./image-template.controller"
import { ImageTemplateService } from "./image-template.service"
import { PortraitCreationController } from "./portrait-creation.controller"
import { InternalImageGenerationController } from "./internal-image-generation.controller"
import { InternalImageGenerationService } from "./internal-image-generation.service"
import { PortraitCreationService } from "./portrait-creation.service"
import { PORTRAIT_IMAGE_GENERATOR } from "./portrait-image-generator"
import { UnconfiguredPortraitImageGenerator } from "./portrait-image-generator.stub"
import { PortraitTaskRunner } from "./portrait-task.runner"
import { PortraitTaskValidator } from "./portrait-task.validator"
import { PromptTemplateController } from "./prompt-template.controller"
import { PromptTemplateService } from "./prompt-template.service"
import { SystemImageTemplateController } from "./system-image-template.controller"

@Module({
  imports: [AiGatewayModule, UsageModule],
  controllers: [
    InternalImageGenerationController,
    // 更具体的子路径必须注册在 ImageProjectController(@Get(":id")) 之前，
    // 否则 /image-project/templates、/image-project/system-templates 会被 :id 路由吞掉，
    // 触发 ParseIntPipe 报 "numeric string is expected"。
    PromptTemplateController,
    ImageTemplateController,
    SystemImageTemplateController,
    BrandKitController,
    AiSplitController,
    PortraitCreationController,
    ImageCropController,
    ImageProjectController,
  ],
  providers: [
    ImageProjectService,
    ImageCropService,
    PromptTemplateService,
    ImageTemplateService,
    BrandKitService,
    AiSplitService,
    InternalImageGenerationService,
    AiSplitValidator,
    AiSplitTaskRunner,
    PortraitCreationService,
    PortraitTaskValidator,
    PortraitTaskRunner,
    AiGatewayPortraitImageGenerator,
    UnconfiguredPortraitImageGenerator,
    {
      provide: PORTRAIT_IMAGE_GENERATOR,
      useExisting: AiGatewayPortraitImageGenerator,
    },
  ],
  exports: [
    ImageProjectService,
    PromptTemplateService,
    ImageTemplateService,
    PortraitCreationService,
  ],
})
export class ImageProjectModule {}
