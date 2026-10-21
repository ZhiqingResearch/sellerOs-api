const { readFile, stat } = require("node:fs/promises")
const { createHmac, randomUUID } = require("node:crypto")
const { basename } = require("node:path")
const { PrismaClient } = require("@prisma/client")
const { AiGatewayClient } = require("@zhiqingresearch/ai-ts-sdk")
const jwt = require("jsonwebtoken")

const API_BASE_URL = process.env.AI_SPLIT_SMOKE_API_URL || "http://127.0.0.1:8000"
const TEST_USER_ID = Number(process.env.AI_SPLIT_SMOKE_USER_ID || 6)
const SKU_IMAGE =
  process.env.AI_SPLIT_SMOKE_SKU_IMAGE ||
  "/Users/zqzx/Downloads/whiteboard_exported_image (1).png"
const COMPETITOR_IMAGE =
  process.env.AI_SPLIT_SMOKE_COMPETITOR_IMAGE ||
  "/Users/zqzx/Downloads/whiteboard_exported_image.png"
const IMAGE_MODEL = process.env.AI_SPLIT_SMOKE_IMAGE_MODEL || "ZQ-Image-1"
const MAX_WAIT_MS = Number(process.env.AI_SPLIT_SMOKE_MAX_WAIT_MS || 12 * 60 * 1000)
const EXISTING_PROJECT_ID = process.env.AI_SPLIT_SMOKE_PROJECT_ID
  ? Number(process.env.AI_SPLIT_SMOKE_PROJECT_ID)
  : null

