// 车泰斗素材工作台 — 模型输出校验单测（方案 §10）
// 「JSON 可解析 ≠ 可用」：各失败分支（坏 JSON/少维/重复/漏货篮/漏文案/覆盖不精确）
import Ajv from "ajv"
import {
  ChetaidouGroupDefinition,
  ModelOutputInvalidError,
  deriveRequiredDimensions,
  identifySchemaOf,
  parseModelJson,
  validateBatchGroupOptions,
  validateBreakdownOutput,
  validateBreakdownResponse,
  validateCompositionOutput,
  validateDivergeOutput,
  validateExpansionOutput,
  validateIdentifyOutput,
  validateSettings,
} from "./chetaidou.schemas"

const settings = {
  site: "original",
  textMode: "keep",
  personMode: "keep",
  personText: "",
  customText: "",
} as const

function validBreakdown() {
  return {
    summary: "整车侧面图，白底",
    hasPeople: false,
    persons: [],
    textInventory: [
      {
        textId: "t1",
        sourceText: "FREE",
        category: "marketing",
        editable: true,
        readability: "readable",
      },
    ],
    softFeatures: { composition: "侧面整车" },
    hardConstraints: ["两轮结构"],
    conflicts: [],
    uncertainties: [],
    basketContents: { hasItems: false, evidence: "", items: [] },
  }
}

function validGroupDef(overrides: Record<string, unknown> = {}) {
  return {
    key: "background",
    label: "背景场景",
    currentValue: "白底",
    sourceDimensions: [],
    expansionReason: "背景可变化",
    selectionMode: "single",
    targetElement: "画面背景",
    attribute: "场景内容",
    kind: "visual",
    ...overrides,
  }
}

describe("parseModelJson", () => {
  it("容忍 ```json 代码块包裹", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it("裸 JSON 直传", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 })
  })
  it("坏 JSON 抛 SyntaxError", () => {
    expect(() => parseModelJson("not-json")).toThrow(SyntaxError)
  })
  it.each(['{"a":1,}', "{'a':1}", "{a:1}", '{/* 注释 */"a":1}'])(
    "本地修复完整对象的格式：%s",
    text => {
      expect(parseModelJson(text)).toEqual({ a: 1 })
    }
  )
  it("补齐内部相邻选项缺失的结束括号和逗号，不修改字段值", () => {
    const expected = {
      groups: [
        {
          key: "copy",
          options: [
            { key: "first", text: '正文包含 } , [ 和转义引号 "', incompatibleWith: [] },
            { key: "second", text: "完整文案", incompatibleWith: [] },
          ],
        },
      ],
    }
    const original = JSON.stringify(expected).replace(
      '"incompatibleWith":[]},{"key":"second"',
      '"incompatibleWith":[]{"key":"second"'
    )
    expect(() => {
      JSON.parse(original)
    }).toThrow(SyntaxError)
    expect(parseModelJson(original)).toEqual(expected)
  })
  it("允许缺失内部数组闭合符，不允许在回复末尾补闭合符", () => {
    expect(parseModelJson('{"a":[1,2}')).toEqual({ a: [1, 2] })
    expect(() => parseModelJson('{"a":[{"b":1}')).toThrow(SyntaxError)
  })
  it.each([
    '{"a":[1,2',
    '{"a":"未完正文}',
    '{"a":}',
    '{"a":[1,]} trailing',
    '{"a":1,/* 未完注释}',
    "{a}",
    "{a:undefined}",
    "{a:1e}",
    "{a:...}",
    "{a:[1,,2]}",
    '{"a":[{"b":1}{"c":}]}',
    '{"a":[{"b":1e}{"c":2}]}',
    '{"a":1}{"b":2}',
    '{"a":[{"key_60","label":"缺值"}{"key":"next"}]}',
    '{"a":[{- items: [1]{"items":[2]}]}',
    '{"a":[{"b":"第一行\n第二行"{"c":2}]}',
  ])("拒绝截断或缺值，不补写内容：%s", text => {
    expect(() => parseModelJson(text)).toThrow(SyntaxError)
  })
  it("格式修复不补必填业务字段", () => {
    expect(() =>
      validateIdentifyOutput(parseModelJson("{groups:[],}"), {
        breakdown: null,
        settings,
      })
    ).toThrow(ModelOutputInvalidError)
  })
  it("字符串里的括号、逗号、注释标记及省略号不影响完整性检查", () => {
    expect(parseModelJson('{a:"文本 } [ // /* ... undefined", b:[1,2,],}')).toEqual({
      a: "文本 } [ // /* ... undefined",
      b: [1, 2],
    })
  })
  it("仅修复字符串里的换行转义，保留正文", () => {
    expect(parseModelJson('{a:"第一行\n第二行",}')).toEqual({ a: "第一行\n第二行" })
    expect(parseModelJson("{a:1/* 注释 */,}")).toEqual({ a: 1 })
  })
})

