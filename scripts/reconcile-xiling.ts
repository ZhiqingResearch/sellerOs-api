/**
 * 曦灵任务对账修复脚本。webhook 被挡成 401 后数据卡住时可用它手工拉一次百度状态回写。
 *
 * 用法：
 *   npx ts-node scripts/reconcile-xiling.ts avatar <figureId|all> [customerId]
 *   npx ts-node scripts/reconcile-xiling.ts voice  <perId|all>    [customerId]
 *   npx ts-node scripts/reconcile-xiling.ts video  <taskId>
 *
 * - 传 all 则从百度拉取当前 APP_ID 下所有形象/音色再逐条修复
 * - DB 里找不到对应 figureId/perId 时：
 *   · 若传了 customerId → 插入一条新记录，归给该客户
 *   · 否则 warn 跳过（避免误插）
 *
 * 读取 .env 中的 XILING_APP_ID / XILING_SECRET_KEY / DATABASE_URL。
 */
import { PrismaClient } from "@prisma/client"
import axios from "axios"
import crypto from "crypto"
import * as dotenv from "dotenv"

dotenv.config()

const BASE_URL = "https://open.xiling.baidu.com/api/digitalhuman/open/v1"
const APP_ID = process.env.XILING_APP_ID ?? ""
const SECRET = process.env.XILING_SECRET_KEY ?? ""
if (!APP_ID || !SECRET) {
  console.error("缺少 XILING_APP_ID / XILING_SECRET_KEY")
  process.exit(1)
}

const auth = () => {
  const expire = new Date(Date.now() + 3_600_000).toISOString()
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(APP_ID + expire)
    .digest("hex")
  return `${APP_ID}/${signature}/${expire}`
}

const prisma = new PrismaClient()

type AvatarInfo = {
  figureId: string
  status: string
  name?: string
  gender?: "MALE" | "FEMALE"
  templateImg?: string
  failedCode?: number | null
  failedMessage?: string | null
  [k: string]: unknown
}
type VoiceInfo = {
  perId: string
  status: string
  name?: string
  gender?: "male" | "female" | "unknown"
  describe?: string
  exampleText?: string
  exampleAudioUrl?: string
  reason?: string
  code?: number | null
  [k: string]: unknown
}
type VideoInfo = {
  taskId: string
  status: string
  failedCode?: number | null
  failedMessage?: string | null
  videoUrl?: string | null
  duration?: number | null
  [k: string]: unknown
}

const dump = (label: string, obj: unknown) =>
  console.log(`[${label}] 百度原始响应:\n${JSON.stringify(obj, null, 2)}`)

type PagedResp<T> = {
  code: number
  message: { global: string }
  result: { pageNo: number; pageSize: number; totalCount: number; result: T[] } | T[]
}

async function listAll<T>(path: string, extraParams: Record<string, unknown> = {}): Promise<T[]> {
  const pageSize = 50
  const out: T[] = []
  for (let pageNo = 1; ; pageNo++) {
    const { data } = await axios.get<PagedResp<T>>(`${BASE_URL}${path}`, {
      headers: { Authorization: auth() },
      params: { pageNo, pageSize, ...extraParams },
    })
    if (data.code !== 0) throw new Error(`${path} 返回错误: ${data.message.global}`)
    const page = Array.isArray(data.result) ? data.result : data.result.result
    out.push(...page)
    if (!page.length || page.length < pageSize) break
  }
  return out
}

async function queryAvatar(figureId: string): Promise<AvatarInfo> {
  const { data } = await axios.get<{
    code: number
    message: { global: string }
    result: { result: AvatarInfo[] }
  }>(`${BASE_URL}/figure/lite2d/query`, {
    headers: { Authorization: auth() },
    params: { figureId },
  })
  dump(`avatar ${figureId}`, data)
  if (data.code !== 0) throw new Error(data.message.global)
  const row = data.result.result[0]
  if (!row) throw new Error(`未找到 figureId=${figureId}`)
  return row
}

