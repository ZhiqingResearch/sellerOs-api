import { Module } from "@nestjs/common"
import { UsageModule } from "../usage/usage.module"
import { InspirationRadarController } from "./inspiration-radar.controller"
import { InspirationRadarService } from "./inspiration-radar.service"

@Module({
  imports: [UsageModule],
  controllers: [InspirationRadarController],
  providers: [InspirationRadarService],
})
export class InspirationRadarModule {}
