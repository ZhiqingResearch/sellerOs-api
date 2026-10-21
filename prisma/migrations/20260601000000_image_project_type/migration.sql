-- 图片创作项目/任务区分创作类型：通用创作(GENERAL) / 电商创作(ECOMMERCE)
-- 现有图片创作即电商创作，故默认值与存量数据均为 ECOMMERCE

-- 项目：新增 type，默认 ECOMMERCE（存量数据视为电商创作）
ALTER TABLE `ImageProject`
  ADD COLUMN `type` VARCHAR(20) NOT NULL DEFAULT 'ECOMMERCE';

CREATE INDEX `ImageProject_userId_type_idx` ON `ImageProject`(`userId`, `type`);

-- 任务：新增 type，建任务时从所属项目继承；存量任务按其项目类型回填
ALTER TABLE `GenerationTask`
  ADD COLUMN `type` VARCHAR(20) NOT NULL DEFAULT 'ECOMMERCE';

UPDATE `GenerationTask` t
JOIN `ImageProject` p ON p.`id` = t.`projectId`
SET t.`type` = p.`type`;

CREATE INDEX `GenerationTask_userId_type_createdAt_idx` ON `GenerationTask`(`userId`, `type`, `createdAt`);
