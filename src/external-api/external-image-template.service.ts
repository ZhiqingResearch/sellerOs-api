import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import {
  CopyImageTemplateDto,
  CreateImageTemplateDto,
  QueryImageTemplateDto,
  TemplateItemDto,
  TemplateScopeQueryDto,
  UpdateImageTemplateDto,
} from "../image-project/image-template.dto"
import { ImageTemplateService } from "../image-project/image-template.service"
import { PrismaService } from "../prisma/prisma.service"

@Injectable()
export class ExternalImageTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly imageTemplateService: ImageTemplateService
  ) {}

  async findByPhone(phone: string, query: QueryImageTemplateDto) {
    const userId = await this.resolveActiveUserId(phone)

    // 复用用户侧查询，保持“本人个人模板 + 全部系统模板”的既有可见性规则。
    return this.imageTemplateService.findAll(query, userId)
  }

  async tabCounts(phone: string) {
    return this.imageTemplateService.tabCounts(await this.resolveActiveUserId(phone))
  }

  async findGroups(phone: string, dto: TemplateScopeQueryDto) {
    const { tab = "all" } = dto
    return this.imageTemplateService.findGroups(await this.resolveActiveUserId(phone), tab)
  }

  async listGroups(phone: string) {
    return this.imageTemplateService.listGroups(await this.resolveActiveUserId(phone))
  }

  async createGroup(phone: string, name: string) {
    return this.imageTemplateService.createGroup(await this.resolveActiveUserId(phone), name)
  }

  async renameGroup(phone: string, id: number, name: string) {
    return this.imageTemplateService.renameGroup(await this.resolveActiveUserId(phone), id, name)
  }

  async deleteGroup(phone: string, id: number) {
    return this.imageTemplateService.deleteGroup(await this.resolveActiveUserId(phone), id)
  }

  async findTags(phone: string, dto: TemplateScopeQueryDto) {
    const { tab = "all" } = dto
    return this.imageTemplateService.findTags(await this.resolveActiveUserId(phone), tab)
  }

  async findOne(phone: string, id: number) {
    return this.imageTemplateService.findOne(id, await this.resolveActiveUserId(phone))
  }

  async create(phone: string, dto: CreateImageTemplateDto) {
    return this.imageTemplateService.create(dto, await this.resolveActiveUserId(phone))
  }

  async importTemplates(phone: string, ids: number[]) {
    return this.imageTemplateService.importTemplates(ids, await this.resolveActiveUserId(phone))
  }

  async addItem(phone: string, id: number, dto: TemplateItemDto) {
    return this.imageTemplateService.addItem(id, dto, await this.resolveActiveUserId(phone))
  }

  async copy(phone: string, id: number, dto: CopyImageTemplateDto) {
    return this.imageTemplateService.copy(id, dto, await this.resolveActiveUserId(phone))
  }

  async update(phone: string, id: number, dto: UpdateImageTemplateDto) {
    return this.imageTemplateService.update(id, dto, await this.resolveActiveUserId(phone))
  }

  async remove(phone: string, id: number) {
    return this.imageTemplateService.remove(id, await this.resolveActiveUserId(phone))
  }

  /** 手机号只用于定位账户，不写入响应；每次调用都实时校验账户是否仍然有效。 */
  private async resolveActiveUserId(phone: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true, isActive: true },
    })

    if (!user) throw new NotFoundException("无此账户信息")
    if (!user.isActive) throw new ForbiddenException("账户已停用")
    return user.id
  }
}
