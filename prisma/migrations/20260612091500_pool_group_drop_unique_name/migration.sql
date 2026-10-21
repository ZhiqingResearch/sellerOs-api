-- PoolGroup 同名唯一改为普通索引：唯一性交给 service 层（尊重软删，删除后分组名可复用）。
-- 先建新索引再删旧唯一索引，外键 PoolGroup_userId_fkey 自动落到新索引（均以 userId 开头），无需动外键。

-- CreateIndex
CREATE INDEX `PoolGroup_userId_name_idx` ON `PoolGroup`(`userId`, `name`);

-- DropIndex
DROP INDEX `PoolGroup_userId_name_key` ON `PoolGroup`;
