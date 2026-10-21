/**
 * 曦灵只读查询脚本。只打印百度返回的完整 JSON，不写 DB。
 *
 * 用法：
 *   npx ts-node scripts/query-xiling.ts avatar <figureId>
 *   npx ts-node scripts/query-xiling.ts voice  <perId>
 *   npx ts-node scripts/query-xiling.ts video  <taskId>
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

const get = async (path: string, params: Record<string, unknown>) => {
  const { data } = await axios.get(`${BASE_URL}${path}`, {
    headers: { Authorization: auth() },
    params,
  })
  return data
}

async function main() {
  const [kind, id] = process.argv.slice(2)
  if (!kind || !id) {
    console.error("用法: npx ts-node scripts/query-xiling.ts <avatar|voice|video> <id>")
    process.exit(1)
  }
  const data =
    kind === "avatar"
      ? await get("/figure/lite2d/query", { figureId: id })
      : kind === "voice"
        ? await get("/tts/clone", { perId: id, isSuccess: false })
        : kind === "video"
          ? await get("/video/task", { taskId: id })
          : null
  if (data === null) {
    console.error(`未知类型: ${kind}`)
    process.exit(1)
  }
  console.log(JSON.stringify(data, null, 2))
}

main().catch(err => {
  console.error("查询失败:", err instanceof Error ? err.message : err)
  process.exit(1)
})
