import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

export const digest = value => createHash("sha256").update(value).digest("hex")
export const jsonHash = value => digest(JSON.stringify(sort(value)))
function sort(value) {
  if (Array.isArray(value)) return value.map(sort)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]))
  }
  return value
}
export async function containedFile(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) {
    throw new Error("数据包文件必须使用相对路径")
  }
  const base = await realpath(root)
  const file = await realpath(path.resolve(base, relative))
  if (!file.startsWith(base + path.sep)) throw new Error(`数据包文件越界：${relative}`)
  return file
}
export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"))
}

export function presetAcceptance(manifest) {
  const acceptance = manifest.breakdownAcceptance
  if (acceptance?.status !== "confirmed" || !/^\d{4}-\d{2}-\d{2}$/.test(acceptance.confirmedOn ?? "") ||
      typeof acceptance.basis !== "string" || !acceptance.basis.trim()) {
    throw new Error("初始化资料包缺少母版及拆解的已确认记录，请使用已确认的完整资料包")
  }
  return acceptance
}

/** 事实规则作为资料随包分发；不依赖历史修复脚本或某个数据库中的 ID/版本。 */
export async function loadFacts(root, manifest, { cardRoot = root } = {}) {
  if (!manifest.factCardFile || !/^[a-f0-9]{64}$/.test(manifest.factCardHash ?? "")) {
    throw new Error("资料包缺少结构化事实卡及校验哈希，请使用完整的最新版资料包")
  }
  const document = await readFile(await containedFile(root, manifest.factsFile), "utf8")
  if (!document.trim() || document.includes("开发联调占位 facts")) throw new Error("商品文档为空或仍是演示占位事实卡")
  const card = await readJson(await containedFile(cardRoot, manifest.factCardFile))
  if (jsonHash(card) !== manifest.factCardHash) throw new Error("结构化事实卡哈希不一致，请核对资料包")
  if (card?.schemaVersion !== 1 || card.skuCode !== manifest.sku.code) throw new Error("结构化事实卡版本或 SKU 归属不正确")
  const content = card.content
  const isText = value => typeof value === "string" && value.trim().length > 0
  const textArray = value => Array.isArray(value) && value.every(isText)
  const rows = (value, fields) => Array.isArray(value) && value.every(row => row && fields.every(field => isText(row[field])))
  if (!content || !isText(content.scope) || !textArray(content.hardConstraints) || !content.hardConstraints.length ||
      !textArray(content.dataIsolationRules) || !content.dataIsolationRules.length || !textArray(content.unknowns) ||
      !rows(content.conditionalRules, ["appliesWhen", "rule"]) || !rows(content.imageReferences, ["imageNumber", "status", "observation"])) {
    throw new Error("结构化事实卡字段不完整：需要硬约束、资料隔离、条件规则、单图参考和未知事项")
  }
  const provenance = content.provenance
  if (provenance?.sourcePath !== manifest.factsFile || provenance.sourceHash !== digest(document) ||
      !isText(provenance.sourceDate) || !isText(provenance.rulesDate)) {
    throw new Error("事实卡与来源文档不匹配，请重新核对规则和来源哈希")
  }
  const facts = { ...content, document }
  return { facts, factsHash: jsonHash(facts) }
}

/** 只把当前 Spaces 的 URL 还原为 key；读取走已有 S3 凭证，不持久化临时签名。 */
export function uploadedImageKey(value, { baseUrl, endpoint, bucket }) {
  let url
  try { url = new URL(value) } catch { throw new Error("图片 URL 格式不正确") }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("图片 URL 必须是 HTTP(S) 地址，且不能包含用户名密码")
  const bases = baseUrl ? [new URL(baseUrl)] : []
  if (endpoint && bucket) {
    const server = new URL(endpoint)
    const virtual = new URL(server.origin)
    if (!virtual.hostname.startsWith(`${bucket}.`)) virtual.hostname = `${bucket}.${virtual.hostname}`
    bases.push(virtual, new URL(`${server.origin}/${encodeURIComponent(bucket)}/`))
    // Spaces 上传接口可能返回同一桶的 CDN 域名，key 与源站一致。
    if (/^[a-z0-9-]+\.digitaloceanspaces\.com$/.test(server.hostname)) {
      const cdn = new URL(virtual)
      cdn.hostname = `${bucket}.${server.hostname.replace(".digitaloceanspaces.com", ".cdn.digitaloceanspaces.com")}`
      bases.push(cdn)
    }
  }
  for (const base of bases) {
    const prefix = base.pathname.replace(/\/$/, "") + "/"
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) continue
    const key = decodeURIComponent(url.pathname.slice(prefix.length))
    if (!key || key.includes("\\") || key.includes("\0") || key.split("/").some(part => !part || part === "." || part === "..")) throw new Error("图片 URL 的对象路径不正确")
    return key
  }
  throw new Error("图片 URL 不属于当前环境的 Spaces 存储桶，请确认 SPACES 配置与上传环境一致")
}

