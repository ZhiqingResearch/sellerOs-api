import { Module } from "@nestjs/common"
import { SkillMarketController } from "./skill-market.controller"
import { SkillMarketService } from "./skill-market.service"
import { SkillMarketTasks } from "./skill-market.tasks"

@Module({
  controllers: [SkillMarketController],
  providers: [SkillMarketService, SkillMarketTasks],
  exports: [SkillMarketService],
})
export class SkillMarketModule {}