async function queryVoice(perId: string): Promise<VoiceInfo> {
  const { data } = await axios.get<{
    code: number
    message: { global: string }
    result: VoiceInfo[]
  }>(`${BASE_URL}/tts/clone`, {
    headers: { Authorization: auth() },
    params: { perId, isSuccess: false },
  })
  dump(`voice ${perId}`, data)
  if (data.code !== 0) throw new Error(data.message.global)
  const row = data.result[0]
  if (!row) throw new Error(`未找到 perId=${perId}`)
  return row
}

async function queryVideo(taskId: string): Promise<VideoInfo> {
  const { data } = await axios.get<{
    code: number
    message: { global: string }
    result: VideoInfo
  }>(`${BASE_URL}/video/task`, {
    headers: { Authorization: auth() },
    params: { taskId },
  })
  dump(`video ${taskId}`, data)
  if (data.code !== 0) throw new Error(data.message.global)
  return data.result
}

const normalize = (raw: string, failMap: Set<string>) =>
  raw === "SUCCESS" ? "SUCCESS" : failMap.has(raw) ? "FAILED" : "GENERATING"

async function applyAvatar(info: AvatarInfo, customerId?: number) {
  const { figureId } = info
  const status = normalize(info.status, new Set(["FAILED"]))
  console.log(
    `[avatar ${figureId}] raw=${info.status} failedCode=${info.failedCode ?? "-"} failedMessage=${info.failedMessage ?? "-"} → status=${status}`
  )
  // Avatar.figureId 从全局 unique 改为 (customerId, figureId) 复合 unique 后，
  // 对账脚本只处理克隆形象（kind=CLONED）。公共形象不需要对账。
  const row = await prisma.avatar.findFirst({ where: { figureId, kind: "CLONED" } })
  if (!row) {
    if (customerId === undefined) {
      console.warn(
        `  ⚠ DB 未找到 figureId=${figureId}（未提供 customerId，跳过；如需新增请传 customerId）`
      )
      return
    }
    const created = await prisma.avatar.create({
      data: {
        name: info.name ?? figureId,
        gender: info.gender ?? "FEMALE",
        figureId,
        status,
        kind: "CLONED",
        ...(status === "SUCCESS" && info.templateImg ? { thumbnailUrl: info.templateImg } : {}),
        customerId,
      },
    })
    console.log(
      `  + DB 已新增 id=${created.id} name=${created.name} status=${created.status} thumbnailUrl=${created.thumbnailUrl ?? "-"} customerId=${customerId}`
    )
    return
  }
  const updated = await prisma.avatar.update({
    where: { id: row.id },
    data: {
      status,
      ...(status === "SUCCESS" && info.templateImg ? { thumbnailUrl: info.templateImg } : {}),
    },
  })
  console.log(
    `  ✓ DB 已更新 id=${updated.id} status=${updated.status} thumbnailUrl=${updated.thumbnailUrl ?? "-"}`
  )
}

async function fixAvatar(figureId: string, customerId?: number) {
  const info = await queryAvatar(figureId)
  await applyAvatar(info, customerId)
}

async function fixAllAvatars(customerId?: number) {
  const list = await listAll<AvatarInfo>("/figure/lite2d/query")
  console.log(`[avatar all] 百度返回 ${list.length} 条形象`)
  for (const info of list) await applyAvatar(info, customerId)
}

