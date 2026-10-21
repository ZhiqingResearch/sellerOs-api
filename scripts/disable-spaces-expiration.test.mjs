import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3"
import assert from "node:assert/strict"
import test from "node:test"
import { disableExpirationRules } from "./disable-spaces-expiration.mjs"

const rules = [
  {
    ID: "rpa-inputs-7day-expire",
    Status: "Enabled",
    Prefix: "rpa-inputs/",
    Expiration: { Days: 7 },
  },
  {
    ID: "rpa-results-7day-expire",
    Status: "Enabled",
    Prefix: "rpa-results/",
    Expiration: { Days: 7 },
  },
  {
    ID: "video-3day-expire",
    Status: "Enabled",
    Prefix: "generated-videos/",
    Expiration: { Days: 3 },
  },
  {
    ID: "beauty-video-3day-expire",
    Status: "Enabled",
    Prefix: "generated-beauty-videos/",
    Expiration: { Days: 3 },
  },
  {
    ID: "other-rule",
    Status: "Enabled",
    Filter: { Prefix: "other/" },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
  },
]

function mockClient(initial, staleRead = false) {
  let stored = structuredClone(initial)
  const calls = []
  return {
    calls,
    async send(command) {
      calls.push(command)
      assert.equal(command.input.Bucket, "erp-pro")
      if (command instanceof GetBucketLifecycleConfigurationCommand) return { Rules: stored }
      assert.ok(command instanceof PutBucketLifecycleConfigurationCommand)
      if (!staleRead) stored = command.input.LifecycleConfiguration.Rules
      return {}
    },
  }
}

test("默认预览不写配置，也不修改原规则", async () => {
  const client = mockClient(rules)
  const result = await disableExpirationRules(client, "erp-pro")
  assert.equal(client.calls.length, 1)
  assert.equal(result.changed, true)
  assert.deepEqual(result.before, rules)
  assert.ok(result.after.slice(0, 4).every(rule => rule.Status === "Disabled"))
})

test("禁用全部四条规则，保留其他规则及原字段，回读核对并支持重复执行", async () => {
  const client = mockClient(rules)
  await disableExpirationRules(client, "erp-pro", true)
  const written = client.calls[1].input.LifecycleConfiguration.Rules
  assert.deepEqual(
    written,
    rules.map((rule, index) => (index < 4 ? { ...rule, Status: "Disabled" } : rule))
  )
  assert.equal(client.calls.length, 3)
  const repeated = await disableExpirationRules(client, "erp-pro", true)
  assert.equal(repeated.changed, false)
  assert.equal(client.calls.length, 4)
})

test("桶没有生命周期配置时不创建配置", async () => {
  const result = await disableExpirationRules(
    {
      async send() {
        throw Object.assign(new Error(), { name: "NoSuchLifecycleConfiguration" })
      },
    },
    "erp-pro",
    true
  )
  assert.deepEqual(result, { before: [], after: [], changed: false })
})

test("读取权限错误直接失败，不覆盖桶配置", async () => {
  await assert.rejects(
    disableExpirationRules(
      {
        async send() {
          throw new Error("AccessDenied")
        },
      },
      "erp-pro",
      true
    ),
    /AccessDenied/
  )
})

test("写入后状态未生效时返回失败", async () => {
  await assert.rejects(
    disableExpirationRules(mockClient(rules, true), "erp-pro", true),
    /回读配置与预期不一致/
  )
})
