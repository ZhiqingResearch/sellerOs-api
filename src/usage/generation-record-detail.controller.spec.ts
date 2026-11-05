import { ExecutionContext, ForbiddenException } from "@nestjs/common"
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants"
import { Reflector } from "@nestjs/core"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { UsageController } from "./usage.controller"

// 此处验证路由和权限，不构造真实计费依赖。
jest.mock("./usage.service", () => ({ UsageService: class UsageService {} }))

const detailHandler = Reflect.get(UsageController.prototype, "getGenerationRecordDetail") as (
  ...args: unknown[]
) => unknown

function createMocks(keys: string[]) {
  const permissions = {
    getForUser: jest.fn().mockResolvedValue(new Set(keys)),
    getLabelMap: jest.fn().mockResolvedValue(new Map([["company.admin", "后台管理"]])),
  }
  const detail = {
    detail: jest
      .fn()
      .mockResolvedValue({ userId: 99, available: true, content: { report: "正文" } }),
  }
  const controller = new UsageController({} as never, {} as never, detail as never)
  const context = {
    getHandler: () => detailHandler,
    getClass: () => UsageController,
    switchToHttp: () => ({ getRequest: () => ({ user: { id: 7 } }) }),
  } as unknown as ExecutionContext
  const guard = new PermissionsGuard(new Reflector(), permissions as never)
  return { controller, context, guard, detail, permissions }
}

describe("生成记录正文路由权限", () => {
  it("详情接口沿用 JWT 和权限守卫，无 company.admin 权限不允许查询正文", async () => {
    const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, UsageController)
    expect(guards).toContain(JwtAuthGuard)
    expect(guards).toContain(PermissionsGuard)
    expect(Reflect.getMetadata(PATH_METADATA, detailHandler)).toBe("generation-records/detail")
    const { guard, context, detail } = createMocks([])
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException)
    expect(detail.detail).not.toHaveBeenCalled()
  })

  it("有管理员权限后原样透传 key，可只读查看其他用户正文", async () => {
    const { guard, context, controller, detail, permissions } = createMocks(["company.admin"])
    expect(await guard.canActivate(context)).toBe(true)
    const result = await controller.getGenerationRecordDetail({ key: "TEXT:ASIN_AUDIT:record-1" })
    expect(result).toMatchObject({ userId: 99, available: true })
    expect(detail.detail).toHaveBeenCalledWith("TEXT:ASIN_AUDIT:record-1")
    expect(permissions.getForUser).toHaveBeenCalledWith(7)
  })
})
