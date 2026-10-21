import { SetMetadata } from "@nestjs/common"

export const RECHARGE_READ_KEY = "rechargeRead"

/**
 * 只读放行口：标注的后台充值只读路由不走 canRecharge 账号白名单（RechargeAccountGuard 直接放行），
 * 改由方法级 PermissionsGuard + `management.users` 权限点把守——客户运营·个人订阅页查充值记录用。
 * 写接口（充值/调额/调整）不得标注，仍走白名单。
 */
export const RechargeRead = () => SetMetadata(RECHARGE_READ_KEY, true)
