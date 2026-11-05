# 统一对象存储

所有业务上传、读取、签名及删除通过 `StorageService`。`SpacesService` 是兼容导出；`OssService` 保留旧调用入口。`/api/spaces/upload-url` 路径与响应结构保持不变，实际使用当前存储。

## 配置

默认 `STORAGE_PROVIDER=oss`：配置 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_REGION`、`OSS_BUCKET`、`OSS_BASE_URL`；可选 `OSS_ENDPOINT`。SDK 强制 HTTPS、V4 签名。

使用 Spaces 时设 `STORAGE_PROVIDER=spaces`，配置 `SPACES_KEY`、`SPACES_SECRET`、`SPACES_ENDPOINT`、`SPACES_BUCKET`、`SPACES_BASE_URL`；`SPACES_REGION` 默认 `us-east-1`。未使用的另一套存储不要求凭证。配置缺失会在使用对应存储时明确报错。

切换后，所有裸 key 操作都指向当前桶。按用户确认，本次不迁移、不读取旧桶、不回退查询历史对象；旧文件不可访问可以接受。数据库原有完整 URL 不改写。Customer 自动转存跳过已配置的双方公开地址，避免无意搬运历史文件。

## 直传

调用者必须原样使用返回的 `headers`，不能写死 `x-amz-acl`。OSS 返回 `x-oss-object-acl` 和 `x-oss-meta-*`，Spaces 返回 `x-amz-acl` 和 `x-amz-meta-*`。浏览器自己发送 `Content-Length`，不要手动设置；签发时长度必须与文件字节数一致。

两个桶的 CORS 按实际站点配置 GET、HEAD、PUT（旧表单需 POST），允许签名返回的请求头，暴露 `Content-Disposition`、`ETag`。初始化命令的 `--allow-origin` 会合并以上方法，不覆盖已有规则；`--dry-run` 不写入。

`GET /api/oss/policy` 是显式 OSS 旧表单协议，仍返回原结构。上传 key 必须用返回的 `dir`（`uploads/legacy/`）拼接文件名，不能再从桶根写入；即使当前业务选择 Spaces，此接口仍明确操作 OSS，需要独立 OSS 配置。普通业务使用通用 PUT 入口。

审核文件、AIGC 产物的覆盖限制、私有 ACL、metadata、下载文件名及 Range 保留。HEAD 只将 404 视为缺失，403/网络错误继续抛出。定时清理只处理当前桶审核临时与快照前缀；OSS 生命周期规则在云控制台配置，应用不声称已自动配置。

## 独立脚本

先 `npm run build`，脚本通过 `scripts/object-storage.mjs` 复用编译后的服务和同一套配置：

- `scripts/upload-product-publish-templates.mjs`：新模板上传当前桶，保留附件名和缓存响应头；dry-run 不上传。
- `scripts/init-chetaidou-production.mjs`：新母版/缩略图均确保存在于当前桶，校验哈希后落库；不能凭旧 `uploadedKey` 跳过上传。现有数据库记录保持不变。预置资料的既有 Spaces URL 仍作为初始化源读取（需源 Spaces 读取凭证），不作为业务历史兼容层。
- `scripts/disable-spaces-expiration.mjs`：仍为显式 Spaces 运维工具，不随业务 provider 切换。

本地测试不写真实云桶。上线需用测试桶与浏览器验证 CORS、PUT/GET V4 签名、Range，以及私有文件无签名访问返回 403。
