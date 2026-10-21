-- 预览墙元信息与车泰斗成品操作：增量结构 SQL
-- 对应 prisma/schema.prisma，基于 release 4e47178。
-- 仅供本次升级手工同步结构；日常默认使用 npm run db:push，不执行 migrate。
-- 先选择目标业务数据库。依赖下列 8 张既有业务表。
-- 此文件的 ADD COLUMN 是一次性的：已通过 db:push 或本 SQL 加过列时不要再次执行。
-- 在同一连接执行，遇错停止，不使用 mysql --force；MySQL DDL 隐式提交。
-- 不修改/删除旧数据，不回填猜测值。新增 JSON 列对历史记录均为空。

ALTER TABLE `Script`
  ADD COLUMN `videoMeta` JSON NULL;

ALTER TABLE `StoryboardVideo`
  ADD COLUMN `generationMeta` JSON NULL;

ALTER TABLE `MaterialImageVariant`
  ADD COLUMN `generationMeta` JSON NULL;

ALTER TABLE `ImageTemplateItem`
  ADD COLUMN `sourceMeta` JSON NULL;

ALTER TABLE `VideoTask`
  ADD COLUMN `deliveryMeta` JSON NULL;

ALTER TABLE `RpaCreationOutput`
  ADD COLUMN `deliveryMeta` JSON NULL;

ALTER TABLE `BeautyTask`
  ADD COLUMN `deliveryMeta` JSON NULL;

ALTER TABLE `PoolImage`
  ADD COLUMN `sourceMeta` JSON NULL;

CREATE TABLE `ChetaidouResultImport` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `ownerId` INTEGER NOT NULL,
  `idempotencyKey` VARCHAR(36) NOT NULL,
  `action` VARCHAR(20) NOT NULL,
  `sourceResultId` INTEGER NOT NULL,
  `requestHash` CHAR(64) NOT NULL,
  `response` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `ChetaidouResultImport_ownerId_idempotencyKey_key` (`ownerId`, `idempotencyKey`),
  INDEX `ChetaidouResultImport_ownerId_sourceResultId_action_idx` (`ownerId`, `sourceResultId`, `action`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 同步完成后在应用环境执行 npx prisma generate && npm run build，再发布后端。
