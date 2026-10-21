-- 图片创作模板库：ImageTemplate（个人/系统模板）+ ImageTemplateItem（图片条目）

CREATE TABLE `ImageTemplate` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `isSystem` BOOLEAN NOT NULL DEFAULT false,
    `name` VARCHAR(200) NOT NULL,
    `groupName` VARCHAR(50) NULL,
    `tags` JSON NULL,
    `note` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,
    INDEX `ImageTemplate_isSystem_deletedAt_idx`(`isSystem`, `deletedAt`),
    INDEX `ImageTemplate_userId_deletedAt_idx`(`userId`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ImageTemplateItem` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `templateId` INTEGER NOT NULL,
    `name` VARCHAR(100) NOT NULL DEFAULT '默认',
    `prompt` TEXT NOT NULL,
    `refImageUrl` VARCHAR(1000) NULL,
    `aspectRatio` VARCHAR(20) NULL,
    `textAmount` VARCHAR(20) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `ImageTemplateItem_templateId_sortOrder_idx`(`templateId`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ImageTemplate` ADD CONSTRAINT `ImageTemplate_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ImageTemplateItem` ADD CONSTRAINT `ImageTemplateItem_templateId_fkey`
    FOREIGN KEY (`templateId`) REFERENCES `ImageTemplate`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
