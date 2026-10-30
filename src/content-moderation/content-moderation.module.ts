import { Global, Module } from "@nestjs/common"
import { APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core"
import { ProvidersModule } from "../common/providers/providers.module"
import { PrismaModule } from "../prisma/prisma.module"
import { SpacesModule } from "../spaces/spaces.module"
import { ContentModerationController } from "./content-moderation.controller"
import { ContentModerationPipe } from "./content-moderation.pipe"
import { ContentModerationService } from "./content-moderation.service"
import { ContentSnapshotService } from "./content-snapshot.service"
import { ModerationResponseInterceptor } from "./moderation-response.interceptor"
import { TaskModerationService } from "./task-moderation.service"

@Global()
@Module({
  imports: [ProvidersModule, PrismaModule, SpacesModule],
  controllers: [ContentModerationController],
  providers: [
    ContentModerationService,
    TaskModerationService,
    ContentSnapshotService,
    { provide: APP_PIPE, useClass: ContentModerationPipe },
    { provide: APP_INTERCEPTOR, useClass: ModerationResponseInterceptor },
  ],
  exports: [ContentModerationService, TaskModerationService],
})
export class ContentModerationModule {}