describe("validateBreakdownResponse", () => {
  it("接受明确无关的拒绝结果", () => {
    const rejected = { status: "REJECTED", reason: "纯人像，无商品或相关素材线索" }
    expect(validateBreakdownResponse(rejected)).toEqual(rejected)
  })
  it.each([
    { status: "REJECTED" },
    { status: "REJECTED", reason: "" },
    { status: "REJECTED", reason: "   " },
    { status: "REJECTED", reason: 1 },
    { status: "REJECTED", reason: "纯人像", ...validBreakdown() },
  ])("不完整或混合拆解字段的拒绝结果仍判输出不合格：%j", data => {
    expect(() => validateBreakdownResponse(data)).toThrow(ModelOutputInvalidError)
  })
  it("正常拆解与历史无状态字段输出保持兼容，并保留业务校验", () => {
    expect(validateBreakdownResponse(validBreakdown())).toEqual(validBreakdown())
    expect(() => validateBreakdownResponse({ ...validBreakdown(), hasPeople: true })).toThrow(
      ModelOutputInvalidError
    )
  })
})

describe("validateBreakdownOutput", () => {
  it("合格拆解通过", () => {
    expect(validateBreakdownOutput(validBreakdown()).basketContents.hasItems).toBe(false)
  })
  it("拆解事实数量不受技术方案额外的 60 条上限限制", () => {
    const data = validBreakdown()
    data.hardConstraints = Array.from({ length: 80 }, (_, i) => `事实 ${i}`)
    expect(validateBreakdownOutput(data).hardConstraints).toHaveLength(80)
  })
  it("hasPeople 与 persons 不一致拒绝", () => {
    const bad = { ...validBreakdown(), hasPeople: true }
    expect(() => validateBreakdownOutput(bad)).toThrow(ModelOutputInvalidError)
  })
  it("非营销文字标记可编辑拒绝", () => {
    const bad = validBreakdown()
    bad.textInventory[0].category = "brand"
    bad.textInventory[0].editable = true
    expect(() => validateBreakdownOutput(bad)).toThrow(ModelOutputInvalidError)
  })
  it("textId 重复拒绝", () => {
    const bad = validBreakdown()
    bad.textInventory.push({ ...bad.textInventory[0] })
    expect(() => validateBreakdownOutput(bad)).toThrow(ModelOutputInvalidError)
  })
  it("缺 basketContents 拒绝", () => {
    const bad = validBreakdown() as Record<string, unknown>
    delete bad.basketContents
    expect(() => validateBreakdownOutput(bad)).toThrow(ModelOutputInvalidError)
  })
})

