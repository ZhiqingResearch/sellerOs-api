import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  UseGuards,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common"
import { APP_PIPE } from "@nestjs/core"
import { Test } from "@nestjs/testing"
import type { NextFunction, Request, Response } from "express"
import request from "supertest"
import { ContentModerationPipe } from "../content-moderation/content-moderation.pipe"
import { ContentModerationService } from "../content-moderation/content-moderation.service"
import { PrismaService } from "../prisma/prisma.service"
import { AigcAuditMiddleware, AigcModule } from "./aigc.module"
import { auditText, recordReview } from "./text-audit"

class Auth {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request & { user: { id: number } }>()
    req.user = { id: Number(req.headers["x-test-user"]) }
    return true
  }
}
const generate = jest.fn(() => Promise.resolve("模型回答"))
@Controller("llm-toolbox")
@UseGuards(Auth)
class TextController {
  @Post("enhance-prompt")
  run(@Body() body: { prompt: string }) {
    return auditText("model-private-id", body.prompt, generate)
  }

  @Post("save-profile")
  save(@Body() _body: unknown) {
    return { ok: true }
  }
}

describe("HTTP真实请求中的文生文日志上下文", () => {
  let app: INestApplication
  const entries: Record<string, unknown>[] = []
  let spy: jest.SpyInstance
  beforeAll(async () => {
    spy = jest.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        (message as { event?: string }).event === "aigc.text"
      )
        entries.push(message as Record<string, unknown>)
    })
    const module = await Test.createTestingModule({
      imports: [AigcModule],
      controllers: [TextController],
      providers: [
        { provide: APP_PIPE, useClass: ContentModerationPipe },
        {
          provide: ContentModerationService,
          useValue: {
            assertContent: (value: { prompt?: string }) => {
              if (value.prompt === "拒绝的内容")
                throw new BadRequestException({ code: "MODERATION_REJECTED", message: "审核拒绝" })
              recordReview("PASSED")
              return Promise.resolve(value)
            },
          },
        },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({
        aiGatewayModel: { findFirst: jest.fn().mockResolvedValue({ displayName: "实际展示名" }) },
      })
      .compile()
    app = module.createNestApplication({ logger: false })
    const middleware = module.get(AigcAuditMiddleware)
    app.use((req: Request, res: Response, next: NextFunction) => middleware.use(req, res, next))
    await app.init()
    await app.listen(0, "127.0.0.1")
  })
  beforeEach(() => {
    entries.length = 0
    generate.mockClear()
  })
  afterAll(async () => {
    await app.close()
    spy.mockRestore()
  })

  it("并发请求打印正确UID和展示名，问题保留、技术凭证排除", async () => {
    await Promise.all(
      [7, 8].map(user =>
        request(app.getHttpServer())
          .post("/llm-toolbox/enhance-prompt")
          .set("x-test-user", String(user))
          .send({ prompt: `问题${user}`, password: "secret-token" })
          .expect(201)
      )
    )
    expect(entries.filter(entry => entry.generationStatus === "SUCCEEDED")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: 7,
          question: ["问题7"],
          displayName: "实际展示名",
          moderationStatus: "PASSED",
        }),
        expect.objectContaining({
          userId: 8,
          question: ["问题8"],
          displayName: "实际展示名",
          moderationStatus: "PASSED",
        }),
      ])
    )
    expect(JSON.stringify(entries)).not.toMatch(/secret-token|model-private-id/)
  })

  it("普通资料接口的审核拒绝不打印为文生文日志", async () => {
    await request(app.getHttpServer())
      .post("/llm-toolbox/save-profile")
      .set("x-test-user", "9")
      .send({ prompt: "拒绝的内容" })
      .expect(400)
    expect(entries).toHaveLength(0)
  })

  it("参数审核拒绝时打印UID和未生成记录，模型不调用", async () => {
    await request(app.getHttpServer())
      .post("/llm-toolbox/enhance-prompt")
      .set("x-test-user", "9")
      .send({ prompt: "拒绝的内容" })
      .expect(400)
    expect(generate).not.toHaveBeenCalled()
    expect(entries).toEqual([
      expect.objectContaining({
        userId: 9,
        question: ["拒绝的内容"],
        moderationStatus: "REJECTED",
        generationStatus: "NOT_STARTED",
      }),
    ])
  })
})
