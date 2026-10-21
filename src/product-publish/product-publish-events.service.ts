import { Injectable, type MessageEvent, OnModuleDestroy } from "@nestjs/common"
import { ProductPublishOutcome, ProductPublishTaskStatus } from "@prisma/client"
import { concat, filter, interval, map, merge, Observable, of, ReplaySubject } from "rxjs"

const EVENT_REPLAY_LIMIT = 1_000
const EVENT_REPLAY_WINDOW_MS = 5 * 60 * 1_000
const HEARTBEAT_INTERVAL_MS = 20_000

export const PRODUCT_PUBLISH_REFRESH_EVENT = "product-publish-refresh-completed"

export type AmazonFeedStatus = "ACCEPTED" | "PROCESSING" | "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED"

export interface ProductPublishRefreshCompletedEvent {
  taskId: string
  requestId: string
  callbackOk: boolean
  amazonStatus: AmazonFeedStatus | null
  taskStatus: ProductPublishTaskStatus
  publishOutcome: ProductPublishOutcome | null
  receivedAt: string
}

interface UserEvent {
  userId: number
  event: MessageEvent
}

/**
 * 一键上架页面的单向实时事件通道。
 *
 * 事件只在当前 Node 进程内广播；保留最近 5 分钟事件用于覆盖“RPA 回调早于刷新
 * POST 响应”以及浏览器短暂重连的竞态。订阅时按 JWT 用户 ID 过滤，用户之间不会
 * 收到彼此任务事件。
 */
@Injectable()
export class ProductPublishEventsService implements OnModuleDestroy {
  private readonly events = new ReplaySubject<UserEvent>(EVENT_REPLAY_LIMIT, EVENT_REPLAY_WINDOW_MS)

  streamForUser(userId: number): Observable<MessageEvent> {
    const connected = of<MessageEvent>({
      type: "connected",
      retry: 3_000,
      data: { connectedAt: new Date().toISOString() },
    })
    const userEvents = this.events.pipe(
      filter(item => item.userId === userId),
      map(item => item.event)
    )
    const heartbeat = interval(HEARTBEAT_INTERVAL_MS).pipe(
      map(
        (): MessageEvent => ({
          type: "heartbeat",
          data: { timestamp: new Date().toISOString() },
        })
      )
    )

    return concat(connected, merge(userEvents, heartbeat))
  }

  publishRefreshCompleted(userId: number, data: ProductPublishRefreshCompletedEvent): void {
    this.events.next({
      userId,
      event: {
        id: data.requestId,
        type: PRODUCT_PUBLISH_REFRESH_EVENT,
        data,
      },
    })
  }

  onModuleDestroy(): void {
    this.events.complete()
  }
}
