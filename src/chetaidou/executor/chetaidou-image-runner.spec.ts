import sharp from "sharp"
import { planChetaidouImage } from "../chetaidou-image-options.service"
import { ChetaidouStorageService, OriginalImageAsset } from "../chetaidou-storage.service"
import { ChetaidouImageRunnerService } from "./chetaidou-image-runner.service"

describe("车泰斗生图请求冻结与准备失败", () => {
  function setup(snapshot: unknown) {
    const db = {
      $transaction: jest.fn(),
      chetaidouCall: {
        findUnique: jest.fn().mockResolvedValue({ id: "call", state: "PREPARED" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      imageGenItem: { update: jest.fn() },
    }
    db.$transaction.mockImplementation((fn: (tx: typeof db) => Promise<void>) => fn(db))
    const gateway = {
      createImageTask: jest
        .fn<Promise<{ id: string }>, [Record<string, unknown>, string]>()
        .mockResolvedValue({ id: "gateway-task" }),
    }
    const storage = {
      signForModel: jest.fn().mockResolvedValue("https://signed.example.com/image.png"),
    }
    const service = new ChetaidouImageRunnerService(
      db as any,
      gateway as any,
      {} as any,
      {} as any,
      storage as any
    )
    jest.spyOn(service as any, "waitTerminal").mockResolvedValue({
      status: "succeeded",
      result: { images: [{ url: "https://result.example.com/image.png" }] },
    })
    const deliver = jest.spyOn(service as any, "deliverArtifact").mockResolvedValue(undefined)
    const fail = jest.spyOn(service, "aggregateJob").mockResolvedValue(undefined)
    const ctx = {
      callId: "call",
      taskId: "task",
      itemId: 1,
      job: { id: "job" },
      snapshot,
      request: { prompt: "Frozen prompt", sourceFileKey: "source" },
      deadlineAt: new Date(Date.now() + 1000),
      previousGatewayTaskId: null,
    }
    return { service, db, gateway, storage, ctx, deliver, fail }
  }
  it("使用冻结的模型、提示词和 sizing，新任务不受 quality env 影响", async () => {
    const previous = process.env.CHETAIDOU_IMAGE_QUALITY
    process.env.CHETAIDOU_IMAGE_QUALITY = "high"
    try {
      const { service, ctx, gateway, deliver } = setup({
        models: { image: { publicId: "frozen-model" } },
        generation: {
          providerApplied: { aspect_ratio: "16:9", resolution: "2k" },
          providerDefaults: {},
        },
      })
      await service["submitAndWait"](ctx as any)
      expect(gateway.createImageTask).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "frozen-model",
          prompt: "Frozen prompt",
          operation: "edit",
          n: 1,
          aspect_ratio: "16:9",
          resolution: "2k",
          callback: true,
        }),
        "chetaidou:call:call"
      )
      expect(gateway.createImageTask.mock.calls[0][0]).not.toHaveProperty("quality")
      expect(deliver).toHaveBeenCalledTimes(1)
    } finally {
      if (previous === undefined) delete process.env.CHETAIDOU_IMAGE_QUALITY
      else process.env.CHETAIDOU_IMAGE_QUALITY = previous
    }
  })
  it("局部重绘保留干净成品、标注和参考的顺序，恢复使用持久引用重新签名", async () => {
    const { service, ctx, gateway, storage } = setup({
      models: { image: { publicId: "frozen-edit-model" } },
      generation: { providerApplied: { size: "1536x2048" } },
      edit: { sourceResultId: 310 },
    })
    storage.signForModel.mockImplementation(async key => `https://signed.example.com/${key}`)
    Object.assign(ctx.request, { sourceFileKey: "result", referenceFileKeys: ["annotated", "reference"] })
    await service["submitAndWait"](ctx as any)
    expect(gateway.createImageTask.mock.calls[0][0]).toMatchObject({
      operation: "edit", size: "1536x2048", reference_images: [
        { url: "https://signed.example.com/result" }, { url: "https://signed.example.com/annotated" }, { url: "https://signed.example.com/reference" },
      ],
    })
  })
  it("旧任务按冻结质量和母版比例执行", async () => {
    const { service, ctx, gateway } = setup({
      image: { width: 800, height: 1000 },
      models: { image: { publicId: "legacy-model" } },
      generation: { quality: "standard", resolution: "1k" },
    })
    await service["submitAndWait"](ctx as any)
    expect(gateway.createImageTask).toHaveBeenCalledWith(
      expect.objectContaining({ quality: "standard", aspect_ratio: "800:1000", resolution: "1k" }),
      expect.any(String)
    )
  })
  it.each(["standard", "hd"])("提交冻结质量 %s，优先于默认值与旧 Job 字段", async quality => {
    const { service, ctx, gateway } = setup({
      models: { image: { publicId: "gpt-image-2.5-sunburst" } },
      generation: {
        quality,
        providerApplied: { aspect_ratio: "16:9", resolution: "2k" },
        providerDefaults: { quality: "standard" },
      },
    })
    Object.assign(ctx.request, { quality: "high" })
    await service["submitAndWait"](ctx as any)
    expect(gateway.createImageTask).toHaveBeenCalledWith(
      expect.objectContaining({ quality, aspect_ratio: "16:9", resolution: "2k" }),
      "chetaidou:call:call"
    )
  })
  it("签名失败尚未请求供应商，标记可重试失败及免费，不标 UNKNOWN", async () => {
    const { service, ctx, gateway, storage, db, fail } = setup({})
    storage.signForModel.mockRejectedValue(new Error("签名失败"))
    await service["submitAndWait"](ctx as any)
    expect(gateway.createImageTask).not.toHaveBeenCalled()
    expect(db.chetaidouCall.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "call", state: "PREPARED" },
        data: expect.objectContaining({ state: "FINISHED", billingStatus: "FREE" }) as unknown,
      })
    )
    expect(fail).toHaveBeenCalledTimes(1)
  })
  it.each(["none", "original", "output", "previous"])("双份保存及恢复（%s）", async failure => {
    const bytes = await sharp({
      create: { width: 1536, height: 2048, channels: 3, background: "white" },
    })
      .png()
      .toBuffer()
    const item: { id: number; gatewayImage: { original: Partial<OriginalImageAsset> } | null } = {
      id: 1,
      gatewayImage: null,
    }
    if (failure === "previous") {
      item.gatewayImage = { original: { callId: "old-call", fileKey: "old/original.png" } }
    }
    const call = {
      id: "call",
      ownerId: 7,
      model: "gpt-image-2.5-sunburst",
      taskId: "task",
      rootTaskId: "task",
      billingStatus: "PENDING",
      gatewayTaskId: "gateway-task",
    }
    const db = {
      $transaction: jest.fn(),
      $queryRaw: jest.fn(),
      imageGenJob: { findUnique: jest.fn().mockResolvedValue({ id: "job" }) },
      chetaidouCall: {
        findUnique: jest.fn().mockResolvedValue(call),
        update: jest.fn(({ data }: { data: Partial<typeof call> }) =>
          Promise.resolve(Object.assign(call, data))
        ),
      },
      imageGenItem: {
        findUnique: jest.fn().mockResolvedValue(item),
        update: jest.fn(({ data }: { data: Partial<typeof item> }) =>
          Promise.resolve(Object.assign(item, data))
        ),
      },
    }
    db.$transaction.mockImplementation((fn: (tx: typeof db) => Promise<void>) => fn(db))
    const billing = { settleImageInTx: jest.fn() }
    const storage = {
      validateImage: jest.fn((buffer: Buffer) =>
        ChetaidouStorageService.prototype.validateImage(buffer)
      ),
      artifactFileKey: jest.fn(
        (id: string, ext: string, variant = "output") => `chetaidou/${id}/${variant}.${ext}`
      ),
      signDownload: jest.fn().mockResolvedValue("https://stored.example.com/original.png"),
      hostArtifact: jest.fn<Promise<void>, [Buffer, string, string]>().mockResolvedValue(undefined),
    }
    const gateway = { createImageTask: jest.fn(), getImageTask: jest.fn() }
    const service = new ChetaidouImageRunnerService(
      db as any,
      gateway as any,
      {} as any,
      billing as any,
      storage as any
    )
    const download = jest.spyOn(service as any, "downloadArtifact").mockResolvedValue(bytes)
    jest.spyOn(service, "aggregateJob").mockResolvedValue(undefined)
    const generation = planChetaidouImage(
      {
        publicId: "gpt-image-2.5-sunburst",
        gatewayConfig: { requestSchema: { request_schema: { type: "object", properties: {} } } },
      },
      { aspectRatio: "2:3", resolutionTier: "4K" },
      1
    )
    const ctx = {
      callId: "call",
      job: { id: "job", businessTaskId: "task" },
      itemId: 1,
      snapshot: { models: { image: { publicId: "gpt-image-2.5-sunburst" } }, generation },
    }
    const terminal = {
      status: "succeeded",
      usage: { amount: "0.10" },
      result: { images: [{ url: "https://artifact.example.com/image.png" }] },
    }
    const deliver = () =>
      service["deliverArtifact"](
        ctx as any,
        terminal as any,
        "https://artifact.example.com/image.png"
      )
    if (failure === "original" || failure === "output") {
      if (failure === "output") storage.hostArtifact.mockResolvedValueOnce(undefined)
      storage.hostArtifact.mockRejectedValueOnce(new Error("OSS 暂不可用"))
      await deliver()
      expect(billing.settleImageInTx).not.toHaveBeenCalled()
      expect(db.imageGenItem.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          status: "DELIVERY_PENDING",
          errorCode: "DELIVERY_PENDING",
          errorMessage: "产物转存失败：OSS 暂不可用",
        },
      })
      if (failure === "output") {
        expect(item.gatewayImage?.original).toMatchObject({
          callId: "call",
          fileKey: "chetaidou/call/original.png",
          width: 1536,
          height: 2048,
          mime: "image/png",
        })
        download.mockImplementation((url: string) => {
          return url === "https://stored.example.com/original.png"
            ? Promise.resolve(bytes)
            : Promise.reject(new Error("网关链接已过期"))
        })
      }
    }
    if (failure === "output") {
      await service["submitAndWait"]({
        ...ctx,
        taskId: "task",
        request: {},
        deadlineAt: new Date(Date.now() + 1000),
      } as any)
    } else {
      await deliver()
    }
    expect(billing.settleImageInTx).toHaveBeenCalledTimes(1)
    const originalUpload = storage.hostArtifact.mock.calls.find(upload =>
      upload[1].endsWith("original.png")
    )!
    expect(originalUpload[0].equals(bytes)).toBe(true)
    expect(originalUpload.slice(1)).toEqual(["chetaidou/call/original.png", "image/png"])
    expect(storage.hostArtifact).toHaveBeenCalledWith(
      expect.any(Buffer),
      "chetaidou/call/output.jpg",
      "image/jpeg"
    )
    expect(db.imageGenItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUCCEEDED",
          width: 1365,
          height: 2048,
          mime: "image/jpeg",
          gatewayImage: expect.objectContaining({
            adaptation: "CROP_ONLY",
            nativeWidth: 1536,
            original: {
              callId: "call",
              fileKey: "chetaidou/call/original.png",
              width: 1536,
              height: 2048,
              mime: "image/png",
            },
          }) as unknown,
        }) as unknown,
      })
    )
    expect(billing.settleImageInTx).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: "call", model: "gpt-image-2.5-sunburst" }),
      expect.anything(),
      true
    )
    expect(gateway.createImageTask).not.toHaveBeenCalled()
    if (failure === "output") {
      expect(storage.signDownload).toHaveBeenCalledWith("chetaidou/call/original.png")
      expect(
        storage.hostArtifact.mock.calls.filter(upload => upload[1].endsWith("original.png"))
      ).toHaveLength(1)
      expect(gateway.getImageTask).not.toHaveBeenCalled()
    }
  })
})