/** 旧拆解缺少货篮信息时明确存 null；不能把未知写成 hasItems=false。 */
export function normalizeBreakdown(raw, checksum, validate) {
  if (raw.sourceHash !== checksum) throw new Error("拆解 sourceHash 与母版文件不一致")
  if (!["ai_unreviewed", "confirmed"].includes(raw.qualityStatus)) {
    throw new Error("初始化拆解来源状态无效，不能导入失效或未知状态的底稿")
  }
  const fields = ["summary", "hasPeople", "persons", "textInventory", "softFeatures", "hardConstraints", "conflicts", "uncertainties"]
  const payload = Object.fromEntries(fields.map(key => [key, raw[key]]))
  for (const key of ["baskets", "pets", "props"]) if (raw[key] !== undefined) payload[key] = raw[key]
  payload.textInventory = payload.textInventory?.map(t => ({ ...t, editable: t.editable && t.category === "marketing" && t.readability === "readable" }))
  const missingBasket = raw.basketContents == null
  // 只借完整 schema 校验其余原始字段；此占位对象不会落库。
  validate({ ...payload, basketContents: missingBasket ? { hasItems: false, evidence: "", items: [] } : raw.basketContents })
  payload.basketContents = missingBasket ? null : raw.basketContents
  if (missingBasket) {
    payload.uncertainties = [...payload.uncertainties, "历史拆解未记录货篮物品信息，不能据此认定为空；保持未知，不推断空篮。"]
  }
  return { payload, missingBasket }
}

export async function loadBundle(root, validate, { readUploadedImage } = {}) {
  const manifest = await readJson(await containedFile(root, "manifest.json"))
  if (manifest.version !== 1 || manifest.sku?.code !== "CS1plus" || !manifest.sku.name) {
    throw new Error("数据包版本或 SKU 不正确，当前仅支持 CS1plus")
  }
  presetAcceptance(manifest)
  const { facts, factsHash } = await loadFacts(root, manifest)
  const catalog = await readJson(await containedFile(root, manifest.catalogFile))
  if (!Array.isArray(catalog.images) || catalog.images.length !== manifest.imageCount || !catalog.images.length) {
    throw new Error("母版目录数量与数据包声明不一致")
  }
  const images = []
  const ids = new Set()
  for (const entry of catalog.images) {
    if (!/^img-[a-zA-Z0-9_-]+$/.test(entry.id) || ids.has(entry.id)) throw new Error(`母版 ID 非法或重复：${entry.id}`)
    ids.add(entry.id)
    if (entry.sourceType !== "preset" || entry.originalAcceptance !== "approved") throw new Error(`${entry.id} 不是已验收预置母版`)
    if (!entry.title || entry.title.length > 200 || String(entry.number ?? "").length > 100) throw new Error(`${entry.id} 标题或编号非法`)
    let file, bytes, uploadedKey
    if (entry.url !== undefined) {
      if (typeof entry.url !== "string" || !entry.url.trim() || entry.file !== undefined) throw new Error(`${entry.id} 请只提供 file 或 url 中的一项`)
      if (!readUploadedImage) throw new Error(`${entry.id} 为已上传图片，需要配置 Spaces 读取方式`)
      const uploaded = await readUploadedImage(entry.url)
      if (entry.objectKey !== undefined && entry.objectKey !== uploaded.key) throw new Error(`${entry.id} URL 与 objectKey 不一致`)
      bytes = uploaded.bytes
      uploadedKey = uploaded.key
      // URL 仅作来源记录；落库 key 持久有效，不保存过期签名参数。
      const source = new URL(entry.url)
      source.search = ""
      source.hash = ""
      entry.url = source.href
    } else {
      file = await containedFile(root, entry.file)
      bytes = await readFile(file)
    }
    const checksum = digest(bytes)
    if (checksum !== entry.sha256) throw new Error(`${entry.id} 图片哈希不一致`)
    const reader = sharp(bytes, { limitInputPixels: false, failOn: "error" })
    const meta = await reader.metadata()
    if (!["jpeg", "png", "webp"].includes(meta.format) || !meta.width || !meta.height || (meta.pages ?? 1) > 1) throw new Error(`${entry.id} 图片格式非法`)
    await reader.stats()
    if (meta.width !== entry.width || meta.height !== entry.height || `image/${meta.format}` !== entry.mime) throw new Error(`${entry.id} 图片尺寸或类型与目录不一致`)
    const raw = await readJson(await containedFile(root, `${manifest.breakdownsDir}/${entry.id}.json`))
    if (raw.imageId !== entry.id) throw new Error(`${entry.id} 拆解归属错误`)
    const { payload, missingBasket } = normalizeBreakdown(raw, checksum, validate)
    images.push({ entry, file, ...(uploadedKey ? { uploadedKey, bytes } : {}), checksum, payload, missingBasket, mime: `image/${meta.format}`, width: meta.width, height: meta.height, raw })
  }
  return { manifest, facts, factsHash, images }
}

