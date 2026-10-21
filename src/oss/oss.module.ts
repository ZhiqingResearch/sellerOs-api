import { Global, Module } from "@nestjs/common"
import { OssController } from "./oss.controller"
import { OssService } from "./oss.service"

@Global()
@Module({
  controllers: [OssController],
  providers: [OssService],
  exports: [OssService],
})
export class OssModule {}