const prisma = new PrismaClient()
let token = ""
let projectId = null

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function api(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} -> ${response.status}: ${JSON.stringify(data)}`)
  }
  return data
}

async function uploadImage(path, label) {
  const [buffer, file] = await Promise.all([readFile(path), stat(path)])
  const signed = await api(`/api/image-project/${projectId}/ai-split/upload-url`, {
    method: "POST",
    body: {
      fileName: basename(path),
      contentType: "image/png",
      fileSize: file.size,
    },
  })
  const response = await fetch(signed.uploadUrl, {
    method: "PUT",
    headers: signed.headers,
    body: buffer,
  })
  if (!response.ok) {
    throw new Error(`${label} 上传失败：HTTP ${response.status} ${await response.text()}`)
  }
  console.log(`[upload] ${label}: ${signed.publicUrl}`)
  return signed.publicUrl
}

function callbackSecret() {
  const versions = Object.keys(process.env)
    .map(key => /^AI_GATEWAY_CALLBACK_SECRET_V(\d+)$/.exec(key))
    .filter(Boolean)
    .map(match => Number(match[1]))
    .sort((a, b) => b - a)
  const version = versions[0]
  const secret = version ? process.env[`AI_GATEWAY_CALLBACK_SECRET_V${version}`] : null
  if (!version || !secret) throw new Error("未配置 AI Gateway 回调密钥")
  return { version, secret }
}

async function deliverTerminalWebhook(task) {
  const eventId = `evt_smoke_${randomUUID().replaceAll("-", "")}`
  const event = {
    id: eventId,
    object: "event",
    type: `${task.object}.${task.status}`,
    created_at: Math.floor(Date.now() / 1000),
    data: { task },
  }
  const rawBody = JSON.stringify(event)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const { version, secret } = callbackSecret()
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex")
  const response = await fetch(`${API_BASE_URL}/api/webhooks/ai-gateway`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AI-Gateway-Event-Id": eventId,
      "X-AI-Gateway-Secret-Version": String(version),
      "X-AI-Gateway-Timestamp": timestamp,
      "X-AI-Gateway-Signature": `v1=${signature}`,
    },
    body: rawBody,
  })
  if (!response.ok) {
    throw new Error(`终态回调失败：HTTP ${response.status} ${await response.text()}`)
  }
  console.log(`[webhook] 已按正式签名协议应用 ${task.id} / ${task.status}`)
}

async function main() {
  const startedAt = new Date()
  const user = await prisma.user.findUnique({
    where: { id: TEST_USER_ID },
    select: {
      id: true,
      phone: true,
      username: true,
      balance: true,
      isActive: true,
      roles: {
        select: { role: { select: { code: true } } },
        orderBy: { roleId: "asc" },
        take: 1,
      },
      orgs: { select: { orgId: true }, orderBy: { orgId: "asc" }, take: 1 },
    },
  })
  if (!user?.isActive) throw new Error(`测试用户 ${TEST_USER_ID} 不存在或已停用`)
  token = jwt.sign(
    {
      sub: user.id,
      phone: user.phone,
      roleCode: user.roles[0]?.role.code ?? null,
      currentOrgId: user.orgs[0]?.orgId ?? null,
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  )

  console.log(`[start] user=${user.username}(${user.id}), balance=${user.balance}`)
  if (EXISTING_PROJECT_ID) {
    projectId = EXISTING_PROJECT_ID
    console.log(`[project] 继续测试项目 ${projectId}`)
  } else {
    const project = await api("/api/image-project", {
      method: "POST",
      body: {
        name: `AI拆图测试-running-board-${new Date().toISOString().slice(0, 19)}`,
        type: "ECOMMERCE",
      },
    })
    projectId = project.id
    console.log(`[project] 创建独立测试项目 ${projectId}`)
  }

  if (!EXISTING_PROJECT_ID) {
    await api(`/api/image-project/${projectId}/product-profile`, {
      method: "PATCH",
      body: {
        productName: "Vehicle Running Boards / Side Steps",
        sku: "AI-SPLIT-SMOKE-RUNNING-BOARD",
        categoryL1: "Automotive",
        categoryL2: "Exterior Accessories",
        categoryL3: "Running Boards",
        targetCountries: ["美国"],
        ecommercePlatforms: ["Amazon"],
        attributes: [
          { key: "产品类型", value: "车辆侧踏板 / 上车辅助踏板" },
          { key: "外观", value: "黑色或深灰色长条踏板，带防滑踩踏区域和安装支架" },
        ],
        sellingPoints: ["辅助上下车辆", "防滑踩踏区域", "适用于车辆侧面安装"],
        extra: "商品事实仅依据用户提供的 SKU 图片；不得虚构具体车型、尺寸、承重、材质或认证。",
        sourceLocale: "zh-CN",
        defaultLocale: "zh-CN",
      },
    })
  }

  const previousTask = EXISTING_PROJECT_ID
    ? await prisma.generationTask.findFirst({
        where: { projectId, generationMode: "AI_SPLIT" },
        select: { promptConfig: true },
        orderBy: { id: "desc" },
      })
    : null
  const existingImages = EXISTING_PROJECT_ID
    ? await api(`/api/image-project/${projectId}/product-image`)
    : []
  let skuUrl = existingImages.find(image => image.purpose === "PRODUCT_MAIN")?.url
  let competitorUrl = previousTask?.promptConfig?.reference?.url
  if (!skuUrl) {
    skuUrl = await uploadImage(SKU_IMAGE, "SKU 主图")
    await api(`/api/image-project/${projectId}/product-image`, {
      method: "POST",
      body: {
        url: skuUrl,
        tag: "主图",
        purpose: "PRODUCT_MAIN",
        note: "用户提供的 SKU 主体图：车辆侧踏板（running board）的多角度/多组件展示，不是包装。",
        isPrimary: true,
        order: 0,
      },
    })
  } else {
    console.log(`[reuse] SKU 主图: ${skuUrl}`)
  }
  if (!competitorUrl) competitorUrl = await uploadImage(COMPETITOR_IMAGE, "竞品图")
  else console.log(`[reuse] 竞品图: ${competitorUrl}`)

  const created = await api(`/api/image-project/${projectId}/ai-split/tasks`, {
    method: "POST",
    body: {
      clientRequestId: randomUUID(),
      competitorReferences: [
        {
          sourceType: "UPLOAD",
          url: competitorUrl,
          saveToCompetitorData: false,
        },
      ],
      site: "AMAZON_US",
      textAmount: "LOW",
      model: IMAGE_MODEL,
      quantity: 1,
      promptConfig: {
        model_params: {
          aspect_ratio: "1:1",
          size: "1024x1024",
          quality: "standard",
          output_format: "png",
        },
      },
    },
  })
  const groupId = created.groupId
  const gateway = new AiGatewayClient({
    baseURL: process.env.AI_GATEWAY_BASE_URL,
    apiKey: process.env.AI_GATEWAY_API_KEY,
    timeoutMs: 60_000,
    getRetry: { maxRetries: 0 },
  })
  console.log(`[task] group=${groupId}, task=${created.tasks[0]?.id}, stage=${created.tasks[0]?.stage}`)

  const deadline = Date.now() + MAX_WAIT_MS
  let lastState = ""
  let lastHeartbeat = 0
  let finalGroup = created
  const delivered = new Set()
  while (Date.now() < deadline) {
    finalGroup = await api(`/api/image-project/ai-split/tasks?groupId=${encodeURIComponent(groupId)}`)
    const task = finalGroup.tasks[0]
    const state = `${finalGroup.status}/${task.status}/${task.stage}`
    if (state !== lastState) {
      console.log(`[progress] ${state}`)
      lastState = state
    } else if (Date.now() - lastHeartbeat >= 30_000) {
      console.log(`[progress] 等待中 ${state}`)
      lastHeartbeat = Date.now()
    }

    if (["SUCCESS", "PARTIAL_SUCCESS", "FAILED"].includes(finalGroup.status)) break
    if (task.stage === "IMAGE_GENERATING") {
      const localTask = await prisma.generationTask.findUnique({
        where: { id: task.id },
        select: { gatewayTaskId: true },
      })
      if (localTask?.gatewayTaskId) {
        const remoteTask = await gateway.tasks.get(localTask.gatewayTaskId)
        if (!["queued", "running"].includes(remoteTask.status) && !delivered.has(remoteTask.id)) {
          await deliverTerminalWebhook(remoteTask)
          delivered.add(remoteTask.id)
        }
      }
    }
    await sleep(5_000)
  }
  if (finalGroup.status === "GENERATING") {
    throw new Error(`等待 AI 拆图完成超时：${JSON.stringify(finalGroup.tasks[0])}`)
  }

  const [freshUser, usageLogs] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { balance: true } }),
    prisma.usageLog.findMany({
      where: { userId: user.id, createdAt: { gte: startedAt } },
      select: {
        id: true,
        source: true,
        cost: true,
        credits: true,
        balanceAfter: true,
        requestId: true,
        meta: true,
        createdAt: true,
      },
      orderBy: { id: "asc" },
    }),
  ])

  const task = finalGroup.tasks[0]
  const snapshotTask = task.id
    ? await prisma.generationTask.findUnique({
        where: { id: task.id },
        select: { promptConfig: true },
      })
    : null
  console.log("[result] " + JSON.stringify({
    projectId,
    groupId,
    status: finalGroup.status,
    taskId: task.id,
    stage: task.stage,
    analysisModel: snapshotTask?.promptConfig?.analysisModel?.publicId ?? null,
    imageModel: IMAGE_MODEL,
    skuUrl,
    competitorUrl,
    competitorTemplate: task.competitorTemplate,
    generationPlan: task.generationPlan,
    images: finalGroup.results.map(image => ({
      id: image.id,
      status: image.status,
      url: image.url,
      errorMessage: image.errorMessage,
    })),
    balanceBefore: String(user.balance),
    balanceAfter: String(freshUser?.balance),
    usageLogs,
  }, null, 2))
}

main()
  .catch(error => {
    console.error(`[failed] project=${projectId ?? "not-created"}`)
    console.error(error?.stack || error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
