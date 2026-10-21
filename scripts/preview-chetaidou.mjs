// 车泰斗工作台 — 前端静态预览服务器（端口 4321）
// python http.server 对 .mjs 返回 text/plain 会导致 ES module 加载失败，这里给正确 MIME。
// 用法：node scripts/preview-chetaidou.mjs
import http from "node:http"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve("..", "chetaidou-studio-main", "public")
const PORT = Number(process.env.PORT ?? 4321)
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost")
    let file = path.normalize(path.join(root, url.pathname === "/" ? "/studio.html" : url.pathname))
    if (!file.startsWith(root)) {
      res.writeHead(403)
      return res.end("forbidden")
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404)
        return res.end("not found")
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      })
      res.end(data)
    })
  })
  .listen(PORT, () => {
    console.log(`[preview] chetaidou-studio 静态服务: http://localhost:${PORT}/ （根路径即 studio.html）`)
  })
