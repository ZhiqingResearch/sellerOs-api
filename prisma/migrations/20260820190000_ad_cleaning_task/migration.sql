-- 创建广告清洗任务表
-- 仅保存广告清洗任务元数据和清洗结果 URL，不保存原始或清洗后的逐行广告数据。
CREATE TABLE `AdCleaningTask` (
    `id` INTEGER NOT NULL AUTO_INCREMENT COMMENT '数据库自增主键，仅供内部关联使用',
    `taskId` VARCHAR(36) NOT NULL COMMENT '对外暴露的任务UUID',
    `userId` INTEGER NOT NULL COMMENT '创建任务的用户ID，从JWT获取',
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED') NOT NULL DEFAULT 'PENDING' COMMENT '任务状态：等待、处理中、成功、失败',
    `progress` INTEGER NOT NULL DEFAULT 0 COMMENT '前端展示进度，范围0到100',
    `stage` VARCHAR(100) NOT NULL DEFAULT '等待处理' COMMENT '当前处理阶段或简短状态说明',
    `originalFilename` VARCHAR(500) NOT NULL COMMENT '用户上传的原始文件名',
    `resultFileUrl` VARCHAR(1000) NULL COMMENT '清洗结果上传到文件服务器后返回的稳定URL',
    `errorMessage` TEXT NULL COMMENT '失败原因，成功任务为空',
    `startedAt` DATETIME(3) NULL COMMENT 'Worker实际开始处理时间',
    `completedAt` DATETIME(3) NULL COMMENT '成功或失败的完成时间',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '任务创建时间',
    `updatedAt` DATETIME(3) NOT NULL COMMENT '任务最后更新时间',

    UNIQUE INDEX `AdCleaningTask_taskId_key`(`taskId`),
    INDEX `AdCleaningTask_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `AdCleaningTask_userId_status_idx`(`userId`, `status`),
    INDEX `AdCleaningTask_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_ad_cleaning_progress` CHECK (`progress` BETWEEN 0 AND 100)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT='广告数据清洗任务，只保存任务状态和最终文件URL';

-- 添加清洗任务与用户之间的外键
-- 清洗任务归属用户；存在任务记录时禁止物理删除用户。
ALTER TABLE `AdCleaningTask` ADD CONSTRAINT `AdCleaningTask_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
