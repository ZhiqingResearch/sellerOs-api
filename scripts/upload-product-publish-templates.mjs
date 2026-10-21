import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..")
const FEATURE_DIR = path.join(ROOT_DIR, "temp", "20260722一键上架功能")
const TEMPLATE_DIR = path.join(FEATURE_DIR, "templates")
const MAPPING_FILE = path.join(FEATURE_DIR, "模版映射说明.txt")
const KEY_PREFIX = "product-publish/templates"
const MIME_TYPE = "application/vnd.ms-excel.sheet.macroEnabled.12"
const dryRun = process.argv.includes("--dry-run")

const mappingText = await readFile(MAPPING_FILE, "utf8")
const mappingLines = mappingText
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean)

if (mappingLines.length === 0 || mappingLines.length % 2 !== 0) {
  throw new Error("模板映射文件格式错误：必须按“分类名、模板文件名”两行一组")
}

const mappings = []
for (let index = 0; index < mappingLines.length; index += 2) {
  mappings.push({ classification: mappingLines[index], filename: mappingLines[index + 1] })
}

const duplicateClassifications = findDuplicates(mappings.map(item => item.classification))
const duplicateFiles = findDuplicates(mappings.map(item => item.filename))
if (duplicateClassifications.length > 0) {
  throw new Error(`存在重复分类：${duplicateClassifications.join(", ")}`)
}
if (duplicateFiles.length > 0) {
  throw new Error(`存在重复模板：${duplicateFiles.join(", ")}`)
}

const actualFiles = (await readdir(TEMPLATE_DIR))
  .filter(filename => filename.endsWith(".xlsm"))
  .sort()
const mappedFiles = mappings.map(item => item.filename).sort()
const missingFiles = mappedFiles.filter(filename => !actualFiles.includes(filename))
const extraFiles = actualFiles.filter(filename => !mappedFiles.includes(filename))
if (missingFiles.length > 0 || extraFiles.length > 0) {
  throw new Error(
    [
      missingFiles.length > 0 ? `缺少模板：${missingFiles.join(", ")}` : "",
      extraFiles.length > 0 ? `存在未映射模板：${extraFiles.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("；")
  )
}

if (dryRun) {
  console.log(`模板检查通过，共 ${mappings.length} 个文件（dry-run，未上传）`)
  for (const item of mappings) {
    console.log(`${item.classification} -> ${KEY_PREFIX}/${item.filename}`)
  }
  process.exit(0)
}

const requiredEnvNames = [
  "SPACES_KEY",
  "SPACES_SECRET",
  "SPACES_ENDPOINT",
  "SPACES_BUCKET",
  "SPACES_BASE_URL",
]
const missingEnvNames = requiredEnvNames.filter(name => !process.env[name]?.trim())
if (missingEnvNames.length > 0) {
  throw new Error(`缺少 Spaces 环境变量：${missingEnvNames.join(", ")}`)
}

const client = new S3Client({
  endpoint: process.env.SPACES_ENDPOINT,
  forcePathStyle: false,
  region: process.env.SPACES_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET,
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
})

for (const item of mappings) {
  const key = `${KEY_PREFIX}/${item.filename}`
  const body = await readFile(path.join(TEMPLATE_DIR, item.filename))
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.SPACES_BUCKET,
      Key: key,
      Body: body,
      ContentType: MIME_TYPE,
      ContentDisposition: `attachment; filename="${item.filename}"`,
      CacheControl: "public, max-age=3600",
      ACL: "public-read",
    })
  )
  const url = `${process.env.SPACES_BASE_URL.replace(/\/$/, "")}/${key}`
  console.log(`上传完成：${item.classification} -> ${url}`)
}

console.log(`全部模板上传完成，共 ${mappings.length} 个文件`)

function findDuplicates(values) {
  const seen = new Set()
  const duplicates = new Set()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}
