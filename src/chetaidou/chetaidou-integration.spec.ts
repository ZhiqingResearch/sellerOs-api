import { PERMISSIONS_METADATA_KEY } from "../auth/decorators/require-permissions.decorator"
import { hasPermission } from "../auth/guards/permissions.guard"
import { ChetaidouAdminService } from "./chetaidou-admin.service"
import {
  ChetaidouImageOptionsService,
  generationCanvasPrompt,
} from "./chetaidou-image-options.service"
import { ChetaidouController } from "./chetaidou.controller"
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
// 测试事务存储刻意使用动态 Prisma mock；生产代码不放宽类型规则。
import { BadRequestException, ConflictException, GatewayTimeoutException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { randomUUID } from "crypto"
import { PrismaService } from "../prisma/prisma.service"
import { ChetaidouBillingService } from "./chetaidou-billing.service"
import { ChetaidouContextService } from "./chetaidou-context.service"
import { applyDivergeOutput, normalizeCustomDimensions } from "./chetaidou-draft"
import { productHardConstraints } from "./chetaidou-product-constraints"
import { ChetaidouStorageService, stableHash } from "./chetaidou-storage.service"
import { identifySchemaOf } from "./chetaidou.schemas"
import { ChetaidouService, defaultSettings } from "./chetaidou.service"
import {
  ChetaidouTaskRunnerService,
  UnknownCallError,
} from "./executor/chetaidou-task-runner.service"

/** Small transactional store: exercises public operations across persisted reloads, no gateway calls. */
function store() {
  const tasks: any[] = []
  const groups: any[] = []
  const adjustments: any[] = []
  const draft: any = {
    id: 1,
    ownerId: 7,
    imageId: 19,
    revision: 0,
    settings: defaultSettings(),
    selections: [],
    customDimensions: [],
    activeGroupRefs: [],
    activeIdeationTaskId: null,
    activeCompositionTaskId: null,
    pendingRefreshTaskId: null,
  }
  const image = {
    id: 19,
    skuId: 1,
    enabled: true,
    sourceType: "PRESET",
    checksum: "image",
    fileKey: "image.png",
    currentBreakdownId: 1,
    title: "母版",
    number: "7",
  }
  const fact = { id: 1, version: 1, contentHash: "fact", content: {} }
  const breakdown = {
    id: 1,
    imageId: 19,
    version: 1,
    qualityStatus: "CONFIRMED",
    contentHash: "breakdown",
    payload: {
      hasPeople: false,
      textInventory: [],
      basketContents: { hasItems: false, items: [], evidence: "" },
    },
  }
  function match(row: any, where: any = {}): boolean {
    return Object.entries(where).every(([key, value]: [string, any]) => {
      if (value === undefined) return true
      if (key === "ownerId_imageId") return match(row, value)
      if (value && typeof value === "object") {
        if ("in" in value) return value.in.includes(row[key])
        if ("notIn" in value) return !value.notIn.includes(row[key])
        if ("not" in value) return row[key] !== value.not
      }
      return row[key] === value
    })
  }
  function update(row: any, data: any) {
    for (const [key, value] of Object.entries(data) as any) {
      if (value === undefined) continue
      row[key] =
        value && typeof value === "object" && "increment" in value
          ? row[key] + value.increment
          : value
    }
    row.updatedAt = new Date()
    return structuredClone(row)
  }
  function table(rows: any[], defaults: Record<string, unknown> = {}) {
    const api: any = {
      findUnique: jest.fn(async ({ where }) =>
        structuredClone(rows.find(r => match(r, where)) ?? null)
      ),
      findUniqueOrThrow: jest.fn(async ({ where }) => {
        const row = rows.find(r => match(r, where))
        if (!row) throw Error("missing")
        return structuredClone(row)
      }),
      findFirst: jest.fn(async ({ where }) =>
        structuredClone(rows.find(r => match(r, where)) ?? null)
      ),
      findMany: jest.fn(async ({ where = {}, orderBy }: any = {}) => {
        const list = rows.filter(r => match(r, where))
        return structuredClone(Array.isArray(orderBy) ? [...list].reverse() : list)
      }),
      count: jest.fn(async ({ where }: any) => rows.filter(r => match(r, where)).length),
      update: jest.fn(async ({ where, data }) =>
        update(
          rows.find(r => match(r, where)),
          data
        )
      ),
      updateMany: jest.fn(async ({ where, data }) => {
        const matched = rows.filter(r => match(r, where))
        matched.forEach(r => update(r, data))
        return { count: matched.length }
      }),
      createMany: jest.fn(async ({ data }) => {
        rows.push(
          ...data.map((row: any) => ({ createdAt: new Date(), updatedAt: new Date(), ...row }))
        )
        return { count: data.length }
      }),
      create: jest.fn(async ({ data }) => {
        const row = {
          createdAt: new Date(),
          updatedAt: new Date(),
          operation: "PRIMARY",
          output: null,
          ...defaults,
          ...data,
        }
        if (data.items?.create)
          row.items = data.items.create.map((item: any, idx: number) => ({
            id: idx + 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...item,
          }))
        rows.push(row)
        return structuredClone(row)
      }),
    }
    return api
  }
  const db: any = {
    aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
    chetaidouAdjustment: table(adjustments, { revision: 0, schemaVersion: 1 }),
    chetaidouTask: table(tasks),
    chetaidouGroup: table(groups),
    chetaidouDraft: table([draft]),
    chetaidouImage: table([image]),
    chetaidouFactCard: table([fact]),
    chetaidouBreakdown: table([breakdown]),
    chetaidouSku: table([{ id: 1, enabled: true, currentFactId: 1 }]),
    chetaidouCall: table([]),
    imageGenJob: table([]),
    imageGenItem: table([]),
    $queryRaw: jest.fn().mockResolvedValue([]),
  }
  db.$transaction = jest.fn(async (fn: any) => {
    if (Array.isArray(fn)) return Promise.all(fn)
    const before = structuredClone({ tasks, groups, draft, adjustments })
    try {
      return await fn(db)
    } catch (error) {
      tasks.splice(0, tasks.length, ...before.tasks)
      adjustments.splice(0, adjustments.length, ...before.adjustments)
      groups.splice(0, groups.length, ...before.groups)
      Object.assign(draft, before.draft)
      throw error
    }
  })
  return { db, tasks, groups, adjustments, draft, image, fact, breakdown }
}

const conflict = {
  id: "c1",
  questionVersion: 1,
  question: "保留哪种背景？",
  reason: "两种选择不兼容",
  sources: ["background"],
  blocking: false,
  choices: [{ id: "keep", label: "保留", instruction: "Keep the background" }],
}
const composeOutput = (ready: boolean) => ({
  status: ready ? "ready" : "needs_resolution",
  summaryCn: "修改背景",
  editPromptEn: ready ? "Keep the original background." : "",
  coveredSelectionIds: [],
  changedFeatures: [],
  preservedFeatures: [],
  textReplacements: [],
  copyAdditions: [],
  conflicts: ready
    ? []
    : [Object.fromEntries(Object.entries(conflict).filter(([key]) => key !== "questionVersion"))],
  acknowledgedAnswerIds: [],
})

describe("车泰斗联调回归", () => {
  let state: ReturnType<typeof store>
  let service: ChetaidouService
  let context: ChetaidouContextService
  let billing: any
  beforeEach(async () => {
    state = store()
    context = new ChetaidouContextService(state.db)
    jest.spyOn(context, "resolveModels").mockResolvedValue({
      text: { publicId: "text", category: "TEXT" },
      image: { publicId: "image", category: "IMAGE" },
    })
    billing = { assertModelsReady: jest.fn(() => context.resolveModels()) }
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChetaidouService,
        {
          provide: ChetaidouImageOptionsService,
          useValue: {
            fetchCapabilities: jest.fn().mockResolvedValue({
              requestSchema: { version: 1, request_schema: { type: "object", properties: {} } },
            }),
            resolveModel: jest.fn().mockResolvedValue({
              publicId: "image",
              gatewayConfig: {
                requestSchema: { version: 1, request_schema: { type: "object", properties: {} } },
              },
            }),
            assertUnchanged: jest.fn(),
          },
        },
        { provide: PrismaService, useValue: state.db },
        { provide: ChetaidouContextService, useValue: context },
        { provide: ChetaidouBillingService, useValue: billing },
        {
          provide: ChetaidouStorageService,
          useValue: {
            signDownload: jest.fn().mockResolvedValue("signed"),
            thumbnailUrl: jest.fn().mockResolvedValue("signed"),
          },
        },
      ],
    }).compile()
    service = moduleRef.get(ChetaidouService)
  })
  async function compose() {
    const result = await service.createTask(7, {
      type: "COMPOSE",
      imageId: 19,
      idempotencyKey: "compose",
      draftRevision: state.draft.revision,
    })
    return state.tasks.find(t => t.id === (result as any).taskId)
  }
  function composeRunner(outputs: unknown[]) {
    const runner: any = new ChetaidouTaskRunnerService(state.db, {} as never, billing, {} as never)
    const call = jest.spyOn(runner, "callLlm")
    for (const output of outputs) {
      if (output instanceof Error) call.mockRejectedValueOnce(output)
      else call.mockResolvedValueOnce(typeof output === "string" ? output : JSON.stringify(output))
    }
    jest
      .spyOn(runner, "settleAndApply")
      .mockImplementation(async (_id: any, _model: any, apply: any) => apply(state.db))
    return runner
  }
  async function executeCompose(task: any, ready: boolean) {
    const runner = composeRunner([composeOutput(ready)])
    await runner.runCompose(task)
    return runner
  }

  it.each(["qwen3.8-max", "database-replacement"].flatMap(model =>
    ["upload", "rebreak", "admin", "retry"].map(entry => [entry, model])
  ))(
    "新拆解读取独立分类默认模型，忽略联想默认和草稿选择且保留旧调用：%s %s",
    async (entry, model) => {
      jest.mocked(context.resolveModels).mockRestore()
      state.db.aiGatewayModel.findMany.mockImplementation(async ({ where }) => {
        const publicId = where.modality === "IMAGE" ? "image"
          : where.category === "CHETAIDOU_BREAKDOWN" ? model : "ideation-model"
        return where.publicId && where.publicId !== publicId
          ? [] : [{ publicId, category: where.category }]
      })
      state.draft.settings.model = "ZQ-Multimodal-Gemini-3.5-Flash-Lite"
      let taskId: string
      if (entry === "upload") {
        state.db.chetaidouImage.create.mockResolvedValue(state.image)
        state.db.chetaidouDraft.upsert = jest.fn()
        const created = await service.createBreakdownInTransaction({
          userId: 7,
          skuId: 1,
          sourceType: "USER_UPLOAD",
          ownerId: 7,
          title: "上传图",
          fileKey: "image.png",
          asset: { mime: "image/png", width: 100, height: 100, checksum: "image" },
          factId: 1,
          idempotencyKey: "upload-database-model",
          requestHash: "upload",
          createdBy: 7,
        })
        taskId = created.taskId
      } else if (entry === "rebreak") {
        Object.assign(state.image, { sourceType: "USER_UPLOAD", ownerId: 7 })
        taskId = (await service.retryBreakdown(7, 19, "rebreak-database-model")).taskId
      } else if (entry === "admin") {
        const admin = new ChetaidouAdminService(state.db, {} as never, context, service)
        taskId = (await admin.rebreak(19, 7, "admin-database-model")).taskId
      } else {
        const draftModel = state.draft.settings.model
        delete state.draft.settings.model
        const root = await compose()
        state.draft.settings.model = draftModel
        Object.assign(root, { type: "BREAKDOWN", status: "FAILED" })
        root.snapshot.models.text.publicId = "ZQ-Multimodal-Gemini-3.5-Flash-Lite"
        const oldSnapshot = structuredClone(root.snapshot)
        await state.db.chetaidouCall.create({
          data: {
            id: "old-call",
            taskId: root.id,
            rootTaskId: root.id,
            state: "FINISHED",
            model: "old-model",
          },
        })
        taskId = (await service.retryTask(7, root.id, { idempotencyKey: "retry-database-model" }))
          .taskId
        expect(root.snapshot).toEqual(oldSnapshot)
        expect(
          await state.db.chetaidouCall.findUnique({ where: { id: "old-call" } })
        ).toMatchObject({
          model: "old-model",
        })
      }
      const task = state.tasks.find(t => t.id === taskId)
      expect(task.snapshot.models.text).toEqual({
        publicId: model,
        category: "CHETAIDOU_BREAKDOWN",
      })
      expect(task.snapshot.settings.model).toBe(model)
      expect(state.draft.settings.model).toBe("ZQ-Multimodal-Gemini-3.5-Flash-Lite")
      const completeMultimodal = jest.fn().mockResolvedValue({
        completion: { choices: [{ message: { content: "{}" } }] },
        requestId: "database-model-request",
      })
      const runner = new ChetaidouTaskRunnerService(
        state.db,
        { completeMultimodal } as never,
        billing,
        { signForModel: jest.fn().mockResolvedValue("https://example.com/image.png") } as never
      )
      await runner.execute(taskId)
      expect(completeMultimodal).toHaveBeenCalledWith(
        expect.objectContaining({ model }),
        undefined,
        true
      )
      expect(await state.db.chetaidouCall.findFirst({ where: { taskId } })).toMatchObject({
        model,
        category: "CHETAIDOU_BREAKDOWN",
      })
    }
  )

  it.each([false, true])("拆解传完整货篮契约，逐篮缺字段仍拒绝且免扣费：%s", async missing => {
    const task = await compose()
    task.type = "BREAKDOWN"
    Object.assign(state.image, { activeBreakdownTaskId: task.id })
    const baskets = [
      { id: "middle_left", position: "左车中篮", hasItems: null, evidence: "被遮挡", items: [] },
      {
        id: "middle_right",
        position: "右车中篮",
        hasItems: true,
        evidence: "可见柯基",
        items: ["柯基"],
      },
      {
        id: "rear_right",
        position: "右车后篮",
        hasItems: true,
        evidence: "可见植物",
        items: ["植物"],
      },
    ]
    const payload = {
      summary: "双车与宠物",
      hasPeople: false,
      persons: [],
      textInventory: [],
      softFeatures: { composition: "双车并行" },
      hardConstraints: [],
      conflicts: [],
      uncertainties: [],
      basketContents: { hasItems: true, evidence: "右车可见柯基和植物", items: ["柯基", "植物"] },
      baskets: missing ? baskets.map(({ id, position }) => ({ id, position })) : baskets,
      pets: [],
      props: [],
    }
    const completeMultimodal = jest.fn().mockResolvedValue({
      completion: { choices: [{ message: { content: JSON.stringify(payload) } }] },
      requestId: "breakdown-request",
    })
    billing.lookupTextUsage = jest.fn().mockResolvedValue(null)
    billing.settleTextInTx = jest.fn().mockResolvedValue("PENDING")
    const runner = new ChetaidouTaskRunnerService(
      state.db,
      { completeMultimodal } as never,
      billing,
      { signForModel: jest.fn().mockResolvedValue("https://example.com/image.png") } as never
    )
    await runner.execute(task.id)
    const request = completeMultimodal.mock.calls[0][0]
    const input = JSON.parse(request.messages[1].content[0].text)
    expect(input.facts).toEqual(task.snapshot.facts.content)
    expect(input.outputSchema.anyOf[0].properties.baskets.items.required).toEqual([
      "id",
      "position",
      "hasItems",
      "evidence",
      "items",
    ])
    const prompt = request.messages[0].content
    expect(prompt).toContain("输入 outputSchema 是本阶段完整的 JSON Schema")
    const example = JSON.parse(prompt.split("合法 JSON 结构样例：\n")[1].split("\n")[0])
    expect(example.baskets).toHaveLength(1)
    expect(example.baskets[0]).toMatchObject({
      hasItems: null,
      evidence: expect.any(String),
      items: [],
    })
    expect(prompt).toContain("逐一检查 baskets 数组的每一项")
    expect(completeMultimodal).toHaveBeenCalledTimes(1)
    if (missing) {
      expect(task.status).toBe("FAILED")
      expect(task.errorMessage).toContain("/baskets/0")
      expect(billing.settleTextInTx).not.toHaveBeenCalled()
      expect(await state.db.chetaidouCall.findFirst({ where: { taskId: task.id } })).toMatchObject({
        outcome: "INVALID",
        billingStatus: "FREE",
        chargedCredits: "0",
      })
      expect(await state.db.chetaidouBreakdown.count({ where: { imageId: 19 } })).toBe(1)
    } else {
      expect(task.status).toBe("SUCCEEDED")
      expect(billing.settleTextInTx).toHaveBeenCalledTimes(1)
      const versions = await state.db.chetaidouBreakdown.findMany({ where: { imageId: 19 } })
      expect(versions[1].payload.baskets).toEqual(baskets)
    }
  })

  it.each([
    { status: "REJECTED", reason: "图片只有办公人像，没有当前商品或相关素材线索" },
    { status: "REJECTED", reason: "" },
  ])("无关图或不合格拒绝结果不落拆解、不扣费：%j", async output => {
    const task = await compose()
    task.type = "BREAKDOWN"
    Object.assign(state.image, { activeBreakdownTaskId: task.id })
    const completeMultimodal = jest.fn().mockResolvedValue({
      completion: { choices: [{ message: { content: JSON.stringify(output) } }] },
      requestId: "unrelated-image-request",
    })
    billing.settleTextInTx = jest.fn()
    const runner = new ChetaidouTaskRunnerService(
      state.db,
      { completeMultimodal } as never,
      billing,
      { signForModel: jest.fn().mockResolvedValue("https://example.com/portrait.jpg") } as never
    )
    await runner.execute(task.id)
    expect(task).toMatchObject({
      status: "FAILED",
      errorCode: output.reason ? "IMAGE_UNRELATED_TO_SKU" : "MODEL_OUTPUT_INVALID",
      output: null,
    })
    expect(billing.settleTextInTx).not.toHaveBeenCalled()
    expect(await state.db.chetaidouBreakdown.count({ where: { imageId: 19 } })).toBe(1)
    expect(state.image.currentBreakdownId).toBe(1)
    expect(await state.db.chetaidouCall.findFirst({ where: { taskId: task.id } })).toMatchObject({
      outcome: "INVALID",
      billingStatus: "FREE",
      chargedCredits: "0",
      errorCode: output.reason ? "IMAGE_UNRELATED_TO_SKU" : "MODEL_OUTPUT_INVALID",
      errorMessage: output.reason || expect.any(String),
    })
    expect(completeMultimodal).toHaveBeenCalledTimes(1)
    if (output.reason) {
      const message = "上传图片明显与当前商品无关，请上传该商品的相关素材。"
      expect((await service.getTask(7, task.id)).errorMessage).toBe(message)
      expect((await service.tasksStatus(7, [task.id])).items[0].errorMessage).toBe(message)
      expect((await service.getImage(7, 19)).activeBreakdownTask?.errorMessage).toBe(message)
      expect((await service.listTasks(7, { page: 1, pageSize: 20 })).items[0].errorMessage).toBe(
        message
      )
    }
  })

  it.each(["局部部件图", "客服文字说明图", "概念示意图", "关联不确定的遮挡图"])(
    "允许无整车、无货篮的商品素材正常拆解：%s",
    async summary => {
      const task = await compose()
      task.type = "BREAKDOWN"
      Object.assign(state.image, { activeBreakdownTaskId: task.id })
      const payload = {
        summary,
        hasPeople: false,
        persons: [],
        textInventory: [],
        softFeatures: { composition: summary },
        hardConstraints: [],
        conflicts: [],
        uncertainties: summary.includes("不确定") ? ["商品结构被遮挡，关联无法确认"] : [],
        basketContents: { hasItems: null, evidence: "没有可识别货篮", items: [] },
        baskets: [],
        pets: [],
        props: [],
      }
      const completeMultimodal = jest.fn().mockResolvedValue({
        completion: { choices: [{ message: { content: JSON.stringify(payload) } }] },
        requestId: "related-material-request",
      })
      billing.lookupTextUsage = jest.fn().mockResolvedValue(null)
      billing.settleTextInTx = jest.fn().mockResolvedValue("PENDING")
      const runner = new ChetaidouTaskRunnerService(
        state.db,
        { completeMultimodal } as never,
        billing,
        { signForModel: jest.fn().mockResolvedValue("https://example.com/material.png") } as never
      )
      await runner.execute(task.id)
      expect(task.status).toBe("SUCCEEDED")
      expect(billing.settleTextInTx).toHaveBeenCalledTimes(1)
      const versions = await state.db.chetaidouBreakdown.findMany({ where: { imageId: 19 } })
      expect(versions[1]).toMatchObject({ payload, qualityStatus: "AI_UNREVIEWED" })
      expect(versions).toHaveLength(2)
    }
  )

  it("已确认的初始化母版无需 acknowledge 即可联想", async () => {
    expect(state.draft.acknowledgedBreakdownId).toBeUndefined()
    state.breakdown.payload.basketContents = null as any
    const result = await service.createTask(7, {
      type: "IDEATION",
      imageId: 19,
      idempotencyKey: "confirmed-preset",
      draftRevision: state.draft.revision,
    })
    expect(result).toMatchObject({ status: "QUEUED" })
    expect(state.draft.acknowledgedBreakdownId).toBeUndefined()
  })

  it("新上传图片拆解成功无需 acknowledge", async () => {
    Object.assign(state.image, { sourceType: "USER_UPLOAD", ownerId: 7 })
    state.breakdown.qualityStatus = "AI_UNREVIEWED"
    const dto = { type: "IDEATION" as const, imageId: 19, idempotencyKey: "uploaded-ai" }
    expect(state.draft.acknowledgedBreakdownId).toBeUndefined()
    await expect(service.createTask(7, dto)).resolves.toMatchObject({ status: "QUEUED" })
  })

  it.each(["MODEL_OUTPUT_INVALID", null])(
    "历史组合错误在详情、列表和批量状态中返回中文，保留原记录：%s",
    async errorCode => {
      const task = await compose()
      const raw = "组合输出不合格：/copyAdditions/0 must have required property 'targetText'"
      Object.assign(state.tasks[0], { status: "FAILED", errorCode, errorMessage: raw })
      const detail = await service.getTask(7, task.id)
      const list = await service.listTasks(7, { page: 1, pageSize: 10 })
      const statuses = await service.tasksStatus(7, [task.id])
      for (const result of [detail, list.items[0], statuses.items[0]]) {
        expect(result.errorMessage).toBe(
          "本次未能完成组合，请点击「重新组织」再试一次，已选内容会保留。"
        )
        expect(result.errorCode).toBe(errorCode)
      }
      expect(state.tasks[0].errorMessage).toBe(raw)
    }
  )

  it("待核对错误和成功任务不被组合校验提示覆盖", async () => {
    const task = await compose()
    Object.assign(state.tasks[0], {
      status: "WAITING_RECONCILIATION",
      errorCode: "CALL_STATUS_UNKNOWN",
      errorMessage: "模型调用状态待核对，请勿重复提交",
    })
    expect((await service.getTask(7, task.id)).errorMessage).toBe(
      "模型调用状态待核对，请勿重复提交"
    )
    Object.assign(state.tasks[0], { status: "SUCCEEDED", errorCode: null, errorMessage: null })
    expect((await service.getTask(7, task.id)).errorMessage).toBeNull()
  })

  it("待核对联想收到原批次回执后自动恢复，没有回执的批次不重发", async () => {
    const h = await ideationHarness(6)
    const base = h.completeMultimodal.getMockImplementation()!
    h.completeMultimodal.mockImplementation(async (request: any) => {
      const input = JSON.parse(request.messages[1].content)
      if (input.dimensions) throw new Error("connection lost")
      return base(request)
    })
    await h.runner.execute(h.taskId)
    expect(state.tasks[0].status).toBe("WAITING_RECONCILIATION")
    expect(state.groups.every(g => g.status === "UNKNOWN")).toBe(true)
    const calls = (await state.db.chetaidouCall.findMany()).filter(c =>
      c.targetKey.startsWith("batch:")
    )
    const resume = jest.spyOn(h.runner, "execute")
    for (const [index, call] of calls.entries()) {
      const input = JSON.parse(call.request.messages[1].content)
      const response = h.respond(h.outputGroups(input.dimensions))
      await state.db.chetaidouCall.update({
        where: { id: call.id },
        data: { gatewayResponse: response.completion, gatewayRequestId: response.requestId },
      })
      await h.runner.reconcileWaitingTasks()
      await resume.mock.results[index].value
      expect(state.groups.filter(g => g.status === "SUCCEEDED")).toHaveLength((index + 1) * 3)
      expect(state.tasks[0].status).toBe(index === 0 ? "WAITING_RECONCILIATION" : "SUCCEEDED")
    }
    const saved = structuredClone(state.groups)
    await h.runner.reconcileWaitingTasks()
    expect(state.groups).toEqual(saved)
    expect(h.completeMultimodal).toHaveBeenCalledTimes(3)
    expect(await state.db.chetaidouCall.findMany()).toHaveLength(3)
    expect(state.draft.activeGroupRefs).toHaveLength(6)
  })

  it("已有回执格式错误，核对收敛为失败且不新增收费调用", async () => {
    const h = await ideationHarness(3)
    const base = h.completeMultimodal.getMockImplementation()!
    h.completeMultimodal.mockImplementation(async (request: any) => {
      if (JSON.parse(request.messages[1].content).dimensions) throw new Error("connection lost")
      return base(request)
    })
    await h.runner.execute(h.taskId)
    const call = (await state.db.chetaidouCall.findMany()).find(c =>
      c.targetKey.startsWith("batch:")
    )
    await state.db.chetaidouCall.update({
      where: { id: call.id },
      data: { gatewayResponse: { choices: [{ message: { content: "{" } }] } },
    })
    const resume = jest.spyOn(h.runner, "execute")
    await h.runner.reconcileWaitingTasks()
    await resume.mock.results[0].value
    expect(state.tasks[0].status).toBe("FAILED")
    expect(state.groups.every(g => g.status === "FAILED")).toBe(true)
    expect((await state.db.chetaidouCall.findMany()).every(c => c.billingStatus === "FREE")).toBe(
      true
    )
    expect(h.completeMultimodal).toHaveBeenCalledTimes(2)
  })

  it("保存回复遇到短暂数据库失败时重试保存，不重发原请求", async () => {
    jest.useFakeTimers()
    try {
      const h = await ideationHarness(3)
      await state.db.chetaidouCall.create({
        data: {
          id: "slow-call",
          state: "PREPARED",
          request: { model: "text", messages: [] },
        },
      })
      state.db.chetaidouCall.update.mockRejectedValueOnce(new Error("database disconnected"))
      h.completeMultimodal.mockResolvedValueOnce(h.respond("original result"))
      const result = h.runner.callLlm("slow-call", { model: "text", messages: [] })
      await jest.advanceTimersByTimeAsync(5000)
      await expect(result).resolves.toBe("original result")
      const saved = await state.db.chetaidouCall.findUnique({ where: { id: "slow-call" } })
      expect(saved.state).toBe("RECEIVED")
      expect(saved.gatewayResponse.choices[0].message.content).toBe("original result")
      expect(h.completeMultimodal).toHaveBeenCalledTimes(1)
      expect(state.db.chetaidouCall.update).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it.each([
    ["MODEL_OUTPUT_INVALID", "Unexpected token '`', invalid JSON"],
    [null, "/0 must have required property 'evidenceNeeded'"],
    ["PROVIDER_ERROR", 'upstream request failed: {"status":500}'],
    ["OUTPUT_APPLY_FAILED", "PrismaClientKnownRequestError: database unavailable"],
  ])("联想技术错误在各读接口转换为中文且保留原始记录：%s", async (errorCode, raw) => {
    const h = await ideationHarness(3)
    const task = state.tasks.find(t => t.id === h.taskId)
    Object.assign(task, { status: "FAILED", errorCode, errorMessage: raw })
    state.groups.push({
      id: "failed-group",
      taskId: h.taskId,
      key: "g0",
      definition: h.definitions[0],
      status: "FAILED",
      errorCode,
      errorMessage: raw,
      order: 0,
      updatedAt: new Date(),
    })
    const detail = await service.getTask(7, h.taskId)
    const list = await service.listTasks(7, { page: 1, pageSize: 10 })
    const statuses = await service.tasksStatus(7, [h.taskId])
    for (const result of [detail, list.items[0], statuses.items[0]]) {
      expect(result.errorMessage).toBe("本次联想未能完成，请稍后重试，已生成的方案会保留。")
      expect(result.errorCode).toBe(errorCode)
    }
    for (const result of [detail, list.items[0]] as any[]) {
      expect(result.groups[0].errorMessage).toBe("该维度暂未生成可用方案，请点击「重试该维度」。")
      expect(result.groups[0].errorCode).toBe(errorCode)
    }
    expect(task.errorMessage).toBe(raw)
    expect(state.groups[0].errorMessage).toBe(raw)
  })

  it.each(["IDEATION", "REFRESH_GROUP", "DIVERGE"])(
    "%s 的待核对状态不提示重试，成功状态不显示错误",
    async type => {
      const h = await ideationHarness(3)
      const task = state.tasks.find(t => t.id === h.taskId)
      Object.assign(task, {
        type,
        status: "WAITING_RECONCILIATION",
        errorCode: "CALL_STATUS_UNKNOWN",
        errorMessage: "UnknownCallError: call-123",
      })
      state.groups.push({
        id: "unknown-group",
        taskId: h.taskId,
        definition: h.definitions[0],
        status: "UNKNOWN",
        errorCode: "CALL_STATUS_UNKNOWN",
        errorMessage: "UnknownCallError: call-123",
        order: 0,
        updatedAt: new Date(),
      })
      const result: any = await service.getTask(7, h.taskId)
      expect(result.errorMessage).toBe("生成结果正在核对，请稍后查看，暂勿重复提交。")
      if (type !== "DIVERGE") {
        expect(result.groups[0].errorMessage).toBe(result.errorMessage)
      }
      for (const row of [task, state.groups[0]]) {
        Object.assign(row, { status: "SUCCEEDED", errorCode: null, errorMessage: null })
      }
      const success: any = await service.getTask(7, h.taskId)
      expect(success.errorMessage).toBeNull()
      if (type !== "DIVERGE") expect(success.groups[0].errorMessage).toBeNull()
    }
  )

  it("精简冲突结构直接进入问答，不消耗修复调用", async () => {
    const task = await compose()
    const full = composeOutput(false)
    const runner = composeRunner([
      {
        status: full.status,
        summaryCn: full.summaryCn,
        editPromptEn: "",
        conflicts: full.conflicts,
      },
    ])
    await runner.runCompose(task)
    expect(runner.callLlm).toHaveBeenCalledTimes(1)
    expect(state.tasks[0]).toMatchObject({
      status: "SUCCEEDED",
      output: { status: "NEEDS_RESOLUTION", copyAdditions: [], editPromptEn: null },
    })
  })

  it.each(["not json", { ...composeOutput(true), copyAdditions: [{ text: "x" }] }])(
    "组合校验失败只调用一次，不结算，旧预算也不会触发自动修复",
    async invalid => {
      const task = await compose()
      task.snapshot.limits.repairBudget = 1
      const runner = composeRunner([invalid, composeOutput(true)])
      await runner.runCompose(task)
      expect(runner.callLlm).toHaveBeenCalledTimes(1)
      expect(runner.settleAndApply).not.toHaveBeenCalled()
      expect(state.tasks[0].status).toBe("FAILED")
      const calls = await state.db.chetaidouCall.findMany()
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        outcome: "INVALID",
        billingStatus: "FREE",
        chargedCredits: "0",
      })
    }
  )

  it("合法冲突结果可进入问答，答案通过后才得到 READY", async () => {
    const task = await compose()
    await composeRunner([composeOutput(false)]).runCompose(task)
    const next = await service.submitAnswers(7, task.id, {
      idempotencyKey: "resolved",
      draftRevision: state.draft.revision,
      answers: [{ conflictId: "c1", choiceId: "keep", questionVersion: 1 }],
    })
    const child = state.tasks.find(t => t.id === next.taskId)
    const decision = child.snapshot.decisions[0]
    await composeRunner([
      { ...composeOutput(true), acknowledgedAnswerIds: [decision.decisionId] },
    ]).runCompose(child)
    expect(child.output.status).toBe("READY")
    expect(child.output.decisions[0].compositionTaskId).toBe(task.id)
    expect(state.tasks[0].output.status).toBe("NEEDS_RESOLUTION")
  })

  it("组合失败保留草稿且只展示中文错误", async () => {
    const task = await compose()
    const runner = composeRunner(["{"])
    await runner.runCompose(task)
    expect(runner.callLlm).toHaveBeenCalledTimes(1)
    expect(state.tasks[0]).toMatchObject({ status: "FAILED", output: null })
    expect(state.tasks[0].errorMessage).toBe(
      "本次未能完成组合，请点击「重新组织」再试一次，已选内容会保留。"
    )
    expect(state.draft.activeCompositionTaskId).toBe(task.id)
  })

  it("修复预算为零时只调用一次", async () => {
    const task = await compose()
    task.snapshot.limits.repairBudget = 0
    const runner = composeRunner(["{"])
    await runner.runCompose(task)
    expect(runner.callLlm).toHaveBeenCalledTimes(1)
    expect(state.tasks[0].errorMessage).not.toContain("自动修复未成功")
  })

  it("首次调用未知进入待核对，重复 execute 不再调用", async () => {
    const task = await compose()
    const runner = composeRunner([new UnknownCallError("initial-call")])
    await runner.execute(task.id)
    expect(state.tasks[0]).toMatchObject({
      status: "WAITING_RECONCILIATION",
      errorCode: "CALL_STATUS_UNKNOWN",
    })
    await runner.execute(task.id)
    expect(runner.callLlm).toHaveBeenCalledTimes(1)
  })

  it("组合失败回执重入不新建模型调用或扣费", async () => {
    const task = await compose()
    const runner = composeRunner(["{"])
    await runner.runCompose(task)
    const [call] = await state.db.chetaidouCall.findMany()
    await state.db.chetaidouCall.update({
      where: { id: call.id },
      data: {
        gatewayResponse: { choices: [{ message: { content: "{" } }] },
      },
    })
    runner.callLlm.mockRestore()
    await runner.runCompose(task)
    expect(await state.db.chetaidouCall.findMany()).toHaveLength(1)
    expect(runner.settleAndApply).not.toHaveBeenCalled()
    expect(state.tasks[0].status).toBe("FAILED")
  })

  it("已有 PREPARED 调用使用落库原请求，不被新的构造参数替换", async () => {
    const task = await compose()
    const frozenRequest = { model: "text", messages: [{ role: "system", content: "冻结规则" }] }
    await state.db.chetaidouCall.create({
      data: {
        id: "prepared",
        taskId: task.id,
        targetKey: "repair:compose",
        attempt: 1,
        state: "PREPARED",
        request: frozenRequest,
      },
    })
    const runner = composeRunner([composeOutput(true)])
    await runner.callComposition(task, "repair:compose", { model: "changed", messages: [] })
    expect(runner.callLlm).toHaveBeenCalledWith("prepared", frozenRequest)
    expect(await state.db.chetaidouCall.findMany()).toHaveLength(1)
  })

  it("真实调用超时记为 UNKNOWN，重入不重新请求网关", async () => {
    const task = await compose()
    const completeMultimodal = jest.fn().mockRejectedValueOnce(new Error("timeout"))
    const runner: any = new ChetaidouTaskRunnerService(
      state.db,
      { completeMultimodal } as never,
      billing,
      {} as never
    )
    jest
      .spyOn(runner, "settleAndApply")
      .mockImplementation(async (_id: any, _model: any, apply: any) => apply(state.db))
    await runner.execute(task.id)
    expect(state.tasks[0].status).toBe("WAITING_RECONCILIATION")
    expect(await state.db.chetaidouCall.findMany()).toEqual(
      expect.arrayContaining([expect.objectContaining({ targetKey: "compose", state: "UNKNOWN" })])
    )
    await expect(runner.runCompose(task)).rejects.toBeInstanceOf(UnknownCallError)
    expect(completeMultimodal).toHaveBeenCalledTimes(1)
    expect(await state.db.chetaidouCall.findMany()).toHaveLength(1)
    const [call] = await state.db.chetaidouCall.findMany()
    expect(call.errorMessage).toBe("timeout")
    await state.db.chetaidouCall.update({
      where: { id: call.id },
      data: {
        gatewayResponse: {
          choices: [{ message: { content: JSON.stringify(composeOutput(true)) } }],
        },
      },
    })
    const resume = jest.spyOn(runner, "execute")
    await runner.reconcileWaitingTasks()
    await resume.mock.results[0].value
    expect(state.tasks[0].status).toBe("SUCCEEDED")
    expect(state.tasks[0].output).toMatchObject({
      status: "READY",
      editPromptEn: "Keep the original background.",
    })
    expect(completeMultimodal).toHaveBeenCalledTimes(1)
  })

  it("同名不同范围的问题保留旧决定，同范围重新回答替换旧决定", async () => {
    const task = await compose()
    await executeCompose(task, false)
    const prior = {
      decisionId: "prior",
      conflictId: "c1",
      compositionTaskId: "older",
      question: "保留哪种颜色？",
      sources: ["color"],
    }
    state.tasks[0].output.decisions = [
      prior,
      { ...prior, decisionId: "replace", question: conflict.question, sources: conflict.sources },
    ]
    const next = await service.submitAnswers(7, task.id, {
      idempotencyKey: "scoped",
      draftRevision: state.draft.revision,
      answers: [{ conflictId: "c1", choiceId: "keep", questionVersion: 1 }],
    })
    const decisions = state.tasks.find(t => t.id === next.taskId).snapshot.decisions
    expect(decisions).toHaveLength(2)
    expect(decisions[0].decisionId).toBe("prior")
    expect(decisions[1].scopeKey).toMatch(/^[a-f0-9]{64}$/)
  })

  it("含阻断问题时，即使只回答非阻断问题也拒绝调用下一轮", async () => {
    const task = await compose()
    await executeCompose(task, false)
    state.tasks[0].output.conflicts.push({
      ...conflict,
      id: "blocked",
      blocking: true,
      choices: [],
    })
    await expect(
      service.submitAnswers(7, task.id, {
        idempotencyKey: "blocked",
        draftRevision: state.draft.revision,
        answers: [{ conflictId: "c1", choiceId: "keep", questionVersion: 1 }],
      })
    ).rejects.toThrow("存在阻断问题")
    expect(state.tasks).toHaveLength(1)
  })

  it("首轮排队即能恢复，待回答后能提交下一轮；重复提交答案返回同一任务", async () => {
    const task = await compose()
    expect(state.draft.activeCompositionTaskId).toBe(task.id)
    expect((await service.getComposition(7, task.id)).isStale).toBe(false)
    await executeCompose(task, false)
    expect((await service.getDraft(7, 19)).activeCompositionTaskId).toBe(task.id)
    const dto = {
      idempotencyKey: "answers",
      draftRevision: state.draft.revision,
      answers: [{ conflictId: "c1", choiceId: "keep", questionVersion: 1 }],
    }
    const next = await service.submitAnswers(7, task.id, dto)
    expect(state.draft.activeCompositionTaskId).toBe(next.taskId)
    expect((await service.getDraft(7, 19)).activeCompositionTaskId).toBe(next.taskId)
    expect((await service.submitAnswers(7, task.id, dto)).taskId).toBe(next.taskId)
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks[1].snapshot.decisions[0].instruction).toBe("Keep the background")
  })
  it("草稿改变后，旧组合晚完成不重新挂回；旧产物保持可读", async () => {
    const task = await compose()
    await service.putDraft(7, 19, {
      revision: state.draft.revision,
      settings: { ...defaultSettings(), customText: "新要求" },
      selections: [],
      customDimensions: [],
    })
    await executeCompose(task, true)
    expect(state.draft.activeCompositionTaskId).toBeNull()
    expect(await service.getComposition(7, task.id)).toMatchObject({
      isStale: true,
      output: { status: "READY" },
    })
  })
  it("无实际变化的保存不使当前组合失效", async () => {
    const task = await compose()
    await service.putDraft(7, 19, {
      revision: state.draft.revision,
      settings: defaultSettings(),
      selections: [],
      customDimensions: [],
    })
    expect(state.draft.activeCompositionTaskId).toBe(task.id)
  })
  it.each(["设置", "事实卡"])("联想%s变化后允许按当前上下文继续组合", async change => {
    const task = await compose()
    task.type = "IDEATION"
    state.draft.activeIdeationTaskId = task.id
    const frozenSnapshot = structuredClone(task.snapshot)
    if (change === "设置") state.draft.settings.customText = "已变更"
    else Object.assign(state.fact, { version: 2, contentHash: "new-facts" })
    state.groups.push({
      id: "old",
      taskId: task.id,
      status: "SUCCEEDED",
      definition: { key: "background", label: "背景", selectionMode: "single" },
      options: [
        { key: "o1", label: "草地", changeInstruction: "Use a lawn", requiresEvidence: false },
      ],
    })
    state.draft.activeGroupRefs = [{ groupId: "old" }]
    state.draft.selections = [{ groupId: "old", optionKeys: ["o1"] }]
    expect(await service.getDraft(7, 19)).toMatchObject({ ideationStale: false })
    await expect(
      service.createTask(7, { type: "COMPOSE", imageId: 19, idempotencyKey: "new" })
    ).resolves.toMatchObject({ status: "QUEUED" })
    expect(task.snapshot).toEqual(frozenSnapshot)
  })
  it("新任务的三个扩展模板都有证据判断规则，历史批量请求仍用冻结正文", async () => {
    const task = await compose()
    for (const key of ["expansion", "batchExpansion", "diverge"]) {
      const body = task.snapshot.prompt.templateBodies[key]
      expect(body).toContain("新的背景衣服不天然需要产品证据")
      expect(body).toContain("requiresEvidence=false、evidenceNeeded=[]")
      expect(body).toContain("evidenceNeeded 必须具体说明缺少的产品证据")
      expect(body).toContain("输出前逐项自检")
    }
    const historical = structuredClone(task.snapshot)
    historical.prompt = { version: "old", templateBodies: { batchExpansion: "历史批量规则" } }
    const runner = composeRunner([])
    expect(runner.batchRequest(historical, []).messages[0].content).toBe("历史批量规则")
    expect(runner.batchRequest(task.snapshot, []).messages[0].content).toContain("输出前逐项自检")
  })
  it("识别、扩展、发散和组合快照均区分排版与文案内容", async () => {
    const task = await compose()
    for (const key of ["dimensions", "expansion", "batchExpansion", "diverge", "composition"]) {
      const body = task.snapshot.prompt.templateBodies[key]
      expect(body).toContain("kind=visual、purpose=copy_layout")
      if (key !== "dimensions")
        expect(body).toContain("禁止输出 targetText、targetLocale、meaningCn")
    }
    expect(task.snapshot.prompt.templateBodies.composition).toContain(
      "不因选择排版而额外产生 copyAdditions"
    )
  })
  it("创建组合的 CAS 冲突会回滚任务，不留无主任务", async () => {
    state.db.chetaidouDraft.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(compose()).rejects.toThrow(ConflictException)
    expect(state.tasks).toHaveLength(0)
  })
  it("发散应用保留来源及原产物，重复应用不重复追加，放弃标记持久化", async () => {
    state.draft.customDimensions = [
      { id: "dim", label: "背景", selectionMode: "multi", options: [], selectedKeys: [] },
    ]
    state.tasks.push({
      id: "diverge",
      rootTaskId: "diverge",
      ownerId: 7,
      imageId: 19,
      type: "DIVERGE",
      status: "SUCCEEDED",
      input: { customDimensionId: "dim" },
      output: { newOptions: [{ key: "ai_1", label: "海边" }], newOptionCount: 1, applied: false },
      updatedAt: new Date(),
    })
    await service.applyTask(7, "diverge", 0)
    await service.applyTask(7, "diverge", 0)
    expect(state.draft.customDimensions[0].options).toEqual([
      { key: "ai_1", text: "海边", origin: "AI", sourceTaskId: "diverge" },
    ])
    expect(state.tasks[0].output.newOptions).toHaveLength(1)
    await expect(service.discardTask(7, "diverge")).rejects.toThrow("已应用")
    state.tasks.push({
      ...state.tasks[0],
      id: "discard",
      output: { newOptions: [], applied: false },
    })
    await service.discardTask(7, "discard")
    expect(await service.getTaskOutput(7, "discard")).toMatchObject({
      discarded: true,
      canApply: false,
    })
    await expect(service.applyTask(7, "discard", 1)).rejects.toThrow("已放弃")
  })
  it("应用与放弃不会绕过产物归属校验；草稿版本冲突不写入选项", async () => {
    state.tasks.push({
      id: "d",
      ownerId: 7,
      imageId: 19,
      type: "DIVERGE",
      status: "SUCCEEDED",
      input: {},
      output: {},
    })
    await expect(service.discardTask(8, "d")).rejects.toThrow("不存在")
    await expect(service.applyTask(7, "d", 99)).rejects.toThrow("草稿已变化")
    expect(state.draft.revision).toBe(0)
  })
  async function ideationHarness(count = 6) {
    state.draft.settings = {
      ...defaultSettings(),
      model: "text",
      dimensionCountRange: { min: count, max: count },
      optionCountRange: { min: 2, max: 2 },
    }
    const created: any = await service.createTask(7, {
      type: "IDEATION",
      imageId: 19,
      idempotencyKey: "new-ideation",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    const definitions = Array.from({ length: count }, (_, i) => ({
      key: `g${i}`,
      label: `维度${i}`,
      currentValue: "当前值",
      sourceDimensions: [],
      expansionReason: "有效独立变化",
      selectionMode: "single",
      targetElement: `元素${i}`,
      attribute: "变化属性",
      kind: "visual",
    }))
    const option = (key: string, i: number) => ({
      key: `o${i}`,
      label: `${key}选项${i}`,
      changeInstruction: "修改元素",
      preserveInstruction: "保留产品",
      riskLevel: "low",
      riskReason: "",
      requiresEvidence: false,
      evidenceNeeded: [],
      dependentChanges: [],
      incompatibleWith: [],
    })
    const outputGroups = (dims: any[]) => ({
      groups: dims.map(g => ({ key: g.key, options: [option(g.key, 0), option(g.key, 1)] })),
    })
    let requestNo = 0
    const respond = (value: any) => ({
      completion: {
        choices: [
          { message: { content: typeof value === "string" ? value : JSON.stringify(value) } },
        ],
      },
      requestId: `request-${++requestNo}`,
    })
    const completeMultimodal = jest.fn(async (request: any) => {
      const input = JSON.parse(request.messages[request.messages.length - 1].content)
      return respond(
        input.dimensions
          ? outputGroups(input.dimensions)
          : {
              summary: "识别完成",
              basketContents: { hasItems: false, evidence: "", items: [] },
              groups: definitions,
            }
      )
    })
    billing.lookupTextUsage = jest.fn().mockResolvedValue(null)
    billing.settleTextInTx = jest.fn().mockResolvedValue("PENDING")
    const runner: any = new ChetaidouTaskRunnerService(
      state.db,
      { completeMultimodal } as never,
      billing,
      {} as never
    )
    return {
      runner,
      taskId: created.taskId,
      definitions,
      completeMultimodal,
      outputGroups,
      respond,
    }
  }

  it("本地修复格式、剔除禁止维度和坏选项后成功，原回执保留且不增加模型调用", async () => {
    const h = await ideationHarness(5)
    h.completeMultimodal.mockImplementation(async (request: any) => {
      const input = JSON.parse(request.messages.at(-1).content)
      let result: any
      if (input.dimensions) {
        result = h.outputGroups(input.dimensions)
        delete result.groups[0].options[0].changeInstruction
      } else {
        result = {
          summary: "识别完成",
          basketContents: { hasItems: false, evidence: "", items: [] },
          groups: [...h.definitions, { ...h.definitions[0], key: "copy_extra", kind: "copy" }],
        }
      }
      return h.respond(JSON.stringify(result).replace(/}$/, ",}"))
    })
    await h.runner.execute(h.taskId)
    const task = state.tasks.find(t => t.id === h.taskId)
    expect(task.status).toBe("SUCCEEDED")
    expect(task.progress).toEqual({ total: 5, processed: 5, succeeded: 5, failed: 0 })
    expect(state.groups.map(g => g.key)).toEqual(h.definitions.map(g => g.key))
    expect(state.groups.map(g => g.options.length)).toEqual([1, 2, 2, 1, 2])
    expect(h.completeMultimodal).toHaveBeenCalledTimes(3)
    expect(billing.settleTextInTx).toHaveBeenCalledTimes(3)
    const calls = await state.db.chetaidouCall.findMany()
    expect(calls).toHaveLength(3)
    const identify = calls.find(c => c.targetKey === "identify")
    const original = identify.gatewayResponse.choices[0].message.content
    expect(original).toContain('"kind":"copy"')
    expect(original).toMatch(/,}$/)
    expect(
      JSON.parse(identify.request.messages[1].content).outputSchema.properties.groups.items
        .properties.kind.enum
    ).toEqual(["visual"])
  })

  it("批次内部缺结束括号及逗号可本地挽救，仍剔除坏项且保留原回执", async () => {
    const h = await ideationHarness(3)
    const base = h.completeMultimodal.getMockImplementation()!
    let original = ""
    h.completeMultimodal.mockImplementation(async (request: any) => {
      const input = JSON.parse(request.messages.at(-1).content)
      if (!input.dimensions) return base(request)
      const result = h.outputGroups(input.dimensions)
      delete result.groups[0].options[0].changeInstruction
      original = JSON.stringify(result).replaceAll(
        '"incompatibleWith":[]},{"key":"o1"',
        '"incompatibleWith":[]{"key":"o1"'
      )
      return h.respond(original)
    })
    await h.runner.execute(h.taskId)
    expect(state.tasks.find(t => t.id === h.taskId).status).toBe("SUCCEEDED")
    expect(state.groups.map(g => g.options.length)).toEqual([1, 2, 2])
    expect(h.completeMultimodal).toHaveBeenCalledTimes(2)
    expect(billing.settleTextInTx).toHaveBeenCalledTimes(2)
    const calls = await state.db.chetaidouCall.findMany()
    const batch = calls.find(c => c.targetKey.startsWith("batch:"))
    expect(batch.gatewayResponse.choices[0].message.content).toBe(original)
  })

  it("空选项整批失败免扣，不重试付费调用", async () => {
    const h = await ideationHarness(3)
    const base = h.completeMultimodal.getMockImplementation()!
    h.completeMultimodal.mockImplementation(async (request: any) => {
      const input = JSON.parse(request.messages.at(-1).content)
      if (!input.dimensions) return base(request)
      return h.respond({ groups: input.dimensions.map((d: any) => ({ key: d.key, options: [] })) })
    })
    await h.runner.execute(h.taskId)
    expect(state.tasks.find(t => t.id === h.taskId).status).toBe("FAILED")
    expect(state.groups.every(g => g.status === "FAILED")).toBe(true)
    expect(h.completeMultimodal).toHaveBeenCalledTimes(2)
    expect(billing.settleTextInTx).not.toHaveBeenCalled()
    expect((await state.db.chetaidouCall.findMany()).every(c => c.billingStatus === "FREE")).toBe(
      true
    )
  })

  it("识别阶段的迟到回执恢复后继续扩展，不重复购买识别调用", async () => {
    const h = await ideationHarness(3)
    h.completeMultimodal.mockRejectedValueOnce(new Error("connection lost"))
    await h.runner.execute(h.taskId)
    const [identify] = await state.db.chetaidouCall.findMany()
    const response = h.respond({
      summary: "原识别结果",
      basketContents: { hasItems: false, evidence: "", items: [] },
      groups: h.definitions,
    })
    await state.db.chetaidouCall.update({
      where: { id: identify.id },
      data: { gatewayResponse: response.completion, gatewayRequestId: response.requestId },
    })
    const resume = jest.spyOn(h.runner, "execute")
    await h.runner.reconcileWaitingTasks()
    await resume.mock.results[0].value
    expect(state.tasks[0].status).toBe("SUCCEEDED")
    expect(state.groups).toHaveLength(3)
    expect(await state.db.chetaidouCall.findMany()).toHaveLength(2)
    expect(h.completeMultimodal).toHaveBeenCalledTimes(2)
    expect(JSON.parse(h.completeMultimodal.mock.calls[1][0].messages[1].content)).toHaveProperty(
      "dimensions"
    )
  })

  it.each([
    "ZQ-Multimodal-Qwen-3.7-Plus",
    "ZQ-Multimodal-Gemini-3.1-Pro",
    "ZQ-Multimodal-Gemini-3.5-Flash-Lite",
    "ZQ-Think-Flash",
    "ZQ-Think-Ultra",
    "gpt-5.5",
  ])("%s 联想携带统一输出 Schema，额外自检字段不导致失败", async model => {
    const h = await ideationHarness(3)
    const task = state.tasks.find(t => t.id === h.taskId)
    task.snapshot.models.text.publicId = model
    task.snapshot.settings.model = model
    state.draft.settings.model = model
    Object.assign(h.definitions[2], { label_duplicate_check: "true" })
    h.definitions[0].selectionMode = "multi"

    await h.runner.execute(h.taskId)

    const request = h.completeMultimodal.mock.calls[0][0]
    expect(request.model).toBe(model)
    expect(JSON.parse(request.messages[1].content).outputSchema).toEqual(
      identifySchemaOf(task.snapshot.settings)
    )
    expect(request.messages[0].content).toContain("输入 outputSchema 是本阶段完整的 JSON Schema")
    expect(task.status).toBe("SUCCEEDED")
    expect(state.groups).toHaveLength(3)
    expect(state.groups.every(g => g.definition.selectionMode === "single")).toBe(true)
    expect(state.groups[2].definition).not.toHaveProperty("label_duplicate_check")
    const identify = await state.db.chetaidouCall.findFirst({ where: { targetKey: "identify" } })
    expect(
      JSON.parse(identify.gatewayResponse.choices[0].message.content).groups[2]
    ).toHaveProperty("label_duplicate_check", "true")
    expect(h.completeMultimodal).toHaveBeenCalledTimes(2)
    for (const [sent] of h.completeMultimodal.mock.calls) {
      if (
        ["ZQ-Multimodal-Qwen-3.7-Plus", "ZQ-Multimodal-Gemini-3.5-Flash-Lite", "gpt-5.5"].includes(
          model
        )
      )
        expect(sent.response_format).toEqual({ type: "json_object" })
      else expect(sent).not.toHaveProperty("response_format")
    }
    for (const call of await state.db.chetaidouCall.findMany())
      expect(call.requestHash).toBe(stableHash(call.request))
  })

  it.each(["ZQ-Multimodal-Qwen-3.7-Plus", "ZQ-Multimodal-Gemini-3.5-Flash-Lite", "gpt-5.5"])(
    "%s 新调用持久化 JSON 参数，旧模板补关键词，重入不新建调用",
    async model => {
      const h = await ideationHarness(3)
      const task = state.tasks.find(t => t.id === h.taskId)
      const request = {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "拆解这张图片" },
              { type: "image_url", image_url: { url: "https://example.com/image.png" } },
            ],
          },
        ],
      }
      const original = structuredClone(request)
      const input = {
        task,
        targetKey: "breakdown",
        kind: "TEXT",
        source: "chetaidou.breakdown",
        model,
        promptVersion: task.snapshot.prompt.version,
        request,
        estimatedCny: 0,
      }
      const callId = await h.runner.openCall(input)
      expect(await h.runner.openCall(input)).toBe(callId)
      h.completeMultimodal.mockResolvedValueOnce(h.respond("原回复"))
      await expect(h.runner.callLlm(callId, request)).resolves.toBe("原回复")
      const [call] = await state.db.chetaidouCall.findMany()
      expect(call.request.response_format).toEqual({ type: "json_object" })
      expect(call.request.messages[0]).toMatchObject({
        role: "system",
        content: expect.stringContaining("JSON"),
      })
      expect(call.request.messages.slice(1)).toEqual(original.messages)
      expect(request).toEqual(original)
      expect(call.requestHash).toBe(stableHash(call.request))
      expect(await state.db.chetaidouCall.findMany()).toHaveLength(1)
      expect(h.completeMultimodal).toHaveBeenCalledTimes(1)
      expect(h.completeMultimodal).toHaveBeenCalledWith(call.request, undefined, true)
    }
  )

  it.each(
    ["ZQ-Multimodal-Qwen-3.7-Plus", "ZQ-Multimodal-Gemini-3.5-Flash-Lite", "gpt-5.5"].flatMap(
      model => ["PREPARED", "SUBMITTING", "UNKNOWN"].map(status => [model, status])
    )
  )("%s 添加 JSON mode 不改写或重发旧调用：%s", async (model, status) => {
    const h = await ideationHarness(3)
    const task = state.tasks.find(t => t.id === h.taskId)
    const frozen = { model, messages: [{ role: "user", content: "旧提示词" }] }
    await state.db.chetaidouCall.create({
      data: {
        id: "before-json-mode",
        taskId: task.id,
        targetKey: "identify",
        attempt: 1,
        state: status,
        request: frozen,
        requestHash: stableHash(frozen),
      },
    })
    const open = h.runner.openCall({
      task,
      targetKey: "identify",
      kind: "TEXT",
      source: "chetaidou.ideation",
      model,
      promptVersion: task.snapshot.prompt.version,
      request: frozen,
      estimatedCny: 0,
    })
    if (status === "UNKNOWN") await expect(open).rejects.toThrow(UnknownCallError)
    else {
      expect(await open).toBe("before-json-mode")
      if (status === "PREPARED") {
        h.completeMultimodal.mockResolvedValueOnce(h.respond("原回复"))
        await h.runner.callLlm("before-json-mode", frozen)
        expect(h.completeMultimodal).toHaveBeenCalledTimes(1)
        expect(h.completeMultimodal).toHaveBeenCalledWith(frozen, undefined, true)
      } else
        await expect(h.runner.callLlm("before-json-mode", frozen)).rejects.toThrow(UnknownCallError)
    }
    if (status !== "PREPARED") expect(h.completeMultimodal).not.toHaveBeenCalled()
    const [call] = await state.db.chetaidouCall.findMany()
    expect(call.request).toEqual(frozen)
    expect(call.requestHash).toBe(stableHash(frozen))
    expect(await state.db.chetaidouCall.findMany()).toHaveLength(1)
  })

  it.each([
    [6, 2],
    [10, 4],
    [24, 8],
  ])("新联想 %i 维按三维批次调用并逐维入库，尾批正确", async (count, batches) => {
    const h = await ideationHarness(count)
    await h.runner.execute(h.taskId)
    expect(h.completeMultimodal).toHaveBeenCalledTimes(1 + batches)
    expect(billing.settleTextInTx).toHaveBeenCalledTimes(batches + 1)
    expect(state.tasks.find(t => t.id === h.taskId).status).toBe("SUCCEEDED")
    expect(state.groups).toHaveLength(count)
    expect(state.groups.every(g => g.status === "SUCCEEDED" && g.options.length === 2)).toBe(true)
    expect(new Set(state.groups.flatMap(g => g.options.map((o: any) => o.selectionId))).size).toBe(
      count * 2
    )
    expect(state.draft.activeGroupRefs).toHaveLength(count)
    const identifyRequest = h.completeMultimodal.mock.calls[0][0]
    const identifyInput = JSON.parse(identifyRequest.messages[1].content)
    expect(identifyInput.dimensionCountRange).toEqual({ min: count, max: count })
    expect(identifyInput.settings).not.toHaveProperty("optionCountRange")
    expect(identifyInput).not.toHaveProperty("dimensions")
    expect(identifyInput.outputSchema.properties.groups).toMatchObject({
      minItems: count,
      maxItems: count,
    })
    const identifyPrompt = identifyRequest.messages[0].content
    expect(identifyPrompt).toContain("本次只识别维度")
    expect(identifyPrompt).toContain("不输出 options")
    expect(identifyPrompt).toContain("purpose=basket_contents")
    expect(identifyPrompt).toContain("kind=visual、purpose=copy_layout")
    expect(identifyPrompt).not.toMatch(
      /optionCountRange|changeInstruction|preserveInstruction|targetText|targetLocale|meaningCn/
    )
    expect(identifyPrompt).toContain("本阶段最终自检：只返回 summary、basketContents、groups")
    expect(identifyPrompt).toContain("textMode=keep/translate/hide 时没有 kind=copy 维度")
    for (const [request] of h.completeMultimodal.mock.calls) {
      const prompt = request.messages[0].content
      expect(prompt).toContain("JSON.parse(完整待输出文本)")
      expect(prompt).toContain("解析报错时根据错误位置修正，再解析修正后的完整文本")
      expect(prompt).toContain("不得声称已经实际执行解析器")
      expect(prompt).toContain('禁止写成 "expansionReason","扩展理由"')
      expect(prompt).toContain("检查整个结果能否作为一个完整 JSON 对象被解析")
      expect(prompt).toContain("先在内部修正，再检查修正后的完整结果")
      expect(prompt).toContain("有效数量必须在上下限内，含边界")
      expect(prompt).not.toContain("数量范围是生成目标，不是失败条件")
      expect(prompt).not.toContain("数量未达到目标时仍完整返回实际有效选项")
      expect(prompt).toMatch(/最终只返回一个修正后的完整 JSON 对象。$/)
    }
    for (const [request] of h.completeMultimodal.mock.calls.slice(1)) {
      expect(request.messages[0].content).toContain(
        "本阶段最终自检：顶层只有 groups，每组只有 key 和 options"
      )
      expect(request.messages[0].content).toContain(
        "每维必须独立生成 optionCountRange.min 到 optionCountRange.max"
      )
      expect(request.messages[0].content).toContain("不得少于下限或超过上限")
    }
    const requests = h.completeMultimodal.mock.calls
      .slice(1)
      .map(([r]: any) => JSON.parse(r.messages[1].content))
    expect(
      requests.every((r: any) => r.dimensions.length <= 3 && r.optionCountRange.min === 2)
    ).toBe(true)
  })

  it.each([6, 65])(
    "目标 10–20 维、每维 30–60 项，实际三维各 %i 项也成功保存并结算",
    async count => {
      const h = await ideationHarness(3)
      const task = state.tasks.find(t => t.id === h.taskId)
      for (const settings of [task.snapshot.settings, state.draft.settings]) {
        settings.dimensionCountRange = { min: 10, max: 20 }
        settings.optionCountRange = { min: 30, max: 60 }
      }
      h.completeMultimodal.mockImplementation(async (request: any) => {
        const input = JSON.parse(request.messages.at(-1).content)
        if (!input.dimensions)
          return h.respond({
            summary: "识别完成",
            basketContents: { hasItems: false, evidence: "", items: [] },
            groups: h.definitions,
          })
        const result = h.outputGroups(input.dimensions)
        for (const group of result.groups) {
          const first = group.options[0]
          group.options = Array.from({ length: count }, (_, i) => ({
            ...first,
            key: `o${i}`,
            label: `${group.key}选项${i}`,
          }))
        }
        return h.respond(result)
      })
      await h.runner.execute(h.taskId)
      expect(task.status).toBe("SUCCEEDED")
      expect(task.progress).toEqual({ total: 3, processed: 3, succeeded: 3, failed: 0 })
      expect(state.groups.every(g => g.status === "SUCCEEDED" && g.options.length === count)).toBe(
        true
      )
      expect(state.draft.activeGroupRefs).toHaveLength(3)
      expect(billing.settleTextInTx).toHaveBeenCalledTimes(2)
      const detail: any = await service.getTask(7, h.taskId)
      expect(detail.groups.map(g => g.optionCount)).toEqual([count, count, count])
    }
  )

  it("识别返回空维度数组失败免扣，不购买扩展调用", async () => {
    const h = await ideationHarness(0)
    const task = state.tasks.find(t => t.id === h.taskId)
    task.snapshot.settings.dimensionCountRange = { min: 10, max: 20 }
    await h.runner.execute(h.taskId)
    expect(task.status).toBe("FAILED")
    expect(h.completeMultimodal).toHaveBeenCalledTimes(1)
    expect(billing.settleTextInTx).not.toHaveBeenCalled()
    expect((await state.db.chetaidouCall.findMany())[0].billingStatus).toBe("FREE")
    expect((await service.getTask(7, h.taskId)).progress).toEqual({
      total: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
    })
  })

  it.each([false, true])("新建联想不传输出上限且失败不自动修复，兼容旧快照：%s", async legacy => {
    const h = await ideationHarness(3)
    const task = state.tasks.find(t => t.id === h.taskId)
    expect(task.snapshot.limits).not.toHaveProperty("maxOutputTokens")
    if (legacy) task.snapshot.limits.maxOutputTokens = 16_384
    const snapshot = structuredClone(task.snapshot)
    h.completeMultimodal.mockImplementation(async (request: any) => {
      const input = JSON.parse(request.messages.at(-1).content)
      if (input.originalInput) return h.respond(h.outputGroups(h.definitions))
      if (input.dimensions) return h.respond("{")
      return h.respond({
        summary: "s",
        basketContents: { hasItems: false, evidence: "", items: [] },
        groups: h.definitions,
      })
    })
    await h.runner.execute(h.taskId)
    expect(h.completeMultimodal).toHaveBeenCalledTimes(2)
    expect(task.status).toBe("FAILED")
    expect(billing.settleTextInTx).not.toHaveBeenCalled()
    for (const [request] of h.completeMultimodal.mock.calls) {
      expect(request).not.toHaveProperty("max_output_tokens")
      expect(request).not.toHaveProperty("max_tokens")
      expect(request).not.toHaveProperty("max_completion_tokens")
    }
    expect(task.snapshot).toEqual(snapshot)
    for (const call of await state.db.chetaidouCall.findMany()) {
      expect(call.request).not.toHaveProperty("max_output_tokens")
      expect(call.requestHash).toBe(stableHash(call.request))
    }
  })

  it.each(["PREPARED", "SUBMITTING", "UNKNOWN"])(
    "移除上限不重复创建旧调用，保留历史请求：%s",
    async status => {
      const h = await ideationHarness(3)
      const task = state.tasks.find(t => t.id === h.taskId)
      const request = { model: "text", messages: [{ role: "user", content: "{}" }] }
      const frozen = { ...request, max_output_tokens: 16_384 }
      await state.db.chetaidouCall.create({
        data: {
          id: "legacy-call",
          taskId: h.taskId,
          targetKey: "identify",
          attempt: 1,
          state: status,
          request: frozen,
          requestHash: stableHash(frozen),
        },
      })
      const open = h.runner.openCall({
        task,
        targetKey: "identify",
        kind: "TEXT",
        source: "chetaidou.ideation",
        model: "text",
        promptVersion: task.snapshot.prompt.version,
        request,
        estimatedCny: 0,
      })
      if (status === "UNKNOWN") await expect(open).rejects.toThrow(UnknownCallError)
      else {
        expect(await open).toBe("legacy-call")
        if (status === "PREPARED") {
          h.completeMultimodal.mockResolvedValueOnce(h.respond({}))
          await h.runner.callLlm("legacy-call", request)
          expect(h.completeMultimodal).toHaveBeenCalledWith(frozen, undefined, true)
        } else {
          await expect(h.runner.callLlm("legacy-call", request)).rejects.toThrow(UnknownCallError)
        }
      }
      if (status !== "PREPARED") expect(h.completeMultimodal).not.toHaveBeenCalled()
      const calls = await state.db.chetaidouCall.findMany()
      expect(calls).toHaveLength(1)
      expect(calls[0].request).toEqual(frozen)
      expect(calls[0].requestHash).toBe(stableHash(frozen))
    }
  )

  it("一维失败保留其他结果，用户定向重试仅调用失败维度并沿用原范围", async () => {
    const h = await ideationHarness(3)
    h.completeMultimodal.mockImplementation(async (request: any) => {
      const input = JSON.parse(request.messages.at(-1).content)
      if (input.originalInput) return h.respond({ groups: [] })
      if (input.dimensions) {
        const result = h.outputGroups(input.dimensions)
        for (const option of result.groups.find((g: any) => g.key === "g1").options)
          delete option.changeInstruction
        return h.respond(result)
      }
      return h.respond({
        summary: "s",
        basketContents: { hasItems: false, evidence: "", items: [] },
        groups: h.definitions,
      })
    })
    await h.runner.execute(h.taskId)
    expect(state.tasks.find(t => t.id === h.taskId).status).toBe("PARTIAL")
    expect(state.groups.filter(g => g.status === "SUCCEEDED")).toHaveLength(2)
    const failed = state.groups.find(g => g.status === "FAILED")
    expect(h.completeMultimodal).toHaveBeenCalledTimes(2)
    expect(billing.settleTextInTx).not.toHaveBeenCalled()
    expect((await state.db.chetaidouCall.findMany()).every(c => c.billingStatus === "FREE")).toBe(
      true
    )
    const previousIds = state.groups
      .filter(g => g.status === "SUCCEEDED")
      .map(g => g.options[0].selectionId)
    state.draft.settings.optionCountRange = { min: 100, max: 200 }
    const retry = await service.retryTask(7, h.taskId, {
      idempotencyKey: "batch-retry",
      groupIds: [failed.id],
    })
    h.completeMultimodal.mockClear()
    h.completeMultimodal.mockImplementation(async (request: any) =>
      h.respond(h.outputGroups(JSON.parse(request.messages[1].content).dimensions))
    )
    await h.runner.execute(retry.taskId)
    expect(h.completeMultimodal).toHaveBeenCalledTimes(1)
    const input = JSON.parse(h.completeMultimodal.mock.calls[0][0].messages[1].content)
    expect(input.dimensions.map((g: any) => g.key)).toEqual(["g1"])
    expect(input.optionCountRange).toEqual({ min: 2, max: 2 })
    expect(state.groups.every(g => g.status === "SUCCEEDED")).toBe(true)
    expect(state.groups.filter(g => g.key !== "g1").map(g => g.options[0].selectionId)).toEqual(
      previousIds
    )
  })

  it("有效回执应用失败后定向重试不重调模型，成功维度不覆盖", async () => {
    const h = await ideationHarness(3)
    // 此处错误发生在写入前；不能用整个内存库回滚模拟并发 SQL 事务，
    // 否则会错误撤销其他维度已提交的独立事务。
    state.db.$transaction.mockImplementation((fn: any) => fn(state.db))
    const original = state.db.chetaidouGroup.updateMany.getMockImplementation()
    let failedOnce = false
    state.db.chetaidouGroup.updateMany.mockImplementation(async (args: any) => {
      if (!failedOnce && args.data.options) {
        failedOnce = true
        throw Error("数据库暂时不可用")
      }
      return original(args)
    })
    await h.runner.execute(h.taskId)
    const failed = state.groups.find(g => g.errorCode === "OUTPUT_APPLY_FAILED")
    expect(failed).toBeDefined()
    expect(billing.settleTextInTx).not.toHaveBeenCalled()
    const retry = await service.retryTask(7, h.taskId, {
      idempotencyKey: "apply-retry",
      groupIds: [failed.id],
    })
    h.completeMultimodal.mockClear()
    await h.runner.execute(retry.taskId)
    expect(h.completeMultimodal).not.toHaveBeenCalled()
    expect(state.groups.every(g => g.status === "SUCCEEDED")).toBe(true)
  })

  it("同轮有待核对批次时，明确失败维度仍可独立重试且不重发未知调用", async () => {
    const h = await ideationHarness(6)
    const base = h.completeMultimodal.getMockImplementation()!
    h.completeMultimodal.mockImplementation(async (request: any) => {
      const input = JSON.parse(request.messages.at(-1).content)
      if (!input.dimensions) return base(request)
      if (input.dimensions.some((g: any) => g.key === "g3")) throw Error("网络中断")
      const output = h.outputGroups(input.dimensions)
      for (const option of output.groups.find((g: any) => g.key === "g1").options)
        delete option.changeInstruction
      return h.respond(output)
    })
    await h.runner.execute(h.taskId)
    const root = state.tasks.find(t => t.id === h.taskId)
    expect(root.status).toBe("WAITING_RECONCILIATION")
    const failed = state.groups.find(g => g.key === "g1")
    const unknown = structuredClone(state.groups.filter(g => g.status === "UNKNOWN"))
    const succeeded = structuredClone(state.groups.filter(g => g.status === "SUCCEEDED"))
    const callsBefore = await state.db.chetaidouCall.findMany()
    const dto = {
      idempotencyKey: "mixed-status-retry",
      draftRevision: state.draft.revision,
      groupIds: [failed.id],
    }
    const retry = await service.retryTask(7, h.taskId, dto)
    await expect(service.retryTask(7, h.taskId, dto)).resolves.toEqual(retry)
    await expect(
      service.retryTask(7, h.taskId, { ...dto, idempotencyKey: "duplicate-retry" })
    ).rejects.toThrow("仅失败维度")
    h.completeMultimodal.mockClear()
    h.completeMultimodal.mockImplementation(async (request: any) =>
      h.respond(h.outputGroups(JSON.parse(request.messages.at(-1).content).dimensions))
    )
    await h.runner.execute(retry.taskId)
    expect(h.completeMultimodal).toHaveBeenCalledTimes(1)
    const input = JSON.parse(h.completeMultimodal.mock.calls[0][0].messages.at(-1).content)
    expect(input.dimensions.map((g: any) => g.key)).toEqual(["g1"])
    expect(state.groups.find(g => g.id === failed.id).status).toBe("SUCCEEDED")
    expect(state.groups.filter(g => g.status === "UNKNOWN")).toEqual(unknown)
    expect(state.groups.filter(g => succeeded.some(s => s.id === g.id))).toEqual(succeeded)
    expect(root.status).toBe("WAITING_RECONCILIATION")
    expect(await state.db.chetaidouCall.findMany()).toHaveLength(callsBefore.length + 1)
    await expect(
      service.retryTask(7, h.taskId, {
        idempotencyKey: "retry-unknown",
        groupIds: [unknown[0].id],
      })
    ).rejects.toThrow("仅失败维度")
    await expect(
      service.retryTask(7, h.taskId, { idempotencyKey: "retry-whole-waiting-task" })
    ).rejects.toThrow("先核对")
  })

  it.each([
    ["FAILED", "SUBMITTING", "未确认的模型调用"],
    ["FAILED", "WAITING", "未确认的模型调用"],
    ["FAILED", "UNKNOWN", "未确认的模型调用"],
    ["UNKNOWN", "UNKNOWN", "仅失败维度"],
    ["RUNNING", "SUBMITTING", "仅失败维度"],
    ["SUCCEEDED", "FINISHED", "仅失败维度"],
  ])("定向重试拒绝所选维度 %s / 原调用 %s", async (status, callState, message) => {
    const root = await compose()
    Object.assign(root, { type: "IDEATION", status: "WAITING_RECONCILIATION" })
    state.groups.push({ id: "target", taskId: root.id, status, currentCallId: "target-call" })
    await state.db.chetaidouCall.create({
      data: { id: "target-call", rootTaskId: root.id, state: callState },
    })
    await expect(
      service.retryTask(7, root.id, { idempotencyKey: "unsafe-target", groupIds: ["target"] })
    ).rejects.toThrow(message)
    expect(state.tasks.filter(t => t.operation === "RETRY")).toHaveLength(0)
    expect(state.tasks.find(t => t.id === root.id).status).toBe("WAITING_RECONCILIATION")
    expect(state.groups[0].status).toBe(status)
  })

  it.each(["RUNNING", "WAITING_RECONCILIATION"])(
    "根任务 %s 且已有排队重试时，其他失败维度仍可重试",
    async status => {
      const root = await compose()
      Object.assign(root, { type: "IDEATION", status })
      state.groups.push(
        { id: "pending", taskId: root.id, status: "PENDING" },
        { id: "failed", taskId: root.id, status: "FAILED" }
      )
      await state.db.chetaidouTask.create({
        data: { id: "queued-retry", rootTaskId: root.id, operation: "RETRY", status: "QUEUED" },
      })
      await service.retryTask(7, root.id, { idempotencyKey: "another-retry", groupIds: ["failed"] })
      expect(state.tasks.filter(t => t.operation === "RETRY")).toHaveLength(2)
      expect(state.groups.every(g => g.status === "PENDING")).toBe(true)
    }
  )

  it.each(["依次完成", "同时完成", "取消第二笔"])(
    "不同失败维度并行调用（%s），独立收尾且保留全部成功结果",
    async mode => {
      const h = await ideationHarness(3)
      const base = h.completeMultimodal.getMockImplementation()!
      h.completeMultimodal.mockImplementation(async (request: any) => {
        const input = JSON.parse(request.messages.at(-1).content)
        return input.dimensions ? h.respond("invalid json") : base(request)
      })
      await h.runner.execute(h.taskId)
      const [firstGroup, secondGroup] = state.groups
      // 模拟 MySQL 事务持有根任务行锁直到提交，模型调用不持锁。
      const transaction = state.db.$transaction.getMockImplementation()
      let committed = Promise.resolve()
      state.db.$transaction.mockImplementation((fn: any) => {
        const result = committed.then(() => transaction(fn))
        committed = result.catch(() => undefined)
        return result
      })
      const first = await service.retryTask(7, h.taskId, {
        idempotencyKey: "parallel-first",
        groupIds: [firstGroup.id],
      })
      const second = await service.retryTask(7, h.taskId, {
        idempotencyKey: "parallel-second",
        groupIds: [secondGroup.id],
      })
      const responses = new Map<string, () => void>()
      h.completeMultimodal.mockClear()
      h.completeMultimodal.mockImplementation(async (request: any) => {
        const input = JSON.parse(request.messages.at(-1).content)
        await new Promise<void>(resolve => responses.set(input.dimensions[0].key, resolve))
        return h.respond(h.outputGroups(input.dimensions))
      })
      const firstExecution = h.runner.execute(first.taskId)
      if (mode === "取消第二笔") {
        await new Promise<void>(resolve => setImmediate(resolve))
        await service.cancelTask(7, second.taskId)
        expect(state.tasks.find(t => t.id === h.taskId)).toMatchObject({
          status: "RUNNING",
          finishedAt: null,
        })
        responses.get(firstGroup.key)!()
        await firstExecution
      } else {
        const secondExecution = h.runner.execute(second.taskId)
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(h.completeMultimodal).toHaveBeenCalledTimes(2)
        expect(h.runner.activeTaskIds()).toEqual(
          expect.arrayContaining([h.taskId, first.taskId, second.taskId])
        )
        responses.get(firstGroup.key)!()
        if (mode === "同时完成") {
          responses.get(secondGroup.key)!()
          await Promise.all([firstExecution, secondExecution])
        } else {
          await firstExecution
          expect(state.tasks.find(t => t.id === h.taskId)).toMatchObject({
            status: "RUNNING",
            finishedAt: null,
          })
          responses.get(secondGroup.key)!()
          await secondExecution
        }
        expect(state.tasks.find(t => t.id === first.taskId).status).toBe("SUCCEEDED")
        expect(state.tasks.find(t => t.id === second.taskId).status).toBe("SUCCEEDED")
        expect(state.draft.activeGroupRefs).toContainEqual({ groupId: secondGroup.id })
      }
      expect(state.tasks.find(t => t.id === h.taskId).status).toBe("PARTIAL")
      expect(state.draft.activeGroupRefs).toContainEqual({ groupId: firstGroup.id })
      expect(state.groups[2].status).toBe("FAILED")
      expect(h.runner.activeTaskIds()).toEqual([])
    }
  )

  it("核对一笔重试只恢复其自身维度，不执行其他排队重试", async () => {
    const h = await ideationHarness(3)
    const base = h.completeMultimodal.getMockImplementation()!
    h.completeMultimodal.mockImplementation(async (request: any) => {
      const input = JSON.parse(request.messages.at(-1).content)
      return input.dimensions ? h.respond("invalid json") : base(request)
    })
    await h.runner.execute(h.taskId)
    const [firstGroup, secondGroup] = state.groups
    secondGroup.currentCallId = null
    const first = await service.retryTask(7, h.taskId, {
      idempotencyKey: "reconcile-first",
      groupIds: [firstGroup.id],
    })
    await service.retryTask(7, h.taskId, {
      idempotencyKey: "queued-second",
      groupIds: [secondGroup.id],
    })
    h.completeMultimodal.mockRejectedValueOnce(new Error("connection lost"))
    await h.runner.execute(first.taskId)
    expect(state.tasks.find(t => t.id === first.taskId).status).toBe("WAITING_RECONCILIATION")
    await state.db.chetaidouCall.update({
      where: { id: firstGroup.currentCallId },
      data: { gatewayResponse: h.respond(h.outputGroups([firstGroup.definition])).completion },
    })
    h.completeMultimodal.mockClear()
    await h.runner.execute(first.taskId, true)
    expect(h.completeMultimodal).not.toHaveBeenCalled()
    expect(firstGroup.status).toBe("SUCCEEDED")
    expect(secondGroup.status).toBe("PENDING")
    expect(state.tasks.find(t => t.id === h.taskId).status).toBe("RUNNING")
  })

  it("认领重试时维度已恢复成功，事务回滚且不创建新调用", async () => {
    const root = await compose()
    Object.assign(root, { type: "IDEATION", status: "WAITING_RECONCILIATION" })
    state.groups.push({ id: "failed", taskId: root.id, status: "FAILED" })
    const updateMany = state.db.chetaidouTask.updateMany.getMockImplementation()
    state.db.chetaidouTask.updateMany.mockImplementation(async (args: any) => {
      state.groups[0].status = "SUCCEEDED"
      return updateMany(args)
    })
    await expect(
      service.retryTask(7, root.id, { idempotencyKey: "stale-target", groupIds: ["failed"] })
    ).rejects.toThrow("维度状态已变化")
    expect(state.tasks.filter(t => t.operation === "RETRY")).toHaveLength(0)
    expect(state.tasks.find(t => t.id === root.id).status).toBe("WAITING_RECONCILIATION")
  })

  it("取消排队中的定向重试后，其他未知维度继续保持待核对", async () => {
    const root = await compose()
    Object.assign(root, { type: "IDEATION", status: "WAITING_RECONCILIATION" })
    state.groups.push(
      { id: "failed", taskId: root.id, status: "FAILED" },
      { id: "unknown", taskId: root.id, status: "UNKNOWN", currentCallId: "unknown-call" }
    )
    await state.db.chetaidouCall.create({
      data: { id: "unknown-call", rootTaskId: root.id, state: "UNKNOWN" },
    })
    const retry = await service.retryTask(7, root.id, {
      idempotencyKey: "cancel-targeted-retry",
      groupIds: ["failed"],
    })
    await service.cancelTask(7, retry.taskId)
    expect(state.tasks.find(t => t.id === root.id)).toMatchObject({
      status: "WAITING_RECONCILIATION",
      finishedAt: null,
    })
    expect(state.groups[0].status).toBe("FAILED")
    expect(state.groups[1]).toMatchObject({ status: "UNKNOWN", currentCallId: "unknown-call" })
    expect(await state.db.chetaidouCall.findMany()).toHaveLength(1)
  })

  it("只修改执行参数保留已有组合和选项，调用期间 revision 变化仍写回联想结果", async () => {
    const h = await ideationHarness(3)
    state.draft.activeCompositionTaskId = "previous-compose"
    await service.putDraft(7, 19, {
      revision: state.draft.revision,
      settings: {
        ...state.draft.settings,
        model: "another-model",
        dimensionCountRange: { min: 24, max: 24 },
      },
      selections: [],
      customDimensions: [],
    })
    expect(state.draft.activeCompositionTaskId).toBe("previous-compose")
    await h.runner.execute(h.taskId)
    expect(state.draft.activeGroupRefs).toHaveLength(3)
    expect(state.draft.settings.model).toBe("another-model")
    expect((await service.getDraft(7, 19)).ideationStale).toBe(false)
  })

  it("联想收尾遇到执行参数保存的 CAS 冲突时重读草稿，不丢成功维度引用", async () => {
    const h = await ideationHarness(3)
    const original = state.db.chetaidouDraft.updateMany.getMockImplementation()
    let raced = false
    state.db.chetaidouDraft.updateMany.mockImplementation(async (args: any) => {
      if (!raced && args.data.activeGroupRefs) {
        raced = true
        state.draft.revision++
        state.draft.settings.optionCountRange = { min: 100, max: 200 }
        return { count: 0 }
      }
      return original(args)
    })
    await h.runner.execute(h.taskId)
    expect(raced).toBe(true)
    expect(state.draft.activeGroupRefs).toHaveLength(3)
    expect(state.draft.settings.optionCountRange).toEqual({ min: 100, max: 200 })
  })

  it.each([false, true])("三维已全部成功可直接组合，不再要求至少十维；旧快照=%s", async legacy => {
    const h = await ideationHarness(3)
    await h.runner.execute(h.taskId)
    if (legacy) delete state.tasks.find(t => t.id === h.taskId).snapshot.execution
    state.draft.selections = [{ groupId: state.groups[0].id, optionKeys: ["o0"] }]
    const result: any = await service.createTask(7, {
      type: "COMPOSE",
      imageId: 19,
      idempotencyKey: "compose-three",
      draftRevision: state.draft.revision,
    })
    expect(state.tasks.find(t => t.id === result.taskId).type).toBe("COMPOSE")
  })

  it("只有三维的成功联想也可刷新其中一维", async () => {
    const h = await ideationHarness(3)
    await h.runner.execute(h.taskId)
    state.groups[0].definition.selectionMode = "multi"
    expect(
      (await service.getTaskGroup(7, h.taskId, state.groups[0].id)).definition.selectionMode
    ).toBe("single")
    const detail: any = await service.getTask(7, h.taskId)
    expect(detail.groups.every((g: any) => g.selectionMode === "single")).toBe(true)
    expect(state.groups[0].definition.selectionMode).toBe("multi")
    state.db.chetaidouGroup.create.mockImplementation(async ({ data }: any) => {
      const group = { id: "refreshed-group", ...data }
      state.groups.push(group)
      return structuredClone(group)
    })
    const result: any = await service.createTask(7, {
      type: "REFRESH_GROUP",
      imageId: 19,
      groupId: state.groups[0].id,
      idempotencyKey: "refresh-three",
      draftRevision: state.draft.revision,
    })
    expect(state.tasks.find(t => t.id === result.taskId).type).toBe("REFRESH_GROUP")
    expect(
      state.tasks.find(t => t.id === result.taskId).snapshot.refresh.definition.selectionMode
    ).toBe("single")
    expect(state.groups.find(g => g.taskId === result.taskId).definition.selectionMode).toBe(
      "single"
    )
    expect(state.draft.pendingRefreshTaskId).toBe(result.taskId)
  })

  it.each(["single", "multi"])(
    "用户自建 %s 维度在 AI 生成选项及应用后保留选择模式",
    async selectionMode => {
      const h = await ideationHarness(3)
      const saved = await service.putDraft(7, 19, {
        revision: state.draft.revision,
        settings: state.draft.settings,
        selections: [],
        customDimensions: [{ label: "自建背景", selectionMode, options: [] }],
      })
      const dimension = (saved.customDimensions as any[])[0]
      const created = await service.createTask(7, {
        type: "DIVERGE",
        imageId: 19,
        customDimensionId: dimension.id,
        idempotencyKey: "custom-diverge",
        draftRevision: saved.revision,
      })
      h.completeMultimodal.mockImplementation(async () =>
        h.respond({ options: h.outputGroups([{ key: "custom" }]).groups[0].options })
      )
      await h.runner.execute(created.taskId)
      const request = h.completeMultimodal.mock.calls[0][0]
      expect(JSON.parse(request.messages[1].content).dimension.selectionMode).toBe(selectionMode)
      expect(state.tasks.find(t => t.id === created.taskId).status).toBe("SUCCEEDED")
      const updated = (await service.getDraft(7, 19)).customDimensions as any[]
      expect(updated[0].selectionMode).toBe(selectionMode)
      expect(updated[0].options).toHaveLength(2)
      expect(updated[0].options.every((o: any) => o.origin === "AI")).toBe(true)
      const selectedKeys = updated[0].options.map((o: any) => o.key)
      const saveSelection = () =>
        service.putDraft(7, 19, {
          revision: state.draft.revision,
          settings: state.draft.settings,
          selections: [],
          customDimensions: [{ ...updated[0], selectedKeys }],
        })
      if (selectionMode === "single")
        await expect(saveSelection()).rejects.toThrow("单选维度不可选择多个方案")
      else expect((await saveSelection()).customDimensions).toMatchObject([{ selectedKeys }])
    }
  )

  it.each(["show", "translate"])(
    "未选联想方案时，历史维度不拦截德国站 %s 文字组合",
    async textMode => {
      const h = await ideationHarness(3)
      await h.runner.execute(h.taskId)
      state.breakdown.payload.textInventory = [
        {
          textId: "headline",
          sourceText: "Reliable Lithium Power",
          category: "marketing",
          editable: true,
          readability: "readable",
        },
      ]
      await service.putDraft(7, 19, {
        revision: state.draft.revision,
        settings: { ...state.draft.settings, site: "amazon_de", textMode },
        selections: [],
        customDimensions: [],
      })
      expect(state.draft.activeGroupRefs).toHaveLength(3)
      expect((await service.getDraft(7, 19)).ideationStale).toBe(false)
      const task = await compose()
      expect(task.snapshot.settings).toMatchObject({ site: "amazon_de", textMode })
      expect(task.snapshot.resolvedSelections).toEqual([])
      const targetText = "Zuverlässige Lithium-Energie"
      const output = {
        ...composeOutput(true),
        editPromptEn: `Replace the marketing headline with "${targetText}".`,
        copyAdditions:
          textMode === "show"
            ? [{ targetText, targetLocale: "de-DE", meaningCn: "可靠的锂电动力" }]
            : [],
        textReplacements:
          textMode === "translate"
            ? [
                {
                  textId: "headline",
                  sourceText: "Reliable Lithium Power",
                  targetText,
                  targetLocale: "de-DE",
                },
              ]
            : [],
      }
      await composeRunner([output]).execute(task.id)
      expect(task.status).toBe("SUCCEEDED")
      expect(task.output.editPromptEn).toContain(targetText)
    }
  )

  it.each(["PARTIAL", "RUNNING", "WAITING_RECONCILIATION"])(
    "联想 %s 时默认可用已成功方案组织提示词，无需允许部分结果参数",
    async status => {
      const h = await ideationHarness(3)
      await h.runner.execute(h.taskId)
      state.tasks.find(t => t.id === h.taskId).status = status
      state.groups[1].status = "FAILED"
      state.groups[2].status = status === "RUNNING" ? "RUNNING" : "UNKNOWN"
      state.draft.selections = [{ groupId: state.groups[0].id, optionKeys: ["o0"] }]
      const task = await compose()
      const selectionId = state.groups[0].options[0].selectionId
      expect(task.snapshot.resolvedSelections).toMatchObject([{ selectionId }])
      await composeRunner([{ ...composeOutput(true), coveredSelectionIds: [selectionId] }]).execute(
        task.id
      )
      expect(task).toMatchObject({ status: "SUCCEEDED", output: { status: "READY" } })
    }
  )

  it("成功维度缺少文案和货篮必需维度时仍可组织提示词", async () => {
    state.breakdown.payload.basketContents = { hasItems: true, items: [], evidence: "有物品" }
    state.draft.settings = { ...defaultSettings(), site: "amazon_us", textMode: "show" }
    const created: any = await service.createTask(7, {
      type: "IDEATION",
      imageId: 19,
      idempotencyKey: "required-incomplete",
    })
    state.tasks.find(t => t.id === created.taskId).status = "PARTIAL"
    state.groups.push({
      id: "visual-only",
      taskId: created.taskId,
      status: "SUCCEEDED",
      definition: { key: "background", label: "背景", kind: "visual" },
      options: [
        {
          key: "o0",
          selectionId: "background-option",
          label: "户外",
          changeInstruction: "Use an outdoor background",
        },
      ],
    })
    state.draft.activeGroupRefs = [{ groupId: "visual-only" }]
    state.draft.selections = [{ groupId: "visual-only", optionKeys: ["o0"] }]
    const task = await compose()
    expect(task.snapshot.resolvedSelections).toMatchObject([{ selectionId: "background-option" }])
    await composeRunner([
      {
        ...composeOutput(true),
        coveredSelectionIds: ["background-option"],
        editPromptEn: 'Use an outdoor background and add "Outdoor freedom".',
        copyAdditions: [
          { targetText: "Outdoor freedom", targetLocale: "en-US", meaningCn: "户外自由" },
        ],
      },
    ]).execute(task.id)
    expect(task).toMatchObject({ status: "SUCCEEDED", output: { status: "READY" } })
  })

  it("维度刷新排队中仍可使用旧版选择组合，刷新应用后旧组合按版本规则失效", async () => {
    const h = await ideationHarness(3)
    await h.runner.execute(h.taskId)
    const group = state.groups[0]
    state.draft.selections = [{ groupId: group.id, optionKeys: ["o0"] }]
    const refresh: any = await service.createTask(7, {
      type: "REFRESH_GROUP",
      imageId: 19,
      groupId: group.id,
      idempotencyKey: "refresh-before-compose",
      draftRevision: state.draft.revision,
    })
    state.groups.find(g => g.taskId === refresh.taskId).id = "refreshed-group"
    const task = await compose()
    expect(task.snapshot.resolvedSelections).toMatchObject([{ groupId: group.id }])
    expect(state.draft.pendingRefreshTaskId).toBe(refresh.taskId)
    await composeRunner([
      { ...composeOutput(true), coveredSelectionIds: [group.options[0].selectionId] },
    ]).execute(task.id)
    expect((await service.getComposition(7, task.id)).isStale).toBe(false)
    h.completeMultimodal.mockResolvedValueOnce(
      h.respond({
        group: {
          ...group.definition,
          options: h
            .outputGroups([group.definition])
            .groups[0].options.map((option: any, i: number) => ({
              ...option,
              key: `new${i}`,
              label: `新方案${i}`,
            })),
        },
      })
    )
    await h.runner.execute(refresh.taskId)
    expect(state.draft.pendingRefreshTaskId).toBeNull()
    expect(state.tasks.find(t => t.id === refresh.taskId)).toMatchObject({
      status: "SUCCEEDED",
      output: { applied: false, canApply: true },
    })
    expect((await service.getComposition(7, task.id)).isStale).toBe(false)
    await service.applyTask(7, refresh.taskId, state.draft.revision)
    expect((await service.getComposition(7, task.id)).isStale).toBe(true)
  })

  it("整批 JSON 无效直接失败且不扣费，不自动修复", async () => {
    const h = await ideationHarness(3)
    const base = h.completeMultimodal.getMockImplementation()!
    h.completeMultimodal.mockImplementation(async (request: any) => {
      const input = JSON.parse(request.messages.at(-1).content)
      if (input.originalInput) return h.respond({ groups: [] })
      if (input.dimensions) return h.respond("bad-json")
      return base(request)
    })
    await h.runner.execute(h.taskId)
    expect(h.completeMultimodal).toHaveBeenCalledTimes(2)
    expect(billing.settleTextInTx).not.toHaveBeenCalled()
    expect(state.groups.every(g => g.status === "FAILED")).toBe(true)
  })

  it("整批网络中断所有关联维度待核对，不扣费、不自动重试", async () => {
    const h = await ideationHarness(3)
    const base = h.completeMultimodal.getMockImplementation()!
    h.completeMultimodal.mockImplementation(async (request: any) => {
      const input = JSON.parse(request.messages.at(-1).content)
      if (input.dimensions) throw Error("网络中断")
      return base(request)
    })
    await h.runner.execute(h.taskId)
    expect(state.groups.every(g => g.status === "UNKNOWN")).toBe(true)
    expect(state.tasks.find(t => t.id === h.taskId).status).toBe("WAITING_RECONCILIATION")
    expect(billing.settleTextInTx).not.toHaveBeenCalled()
    await expect(
      service.retryTask(7, h.taskId, { idempotencyKey: "unsafe-retry" })
    ).rejects.toThrow("先核对")
    await h.runner.execute(h.taskId)
    expect(h.completeMultimodal).toHaveBeenCalledTimes(2)
  })

  it.each(["识别", "扩展"])("%s等待超时明确失败、返回重试提示且允许手动重试", async stage => {
    const h = await ideationHarness(3)
    const base = h.completeMultimodal.getMockImplementation()!
    h.completeMultimodal.mockImplementation(async (request: any) => {
      const input = JSON.parse(request.messages.at(-1).content)
      if ((stage === "扩展") === !!input.dimensions) throw new GatewayTimeoutException("网关超时")
      return base(request)
    })
    await h.runner.execute(h.taskId)
    const result = await service.getTask(7, h.taskId)
    expect(result).toMatchObject({
      status: "FAILED",
      errorCode: "PROVIDER_TIMEOUT",
      errorMessage: "等待超时，请重试。",
    })
    if (stage === "扩展") {
      expect(result.groups).toHaveLength(3)
      expect(
        result.groups.every(
          (g: any) => g.status === "FAILED" && g.errorMessage === "等待超时，请重试。"
        )
      ).toBe(true)
    }
    const failedCall = await state.db.chetaidouCall.findFirst({
      where: { errorCode: "PROVIDER_TIMEOUT" },
    })
    expect(failedCall).toMatchObject({
      state: "FINISHED",
      outcome: "PROVIDER_FAILED",
      billingStatus: "REVIEW",
      errorMessage: "网关超时",
    })
    expect(Number.isFinite(failedCall.finishedAt.getTime())).toBe(true)
    expect(billing.settleTextInTx).not.toHaveBeenCalled()
    expect(h.runner.activeTaskIds()).toEqual([])
    expect(h.completeMultimodal).toHaveBeenCalledTimes(stage === "识别" ? 1 : 2)

    h.completeMultimodal.mockImplementation(base)
    const retry = await service.retryTask(7, h.taskId, { idempotencyKey: "retry-timeout" })
    await h.runner.execute(retry.taskId)
    expect((await service.getTask(7, h.taskId)).status).toBe("SUCCEEDED")
    expect(h.completeMultimodal).toHaveBeenCalledTimes(3)
    expect(
      (await state.db.chetaidouCall.findUnique({ where: { id: failedCall.id } })).billingStatus
    ).toBe("REVIEW")
  })

  it("部分批次超时保留成功方案，定向重试只重发超时维度", async () => {
    const h = await ideationHarness(6)
    const base = h.completeMultimodal.getMockImplementation()!
    h.completeMultimodal.mockImplementation(async (request: any) => {
      const input = JSON.parse(request.messages.at(-1).content)
      if (input.dimensions?.some((g: any) => g.key === "g3"))
        throw new GatewayTimeoutException("网关超时")
      return base(request)
    })
    await h.runner.execute(h.taskId)
    expect(state.tasks.find(t => t.id === h.taskId).status).toBe("PARTIAL")
    const succeeded = state.groups.filter(g => g.status === "SUCCEEDED")
    const savedOptions = structuredClone(succeeded.map(g => g.options))
    const failed = state.groups.filter(g => g.status === "FAILED")
    expect(succeeded).toHaveLength(3)
    expect(failed).toHaveLength(3)
    expect(
      (await service.getTask(7, h.taskId)).groups
        .filter((g: any) => g.status === "FAILED")
        .every((g: any) => g.errorMessage === "等待超时，请重试。")
    ).toBe(true)
    h.completeMultimodal.mockImplementation(base)
    const retry = await service.retryTask(7, h.taskId, {
      idempotencyKey: "retry-timeout-groups",
      groupIds: failed.map(g => g.id),
    })
    await h.runner.execute(retry.taskId)
    expect((await service.getTask(7, h.taskId)).status).toBe("SUCCEEDED")
    expect(succeeded.map(g => g.options)).toEqual(savedOptions)
    expect(h.completeMultimodal).toHaveBeenCalledTimes(4)
    const retryInput = JSON.parse(h.completeMultimodal.mock.calls[3][0].messages.at(-1).content)
    expect(retryInput.dimensions.map((g: any) => g.key)).toEqual(failed.map(g => g.key))
  })

  it("组合等待超时结束任务并允许手动重试", async () => {
    const task = await compose()
    const completeMultimodal = jest.fn().mockRejectedValue(new GatewayTimeoutException("网关超时"))
    const runner = new ChetaidouTaskRunnerService(
      state.db,
      { completeMultimodal } as never,
      billing,
      {} as never
    )
    await runner.execute(task.id)
    expect(await service.getTask(7, task.id)).toMatchObject({
      status: "FAILED",
      errorCode: "PROVIDER_TIMEOUT",
      errorMessage: "等待超时，请重试。",
    })
    expect(completeMultimodal).toHaveBeenCalledTimes(1)
    const retry = await service.retryTask(7, task.id, { idempotencyKey: "retry-compose-timeout" })
    completeMultimodal.mockResolvedValue({
      completion: { choices: [{ message: { content: JSON.stringify(composeOutput(true)) } }] },
      requestId: "retry-compose-request",
    })
    billing.lookupTextUsage = jest.fn().mockResolvedValue(null)
    billing.settleTextInTx = jest.fn().mockResolvedValue("PENDING")
    await runner.execute(retry.taskId)
    expect((await service.getTask(7, task.id)).status).toBe("SUCCEEDED")
    expect(completeMultimodal).toHaveBeenCalledTimes(2)
  })

  it("非法范围返回400，不写入草稿", async () => {
    await expect(
      service.putDraft(7, 19, {
        revision: state.draft.revision,
        settings: { ...defaultSettings(), dimensionCountRange: { min: 8, max: 2 } },
        selections: [],
        customDimensions: [],
      })
    ).rejects.toMatchObject({ status: 400 })
    expect(state.draft.revision).toBe(0)
  })

  it("定向重试只执行指定失败组，根任务重新聚合且成功组进入草稿", async () => {
    const root = await compose()
    delete root.snapshot.execution // 明确覆盖历史单维任务重试兼容。
    Object.assign(root, {
      type: "IDEATION",
      status: "PARTIAL",
      acceptedDraftRevision: state.draft.revision,
    })
    state.draft.activeIdeationTaskId = root.id
    state.draft.activeGroupRefs = [{ groupId: "ok" }]
    for (const id of ["ok", "retry", "other"])
      state.groups.push({
        id,
        taskId: root.id,
        status: id === "ok" ? "SUCCEEDED" : "FAILED",
        definition: { key: id, label: id },
        options: [],
        order: 1,
      })
    const result = await service.retryTask(7, root.id, {
      idempotencyKey: "retry",
      groupIds: ["retry"],
    })
    const retry = state.tasks.find(t => t.id === result.taskId)
    const runner: any = new ChetaidouTaskRunnerService(state.db, {} as never, billing, {} as never)
    const expand = jest
      .spyOn(runner, "expandGroup")
      .mockImplementation(async (_t: any, _s: any, group: any) => {
        state.groups.find(g => g.id === group.id).status = "SUCCEEDED"
        await runner.bumpProgress(retry)
      })
    await runner.runIdeation(retry)
    expect(expand).toHaveBeenCalledTimes(1)
    expect((expand.mock.calls[0][2] as any).id).toBe("retry")
    expect(root.status).toBe("PARTIAL")
    expect(root.progress).toMatchObject({ total: 3, succeeded: 2, failed: 1 })
    expect(state.draft.activeGroupRefs).toContainEqual({ groupId: "retry" })
    expect(state.groups.find(g => g.id === "other").status).toBe("FAILED")
    const second = await service.retryTask(7, root.id, {
      idempotencyKey: "retry-other",
      groupIds: ["other"],
    })
    await runner.runIdeation(state.tasks.find(t => t.id === second.taskId))
    expect(root.status).toBe("SUCCEEDED")
    expect(state.draft.activeGroupRefs).toHaveLength(3)
  })
  it("原图型号文字作为观察保留，资料隔离规则单独传入且不改写历史模板", async () => {
    const hardRule = "保持当前 SKU 已确认的真实部件数量、连接关系、几何和外观身份。"
    const isolationRule = "不得借用其他商品资料；不能仅凭原图 C1S 字样判定跨 SKU 混用。"
    state.fact.content = { hardConstraints: [hardRule], dataIsolationRules: [isolationRule] }
    state.draft.settings = { ...defaultSettings(), site: "amazon_de", textMode: "show" }
    state.breakdown.payload.textInventory = [
      {
        textId: "model",
        sourceText: "C1S Lithium Battery",
        category: "model",
        editable: false,
        readability: "readable",
      },
    ]
    const task = await compose()
    const instructionEn =
      "Preserve the confirmed component count, connections, geometry and identity."
    const output = {
      ...composeOutput(true),
      editPromptEn: `${instructionEn} Preserve the source label "C1S Lithium Battery" without asserting model compatibility. Add "Für jeden Tag" as marketing copy.`,
      copyAdditions: [
        { targetText: "Für jeden Tag", targetLocale: "de-DE", meaningCn: "为每一天" },
      ],
      hardConstraintChecks: [{ constraintId: "fact_hard_1", status: "preserved", instructionEn }],
    }
    const runner = composeRunner([output])
    await runner.runCompose(task)
    const request = runner.callLlm.mock.calls[0][1]
    const input = JSON.parse(request.messages[1].content)
    expect(input.facts.dataIsolationRules).toEqual([isolationRule])
    expect(input.facts.hardConstraints).toEqual([hardRule])
    expect(input).not.toHaveProperty("productHardConstraints")
    expect(input.breakdown.textInventory[0].sourceText).toBe("C1S Lithium Battery")
    expect(request.messages[0].content).toContain("仅因原图出现 C1S 等历史型号字样，不得判定")
    expect(state.tasks[0].output.status).toBe("READY")
    expect(state.tasks[0].output.editPromptEn).toContain("C1S Lithium Battery")

    const historical = structuredClone(task)
    historical.id = "historical-compose"
    historical.rootTaskId = historical.id
    historical.snapshot.prompt = { version: "old", templateBodies: { composition: "历史组合模板" } }
    state.tasks.push(historical)
    const oldRunner = composeRunner([output])
    await oldRunner.runCompose(historical)
    expect(oldRunner.callLlm.mock.calls[0][1].messages[0].content).toBe("历史组合模板")
  })

  it("符合 PRD 的组合无需扩展检查，生图不追加事实原文", async () => {
    const rule = "不加把手篮，不改变中部货篮位置和连接。"
    state.fact.content = { hardConstraints: [rule] }
    const task = await compose()
    const output = {
      ...composeOutput(true),
      editPromptEn:
        "Keep the background and central basket connections; do not add a handlebar basket.",
    }
    const runner = composeRunner([output])
    await runner.runCompose(task)
    const saved = state.tasks.find(t => t.id === task.id)
    expect(saved).toMatchObject({ status: "SUCCEEDED", output: { status: "READY" } })
    expect(saved.output.editPromptEn).toBe(output.editPromptEn)
    const request = runner.callLlm.mock.calls[0][1]
    const input = JSON.parse(request.messages[1].content)
    expect(input.facts.hardConstraints).toEqual([rule])
    expect(input).not.toHaveProperty("productHardConstraints")
    expect(request.messages[0].content).not.toContain("hardConstraintChecks")
    expect(runner.callLlm).toHaveBeenCalledTimes(1)
    const generated: any = await service.createTask(7, {
      type: "GENERATE",
      imageId: 19,
      compositionTaskId: task.id,
      count: 1,
      aspectRatio: "16:9",
      idempotencyKey: "prd-generate",
    })
    const job = await state.db.imageGenJob.findUnique({ where: { id: generated.imageGenJobId } })
    expect(job.prompt).toBe(generationCanvasPrompt(output.editPromptEn, "16:9"))
    expect(job.prompt).toContain("中心裁剪安全构图：")
    expect(job.prompt).toContain("裁剪为16:9比例的图像画面")
    expect(job.prompt).not.toContain(rule)
    expect(job.prompt).not.toContain("Confirmed product constraints")
    expect(job.request.prompt).toBe(job.prompt)
    const snapshot = state.tasks.find(t => t.id === generated.taskId).snapshot
    expect(snapshot.composition.editPromptEn).toBe(output.editPromptEn)
    expect(snapshot.generation.generationPromptVersion).toBe("canvas-v2")
  })

  it("旧冻结模板与回执保持原样，扩展指令改写不再导致失败或阻止生图", async () => {
    state.fact.content = { hardConstraints: ["不加把手货篮。"] }
    const task = await compose()
    task.snapshot.prompt = {
      version: "a1-20261007-sku-isolation-v5",
      templateBodies: { composition: "旧组合规则：hardConstraintChecks 必须逐字进入 editPromptEn" },
    }
    state.tasks.find(t => t.id === task.id).snapshot = structuredClone(task.snapshot)
    const output = {
      ...composeOutput(true),
      editPromptEn: "Keep the original vehicle with no added baskets.",
      hardConstraintChecks: [
        {
          constraintId: "fact_hard_1",
          status: "preserved",
          instructionEn: "Do not add a handlebar basket.",
        },
      ],
    }
    const original = structuredClone(output)
    const runner = composeRunner([output])
    await runner.runCompose(task)
    const request = runner.callLlm.mock.calls[0][1]
    expect(request.messages[0].content).toBe(task.snapshot.prompt.templateBodies.composition)
    expect(JSON.parse(request.messages[1].content).productHardConstraints).toEqual(
      productHardConstraints(state.fact.content)
    )
    const saved = state.tasks.find(t => t.id === task.id)
    expect(saved.status).toBe("SUCCEEDED")
    expect(saved.output.editPromptEn).toBe(output.editPromptEn)
    expect(saved.output).not.toHaveProperty("hardConstraintChecks")
    expect(output).toEqual(original)
    const generated: any = await service.createTask(7, {
      type: "GENERATE",
      imageId: 19,
      compositionTaskId: task.id,
      count: 1,
      aspectRatio: "1:1",
      idempotencyKey: "legacy-prd-generate",
    })
    const job = await state.db.imageGenJob.findUnique({ where: { id: generated.imageGenJobId } })
    expect(job.request.prompt).toBe(generationCanvasPrompt(output.editPromptEn, "1:1"))
    expect(runner.callLlm).toHaveBeenCalledTimes(1)
  })

  it("硬事实冲突仍进入阻断问答，不能提交生图", async () => {
    state.fact.content = { hardConstraints: ["不加把手货篮。"] }
    const task = await compose()
    const output = composeOutput(false)
    output.conflicts = [{ ...output.conflicts[0], blocking: true, choices: [] }]
    await composeRunner([output]).runCompose(task)
    expect(state.tasks.find(t => t.id === task.id).output).toMatchObject({
      status: "NEEDS_RESOLUTION",
      editPromptEn: null,
    })
    await expect(
      service.createTask(7, {
        type: "GENERATE",
        imageId: 19,
        compositionTaskId: task.id,
        count: 1,
        aspectRatio: "1:1",
        idempotencyKey: "blocked-generate",
      })
    ).rejects.toThrow()
    expect(state.db.imageGenJob.create).not.toHaveBeenCalled()
  })

  it("生图提交在模型检查期间草稿变化时 CAS 拦截，不创建批次", async () => {
    const task = await compose()
    await executeCompose(task, true)
    billing.assertModelsReady.mockImplementationOnce(async () => {
      state.draft.revision++
      state.draft.activeCompositionTaskId = null
      return context.resolveModels()
    })
    await expect(
      service.createTask(7, {
        type: "GENERATE",
        imageId: 19,
        compositionTaskId: task.id,
        count: 1,
        aspectRatio: "1:1",
        idempotencyKey: "generate",
      })
    ).rejects.toThrow(ConflictException)
    expect(state.db.imageGenJob.create).not.toHaveBeenCalled()
  })

  it("前端比例和尺寸冻结在 Job、Task；不会改写组合原提示词", async () => {
    const task = await compose()
    await executeCompose(task, true)
    const result = (await service.createTask(7, {
      type: "GENERATE",
      imageId: 19,
      compositionTaskId: task.id,
      count: 4,
      aspectRatio: "custom",
      customAspectW: 166,
      customAspectH: 182,
      resolutionTier: " 2k ",
      idempotencyKey: "generate-custom",
    })) as any
    const generated = state.tasks.find(t => t.id === result.taskId)
    expect(generated.snapshot.generation).toMatchObject({
      count: 4,
      aspectRatio: "166:182",
      requestedAspectRatio: "custom",
      resolutionTier: "2K",
      schemaVersion: 1,
    })
    expect(generated.snapshot.generation).not.toHaveProperty("quality")
    const job = await state.db.imageGenJob.findUnique({ where: { id: result.imageGenJobId } })
    expect(job.prompt).toContain("166:182")
    expect(job.request).not.toHaveProperty("quality")
    expect(generated.snapshot.composition.editPromptEn).toBe("Keep the original background.")
    expect(job.items).toHaveLength(4)
    expect(state.draft.activeCompositionTaskId).toBe(task.id)
    const details = (await service.getTask(7, result.taskId)) as any
    expect(details.generation).toMatchObject({
      model: "image",
      aspectRatio: "166:182",
      resolutionTier: "2K",
    })
    expect(details.generation).not.toHaveProperty("providerDefaults")
  })

  it("按实时网关能力冻结 21:9 + 2K 直传，一批多图及幂等重放只查询一次", async () => {
    const task = await compose()
    await executeCompose(task, true)
    jest.spyOn(service["imageOptions"], "fetchCapabilities").mockResolvedValue({
      detail: { modality: "image", facts: { modes: ["edit"] } },
      requestSchema: {
        version: 9,
        request_schema: {
          type: "object",
          properties: {
            aspect_ratio: { enum: ["21:9"] },
            resolution: { enum: ["2k"] },
          },
        },
      },
    } as never)
    const dto = {
      type: "GENERATE",
      imageId: 19,
      compositionTaskId: task.id,
      count: 4,
      aspectRatio: "21:9",
      resolutionTier: "2K",
      idempotencyKey: "native-generate",
    }
    const result: any = await service.createTask(7, dto)
    const generated = state.tasks.find(t => t.id === result.taskId)
    const job = await state.db.imageGenJob.findUnique({ where: { id: result.imageGenJobId } })
    expect(generated.snapshot.generation).toMatchObject({
      requestedAspectRatio: "21:9",
      aspectRatio: "21:9",
      providerApplied: { aspect_ratio: "21:9", resolution: "2k" },
      normalizationMode: "CROP_ONLY",
      schemaVersion: 9,
    })
    expect(job.request.generation).toEqual(generated.snapshot.generation)
    expect(job.prompt).toBe(generationCanvasPrompt("Keep the original background.", "21:9", true))
    expect(generated.input.aspectRatio).toBe("21:9")
    const details: any = await service.getTask(7, result.taskId)
    expect(details.generation).toMatchObject({ requestedAspectRatio: "21:9", aspectRatio: "21:9" })
    expect(job.items).toHaveLength(4)
    await service.createTask(7, { ...dto, aspectRatio: "7:3" })
    expect(service["imageOptions"].fetchCapabilities).toHaveBeenCalledTimes(1)
    expect(service["imageOptions"].fetchCapabilities).toHaveBeenCalledWith("image")
    expect(state.db.imageGenJob.create).toHaveBeenCalledTimes(1)
  })

  it("网关能力查询失败时不创建生图任务", async () => {
    const task = await compose()
    await executeCompose(task, true)
    jest
      .spyOn(service["imageOptions"], "fetchCapabilities")
      .mockRejectedValue(new Error("能力查询失败"))
    await expect(
      service.createTask(7, {
        type: "GENERATE",
        imageId: 19,
        compositionTaskId: task.id,
        count: 1,
        aspectRatio: "21:9",
        resolutionTier: "2K",
        idempotencyKey: "capability-failed",
      })
    ).rejects.toThrow("能力查询失败")
    expect(state.db.imageGenJob.create).not.toHaveBeenCalled()
  })

  it("新生成缺比例返回 400，旧缺比例幂等重放仍返回原任务", async () => {
    const task = await compose()
    await executeCompose(task, true)
    const dto = {
      type: "GENERATE",
      imageId: 19,
      compositionTaskId: task.id,
      count: 1,
      idempotencyKey: "legacy-generate",
    }
    await expect(service.createTask(7, dto)).rejects.toThrow("必须由前端传入")
    const requestHash = context.requestHash({
      type: dto.type,
      imageId: dto.imageId,
      compositionTaskId: dto.compositionTaskId,
      count: dto.count,
    })
    state.tasks.push({
      id: "legacy",
      rootTaskId: "legacy",
      type: "GENERATE",
      ownerId: 7,
      imageId: 19,
      skuId: 1,
      idempotencyKey: dto.idempotencyKey,
      requestHash,
      snapshot: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    expect(await service.createTask(7, dto)).toMatchObject({ id: "legacy" })
  })

  it("质量冻结到 Task/Job 并返回详情；等价重放不重建，更改质量同键冲突", async () => {
    const task = await compose()
    await executeCompose(task, true)
    const dto = {
      type: "GENERATE",
      imageId: 19,
      compositionTaskId: task.id,
      count: 2,
      aspectRatio: "16:9",
      resolutionTier: "2K",
      quality: " HD ",
      idempotencyKey: "generate-quality",
    }
    const created = (await service.createTask(7, dto)) as any
    const generated = state.tasks.find(t => t.id === created.taskId)
    expect(generated.snapshot.generation.quality).toBe("hd")
    expect(generated.input.quality).toBe("hd")
    const job = await state.db.imageGenJob.findUnique({ where: { id: created.imageGenJobId } })
    expect(job.request.generation.quality).toBe("hd")
    expect(((await service.getTask(7, created.taskId)) as any).generation.quality).toBe("hd")
    expect(await service.createTask(7, { ...dto, quality: "hd" })).toMatchObject({
      id: created.taskId,
    })
    await expect(service.createTask(7, { ...dto, quality: "standard" })).rejects.toThrow(
      ConflictException
    )
    expect(state.db.imageGenJob.create).toHaveBeenCalledTimes(1)
    await service.createTask(7, {
      ...dto,
      quality: "standard",
      idempotencyKey: "generate-standard",
    })
    expect(state.draft.activeCompositionTaskId).toBe(task.id)
    expect(state.db.imageGenJob.create).toHaveBeenCalledTimes(2)
  })

  it("非法质量及非 GENERATE 质量参数在创建任务前拒绝", async () => {
    for (const quality of [null, "", "auto", "high", 1]) {
      await expect(
        service.createTask(7, {
          type: "GENERATE",
          imageId: 19,
          idempotencyKey: "invalid-quality",
          quality,
        } as any)
      ).rejects.toThrow(BadRequestException)
    }
    await expect(
      service.createTask(7, {
        type: "COMPOSE",
        imageId: 19,
        idempotencyKey: "wrong-type",
        quality: "hd",
      })
    ).rejects.toThrow("质量参数仅可用于 GENERATE")
    expect(state.db.imageGenJob.create).not.toHaveBeenCalled()
  })

  it("改变尺寸不使组合过期；同键大小写等价重放，换参数同键 409", async () => {
    const task = await compose()
    await executeCompose(task, true)
    const dto = {
      type: "GENERATE",
      imageId: 19,
      compositionTaskId: task.id,
      count: 1,
      idempotencyKey: "generate-tier",
      aspectRatio: "16:9",
      resolutionTier: "2k",
    }
    const generated = (await service.createTask(7, dto)) as any
    expect(await service.createTask(7, { ...dto, resolutionTier: " 2K " })).toMatchObject({
      id: generated.taskId,
    })
    await expect(service.createTask(7, { ...dto, resolutionTier: "4K" })).rejects.toThrow(
      ConflictException
    )
    await service.createTask(7, {
      ...dto,
      aspectRatio: "1:1",
      resolutionTier: "4K",
      idempotencyKey: "another-generate",
    })
    expect(state.draft.activeCompositionTaskId).toBe(task.id)
    expect(state.db.imageGenJob.create).toHaveBeenCalledTimes(2)
  })

  it("模型在创建事务内变更时拒绝提交，不产生 Job", async () => {
    const task = await compose()
    await executeCompose(task, true)
    jest
      .spyOn(service["imageOptions"], "assertUnchanged")
      .mockRejectedValue(new ConflictException("模型配置已更新"))
    await expect(
      service.createTask(7, {
        type: "GENERATE",
        imageId: 19,
        compositionTaskId: task.id,
        count: 1,
        aspectRatio: "1:1",
        idempotencyKey: "model-changed",
      })
    ).rejects.toThrow(ConflictException)
    expect(state.db.imageGenJob.create).not.toHaveBeenCalled()
  })

  it("已删除或放弃的发散产物仍进入下一轮避重历史", async () => {
    state.draft.customDimensions = [
      { id: "dim", label: "背景", selectionMode: "multi", options: [], selectedKeys: [] },
    ]
    state.tasks.push({
      id: "old",
      ownerId: 7,
      imageId: 19,
      type: "DIVERGE",
      input: { customDimensionId: "dim" },
      output: { discarded: true, newOptions: [{ key: "old-opt", label: "海边" }] },
    })
    const result = await service.createTask(7, {
      type: "DIVERGE",
      imageId: 19,
      customDimensionId: "dim",
      idempotencyKey: "diverge",
    })
    expect(state.tasks.find(t => t.id === (result as any).taskId).input.history).toContainEqual({
      key: "old-opt",
      label: "海边",
    })
  })

  it("取消全部排队图片后批次立即终结；运行中文字不可取消", async () => {
    state.tasks.push({
      id: "image-task",
      rootTaskId: "image-task",
      ownerId: 7,
      type: "GENERATE",
      imageGenJobId: "job",
    })
    state.db.imageGenJob.findUnique.mockResolvedValue({
      id: "job",
      businessType: "CHETAIDOU",
      items: [{ status: "QUEUED" }],
    })
    state.db.imageGenItem.updateMany.mockResolvedValue({ count: 1 })
    state.db.imageGenItem.findMany.mockResolvedValue([{ status: "CANCELLED" }])
    state.db.imageGenJob.update.mockResolvedValue({})
    expect(await service.cancelTask(7, "image-task")).toEqual({
      cancelled: 1,
      pending: 0,
      note: null,
    })
    expect(state.db.imageGenJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) })
    )
    state.tasks.push({
      id: "text",
      rootTaskId: "text",
      ownerId: 7,
      type: "IDEATION",
      status: "RUNNING",
    })
    await expect(service.cancelTask(7, "text")).rejects.toThrow("仅排队")
  })

  it("旧生图记录从原命令回解修改摘要，不读取后来生成的新组合", async () => {
    state.tasks.push(
      { id: "old-compose", ownerId: 7, output: { summaryCn: "旧摘要" } },
      { id: "new-compose", ownerId: 7, output: { summaryCn: "新摘要" } },
      {
        id: "generate",
        rootTaskId: "generate",
        imageGenJobId: "job",
        ownerId: 7,
        skuId: 1,
        imageId: 19,
        type: "GENERATE",
        operation: "PRIMARY",
        snapshot: {},
        input: { compositionTaskId: "old-compose" },
      }
    )
    state.draft.activeCompositionTaskId = "new-compose"
    state.db.imageGenItem.count.mockResolvedValue(1)
    state.db.imageGenItem.findMany.mockResolvedValue([
      { id: 1, jobId: "job", idx: 0, status: "SUCCEEDED", fileKey: "result.png" },
    ])
    const result = await service.listResults(7, 1, { page: 1, pageSize: 20 })
    expect(result.items[0]).toMatchObject({ compositionTaskId: "old-compose", summaryCn: "旧摘要" })
  })

  it("多状态筛选先于分页，列表和快照返回相同目标信息", async () => {
    for (const [index, status] of ["SUCCEEDED", "QUEUED", "RUNNING"].entries())
      state.tasks.push({
        id: `t${index}`,
        rootTaskId: `t${index}`,
        ownerId: 7,
        imageId: 19,
        type: "DIVERGE",
        status,
        input: { customDimensionId: "dim" },
        updatedAt: new Date(index + 1),
      })
    const result = await service.listTasks(7, { status: "QUEUED,RUNNING", page: 1, pageSize: 1 })
    expect(result.total).toBe(2)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      status: "RUNNING",
      target: { customDimensionId: "dim" },
      imageTitle: "母版",
      imageNumber: "7",
    })
    const snapshot = await service.tasksStatus(7, ["t2"])
    expect(snapshot.items[0].target).toEqual(result.items[0].target)
    expect(snapshot.items[0].updatedAt).toEqual(result.items[0].updatedAt)
  })
  it("显式生图模型冻结到 Task 和 Job，同键换模型拒绝", async () => {
    const task = await compose()
    await executeCompose(task, true)
    jest.spyOn(service["imageOptions"], "resolveModel").mockResolvedValue({
      publicId: "ZQ-Image-1",
      gatewayConfig: {
        requestSchema: { version: 4, request_schema: { type: "object", properties: {} } },
      },
    } as never)
    const body = {
      type: "GENERATE",
      imageId: 19,
      compositionTaskId: task.id,
      count: 1,
      aspectRatio: "1:1",
      imageModel: "ZQ-Image-1",
      idempotencyKey: "selected-image",
    }
    const created: any = await service.createTask(7, body)
    const saved = state.tasks.find(row => row.id === created.taskId)
    const job = await state.db.imageGenJob.findUnique({ where: { id: created.imageGenJobId } })
    expect(service["imageOptions"].resolveModel).toHaveBeenCalledWith(undefined, "ZQ-Image-1")
    expect(service["imageOptions"].assertUnchanged).toHaveBeenCalledWith(
      state.db,
      expect.any(String),
      "ZQ-Image-1"
    )
    expect(saved.snapshot.models.image).toEqual({
      publicId: "ZQ-Image-1",
      category: "CHETAIDOU_IMAGE",
    })
    expect(job.model).toBe("ZQ-Image-1")
    expect(job.request.model).toBe("ZQ-Image-1")
    expect((await service.getTask(7, saved.id)).executionSettings.imageModel).toBe("ZQ-Image-1")
    expect((await service.createTask(7, body)) as any).toMatchObject({ id: saved.id })
    await expect(service.createTask(7, { ...body, imageModel: "other" })).rejects.toThrow(
      "不同请求"
    )
  })

  it.each(["IDEATION", "COMPOSE"])("未执行历史恢复后的首次%s复用原记录", async type => {
    state.draft.workspaceId = randomUUID()
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...state.draft.settings, customText: "冬季氛围" },
      selections: [],
      customDimensions: [],
    })
    const record = state.adjustments[0]
    expect(state.tasks).toHaveLength(0)
    await service.resetDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
    })
    const original = structuredClone(record)
    const restored = await service.restoreAdjustment(7, 19, record.id, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
    })
    expect(record).toEqual(original)
    expect(restored.activeAdjustmentId).toBe(record.id)
    expect(restored.restoredFromAdjustmentId).toBeNull()
    const created: any = await service.createTask(7, {
      type,
      imageId: 19,
      idempotencyKey: "resume-pending-history",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    expect({
      total: state.adjustments.length,
      adjustmentId: state.tasks.find(t => t.id === created.taskId).adjustmentId,
    }).toEqual({ total: 1, adjustmentId: record.id })
  })

  it("未执行历史恢复后修改要求仍更新原记录", async () => {
    state.draft.workspaceId = randomUUID()
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...state.draft.settings, customText: "冬季氛围" },
      selections: [],
      customDimensions: [],
    })
    const record = state.adjustments[0]
    const original = structuredClone(record)
    const restored = await service.restoreAdjustment(7, 19, record.id, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
    })
    expect(record).toEqual(original)
    expect(restored.activeAdjustmentId).toBe(record.id)
    expect(restored.restoredFromAdjustmentId).toBeNull()
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...state.draft.settings, customText: "雪夜氛围" },
      selections: [],
      customDimensions: [],
    })
    expect({
      total: state.adjustments.length,
      adjustmentId: state.draft.activeAdjustmentId,
    }).toEqual({ total: 1, adjustmentId: record.id })
    expect(record.state.settings.customText).toBe("雪夜氛围")
    expect((await service.getAdjustment(7, 19, record.id)).state).toEqual(record.state)
  })

  it.each(["IDEATION", "COMPOSE"])("%s失败且指针清空后恢复仍隔离已执行历史", async type => {
    state.draft.workspaceId = randomUUID()
    const created: any = await service.createTask(7, {
      type,
      imageId: 19,
      idempotencyKey: "failed-cleared-history",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    const task = state.tasks.find(t => t.id === created.taskId)
    task.status = "FAILED"
    const record = state.adjustments[0]
    record.state.activeIdeationTaskId = null
    record.state.activeCompositionTaskId = null
    const original = structuredClone(record)
    const restored = await service.restoreAdjustment(7, 19, record.id, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
    })
    expect(restored.activeAdjustmentId).toBeNull()
    expect(restored.restoredFromAdjustmentId).toBe(record.id)
    await service.putDraft(7, 19, {
      workspaceId: restored.workspaceId,
      revision: restored.revision,
      settings: { ...state.draft.settings, customText: "雪夜氛围" },
      selections: [],
      customDimensions: [],
    })
    expect(state.adjustments).toHaveLength(2)
    expect(state.adjustments[1].parentAdjustmentId).toBe(record.id)
    expect(record).toEqual(original)
  })

  it.each(["IDEATION", "COMPOSE"])("首次%s复用记录时同步实际事实卡和拆解版本", async type => {
    state.draft.workspaceId = randomUUID()
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...state.draft.settings, customText: "冬季氛围" },
      selections: [],
      customDimensions: [],
    })
    const record = state.adjustments[0]
    await state.db.chetaidouFactCard.create({
      data: { ...state.fact, id: 2, version: 2, contentHash: "new-facts" },
    })
    await state.db.chetaidouSku.update({ where: { id: 1 }, data: { currentFactId: 2 } })
    await state.db.chetaidouBreakdown.create({
      data: { ...state.breakdown, id: 2, version: 2, contentHash: "new-breakdown" },
    })
    await state.db.chetaidouImage.update({ where: { id: 19 }, data: { currentBreakdownId: 2 } })
    const created: any = await service.createTask(7, {
      type,
      imageId: 19,
      idempotencyKey: "first-task-after-context-update",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    expect(state.adjustments).toHaveLength(1)
    const task = state.tasks.find(t => t.id === created.taskId)
    expect(task.adjustmentId).toBe(record.id)
    expect(task.snapshot.facts.version).toBe(2)
    expect(task.snapshot.breakdown.version).toBe(2)
    expect({ facts: record.state.facts, breakdown: record.state.breakdown }).toEqual({
      facts: { id: 2, version: 2, contentHash: "new-facts" },
      breakdown: { id: 2, version: 2, contentHash: "new-breakdown" },
    })
  })

  it("首次任务关联历史写入失败时，资料引用、任务和草稿一起回滚", async () => {
    state.draft.workspaceId = randomUUID()
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...state.draft.settings, customText: "冬季氛围" },
      selections: [],
      customDimensions: [],
    })
    await state.db.chetaidouFactCard.create({
      data: { ...state.fact, id: 2, version: 2, contentHash: "new-facts" },
    })
    await state.db.chetaidouSku.update({ where: { id: 1 }, data: { currentFactId: 2 } })
    const before = structuredClone({
      draft: state.draft,
      adjustments: state.adjustments,
      tasks: state.tasks,
    })
    state.db.chetaidouAdjustment.update.mockRejectedValueOnce(new Error("history write failed"))
    await expect(
      service.createTask(7, {
        type: "IDEATION",
        imageId: 19,
        idempotencyKey: "failed-first-task-history-update",
        workspaceId: state.draft.workspaceId,
        draftRevision: state.draft.revision,
      })
    ).rejects.toThrow("history write failed")
    expect({ draft: state.draft, adjustments: state.adjustments, tasks: state.tasks }).toEqual(
      before
    )
  })

  async function recordedIdeation(run = true) {
    state.draft.workspaceId = randomUUID()
    state.draft.activeAdjustmentId = null
    state.draft.restoredFromAdjustmentId = null
    const submittedWorkspace = state.draft.workspaceId
    const h = await ideationHarness(3)
    if (run) await h.runner.execute(h.taskId)
    return { ...h, submittedWorkspace, record: state.adjustments[0] }
  }

  it("首次保存要求建历史，未联想或组织前反复修改只更新该条", async () => {
    state.draft.workspaceId = randomUUID()
    for (const customText of ["冬季氛围", "雪夜氛围", "雪夜氛围"]) {
      const saved = await service.putDraft(7, 19, {
        workspaceId: state.draft.workspaceId,
        revision: state.draft.revision,
        settings: { ...state.draft.settings, customText },
        selections: [],
        customDimensions: [],
      })
      expect(state.adjustments).toHaveLength(1)
      expect(saved.activeAdjustmentId).toBe(state.adjustments[0].id)
      expect(saved.restoredFromAdjustmentId).toBeNull()
      expect(state.adjustments[0].state.settings.customText).toBe(customText)
      expect(state.adjustments[0].state.facts.contentHash).toBe(state.fact.contentHash)
      expect(state.adjustments[0].state.breakdown.contentHash).toBe(state.breakdown.contentHash)
    }
    const record = state.adjustments[0]
    const body = {
      type: "COMPOSE" as const,
      imageId: 19,
      idempotencyKey: "first-compose-after-saved-requirements",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    }
    const created: any = await service.createTask(7, body)
    expect(state.tasks.find(t => t.id === created.taskId).adjustmentId).toBe(record.id)
    expect(await service.createTask(7, body)).toMatchObject({ id: created.taskId })
    expect(state.adjustments).toHaveLength(1)
  })

  it("保存要求后首次联想复用，重新联想及继承联想后的重新组织分别分叉", async () => {
    const h = await recordedIdeation()
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...state.draft.settings, customText: "冬季氛围" },
      selections: [],
      customDimensions: [],
    })
    expect(state.adjustments).toHaveLength(2)
    const savedRecord = state.adjustments[1]
    const first: any = await service.createTask(7, {
      type: "IDEATION",
      imageId: 19,
      idempotencyKey: "first-ideation-saved-requirements",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    expect(state.adjustments).toHaveLength(2)
    expect(state.tasks.find(t => t.id === first.taskId).adjustmentId).toBe(savedRecord.id)
    await h.runner.execute(first.taskId)
    const group = state.groups.find(g => g.taskId === first.taskId)
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: state.draft.settings,
      selections: [{ groupId: group.id, optionKeys: [group.options[0].key] }],
      customDimensions: [],
    })
    const original = structuredClone(savedRecord)
    const firstCompose: any = await service.createTask(7, {
      type: "COMPOSE",
      imageId: 19,
      idempotencyKey: "first-compose-new-requirements",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    expect(state.tasks.find(t => t.id === firstCompose.taskId).adjustmentId).toBe(savedRecord.id)
    const composedRecord = structuredClone(savedRecord)
    const recompose: any = await service.createTask(7, {
      type: "COMPOSE",
      imageId: 19,
      idempotencyKey: "recompose-inherit-ideation",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    const inherited = state.adjustments[2]
    expect(inherited.parentAdjustmentId).toBe(savedRecord.id)
    expect(inherited.state).toMatchObject({
      settings: original.state.settings,
      activeIdeationTaskId: first.taskId,
      activeGroupRefs: original.state.activeGroupRefs,
      selections: original.state.selections,
      activeCompositionTaskId: recompose.taskId,
    })
    expect(savedRecord).toEqual(composedRecord)
    const inheritedBefore = structuredClone(inherited)
    const again: any = await service.createTask(7, {
      type: "IDEATION",
      imageId: 19,
      idempotencyKey: "reideation-after-recompose",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    expect(state.adjustments).toHaveLength(4)
    expect(state.adjustments[3].parentAdjustmentId).toBe(inherited.id)
    expect(state.tasks.find(t => t.id === again.taskId).adjustmentId).toBe(state.adjustments[3].id)
    expect(inherited).toEqual(inheritedBefore)
    expect(state.adjustments[3].state.settings.customText).toBe("冬季氛围")
    expect(state.adjustments[3].state.selections).toEqual([])
  })

  it.each(["QUEUED", "FAILED", "CANCELLED"])(
    "已提交%s联想后改要求必须新建，不能覆盖原记录",
    async status => {
      const h = await recordedIdeation(false)
      state.tasks.find(t => t.id === h.taskId).status = status
      const original = structuredClone(h.record)
      await service.putDraft(7, 19, {
        workspaceId: state.draft.workspaceId,
        revision: state.draft.revision,
        settings: { ...state.draft.settings, customText: "新要求" },
        selections: [],
        customDimensions: [],
      })
      expect(state.adjustments).toHaveLength(2)
      expect(h.record).toEqual(original)
      expect(state.adjustments[1].parentAdjustmentId).toBe(h.record.id)
      expect(state.adjustments[1].state.activeIdeationTaskId).toBeNull()
    }
  )

  it("保存新要求的历史写失败时，草稿与来源一起回滚", async () => {
    await recordedIdeation()
    const before = structuredClone({ draft: state.draft, adjustments: state.adjustments })
    state.db.chetaidouAdjustment.create.mockRejectedValueOnce(new Error("history write failed"))
    await expect(
      service.putDraft(7, 19, {
        workspaceId: state.draft.workspaceId,
        revision: state.draft.revision,
        settings: { ...state.draft.settings, customText: "冬季氛围" },
        selections: [],
        customDimensions: [],
      })
    ).rejects.toThrow("history write failed")
    expect({ draft: state.draft, adjustments: state.adjustments }).toEqual(before)
  })

  it("只组织未联想的记录改要求也分叉，新要求首次联想复用新记录", async () => {
    state.draft.workspaceId = randomUUID()
    const first = await compose()
    const original = structuredClone(state.adjustments[0])
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...state.draft.settings, customText: "冬季氛围" },
      selections: [],
      customDimensions: [],
    })
    const record = state.adjustments[1]
    expect(record.parentAdjustmentId).toBe(first.adjustmentId)
    expect(state.adjustments[0]).toEqual(original)
    const created: any = await service.createTask(7, {
      type: "IDEATION",
      imageId: 19,
      idempotencyKey: "first-ideation-after-requirements-change",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    expect(state.adjustments).toHaveLength(2)
    expect(state.tasks.find(t => t.id === created.taskId).adjustmentId).toBe(record.id)
  })

  it("未联想或组织的历史改要求只更新，旧发散产物不能自动写回新要求", async () => {
    state.draft.workspaceId = randomUUID()
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...state.draft.settings, customText: "冬季氛围" },
      selections: [],
      customDimensions: [{ id: "dim", label: "季节", selectionMode: "single", options: [] }],
    })
    const record = state.adjustments[0]
    const created: any = await service.createTask(7, {
      type: "DIVERGE",
      imageId: 19,
      customDimensionId: "dim",
      idempotencyKey: "pending-history-diverge",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...state.draft.settings, customText: "雪夜氛围" },
      selections: [],
      customDimensions: state.draft.customDimensions,
    })
    expect(state.adjustments).toHaveLength(1)
    expect(state.draft.activeAdjustmentId).toBe(record.id)
    const task = state.tasks.find(t => t.id === created.taskId)
    Object.assign(task, {
      status: "SUCCEEDED",
      output: { newOptions: [{ key: "winter", label: "冬季" }], applied: false, canApply: true },
    })
    const before = structuredClone({ draft: state.draft, adjustments: state.adjustments })
    await expect(
      applyDivergeOutput(state.db, 7, task.id, task.acceptedDraftRevision, true)
    ).rejects.toThrow("出图要求已变化")
    expect({ draft: state.draft, adjustments: state.adjustments }).toEqual(before)
    await expect(
      service.applyTask(7, task.id, state.draft.revision, state.draft.workspaceId)
    ).resolves.toMatchObject({ applied: true })
    expect(state.draft.customDimensions[0].options[0].sourceTaskId).toBe(task.id)
    expect(state.adjustments).toHaveLength(1)
  })

  it.each(["批次", "逐维", "定向重试", "回执恢复"])(
    "%s联想每维成功即发布有效组，收尾不重复递增版本",
    async mode => {
      const h = await recordedIdeation(false)
      const task = state.tasks.find(t => t.id === h.taskId)
      const transaction = state.db.$transaction.getMockImplementation()
      let committed = Promise.resolve()
      state.db.$transaction.mockImplementation((fn: any) => {
        const result = committed.then(() => transaction(fn))
        committed = result.catch(() => undefined)
        return result
      })
      let executionTaskId = h.taskId
      if (mode === "定向重试" || mode === "回执恢复") {
        const base = h.completeMultimodal.getMockImplementation()!
        h.completeMultimodal.mockImplementation(async (request: any) => {
          const input = JSON.parse(request.messages.at(-1).content)
          if (!input.dimensions) return base(request)
          if (mode === "回执恢复") throw new Error("connection lost")
          return h.respond("invalid json")
        })
        await h.runner.execute(h.taskId)
        h.completeMultimodal.mockImplementation(base)
        if (mode === "定向重试") {
          const retry = await service.retryTask(7, h.taskId, {
            idempotencyKey: "retry-history-groups",
            groupIds: state.groups.map(g => g.id),
          })
          executionTaskId = retry.taskId
        } else {
          const call = await state.db.chetaidouCall.findUnique({
            where: { id: state.groups[0].currentCallId },
          })
          await state.db.chetaidouCall.update({
            where: { id: call.id },
            data: { gatewayResponse: h.respond(h.outputGroups(h.definitions)).completion },
          })
        }
      }
      if (mode === "逐维") {
        task.snapshot.execution.version = 0
        const base = h.completeMultimodal.getMockImplementation()!
        h.completeMultimodal.mockImplementation(async (request: any) => {
          const input = JSON.parse(request.messages.at(-1).content)
          return input.dimension
            ? h.respond({
                group: {
                  ...input.dimension,
                  options: h.outputGroups([input.dimension]).groups[0].options,
                },
              })
            : base(request)
        })
      }
      const observed: any[] = []
      const bump = h.runner.bumpProgress.bind(h.runner)
      jest.spyOn(h.runner, "bumpProgress").mockImplementation(async (current: any) => {
        observed.push({
          status: task.status,
          succeeded: state.groups.filter(g => g.status === "SUCCEEDED").map(g => g.id),
          draft: await service.getDraft(7, 19),
          history: structuredClone(h.record.state),
        })
        await bump(current)
      })
      const before = state.draft.revision
      await h.runner.execute(executionTaskId, mode === "回执恢复")
      expect(observed).toHaveLength(3)
      for (const row of observed) {
        expect(row.status).toBe("RUNNING")
        expect(row.draft.revision).toBeGreaterThan(before)
        for (const id of row.succeeded) {
          expect(row.draft.activeGroupRefs).toContainEqual({ groupId: id })
          expect(row.draft.activeGroups).toContainEqual(expect.objectContaining({ groupId: id }))
          expect(row.history.activeGroupRefs).toContainEqual({ groupId: id })
        }
      }
      expect(state.draft.revision).toBe(before + 3)
      expect(state.draft.activeGroupRefs.map((ref: any) => ref.groupId)).toEqual(
        state.groups.map(g => g.id)
      )
      const revision = state.draft.revision
      await h.runner.finishTask(task, "SUCCEEDED", null, null)
      expect(state.draft.revision).toBe(revision)
    }
  )

  it.each(["历史", "草稿"])("%s写入失败时，维度成功和有效组一起回滚", async target => {
    const h = await recordedIdeation(false)
    const task = state.tasks.find(t => t.id === h.taskId)
    const group = { id: "group", taskId: h.taskId, key: "g0", status: "RUNNING", order: 0 }
    state.groups.push(group)
    const before = structuredClone({ draft: state.draft, history: h.record.state })
    const update =
      target === "历史" ? state.db.chetaidouAdjustment.update : state.db.chetaidouDraft.updateMany
    update.mockRejectedValueOnce(new Error("有效组保存失败"))
    await expect(
      h.runner.applyBatchGroup(
        task,
        group,
        h.outputGroups([{ key: "g0" }]).groups[0].options,
        "call"
      )
    ).rejects.toThrow("有效组保存失败")
    expect(state.groups[0].status).toBe("RUNNING")
    expect(state.groups[0].options).toBeUndefined()
    expect(state.draft).toEqual(before.draft)
    expect(state.adjustments[0].state).toEqual(before.history)
  })

  it("待核对联想的成功维度可保存和组合，未知维度保持待核对", async () => {
    state.draft.workspaceId = randomUUID()
    const h = await ideationHarness(6)
    const base = h.completeMultimodal.getMockImplementation()!
    h.completeMultimodal.mockImplementation(async (request: any) => {
      const input = JSON.parse(request.messages.at(-1).content)
      if (input.dimensions?.some((g: any) => g.key === "g3")) throw new Error("connection lost")
      return base(request)
    })
    await h.runner.execute(h.taskId)
    const draft = await service.getDraft(7, 19)
    expect((await service.getTask(7, h.taskId)).status).toBe("WAITING_RECONCILIATION")
    expect(draft.activeGroups).toHaveLength(3)
    const group = state.groups.find(g => g.status === "SUCCEEDED")
    const saved = await service.putDraft(7, 19, {
      workspaceId: draft.workspaceId!,
      revision: draft.revision,
      settings: draft.settings as any,
      selections: [{ groupId: group.id, optionKeys: [group.options[0].key] }],
      customDimensions: [],
    })
    await expect(
      service.createTask(7, {
        type: "COMPOSE",
        imageId: 19,
        idempotencyKey: "compose-partial-history",
        workspaceId: saved.workspaceId!,
        draftRevision: saved.revision,
        allowPartialIdeation: true,
      })
    ).resolves.toMatchObject({ status: "QUEUED" })
    expect(state.groups.filter(g => g.status === "UNKNOWN")).toHaveLength(3)
  })

  it("首次直接发散创建历史，列表和状态可定位且幂等重放不新增历史", async () => {
    state.draft.workspaceId = null
    const draft = await service.getDraft(7, 19)
    const saved = await service.putDraft(7, 19, {
      workspaceId: draft.workspaceId!,
      revision: draft.revision,
      settings: draft.settings as any,
      selections: [],
      customDimensions: [{ id: "dim", label: "季节", selectionMode: "single", options: [] }],
    })
    const body = {
      type: "DIVERGE" as const,
      imageId: 19,
      customDimensionId: "dim",
      idempotencyKey: "first-diverge",
      workspaceId: saved.workspaceId!,
      draftRevision: saved.revision,
    }
    const created: any = await service.createTask(7, body)
    expect(state.adjustments).toHaveLength(1)
    const record = state.adjustments[0]
    const task = state.tasks.find(t => t.id === created.taskId)
    expect(task.adjustmentId).toBe(record.id)
    expect(task.workspaceId).toBe(state.draft.workspaceId)
    expect(task.snapshot.workflow.adjustmentId).toBe(record.id)
    expect(state.draft.activeAdjustmentId).toBe(record.id)
    expect(record.state.customDimensions[0].id).toBe("dim")
    const list = await service.listTasks(7, { page: 1, pageSize: 10 })
    const statuses = await service.tasksStatus(7, [task.id])
    for (const row of [await service.getTask(7, task.id), list.items[0], statuses.items[0]])
      expect(row.adjustmentId).toBe(record.id)
    expect(await service.createTask(7, body)).toMatchObject({ id: task.id })
    expect(state.adjustments).toHaveLength(1)
    Object.assign(task, {
      status: "SUCCEEDED",
      output: { newOptions: [{ key: "winter", label: "冬季" }], applied: false },
    })
    await applyDivergeOutput(state.db, 7, task.id, task.acceptedDraftRevision, true)
    expect(record.state.customDimensions[0].options).toContainEqual(
      expect.objectContaining({ key: "winter", origin: "AI", sourceTaskId: task.id })
    )
  })

  it("首次联想创建完整历史，原令牌重放不重复创建", async () => {
    const h = await recordedIdeation()
    expect(state.adjustments).toHaveLength(1)
    expect(h.record.state.activeGroupRefs).toHaveLength(3)
    expect(state.draft.activeGroupRefs).toEqual(h.record.state.activeGroupRefs)
    expect(h.record.state.settings.dimensionCountRange).toEqual({ min: 3, max: 3 })
    expect(h.record.state.facts.id).toBe(state.fact.id)
    const repeat = await service.createTask(7, {
      type: "IDEATION",
      imageId: 19,
      idempotencyKey: "new-ideation",
      workspaceId: h.submittedWorkspace,
      draftRevision: 0,
    })
    expect(repeat).toMatchObject({ id: h.taskId })
    expect(state.adjustments).toHaveLength(1)
  })

  it.each([false, true])(
    "保存出图要求即建历史，重复保存复用且保留来源（恢复=%s）",
    async restored => {
      const h = await recordedIdeation()
      if (restored)
        await service.restoreAdjustment(7, 19, h.record.id, {
          workspaceId: state.draft.workspaceId,
          revision: state.draft.revision,
        })
      const original = structuredClone(h.record)
      const workspaceId = state.draft.workspaceId
      const saved = await service.putDraft(7, 19, {
        workspaceId,
        revision: state.draft.revision,
        settings: { ...state.draft.settings, customText: "更换冬季氛围" },
        selections: [],
        customDimensions: [],
      })
      expect(state.adjustments).toHaveLength(2)
      expect(h.record).toEqual(original)
      expect(saved.settings.customText).toBe("更换冬季氛围")
      expect(saved.activeGroupRefs).toEqual(original.state.activeGroupRefs)
      expect(saved.activeCompositionTaskId).toBeNull()
      expect(saved.activeAdjustmentId).toBe(state.adjustments[1].id)
      expect(saved.activeIdeationTaskId).toBeNull()
      expect(state.adjustments[1].parentAdjustmentId).toBe(h.record.id)
      expect(saved.workspaceId).not.toBe(workspaceId)
      expect(saved.restoredFromAdjustmentId).toBeNull()
      const list = await service.listAdjustments(7, 19, { page: 1, pageSize: 20 })
      expect(list.total).toBe(2)
      expect(list.items[0].id).toBe(saved.activeAdjustmentId)

      await service.putDraft(7, 19, {
        workspaceId: saved.workspaceId,
        revision: saved.revision,
        settings: saved.settings,
        selections: [],
        customDimensions: [],
      })
      expect(state.adjustments).toHaveLength(2)
      expect(h.record).toEqual(original)
    }
  )

  it("联想后首次组织复用本轮，单独重新组织新增历史，幂等重放不新增", async () => {
    const h = await recordedIdeation()
    let source = h.record
    for (const [index, key] of ["first-compose-history", "second-compose-history"].entries()) {
      const original = structuredClone(source)
      const body = {
        type: "COMPOSE" as const,
        imageId: 19,
        idempotencyKey: key,
        workspaceId: state.draft.workspaceId,
        draftRevision: state.draft.revision,
      }
      const created: any = await service.createTask(7, body)
      const task = state.tasks.find(row => row.id === created.taskId)
      if (index === 0) expect(task.adjustmentId).toBe(source.id)
      else {
        expect(source).toEqual(original)
        expect(task.adjustmentId).not.toBe(source.id)
        expect(state.adjustments.at(-1).parentAdjustmentId).toBe(source.id)
      }
      source = state.adjustments.at(-1)
      expect(task.workspaceId).toBe(state.draft.workspaceId)
      expect(source.state.activeCompositionTaskId).toBe(task.id)
      const total = state.adjustments.length
      expect(await service.createTask(7, body)).toMatchObject({ id: task.id })
      expect(state.adjustments).toHaveLength(total)
    }
    expect(state.adjustments).toHaveLength(2)
  })

  it.each([false, true])(
    "保存要求即建历史，首次联想、组织及多次出图复用（冲突问答=%s）",
    async needsAnswers => {
      const h = await recordedIdeation()
      const original = structuredClone(h.record)
      for (const customText of ["冬季氛围", "晴天氛围"]) {
        await service.putDraft(7, 19, {
          workspaceId: state.draft.workspaceId,
          revision: state.draft.revision,
          settings: { ...state.draft.settings, customText },
          selections: [],
          customDimensions: [],
        })
        expect(state.adjustments).toHaveLength(2)
        expect(h.record).toEqual(original)
      }
      const savedRecordId = state.draft.activeAdjustmentId
      const body = {
        type: "IDEATION" as const,
        imageId: 19,
        idempotencyKey: "adjusted-ideation",
        workspaceId: state.draft.workspaceId,
        draftRevision: state.draft.revision,
      }
      const ideation: any = await service.createTask(7, body)
      const record = state.adjustments[1]
      expect(record.id).toBe(savedRecordId)
      expect(record.parentAdjustmentId).toBe(h.record.id)
      expect(await service.createTask(7, body)).toMatchObject({ id: ideation.taskId })
      await h.runner.execute(ideation.taskId)
      const group = state.groups.find(g => g.taskId === ideation.taskId)
      const selectionId = group.options[0].selectionId
      await service.putDraft(7, 19, {
        workspaceId: state.draft.workspaceId,
        revision: state.draft.revision,
        settings: state.draft.settings,
        selections: [{ groupId: group.id, optionKeys: [group.options[0].key] }],
        customDimensions: [],
      })
      const composed: any = await service.createTask(7, {
        type: "COMPOSE",
        imageId: 19,
        idempotencyKey: "adjusted-compose",
        workspaceId: state.draft.workspaceId,
        draftRevision: state.draft.revision,
      })
      let composition = state.tasks.find(t => t.id === composed.taskId)
      await composeRunner([
        { ...composeOutput(!needsAnswers), coveredSelectionIds: [selectionId] },
      ]).runCompose(composition)
      if (needsAnswers) {
        const answers = {
          idempotencyKey: "adjusted-answers",
          workspaceId: state.draft.workspaceId,
          draftRevision: state.draft.revision,
          answers: [{ conflictId: "c1", choiceId: "keep", questionVersion: 1 }],
        }
        const next = await service.submitAnswers(7, composition.id, answers)
        expect(await service.submitAnswers(7, composition.id, answers)).toMatchObject({
          taskId: next.taskId,
        })
        const parentId = composition.id
        composition = state.tasks.find(t => t.id === next.taskId)
        expect(composition.parentTaskId).toBe(parentId)
        await composeRunner([
          {
            ...composeOutput(true),
            coveredSelectionIds: [selectionId],
            acknowledgedAnswerIds: [composition.snapshot.decisions[0].decisionId],
          },
        ]).runCompose(composition)
      }
      expect(composition.output.status).toBe("READY")
      for (const count of [1, 2]) {
        const generate = {
          type: "GENERATE" as const,
          imageId: 19,
          compositionTaskId: composition.id,
          count,
          aspectRatio: "1:1",
          idempotencyKey: `adjusted-generate-${count}`,
          workspaceId: state.draft.workspaceId,
          draftRevision: state.draft.revision,
        }
        const generated: any = await service.createTask(7, generate)
        const job = await state.db.imageGenJob.findUnique({
          where: { id: generated.imageGenJobId },
        })
        expect(job.items).toHaveLength(count)
        expect(job.request.compositionTaskId).toBe(composition.id)
        expect(await service.createTask(7, generate)).toMatchObject({ id: generated.taskId })
      }
      expect(state.adjustments).toHaveLength(2)
      expect(h.record).toEqual(original)
      const detail = await service.getAdjustment(7, 19, record.id)
      expect(detail.state).toMatchObject({
        settings: { customText: "晴天氛围" },
        activeIdeationTaskId: ideation.taskId,
        activeCompositionTaskId: composition.id,
        selections: [{ groupId: group.id }],
      })
      expect(detail.tasks).toHaveLength(needsAnswers ? 5 : 4)
      for (const task of detail.tasks) expect(task.adjustmentId).toBe(record.id)
      const restored = await service.restoreAdjustment(7, 19, record.id, {
        workspaceId: state.draft.workspaceId,
        revision: state.draft.revision,
      })
      expect(restored.settings.customText).toBe("晴天氛围")
      expect(restored.activeCompositionTaskId).toBe(composition.id)
      expect(restored.activeGroupRefs).toEqual(record.state.activeGroupRefs)
      expect(state.adjustments).toHaveLength(2)
    }
  )

  it("首次直接组织创建历史，后续单独重新组织新增一条", async () => {
    state.draft.workspaceId = randomUUID()
    const first = await compose()
    expect(state.adjustments).toHaveLength(1)
    const record = state.adjustments[0]
    const next: any = await service.createTask(7, {
      type: "COMPOSE",
      imageId: 19,
      idempotencyKey: "first-direct-recompose",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    expect(first.adjustmentId).toBe(record.id)
    expect(state.tasks.find(t => t.id === next.taskId).adjustmentId).toBe(state.adjustments[1].id)
    expect(state.adjustments[1].parentAdjustmentId).toBe(record.id)
    expect(state.adjustments).toHaveLength(2)
  })

  it("修改选项使组合指针失效后，重新组织仍新增历史", async () => {
    const h = await recordedIdeation()
    const first = await compose()
    const group = state.groups[0]
    const original = structuredClone(h.record)
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: state.draft.settings,
      selections: [{ groupId: group.id, optionKeys: [group.options[0].key] }],
      customDimensions: [],
    })
    expect(state.draft.activeCompositionTaskId).toBeNull()
    expect(h.record).toEqual(original)
    expect(state.draft.activeAdjustmentId).toBeNull()
    const next: any = await service.createTask(7, {
      type: "COMPOSE",
      imageId: 19,
      idempotencyKey: "recompose-after-selections",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    expect(state.adjustments).toHaveLength(2)
    expect(h.record).toEqual(original)
    expect(state.tasks.find(t => t.id === next.taskId)).toMatchObject({
      adjustmentId: state.adjustments[1].id,
      snapshot: { resolvedSelections: [{ groupId: group.id }] },
    })
    expect(state.adjustments[1].state.activeGroupRefs).toEqual(original.state.activeGroupRefs)
    expect(state.adjustments[1].state.activeIdeationTaskId).toBe(h.taskId)
    expect(state.adjustments[1].state.settings).toEqual(original.state.settings)
    expect(first.adjustmentId).toBe(h.record.id)
  })

  it("默认表单保存不建历史，要求变化建历史，首次联想及选项参数更新复用", async () => {
    state.draft.workspaceId = randomUUID()
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: defaultSettings(),
      selections: [],
      customDimensions: [],
    })
    expect(state.adjustments).toHaveLength(0)
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...state.draft.settings, customText: "冬季氛围" },
      selections: [],
      customDimensions: [],
    })
    const h = await ideationHarness(3)
    await h.runner.execute(h.taskId)
    const group = state.groups[0]
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...state.draft.settings, model: "another-model" },
      selections: [{ groupId: group.id, optionKeys: [group.options[0].key] }],
      customDimensions: [],
    })
    expect(state.adjustments).toHaveLength(1)
    expect(state.adjustments[0].state.selections).toHaveLength(1)
  })

  it("出图要求草稿写入失败时保留草稿和来源记录", async () => {
    await recordedIdeation()
    const original = structuredClone({ draft: state.draft, adjustments: state.adjustments })
    state.db.chetaidouDraft.updateMany.mockRejectedValueOnce(new Error("write failed"))
    await expect(
      service.putDraft(7, 19, {
        workspaceId: state.draft.workspaceId,
        revision: state.draft.revision,
        settings: { ...state.draft.settings, customText: "冬季氛围" },
        selections: [],
        customDimensions: [],
      })
    ).rejects.toThrow("write failed")
    expect({ draft: state.draft, adjustments: state.adjustments }).toEqual(original)
  })

  it("重新联想创建新历史并清除旧组选项引用，原选择留在来源记录", async () => {
    const h = await recordedIdeation()
    const group = state.groups[0]
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: state.draft.settings,
      selections: [{ groupId: group.id, optionKeys: [group.options[0].key] }],
      customDimensions: [],
    })
    const original = structuredClone(h.record.state)
    await service.createTask(7, {
      type: "IDEATION",
      imageId: 19,
      idempotencyKey: "second-ideation",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    expect(state.adjustments).toHaveLength(2)
    expect(state.adjustments[1].state.selections).toEqual([])
    expect(state.adjustments[1].state.activeGroupRefs).toEqual([])
    expect(state.adjustments[1].parentAdjustmentId).toBe(h.record.id)
    expect(h.record.state).toEqual(original)
    expect(h.record.state.selections).toHaveLength(1)
  })

  it("新建恢复默认且不创建历史，旧版本 reset 不能清空新内容", async () => {
    const h = await recordedIdeation()
    const before = structuredClone(h.record.state)
    const dto = { workspaceId: state.draft.workspaceId, revision: state.draft.revision }
    const fresh = await service.resetDraft(7, 19, dto)
    expect(fresh.settings).toEqual(defaultSettings())
    expect(fresh.activeGroupRefs).toEqual([])
    expect(fresh.customDimensions).toEqual([])
    expect(fresh.activeAdjustmentId).toBeNull()
    expect(fresh.workspaceId).not.toBe(dto.workspaceId)
    await expect(service.resetDraft(7, 19, dto)).rejects.toBeInstanceOf(ConflictException)
    expect(state.adjustments).toHaveLength(1)
    expect(h.record.state).toEqual(before)
  })

  it("恢复历史后修改并组合分叉，原记录不变且使用新设置", async () => {
    const h = await recordedIdeation()
    const original = structuredClone(h.record.state)
    await service.resetDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
    })
    const restored = await service.restoreAdjustment(7, 19, h.record.id, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
    })
    expect(restored.activeGroupRefs).toEqual(original.activeGroupRefs)
    expect(restored.activeGroups[0]).toMatchObject({
      groupId: state.groups[0].id,
      producerTaskId: h.taskId,
    })
    expect(state.adjustments).toHaveLength(1)
    const group = state.groups[0]
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...defaultSettings(), site: "amazon_de", customText: "更换冬季氛围" },
      selections: [{ groupId: group.id, optionKeys: [group.options[0].key] }],
      customDimensions: [],
    })
    expect(h.record.state).toEqual(original)
    const created: any = await service.createTask(7, {
      type: "COMPOSE",
      imageId: 19,
      idempotencyKey: "fork-compose",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    const task = state.tasks.find(t => t.id === created.taskId)
    expect(state.adjustments).toHaveLength(2)
    expect(state.adjustments[1].parentAdjustmentId).toBe(h.record.id)
    expect(task.adjustmentId).toBe(state.adjustments[1].id)
    expect(task.site).toBe("amazon_de")
    expect(task.snapshot.settings.customText).toBe("更换冬季氛围")
    expect(task.snapshot.resolvedSelections).toHaveLength(1)
    expect(h.record.state).toEqual(original)
  })

  it("历史修改后直接换一批，新组写入分叉记录", async () => {
    const h = await recordedIdeation()
    await service.restoreAdjustment(7, 19, h.record.id, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
    })
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...defaultSettings(), customText: "晴天" },
      selections: [],
      customDimensions: [],
    })
    const original = structuredClone(h.record.state)
    const created: any = await service.createTask(7, {
      type: "REFRESH_GROUP",
      imageId: 19,
      groupId: state.groups[0].id,
      idempotencyKey: "fork-refresh",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    const task = state.tasks.find(t => t.id === created.taskId)
    jest
      .spyOn(h.runner, "expandGroup")
      .mockImplementation(async (_task: any, _snapshot: any, group: any) => {
        await state.db.chetaidouGroup.update({
          where: { id: group.id },
          data: { status: "SUCCEEDED", options: state.groups[0].options },
        })
      })
    await h.runner.runRefreshGroup(task)
    expect(state.adjustments).toHaveLength(2)
    expect(task.output.newGroupId).toBeTruthy()
    expect(state.adjustments[1].state.activeGroupRefs).toContainEqual({
      groupId: task.output.newGroupId,
    })
    expect(h.record.state).toEqual(original)
    expect(state.draft.pendingRefreshTaskId).toBeNull()
  })

  it("原联想重复完成不覆盖已刷新的组版本", async () => {
    const h = await recordedIdeation()
    const old = state.groups[0]
    state.groups.push({
      ...structuredClone(old),
      id: "refreshed-group",
      taskId: "refresh-task",
      parentGroupId: old.id,
    })
    h.record.state.activeGroupRefs[0] = { groupId: "refreshed-group" }
    state.draft.activeGroupRefs[0] = { groupId: "refreshed-group" }
    await h.runner.finishTask(
      state.tasks.find(row => row.id === h.taskId),
      "SUCCEEDED",
      null,
      null
    )
    expect(h.record.state.activeGroupRefs).toHaveLength(3)
    expect(h.record.state.activeGroupRefs[0].groupId).toBe("refreshed-group")
    expect(state.draft.activeGroupRefs).toEqual(h.record.state.activeGroupRefs)
  })

  it("取消已切走的刷新清理所属历史，不清理新工作区占位", async () => {
    const h = await recordedIdeation()
    const created: any = await service.createTask(7, {
      type: "REFRESH_GROUP",
      imageId: 19,
      groupId: state.groups[0].id,
      idempotencyKey: "cancel-old-refresh",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    await service.resetDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
    })
    state.draft.pendingRefreshTaskId = "new-task"
    await service.cancelTask(7, created.taskId)
    expect(h.record.state.pendingRefreshTaskId).toBeNull()
    expect(state.draft.pendingRefreshTaskId).toBe("new-task")
  })

  it("切走后的联想完成补齐所属历史，不写新工作区", async () => {
    const h = await recordedIdeation(false)
    await service.resetDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
    })
    const fresh = structuredClone(state.draft)
    await h.runner.execute(h.taskId)
    expect(h.record.state.activeGroupRefs).toHaveLength(3)
    expect(state.draft).toEqual(fresh)
    const restored = await service.restoreAdjustment(7, 19, h.record.id, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
    })
    expect(restored.activeGroupRefs).toHaveLength(3)
  })

  it("联想期间修改要求立即建新历史，晚到结果只补齐来源", async () => {
    const h = await recordedIdeation(false)
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...state.draft.settings, customText: "冬季氛围" },
      selections: [],
      customDimensions: [],
    })
    const edited = structuredClone(state.draft)
    await h.runner.execute(h.taskId)
    expect(state.adjustments).toHaveLength(2)
    expect(h.record.state.settings.customText).toBe("")
    expect(h.record.state.activeGroupRefs).toHaveLength(3)
    expect(state.draft).toEqual(edited)
    expect(state.adjustments[1].state.activeGroupRefs).toEqual([])
    expect(state.adjustments[1].state.settings.customText).toBe("冬季氛围")
  })

  it("刷新期间修改要求解除旧占位，晚到刷新不影响新组合", async () => {
    const h = await recordedIdeation()
    const refresh: any = await service.createTask(7, {
      type: "REFRESH_GROUP",
      imageId: 19,
      groupId: state.groups[0].id,
      idempotencyKey: "refresh-before-edit",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    const refreshTask = state.tasks.find(t => t.id === refresh.taskId)
    const saved = await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: { ...state.draft.settings, customText: "冬季氛围" },
      selections: [],
      customDimensions: [],
    })
    expect(saved.pendingRefreshTaskId).toBeNull()
    expect(h.record.state.pendingRefreshTaskId).toBe(refreshTask.id)
    const composed: any = await service.createTask(7, {
      type: "COMPOSE",
      imageId: 19,
      idempotencyKey: "compose-after-edit",
      workspaceId: saved.workspaceId!,
      draftRevision: saved.revision,
    })
    const current = structuredClone(state.draft)
    jest.spyOn(h.runner, "expandGroup").mockImplementation(async (_t: any, _s: any, group: any) => {
      await state.db.chetaidouGroup.update({
        where: { id: group.id },
        data: { status: "SUCCEEDED", options: state.groups[0].options },
      })
    })
    await h.runner.runRefreshGroup(refreshTask)
    expect(state.adjustments).toHaveLength(2)
    expect(h.record.state.pendingRefreshTaskId).toBeNull()
    expect(h.record.state.activeGroupRefs).toContainEqual({
      groupId: refreshTask.output.newGroupId,
    })
    expect(state.draft).toEqual(current)
    expect(state.adjustments[1].state.activeCompositionTaskId).toBe(composed.taskId)
  })

  it("旧组合晚完成只保留原记录，新组织的提示词属于新记录", async () => {
    const h = await recordedIdeation()
    const first = await compose()
    const next: any = await service.createTask(7, {
      type: "COMPOSE",
      imageId: 19,
      idempotencyKey: "later-compose",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    const latest = state.tasks.find(t => t.id === next.taskId)
    await executeCompose(latest, true)
    await executeCompose(first, true)
    expect(state.adjustments).toHaveLength(2)
    expect(state.draft.activeCompositionTaskId).toBe(latest.id)
    expect(h.record.state.activeCompositionTaskId).toBe(first.id)
    expect(state.adjustments[1].state.activeCompositionTaskId).toBe(latest.id)
    expect(first.output.status).toBe("READY")
    expect(latest.output.status).toBe("READY")
  })

  it.each(["QUEUED", "READY", "ANSWERS"])(
    "晚到发散保留产物，不覆盖首次组织及问答的当前组合：%s",
    async phase => {
      const h = await recordedIdeation()
      await service.putDraft(7, 19, {
        workspaceId: state.draft.workspaceId,
        revision: state.draft.revision,
        settings: state.draft.settings,
        selections: [],
        customDimensions: [{ id: "dim", label: "季节", selectionMode: "single", options: [] }],
      })
      const created: any = await service.createTask(7, {
        type: "DIVERGE",
        imageId: 19,
        customDimensionId: "dim",
        idempotencyKey: "diverge-before-compose",
        workspaceId: state.draft.workspaceId,
        draftRevision: state.draft.revision,
      })
      const task = state.tasks.find(t => t.id === created.taskId)
      const composition = await compose()
      expect(composition.adjustmentId).toBe(h.record.id)
      if (phase !== "QUEUED") await executeCompose(composition, phase === "READY")
      if (phase === "ANSWERS")
        await service.submitAnswers(7, composition.id, {
          idempotencyKey: "answers-before-diverge-finishes",
          workspaceId: state.draft.workspaceId,
          draftRevision: state.draft.revision,
          answers: [{ conflictId: "c1", choiceId: "keep", questionVersion: 1 }],
        })
      Object.assign(task, {
        status: "SUCCEEDED",
        output: {
          newOptions: [{ key: "winter", label: "冬季" }],
          applied: false,
          canApply: true,
        },
      })
      const before = structuredClone({ draft: state.draft, record: h.record })
      await expect(
        applyDivergeOutput(state.db, 7, task.id, task.acceptedDraftRevision, true)
      ).rejects.toThrow("组合已变化")
      await expect(
        h.runner.applyDivergeToDraft(task, "dim", task.output.newOptions)
      ).resolves.toBeUndefined()
      expect({ draft: state.draft, record: state.adjustments[0] }).toEqual(before)
      expect(await service.getTaskOutput(7, task.id)).toMatchObject({
        newOptions: [{ key: "winter", label: "冬季" }],
        applied: false,
        canApply: true,
      })
      if (phase === "READY") {
        expect((await service.getComposition(7, composition.id)).isStale).toBe(false)
        await expect(
          service.createTask(7, {
            type: "GENERATE",
            imageId: 19,
            compositionTaskId: composition.id,
            count: 1,
            aspectRatio: "1:1",
            idempotencyKey: "generate-after-late-diverge",
            workspaceId: state.draft.workspaceId,
            draftRevision: state.draft.revision,
          })
        ).resolves.toMatchObject({ status: "QUEUED" })
      }
      await expect(
        service.applyTask(7, task.id, state.draft.revision, state.draft.workspaceId)
      ).resolves.toMatchObject({ applied: true })
      expect(state.draft.activeCompositionTaskId).toBeNull()
      expect(state.adjustments[0].state.activeCompositionTaskId).toBeNull()
      expect(state.draft.customDimensions[0].options).toContainEqual({
        key: "winter",
        text: "冬季",
        origin: "AI",
        sourceTaskId: task.id,
      })
      expect(state.adjustments).toHaveLength(1)
    }
  )

  it("已有组合后主动发散，组合指针未变时仍可自动应用", async () => {
    await recordedIdeation()
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: state.draft.settings,
      selections: [],
      customDimensions: [{ id: "dim", label: "季节", selectionMode: "single", options: [] }],
    })
    const composition = await compose()
    await executeCompose(composition, true)
    const created: any = await service.createTask(7, {
      type: "DIVERGE",
      imageId: 19,
      customDimensionId: "dim",
      idempotencyKey: "diverge-after-compose",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    const task = state.tasks.find(t => t.id === created.taskId)
    Object.assign(task, {
      status: "SUCCEEDED",
      output: { newOptions: [{ key: "winter", label: "冬季" }], applied: false, canApply: true },
    })
    await expect(
      applyDivergeOutput(state.db, 7, task.id, task.acceptedDraftRevision, true)
    ).resolves.toMatchObject({ applied: true })
    expect(state.draft.activeCompositionTaskId).toBeNull()
    expect(state.draft.customDimensions[0].options[0].sourceTaskId).toBe(task.id)
    expect(state.adjustments).toHaveLength(1)
  })

  it("旧组合首次提交答案补建历史，幂等重放和后续出图复用该记录", async () => {
    state.draft.workspaceId = null
    const composition = await compose()
    await executeCompose(composition, false)
    const draft = await service.getDraft(7, 19)
    expect(state.adjustments).toHaveLength(0)
    const body = {
      idempotencyKey: "legacy-composition-answers",
      workspaceId: draft.workspaceId!,
      draftRevision: draft.revision,
      answers: [{ conflictId: "c1", choiceId: "keep", questionVersion: 1 }],
    }
    const next = await service.submitAnswers(7, composition.id, body)
    expect(state.adjustments).toHaveLength(1)
    const record = state.adjustments[0]
    const answered = state.tasks.find(t => t.id === next.taskId)
    expect(record.parentAdjustmentId).toBeNull()
    expect(answered.adjustmentId).toBe(record.id)
    expect(answered.parentTaskId).toBe(composition.id)
    expect(record.state.activeCompositionTaskId).toBe(answered.id)
    expect(await service.submitAnswers(7, composition.id, body)).toMatchObject({
      taskId: answered.id,
    })
    await composeRunner([
      {
        ...composeOutput(true),
        acknowledgedAnswerIds: answered.snapshot.decisions.map(d => d.decisionId),
      },
    ]).runCompose(answered)
    const generated: any = await service.createTask(7, {
      type: "GENERATE",
      imageId: 19,
      compositionTaskId: answered.id,
      count: 1,
      aspectRatio: "1:1",
      idempotencyKey: "legacy-answers-generate",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    expect(state.tasks.find(t => t.id === generated.taskId).adjustmentId).toBe(record.id)
    const detail = await service.getAdjustment(7, 19, record.id)
    expect(detail.tasks.map(t => t.id)).toEqual(
      expect.arrayContaining([answered.id, generated.taskId])
    )
    expect((await service.listAdjustments(7, 19, { page: 1, pageSize: 20 })).total).toBe(1)
  })

  it("切走后的发散完成补齐原历史维度，不污染新草稿", async () => {
    const h = await recordedIdeation()
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: state.draft.settings,
      selections: [],
      customDimensions: [{ id: "dim", label: "季节", selectionMode: "single", options: [] }],
    })
    const created: any = await service.createTask(7, {
      type: "DIVERGE",
      imageId: 19,
      customDimensionId: "dim",
      idempotencyKey: "diverge-history",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    const task = state.tasks.find(t => t.id === created.taskId)
    Object.assign(task, {
      status: "SUCCEEDED",
      output: { newOptions: [{ key: "winter", label: "冬季" }] },
    })
    await service.resetDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
    })
    const fresh = structuredClone(state.draft)
    await applyDivergeOutput(state.db, 7, task.id, task.acceptedDraftRevision, true)
    expect(h.record.state.customDimensions[0].options).toContainEqual({
      key: "winter",
      text: "冬季",
      origin: "AI",
      sourceTaskId: task.id,
    })
    expect(state.draft).toEqual(fresh)
  })

  it("发散执行期间修改维度语义，不自动把旧结果并入新维度", async () => {
    await recordedIdeation()
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: state.draft.settings,
      selections: [],
      customDimensions: [{ id: "dim", label: "季节", selectionMode: "single", options: [] }],
    })
    const created: any = await service.createTask(7, {
      type: "DIVERGE",
      imageId: 19,
      customDimensionId: "dim",
      idempotencyKey: "changed-target",
      workspaceId: state.draft.workspaceId,
      draftRevision: state.draft.revision,
    })
    const task = state.tasks.find(row => row.id === created.taskId)
    Object.assign(task, {
      status: "SUCCEEDED",
      output: { newOptions: [{ key: "winter", label: "冬季" }], canApply: true, applied: false },
    })
    await service.putDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
      settings: state.draft.settings,
      selections: [],
      customDimensions: [{ id: "dim", label: "色彩", selectionMode: "single", options: [] }],
    })
    const before = structuredClone(state.draft)
    await expect(
      applyDivergeOutput(state.db, 7, task.id, task.acceptedDraftRevision, true)
    ).rejects.toThrow("维度已变化")
    expect(state.draft).toEqual(before)
    expect(await service.getTaskOutput(7, task.id)).toMatchObject({
      applied: false,
      canApply: true,
    })
  })

  it("历史跨用户拒绝，事务失败不留下孤立历史", async () => {
    const h = await recordedIdeation()
    await expect(service.getAdjustment(8, 19, h.record.id)).rejects.toThrow("不存在")
    await service.resetDraft(7, 19, {
      workspaceId: state.draft.workspaceId,
      revision: state.draft.revision,
    })
    const before = structuredClone(state.draft)
    state.db.chetaidouTask.create.mockRejectedValueOnce(new Error("write failed"))
    await expect(
      service.createTask(7, {
        type: "IDEATION",
        imageId: 19,
        idempotencyKey: "failed-history",
        workspaceId: state.draft.workspaceId,
        draftRevision: state.draft.revision,
      })
    ).rejects.toThrow("write failed")
    expect(state.adjustments).toHaveLength(1)
    expect(state.draft).toEqual(before)
  })

  it.each(["MODEL_OUTPUT_INVALID", "PROVIDER_TIMEOUT", "PROVIDER_ERROR"])(
    "拆解失败统一文案，保留技术详情：%s",
    async errorCode => {
      const task = await compose()
      Object.assign(task, {
        type: "BREAKDOWN",
        status: "FAILED",
        errorCode,
        errorMessage: "/baskets missing evidence",
      })
      expect((await service.getTask(7, task.id)).errorMessage).toBe("与母版差异太大")
      expect((await service.tasksStatus(7, [task.id])).items[0].errorMessage).toBe("与母版差异太大")
      state.image.activeBreakdownTaskId = task.id
      expect((await service.getImage(7, 19)).activeBreakdownTask?.errorMessage).toBe(
        "与母版差异太大"
      )
      expect((await service.listTasks(7, { page: 1, pageSize: 20 })).items[0].errorMessage).toBe(
        "与母版差异太大"
      )
      expect(task.errorMessage).toContain("missing evidence")
    }
  )
})

