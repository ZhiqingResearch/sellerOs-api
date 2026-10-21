import { Module } from "@nestjs/common"
import { ImageProjectModule } from "../image-project/image-project.module"
import { ExternalApiKeyGuard } from "./external-api-key.guard"
import { ExternalImageTemplateController } from "./external-image-template.controller"
import { ExternalImageTemplateService } from "./external-image-template.service"
import { ExternalUserPhonePipe } from "./external-user-phone.decorator"

@Module({
  imports: [ImageProjectModule],
  controllers: [ExternalImageTemplateController],
  providers: [ExternalApiKeyGuard, ExternalUserPhonePipe, ExternalImageTemplateService],
})
export class ExternalApiModule {}
