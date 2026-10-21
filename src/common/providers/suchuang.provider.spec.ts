import type { AtlasVideoParams } from "./atlas.provider"
import { SuchuangProvider } from "./suchuang.provider"

interface TestableSuchuangProvider {
  resolveGoogleOmniSize(params: AtlasVideoParams): string | undefined
}

describe("SuchuangProvider Google Omni 尺寸", () => {
  const provider = new SuchuangProvider({ get: jest.fn().mockReturnValue(undefined) } as never)
  const testable = provider as unknown as TestableSuchuangProvider

  it("把大写 X 的宽高尺寸规范为上游要求的小写 x", () => {
    expect(
      testable.resolveGoogleOmniSize({
        mode: "REFERENCE",
        tier: "google_omni",
        resolution: "1080X1920",
      })
    ).toBe("1080x1920")
  })
})
