import {
  gatewayImageDimensions,
  imageMetadata,
  modelDisplayNames,
  videoMetadata,
} from "./generation-metadata"

describe("预览墙元信息", () => {
  it("重绘展示实际选中档位，自定义像素回退不冒用原表单旧档位", () => {
    expect(imageMetadata({ executionSpec: {
      form: { resolutionTier: "4K" }, localRedraw: { resolutionTier: "2K" },
    } }).resolutionTier).toBe("2K")
    expect(imageMetadata({ executionSpec: {
      form: { resolutionTier: "4K" }, localRedraw: { generationWidth: 1536, generationHeight: 1024 },
    } }).resolutionTier).toBeNull()
  })
  it("交付尺寸优先于上游尺寸；本地后处理尺寸优先于网关成品尺寸", () => {
    const gateway = {
      metadata: {
        width: 3504,
        height: 2336,
        delivery: { final_size: "2048x1365", source_size: "3504x2336" },
      },
    }
    expect(gatewayImageDimensions(gateway)).toEqual({
      width: 2048,
      height: 1365,
      nativeWidth: 3504,
      nativeHeight: 2336,
    })
    expect(
      gatewayImageDimensions({ ...gateway, normalized: { from: "2048x1365", to: "1024x683" } })
    ).toEqual({ width: 1024, height: 683, nativeWidth: 3504, nativeHeight: 2336 })
  })
  it.each(["0x100", "-1x100", "NaNx100", "9007199254740992x100", "2048x", null])(
    "拒绝非法尺寸 %s，不按当前表单补造",
    size => {
      expect(
        gatewayImageDimensions({ metadata: { delivery: { final_size: size, source_size: size } } })
      ).toEqual({
        width: undefined,
        height: undefined,
        nativeWidth: undefined,
        nativeHeight: undefined,
      })
    }
  )
  it("批量按 publicId 查询，包括停用模型；空名称或缺行不替换原名称", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { publicId: "a", displayName: "已停用模型" },
      { publicId: "b", displayName: "  " },
    ])
    const names = await modelDisplayNames({ aiGatewayModel: { findMany } } as never, [
      "a",
      "a",
      "b",
      "missing",
      null,
    ])
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publicId: { in: ["a", "b", "missing"] } } })
    )
    expect(names.get("a")).toBe("已停用模型")
    expect(names.get("b") ?? "旧名称").toBe("旧名称")
    expect(names.get("missing") ?? "原 ID").toBe("原 ID")
  })
  it("实际与请求值独立，自动时长和未记录数据不补默认值", () => {
    expect(
      videoMetadata(
        { duration_seconds: -1, resolution: "1080p" },
        { actualDurationSec: 8, actualResolution: "720p" }
      )
    ).toEqual({
      requestedDurationSec: null,
      requestedResolution: "1080p",
      actualDurationSec: 8,
      actualResolution: "720p",
    })
    expect(videoMetadata(null, null)).toEqual({
      requestedDurationSec: null,
      requestedResolution: null,
      actualDurationSec: null,
      actualResolution: null,
    })
    expect(imageMetadata({ model: "原名称" }).resolutionTier).toBeNull()
  })
})
