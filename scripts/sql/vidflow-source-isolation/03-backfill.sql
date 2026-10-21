-- 确认 02-preview.sql 的预览后执行；建议暂停两边新提交直至新版 API 部署完成。
-- 只修正来源标记，包含软删历史，保留状态、图片、视频、扣费与关联。可重复执行。
SELECT DATABASE() AS target_database;
START TRANSACTION;

UPDATE GenerationTask t
JOIN ImageProject p ON p.id = t.projectId
SET t.source = 'vidflowos'
WHERE p.source = 'vidflowos' AND t.source <> 'vidflowos';
SELECT ROW_COUNT() AS updated_tasks;

UPDATE GeneratedImage i
JOIN GenerationTask t ON t.id = i.taskId
JOIN ImageProject p ON p.id = t.projectId
SET i.source = 'vidflowos'
WHERE (p.source = 'vidflowos' OR t.source = 'vidflowos')
  AND i.source <> 'vidflowos';
SELECT ROW_COUNT() AS updated_images;

UPDATE ImageGenJob j
JOIN GenerationTask t ON t.sourceJobId = j.id OR t.id = j.taskId
JOIN ImageProject p ON p.id = t.projectId
SET j.source = 'vidflowos'
WHERE j.userId = t.userId
  AND (p.source = 'vidflowos' OR t.source = 'vidflowos')
  AND j.source <> 'vidflowos';
SELECT ROW_COUNT() AS updated_jobs;

-- 视频任务沿用已有 source 字段，仅按已确认的项目来源补齐。
UPDATE VideoTask t
JOIN VideoProject p ON p.id = t.projectId
SET t.source = 'vidflowos'
WHERE p.source = 'vidflowos' AND t.source <> 'vidflowos';
SELECT ROW_COUNT() AS updated_video_tasks;

COMMIT;
