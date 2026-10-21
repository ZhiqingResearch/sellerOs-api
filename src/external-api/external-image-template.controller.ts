import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"
import {
  CopyImageTemplateDto,
  CreateImageTemplateDto,
  CreateTemplateGroupDto,
  ImportImageTemplateDto,
  QueryImageTemplateDto,
  RenameTemplateGroupDto,
  TemplateItemDto,
  TemplateScopeQueryDto,
  UpdateImageTemplateDto,
} from "../image-project/image-template.dto"
import { ExternalApiKeyGuard } from "./external-api-key.guard"
import { ExternalImageTemplateService } from "./external-image-template.service"
import {
  EXTERNAL_USER_PHONE_HEADER,
  ExternalUserPhone,
  ExternalUserPhonePipe,
} from "./external-user-phone.decorator"

@ApiTags("外部接口 - 图片模板")
@ApiHeader({ name: "X-API-Key", required: true, description: "外部模板接口访问密钥" })
@ApiHeader({
  name: EXTERNAL_USER_PHONE_HEADER,
  required: true,
  description: "本次操作对应的系统用户手机号",
})
@ApiBadRequestResponse({ description: "请求参数不合法" })
@ApiUnauthorizedResponse({ description: "X-API-Key 缺失或不正确" })
@ApiForbiddenResponse({ description: "账户已停用、无权访问资源或系统模板禁止修改" })
@ApiNotFoundResponse({ description: "账户、模板或分组不存在" })
@ApiServiceUnavailableResponse({ description: "服务端未配置外部模板接口密钥" })
@Controller("external/image-templates")
@UseGuards(ExternalApiKeyGuard)
export class ExternalImageTemplateController {
  constructor(private readonly service: ExternalImageTemplateService) {}

  // 所有接口统一从请求头读取手机号，请求体只承载模板业务参数。

  @Post("query")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "按手机号查询用户可见的生图模板",
    description:
      "不使用 JWT；返回该用户的个人模板与全部系统模板，不返回其他用户的个人模板。支持分页、分组、标签和关键词筛选。",
  })
  @ApiOkResponse({ description: "模板分页列表" })
  findByPhone(
    @ExternalUserPhone(ExternalUserPhonePipe) phone: string,
    @Body() dto: QueryImageTemplateDto
  ) {
    return this.service.findByPhone(phone, dto)
  }

  @Post("tab-counts/query")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "查询模板 Tab 计数（全部/我的/系统）" })
  tabCounts(@ExternalUserPhone(ExternalUserPhonePipe) phone: string) {
    return this.service.tabCounts(phone)
  }

  @Post("groups/query")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "查询当前用户可见的模板分组及模板数" })
  findGroups(
    @ExternalUserPhone(ExternalUserPhonePipe) phone: string,
    @Body() dto: TemplateScopeQueryDto
  ) {
    return this.service.findGroups(phone, dto)
  }

  @Post("groups/manage/query")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "查询当前用户的个人分组管理列表（包含空分组）" })
  listGroups(@ExternalUserPhone(ExternalUserPhonePipe) phone: string) {
    return this.service.listGroups(phone)
  }

  @Post("groups")
  @ApiOperation({ summary: "新建当前用户的个人模板分组" })
  createGroup(
    @ExternalUserPhone(ExternalUserPhonePipe) phone: string,
    @Body() dto: CreateTemplateGroupDto
  ) {
    return this.service.createGroup(phone, dto.name)
  }

  @Patch("groups/:id")
  @ApiOperation({ summary: "重命名当前用户的个人模板分组" })
  renameGroup(
    @ExternalUserPhone(ExternalUserPhonePipe) phone: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RenameTemplateGroupDto
  ) {
    return this.service.renameGroup(phone, id, dto.name)
  }

  @Delete("groups/:id")
  @ApiOperation({ summary: "删除当前用户的个人模板分组及组内模板" })
  deleteGroup(
    @ExternalUserPhone(ExternalUserPhonePipe) phone: string,
    @Param("id", ParseIntPipe) id: number
  ) {
    return this.service.deleteGroup(phone, id)
  }

  @Post("tags/query")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "查询当前用户可见的模板标签及模板数" })
  findTags(
    @ExternalUserPhone(ExternalUserPhonePipe) phone: string,
    @Body() dto: TemplateScopeQueryDto
  ) {
    return this.service.findTags(phone, dto)
  }

  @Post("import")
  @ApiOperation({ summary: "按模板 ID 批量导入为当前用户的个人模板" })
  importTemplates(
    @ExternalUserPhone(ExternalUserPhonePipe) phone: string,
    @Body() dto: ImportImageTemplateDto
  ) {
    return this.service.importTemplates(phone, dto.ids)
  }

  @Post()
  @ApiOperation({ summary: "新建当前用户的个人模板" })
  create(
    @ExternalUserPhone(ExternalUserPhonePipe) phone: string,
    @Body() dto: CreateImageTemplateDto
  ) {
    return this.service.create(phone, dto)
  }

  @Post(":id/query")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "查询当前用户可见的模板详情" })
  findOne(
    @ExternalUserPhone(ExternalUserPhonePipe) phone: string,
    @Param("id", ParseIntPipe) id: number
  ) {
    return this.service.findOne(phone, id)
  }

  @Post(":id/items")
  @ApiOperation({ summary: "向当前用户的个人模板追加一张图片条目" })
  addItem(
    @ExternalUserPhone(ExternalUserPhonePipe) phone: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: TemplateItemDto
  ) {
    return this.service.addItem(phone, id, dto)
  }

  @Post(":id/copy")
  @ApiOperation({ summary: "复制可见模板为当前用户的个人模板" })
  copy(
    @ExternalUserPhone(ExternalUserPhonePipe) phone: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: CopyImageTemplateDto
  ) {
    return this.service.copy(phone, id, dto)
  }

  @Patch(":id")
  @ApiOperation({ summary: "编辑当前用户的个人模板（传 items 时整组替换）" })
  update(
    @ExternalUserPhone(ExternalUserPhonePipe) phone: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateImageTemplateDto
  ) {
    return this.service.update(phone, id, dto)
  }

  @Delete(":id")
  @ApiOperation({ summary: "软删除当前用户的个人模板" })
  remove(
    @ExternalUserPhone(ExternalUserPhonePipe) phone: string,
    @Param("id", ParseIntPipe) id: number
  ) {
    return this.service.remove(phone, id)
  }
}
