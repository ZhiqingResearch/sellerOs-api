import type { Response } from "express"
import type { BusinessAiDto } from "./business-ai.dto"
import type { BusinessAiService, BusinessAiSource } from "./business-ai.service"

export async function streamBusinessAi(
  response: Response,
  service: BusinessAiService,
  userId: number,
  source: BusinessAiSource,
  dto: BusinessAiDto
): Promise<void> {
  response.status(200)
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8")
  response.setHeader("Cache-Control", "no-cache, no-transform")
  response.setHeader("X-Accel-Buffering", "no")
  response.flushHeaders()
  const write = (event: object) => {
    if (!response.destroyed && !response.writableEnded)
      response.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  const heartbeatTimer = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write(": heartbeat\n\n")
  }, 15_000)
  heartbeatTimer.unref()
  try {
    // 客户端离开后仍完成已经发生的网关调用结算，防止断开连接绕过扣费。
    for await (const event of service.stream(userId, source, dto)) write(event)
    write({ type: "billing_handled", content: "" })
    if (!response.destroyed && !response.writableEnded) response.write("data: [DONE]\n\n")
  } catch (error: unknown) {
    write({
      type: "error",
      content: error instanceof Error ? error.message : "AI 分析失败，请重试",
    })
  } finally {
    clearInterval(heartbeatTimer)
    response.end()
  }
}
