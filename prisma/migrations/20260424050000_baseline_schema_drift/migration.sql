-- 追认历史 schema drift：User.modelUnlocked
--
-- 该列是通过 prisma db push 加到 schema.prisma 并落 DB 的，没有生成对应 migration。
-- 对已有此列的 dev/prod：通过 `prisma migrate resolve --applied 20260424050000_baseline_schema_drift`
-- 标记为已应用（跳过执行）。
-- 对全新 DB（本地 docker / CI）：这条 migration 会正常执行，把列加上。
--
-- 关于 Avatar/Voice 的 FK 自动索引（Avatar_customerId_fkey / Voice_customerId_fkey）：
-- 不需要单独 migration —— 它们是 20260410025304_auto_migration 里 FK 创建时 MySQL 自动生成的，
-- schema.prisma 里用 `@@index([customerId], map: "Avatar_customerId_fkey")` 追认即可，
-- 所有环境（含 fresh DB）在执行 FK migration 时都会自动有这个同名索引，shadow DB 校验也能通过。

ALTER TABLE `User`
  ADD COLUMN `modelUnlocked` BOOLEAN NOT NULL DEFAULT false;
