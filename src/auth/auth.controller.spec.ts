import { INestApplication, ValidationPipe } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { AuthController } from "./auth.controller"
import { AuthService } from "./auth.service"

describe("短信登录 HTTP 接口", () => {
  let app: INestApplication
  const auth = {
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
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })
  beforeEach(() => {
    jest.clearAllMocks()
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