describe("validateIdentifyOutput", () => {
  const ctx = {
    breakdown: validBreakdown(),
    settings: settings as never,
  }
  function identify(groups: unknown[], basket = { hasItems: false, evidence: "", items: [] }) {
    return { summary: "s", basketContents: basket, groups }
  }
  it("维度漏写 currentValue 时补未指定，保留其他维度及原始输入", () => {
    const groups = Array.from({ length: 20 }, (_, i) =>
      validGroupDef({ key: `g${i}`, label: `维度${i}` })
    )
    delete (groups[12] as Partial<ChetaidouGroupDefinition>).currentValue
    const data = identify(groups)
    const original = structuredClone(data)
    const parsed = validateIdentifyOutput(data, ctx)
    expect(parsed.groups).toHaveLength(20)
    expect(parsed.groups[12]).toEqual({ ...groups[12], currentValue: "未指定" })
    expect(parsed.groups[0].currentValue).toBe("白底")
    expect(data).toEqual(original)
  })
  it.each(["single", "multi", undefined, "unknown"])(
    "AI 联想的 selectionMode=%s 由后端统一规范为 single，保留原始输入",
    selectionMode => {
      const data = identify([validGroupDef({ selectionMode })])
      const original = structuredClone(data)
      expect(validateIdentifyOutput(data, ctx).groups[0].selectionMode).toBe("single")
      expect(data).toEqual(original)
    }
  )
  it("清洗识别结果中的额外字段，保留合法条件字段和原始输入", () => {
    const group = validGroupDef({
      label_duplicate_check: "true",
      purpose: "basket_contents",
      basketId: "basket_1",
    })
    const data = {
      ...identify([group]),
      self_check: "通过",
      basketContents: {
        hasItems: false,
        evidence: "",
        items: [],
        check: true,
      },
    }
    const original = structuredClone(data)
    const parsed = validateIdentifyOutput(data, ctx)
    expect(parsed).toEqual({
      summary: "s",
      basketContents: { hasItems: false, evidence: "", items: [] },
      groups: [validGroupDef({ purpose: "basket_contents", basketId: "basket_1" })],
    })
    expect(data).toEqual(original)
  })
  it.each([
    ["缺必填字段", { attribute: undefined }],
    ["currentValue 为 null", { currentValue: null }],
    ["currentValue 类型错误", { currentValue: 42 }],
    ["类型错误", { sourceDimensions: "背景" }],
    ["非法枚举", { kind: "unknown" }],
  ])("剔除自检字段后仍拒绝%s", (_reason, overrides) => {
    const group = validGroupDef({ label_duplicate_check: "true", ...overrides })
    expect(() => validateIdentifyOutput(identify([group]), ctx)).toThrow(ModelOutputInvalidError)
  })
  it.each([
    ["key", { key: "background", label: "另一维度" }],
    ["label", { key: "another", label: "背景场景" }],
  ])("剔除自检字段后仍拒绝重复维度 %s", (_field, overrides) => {
    const groups = [validGroupDef(), validGroupDef({ label_duplicate_check: "true", ...overrides })]
    expect(() => validateIdentifyOutput(identify(groups), ctx)).toThrow(/重复/)
  })
  it("10–20 维合格通过", () => {
    const groups = Array.from({ length: 10 }, (_, i) =>
      validGroupDef({ key: `g${i}`, label: `维度${i}` })
    )
    expect(validateIdentifyOutput(identify(groups), ctx).groups).toHaveLength(10)
  })
  it("少于目标维度数量仍返回实际结果", () => {
    const groups = Array.from({ length: 9 }, (_, i) =>
      validGroupDef({ key: `g${i}`, label: `维度${i}` })
    )
    expect(validateIdentifyOutput(identify(groups), ctx).groups).toHaveLength(9)
  })
  it("超过目标维度数量仍返回实际结果", () => {
    const groups = Array.from({ length: 21 }, (_, i) =>
      validGroupDef({ key: `g${i}`, label: `维度${i}` })
    )
    expect(validateIdentifyOutput(identify(groups), ctx).groups).toHaveLength(21)
  })
  it.each([3, 24])("要求 10–20 维但实际返回 %i 维也通过结构校验", count => {
    const groups = Array.from({ length: count }, (_, i) =>
      validGroupDef({ key: `g${i}`, label: `维度${i}` })
    )
    expect(
      validateIdentifyOutput(identify(groups), { ...ctx, countRange: { min: 10, max: 20 } }).groups
    ).toHaveLength(count)
  })
  it("label 重复拒绝", () => {
    const groups = Array.from({ length: 10 }, () => validGroupDef({ key: "same" }))
    expect(() => validateIdentifyOutput(identify(groups), ctx)).toThrow(ModelOutputInvalidError)
  })
  it("textMode=show 必须有 copy 维", () => {
    const groups = Array.from({ length: 10 }, (_, i) =>
      validGroupDef({ key: `g${i}`, label: `维度${i}` })
    )
    expect(() =>
      validateIdentifyOutput(identify(groups), {
        ...ctx,
        settings: { ...settings, textMode: "show" } as never,
      })
    ).toThrow(/文案/)
  })
  it.each(["keep", "translate", "hide"] as const)(
    "textMode=%s 剔除 copy，保留其他维度及原始回执",
    textMode => {
      const groups = Array.from({ length: 10 }, (_, i) =>
        validGroupDef({ key: `g${i}`, label: `维度${i}`, ...(i === 0 ? { kind: "copy" } : {}) })
      )
      const data = identify(groups)
      const original = structuredClone(data)
      expect(
        validateIdentifyOutput(data, { ...ctx, settings: { ...settings, textMode } }).groups
      ).toEqual(groups.slice(1))
      expect(data).toEqual(original)
    }
  )
  it("空维度或剔除后没有有效维度仍失败", () => {
    for (const groups of [[], [validGroupDef({ kind: "copy" })]])
      expect(() => validateIdentifyOutput(identify(groups), ctx)).toThrow(ModelOutputInvalidError)
  })
  it.each(["keep", "hide", "translate", "show"] as const)(
    "识别 Schema 遵守文字模式 %s",
    textMode => {
      const schema = identifySchemaOf({
        ...settings,
        textMode,
        dimensionCountRange: { min: 1, max: 2 },
      })
      expect(schema.properties.groups.items.properties.kind.enum).toEqual(
        textMode === "show" ? ["visual", "copy"] : ["visual"]
      )
      expect(schema.properties.groups.minItems).toBe(1)
      const validate = new Ajv({ strict: false }).compile(schema)
      expect(validate(identify([validGroupDef()]))).toBe(textMode !== "show")
      expect(
        validate(identify([validGroupDef(), validGroupDef({ key: "copy", kind: "copy" })]))
      ).toBe(textMode === "show")
      expect(validate(identify([validGroupDef({ purpose: "copy_layout" })]))).toBe(
        textMode === "keep" || textMode === "translate"
      )
      expect(validate(identify([]))).toBe(false)
    }
  )
  it.each([9, 10, 20, 21])("模型请求 Schema 按 10–20 维约束实际 %i 维", count => {
    const schema = identifySchemaOf({ ...settings, dimensionCountRange: { min: 10, max: 20 } })
    expect(schema.properties.groups.minItems).toBe(10)
    expect(schema.properties.groups.maxItems).toBe(20)
    const groups = Array.from({ length: count }, (_, i) =>
      validGroupDef({ key: `g${i}`, label: `维度${i}` })
    )
    expect(new Ajv({ strict: false }).compile(schema)(identify(groups))).toBe(
      count >= 10 && count <= 20
    )
  })
  it("请求未指定数量时使用 10–20 维，清理后不足仍保留", () => {
    const schema = identifySchemaOf(settings)
    expect(schema.properties.groups.minItems).toBe(10)
    expect(schema.properties.groups.maxItems).toBe(20)
    const groups = Array.from({ length: 10 }, (_, i) =>
      validGroupDef({ key: `g${i}`, label: `维度${i}`, ...(i === 0 ? { kind: "copy" } : {}) })
    )
    expect(validateIdentifyOutput(identify(groups), ctx).groups).toHaveLength(9)
  })
  it("货篮有物品必须有 basket_contents 维", () => {
    const groups = Array.from({ length: 10 }, (_, i) =>
      validGroupDef({ key: `g${i}`, label: `维度${i}` })
    )
    const basket = { hasItems: true, evidence: "纸箱", items: ["纸箱"] }
    const ctxWithBasket = {
      ...ctx,
      breakdown: { ...ctx.breakdown, basketContents: basket },
    }
    expect(() => validateIdentifyOutput(identify(groups, basket), ctxWithBasket)).toThrow(
      /basket_contents/
    )
    // 补上后通过
    groups[9] = validGroupDef({ key: "basket", label: "货篮物品", purpose: "basket_contents" })
    expect(() => validateIdentifyOutput(identify(groups, basket), ctxWithBasket)).not.toThrow()
  })
})

