import { validate } from "class-validator"
import { RemoveBeautyTasksDto } from "../../beauty-workflow/beauty-workflow.dto"
import { RemoveGeneratedImagesDto } from "../../image-project/image-project.dto"
import { RemoveRpaResultsDto } from "../../rpa-creation/rpa-creation.dto"
import { RemoveVideoTasksDto } from "../../video-project/video-project.dto"

describe("批量移除 DTO", () => {
  it.each([
    [RemoveGeneratedImagesDto, "imageIds"],
    [RemoveVideoTasksDto, "taskIds"],
    [RemoveRpaResultsDto, "outputIds"],
    [RemoveBeautyTasksDto, "taskIds"],
  ])("%p 接受 1-100 个不重复正整数 ID", async (Dto, field) => {
    const valid = Object.assign(new Dto(), { [field]: [1, 2] })
    expect(await validate(valid)).toHaveLength(0)

    for (const invalidIds of [
      [],
      [1, 1],
      [0],
      [1.5],
      Array.from({ length: 101 }, (_, i) => i + 1),
    ]) {
      const invalid = Object.assign(new Dto(), { [field]: invalidIds })
      expect(await validate(invalid)).not.toHaveLength(0)
    }
  })
})
