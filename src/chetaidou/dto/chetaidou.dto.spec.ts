import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import {
  ChetaidouResultIdsDto,
  ComposeAnswersDto,
  CreateTaskDto,
  ImageListQueryDto,
  SelectionRefDto,
  UpdateDraftDto,
} from "./chetaidou.dto"

describe("车泰斗 DTO 不添加 PRD 之外的数量上限", () => {
  it("全局 whitelist 保留模型和两个自定义范围，超过旧限额的选项可保存", async () => {
    const dto = plainToInstance(UpdateDraftDto, {
      workspaceId: "430bf253-e97c-49fb-8bdc-f2e80931c690",
      revision: 1,
      settings: {
        site: "original",
        textMode: "keep",
        personMode: "keep",
        model: "ZQ-Think-Ultra",
        dimensionCountRange: { min: 24, max: 24 },
        optionCountRange: { min: 60, max: 80 },
      },
      selections: [],
      customDimensions: [
        {
          label: "场景",
          selectionMode: "multi",
          options: Array.from({ length: 350 }, (_, i) => ({ text: `选项${i}` })),
        },
      ],
    })
    expect(await validate(dto, { whitelist: true })).toEqual([])
    expect(dto.settings.model).toBe("ZQ-Think-Ultra")
    expect(dto.settings.dimensionCountRange).toEqual({ min: 24, max: 24 })
    expect(dto.settings.optionCountRange).toEqual({ min: 60, max: 80 })
  })
  it("组内可提交超过 60 个选项 ID", async () => {
    const dto = plainToInstance(SelectionRefDto, {
      groupId: "430bf253-e97c-49fb-8bdc-f2e80931c690",
      optionKeys: Array.from({ length: 75 }, (_, i) => `option-${i}`),
    })
    expect(await validate(dto)).toEqual([])
  })

  it("冲突问答可一次提交超过 30 个答案", async () => {
    const dto = plainToInstance(ComposeAnswersDto, {
      idempotencyKey: "430bf253-e97c-49fb-8bdc-f2e80931c690",
      workspaceId: "430bf253-e97c-49fb-8bdc-f2e80931c690",
      draftRevision: 1,
      answers: Array.from({ length: 40 }, (_, i) => ({
        conflictId: `conflict-${i}`,
        questionVersion: 1,
        choiceId: "choice-1",
      })),
    })
    expect(await validate(dto)).toEqual([])
  })

  it("分页大小可以超过 100，仍要求正整数", async () => {
    expect(await validate(plainToInstance(ImageListQueryDto, { pageSize: 150 }))).toEqual([])
    expect(await validate(plainToInstance(ImageListQueryDto, { pageSize: 0 }))).not.toEqual([])
  })
})

describe("车泰斗生图质量 DTO", () => {
  const request = {
    workspaceId: "430bf253-e97c-49fb-8bdc-f2e80931c690",
    draftRevision: 1,
    type: "GENERATE",
    imageId: 19,
    compositionTaskId: "430bf253-e97c-49fb-8bdc-f2e80931c690",
    idempotencyKey: "b2c3d4e5-1111-4222-8333-444455556666",
    count: 1,
    aspectRatio: "1:1",
  }
  it.each(["standard", "hd"])("whitelist 保留并归一质量 %s", async quality => {
    const dto = plainToInstance(CreateTaskDto, {
      ...request,
      quality: ` ${quality.toUpperCase()} `,
    })
    expect(await validate(dto, { whitelist: true })).toEqual([])
    expect(dto.quality).toBe(quality)
  })
  it.each(["", "auto", "high", 1, {}])("拒绝非法质量 %j", async quality => {
    expect(await validate(plainToInstance(CreateTaskDto, { ...request, quality }))).not.toEqual([])
  })
  it("旧客户端可省略质量", async () => {
    expect(await validate(plainToInstance(CreateTaskDto, request), { whitelist: true })).toEqual([])
  })
})

describe("车泰斗批量结果 ID 校验", () => {
  it.each([undefined, [], [1, 1], [0], [-1], [1.5], ["1"], [Number.MAX_SAFE_INTEGER + 1]])(
    "拒绝非法 resultIds %j",
    async resultIds => {
      expect(await validate(plainToInstance(ChetaidouResultIdsDto, { resultIds }))).not.toEqual([])
    }
  )

  it("接收跨生成批次的 ID，不额外设置数量上限", async () => {
    const resultIds = Array.from({ length: 150 }, (_, i) => i + 1)
    expect(await validate(plainToInstance(ChetaidouResultIdsDto, { resultIds }))).toEqual([])
  })
})