describe.each(["batch", "single", "diverge"])("%s 选项名称去重", mode => {
  const definition = validGroupDef() as ChetaidouGroupDefinition
  const countRange = { min: 30, max: 60 }
  const validate = (options: unknown[]) => {
    if (mode === "batch")
      return validateBatchGroupOptions(
        { groups: [{ key: definition.key, options }] },
        definition,
        settings,
        countRange
      )
    if (mode === "single")
      return validateExpansionOutput(
        { group: { ...definition, options } },
        { definition, settings, countRange }
      )
    return validateDivergeOutput({ options }, { settings, countRange })
  }
  const makeOptions = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      key: `option_${i}`,
      label: `方案 ${i}`,
      changeInstruction: `改变背景为场景 ${i}`,
      preserveInstruction: "保持产品结构",
      riskLevel: "low",
      riskReason: "",
      requiresEvidence: false,
      evidenceNeeded: [],
      dependentChanges: [],
      incompatibleWith: [],
    }))

  it("缺失联动、互斥及无需证据的说明时补空数组，保留原始回执", () => {
    const options: Record<string, unknown>[] = makeOptions(40)
    for (const option of options) {
      delete option.dependentChanges
      delete option.incompatibleWith
      delete option.evidenceNeeded
    }
    const original = structuredClone(options)
    expect(validate(options)).toEqual(makeOptions(40))
    expect(options).toEqual(original)
  })

  it("已返回的联动、互斥与证据说明原样保留", () => {
    const option = {
      ...makeOptions(1)[0],
      requiresEvidence: true,
      dependentChanges: ["调整接地阴影"],
      incompatibleWith: ["scene.night"],
      evidenceNeeded: ["补充未遮挡的结构图"],
    }
    expect(validate([option])).toEqual([option])
  })

  it("需要证据时缺少证据说明仍剔除，缺失证据标记也不默认放行", () => {
    const option: Record<string, unknown> = makeOptions(1)[0]
    delete option.evidenceNeeded
    expect(() => validate([{ ...option, requiresEvidence: true }])).toThrow(/evidenceNeeded/)
    delete option.requiresEvidence
    expect(() => validate([option])).toThrow(/requiresEvidence/)
  })

  it.each([
    ["dependentChanges", null],
    ["dependentChanges", "无"],
    ["incompatibleWith", {}],
    ["evidenceNeeded", [1]],
  ])("辅助字段 %s 已返回错误类型 %p 时仍剔除该项", (field, value) => {
    const good = makeOptions(1)[0]
    const bad = { ...good, [field]: value }
    expect(validate([bad, good])).toEqual([good])
  })

  it("60 项中同名方案保留第一项，返回 59 项且不改写原始回执", () => {
    const options = makeOptions(60)
    options[56].label = ` ${options[15].label} `
    options[56].changeInstruction = "重复项的不同指令不覆盖首次方案"
    const original = structuredClone(options)
    const result = validate(options)
    expect(result).toHaveLength(59)
    expect(result[15]).toEqual(original[15])
    expect(result.some(o => o.key === options[56].key)).toBe(false)
    expect(result.map(o => o.key)).toEqual(original.filter((_, i) => i !== 56).map(o => o.key))
    expect(options).toEqual(original)
  })

  it("完全重复的 key 与名称同样只保留一次", () => {
    const options = makeOptions(60)
    options[59] = { ...options[0] }
    expect(validate(options)).toHaveLength(59)
  })

  it("去重后低于目标数量仍保留实际方案", () => {
    const options = makeOptions(30)
    options[29].label = options[0].label
    expect(validate(options)).toHaveLength(29)
  })

  it.each([6, 61])("要求 30–60 项但实际返回 %i 项也成功", count => {
    expect(validate(makeOptions(count))).toHaveLength(count)
  })

  if (mode !== "batch")
    it("旧任务未设置数量范围也保留不足或超出目标的结果", () => {
      for (const count of [6, 61]) {
        const options = makeOptions(count)
        const result =
          mode === "single"
            ? validateExpansionOutput(
                { group: { ...definition, options } },
                { definition, settings }
              )
            : validateDivergeOutput({ options }, { settings, maxOptions: 60 })
        expect(result).toHaveLength(count)
      }
    })

  if (mode === "single")
    it("单维扩展忽略模型回填的多选模式，原始结果不变", () => {
      const data = {
        group: { ...validGroupDef({ selectionMode: "multi" }), options: makeOptions(2) },
      }
      expect(
        validateExpansionOutput(data, { definition: validGroupDef() as never, settings })
      ).toHaveLength(2)
      expect(data.group.selectionMode).toBe("multi")
    })

  it("不同名称复用 key 时剔除后项，保留唯一选择标识", () => {
    const options = makeOptions(30)
    options[29].key = options[0].key
    expect(validate(options)).toEqual(options.slice(0, -1))
  })
  it("逐条剔除缺字段、类型错误和非法枚举，原始回执不变", () => {
    const options: Record<string, unknown>[] = makeOptions(6)
    delete options[1].changeInstruction
    options[2].evidenceNeeded = "无"
    options[3].riskLevel = "unknown"
    const raw = [...options, null]
    const original = structuredClone(raw)
    expect(validate(raw)).toEqual([options[0], options[4], options[5]])
    expect(raw).toEqual(original)
  })
  it("同名坏项不占用名称，后续完整选项仍保留", () => {
    const good = makeOptions(1)[0]
    expect(validate([{ ...good, changeInstruction: undefined }, good])).toEqual([good])
  })
  it("空选项或全部无效仍失败", () => {
    for (const options of [[], [{ key: "bad" }]])
      expect(() => validate(options)).toThrow(ModelOutputInvalidError)
  })
})

