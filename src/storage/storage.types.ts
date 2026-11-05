/** 对象下载响应头；部署脚本上传模板时沿用原有缓存及附件行为。 */
export interface ObjectResponseHeaders {
  contentDisposition?: string
  cacheControl?: string
}
