import { Module } from "@nestjs/common"
import { PermissionController, RoleController } from "./role.controller"
import { RoleService } from "./role.service"

@Module({
  controllers: [RoleController, PermissionController],
  providers: [RoleService],
})
export class RoleModule {}
