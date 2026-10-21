import { Body, Controller, Delete, Get, Param, Post, Request, Res, UseGuards } from "@nestjs/common"
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger"
import type { Response } from "express"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { RegisterDownloadDto } from "./dto/register-download.dto"
import {
  RegisterDownloadResponseDto,
  RemoveFromLibraryResponseDto,
  SkillMarketListResponseDto,
} from "./dto/skill-market-response.dto"
import { SkillMarketService } from "./skill-market.service"

interface AuthedRequest {
  user: { id: number }
  ip?: string
  headers: Record<string, unknown>
}

@ApiTags("Skill 市场")
@ApiBearerAuth()
@Controller("skill-market")
// 按需求放开：登录即可访问，不做菜单权限校验
@UseGuards(JwtAuthGuard)
export class SkillMarketController {
  constructor(private readonly service: SkillMarketService) {}

  @Get("skills")
  @ApiOperation({ summary: "获取所有技能的下载统计和当前用户下载状态" })
  @ApiOkResponse({ type: SkillMarketListResponseDto })
  listSkills(@Request() req: AuthedRequest) {
    return this.service.listSkills(req.user.id)
  }

  @Post("skills/:skillId/downloads")
  @ApiOperation({ summary: "登记一次下载（clientRequestId 幂等），返回最新统计与正文签名下载地址" })
  @ApiCreatedResponse({
    type: RegisterDownloadResponseDto,
    description: "历史首次下载返回 201，其余返回 200",
  })
  @ApiOkResponse({ type: RegisterDownloadResponseDto })
  async registerDownload(
    @Param("skillId") skillId: string,
    @Body() dto: RegisterDownloadDto,
    @Request() req: AuthedRequest,
    // 历史首次 201 / 重复与幂等重放 200，需要按结果动态设置状态码
    @Res({ passthrough: true }) res: Response
  ) {
    const userAgent = req.headers["user-agent"]
    const result = await this.service.registerDownload(req.user.id, skillId, dto, {
      ip: req.ip,
      userAgent: typeof userAgent === "string" ? userAgent : undefined,
    })
    res.status(result.firstDownload && !result.idempotentReplay ? 201 : 200)
    return result
  }

  @Delete("skills/:skillId/my-library")
  @ApiOperation({ summary: "移出当前用户的已下载列表（不动计数，幂等）" })
  @ApiOkResponse({ type: RemoveFromLibraryResponseDto })
  removeFromLibrary(@Param("skillId") skillId: string, @Request() req: AuthedRequest) {
    return this.service.removeFromLibrary(req.user.id, skillId)
  }
}
