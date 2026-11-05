import { Global, Module } from "@nestjs/common"
import { StorageModule } from "../storage/storage.module"
import { SpacesController } from "./spaces.controller"

@Global()
@Module({
  controllers: [SpacesController],
  imports: [StorageModule],
  exports: [StorageModule],
})
export class SpacesModule {}
