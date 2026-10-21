-- 项目发布信息：发布时 publishedAt / publishUrl 会被回写

ALTER TABLE `Project`
  ADD COLUMN `publishedAt` DATETIME(3) NULL,
  ADD COLUMN `publishUrl` VARCHAR(1000) NULL;
