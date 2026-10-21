/**
 * ASIN 审计十板块契约（v2.0 · 2026-09-08，依据《十板块项目分值与扣分规则.xlsx》V1.1）。
 * 十板块 A–J · 24 计分项目 · 满分 100：内容质量 A–F 共 64 分，运营健康 G–J 共 36 分。
 * 广告域不进这 100 分（并列独立诊断）。服务端按本契约校验模型输出并重算聚合分。
 */

export interface BoardItemSpec {
  id: string
  name: string
  maxScore: number
}

export interface BoardSpec {
  id: string
  name: string
  weight: number
  maxScore: number
  items: BoardItemSpec[]
}

export const AUDIT_BOARD_CONTRACT: readonly BoardSpec[] = [
  {
    id: "A",
    name: "搜索意图与语义匹配",
    weight: 12,
    maxScore: 12,
    items: [
      { id: "A1", name: "标题身份与关键规格", maxScore: 5 },
      { id: "A2", name: "核心意图自然表达", maxScore: 4 },
      { id: "A3", name: "合格配置/场景词内容覆盖", maxScore: 3 },
    ],
  },
  {
    id: "B",
    name: "场景与受众清晰度",
    weight: 6,
    maxScore: 6,
    items: [
      { id: "B1", name: "任务与人群清晰度", maxScore: 2 },
      { id: "B2", name: "产品身份与能力清晰度", maxScore: 2 },
      { id: "B3", name: "用途相容性", maxScore: 2 },
    ],
  },
  {
    id: "C",
    name: "关键问题可回答性",
    weight: 6,
    maxScore: 6,
    items: [
      { id: "C1", name: "购买问题的答案可定位", maxScore: 3 },
      { id: "C2", name: "使用条件与边界", maxScore: 2 },
      { id: "C3", name: "文字与排版可读性", maxScore: 1 },
    ],
  },
  {
    id: "D",
    name: "差异化与价值表达",
    weight: 8,
    maxScore: 8,
    items: [
      { id: "D1", name: "对标后的购买价值", maxScore: 4 },
      { id: "D2", name: "量化与比较卖点依据", maxScore: 2 },
      { id: "D3", name: "可比竞品VOC回应", maxScore: 2 },
    ],
  },
  {
    id: "E",
    name: "内容资产有效性",
    weight: 12,
    maxScore: 12,
    items: [
      { id: "E1", name: "图片信息与可读性", maxScore: 6 },
      { id: "E2", name: "公开A+内容有效性", maxScore: 4 },
      { id: "E3", name: "视频演示价值", maxScore: 2 },
    ],
  },
  {
    id: "F",
    name: "产品事实与属性一致性",
    weight: 20,
    maxScore: 20,
    items: [
      { id: "F1", name: "六组核心事实一致性", maxScore: 12 },
      { id: "F2", name: "后台Search Terms有效性", maxScore: 3 },
      { id: "F3", name: "五组辅助属性", maxScore: 5 },
    ],
  },
  {
    id: "G",
    name: "自然可见度与流量承接",
    weight: 14,
    maxScore: 14,
    items: [
      { id: "G1", name: "当日核心词首页观测率", maxScore: 8 },
      { id: "G3", name: "合格机会词曝光承接", maxScore: 6 },
    ],
  },
  {
    id: "H",
    name: "口碑与购买风险",
    weight: 8,
    maxScore: 8,
    items: [
      { id: "H2a", name: "评分可信度", maxScore: 4 },
      { id: "H2b", name: "近期购买风险", maxScore: 4 },
    ],
  },
  {
    id: "I",
    name: "排名趋势与稳定性",
    weight: 8,
    maxScore: 8,
    items: [{ id: "I3", name: "排名趋势与稳定性", maxScore: 8 }],
  },
  {
    id: "J",
    name: "流量来源韧性",
    weight: 6,
    maxScore: 6,
    items: [{ id: "J2", name: "流量来源韧性", maxScore: 6 }],
  },
] as const

/** 内容质量域 A–F（64 分） */
export const CONTENT_BOARD_IDS = ["A", "B", "C", "D", "E", "F"] as const

/** 运营健康域 G–J（36 分） */
export const OPERATIONS_BOARD_IDS = ["G", "H", "I", "J"] as const

/** 证据覆盖率低于该值不出总分（v2.0 §五） */
export const MIN_COVERAGE_FOR_TOTAL = 0.6

export function boardSpec(id: string): BoardSpec | undefined {
  return AUDIT_BOARD_CONTRACT.find(b => b.id === id)
}
