import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { ExternalApiKeyGuard } from "./external-api-key.guard"

describe("ExternalApiKeyGuard", () => {
  const apiKey = "external-image-template-key"

  function setup(configuredKey: string | undefined, suppliedKey?: string) {
    const config = {
      get: jest.fn().mockReturnValue(configuredKey ?? ""),
    } as unknown as ConfigService
    const request = { get: jest.fn().mockReturnValue(suppliedKey) }
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext
    return { guard: new ExternalApiKeyGuard(config), context }
  }

  it("密钥完全一致时允许访问", () => {
    const { guard, context } = setup(apiKey, apiKey)
    expect(guard.canActivate(context)).toBe(true)
  })

  it.each([undefined, "wrong-key", "external-image-template-kez"])(
    "密钥缺失或不正确时返回 401：%s",
    suppliedKey => {
      const { guard, context } = setup(apiKey, suppliedKey)
      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException)
      expect(() => guard.canActivate(context)).toThrow("X-API-Key 不正确")
    }
  )

  it("服务端未配置密钥时返回 503", () => {
    const { guard, context } = setup(undefined, apiKey)
    expect(() => guard.canActivate(context)).toThrow(ServiceUnavailableException)
    expect(() => guard.canActivate(context)).toThrow("外部模板接口密钥未配置")
  })
})