async function applyVoice(info: VoiceInfo, customerId?: number) {
  const { perId } = info
  const status = normalize(info.status, new Set(["FAIL", "FAILED"]))
  console.log(`[voice ${perId}] raw=${info.status} reason=${info.reason ?? "-"} → status=${status}`)
  const row = await prisma.voice.findFirst({ where: { perId, kind: "CLONED" } })
  if (!row) {
    if (customerId === undefined) {
      console.warn(
        `  ⚠ DB 未找到 perId=${perId}（未提供 customerId，跳过；如需新增请传 customerId）`
      )
      return
    }
    const created = await prisma.voice.create({
      data: {
        name: info.name ?? perId,
        gender: info.gender ?? "female",
        perId,
        status,
        kind: "CLONED",
        ...(info.exampleText ? { exampleText: info.exampleText } : {}),
        ...(info.describe ? { description: info.describe } : {}),
        ...(status === "SUCCESS" && info.exampleAudioUrl
          ? { exampleAudioUrl: info.exampleAudioUrl }
          : {}),
        customerId,
      },
    })
    console.log(
      `  + DB 已新增 id=${created.id} name=${created.name} status=${created.status} exampleAudioUrl=${created.exampleAudioUrl ?? "-"} customerId=${customerId}`
    )
    return
  }
  const updated = await prisma.voice.update({
    where: { id: row.id },
    data: {
      status,
      ...(status === "SUCCESS" && info.exampleAudioUrl
        ? { exampleAudioUrl: info.exampleAudioUrl }
        : {}),
    },
  })
  console.log(
    `  ✓ DB 已更新 id=${updated.id} status=${updated.status} exampleAudioUrl=${updated.exampleAudioUrl ?? "-"}`
  )
}

async function fixVoice(perId: string, customerId?: number) {
  const info = await queryVoice(perId)
  await applyVoice(info, customerId)
}

async function fixAllVoices(customerId?: number) {
  const list = await listAll<VoiceInfo>("/tts/clone", { isSuccess: false })
  console.log(`[voice all] 百度返回 ${list.length} 条音色`)
  for (const info of list) await applyVoice(info, customerId)
}

async function fixVideo(taskId: string) {
  const info = await queryVideo(taskId)
  const status = normalize(info.status, new Set(["FAILED"]))
  console.log(
    `[video ${taskId}] 百度返回 raw=${info.status} failedMessage=${info.failedMessage ?? "-"} → status=${status}`
  )

  const updated = await prisma.script.update({
    where: { videoTaskId: taskId },
    data:
      status === "SUCCESS"
        ? {
            videoStatus: "SUCCESS",
            videoUrl: info.videoUrl ?? undefined,
            videoDuration: info.duration ?? undefined,
            videoErrorMessage: null,
          }
        : status === "FAILED"
          ? { videoStatus: "FAILED", videoErrorMessage: info.failedMessage ?? null }
          : { videoStatus: "GENERATING" },
  })
  console.log(
    `[video ${taskId}] DB 已更新 scriptId=${updated.id} videoStatus=${updated.videoStatus} videoUrl=${updated.videoUrl ?? "-"}`
  )
}

async function main() {
  const [kind, id, customerIdArg] = process.argv.slice(2)
  if (!kind || !id) {
    console.error(
      "用法: npx ts-node scripts/reconcile-xiling.ts <avatar|voice|video> <id|all> [customerId]"
    )
    process.exit(1)
  }
  let customerId: number | undefined
  if (customerIdArg !== undefined) {
    customerId = Number(customerIdArg)
    if (!Number.isInteger(customerId) || customerId <= 0) {
      console.error(`customerId 必须是正整数，收到: ${customerIdArg}`)
      process.exit(1)
    }
    const customer = await prisma.customer.findUnique({ where: { id: customerId } })
    if (!customer) {
      console.error(`customerId=${customerId} 在 DB 中不存在`)
      process.exit(1)
    }
  }
  if (kind === "avatar")
    id === "all" ? await fixAllAvatars(customerId) : await fixAvatar(id, customerId)
  else if (kind === "voice")
    id === "all" ? await fixAllVoices(customerId) : await fixVoice(id, customerId)
  else if (kind === "video") {
    if (id === "all") {
      console.error("video 不支持 all（曦灵无批量列视频接口），请传具体 taskId")
      process.exit(1)
    }
    await fixVideo(id)
  } else {
    console.error(`未知类型: ${kind}`)
    process.exit(1)
  }
}

main()
  .catch(err => {
    console.error("修复失败:", err instanceof Error ? err.message : err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
