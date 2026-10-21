import { Module } from "@nestjs/common"
import { SensitiveWordController } from "./sensitive-word.controller"
import { SensitiveWordService } from "./sensitive-word.service"

@Module({
  controllers: [SensitiveWordController],
  providers: [SensitiveWordService],
  exports: [SensitiveWordService],
})
export class SensitiveWordModule {}
