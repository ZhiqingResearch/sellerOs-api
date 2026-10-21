-- 图片创作模板库：个人分组单独管理（ImageTemplateGroup 注册表）

CREATE TABLE `ImageTemplateGroup` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `name` VARCHAR(50) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `ImageTemplateGroup_userId_name_key`(`userId`, `name`),
    INDEX `ImageTemplateGroup_userId_sortOrder_idx`(`userId`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ImageTemplateGroup` ADD CONSTRAINT `ImageTemplateGroup_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 回填：把现有个人模板已用到的分组名登记为分组行（系统模板分组不纳入）
INSERT INTO `ImageTemplateGroup` (`userId`, `name`, `updatedAt`)
SELECT `userId`, `groupName`, NOW(3)
FROM `ImageTemplate`
WHERE `isSystem` = 0
  AND `deletedAt` IS NULL
  AND `groupName` IS NOT NULL
  AND `groupName` <> ''
GROUP BY `userId`, `groupName`;
