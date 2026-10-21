import { ProductPublishOutcome, ProductPublishTaskStatus } from "@prisma/client"
import { filter, firstValueFrom, timeout } from "rxjs"
import {
  PRODUCT_PUBLISH_REFRESH_EVENT,
  ProductPublishEventsService,
} from "./product-publish-events.service"

describe("ProductPublishEventsService", () => {
  let service: ProductPublishEventsService

  beforeEach(() => {
    service = new ProductPublishEventsService()
  })

  afterEach(() => {
    service.onModuleDestroy()
  })

  it("订阅后先发送 connected 事件", async () => {
    await expect(firstValueFrom(service.streamForUser(1))).resolves.toMatchObject({
      type: "connected",
      retry: 3000,
    })
  })

  it("只向任务所属用户发送刷新完成事件", async () => {
    const ownEvents = firstValueFrom(
      service.streamForUser(1).pipe(filter(event => event.type === PRODUCT_PUBLISH_REFRESH_EVENT))
    )
    const otherEvents = firstValueFrom(
      service.streamForUser(2).pipe(
        filter(event => event.type === PRODUCT_PUBLISH_REFRESH_EVENT),
        timeout({ first: 50 })
      )
    )

    service.publishRefreshCompleted(1, {
      taskId: "11111111-1111-4111-8111-111111111111",
      requestId: "query-request-1",
      callbackOk: true,
      amazonStatus: "SUCCESS",
      taskStatus: ProductPublishTaskStatus.COMPLETED,
      publishOutcome: ProductPublishOutcome.SUCCESS,
      receivedAt: "2026-08-04T08:00:00.000Z",
    })

    const ownEvent = await ownEvents
    expect(ownEvent.id).toBe("query-request-1")
    expect(ownEvent.type).toBe(PRODUCT_PUBLISH_REFRESH_EVENT)
    expect(ownEvent.data).toMatchObject({
      taskId: "11111111-1111-4111-8111-111111111111",
      requestId: "query-request-1",
    })

    await expect(otherEvents).rejects.toThrow("Timeout has occurred")
  })

  it("重连时可重放最近事件，覆盖快速回调竞态", async () => {
    service.publishRefreshCompleted(1, {
      taskId: "11111111-1111-4111-8111-111111111111",
      requestId: "query-request-2",
      callbackOk: true,
      amazonStatus: "PROCESSING",
      taskStatus: ProductPublishTaskStatus.PUBLISHING,
      publishOutcome: null,
      receivedAt: "2026-08-04T08:00:00.000Z",
    })

    const replayed = await firstValueFrom(
      service.streamForUser(1).pipe(filter(event => event.type === PRODUCT_PUBLISH_REFRESH_EVENT))
    )

    expect(replayed.id).toBe("query-request-2")
  })
})
