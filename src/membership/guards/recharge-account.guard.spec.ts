import { ExecutionContext, ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { RechargeAccessService } from "../recharge-access.service"
import { RechargeAccountGuard } from "./recharge-account.guard"
import { RechargeRead } from "./recharge-read.decorator"

/** 后台充值账号门：写接口只认 canRecharge 白名单（连超管也挡）；@RechargeRead 只读路由放行给权限点 */
describe("RechargeAccountGuard", () => {
  const access = { canRecharge: jest.fn() }
  const guard = new RechargeAccountGuard(
    access as unknown as RechargeAccessService,
    new Reflector()
  )
  const ctxFor = (handler: (...a: unknown[]) => unknown): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 1 } }) }),
      getHandler: () => handler,
      getClass: () => class {},
    }) as unknown as ExecutionContext

  beforeEach(() => access.canRecharge.mockReset())

  it("白名单账号放行", async () => {
    access.canRecharge.mockResolvedValue(true)
    await expect(guard.canActivate(ctxFor(() => undefined))).resolves.toBe(true)
  })

  it("非白名单账号 403「无后台充值权限」（连超管也挡）", async () => {
    access.canRecharge.mockResolvedValue(false)
    await expect(guard.canActivate(ctxFor(() => undefined))).rejects.toThrow(ForbiddenException)
  })

  it("@RechargeRead 只读路由：不查白名单直接放行（权限点由方法级 PermissionsGuard 把守）", async () => {
    class T {
      @RechargeRead()
      handler(this: void) {
        return undefined
      }
    }
    await expect(guard.canActivate(ctxFor(new T().handler))).resolves.toBe(true)
    expect(access.canRecharge).not.toHaveBeenCalled()
  })
})
