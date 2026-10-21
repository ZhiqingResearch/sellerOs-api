import { splitInferenceReply } from "./llm-toolbox.reply-split"

describe("splitInferenceReply（P0 §4.3 三层派生）", () => {
  it("主路径：独立 --- 分隔线且两侧均非空 → 前段视觉复述 / 后段结构化", () => {
    const raw = "一只橘猫在米色沙发上，午后柔光\n\n---\n\n[主体]: 橘猫\n[细节]: 蓬松毛发"
    expect(splitInferenceReply(raw)).toEqual({
      visualDescription: "一只橘猫在米色沙发上，午后柔光",
      structuredPrompt: "[主体]: 橘猫\n[细节]: 蓬松毛发",
    })
  })

  it("主路径：≥3 个连字符都算分隔线（-----）", () => {
    const raw = "复述正文\n-----\n[主体]: x"
    expect(splitInferenceReply(raw)).toEqual({
      visualDescription: "复述正文",
      structuredPrompt: "[主体]: x",
    })
  })

  it("分隔线在开头（前侧为空）→ 主路径不成立，落 [主体] 兜底（残段 --- 计入前段，按 P0 字面行为）", () => {
    const raw = "---\n[主体]: x"
    expect(splitInferenceReply(raw)).toEqual({
      visualDescription: "---",
      structuredPrompt: "[主体]: x",
    })
  })

  it("兜底 1：无分隔线但有 [主体]: 行（半角冒号）→ 从该行起拆分", () => {
    const raw = "整体画面描述……\n[主体]: 橘猫\n[背景]: 客厅"
    expect(splitInferenceReply(raw)).toEqual({
      visualDescription: "整体画面描述……",
      structuredPrompt: "[主体]: 橘猫\n[背景]: 客厅",
    })
  })

  it("兜底 1：全角冒号同样识别", () => {
    const raw = "画面复述\n[主体]：橘猫"
    expect(splitInferenceReply(raw)).toEqual({
      visualDescription: "画面复述",
      structuredPrompt: "[主体]：橘猫",
    })
  })

  it("兜底 1：[主体] 在首行（位置 0）→ 落到整段兜底", () => {
    const raw = "[主体]: 橘猫\n[背景]: 客厅"
    expect(splitInferenceReply(raw)).toEqual({
      visualDescription: "",
      structuredPrompt: "[主体]: 橘猫\n[背景]: 客厅",
    })
  })

  it("兜底 2：两种标记都没有 → 整段视为结构化", () => {
    const raw = "只有一段没有任何标记的文本"
    expect(splitInferenceReply(raw)).toEqual({
      visualDescription: "",
      structuredPrompt: "只有一段没有任何标记的文本",
    })
  })

  it("空文本 → 三字段空串（由图推理无回显兜底）", () => {
    expect(splitInferenceReply("")).toEqual({ visualDescription: "", structuredPrompt: "" })
  })
})
