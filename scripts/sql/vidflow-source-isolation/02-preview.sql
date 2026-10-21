-- 只读预览：以已标记 source=vidflowos 的项目/任务为证据，不按项目名称猜测。
SELECT DATABASE() AS target_database;

SELECT p.id, p.userId, p.name, p.type, p.deletedAt,
       COUNT(t.id) AS task_count
FROM ImageProject p
LEFT JOIN GenerationTask t ON t.projectId = p.id
WHERE p.source = 'vidflowos'
GROUP BY p.id, p.userId, p.name, p.type, p.deletedAt
ORDER BY p.id;

SELECT COUNT(*) AS tasks_to_backfill
FROM GenerationTask t
JOIN ImageProject p ON p.id = t.projectId
WHERE p.source = 'vidflowos' AND t.source <> 'vidflowos';

SELECT COUNT(*) AS images_to_backfill
FROM GeneratedImage i
JOIN GenerationTask t ON t.id = i.taskId
JOIN ImageProject p ON p.id = t.projectId
WHERE (p.source = 'vidflowos' OR t.source = 'vidflowos')
  AND i.source <> 'vidflowos';

SELECT DISTINCT j.id, j.userId, j.taskId, j.source, j.createdAt
FROM ImageGenJob j
JOIN GenerationTask t ON t.sourceJobId = j.id OR t.id = j.taskId
JOIN ImageProject p ON p.id = t.projectId
WHERE j.userId = t.userId
  AND (p.source = 'vidflowos' OR t.source = 'vidflowos')
  AND j.source <> 'vidflowos'
ORDER BY j.createdAt;

-- 未归档的旧 Job 没有可靠的系统来源标记，以下仅列出待核对候选，不会自动回填。
-- 同一用户可能在两个系统都创建过内容，不能批量按 userId 判定。
SELECT j.id, j.userId, j.kind, j.status, j.createdAt
FROM ImageGenJob j
WHERE j.source = 'platform' AND j.kind = 'IMAGE_TO_IMAGE'
  AND j.taskId IS NULL
  AND NOT EXISTS (SELECT 1 FROM GenerationTask t WHERE t.sourceJobId = j.id)
  AND EXISTS (
    SELECT 1 FROM ImageProject p WHERE p.userId = j.userId AND p.source = 'vidflowos'
  )
ORDER BY j.createdAt;

-- 视频来源已有字段，无需新增列；预览已确认 VidFlow 容器项目下的历史任务。
SELECT p.id, p.userId, p.name, p.type, p.deletedAt,
       COUNT(t.id) AS task_count
FROM VideoProject p
LEFT JOIN VideoTask t ON t.projectId = p.id
WHERE p.source = 'vidflowos'
GROUP BY p.id, p.userId, p.name, p.type, p.deletedAt
ORDER BY p.id;

SELECT COUNT(*) AS video_tasks_to_backfill
FROM VideoTask t
JOIN VideoProject p ON p.id = t.projectId
WHERE p.source = 'vidflowos' AND t.source <> 'vidflowos';
