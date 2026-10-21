-- 模板库分组：升级为统一外键关联（系统分组 + 个人分组，ImageTemplate.groupId 外键）

-- 1) 分组表支持系统分组：新增 isSystem，userId 改为可空（系统分组 userId=null）
ALTER TABLE `ImageTemplateGroup`
  ADD COLUMN `isSystem` BOOLEAN NOT NULL DEFAULT false,
  MODIFY COLUMN `userId` INTEGER NULL;

-- 2) 把系统模板用到的分组登记为系统分组行
INSERT INTO `ImageTemplateGroup` (`userId`, `isSystem`, `name`, `updatedAt`)
SELECT NULL, 1, `groupName`, NOW(3)
FROM `ImageTemplate`
WHERE `isSystem` = 1
  AND `deletedAt` IS NULL
  AND `groupName` IS NOT NULL
  AND `groupName` <> ''
GROUP BY `groupName`;

-- 3) ImageTemplate 增加 groupId 并按 (归属, 分组名) 回填
ALTER TABLE `ImageTemplate` ADD COLUMN `groupId` INTEGER NULL;

UPDATE `ImageTemplate` t
JOIN `ImageTemplateGroup` g
  ON g.`isSystem` = 0 AND g.`userId` = t.`userId` AND g.`name` = t.`groupName`
SET t.`groupId` = g.`id`
WHERE t.`isSystem` = 0 AND t.`groupName` IS NOT NULL;

UPDATE `ImageTemplate` t
JOIN `ImageTemplateGroup` g
  ON g.`isSystem` = 1 AND g.`name` = t.`groupName`
SET t.`groupId` = g.`id`
WHERE t.`isSystem` = 1 AND t.`groupName` IS NOT NULL;

-- 4) 去掉冗余的 groupName 字符串，分组名改由 ImageTemplateGroup 单一持有
ALTER TABLE `ImageTemplate` DROP COLUMN `groupName`;

-- 5) 外键：删除分组时把残留引用置空（删除流程会先软删模板并置空 groupId）
CREATE INDEX `ImageTemplate_groupId_idx` ON `ImageTemplate`(`groupId`);

ALTER TABLE `ImageTemplate` ADD CONSTRAINT `ImageTemplate_groupId_fkey`
  FOREIGN KEY (`groupId`) REFERENCES `ImageTemplateGroup`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
