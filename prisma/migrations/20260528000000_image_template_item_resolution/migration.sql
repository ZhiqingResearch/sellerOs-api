-- 模板图片条目新增分辨率分字段（便于生图任务信息统一）
ALTER TABLE `ImageTemplateItem`
  ADD COLUMN `resolutionTier` VARCHAR(20) NULL,
  ADD COLUMN `customAspectW` INTEGER NULL,
  ADD COLUMN `customAspectH` INTEGER NULL,
  ADD COLUMN `customSizeMode` VARCHAR(20) NULL;
