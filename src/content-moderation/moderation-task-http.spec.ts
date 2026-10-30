import Core from "@alicloud/pop-core"
import { type ExecutionContext, type INestApplication } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core"
import { Test } from "@nestjs/testing"
import { Decimal } from "@prisma/client/runtime/library"
import type { AiGatewayClient } from "@zhiqingresearch/ai-ts-sdk"
import request from "supertest"
import { AiGatewayModelService } from "../ai-gateway/ai-gateway-model.service"
import { AiGatewayWebhookService } from "../ai-gateway/ai-gateway-webhook.service"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { AliyunContentModerationProvider } from "../common/providers/aliyun-content-moderation.provider"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { InternalGenerationController } from "../video-project/internal-generation.controller"
import { InternalGenerationGuard } from "../video-project/internal-generation.guard"
import { InternalGenerationService } from "../video-project/internal-generation.service"
import { SalesController } from "../video-project/sales/sales.controller"
import { SalesService } from "../video-project/sales/sales.service"
import { VideoProjectController } from "../video-project/video-project.controller"
import { VideoProjectService } from "../video-project/video-project.service"
import { contentInputs } from "./content-inputs"
import { ModerationScopeMiddleware } from "./moderation-scope"
import { ContentModerationController } from "./content-moderation.controller"
import { ContentModerationPipe } from "./content-moderation.pipe"
import { ContentModerationService } from "./content-moderation.service"
import { ModerationResponseInterceptor } from "./moderation-response.interceptor"
import { TaskModerationService } from "./task-moderation.service"

jest.mock("@alicloud/pop-core", () => jest.fn())

type Row = Record<string, unknown>
const isDate = (value: unknown): value is Date =>
  Object.prototype.toString.call(value) === "[object Date]"
function matches(where: Row, row: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Row[]).some(condition => matches(condition, row))
    if (key === "AND") return (value as Row[]).every(condition => matches(condition, row))
    if (isDate(value)) return isDate(row[key]) && (row[key] as Date).getTime() === value.getTime()
    if (value && typeof value === "object") {
      const condition = value as { in?: unknown[]; lt?: Date; lte?: Date; not?: unknown }
      if (condition.in) return condition.in.includes(row[key])
      if (condition.lt) return (row[key] as Date) < condition.lt
      if (condition.lte) return (row[key] as Date) <= condition.lte
      if ("not" in condition) return row[key] !== condition.not
      return Boolean(
        row[key] && typeof row[key] === "object" && matches(value as Row, row[key] as Row)
      )
    }
    return row[key] === value
  })
}

function taskStore() {
  const rows = new Map<number, Row>()
  const createRow = (data: Row = {}) => {
    const row: Row = {
      id: rows.size + 1,
      userId: 7,
      source: "platform",
      model: "model",
      modelName: "模型",
      mode: "NORMAL",
      project: { id: 1, userId: 7, source: "platform", deletedAt: null },
      storyboard: {
        deletedAt: null,
        production: {
          deletedAt: null,
          project: { deletedAt: null, customer: { userId: 7, deletedAt: null } },
        },
      },
      status: "WAITING_MODERATION",
      deletedAt: null,
      gatewayTaskId: null,
      resultUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      moderationStatus: null,
      moderation: null,
      moderationClaimUntil: null,
      moderationNextCheckAt: null,
      moderationPassedAt: null,
      generationParams: {
        model: "model",
        prompt: "普通内容",
        resolution: "720p",
        duration_seconds: 4,
      },
      ...data,
    }
    rows.set(row.id as number, row)
    return structuredClone(row)
  }
  const read = async ({ where }: { where: Row }) =>
    structuredClone([...rows.values()].find(row => matches(where, row)) ?? null)
  return {
    rows,
    createRow,
    create: jest.fn(async ({ data }: { data: Row }) => createRow(data)),
    findFirst: jest.fn(read),
    findUnique: jest.fn(read),
    findMany: jest.fn(async ({ where }: { where: Row }) =>
      structuredClone([...rows.values()].filter(row => matches(where, row)))
    ),
    updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0
      for (const [id, row] of rows)
        if (matches(where, row)) {
          rows.set(id, { ...row, ...structuredClone(data) })
          count++
        }
      return { count }
    }),
    update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = [...rows.values()].find(row => matches(where, row))!
      const updated = { ...row, ...structuredClone(data) }
      rows.set(row.id as number, updated)
      return updated
    }),
  }
}

