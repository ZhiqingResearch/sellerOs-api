import { BadRequestException, NotFoundException } from "@nestjs/common"
import { ImageProjectService } from "../image-project/image-project.service"
import { LocalRedrawService, parseLocalRedrawForm } from "./local-redraw.service"

const urls = ["https://cdn.example.com/original.png", "https://cdn.example.com/marked.png"]
const prompt = "框1：移动文字，保留其他内容"
const localRedraw = {
  provider: "ZQ-Image-2",
  sourceWidth: 3000,
  sourceHeight: 2000,
  generationWidth: 1536,
  generationHeight: 1024,
}
function setup(type = "GENERAL") {
  const project = { id: 41, type, status: "DRAFT" }
  const prisma = {
    imageProject: { findFirst: jest.fn().mockResolvedValue(project) },
    generatedImage: {
      findFirst: jest.fn().mockResolvedValue({
        id: 23,
        url: urls[0],
        task: {
          projectId: 41,
          type,
          project,
          promptConfig: {
            creation_type: "FOUR_VIEW_CHARACTER",
            modules: { character: "保持角色" },
          },
          viewConfig: { view: "front" },
          presetOption: "FOUR_VIEW_CHARACTER",
        },
      }),
    },
    imageGenItem: { findFirst: jest.fn().mockResolvedValue(null) },
  }
  const generate = {
    create: jest.fn().mockResolvedValue({
      ok: true,
      taskId: 71,
      generatedImages: [{ id: 72, order: 0, status: "GENERATING" }],
      localRedraw,
    }),
  }
  const i2i = {
    create: jest.fn().mockResolvedValue({
      ok: true,
      jobId: "job-1",
      taskId: "job-1",
      total: 1,
      items: [],
      localRedraw,
    }),
  }
  return {
    prisma,
    generate,
    i2i,
    service: new LocalRedrawService(prisma as never, generate as never, i2i as never),
  }
}

