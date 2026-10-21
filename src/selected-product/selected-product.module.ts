import { Module } from "@nestjs/common"
import { SelectedProductController } from "./selected-product.controller"
import { SelectedProductService } from "./selected-product.service"

@Module({
  controllers: [SelectedProductController],
  providers: [SelectedProductService],
})
export class SelectedProductModule {}
