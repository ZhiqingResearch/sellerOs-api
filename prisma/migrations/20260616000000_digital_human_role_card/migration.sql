-- AlterTable: 数字人新增 roleCard（AI 角色卡专属 7 段文本 + 提炼标签；手动数字人为 null）
ALTER TABLE `DigitalHuman` ADD COLUMN `roleCard` JSON NULL;
