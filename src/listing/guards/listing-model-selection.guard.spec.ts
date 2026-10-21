import { ExecutionContext, ForbiddenException } from "@nestjs/common"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { PrismaService } from "../../prisma/prisma.service"
import { ListingAiInvocationDto } from "../dto/listing-ai.dto"
import { ListingModelSelectionGuard } from "./listing-model-selection.guard"

function contextOf(body: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: { id: 7 }, body }) }),
  } as unknown as ExecutionContext
}

describe("ListingModelSelectionGuard", () => {
  const findFirst = jest.fn()
  const guard = new ListingModelSelectionGuard({
    userRole: { findFirst },
  } as unknown as PrismaService)
  beforeEach(() => findFirst.mockReset())

  it.each(["claude-haiku-5-5", "gpt-6-luna", "gpt-6.1-sol"])("DTO 接受新增模型 %s", async model => {
    const dto = plainToInstance(ListingAiInvocationDto, {
      operation: "generation",
      model,
      userPrompt: "产品资料",
    })
    expect(await validate(dto)).toEqual([])
  })

  it("允许实际绑定内部运营角色的多角色用户", async () => {
    findFirst.mockResolvedValue({ roleId: 3 })
    await expect(guard.canActivate(contextOf({ main: { model: "gpt-6-luna" } }))).resolves.toBe(
      true
    )
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: 7, role: { name: { in: ["运营专员（内部）", "运营专员(内部)"] } } },
      select: { roleId: true },
    })
  })

  it.each(["model", "main", "longTitle", "autoScore"])(
    "拒绝通过 %s 绕过内部角色限制",
    async field => {
      findFirst.mockResolvedValue(null)
      const body =
        field === "model" ? { model: "gpt-6.1-sol" } : { [field]: { model: "gpt-6.1-sol" } }
      await expect(guard.canActivate(contextOf(body))).rejects.toBeInstanceOf(ForbiddenException)
    }
  )

  it.each([undefined, "ZQ-Think-Flash", "ZQ-Think-Lite", "ZQ-Multimodal-Gemini-3.8-Flash"])(
    "保留已有调用资格 %s",
    async model => {
      await expect(guard.canActivate(contextOf({ main: { model } }))).resolves.toBe(true)
      expect(findFirst).not.toHaveBeenCalled()
    }
  )
})