describe("自建维度稳定标识与来源", () => {
  it("缺 ID 自动分配、保持顺序，客户端不能伪造 AI 来源", () => {
    const input = [
      {
        label: "背景",
        selectionMode: "multi",
        options: [{ text: "海边", origin: "AI" as const }, { text: "山地" }],
      },
    ]
    const saved = normalizeCustomDimensions(input, [])
    expect(saved[0].id).toMatch(/^dim_/)
    expect(saved[0].options.map(o => o.text)).toEqual(["海边", "山地"])
    expect(saved[0].options[0].origin).toBe("USER")
    expect(stableHash(normalizeCustomDimensions(saved, saved))).toBe(stableHash(saved))
  })
  it("AI 已存来源在前端省略只读字段后仍保留，重复 key 拒绝", () => {
    const previous = [
      {
        id: "d",
        label: "背景",
        selectionMode: "multi",
        options: [{ key: "ai", text: "海边", origin: "AI" as const, sourceTaskId: "t" }],
      },
    ]
    const input = [{ ...previous[0], options: [{ key: "ai", text: "海边" }] }]
    expect(normalizeCustomDimensions(input, previous)[0].options[0]).toMatchObject({
      origin: "AI",
      sourceTaskId: "t",
    })
    expect(() =>
      normalizeCustomDimensions(
        [{ ...input[0], options: [input[0].options[0], input[0].options[0]] }],
        previous
      )
    ).toThrow("key 重复")
  })
})

describe("车泰斗权限节点", () => {
  it("控制器使用统一节点，父节点继承，旧兄弟节点不再冒充新权限", () => {
    expect(Reflect.getMetadata(PERMISSIONS_METADATA_KEY, ChetaidouController)).toEqual([
      "tool.ai_creative_studio.chetaidou",
    ])
    expect(
      hasPermission(new Set(["tool.ai_creative_studio"]), "tool.ai_creative_studio.chetaidou")
    ).toBe(true)
    expect(hasPermission(new Set(["tool.chetaidou"]), "tool.ai_creative_studio.chetaidou")).toBe(
      false
    )
  })
})
