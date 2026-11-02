import { ConflictException, INestApplication, ValidationPipe } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { AllExceptionsFilter } from "../common/filters/http-exception.filter"
import { AuthController } from "./auth.controller"
import { AuthService } from "./auth.service"

describe("短信登录 HTTP 接口", () => {
  let app: INestApplication
  const auth = {
    register: jest.fn().mockResolvedValue({ access_token: "signup-token" }),
    sendCode: jest.fn().mockResolvedValue({ message: "验证码已发送" }),
    loginBySms: jest.fn().mockResolvedValue({ access_token: "test-token" }),
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: auth }],
    }).compile()
    app = module.createNestApplication()
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    app.useGlobalFilters(new AllExceptionsFilter({ warn: jest.fn(), error: jest.fn() } as never))
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })
  beforeEach(() => {
    jest.clearAllMocks()
  })

  const registration = {
    username: "tester01",
    phone: "15884033673",
    code: "123456",
    password: "Password1",
  }

  it("注册无需登录，去除用户名和邀请码首尾空格，直接返回 token", async () => {
    await request(app.getHttpServer())
      .post("/api/auth/register")
      .send({
        ...registration,
        username: " tester01 ",
        inviteCode: " OS1234 ",
        confirmPassword: "Password1",
      })
      .expect(201, { access_token: "signup-token" })
    expect(auth.register).toHaveBeenCalledWith({ ...registration, inviteCode: "OS1234" })
  })

  it.each([undefined, "", "   ", null])("邀请码 %s 允许不填", async inviteCode => {
    await request(app.getHttpServer())
      .post("/api/auth/register")
      .send({ ...registration, inviteCode })
      .expect(201)
  })

  it.each([
    { username: "   " },
    { username: "a".repeat(51) },
    { phone: "123" },
    { code: "abcdef" },
    { password: "Short1" },
    { password: "12345678" },
    { password: "abcdefgh" },
    { password: "a1".repeat(33) },
    { inviteCode: "bad" },
    { inviteCode: 123456 },
  ])("拒绝非法注册参数 %j", async invalid => {
    await request(app.getHttpServer())
      .post("/api/auth/register")
      .send({ ...registration, ...invalid })
      .expect(400)
    expect(auth.register).not.toHaveBeenCalled()
  })

  it("缺少必填字段不能注册", async () => {
    await request(app.getHttpServer()).post("/api/auth/register").send({}).expect(400)
    expect(auth.register).not.toHaveBeenCalled()
  })

  it("注册冲突使用实际全局错误格式，message位于响应顶层", async () => {
    auth.register.mockRejectedValueOnce(new ConflictException("该手机号已注册，请直接登录"))
    const response = await request(app.getHttpServer())
      .post("/api/auth/register")
      .send(registration)
      .expect(409)
    expect(response.body).toEqual({
      statusCode: 409,
      message: "该手机号已注册，请直接登录",
      timestamp: expect.any(String) as string,
    })
  })

  it("发送路由可访问并返回成功提示", async () => {
    await request(app.getHttpServer())
      .post("/api/auth/send-code")
      .send({ phone: "15884033673" })
      .expect(201, { message: "验证码已发送" })
    expect(auth.sendCode).toHaveBeenCalledWith("15884033673")
  })

  it("验证码登录路由可访问并返回 token", async () => {
    await request(app.getHttpServer())
      .post("/api/auth/login-sms")
      .send({ phone: "15884033673", code: "123456" })
      .expect(201, { access_token: "test-token" })
  })

  it("非法手机号不能调用发送服务", async () => {
    await request(app.getHttpServer())
      .post("/api/auth/send-code")
      .send({ phone: "invalid" })
      .expect(400)
    expect(auth.sendCode).not.toHaveBeenCalled()
  })

  it.each(["12345", "abcdef"])("拒绝非法验证码 %s", async code => {
    await request(app.getHttpServer())
      .post("/api/auth/login-sms")
      .send({ phone: "15884033673", code })
      .expect(400)
    expect(auth.loginBySms).not.toHaveBeenCalled()
  })
})
