/**
 * 列出当前 XILING_APP_ID 下所有已有的数字人形象和音色（分页全量拉取），输出到控制台。
 *
 * 用法：
 *   npx ts-node scripts/list-xiling.ts            # 两个都列
 *   npx ts-node scripts/list-xiling.ts avatar     # 只列形象
 *   npx ts-node scripts/list-xiling.ts voice      # 只列音色
 */
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
    // 形象接口是 result.result，音色是 result 直接数组
    const page = Array.isArray(data.result) ? data.result : data.result.result
    out.push(...page)
    if (!page.length || page.length < pageSize) break
  }
  return out
}

type Avatar = {
  figureId: string
  name: string
  gender?: string
  status: string
  templateImg?: string
  resolutionWidth?: number
  resolutionHeight?: number
  taskSubmitTime?: string
  failedMessage?: string
}

type Voice = {
  perId: string
  name: string
  gender?: string
  status: string
  exampleAudioUrl?: string
  reason?: string
  submitTime?: string
}

async function listAvatars() {
  const rows = await listAll<Avatar>("/figure/lite2d/query")
  console.log(`\n=== 数字人形象 (${rows.length} 条) ===`)
  for (const a of rows) {
    console.log(
      `  [${a.status.padEnd(8)}] ${a.figureId}  ${a.name ?? "-"}  gender=${a.gender ?? "-"}  ` +
        `resolution=${a.resolutionWidth ?? "-"}x${a.resolutionHeight ?? "-"}  ` +
        `submitted=${a.taskSubmitTime ?? "-"}` +
        (a.failedMessage ? `  ✗ ${a.failedMessage}` : "")
    )
  }
}

async function listVoices() {
  // isSuccess=false 才能同时看到 SUCCESS/FAILED/进行中
  const rows = await listAll<Voice>("/tts/clone", { isSuccess: false })
  console.log(`\n=== 音色克隆 (${rows.length} 条) ===`)
  for (const v of rows) {
    console.log(
      `  [${v.status.padEnd(8)}] ${v.perId}  ${v.name ?? "-"}  gender=${v.gender ?? "-"}  ` +
        `submitted=${v.submitTime ?? "-"}` +
        (v.reason ? `  ✗ ${v.reason}` : "")
    )
  }
}

async function main() {
  const kind = process.argv[2]
  if (!kind || kind === "avatar") await listAvatars()
  if (!kind || kind === "voice") await listVoices()
  if (kind && kind !== "avatar" && kind !== "voice") {
    console.error(`未知类型: ${kind}（可选 avatar | voice，或留空列全部）`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error("列表失败:", err instanceof Error ? err.message : err)
  process.exit(1)
})