describe("文案内容与排版隔离", () => {
  const showSettings = { ...settings, site: "amazon_jp", textMode: "show" } as const
  const content = validGroupDef({ key: "content", label: "营销文案内容", kind: "copy" })
  const layout = validGroupDef({
    key: "layout",
    label: "文案排版位置",
    targetElement: "营销文字",
    attribute: "位置与对齐",
    kind: "visual",
    purpose: "copy_layout",
  }) as ChetaidouGroupDefinition
  const range = { min: 1, max: 2 }
  const option = {
    key: "left_top",
    label: "左上留白区横排，左对齐",
    changeInstruction: "将已选营销文案置于左上留白区并左对齐",
    preserveInstruction: "避开人物面部与车把，不改写已选文案",
    riskLevel: "low",
    riskReason: "仅改变位置",
    requiresEvidence: false,
    evidenceNeeded: [],
    dependentChanges: [],
    incompatibleWith: [],
  }
  const identify = (groups: unknown[]) => ({
    summary: "文案与排版分别选择",
    basketContents: { hasItems: false, evidence: "", items: [] },
    groups,
  })
  const identifyContext = { breakdown: validBreakdown(), settings: showSettings, countRange: range }

  it("内容 copy + 排版 visual 可同时存在；排版不能充当必需文案内容", () => {
    expect(
      validateIdentifyOutput(identify([content, layout]), identifyContext).groups
    ).toHaveLength(2)
    expect(() => validateIdentifyOutput(identify([layout]), identifyContext)).toThrow(
      /必须包含文案/
    )
  })

  it("排版误标 copy 或隐藏文字模式下生成排版，交给定向修复", () => {
    expect(() =>
      validateIdentifyOutput(identify([{ ...layout, kind: "copy" }]), identifyContext)
    ).toThrow(/必须为 visual/)
    expect(() =>
      validateIdentifyOutput(identify([layout]), {
        ...identifyContext,
        settings: { ...showSettings, textMode: "hide" },
      })
    ).toThrow(ModelOutputInvalidError)
  })
  it("hide 剔除排版维度，保留普通视觉维度", () => {
    expect(
      validateIdentifyOutput(identify([layout, validGroupDef()]), {
        ...identifyContext,
        settings: { ...showSettings, textMode: "hide" },
      }).groups
    ).toEqual([validGroupDef()])
  })

  it.each(["batch", "single"])("%s 扩展允许纯排版，拒绝夹带新广告语", mode => {
    const validate = (options: unknown[]) =>
      mode === "batch"
        ? validateBatchGroupOptions(
            { groups: [{ key: layout.key, options }] },
            layout,
            showSettings,
            range
          )
        : validateExpansionOutput(
            { group: { ...layout, options } },
            { definition: layout, settings: showSettings, countRange: range }
          )
    expect(validate([option])[0].label).toBe(option.label)
    for (const extra of [
      { targetText: "毎日の買い物が、もっとラクに。" },
      { targetLocale: "ja-JP" },
      { meaningCn: "让购物更轻松" },
    ]) {
      expect(() => validate([{ ...option, ...extra }])).toThrow(/只能描述排版/)
      expect(validate([{ ...option, ...extra }, option])).toEqual([option])
    }
  })

  it("真实 copy 选项仍要求准确目标文案，历史未带 purpose 的文案组仍兼容", () => {
    const def = content as ChetaidouGroupDefinition
    const validate = (options: unknown[]) =>
      validateBatchGroupOptions({ groups: [{ key: def.key, options }] }, def, showSettings, range)
    expect(() => validate([option])).toThrow(/copy 选项缺少/)
    expect(
      validate([
        {
          ...option,
          targetText: "毎日のお買い物をもっと快適に。",
          targetLocale: "ja-JP",
          meaningCn: "让购物更舒适",
        },
      ])
    ).toHaveLength(1)
  })
})

