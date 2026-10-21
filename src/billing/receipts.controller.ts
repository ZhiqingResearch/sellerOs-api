import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PaginationDto } from "../common/dto/pagination.dto"
import { ClaimReceiptDto, ResendReceiptDto, SetDefaultEmailDto } from "./dto/billing.dto"
import { ReceiptsService } from "./receipts.service"

/** 用户侧：收据列表/详情/网页渲染/重发邮件/CSV 导出/人工流水补开/默认接收邮箱。 */
@ApiTags("收据中心")
@ApiBearerAuth()
@Controller("billing/receipts")
@UseGuards(JwtAuthGuard)
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Get()
  @ApiOperation({ summary: "我的收据列表（分页）" })
  list(@Request() req: { user: { id: number } }, @Query() query: PaginationDto) {
    return this.receipts.listMine(req.user.id, query.page, query.pageSize)
  }

  @Get("export")
  @ApiOperation({
    summary: "收据 CSV 导出（带 BOM）",
    description:
      "开具时间按 tz（IANA 时区名，前端传 Intl.DateTimeFormat().resolvedOptions().timeZone，如 Asia/Shanghai）格式化为 YYYY-MM-DD HH:mm:ss；缺省/非法回落 Asia/Shanghai。最多 5000 行。",
  })
  @Header("Content-Type", "text/csv; charset=utf-8")
  export(@Request() req: { user: { id: number } }, @Query("tz") tz?: string) {
    return this.receipts.exportCsv(req.user.id, tz)
  }

  // 静态段须先于 :receiptNo 注册，否则被参数路由吃掉
  @Get("default-email")
  @ApiOperation({ summary: "默认收据接收邮箱（用户设置值，回落账号邮箱；均无=空串）" })
  getDefaultEmail(@Request() req: { user: { id: number } }) {
    return this.receipts.getDefaultEmail(req.user.id)
  }

  @Put("default-email")
  @ApiOperation({ summary: "设置默认收据接收邮箱（空串=清除，回落账号邮箱）" })
  setDefaultEmail(@Request() req: { user: { id: number } }, @Body() dto: SetDefaultEmailDto) {
    return this.receipts.setDefaultEmail(req.user.id, dto.email)
  }

  @Get(":receiptNo")
  @ApiOperation({ summary: "收据详情（含全部正文字段，供查看页/前端下载 PDF）" })
  detail(@Request() req: { user: { id: number } }, @Param("receiptNo") receiptNo: string) {
    return this.receipts.getMine(req.user.id, receiptNo)
  }

  @Get(":receiptNo/html")
  @ApiOperation({ summary: "收据网页渲染 HTML（查看/打印/前端生成 PDF 共用模板）" })
  @Header("Content-Type", "text/html; charset=utf-8")
  html(@Request() req: { user: { id: number } }, @Param("receiptNo") receiptNo: string) {
    return this.receipts.renderMineHtml(req.user.id, receiptNo)
  }

  @Post(":receiptNo/resend")
  @ApiOperation({ summary: "重发收据邮件（可传 email 改发新邮箱；PDF 附件通道配置后自动带附件）" })
  resend(
    @Request() req: { user: { id: number } },
    @Param("receiptNo") receiptNo: string,
    @Body() dto: ResendReceiptDto
  ) {
    return this.receipts.resend(req.user.id, receiptNo, dto?.email)
  }

  @Post("claim")
  @ApiOperation({
    summary: "补开收据：对本人的后台人工充值流水现开收据（可传 email 指定接收邮箱）",
  })
  claim(@Request() req: { user: { id: number } }, @Body() dto: ClaimReceiptDto) {
    return this.receipts.claimFromTransaction(req.user.id, dto.transactionId, dto.email)
  }
}