describe("HTTP→真实业务服务→审核状态机→网关SDK", () => {
  let app: INestApplication
  let tasks: TaskModerationService
  let gateway: AiGatewayProvider
  let estimate: jest.SpyInstance
  const vendor = jest.fn()
  const videoTask = taskStore(),
    beautyTask = taskStore(),
    storyboardVideo = taskStore()
  const stores = [videoTask, beautyTask, storyboardVideo]
  const model = {
    publicId: "model",
    displayName: "模型",
    category: "NORMAL",
    priceMultiplier: new Decimal(1),
  }
  const prisma = {
    videoTask,
    beautyTask,
    storyboardVideo,
    user: { findUnique: jest.fn().mockResolvedValue({ id: 7 }) },
    videoProject: {
      findUnique: jest.fn().mockResolvedValue({ id: 1, userId: 7 }),
      findFirst: jest.fn().mockResolvedValue({ id: 1 }),
    },
    aiGatewayModel: {
      findFirst: jest.fn().mockResolvedValue(model),
      findMany: jest.fn().mockResolvedValue([model]),
    },
    usageLog: { findUnique: jest.fn().mockResolvedValue(null) },
    salesWorkflow: {
      findUnique: jest.fn().mockResolvedValue({
        id: 6,
        projectId: 1,
        userId: 7,
        model: "model",
        outputMode: "ONESHOT",
        totalDuration: 4,
        productImages: [{ url: "https://assets.test/product.png" }],
        digitalHuman: null,
        scene: null,
        aspectRatio: "16:9",
        resolution: "720p",
        generateAudio: false,
        project: { id: 1, name: "带货项目", type: "ECOMMERCE" },
        segments: [
          {
            id: 1,
            order: 0,
            startSec: 0,
            endSec: 4,
            vidPrompt: "数据库中的商品画面",
            voiceover: "商品介绍",
          },
        ],
      }),
    },
  }
  const usage = {
    resolveFixedVideoTier: jest
      .fn()
      .mockResolvedValue({ creditsPerSec: new Decimal(1), flat: false }),
    assertExactCreditsAffordable: jest.fn(),
    assertGatewayAffordable: jest.fn(),
  }
  const webhook = {
    applyVideoTask: jest.fn(),
    reconcileVideoTaskOnRead: jest.fn().mockResolvedValue(false),
  }
  const submit = jest.fn()
  let mode = "pass"

  beforeAll(async () => {
    ;(Core as unknown as jest.Mock).mockImplementation(() => ({ request: vendor }))
    const config = new ConfigService({
      ZQ_ACCESS_KEY_ID: "test",
      ZQ_ACCESS_KEY_SECRET: "test",
      SPACES_BASE_URL: "https://assets.test",
      AI_GATEWAY_API_KEY: "test",
      AI_GATEWAY_VIDFLOWOS_API_KEY: "test-internal",
      AI_GATEWAY_BASE_URL: "https://no-network.invalid",
    })
    const provider = new AliyunContentModerationProvider(config)
    const snapshots = {
      freeze: jest.fn(async (value, root, technical) => ({
        value,
        inputs: contentInputs(value, root, technical),
      })),
    }
    const content = new ContentModerationService(provider, {} as never, snapshots as never)
    tasks = new TaskModerationService(prisma as never, provider, snapshots as never)
    gateway = new AiGatewayProvider(config, tasks, content, usage as never)
    const clients = gateway as unknown as {
      gateway: AiGatewayClient
      vidflowosGateway: AiGatewayClient
    }
    for (const client of [clients.gateway, clients.vidflowosGateway]) {
      jest.spyOn(client.videos.withResponse, "generate").mockImplementation(submit)
    }
    estimate = jest.spyOn(gateway, "estimateVideoPrice")
    tasks.registerContinuation(async (key, row) => {
      const result = await gateway.createVideoTask(row.generationParams as never, key)
      const store = key.startsWith("beauty-task")
        ? beautyTask
        : key.startsWith("storyboard-video")
          ? storyboardVideo
          : videoTask
      await store.updateMany({ where: { id: row.id }, data: { gatewayTaskId: result.id } })
    })
    const auth = {
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user: { id: number } }>().user = { id: 7 }
        return true
      },
    }
    const module = await Test.createTestingModule({
      controllers: [
        VideoProjectController,
        InternalGenerationController,
        ContentModerationController,
        SalesController,
      ],
      providers: [
        VideoProjectService,
        InternalGenerationService,
        SalesService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsageService, useValue: usage },
        { provide: AiGatewayProvider, useValue: gateway },
        { provide: AiGatewayWebhookService, useValue: webhook },
        { provide: AiGatewayModelService, useValue: {} },
        { provide: ContentModerationService, useValue: content },
        { provide: TaskModerationService, useValue: tasks },
        { provide: APP_PIPE, useClass: ContentModerationPipe },
        { provide: APP_INTERCEPTOR, useClass: ModerationResponseInterceptor },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(auth)
      .overrideGuard(InternalGenerationGuard)
      .useValue(auth)
      .compile()
    app = module.createNestApplication({ logger: false })
    const scope = new ModerationScopeMiddleware()
    app.use(scope.use.bind(scope))
    app.setGlobalPrefix("api")
    await app.init()
    await app.listen(0, "127.0.0.1")
  })
  beforeEach(() => {
    jest.clearAllMocks()
    stores.forEach(store => store.rows.clear())
    mode = "pass"
    submit.mockResolvedValue({
      data: {
        id: "gateway-reviewed",
        object: "video.task",
        status: "queued",
        model: "model",
        request_id: "req",
        created_at: 1,
      },
      response: { requestId: "req", status: 202, headers: new Headers() },
    })
    vendor.mockImplementation(async (action: string) => {
      if (mode === "unavailable") throw new Error("upstream timeout")
      if (action === "VideoModeration" || action === "FileModeration")
        return { Code: 200, Data: { TaskId: "vendor" } }
      if (action.endsWith("ModerationResult")) {
        if (mode === "pending") return { Code: 280 }
        return { Code: 200, Data: { RiskLevel: mode === "video_rejected" ? "high" : "none" } }
      }
      return {
        Code: 200,
        Data: {
          RiskLevel: mode === "rejected" ? "high" : mode === "unknown" ? "new_level" : "none",
          Result: [],
        },
      }
    })
  })
  afterAll(async () => {
    await app.close()
    jest.restoreAllMocks()
  })

  describe.each([
    {
      path: "/api/video-project/1/task",
      body: {
        category: "NORMAL",
        publicId: "model",
        params: { prompt: "普通内容", resolution: "720p", duration_seconds: 4 },
      },
    },
    {
      path: "/api/internal/generation/video-tasks",
      body: {
        phone: "credential-only",
        category: "NORMAL",
        request: { model: "model", prompt: "普通内容", resolution: "720p", duration_seconds: 4 },
      },
    },
  ])("真实任务创建 $path", ({ path, body }) => {
    it.each(["rejected", "unavailable", "unknown"])(
      "%s 时创建失败状态记录，SDK和外部报价均不调用",
      async outcome => {
        mode = outcome
        const res = await request(app.getHttpServer()).post(path).send(body)
        expect(res.status).toBe(201)
        expect(res.body.status).toBe("FAILED")
        expect(vendor).toHaveBeenCalled()
        expect(submit).not.toHaveBeenCalled()
        expect(estimate).not.toHaveBeenCalled()
        expect(JSON.stringify(vendor.mock.calls)).not.toContain("credential-only")
      }
    )
    it("全部通过才调用一次生成SDK", async () => {
      const res = await request(app.getHttpServer()).post(path).send(body)
      expect(res.status).toBe(201)
      expect(submit).toHaveBeenCalledTimes(1)
      expect(vendor.mock.calls.filter(([action]) => action === "TextModerationPlus")).toHaveLength(1)
      expect(vendor.mock.invocationCallOrder.at(-1)).toBeLessThan(
        submit.mock.invocationCallOrder[0]
      )
    })
  })

  it("视频待审时创建与前端轮询均不生成；通过后仅续跑一次", async () => {
    mode = "pending"
    await request(app.getHttpServer())
      .post("/api/video-project/1/task")
      .send({
        category: "NORMAL",
        publicId: "model",
        params: { prompt: "普通内容", reference_videos: [{ url: "https://assets.test/v.mp4" }] },
      })
      .expect(201)
    expect(videoTask.rows.get(1)?.status).toBe("WAITING_MODERATION")
    await request(app.getHttpServer()).get("/api/video-project/task/1").expect(200)
    await tasks.scan()
    expect(submit).not.toHaveBeenCalled()
    expect(estimate).not.toHaveBeenCalled()
    mode = "pass"
    await request(app.getHttpServer()).get("/api/video-project/task/1").expect(200)
    await request(app.getHttpServer()).get("/api/video-project/task/1").expect(200)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it("动作复刻批量入口的异步视频拒绝后不调用生成SDK", async () => {
    mode = "pending"
    const res = await request(app.getHttpServer())
      .post("/api/video-project/1/motion-control/batch")
      .send({
        prompt: "复刻动作",
        actionVideos: [{ url: "https://assets.test/action.mp4", name: "动作", durationSec: 4 }],
        targetImages: [{ url: "https://assets.test/target.png", name: "人物" }],
      })
      .expect(201)
    expect(res.body.tasks[0].status).toBe("WAITING_MODERATION")
    expect(submit).not.toHaveBeenCalled()
    mode = "video_rejected"
    const query = await request(app.getHttpServer()).get("/api/video-project/task/1").expect(200)
    expect(query.body.status).toBe("FAILED")
    await tasks.scan()
    expect(submit).not.toHaveBeenCalled()
    expect(estimate).not.toHaveBeenCalled()
  })

  it.each(["rejected", "unavailable", "unknown"])(
    "带货生成从数据库读取的脚本 %s 时不调用SDK",
    async outcome => {
      mode = outcome
      const res = await request(app.getHttpServer())
        .post("/api/video-project/sales/1/generate")
        .send({})
        .expect(201)
      expect(res.body.outputs[0].videos[0].status).toBe("FAILED")
      expect(vendor).toHaveBeenCalled()
      expect(submit).not.toHaveBeenCalled()
      expect(estimate).not.toHaveBeenCalled()
    }
  )

  it("带货脚本及参考图通过后才调用一次生成SDK", async () => {
    await request(app.getHttpServer())
      .post("/api/video-project/sales/1/generate")
      .send({})
      .expect(201)
    expect(vendor.mock.calls.some(([action]) => action === "ImageModeration")).toBe(true)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["VIDEO_TASK", videoTask],
    ["BEAUTY_TASK", beautyTask],
    ["STORYBOARD_VIDEO", storyboardVideo],
  ] as const)(
    "%s 的持久化输入拒绝后，公共查询和定时扫描均不能续跑",
    async (businessType, store) => {
      mode = "rejected"
      store.createRow()
      const res = await request(app.getHttpServer())
        .post("/api/content-moderation/check")
        .send({ businessType, businessTaskId: "1" })
        .expect(200)
      expect(res.body.moderationStatus).toBe("REJECTED")
      await request(app.getHttpServer())
        .get(`/api/content-moderation/tasks/${businessType}/1`)
        .expect(200)
      await tasks.scan()
      expect(vendor).toHaveBeenCalled()
      expect(submit).not.toHaveBeenCalled()
      expect(estimate).not.toHaveBeenCalled()
    }
  )

  it("异步视频返回风险后不能续跑，取消后的通过回执也不能生成", async () => {
    mode = "pending"
    videoTask.createRow({
      generationParams: {
        model: "model",
        prompt: "普通内容",
        reference_videos: [{ url: "https://assets.test/v.mp4" }],
      },
    })
    const url = "/api/content-moderation/tasks/VIDEO_TASK/1"
    await request(app.getHttpServer())
      .post("/api/content-moderation/check")
      .send({ businessType: "VIDEO_TASK", businessTaskId: "1" })
      .expect(202)
    mode = "video_rejected"
    const rejected = await request(app.getHttpServer()).get(url).expect(200)
    expect(rejected.body.moderationStatus).toBe("REJECTED")
    expect(submit).not.toHaveBeenCalled()
    videoTask.rows.clear()
    mode = "pending"
    videoTask.createRow({
      generationParams: {
        model: "model",
        prompt: "普通内容",
        reference_videos: [{ url: "https://assets.test/v.mp4" }],
      },
    })
    await request(app.getHttpServer())
      .post("/api/content-moderation/check")
      .send({ businessType: "VIDEO_TASK", businessTaskId: "1" })
      .expect(202)
    videoTask.rows.set(1, { ...videoTask.rows.get(1)!, status: "CANCELLED" })
    mode = "pass"
    await request(app.getHttpServer()).get(url).expect(200)
    await tasks.scan()
    expect(submit).not.toHaveBeenCalled()
  })
})
