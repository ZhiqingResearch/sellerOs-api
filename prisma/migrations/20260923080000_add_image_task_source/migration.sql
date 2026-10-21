-- 图片任务来源：platform 本平台 / vidflowos VidFlowOS 代办（对账/取消按此选网关 Key；列表默认过滤）
ALTER TABLE `GenerationTask` ADD COLUMN `source` VARCHAR(20) NOT NULL DEFAULT 'platform';
ALTER TABLE `GeneratedImage` ADD COLUMN `source` VARCHAR(20) NOT NULL DEFAULT 'platform';
ALTER TABLE `ImageProject` ADD COLUMN `source` VARCHAR(20) NOT NULL DEFAULT 'platform';
