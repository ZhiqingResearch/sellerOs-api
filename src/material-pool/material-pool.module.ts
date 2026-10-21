import { Module } from "@nestjs/common"
import { DigitalHumanController } from "./digital-human.controller"
import { DigitalHumanService } from "./digital-human.service"
import { PoolGroupController } from "./pool-group.controller"
import { PoolGroupService } from "./pool-group.service"
import { PoolImageController } from "./pool-image.controller"
import { PoolImageService } from "./pool-image.service"
import { SceneController } from "./scene.controller"
import { SceneService } from "./scene.service"

@Module({
  controllers: [
    // /material-pool/groups、/material-pool/images/... 等静态子路径在各自控制器内已先于 :id 注册
    PoolGroupController,
    PoolImageController,
    DigitalHumanController,
    SceneController,
  ],
  providers: [PoolGroupService, PoolImageService, DigitalHumanService, SceneService],
  exports: [PoolGroupService, PoolImageService, DigitalHumanService, SceneService],
})
export class MaterialPoolModule {}
