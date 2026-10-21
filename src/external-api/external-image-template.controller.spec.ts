import { INestApplication, RequestMethod } from "@nestjs/common"
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { ExternalApiKeyGuard } from "./external-api-key.guard"
import { ExternalImageTemplateController } from "./external-image-template.controller"
import { ExternalImageTemplateService } from "./external-image-template.service"
import { ExternalUserPhonePipe } from "./external-user-phone.decorator"

type ControllerMethod = keyof ExternalImageTemplateController

function route(method: ControllerMethod) {
  const handler = ExternalImageTemplateController.prototype[method]
  return {
    method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
    path: Reflect.getMetadata(PATH_METADATA, handler) as string,
  }
}

describe("ExternalImageTemplateController routes", () => {
  it.each([
    ["findByPhone", RequestMethod.POST, "query"],
    ["tabCounts", RequestMethod.POST, "tab-counts/query"],
    ["findGroups", RequestMethod.POST, "groups/query"],
    ["listGroups", RequestMethod.POST, "groups/manage/query"],
    ["createGroup", RequestMethod.POST, "groups"],
    ["renameGroup", RequestMethod.PATCH, "groups/:id"],
    ["deleteGroup", RequestMethod.DELETE, "groups/:id"],
    ["findTags", RequestMethod.POST, "tags/query"],
    ["importTemplates", RequestMethod.POST, "import"],
    ["create", RequestMethod.POST, "/"],
    ["findOne", RequestMethod.POST, ":id/query"],
    ["addItem", RequestMethod.POST, ":id/items"],
    ["copy", RequestMethod.POST, ":id/copy"],
    ["update", RequestMethod.PATCH, ":id"],
    ["remove", RequestMethod.DELETE, ":id"],
  ] as const)("registers %s", (handler, expectedMethod, expectedPath) => {
    expect(route(handler)).toEqual({ method: expectedMethod, path: expectedPath })
  })

  it("将请求头手机号与请求体业务参数分开传给服务层", async () => {
    const service = { create: jest.fn().mockResolvedValue({ id: 1 }) }
    const controller = new ExternalImageTemplateController(service as never)
    const dto = { name: "A+ 模板", items: [] }

    await controller.create("13800001234", dto)

    expect(service.create).toHaveBeenCalledWith("13800001234", dto)
  })
})

describe("ExternalImageTemplateController phone header", () => {
  let app: INestApplication
  const service = { findByPhone: jest.fn() }

  beforeEach(async () => {
    service.findByPhone.mockResolvedValue({ total: 0, page: 1, pageSize: 10, items: [] })
    const module = await Test.createTestingModule({
      controllers: [ExternalImageTemplateController],
      providers: [
        ExternalUserPhonePipe,
        { provide: ExternalImageTemplateService, useValue: service },
      ],
    })
      .overrideGuard(ExternalApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = module.createNestApplication()
    await app.init()
  })

  afterEach(async () => {
    await app.close()
    jest.clearAllMocks()
  })

  it("从 X-User-Phone 读取手机号并与请求体筛选参数分开传递", async () => {
    await request(app.getHttpServer())
      .post("/external/image-templates/query")
      .set("X-User-Phone", "13800001234")
      .send({ page: 2, pageSize: 20 })
      .expect(200)

    expect(service.findByPhone).toHaveBeenCalledWith("13800001234", {
      page: 2,
      pageSize: 20,
    })
  })

  it("缺少 X-User-Phone 时返回 400", async () => {
    await request(app.getHttpServer()).post("/external/image-templates/query").send({}).expect(400)
    expect(service.findByPhone).not.toHaveBeenCalled()
  })

  it("不再从请求体读取 phone", async () => {
    await request(app.getHttpServer())
      .post("/external/image-templates/query")
      .send({ phone: "13800001234" })
      .expect(400)
    expect(service.findByPhone).not.toHaveBeenCalled()
  })
})
