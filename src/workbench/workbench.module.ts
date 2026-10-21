import { Module } from "@nestjs/common"
import { WorkbenchController } from "./workbench.controller"
import { WorkbenchService } from "./workbench.service"

/** 卖家工作台；各功能产出查询集中在 workbench-outputs.ts，新增业务在那里追加一块即可 */
@Module({
  controllers: [WorkbenchController],
  providers: [WorkbenchService],
})
export class WorkbenchModule {}
