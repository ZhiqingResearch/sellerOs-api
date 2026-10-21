import { Controller, Get, Query, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { AuditService } from "./audit.service"
import { QueryAuditDetailDto } from "./dto/query-audit-detail.dto"

@ApiTags("ASIN 审计")
@ApiBearerAuth()
@Controller("audit")
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private readonly service: AuditService) {}

  @Get("detail")
  @ApiOperation({
    summary: "按 URL 或 ASIN 查审计商品详情",
    description:
      "url 与 asin 二选一（都传以 url 为准、都不传 400）；传 asin 时按 country（默认 US）域名拼 URL。命中缓存且 fetchedAt 距今 < PRODUCT_CACHE_TTL_DAYS（默认 30 天）直返，否则同步调审计爬虫、写库。爬虫失败抛 502，body 含 { code, message }。与 products/detail 各存各表、互不影响。",
  })
  detail(@Query() query: QueryAuditDetailDto) {
    return this.service.findDetail(query)
  }
}