describe("copy 选项部分挽救", () => {
  it("仅保留字段完整且目标语言正确的选项，原始回执不变", () => {
    const definition = validGroupDef({ key: "copy", kind: "copy" }) as ChetaidouGroupDefinition
    const valid = {
      key: "copy_good",
      label: "每日购物",
      changeInstruction: "增加营销文字",
      preserveInstruction: "保持产品",
      riskLevel: "low",
      riskReason: "",
      requiresEvidence: false,
      evidenceNeeded: [],
      dependentChanges: [],
      incompatibleWith: [],
      targetText: "毎日の買い物",
      targetLocale: "ja-JP",
      meaningCn: "每日购物",
    }
    const options = [{ ...valid, targetLocale: "en-US" }, { ...valid, meaningCn: undefined }, valid]
    const original = structuredClone(options)
    expect(
      validateBatchGroupOptions(
        { groups: [{ key: definition.key, options }] },
        definition,
        { ...settings, site: "amazon_jp", textMode: "show" },
        { min: 30, max: 60 }
      )
    ).toEqual([valid])
    expect(options).toEqual(original)
  })
})

describe("deriveRequiredDimensions", () => {
  it("show → copy 维；occupied basket → basket_contents 维", () => {
    expect(
      deriveRequiredDimensions(
        validBreakdown() as never,
        { ...settings, textMode: "show" } as never
      )
    ).toEqual([{ kind: "copy" }])
    const withItems = {
      ...validBreakdown(),
      basketContents: { hasItems: true, evidence: "x", items: ["y"] },
    }
    expect(deriveRequiredDimensions(withItems as never, settings as never)).toEqual([
      { purpose: "basket_contents" },
    ])
    expect(deriveRequiredDimensions(validBreakdown() as never, settings as never)).toEqual([])
  })
})

