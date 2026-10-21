import { Module } from "@nestjs/common"
import { MenuController } from "./menu.controller"
import { MenuGroupService } from "./menu-group.service"
import { MenuService } from "./menu.service"

@Module({
  controllers: [MenuController],
  providers: [MenuService, MenuGroupService],
})
export class MenuModule {}
