-- 形象/音色补充性别字段，音色补充试听文本字段

ALTER TABLE `Avatar`
  ADD COLUMN `gender` VARCHAR(191) NOT NULL DEFAULT 'FEMALE';

ALTER TABLE `Voice`
  ADD COLUMN `gender` VARCHAR(191) NOT NULL DEFAULT 'female',
  ADD COLUMN `exampleText` VARCHAR(200) NULL;