describe("validateCompositionOutput", () => {
  const composeCtx = {
    settings: settings as never,
    selectionIds: ["sel-1", "sel-2"],
    effectiveDecisionIds: ["dec-1"],
    breakdown: validBreakdown() as never,
  }
  function readyOutput(overrides: Record<string, unknown> = {}) {
    return {
      status: "ready",
      summaryCn: "更换背景并加雨衣",
      editPromptEn: "Edit the background to a rainy street; keep the bike.",
      coveredSelectionIds: ["sel-1", "sel-2"],
      changedFeatures: ["背景"],
      preservedFeatures: ["车架"],
      textReplacements: [],
      copyAdditions: [],
      conflicts: [],
      acknowledgedAnswerIds: ["dec-1"],
      ...overrides,
    }
  }
  it("READY 且覆盖精确通过", () => {
    const out = validateCompositionOutput(readyOutput(), composeCtx)
    expect(out.status).toBe("READY")
    expect(out.editPromptEn).toContain("Edit the background")
  })
  it("覆盖缺少已选项拒绝", () => {
    expect(() =>
      validateCompositionOutput(readyOutput({ coveredSelectionIds: ["sel-1"] }), composeCtx)
    ).toThrow(/覆盖缺少/)
  })
  it("覆盖包含未知 ID 拒绝", () => {
    expect(() =>
      validateCompositionOutput(
        readyOutput({ coveredSelectionIds: ["sel-1", "sel-2", "ghost"] }),
        composeCtx
      )
    ).toThrow(/未知选项/)
  })
  it("READY 携带冲突拒绝", () => {
    expect(() =>
      validateCompositionOutput(
        readyOutput({
          conflicts: [
            {
              id: "c1",
              question: "q",
              reason: "r",
              sources: ["sel-1"],
              blocking: false,
              choices: [],
            },
          ],
        }),
        composeCtx
      )
    ).toThrow(/不应携带冲突/)
  })
  it("决策未确认拒绝", () => {
    expect(() =>
      validateCompositionOutput(readyOutput({ acknowledgedAnswerIds: [] }), composeCtx)
    ).toThrow(/未确认有效决策/)
  })
  it("textMode=keep 产生翻译拒绝", () => {
    expect(() =>
      validateCompositionOutput(
        readyOutput({
          textReplacements: [
            { textId: "t1", sourceText: "FREE", targetText: "GRATIS", targetLocale: "de-DE" },
          ],
        }),
        composeCtx
      )
    ).toThrow(/不允许产生翻译/)
  })
  it("旧站点文案可随当前站点翻译，新语言校验仍生效", () => {
    const context = {
      ...composeCtx,
      settings: { ...settings, site: "amazon_de", textMode: "show" },
      selections: [
        {
          selectionId: "sel-1",
          kind: "copy",
          targetText: "Easy everyday shopping",
          targetLocale: "en-US",
        },
      ],
    } as never
    const output = readyOutput({
      editPromptEn: "Add the exact text: Einfach einkaufen.",
      copyAdditions: [
        { targetText: "Einfach einkaufen.", targetLocale: "de-DE", meaningCn: "轻松购物" },
      ],
    })
    expect(() => validateCompositionOutput(output, context)).not.toThrow()
    expect(() =>
      validateCompositionOutput(
        { ...output, copyAdditions: [{ ...output.copyAdditions[0], targetLocale: "en-US" }] },
        context
      )
    ).toThrow(/语言/)
    const sameLocale = {
      ...composeCtx,
      settings: { ...settings, site: "amazon_de", textMode: "show" },
      selections: [
        { selectionId: "sel-1", kind: "copy", targetText: "Gute Fahrt", targetLocale: "de-DE" },
      ],
    } as never
    expect(() => validateCompositionOutput(output, sameLocale)).toThrow(/原样保留/)
  })
  it("NEEDS_RESOLUTION 无冲突拒绝", () => {
    expect(() =>
      validateCompositionOutput(
        readyOutput({ status: "needs_resolution", conflicts: [], editPromptEn: "" }),
        composeCtx
      )
    ).toThrow(/至少一个问题/)
  })
})

