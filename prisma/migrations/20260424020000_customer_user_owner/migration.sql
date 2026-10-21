-- Customer 所有者归属：userId 引用 User.id
-- 步骤：先加 NULL 列，回填所有存量行为 userId=2，再改为 NOT NULL 并加外键/索引。

-- 1. 加列（允许 NULL，便于回填）
ALTER TABLE `Customer` ADD COLUMN `userId` INT NULL;

-- 2. 回填存量数据给 id=2 的用户
UPDATE `Customer` SET `userId` = 2 WHERE `userId` IS NULL;

-- 3. 改为 NOT NULL
ALTER TABLE `Customer` MODIFY COLUMN `userId` INT NOT NULL;

-- 4. 外键 + 索引
CREATE INDEX `Customer_userId_idx` ON `Customer`(`userId`);
ALTER TABLE `Customer`
  ADD CONSTRAINT `Customer_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
