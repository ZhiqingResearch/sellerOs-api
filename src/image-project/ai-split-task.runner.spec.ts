import { BadRequestException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import { createHash } from "crypto"
import { AiSplitTaskRunner } from "./ai-split-task.runner"
import { AiSplitPromptSnapshot } from "./ai-split.types"

describe("AiSplitTaskRunner", () => {
  const snapshot: AiSplitPromptSnapshot = {
    schemaVersion: "ai-split.v1",
    analysisModel: {
      id: 1,
      publicId: "ZQ-Multimodal-Gemini-3.1-Pro",
      displayName: "Gemini 3.1 Pro",
      gatewayConfig: {},
    },
    reference: {
      sourceType: "UPLOAD",
      url: "https://example.com/competitor.png",
    },
    currentProduct: { productName: "Running Board" },
    currentProductKeys: ["productName"],
    productImages: [
      {
        id: 11,
        index: 1,
        url: "https://example.com/main.png",
        purpose: "PRODUCT_MAIN",
        description: "踏板主体",
      },
      {
        id: 12,
        index: 2,
        url: "https://example.com/package.png",
        purpose: "PACKAGING",
        description: "运输包装箱",
      },
    ],
    competitorTemplate: { schema_version: "v3" },
    generationPlan: {
      prompt: "生成电商主图",
      negative_prompt: "不要改变产品结构",
      render_constraints: {
        preserve_product_identity: true,
        do_not_merge_packaging_into_product: true,
        preserve_creative_owned: true,
      },
    },
    generationSettings: {
      site: "AMAZON_US",
      locale: "en-US",
      textAmount: "LOW",
      model: "ZQ-Image-3",
      quantity: 2,
      modelParams: { aspect_ratio: "1:1", size: "2048x2048" },
      supportsNegativePrompt: true,
    },
    promptVersions: {
      competitorAnalysis: "v3",
      competitorAnalysisHash: "competitor-hash",
      productImageGeneration: "v4",
      productImageGenerationHash: "product-hash",
    },
    gatewayCalls: {},
  }

  function setup(deliveryPlan?: Record<string, unknown>) {
    const tx = {
      generationTask: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
      generatedImage: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        count: jest.fn().mockResolvedValue(0),
      },
    }
    const task = {
      deliveryPlan,
      id: 31,
      projectId: 5,
      userId: 7,
      source: "platform" as string | undefined,
      generationMode: "AI_SPLIT",
      groupId: "group-1",
      status: "GENERATING",
      aiSplitStage: "IMAGE_SUBMITTING",
      gatewayTaskId: null,
      promptConfig: snapshot,
      generatedImages: [
        { id: 101, status: "GENERATING", order: 0 },
        { id: 102, status: "GENERATING", order: 1 },
      ],
    }
    const prisma = {
      generationTask: {
        findUnique: jest.fn().mockResolvedValue(task),
        update: jest.fn().mockResolvedValue(task),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    }
    const gateway = {
      isConfigured: jest.fn().mockReturnValue(true),
      createImageTask: jest.fn().mockResolvedValue({
        id: "gateway-image-31",
        object: "image.task",
        status: "queued",
        model: "ZQ-Image-3",
        request_id: "req-image-31",
        created_at: 1,
      }),
      getUsageByRequestId: jest.fn(),
    }
    const usage = {
      chargeModel: jest.fn(),
      gatewayPriceMultiplier: jest.fn().mockResolvedValue(1), // 分析模型为 TEXT，倍率 1
      gatewayFixedImageCredits: jest.fn().mockResolvedValue(null), // 生图模型未配组合价,分析按量
    }
    const webhook = { applyImageTask: jest.fn() }
    const runner = new AiSplitTaskRunner(
      prisma as never,
      gateway as never,
      usage as never,
      webhook as never
    )
    return { runner, prisma, gateway, usage, webhook, tx, task }
  }

  it("最终生图只传 PRODUCT_MAIN / PRODUCT_DETAIL，包装图不进 reference_images 与用途清单", async () => {
    const { runner, gateway } = setup()

    await runner.run(31)

    expect(gateway.createImageTask).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "ZQ-Image-3",
        operation: "edit",
        n: 2,
        aspect_ratio: "1:1",
        size: "2048x2048",
        negative_prompt: "不要改变产品结构",
        reference_images: [{ url: "https://example.com/main.png" }],
      }),
      "ai-split:image-generation-task:31"
    )
    const request = (
      gateway.createImageTask.mock.calls as [Record<string, unknown>, string][]
    )[0][0]
    expect(request.prompt).toContain("Image 1")
    expect(request.prompt).toContain("用途：PRODUCT_MAIN")
    expect(JSON.stringify(request)).not.toContain("package.png")
    expect(JSON.stringify(request)).not.toContain("PACKAGING")
    expect(JSON.stringify(request)).not.toContain("competitor.png")
  })

  it("安全构图在最终提交追加一次，保留语言与负面约束", async () => {
    const { runner, gateway } = setup({ cropAnchor: "centre", requested: { aspectRatio: "3:10" } })
    await runner.run(31)
    const request = (gateway.createImageTask.mock.calls as [Record<string, unknown>, string][])[0][0]
    const prompt = String(request.prompt)
    expect(prompt).toContain("最终交付目标为宽高比 3:10")
    expect(prompt.match(/中心裁剪安全构图：/g)).toHaveLength(1)
    expect(prompt.startsWith("LANGUAGE=ENGLISH (EN-US). STRICT RULE:")).toBe(true)
    expect(request.negative_prompt).toBe("不要改变产品结构")
  })

  it("原生直传的拆图任务不追加本地裁剪指令", async () => {
    const { runner, gateway } = setup({ nativeSizing: true, cropAnchor: "centre", requested: { aspectRatio: "3:10" } })
    await runner.run(31)
    const request = (gateway.createImageTask.mock.calls as [Record<string, unknown>, string][])[0][0]
    expect(request.prompt).not.toContain("中心裁剪安全构图：")
  })

  it("重试或恢复提交前按冻结交付目标覆盖旧尺寸，不改写原快照", async () => {
    const { runner, prisma, gateway, task } = setup({
      requested: { aspectRatio: "463:625", resolutionTier: "2K" },
    })
    const staged = structuredClone(task)
    staged.promptConfig.generationSettings.modelParams = {
      aspect_ratio: "3:2", size: "1728x2304", resolution: "4k",
      width: 1920, height: 1080, resolution_tier: "1K", quality: "standard",
    }
    prisma.generationTask.findUnique.mockResolvedValue(staged)
    const before = structuredClone(staged.promptConfig.generationSettings.modelParams)
    await runner.run(31)
    const request = (gateway.createImageTask.mock.calls as [Record<string, unknown>, string][])[0][0]
    expect(request).toMatchObject({ aspect_ratio: "463:625", resolution: "2k", quality: "standard" })
    for (const key of ["size", "width", "height", "resolution_tier"])
      expect(request).not.toHaveProperty(key)
    expect(staged.promptConfig.generationSettings.modelParams).toEqual(before)
  })

  it("constraint 提及 creative_owned 元素时由 strip 统一剔除，不拦截任务", () => {
    const { runner } = setup()
    const strip = (
      runner as unknown as {
        stripCreativeElementConstraints: (template: Record<string, unknown>) => void
      }
    ).stripCreativeElementConstraints.bind(runner)

    const validTemplate = {
      variable_bindings: [
        {
          key: "product.productName",
          placeholder: "{{product.productName}}",
          source: "current_product_keys",
        },
      ],
      generation_prompt: {
        product_subject: "{{product.productName}} 与漂浮的宇航员",
        creative_elements: "漂浮的宇航员",
        constraints: [],
      },
      element_classification: [{ element: "宇航员", ownership: "creative_owned" }],
    }

    // 保留式 constraint（不要移除/保持）提及创意元素：由 strip 剔除防止污染 negative_prompt
    const preservation = {
      ...validTemplate,
      generation_prompt: {
        ...validTemplate.generation_prompt,
        constraints: ["不要移除画面中的宇航员", "保持整体画面完整", "切勿删除宇航员出屏效果"],
      },
    }
    strip(preservation)
    expect(preservation.generation_prompt.constraints).toEqual(["保持整体画面完整"])

    // 不复刻专属造型式（PRD 认可的创意泛化指令）同样剔除；
    // 与创意元素无关的真正排除式（禁止出现竞品品牌标志）不提及创意元素，原样保留给下游。
    const noCopy = {
      ...validTemplate,
      element_classification: [
        { element: "桌面上的键盘、鼠标、蜡烛、花瓶、条纹杯", ownership: "creative_owned" },
      ],
      generation_prompt: {
        ...validTemplate.generation_prompt,
        creative_elements: "桌面上摆放键盘、鼠标、蜡烛、花瓶与条纹杯等道具",
        constraints: [
          "不要复刻原图中键盘、鼠标、蜡烛、花瓶、条纹杯的专属造型",
          "禁止出现竞品品牌标志",
        ],
      },
    }
    strip(noCopy)
    expect(noCopy.generation_prompt.constraints).toEqual(["禁止出现竞品品牌标志"])

    // 排除式提及创意元素（不要出现X）不拦截任务：由 strip 统一剔除
    const polluted = {
      ...validTemplate,
      generation_prompt: {
        ...validTemplate.generation_prompt,
        constraints: ["不要出现宇航员"],
      },
    }
    strip(polluted)
    expect(polluted.generation_prompt.constraints).toEqual([])
  })

  it("禁止项兜底：包含 creative_owned 元素的词条会被剔除后再提交", () => {
    const { runner } = setup()
    const sanitize = (
      runner as unknown as {
        sanitizeNegativePrompt: (
          negative: string,
          competitorTemplate: Record<string, unknown> | null | undefined
        ) => string
      }
    ).sanitizeNegativePrompt.bind(runner)
    const template = {
      element_classification: [{ element: "astronaut figure", ownership: "creative_owned" }],
    }

    expect(sanitize("dark background, astronaut figure, blurry", template)).toBe(
      "dark background, blurry"
    )
    expect(sanitize("dark background, blurry", template)).toBe("dark background, blurry")
    expect(sanitize("astronaut figure", null)).toBe("astronaut figure")
  })

  it("生图提交失败时立即结束任务，不自动重试", async () => {
    const { runner, gateway } = setup()
    gateway.createImageTask.mockRejectedValueOnce(new BadRequestException("模型参数不支持"))
    const failTask = jest
      .spyOn(
        runner as unknown as { failTask: (taskId: number, message: string) => Promise<void> },
        "failTask"
      )
      .mockResolvedValue()

    await runner.run(31)

    expect(gateway.createImageTask).toHaveBeenCalledTimes(1)
    expect(failTask).toHaveBeenCalledWith(31, "模型参数不支持")
  })

  it("竞品拆解模型空返回：按产品口径失败（竞品图没有检测出可用产品），且不自动重试", async () => {
    const { runner, prisma, gateway, task } = setup()
    const staged = structuredClone(task)
    staged.aiSplitStage = "QUEUED"
    staged.gatewayTaskId = null
    prisma.generationTask.findUnique.mockResolvedValue(staged)
    gateway.completeMultimodal = jest.fn().mockResolvedValue({
      requestId: undefined,
      completion: { choices: [{ message: {} }] }, // content 缺失 → 空返回
    })
    const failTask = jest
      .spyOn(
        runner as unknown as { failTask: (taskId: number, message: string) => Promise<void> },
        "failTask"
      )
      .mockResolvedValue()

    await runner.run(31)

    // 空返回是内容级失败，同输入重试无意义：只调用一次
    expect(gateway.completeMultimodal).toHaveBeenCalledTimes(1)
    expect(failTask).toHaveBeenCalledWith(31, "竞品图没有检测出可用产品，无法进行分析")
  })

  it("生图规划模型空返回：失败文案为「生图规划失败，请重试」", async () => {
    const { runner, prisma, gateway, task } = setup()
    const staged = structuredClone(task)
    staged.aiSplitStage = "PRODUCT_PLANNING"
    staged.gatewayTaskId = null
    delete staged.promptConfig.generationPlan
    prisma.generationTask.findUnique.mockResolvedValue(staged)
    gateway.completeMultimodal = jest.fn().mockResolvedValue({
      requestId: undefined,
      completion: { choices: [{ message: {} }] }, // content 缺失 → 空返回
    })
    const failTask = jest
      .spyOn(
        runner as unknown as { failTask: (taskId: number, message: string) => Promise<void> },
        "failTask"
      )
      .mockResolvedValue()

    await runner.run(31)

    expect(gateway.completeMultimodal).toHaveBeenCalledTimes(1)
    expect(failTask).toHaveBeenCalledWith(31, "生图规划失败，请重试")
  })

  it("生图规划提示词版本升 v4（站点语言硬规则 + 显式 language 字段）", () => {
    const { runner } = setup()
    expect(runner.getPromptVersions().productImageGeneration).toBe("v4")
    expect(runner.getPromptVersions().productImageGenerationHash).not.toBe("product-hash")
  })

  it("第2步 generation_settings 注入显式语言标签（site=AMAZON_MX → Spanish (es-MX)）", async () => {
    const { runner, prisma, gateway, usage, task } = setup()
    const staged = structuredClone(task)
    staged.aiSplitStage = "PRODUCT_PLANNING"
    delete staged.promptConfig.generationPlan
    staged.promptConfig.generationSettings.site = "AMAZON_MX"
    staged.promptConfig.generationSettings.locale = "es-MX"
    // 三个阶段共享同一 promptConfig 引用：workflow2 会把 requestId/generationPlan
    // 写回快照，后续阶段（计费/提交）要读到这些运行期写入。
    const billingStage = structuredClone(staged)
    billingStage.aiSplitStage = "PRODUCT_BILLING"
    billingStage.promptConfig = staged.promptConfig
    const submittingStage = structuredClone(staged)
    submittingStage.aiSplitStage = "IMAGE_SUBMITTING"
    submittingStage.promptConfig = staged.promptConfig
    prisma.generationTask.findUnique
      .mockResolvedValueOnce(staged)
      .mockResolvedValueOnce(billingStage)
      .mockResolvedValueOnce(submittingStage)
    gateway.completeMultimodal = jest.fn().mockResolvedValue({
      requestId: "req-w2",
      completion: {
        choices: [{ message: { content: JSON.stringify(snapshot.generationPlan) } }],
      },
    })
    gateway.getUsageByRequestId.mockResolvedValue({
      request_id: "req-w2",
      amount: "0.1",
      currency: "CNY",
      status: "succeeded",
    })
    usage.chargeModel.mockResolvedValue({ duplicate: false })

    await runner.run(31)

    expect(gateway.completeMultimodal).toHaveBeenCalledTimes(1)
    const request = gateway.completeMultimodal.mock.calls[0][0] as {
      messages: { role: string; content: unknown }[]
    }
    const userText = (request.messages[1].content as { type: string; text: string }[])[0].text
    const parsed = JSON.parse(userText) as { generation_settings: Record<string, unknown> }
    expect(parsed.generation_settings.language).toBe("Spanish (es-MX)")
    expect(parsed.generation_settings.site).toBe("AMAZON_MX")
  })

  it("终稿 prompt 头尾包站点语言硬指令（site=AMAZON_MX，textAmount=LOW）", async () => {
    const { runner, prisma, gateway, task } = setup()
    const staged = structuredClone(task)
    staged.promptConfig.generationSettings.site = "AMAZON_MX"
    prisma.generationTask.findUnique.mockResolvedValue(staged)

    await runner.run(31)

    const request = (
      gateway.createImageTask.mock.calls as [Record<string, unknown>, string][]
    )[0][0]
    expect(String(request.prompt).startsWith("LANGUAGE=SPANISH (ES-MX). STRICT RULE:")).toBe(true)
    expect(request.prompt).toContain("MUST be written in Spanish only")
    expect(
      String(request.prompt).endsWith(
        "must be in Spanish (es-MX); translate any other-language copy into Spanish first and reject foreign characters even if the source description contains them."
      )
    ).toBe(true)
    // 规划产物本体仍在（头尾包裹不吞内容）。
    expect(request.prompt).toContain("生成电商主图")
  })

  it("textAmount=NONE 无文字时终稿不包语言指令", async () => {
    const { runner, prisma, gateway, task } = setup()
    const staged = structuredClone(task)
    staged.promptConfig.generationSettings.textAmount = "NONE"
    prisma.generationTask.findUnique.mockResolvedValue(staged)

    await runner.run(31)

    const request = (
      gateway.createImageTask.mock.calls as [Record<string, unknown>, string][]
    )[0][0]
    expect(String(request.prompt)).not.toContain("LANGUAGE=")
  })

  it("site 国家码查不到时终稿兜底英文指令（旧快照/新站点同口径）", async () => {
    const { runner, prisma, gateway, task } = setup()
    const staged = structuredClone(task)
    staged.promptConfig.generationSettings.site = "TIKTOK_ZZ"
    prisma.generationTask.findUnique.mockResolvedValue(staged)

    await runner.run(31)

    const request = (
      gateway.createImageTask.mock.calls as [Record<string, unknown>, string][]
    )[0][0]
    expect(String(request.prompt).startsWith("LANGUAGE=ENGLISH (EN-US). STRICT RULE:")).toBe(true)
  })

  it("模型未明确声明 JSON Schema 能力时不发送 response_format", () => {
    const { runner } = setup()
    const structuredOutput = (
      runner as unknown as {
        structuredOutput: (
          value: AiSplitPromptSnapshot,
          name: string,
          schema: Record<string, unknown>
        ) => Record<string, unknown>
      }
    ).structuredOutput.bind(runner)

    expect(structuredOutput(snapshot, "test", { type: "object" })).toEqual({})
    const structuredSystemPrompt = (
      runner as unknown as {
        structuredSystemPrompt: (
          value: AiSplitPromptSnapshot,
          prompt: string,
          schema: Record<string, unknown>
        ) => string
      }
    ).structuredSystemPrompt.bind(runner)
    expect(structuredSystemPrompt(snapshot, "原提示词", { required: ["prompt"] })).toContain(
      '"required":["prompt"]'
    )

    const supported = structuredClone(snapshot)
    supported.analysisModel.gatewayConfig = {
      detail: { facts: { supports_json_schema: true } },
    }
    expect(structuredOutput(supported, "test", { type: "object" })).toEqual({
      response_format: {
        type: "json_schema",
        json_schema: { name: "test", strict: true, schema: { type: "object" } },
      },
    })
    expect(structuredSystemPrompt(supported, "原提示词", { required: ["prompt"] })).toBe("原提示词")
  })

  it.each(["vidflowos", "platform", undefined])(
    "来源 %s 按 Gateway requestId 实际金额扣费并生成确定性幂等键",
    async source => {
      const { runner, gateway, usage, prisma, task } = setup()
      task.source = source
      const billingSnapshot = structuredClone(snapshot)
      billingSnapshot.gatewayCalls.workflow1RequestId = "gateway-request-1"
      gateway.getUsageByRequestId.mockResolvedValue({
        request_id: "gateway-request-1",
        amount: "0.125",
        currency: "CNY",
        status: "succeeded",
      })
      usage.chargeModel.mockResolvedValue({ duplicate: false })
      const settle = (
        runner as unknown as {
          settleWorkflow: (
            taskValue: typeof task,
            value: AiSplitPromptSnapshot,
            workflow: 1 | 2
          ) => Promise<boolean>
        }
      ).settleWorkflow.bind(runner)

      await expect(settle(task, billingSnapshot, 1)).resolves.toBe(true)

      const expectedRequestId = `ais:${createHash("sha256")
        .update("gateway-request-1")
        .digest("hex")
        .slice(0, 40)}`
      expect(usage.chargeModel).toHaveBeenCalledWith(
        7,
        "0.125",
        expect.objectContaining({
          source: "aicreative.ai_split",
          invokeType: source === "vidflowos" ? "API" : "PLATFORM",
          model: "ZQ-Multimodal-Gemini-3.1-Pro",
          requestId: expectedRequestId,
          allowOverdraft: true,
        })
      )
      expect(prisma.generationTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ aiSplitStage: "PRODUCT_PLANNING" }) as unknown,
        })
      )
    }
  )

  it("生图模型配置组合一口价时：分析两步跳过计费（不查用量不扣费），阶段照常推进", async () => {
    const { runner, gateway, usage, prisma, task } = setup()
    usage.gatewayFixedImageCredits.mockResolvedValue(new Decimal(30))
    const billingSnapshot = structuredClone(snapshot)
    billingSnapshot.gatewayCalls.workflow1RequestId = "gateway-request-1"
    const settle = (
      runner as unknown as {
        settleWorkflow: (
          taskValue: typeof task,
          value: AiSplitPromptSnapshot,
          workflow: 1 | 2
        ) => Promise<boolean>
      }
    ).settleWorkflow.bind(runner)

    await expect(settle(task, billingSnapshot, 1)).resolves.toBe(true)

    // 按生图模型 AI_SPLIT 行读组合价（实时读库）
    expect(usage.gatewayFixedImageCredits).toHaveBeenCalledWith("ZQ-Image-3", "AI_SPLIT")
    expect(gateway.getUsageByRequestId).not.toHaveBeenCalled()
    expect(usage.chargeModel).not.toHaveBeenCalled()
    // 阶段照常推进到第 2 步生图规划
    expect(prisma.generationTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ aiSplitStage: "PRODUCT_PLANNING" }),
      })
    )
  })
})