/** 输出自包含素材包，保留原图、目录、拆解和商品文档，不复制任务/密钥/用户数据。 */
export async function packBundle(source, destination, { imageUrls } = {}) {
  let manifest, cardRoot = source
  try { manifest = await readJson(await containedFile(source, "manifest.json")) }
  catch (error) {
    if (error.code !== "ENOENT") throw error
    // 原型仓库没有 manifest 时，只有来源文档与已核对版本完全一致才可使用内置规则。
    cardRoot = fileURLToPath(new URL("./preset-data/", import.meta.url))
    manifest = await readJson(await containedFile(cardRoot, "manifest.json"))
  }
  if (manifest.version !== 1 || manifest.sku?.code !== "CS1plus" || !manifest.sku.name) throw new Error("数据包版本或 SKU 不正确，当前仅支持 CS1plus")
  presetAcceptance(manifest)
  await loadFacts(source, manifest, { cardRoot })
  const catalog = await readJson(await containedFile(source, manifest.catalogFile))
  if (!Array.isArray(catalog.images) || !catalog.images.length || catalog.images.length !== manifest.imageCount) throw new Error("母版目录数量与数据包声明不一致")
  if (imageUrls !== undefined && (!imageUrls || Array.isArray(imageUrls) || typeof imageUrls !== "object")) throw new Error("图片 URL 清单必须是 imageId 到 URL 的对象")
  if (imageUrls) for (const image of catalog.images) {
    if (typeof imageUrls[image.id] !== "string" || !imageUrls[image.id].trim()) throw new Error(`${image.id} 缺少图片 URL`)
    const url = new URL(imageUrls[image.id])
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error(`${image.id} 图片 URL 不正确`)
    url.search = ""
    url.hash = ""
    delete image.file
    image.url = url.href
  }
  await mkdir(destination, { recursive: true })
  // manifest 最后写入；打包中断的目录不会被识别为完整数据包。
  const files = [manifest.catalogFile, manifest.factsFile]
  for (const image of catalog.images) {
    if (!/^img-[a-zA-Z0-9_-]+$/.test(image.id)) throw new Error("母版 ID 非法")
    if (!imageUrls && image.file !== undefined) files.push(image.file)
    files.push(`${manifest.breakdownsDir}/${image.id}.json`)
  }
  for (const relative of files) {
    const from = await containedFile(source, relative)
    const to = path.resolve(destination, relative)
    if (!to.startsWith(path.resolve(destination) + path.sep)) throw new Error("输出路径越界")
    await mkdir(path.dirname(to), { recursive: true })
    await copyFile(from, to)
  }
  const cardFile = await containedFile(cardRoot, manifest.factCardFile)
  const cardDestination = path.resolve(destination, manifest.factCardFile)
  if (!cardDestination.startsWith(path.resolve(destination) + path.sep)) throw new Error("输出路径越界")
  await mkdir(path.dirname(cardDestination), { recursive: true })
  await copyFile(cardFile, cardDestination)
  if (imageUrls) await writeFile(path.join(destination, manifest.catalogFile), JSON.stringify(catalog, null, 2) + "\n")
  await writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
}