describe("统一重绘入口", () => {
  afterEach(() => jest.restoreAllMocks())
  it.each([
    null,
    "[]",
    "bad",
    { prompt: " " },
    { prompt, provider: "ZQ-Image-3" },
    { prompt, sourceImageId: "23" },
    { prompt, count: 5 },
    { prompt, mainImageUrls: ["[url](https://example.com)"] },
  ])("拒绝非法参数 %j", raw => {
    expect(() => parseLocalRedrawForm(raw)).toThrow(BadRequestException)
  })
  it.each(["GENERAL", "ECOMMERCE", "FACTORY"])(
    "%s 项目沿用任务保存并强制启用共享规则",
    async type => {
      const { service, generate, i2i } = setup(type)
      const response = await service.create(
        { projectId: 41, prompt, mainImageUrls: urls },
        {},
        7,
        "platform"
      )
      expect(response).toMatchObject({ taskId: 71, localRedraw })
      const form = JSON.parse(generate.create.mock.calls[0][0].form as string)
      expect(form).toMatchObject({
        projectId: "41",
        mode: "image-creation",
        editMode: "local-redraw",
        provider: "ZQ-Image-2",
        count: 1,
        prompt,
        mainImageUrls: urls,
      })
      expect(i2i.create).not.toHaveBeenCalled()
    }
  )
  it("人像原图保留原项目、配置、视图，调用同一生成服务", async () => {
    const { service, prisma, generate } = setup("PORTRAIT")
    await service.create(
      { sourceImageId: 23, prompt, mainImageUrls: [urls[1]] },
      {},
      7,
      "vidflowos"
    )
    expect(prisma.generatedImage.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 23,
      source: "vidflowos",
      task: { userId: 7, source: "vidflowos" },
    })
    const [input, userId, source] = generate.create.mock.calls[0]
    expect(input.portrait).toMatchObject({
      promptConfig: { creation_type: "FOUR_VIEW_CHARACTER", modules: { character: "保持角色" } },
      viewConfig: { view: "front" },
      presetOption: "FOUR_VIEW_CHARACTER",
    })
    expect(JSON.parse(input.form as string).mainImageUrls).toEqual(urls)
    expect([userId, source]).toEqual([7, "vidflowos"])
  })
  it.each(["GENERAL", "PORTRAIT", "ECOMMERCE"])("%s 来源记录为 4K 时传入可信后端档位", async type => {
    const { service, prisma, generate } = setup(type)
    const image = await prisma.generatedImage.findFirst()
    prisma.generatedImage.findFirst.mockResolvedValue({
      ...image, task: { ...image.task, executionSpec: { form: { resolutionTier: "4K" } } },
    } as never)
    await service.create({ sourceImageId: 23, prompt, mainImageUrls: [urls[1]] }, {}, 7, "platform")
    expect(generate.create.mock.calls[0][0].localRedrawResolutionTier).toBe("4K")
  })

  it("未归档 URL 原图按用户和来源读取 Job 档位，忽略页面参数", async () => {
    const { service, prisma, i2i } = setup()
    prisma.generatedImage.findFirst.mockResolvedValue(null as never)
    prisma.imageGenItem.findFirst.mockResolvedValue({ job: { request: { resolutionTier: "4K" } } } as never)
    jest.spyOn(global, "fetch").mockImplementation(async url => new Response(String(url)))
    await service.create({ prompt, mainImageUrls: urls }, {}, 7, "vidflowos")
    expect(prisma.imageGenItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ url: urls[0], job: { userId: 7, source: "vidflowos", businessType: "IMAGE_CREATIVE" } }),
    }))
    expect(i2i.create.mock.calls[0][0].localRedrawResolutionTier).toBe("4K")
  })
  it("人像不能仅传项目绕过原图归属校验", async () => {
    const { service, generate } = setup("PORTRAIT")
    await expect(
      service.create({ projectId: 41, prompt, mainImageUrls: urls }, {}, 7, "platform")
    ).rejects.toThrow("sourceImageId")
    expect(generate.create).not.toHaveBeenCalled()
  })
  it("原图必须属于当前用户、来源、未删除的成功席位，项目不能错配", async () => {
    const { service, prisma, generate } = setup()
    await expect(
      service.create(
        { projectId: 42, sourceImageId: 23, prompt, mainImageUrls: [urls[1]] },
        {},
        7,
        "platform"
      )
    ).rejects.toThrow("不属于指定项目")
    prisma.generatedImage.findFirst.mockResolvedValueOnce(null)
    await expect(
      service.create({ sourceImageId: 23, prompt, mainImageUrls: [urls[1]] }, {}, 7, "platform")
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(generate.create).not.toHaveBeenCalled()
  })
  it("未归档的文件改图沿用 job，不创建项目任务", async () => {
    const { service, i2i, generate } = setup()
    const original = {
      fieldname: "main",
      buffer: Buffer.from("original"),
      mimetype: "image/png",
      size: 8,
    }
    const annotated = { ...original, fieldname: "refs", buffer: Buffer.from("marked") }
    await expect(
      service.create({ prompt }, { main: [original], refs: [annotated] }, 7, "platform")
    ).resolves.toMatchObject({ jobId: "job-1", localRedraw })
    const [input, uid, source] = i2i.create.mock.calls[0]
    expect(JSON.parse(input.form as string)).toMatchObject({
      mode: "normal",
      editMode: "local-redraw",
      provider: "ZQ-Image-2",
      count: 1,
    })
    expect(input.files).toEqual({ main: [original], refs: [annotated] })
    expect([uid, source]).toEqual([7, "platform"])
    expect(generate.create).not.toHaveBeenCalled()
  })
  it("未归档 URL 改图按原顺序转字节供现有 job 管线使用", async () => {
    jest
      .spyOn(global, "fetch")
      .mockImplementation(
        async url => new Response(String(url), { headers: { "content-type": "image/png" } })
      )
    const { service, i2i } = setup()
    await service.create({ prompt, mainImageUrls: urls }, {}, 7, "platform")
    const input = i2i.create.mock.calls[0][0]
    expect(input.files.main[0].buffer.toString()).toBe(urls[0])
    expect(input.files.refs[0].buffer.toString()).toBe(urls[1])
  })
  it("重绘生成错误按原状态返回，不返回成功结果", async () => {
    const { service, generate } = setup()
    generate.create.mockResolvedValueOnce({ ok: false, status: 400, error: "尺寸不支持" })
    await expect(
      service.create({ projectId: 41, prompt, mainImageUrls: urls }, {}, 7, "platform")
    ).rejects.toThrow("尺寸不支持")
  })
})

it("人像局部重绘的执行规格与任务原子写入，普通人像入口仍被拒绝", async () => {
  const tx = {
    generationTask: { create: jest.fn().mockResolvedValue({ id: 71 }) },
    imageProject: { updateMany: jest.fn() },
  }
  const prisma = {
    imageProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7, type: "PORTRAIT" }) },
    $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  }
  const service = new ImageProjectService(prisma as never, {} as never)
  const dto = { model: "ZQ-Image-2", prompt, status: "GENERATING", n: 1 }
  const context = {
    executionSpec: { kind: "IMAGE_CREATIVE_GENERATE", localRedraw },
    deadlineAt: new Date(),
    portrait: {
      promptConfig: { creation_type: "SINGLE_PORTRAIT" },
      viewConfig: { view: "front" },
      presetOption: "SINGLE_PORTRAIT",
    },
  }
  await service.createTask(41, dto as never, 7, "platform", context)
  expect(tx.generationTask.create.mock.calls[0][0].data).toMatchObject({
    type: "PORTRAIT",
    model: "ZQ-Image-2",
    executionSpec: context.executionSpec,
    deadlineAt: context.deadlineAt,
    promptConfig: context.portrait.promptConfig,
    viewConfig: context.portrait.viewConfig,
  })
  await expect(service.createTask(41, dto as never, 7)).rejects.toThrow("人像生成任务接口")
})

