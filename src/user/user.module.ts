import { Module } from "@nestjs/common"
import { MembershipModule } from "../membership/membership.module"
import { SmsModule } from "../sms/sms.module"
import { UserController } from "./user.controller"
import { UserService } from "./user.service"

@Module({
  imports: [SmsModule, MembershipModule],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