describe("validateSettings", () => {
  it("translate 要求非 original 站点", () => {
    expect(() => validateSettings({ ...settings, textMode: "translate" } as never, null)).toThrow(
      /非 original/
    )
  })
  it("personMode=keep 可填写服饰表情说明", () => {
    expect(() =>
      validateSettings({ ...settings, personText: "穿蓝色外套并微笑" }, null)
    ).not.toThrow()
  })
  it("未知站点拒绝", () => {
    expect(() => validateSettings({ ...settings, site: "amazon_mx" } as never, null)).toThrow(
      /未知站点/
    )
  })
})

describe("拆解货篮三态与对象结构", () => {
  it("未知篮子不能被当作空篮，保留宠物道具位置", () => {
    const payload = {
      ...validBreakdown(),
      basketContents: { hasItems: null, evidence: "被遮挡", items: [] },
      baskets: [{ id: "front", position: "车头", hasItems: null, evidence: "被遮挡", items: [] }],
      pets: [{ id: "cat", position: "右侧", description: "一只猫" }],
      props: [],
    }
    expect(validateBreakdownOutput(payload).basketContents.hasItems).toBeNull()
    expect(deriveRequiredDimensions(payload, settings)).toEqual([])
  })
  it("多个有物品的货篮分别产生必需维度，汇总空篮与实际物品矛盾时拒绝", () => {
    const payload = {
      ...validBreakdown(),
      basketContents: { hasItems: true, evidence: "可见", items: ["袋子", "盒子"] },
      baskets: [
        { id: "front", position: "车头", hasItems: true, evidence: "可见", items: ["袋子"] },
        { id: "rear", position: "车尾", hasItems: true, evidence: "可见", items: ["盒子"] },
      ],
    }
    expect(deriveRequiredDimensions(validateBreakdownOutput(payload), settings)).toEqual([
      { purpose: "basket_contents", basketId: "front" },
      { purpose: "basket_contents", basketId: "rear" },
    ])
    expect(() =>
      validateBreakdownOutput({
        ...payload,
        basketContents: { hasItems: false, evidence: "", items: [] },
      })
    ).toThrow("汇总")
  })
})
