import { Controller, Get, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { OssService } from "./oss.service"

@ApiTags("OSS")
@ApiBearerAuth()
@Controller("oss")
@UseGuards(JwtAuthGuard)
export class OssController {
  constructor(private readonly ossService: OssService) {}

  @ApiOperation({ summary: "生成OSS Policy" })
  @Get("policy")
  generateOSSPolicy() {
    return this.ossService.generateOSSPolicy()
  }

  // @ApiOperation({ summary: "测试上传" })
  // @Get("test")
  // async test() {
  //   return this.ossService.test()
  // }
}
