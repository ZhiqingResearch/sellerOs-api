-- ImagePromptTemplate：图片创作内置提示词管理
CREATE TABLE `ImagePromptTemplate` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `dimension` VARCHAR(50) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `prompt` TEXT NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ImagePromptTemplate_dimension_name_key`(`dimension`, `name`),
    INDEX `ImagePromptTemplate_dimension_enabled_sortOrder_idx`(`dimension`, `enabled`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
