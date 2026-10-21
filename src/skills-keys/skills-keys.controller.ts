import { Body, Controller, Get, Header, Post, Query, Request, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { SkillsKeyOperationDto, SkillsKeyProjectDto, SkillsKeyQueryDto } from "./dto/skills-key.dto"
import { SkillsKeysService } from "./skills-keys.service"

@ApiTags("Skills 接入密钥")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("skills/keys")
export class SkillsKeysController {
  constructor(private readonly keys: SkillsKeysService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "查询本人接入密钥状态（仅脱敏信息）" })
  status(@Request() req: { user: { id: number } }, @Query() dto: SkillsKeyQueryDto) {
    return this.keys.status(req.user.id, dto.projectCode)
  }

  @Post()
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "首次生成本人接入密钥；相同 operationId 安全查询结果" })
  generate(@Request() req: { user: { id: number } }, @Body() dto: SkillsKeyOperationDto) {
    return this.keys.generate(req.user.id, dto)
  }

  @Post("reset")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "重置本人密钥：旧密钥失效，须更新客户端，在途任务可能扣费失败" })
  reset(@Request() req: { user: { id: number } }, @Body() dto: SkillsKeyOperationDto) {
    return this.keys.generate(req.user.id, dto, true)
  }

  @Post("reveal")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "当前用户主动查看或复制本人有效密钥" })
  reveal(@Request() req: { user: { id: number } }, @Body() dto: SkillsKeyProjectDto) {
    return this.keys.reveal(req.user.id, dto.projectCode)
  }
}
