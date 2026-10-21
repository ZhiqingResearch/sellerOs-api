import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import type { AuthedRequest } from "./dto/common.dto"
import { CreatePoolGroupDto, RenamePoolGroupDto } from "./dto/pool-group.dto"
import { PoolGroupService } from "./pool-group.service"

@ApiTags("素材池 - 素材图分组")
@ApiBearerAuth()
@Controller("material-pool/groups")
@UseGuards(JwtAuthGuard)
export class PoolGroupController {
  constructor(private readonly service: PoolGroupService) {}

  @ApiOperation({ summary: "分组列表（含每组素材数；无默认分组）" })
  @Get()
  findAll(@Request() req: AuthedRequest) {
    return this.service.findAll(req.user.id)
  }

  @ApiOperation({ summary: "新建分组（同名 409）" })
  @Post()
  create(@Body() dto: CreatePoolGroupDto, @Request() req: AuthedRequest) {
    return this.service.create(req.user.id, dto.name)
  }

  @ApiOperation({ summary: "重命名分组（同名 409）" })
  @Patch(":id")
  rename(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RenamePoolGroupDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.rename(req.user.id, id, dto.name)
  }

  @ApiOperation({
    summary: "删除分组（连带软删除组内素材）",
    description: "二次确认在前端；返回连带删除的素材数量。",
  })
  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.remove(req.user.id, id)
  }
}
