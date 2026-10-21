import { Module } from "@nestjs/common"
import { SpacesModule } from "../spaces/spaces.module"
import { ProductPublishEventsService } from "./product-publish-events.service"
import { ProductPublishRpaService } from "./product-publish-rpa.service"
import { ProductPublishRpaTask } from "./product-publish-rpa.task"
import { ProductPublishStoreSyncService } from "./product-publish-store-sync.service"
import { ProductPublishStoreSyncTask } from "./product-publish-store-sync.task"
import { ProductPublishStoreService } from "./product-publish-store.service"
import {
  ProductPublishController,
  ProductPublishRpaInternalController,
} from "./product-publish.controller"
import { ProductPublishService } from "./product-publish.service"

@Module({
  imports: [SpacesModule],
  controllers: [ProductPublishController, ProductPublishRpaInternalController],
  providers: [
    ProductPublishService,
    ProductPublishEventsService,
    ProductPublishRpaService,
    ProductPublishRpaTask,
    ProductPublishStoreService,
    ProductPublishStoreSyncService,
    ProductPublishStoreSyncTask,
  ],
  exports: [ProductPublishRpaService],
})
export class ProductPublishModule {}
