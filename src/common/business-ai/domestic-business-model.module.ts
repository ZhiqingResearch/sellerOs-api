import { Module } from "@nestjs/common"
import { DomesticBusinessGateway } from "./domestic-business-gateway"
import { DomesticBusinessModelGuard } from "./domestic-business-model.guard"
import { DomesticBusinessModels } from "./domestic-business-models"

@Module({
  providers: [DomesticBusinessModels, DomesticBusinessModelGuard, DomesticBusinessGateway],
  exports: [DomesticBusinessModels, DomesticBusinessModelGuard, DomesticBusinessGateway],
})
export class DomesticBusinessModelModule {}
