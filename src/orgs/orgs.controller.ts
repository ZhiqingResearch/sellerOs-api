import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { CreateOrgDto } from "./dto/create-org.dto"
import { OrgItemDto } from "./dto/org-response.dto"
import { UpdateOrgDto } from "./dto/update-org.dto"
import { OrgsService } from "./orgs.service"

@ApiTags("组织管理")
@ApiBearerAuth()
@Controller("orgs")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("management.users")
export class OrgsController {
  constructor(private readonly orgsService: OrgsService) {}

  @Get()
  @ApiOperation({ summary: "组织列表（含用户数）" })
  @ApiOkResponse({ type: OrgItemDto, isArray: true })
  list() {
    return this.orgsService.list()
  }

  @Post()
  @ApiOperation({ summary: "新建组织" })
  @ApiOkResponse({ type: OrgItemDto })
  create(@Body() dto: CreateOrgDto) {
    return this.orgsService.createOrg(dto)
  }

  @Patch(":id")
  @ApiOperation({ summary: "重命名 / 改备注" })
  @ApiOkResponse({ type: OrgItemDto })
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateOrgDto) {
    return this.orgsService.updateOrg(id, dto)
  }

  @Delete(":id")
  @ApiOperation({ summary: "删除组织（其下有用户不可删）" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.orgsService.deleteOrg(id)
  }
}
