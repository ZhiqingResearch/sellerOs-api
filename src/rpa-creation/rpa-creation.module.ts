import { Module } from "@nestjs/common"
import { UsageModule } from "../usage/usage.module"
import { RpaCreationController, RpaCreationInternalController } from "./rpa-creation.controller"
import { RpaCreationService } from "./rpa-creation.service"

@Module({
  imports: [UsageModule],
  controllers: [RpaCreationInternalController, RpaCreationController],
  providers: [RpaCreationService],
  exports: [RpaCreationService],
})
export class RpaCreationModule {}
