# SellerOS / VidFlow 图片与视频创作来源隔离

在 **SellerOS 对应的数据库** 执行 SQL，不在 VidFlow 数据库执行。

1. 暂停 SellerOS / VidFlow 图片新提交，并等待在途任务完成、归档（避免旧代码继续创建无来源的 Job；新代码会拒绝未回填的旧 VidFlow Job 内部轮询）。
2. 执行 `01-schema.sql`：给 ImageGenJob 增加 `source`；已有列时跳过。MySQL DDL 会自动提交。
3. 执行 `02-preview.sql`，核对项目归属及回填范围。
4. 确认预览后执行 `03-backfill.sql`：仅补齐图片/视频任务来源，不删除项目、任务、图片或视频，不修改扣费。
5. 部署新版 SellerOS API（按更新后的 schema 生成 Prisma Client），恢复提交。
6. 使用同手机号分别在两系统创建：SellerOS 项目/任务/工作台/生成记录不显示 VidFlow 内容；SellerOS JWT 不能访问 VidFlow 资源 ID；VidFlow 内部生成、轮询与归档正常。

视频项目和任务已存在 source 字段，本次不新增视频字段；02/03 已包含视频预览与回填。若此前已执行图片回填，可重新执行更新后的 02/03。

三个 SQL 文件可重复执行。部署容器已有 `prisma db push`，可能先行创建 source 列；01 会检测并跳过。不要在回填之后重新部署旧代码。

## 未归档旧 Job

旧 ImageGenJob 没有来源标记，未关联任务的旧 Job 无法仅凭库中数据可靠区分。02 最后一个查询只列候选，不能把同一用户全部 Job 判为 VidFlow。

需要用 VidFlow 本地记录的源平台 jobId、请求日志等核对精确 ID。确认后可单独执行：

```sql
-- 将占位值替换为已确认的 VidFlow jobId；先 SELECT 核对，再执行 UPDATE。
SELECT id, userId, kind, status, source FROM ImageGenJob
WHERE id IN ('已确认的VidFlow-jobId');
UPDATE ImageGenJob SET source = 'vidflowos'
WHERE kind = 'IMAGE_TO_IMAGE' AND id IN ('已确认的VidFlow-jobId');
```

来源不明的历史 Job 不会被自动隐藏；需要完成上述核对才能覆盖这部分存量。新 Job 在创建时就带来源。
