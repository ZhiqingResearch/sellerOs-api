import { Global, Module } from "@nestjs/common"
import { SpacesController } from "./spaces.controller"
import { SpacesService } from "./spaces.service"

@Global()
@Module({
  controllers: [SpacesController],
  providers: [SpacesService],
  exports: [SpacesService],
})
export class SpacesModule {}
