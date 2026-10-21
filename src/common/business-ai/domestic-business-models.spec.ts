import { BadRequestException, type ExecutionContext } from "@nestjs/common"
import { validate } from "class-validator"
import { AnalyzeCompetitorsDto } from "../../competitor-analysis/dto/analyze-competitors.dto"
import { ListingAiInvocationDto } from "../../listing/dto/listing-ai.dto"
import { PrismaService } from "../../prisma/prisma.service"
import { BusinessAiDto } from "./business-ai.dto"
import { DomesticBusinessModelGuard } from "./domestic-business-model.guard"
import { DomesticBusinessModels } from "./domestic-business-models"

const contextOf = (body: unknown) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ body }) }) }) as ExecutionContext

describe("指定业务的国产模型校验", () => {
  const findFirst = jest.fn()
  const findMany = jest.fn()
  const models = new DomesticBusinessModels({
    aiGatewayModel: { findFirst, findMany },
  } as unknown as PrismaService)
  const guard = new DomesticBusinessModelGuard(models)
  beforeEach(() => {
    jest.clearAllMocks()
    findFirst.mockResolvedValue({ publicId: "qwen3.8-max" })
  })

  it.each(["qwen3.8-max", "MiniMax-M3"])("按 TEXT 分类和双启用标志校验 %s", async model => {
    await models.assertEnabled(model)
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        publicId: model,
        category: "TEXT",
        modality: "TEXT",
        enabled: true,
        gatewayActive: true,
      },
      select: { publicId: true },
    })
  })
  it.each([undefined, null, "", "ZQ-Think-Flash", "gpt-6.1-sol", "qwen3.8-max "])(
    "拒绝遗漏及白名单外模型 %s",
    async model => {
      await expect(models.assertEnabled(model)).rejects.toBeInstanceOf(BadRequestException)
      expect(findFirst).not.toHaveBeenCalled()
    }
  )
  it("已停用、网关不可用或只在其他分类上架均拒绝", async () => {
    findFirst.mockResolvedValue(null)
    await expect(models.assertEnabled("MiniMax-M3")).rejects.toThrow("未启用或当前不可用")
  })
  it("目录查询也限制为同一白名单和 TEXT 分类", async () => {
    findMany.mockResolvedValue([{ publicId: "MiniMax-M3", displayName: "MiniMax-M3" }])
    expect(await models.findAll()).toEqual({
      items: [{ publicId: "MiniMax-M3", displayName: "MiniMax-M3" }],
    })
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          publicId: { in: ["qwen3.8-max", "MiniMax-M3"] },
          category: "TEXT",
          modality: "TEXT",
          enabled: true,
          gatewayActive: true,
        },
      })
    )
  })
  it.each(["model", "main", "longTitle", "autoScore"])("拒绝 %s 中的不可用模型", async key => {
    const body =
      key === "model" ? { model: "ZQ-Think-Flash" } : { [key]: { model: "ZQ-Think-Flash" } }
    await expect(guard.canActivate(contextOf(body))).rejects.toBeInstanceOf(BadRequestException)
  })
  it("同时校验生成、长标题和自动评分，重复模型只查一次", async () => {
    await guard.canActivate(
      contextOf({
        main: { model: "qwen3.8-max" },
        longTitle: { model: "MiniMax-M3" },
        autoScore: { model: "qwen3.8-max" },
      })
    )
    expect(findFirst).toHaveBeenCalledTimes(2)
  })
  it("历史读取和上传凭证不需要选择模型", async () => {
    await guard.canActivate(contextOf(undefined))
    await guard.canActivate(contextOf({ fileName: "manual.pdf" }))
    expect(findFirst).not.toHaveBeenCalled()
  })
  for (const [name, dto, payload] of [
    ["Listing", ListingAiInvocationDto, { operation: "generation", userPrompt: "资料" }],
    ["竞品", AnalyzeCompetitorsDto, { asins: ["B000000001"], country: "US" }],
    ["推广与定价", BusinessAiDto, { operation: "generate", userPrompt: "资料" }],
  ] as const) {
    it.each([undefined, null, "ZQ-Think-Flash"])(`${name} DTO 拒绝模型 %s`, async model => {
      const input = Object.assign(new dto(), payload, { model })
      expect((await validate(input)).some(error => error.property === "model")).toBe(true)
    })
    it.each(["qwen3.8-max", "MiniMax-M3"])(`${name} DTO 接受 %s`, async model => {
      expect(await validate(Object.assign(new dto(), payload, { model }))).toHaveLength(0)
    })
  }
})
