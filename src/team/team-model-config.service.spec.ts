import { BadRequestException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { PrismaService } from "../prisma/prisma.service"
import { BatchSaveModelsDto } from "./dto/console.dto"
import { TeamModelConfigService } from "./team-model-config.service"
import { TEAM_MODEL_MODULES } from "./team.constants"

const CATALOG = [
  { code: "gemini-2.5-flash", name: "Gemini 2.5 Flash", kind: "TEXT" },
  { code: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", kind: "TEXT" },
  { code: "nano-banana-2", name: "Nano Banana 2", kind: "IMAGE" },
  { code: "veo-3.1-lite", name: "Veo 3.1 Lite", kind: "VIDEO" },
]

const DEFAULT_OF: Record<string, string> = {
  TEXT: "gemini-2.5-flash",
  IMAGE: "nano-banana-2",
  VIDEO: "veo-3.1-lite",
}

/** 合法批量保存 payload：每模块可选范围=该类型的在架默认模型 */
const validPayload = (): BatchSaveModelsDto => ({
  defaults: { text: "gemini-2.5-flash", image: "nano-banana-2", video: "veo-3.1-lite" },
  modules: TEAM_MODEL_MODULES.map(d => ({
    moduleKey: d.moduleKey,
    allowedModels: [DEFAULT_OF[d.kind]],
    defaultModel: DEFAULT_OF[d.kind],
    memberSelectable: true,
  })),
})

describe("TeamModelConfigService", () => {
  let service: TeamModelConfigService
  let prisma: {
    aiModel: { findMany: jest.Mock }
    team: { findUniqueOrThrow: jest.Mock; findUnique: jest.Mock; update: jest.Mock }
    teamModelConfig: {
      findMany: jest.Mock
      findUnique: jest.Mock
      deleteMany: jest.Mock
      createMany: jest.Mock
    }
    teamAuditLog: { create: jest.Mock }
    $transaction: jest.Mock
  }

  beforeEach(async () => {
    prisma = {
      aiModel: { findMany: jest.fn().mockResolvedValue(CATALOG) },
      team: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          defaultModelText: "gemini-2.5-flash",
          defaultModelImage: "nano-banana-2",
          defaultModelVideo: "veo-3.1-lite",
        }),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      teamModelConfig: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: TEAM_MODEL_MODULES.length }),
      },
      teamAuditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    }
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma))

    const moduleRef = await Test.createTestingModule({
      providers: [TeamModelConfigService, { provide: PrismaService, useValue: prisma }],
    }).compile()
    service = moduleRef.get(TeamModelConfigService)
  })

  describe("getCatalog", () => {
    it("只查在架模型并按 kind 分组", async () => {
      const r = await service.getCatalog()
      expect(prisma.aiModel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { active: true } })
      )
      expect(r.text.map(m => m.code)).toEqual(["gemini-2.5-flash", "gemini-3.1-pro-preview"])
      expect(r.image.map(m => m.code)).toEqual(["nano-banana-2"])
      expect(r.video.map(m => m.code)).toEqual(["veo-3.1-lite"])
    })
  })

  describe("getConfig", () => {
    it("返回注册表全部模块；未配置模块为 null（跟随全局默认）", async () => {
      const r = await service.getConfig(1)
      expect(r.defaults).toEqual({
        text: "gemini-2.5-flash",
        image: "nano-banana-2",
        video: "veo-3.1-lite",
      })
      expect(r.modules).toHaveLength(TEAM_MODEL_MODULES.length)
      const listing = r.modules.find(m => m.moduleKey === "listing")!
      expect(listing).toMatchObject({
        label: "Listing",
        kind: "TEXT",
        allowedModels: null,
        defaultModel: null,
        memberSelectable: true,
      })
    })

    it("已配置模块返回库中配置", async () => {
      prisma.teamModelConfig.findMany.mockResolvedValue([
        {
          teamId: 1,
          moduleKey: "listing",
          allowedModels: ["gemini-3.1-pro-preview"],
          defaultModel: "gemini-3.1-pro-preview",
          memberSelectable: false,
        },
      ])
      const r = await service.getConfig(1)
      const listing = r.modules.find(m => m.moduleKey === "listing")!
      expect(listing).toMatchObject({
        allowedModels: ["gemini-3.1-pro-preview"],
        defaultModel: "gemini-3.1-pro-preview",
        memberSelectable: false,
      })
    })
  })

  describe("batchSave", () => {
    it("缺少模块配置 → 400", async () => {
      const dto = validPayload()
      dto.modules = dto.modules.filter(m => m.moduleKey !== "listing")
      await expect(service.batchSave(1, 10, dto)).rejects.toThrow(BadRequestException)
      await expect(service.batchSave(1, 10, dto)).rejects.toThrow("缺少模块配置：Listing")
    })

    it("重复 moduleKey → 400", async () => {
      const dto = validPayload()
      dto.modules = [...dto.modules, { ...dto.modules[0] }]
      await expect(service.batchSave(1, 10, dto)).rejects.toThrow("重复的 moduleKey")
    })

    it("未知 moduleKey → 400", async () => {
      const dto = validPayload()
      dto.modules.push({
        moduleKey: "foo",
        allowedModels: ["gemini-2.5-flash"],
        defaultModel: "gemini-2.5-flash",
        memberSelectable: true,
      })
      await expect(service.batchSave(1, 10, dto)).rejects.toThrow("未知的功能模块：foo")
    })

    it("默认模型不在可选范围 → 400", async () => {
      const dto = validPayload()
      const listing = dto.modules.find(m => m.moduleKey === "listing")!
      listing.allowedModels = ["gemini-2.5-flash", "gemini-3.1-pro-preview"]
      listing.defaultModel = "gemini-3.1-pro-preview"
      const img = dto.modules.find(m => m.moduleKey === "img")!
      img.allowedModels = ["nano-banana-2"]
      img.defaultModel = "not-in-range"
      await expect(service.batchSave(1, 10, dto)).rejects.toThrow("默认模型必须在可选范围内")
    })

    it("模型不存在/已下架 → 400", async () => {
      const dto = validPayload()
      dto.defaults.text = "not-exist"
      await expect(service.batchSave(1, 10, dto)).rejects.toThrow("模型 not-exist 不存在或已下架")
    })

    it("模型类型与模块不匹配 → 400", async () => {
      const dto = validPayload()
      const listing = dto.modules.find(m => m.moduleKey === "listing")!
      listing.allowedModels = ["nano-banana-2"]
      listing.defaultModel = "nano-banana-2"
      await expect(service.batchSave(1, 10, dto)).rejects.toThrow("不是文本类模型")
    })

    it("校验通过：单事务更新默认 + 全量替换模块配置 + 写审计", async () => {
      const dto = validPayload()
      const r = await service.batchSave(1, 10, dto)

      expect(prisma.$transaction).toHaveBeenCalledTimes(1)
      expect(prisma.team.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          defaultModelText: "gemini-2.5-flash",
          defaultModelImage: "nano-banana-2",
          defaultModelVideo: "veo-3.1-lite",
        },
      })
      expect(prisma.teamModelConfig.deleteMany).toHaveBeenCalledWith({ where: { teamId: 1 } })
      const createManyCalls = prisma.teamModelConfig.createMany.mock.calls as unknown[][]
      const createManyArg = createManyCalls[0][0] as { data: { moduleKey: string }[] }
      expect(createManyArg.data).toHaveLength(TEAM_MODEL_MODULES.length)
      expect(prisma.teamAuditLog.create).toHaveBeenCalledTimes(1)
      // 返回整页数据
      expect(r.modules).toHaveLength(TEAM_MODEL_MODULES.length)
    })
  })

  describe("resolveModuleModels", () => {
    it("无模块配置时回落全局默认", async () => {
      prisma.team.findUnique.mockResolvedValue({
        defaultModelText: "gemini-2.5-flash",
        defaultModelImage: "nano-banana-2",
        defaultModelVideo: "veo-3.1-lite",
      })
      const r = await service.resolveModuleModels(1, "listing", "text")
      expect(r).toEqual({
        source: "global",
        allowedModels: null,
        defaultModel: "gemini-2.5-flash",
        memberSelectable: true,
      })
    })
  })
})
