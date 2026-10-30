import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common"
import { map } from "rxjs"
import { moderationSnapshot } from "./task-moderation.service"

export function publicModeration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicModeration)
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return value
  const source = value as Record<string, unknown>
  const moderation = source.moderation
  const hasInternalModeration =
    Object.prototype.hasOwnProperty.call(source, "moderation") &&
    Object.prototype.hasOwnProperty.call(source, "moderationStatus")
  const rest = !hasInternalModeration
    ? source
    : Object.fromEntries(
        Object.entries(source).filter(
          ([key]) => !["moderation", "moderationClaimUntil", "moderationNextCheckAt"].includes(key)
        )
      )
  const result = Object.fromEntries(
    Object.entries(rest).map(([key, item]) => [key, publicModeration(item)])
  )
  if (hasInternalModeration) {
    result.contentModeration = moderationSnapshot({
      moderationStatus: rest.moderationStatus as string | null,
      moderation,
    })
  }
  return result
}

@Injectable()
export class ModerationResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() === "http") {
      const http = context.switchToHttp()
      const request = http.getRequest<{ path: string }>()
      if (
        /^\/(?:api\/)?(?:content-moderation(?:\/|$)|(?:video-project|beauty-project)\/task\/|internal\/generation\/video-tasks\/|customer\/storyboards(?:\/|$))/.test(
          request.path
        )
      ) {
        http
          .getResponse<{ setHeader(name: string, value: string): void }>()
          .setHeader("Cache-Control", "no-store")
      }
    }
    return next.handle().pipe(map(publicModeration))
  }
}
