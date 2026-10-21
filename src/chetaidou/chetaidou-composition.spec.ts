import {
  CompositionValidationContext,
  ModelOutputInvalidError,
  compositionScopeKey,
  parseCompositionJson,
  validateCompositionOutput,
} from "./chetaidou.schemas"

const ctx: CompositionValidationContext = {
  settings: {
    site: "amazon_us",
    textMode: "show",
    personMode: "keep",
    personText: "",
    customText: "",
  },
  selectionIds: ["copy-a", "copy-b"],
  effectiveDecisionIds: [],
  breakdown: null,
  selections: [
    { selectionId: "copy-a", kind: "copy", targetText: "Go now" },
    { selectionId: "copy-b", kind: "copy", targetText: "Ride today" },
  ],
}
const addition = (targetText: string) => ({ targetText, targetLocale: "en-US", meaningCn: "出发" })
const ready = () => ({
  status: "ready",
  summaryCn: "更换文案",
  editPromptEn: 'Use "Go now" and "Ride today".',
  coveredSelectionIds: ["copy-a", "copy-b"],
  changedFeatures: [],
  preservedFeatures: [],
  copyAdditions: [addition("Go now"), addition("Ride today")],
  textReplacements: [],
  acknowledgedAnswerIds: [],
  conflicts: [],
})
const question = () => ({
  status: "needs_resolution",
  summaryCn: "文案冲突",
  editPromptEn: "",
  conflicts: [
    {
      id: "copy",
      question: "保留哪条？",
      reason: "两条文案互斥",
      sources: ["copy-a", "copy-b"],
      blocking: false,
      choices: [
        { id: "a", label: "保留 A", instruction: "Keep Go now" },
        { id: "b", label: "保留 B", instruction: "Keep Ride today" },
      ],
    },
  ],
})

