-- 在 SellerOS 对应的数据库执行。重复执行安全；不删除数据。
-- 先执行本文件，再执行 02-preview.sql 和 03-backfill.sql，最后部署新版 API。
SELECT DATABASE() AS target_database;

SET @vidflow_source_ddl = IF(
  EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ImageGenJob' AND COLUMN_NAME = 'source'
  ),
  'SELECT ''ImageGenJob.source already exists'' AS result',
  'ALTER TABLE `ImageGenJob` ADD COLUMN `source` VARCHAR(20) NOT NULL DEFAULT ''platform'''
);
PREPARE vidflow_source_statement FROM @vidflow_source_ddl;
EXECUTE vidflow_source_statement;
DEALLOCATE PREPARE vidflow_source_statement;
