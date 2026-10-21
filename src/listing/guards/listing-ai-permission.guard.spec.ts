import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common"
import { PermissionCacheService } from "../../auth/services/permission-cache.service"
import { ListingAiPermissionGuard } from "./listing-ai-permission.guard"

function contextOf(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext
}

describe("ListingAiPermissionGuard", () => {
  const getForUser = jest.fn()
  const getLabelMap = jest.fn().mockResolvedValue(
    new Map([
      ["tool.listing_generate", "Listing 生成"],
      ["tool.listing_score", "Listing 打分"],
    ])
  )
  const guard = new ListingAiPermissionGuard({
    getForUser,
    getLabelMap,
  } as unknown as PermissionCacheService)

  beforeEach(() => {
    getForUser.mockReset()
    getLabelMap.mockClear()
  })

  it("Listing 打分权限可以调用 score 操作", async () => {
    getForUser.mockResolvedValue(new Set(["tool.listing_score"]))

    await expect(
      guard.canActivate(contextOf({ user: { id: 7 }, body: { operation: "score" } }))
    ).resolves.toBe(true)
  })

  it("Listing 生成权限可以继续调用自动打分", async () => {
    getForUser.mockResolvedValue(new Set(["tool.listing_generate"]))

    await expect(
      guard.canActivate(contextOf({ user: { id: 7 }, body: { operation: "score" } }))
    ).resolves.toBe(true)
  })

  it("仅有 Listing 打分权限不能调用生成操作", async () => {
    getForUser.mockResolvedValue(new Set(["tool.listing_score"]))

    await expect(
      guard.canActivate(contextOf({ user: { id: 7 }, body: { operation: "generation" } }))
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("未登录时拒绝调用", async () => {
    await expect(
      guard.canActivate(contextOf({ body: { operation: "score" } }))
    ).rejects.toBeInstanceOf(UnauthorizedException)
  })
})
