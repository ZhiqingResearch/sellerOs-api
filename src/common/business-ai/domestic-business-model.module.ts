import { Module } from "@nestjs/common"
import { DomesticBusinessGateway } from "./domestic-business-gateway"
import { DomesticBusinessModelController } from "./domestic-business-model.controller"
import { DomesticBusinessModelGuard } from "./domestic-business-model.guard"
import { DomesticBusinessModels } from "./domestic-business-models"

@Module({
  controllers: [DomesticBusinessModelController],
  providers: [DomesticBusinessModels, DomesticBusinessModelGuard, DomesticBusinessGateway],
  exports: [DomesticBusinessModels, DomesticBusinessModelGuard, DomesticBusinessGateway],
})
export class DomesticBusinessModelModule {}
