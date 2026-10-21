-- 模板图片条目：prompt 改为选填（允许 NULL）
ALTER TABLE `ImageTemplateItem`
  MODIFY COLUMN `prompt` TEXT NULL;
