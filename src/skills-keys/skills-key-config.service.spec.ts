import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { SkillsKeyConfigService } from "./skills-key-config.service"

// 所有凭证均为无效测试占位值，不连接 API 或读取实际环境变量。
const validConfig = () => ({
  SKILLS_KEYS_API_ORIGIN: "https://skills.example.invalid/",
  SKILLS_KEYS_PROJECT_ID: "selleros-project-test",
  SKILLS_KEYS_PROJECT_KEY_A: "test-only-project-credential",
  SKILLS_KEYS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
})

describe("SkillsKeyConfigService", () => {
  it("全部未配置时禁用，其他功能可继续启动", () => {
    const service = new SkillsKeyConfigService(new ConfigService({}))
    expect(service.enabled).toBe(false)
    expect(() => service.getProject()).toThrow(ServiceUnavailableException)
    expect(() => service.getEncryptionKey()).toThrow(ServiceUnavailableException)
  })

  it("只能使用登记的默认项目，配置和密钥不会被调用者修改", () => {
    const service = new SkillsKeyConfigService(new ConfigService(validConfig()))
    expect(service.enabled).toBe(true)
    const project = service.getProject()
    expect(project).toEqual({
      code: "selleros",
      projectId: "selleros-project-test",
      apiOrigin: "https://skills.example.invalid",
      keyA: "test-only-project-credential",
    })
    expect(Object.isFrozen(project)).toBe(true)
    expect(() => service.getProject("another-project")).toThrow(ForbiddenException)
    const copiedKey = service.getEncryptionKey()
    copiedKey.fill(0)
    expect(service.getEncryptionKey()).toEqual(Buffer.alloc(32, 7))
  })

  it.each(Object.keys(validConfig()))("部分配置缺少 %s 时启动失败且不泄露值", missing => {
    const configuration: Record<string, string> = validConfig()
    delete configuration[missing]
    expect(() => new SkillsKeyConfigService(new ConfigService(configuration))).toThrow(
      `接入密钥配置无效：${missing}`
    )
  })

  it.each([
    "http://skills.example.invalid",
    "https://secret:password@skills.example.invalid",
    "https://skills.example.invalid/api",
    "https://skills.example.invalid?token=test-only-secret",
    "https://skills.example.invalid#test-only-secret",
    "https://skills.example.invalid\\api",
    "invalid-test-only-secret",
  ])("拒绝非 HTTPS origin 地址，不在异常里暴露地址：%s", origin => {
    expect(
      () =>
        new SkillsKeyConfigService(
          new ConfigService({ ...validConfig(), SKILLS_KEYS_API_ORIGIN: origin })
        )
    ).toThrow("接入密钥配置无效：SKILLS_KEYS_API_ORIGIN")
  })

  it.each([
    ["SKILLS_KEYS_PROJECT_ID", "invalid project"],
    ["SKILLS_KEYS_PROJECT_KEY_A", "credential\nheader-injection"],
    ["SKILLS_KEYS_ENCRYPTION_KEY", Buffer.alloc(31).toString("base64")],
    ["SKILLS_KEYS_ENCRYPTION_KEY", Buffer.alloc(32).toString("hex")],
    ["SKILLS_KEYS_ENCRYPTION_KEY", `${Buffer.alloc(32).toString("base64")}!`],
    ["SKILLS_KEYS_ENCRYPTION_KEY", 123],
  ])("拒绝无效配置 %s", (name, value) => {
    expect(
      () => new SkillsKeyConfigService(new ConfigService({ ...validConfig(), [name]: value }))
    ).toThrow(`接入密钥配置无效：${name}`)
  })

  it("仅需四项配置，遗留环境白名单不再解析或授予项目权限", () => {
    const service = new SkillsKeyConfigService(
      new ConfigService({ ...validConfig(), SKILLS_KEYS_ALLOWED_APP_IDS: "invalid,,legacy" })
    )
    expect(service.enabled).toBe(true)
    expect(service.getProject()).not.toHaveProperty("allowedAppIds")
    const disabled = new SkillsKeyConfigService(
      new ConfigService({ SKILLS_KEYS_ALLOWED_APP_IDS: "old-service" })
    )
    expect(disabled.enabled).toBe(false)
  })
})
