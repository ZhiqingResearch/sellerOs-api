/**
 * 预览：node --env-file-if-exists=.env scripts/disable-spaces-expiration.mjs
 * 禁用：在上述命令末尾加 --apply。仅处理下列四条历史过期规则。
 */
import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual, parseArgs } from "node:util"

const RULE_IDS = new Set([
  "rpa-inputs-7day-expire",
  "rpa-results-7day-expire",
  "video-3day-expire",
  "beauty-video-3day-expire",
])

export async function disableExpirationRules(client, bucket, apply = false) {
  let before
  try {
    const result = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))
    before = result.Rules ?? []
  } catch (error) {
    if (error.name !== "NoSuchLifecycleConfiguration") throw error
    before = []
  }
  const after = before.map(rule => (RULE_IDS.has(rule.ID) ? { ...rule, Status: "Disabled" } : rule))
  const changed = !isDeepStrictEqual(before, after)
  if (apply && changed) {
    // 生命周期 API 会整体覆盖，必须带回所有其他规则。
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: { Rules: after },
      })
    )
    const verified = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
    )
    if (!isDeepStrictEqual(verified.Rules, after)) {
      throw new Error("已提交禁用，但回读配置与预期不一致，请重新检查桶生命周期规则")
    }
  }
  return { before, after, changed }
}

async function main() {
  const { values: args } = parseArgs({ options: { apply: { type: "boolean" } } })
  const required = name => {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`缺少环境变量 ${name}`)
    return value
  }
  const bucket = required("SPACES_BUCKET")
  const endpoint = required("SPACES_ENDPOINT")
  const client = new S3Client({
    endpoint,
    region: process.env.SPACES_REGION || "us-east-1",
    credentials: {
      accessKeyId: required("SPACES_KEY"),
      secretAccessKey: required("SPACES_SECRET"),
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
    maxAttempts: 1,
  })
  try {
    console.log(`存储桶：${bucket}；地址：${endpoint}`)
    const result = await disableExpirationRules(client, bucket, !!args.apply)
    console.table(
      result.before.map((rule, index) => ({
        ID: rule.ID,
        Prefix: rule.Prefix ?? JSON.stringify(rule.Filter),
        当前状态: rule.Status,
        目标状态: result.after[index].Status,
      }))
    )
    console.log(
      !args.apply
        ? "预览完成，未修改桶配置。加 --apply 执行禁用。"
        : result.changed
          ? "过期规则已禁用，回读核对通过。"
          : "无需修改，目标规则已禁用或不存在。"
    )
  } finally {
    client.destroy()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`禁用过期规则失败：${error.message}`)
    process.exitCode = 1
  })
}
