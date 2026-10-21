import { Module } from "@nestjs/common"
import { ProductFactoryController } from "./product-factory.controller"
import { ProductFactoryService } from "./product-factory.service"

@Module({
  controllers: [ProductFactoryController],
  providers: [ProductFactoryService],
})
export class ProductFactoryModule {}
