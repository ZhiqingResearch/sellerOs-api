import sharp from "sharp"
import {
  aigcMetadata,
  contentId,
  parseAigc,
  readAigcXmp,
  xmlEscape,
} from "./aigc-metadata"

export function readImageAigc(meta: Pick<sharp.Metadata, "xmp" | "comments">) {
  return (
    parseAigc(meta.comments?.find(item => item.keyword === "AIGC")?.text) ??
    readAigcXmp(meta.xmp?.toString("utf8"))
  )
}

function pngAigc(buffer: Buffer, json: string): Buffer {
  const ascii = json.replace(
    /[^\x20-\x7e]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  )
  const data = Buffer.from(`tEXtAIGC\0${ascii}`, "ascii")
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const chunk = Buffer.alloc(data.length + 8)
  chunk.writeUInt32BE(data.length - 4, 0)
  data.copy(chunk, 4)
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  // 放在IHDR之后，仅读取头部的元数据工具也能核验，无需解码整幅像素。
  return Buffer.concat([buffer.subarray(0, 33), chunk, buffer.subarray(33)])
}

export async function labelImage(buffer: Buffer, id = contentId(buffer)) {
  const meta = await sharp(buffer, { limitInputPixels: false }).metadata()
  if (
    !meta.width ||
    !meta.height ||
    (meta.pages ?? 1) > 1 ||
    !["png", "jpeg", "webp"].includes(meta.format ?? "")
  )
    throw new Error("生成图片格式暂不支持标识处理")
  const rotated = (meta.orientation ?? 1) >= 5 && (meta.orientation ?? 1) <= 8
  const width = rotated ? meta.height : meta.width
  const height = rotated ? meta.width : meta.height
  const original = readImageAigc(meta)
  const metadata = aigcMetadata(id, original)
  const json = JSON.stringify(metadata)
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:aigc="urn:selleros:aigc:1.0/"><aigc:AIGC>${xmlEscape(json)}</aigc:AIGC></rdf:Description></rdf:RDF></x:xmpmeta>`
  let image = sharp(buffer, { limitInputPixels: false }).rotate()
  if (meta.format !== "png") image = image.withXmp(xmp)
  if (meta.format === "jpeg") image = image.jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
  else if (meta.format === "webp") image = image.webp({ quality: 95 })
  else image = image.png()
  let output: Buffer = await image.toBuffer()
  if (meta.format === "png") output = pngAigc(output, json)
  const verified = await sharp(output).metadata()
  if (
    verified.width !== width ||
    verified.height !== height ||
    readImageAigc(verified)?.AIGC.PropagateID !== id
  )
    throw new Error("生成图片标识校验失败")
  return { buffer: output, mime: `image/${meta.format}`, metadata, width, height }
}