it("已有 job 的公开归档模型和比例取实际重绘快照", async () => {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    generationTask: { create: jest.fn().mockResolvedValue({ id: 71 }) },
    imageGenJob: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ id: "job-1", taskId: null, model: "ZQ-Image-2", request: { localRedraw }, items: [{ id: 1, url: "https://cdn.example.com/result.png", status: "SUCCEEDED", gatewayImage: { width: 1440, height: 1080 } }] }),
    },
  }
  const prisma = {
    imageProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7, type: "GENERAL" }) },
    imageGenJob: {
      findFirst: jest.fn().mockResolvedValue({
        request: { localRedraw },
        items: [
          {
            url: "https://cdn.example.com/result.png",
            gatewayImage: { width: 1440, height: 1080 },
          },
        ],
      }),
    },
    $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  }
  const service = new ImageProjectService(prisma as never, {} as never)
  await service.createTask(
    41,
    {
      sourceJobId: "job-1",
      model: "ZQ-Image-3",
      generatedImages: [{ status: "SUCCESS", url: "https://cdn.example.com/result.png" }],
    } as never,
    7
  )
  expect(tx.generationTask.create.mock.calls[0][0].data).toMatchObject({
    model: "ZQ-Image-2",
    aspectRatio: "1440:1080",
    generatedImages: { create: [expect.objectContaining({ width: 1440, height: 1080 })] },
    sourceJobId: "job-1",
  })
})

import { GenerationTaskRunnerService } from "./executor/generation-task-runner.service"

it.each(["SUCCESS", "CANCELLED", "TIMEOUT"])(
  "人像重绘终态 %s 后按现有规则恢复项目状态",
  async status => {
    const prisma = {
      generationTask: {
        findUnique: jest.fn().mockResolvedValue({
          id: 71,
          projectId: 41,
          userId: 7,
          type: "PORTRAIT",
          status,
          executionSpec: { localRedraw, provider: "ZQ-Image-2" },
          generatedImages: [{ status: status === "SUCCESS" ? "SUCCESS" : "FAILED" }],
        }),
        count: jest.fn().mockResolvedValue(0),
      },
      generatedImage: { count: jest.fn().mockResolvedValue(1) },
      imageProject: { updateMany: jest.fn() },
    }
    const usage = { gatewayFixedImageCredits: jest.fn().mockResolvedValue(null) }
    const runner = new GenerationTaskRunnerService(
      prisma as never,
      (() => ({})) as never,
      usage as never
    )
    await runner.aggregateTask(71)
    expect(prisma.imageProject.updateMany).toHaveBeenCalledWith({
      where: { id: 41, status: { not: "ARCHIVED" }, deletedAt: null },
      data: { status: "COMPLETED" },
    })
  }
)

import { GenerateService } from "./generate.service"

it("人像重绘失败重试沿用冻结规格，并恢复原项目生成中状态", async () => {
  const task = {
    id: 71,
    userId: 7,
    projectId: 41,
    type: "PORTRAIT",
    executionSpec: { localRedraw, provider: "ZQ-Image-2" },
    generatedImages: [{ id: 72, order: 0, status: "FAILED" }],
  }
  const prisma = {
    generationTask: {
      findUnique: jest.fn().mockResolvedValue(task),
      update: jest.fn().mockResolvedValue({}),
    },
    generatedImage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    imageProject: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
  }
  const queue = { enqueue: jest.fn() }
  const service = new GenerateService(
    prisma as never,
    {} as never,
    queue as never,
    {} as never,
    {} as never,
    {} as never
  )
  await expect(service.retryTaskImages(71, 7)).resolves.toMatchObject({
    ok: true,
    generatedImages: [{ id: 72, order: 0, status: "GENERATING" }],
  })
  expect(prisma.imageProject.updateMany).toHaveBeenCalledWith({
    where: { id: 41, status: { not: "ARCHIVED" }, deletedAt: null },
    data: { status: "GENERATING" },
  })
  expect(prisma.generationTask.update.mock.calls[0][0].data.executionSpec).toBeUndefined()
  expect(queue.enqueue).toHaveBeenCalledTimes(1)
})
