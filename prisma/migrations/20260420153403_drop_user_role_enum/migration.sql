-- ============================================================
-- Stage 2: 删除 User.role 枚举字段，把 roleId 改为 NOT NULL + FK
--
-- 设计要点：迁移自备回填逻辑，不依赖外部 seed 步骤。任何环境部署
-- 时，本迁移保证 user.roleId 从 legacy user.role 枚举值派生出有效
-- 值，再收紧 NOT NULL 约束。
-- ============================================================

-- 1. 确保 ADMIN / USER 两个内置角色存在（幂等，不覆盖已有描述）
INSERT INTO `Role` (`code`, `name`, `description`, `isSystem`, `createdAt`, `updatedAt`)
  VALUES ('ADMIN', '管理员', '系统管理员（内置），拥有全部权限', 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
  ON DUPLICATE KEY UPDATE `code` = `code`;

INSERT INTO `Role` (`code`, `name`, `description`, `isSystem`, `createdAt`, `updatedAt`)
  VALUES ('USER', '普通用户', '普通用户（内置），拥有全部权限', 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
  ON DUPLICATE KEY UPDATE `code` = `code`;

-- 2. 回填 user.roleId（只更新 roleId IS NULL 的行，与 legacy enum 值对齐）
UPDATE `User` u
  JOIN `Role` r ON u.`role` = r.`code`
  SET u.`roleId` = r.`id`
  WHERE u.`roleId` IS NULL;

-- 3. 断旧 FK（之前是 ON DELETE SET NULL，改 NOT NULL 前必须先断）
ALTER TABLE `User` DROP FOREIGN KEY `User_roleId_fkey`;

-- 4. roleId 收紧 NOT NULL + 删 legacy role 枚举列
ALTER TABLE `User` MODIFY COLUMN `roleId` INTEGER NOT NULL;
ALTER TABLE `User` DROP COLUMN `role`;

-- 5. 新 FK：ON DELETE RESTRICT（与 Prisma 默认对齐）
ALTER TABLE `User` ADD CONSTRAINT `User_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
