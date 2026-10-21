import { Module } from "@nestjs/common"
import { ProductReportController } from "./product-report.controller"
import { ProductReportService } from "./product-report.service"

@Module({
  controllers: [ProductReportController],
  providers: [ProductReportService],
})
export class ProductReportModule {}