describe("组合结构与文案契约", () => {
  it("PRD 组合不要求额外的硬条件逐字检查，完整英文指令原样保留", () => {
    const data = ready()
    const output = validateCompositionOutput(data, ctx)
    expect(output.status).toBe("READY")
    expect(output.editPromptEn).toBe(data.editPromptEn)
    expect(output).not.toHaveProperty("hardConstraintChecks")
  })
  it("旧模板的扩展检查不再构成门槛，也不进入新产物或改写回执", () => {
    for (const legacy of [
      null,
      [],
      { obsolete: true },
      [{ constraintId: "fact_hard_1", status: "preserved", instructionEn: "Keep the basket." }],
    ]) {
      const data = { ...ready(), hardConstraintChecks: legacy }
      const original = structuredClone(data)
      const output = validateCompositionOutput(data, ctx)
      expect(output.editPromptEn).toBe(data.editPromptEn)
      expect(output).not.toHaveProperty("hardConstraintChecks")
      expect(data).toEqual(original)
    }
    // 只兼容撤销的扩展字段，其他未知字段及遗漏选择仍按契约拒绝。
    expect(() => validateCompositionOutput({ ...ready(), unrecognized: true }, ctx)).toThrow()
    expect(() =>
      validateCompositionOutput({ ...ready(), coveredSelectionIds: ["copy-a"] }, ctx)
    ).toThrow("覆盖缺少已选项")
    expect(() =>
      validateCompositionOutput({ ...ready(), hardConstraintChecks: [{ status: "conflict" }] }, ctx)
    ).toThrow("组合包含未解决的硬事实冲突")
  })
  it("硬事实冲突保持阻断，没有可执行生图指令", () => {
    const data = question()
    data.conflicts = [{ ...data.conflicts[0], blocking: true, choices: [] }]
    expect(validateCompositionOutput(data, ctx)).toMatchObject({
      status: "NEEDS_RESOLUTION",
      editPromptEn: null,
      conflicts: [{ blocking: true, choices: [] }],
    })
  })
  it("一条文案搭配一个排版选择只需要一条准确文案，不为排版再造广告语", () => {
    const context: CompositionValidationContext = {
      ...ctx,
      selectionIds: ["copy-a", "layout-a"],
      selections: [
        { selectionId: "copy-a", kind: "copy", targetText: "Go now" },
        { selectionId: "layout-a", kind: "visual" },
      ],
    }
    const data = {
      ...ready(),
      editPromptEn:
        'Place "Go now" in the top-left negative space, left aligned; avoid the rider and vehicle.',
      coveredSelectionIds: context.selectionIds,
      copyAdditions: [addition("Go now")],
    }
    expect(validateCompositionOutput(data, context).copyAdditions).toHaveLength(1)
    expect(() =>
      validateCompositionOutput({ ...data, copyAdditions: [addition("Ride today")] }, context)
    ).toThrow()
  })
  it("正常文案通过，精简冲突结构无需最终文案字段", () => {
    expect(validateCompositionOutput(ready(), ctx).status).toBe("READY")
    expect(validateCompositionOutput(question(), ctx)).toMatchObject({
      status: "NEEDS_RESOLUTION",
      editPromptEn: null,
      copyAdditions: [],
    })
  })
  it("坏 JSON 统一为模型内容错误，代码块 JSON 仍兼容", () => {
    expect(() => parseCompositionJson("{")).toThrow(ModelOutputInvalidError)
    expect(parseCompositionJson('```json\n{"status":"ready"}\n```')).toEqual({ status: "ready" })
  })
  it("缺失及多余字段带路径和实际字段名，不映射或补空", () => {
    const raw = {
      ...ready(),
      copyAdditions: [{ text: "Go now", locale: "en-US", meaning: "出发" }],
    }
    try {
      validateCompositionOutput(raw, ctx)
      throw new Error("校验未拒绝")
    } catch (error) {
      expect(error).toBeInstanceOf(ModelOutputInvalidError)
      const invalid = error as ModelOutputInvalidError
      expect(invalid.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            instancePath: "/copyAdditions/0",
            params: { missingProperty: "targetText" },
          }),
          expect.objectContaining({ params: { additionalProperty: "text" } }),
        ])
      )
      expect(invalid.message).toContain('"additionalProperty":"text"')
      expect(raw.copyAdditions[0]).toEqual({ text: "Go now", locale: "en-US", meaning: "出发" })
    }
  })
  it.each([
    { copyAdditions: [] },
    { copyAdditions: [addition("different")] },
    { copyAdditions: [{ ...addition("Go now"), targetLocale: "ja-JP" }] },
    { copyAdditions: [{ ...addition("Go now"), meaningCn: " " }] },
    { copyAdditions: [addition("Go now")] },
    { coveredSelectionIds: ["copy-a", "copy-b", "copy-b"] },
  ])("非法文案或覆盖不允许生图：%j", overrides => {
    expect(() => validateCompositionOutput({ ...ready(), ...overrides }, ctx)).toThrow(
      ModelOutputInvalidError
    )
  })
  it("只有被有效非阻断决策精确命名的文案可取舍，覆盖 ID 仍完整", () => {
    const data = { ...ready(), copyAdditions: [addition("Go now")], acknowledgedAnswerIds: ["d1"] }
    const decision = {
      decisionId: "d1",
      originalConflict: { blocking: false, sources: ["copy-a", "copy-b"] },
    }
    const resolvedCtx = { ...ctx, effectiveDecisionIds: ["d1"], decisions: [decision] }
    expect(validateCompositionOutput(data, resolvedCtx).status).toBe("READY")
    for (const originalConflict of [
      { blocking: true, sources: ["copy-a", "copy-b"] },
      { blocking: false, sources: ["all"] },
    ]) {
      expect(() =>
        validateCompositionOutput(data, {
          ...resolvedCtx,
          decisions: [{ ...decision, originalConflict }],
        })
      ).toThrow(/未原样保留/)
    }
    expect(() =>
      validateCompositionOutput({ ...data, acknowledgedAnswerIds: [] }, resolvedCtx)
    ).toThrow(/未确认/)
  })
  it("冲突禁止可执行指令，软冲突必须有选项且选项 ID 唯一", () => {
    const raw = question()
    expect(() => validateCompositionOutput({ ...raw, editPromptEn: "Generate now" }, ctx)).toThrow()
    expect(() =>
      validateCompositionOutput({ ...raw, conflicts: [{ ...raw.conflicts[0], choices: [] }] }, ctx)
    ).toThrow(/处理选项/)
    expect(() =>
      validateCompositionOutput(
        {
          ...raw,
          conflicts: [
            {
              ...raw.conflicts[0],
              choices: [raw.conflicts[0].choices[0], raw.conflicts[0].choices[0]],
            },
          ],
        },
        ctx
      )
    ).toThrow(/ID 重复/)
    expect(
      validateCompositionOutput(
        { ...raw, conflicts: [{ ...raw.conflicts[0], blocking: true, choices: [] }] },
        ctx
      ).status
    ).toBe("NEEDS_RESOLUTION")
  })
  it("translate 对齐原文、可编辑属性、目标语言和提示词", () => {
    const translatedCtx: CompositionValidationContext = {
      ...ctx,
      selections: [],
      settings: { ...ctx.settings, textMode: "translate" },
      breakdown: {
        textInventory: [
          {
            textId: "t1",
            sourceText: "出发",
            category: "marketing",
            editable: true,
            readability: "readable",
          },
        ],
      } as CompositionValidationContext["breakdown"],
    }
    const raw = {
      ...ready(),
      copyAdditions: [],
      textReplacements: [
        { textId: "t1", sourceText: "出发", targetText: "Go now", targetLocale: "en-US" },
      ],
    }
    expect(validateCompositionOutput(raw, translatedCtx).status).toBe("READY")
    expect(() =>
      validateCompositionOutput({ ...raw, textReplacements: [] }, translatedCtx)
    ).toThrow(/遗漏/)
    expect(() =>
      validateCompositionOutput(
        { ...raw, textReplacements: [{ ...raw.textReplacements[0], sourceText: "伪造" }] },
        translatedCtx
      )
    ).toThrow(/不匹配/)
    expect(() =>
      validateCompositionOutput(
        { ...raw, textReplacements: [{ ...raw.textReplacements[0], targetLocale: "ja-JP" }] },
        translatedCtx
      )
    ).toThrow(/语言/)
  })
  it("决策范围按原问题及来源生成，来源顺序无关，缺失原问题不猜测", () => {
    expect(compositionScopeKey("问题", ["a", "b"])).toBe(compositionScopeKey("问题", ["b", "a"]))
    expect(compositionScopeKey("问题", ["a"])).not.toBe(compositionScopeKey("另一问题", ["a"]))
    expect(compositionScopeKey(undefined, ["a"])).toBeNull()
  })
})
