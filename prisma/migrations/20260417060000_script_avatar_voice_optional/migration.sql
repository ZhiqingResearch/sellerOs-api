-- Make Script.avatarId and voiceId nullable so drafts can be saved before picking avatar/voice

ALTER TABLE `Script` DROP FOREIGN KEY `Script_avatarId_fkey`;
ALTER TABLE `Script` DROP FOREIGN KEY `Script_voiceId_fkey`;

ALTER TABLE `Script` MODIFY COLUMN `avatarId` INT NULL;
ALTER TABLE `Script` MODIFY COLUMN `voiceId` INT NULL;

ALTER TABLE `Script` ADD CONSTRAINT `Script_avatarId_fkey` FOREIGN KEY (`avatarId`) REFERENCES `Avatar`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `Script` ADD CONSTRAINT `Script_voiceId_fkey` FOREIGN KEY (`voiceId`) REFERENCES `Voice`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
