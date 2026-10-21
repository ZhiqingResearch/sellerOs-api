import { PrismaClient } from "@prisma/client"

// Skill 市场技能目录（种子）：skillId 是前后端稳定业务 ID，必须与联调文档 / 前端固定数据一致。
// 改这里后跑 `npx tsx prisma/seed.ts skill-market`。
// upsert 的 update 分支只刷 name/category/fileUrl，不覆盖 status（运营下架不被 seed 冲掉）和计数。
// 正文存 Spaces 共用桶 erp-pro（public-read 直链，下载文件名烧入对象 Content-Disposition 元数据），
// DB 存完整公开 URL；仓库不保留源文件副本，需要重传时从清洗版归档（本地 skills.zip）取。

export interface SkillMarketSkillSeed {
  skillId: string
  name: string
  category: string
  /** 历史源文件名（含中文名），文档化下载文件名约定：<skill_id>-<中文名去空格>.md */
  fileName: string
}

export const SKILL_MARKET_SKILLS: SkillMarketSkillSeed[] = [
  // ── 选品与市场 ──
  {
    skillId: "trending",
    name: "趋势品发现",
    category: "选品与市场",
    fileName: "trending-趋势品发现.md",
  },
  {
    skillId: "sales-est",
    name: "销量与市场容量估算",
    category: "选品与市场",
    fileName: "sales-est-销量与市场容量估算.md",
  },
  {
    skillId: "seller-scan",
    name: "卖家店铺透视",
    category: "选品与市场",
    fileName: "seller-scan-卖家店铺透视.md",
  },
  {
    skillId: "aba-insight",
    name: "ABA 品牌分析洞察",
    category: "选品与市场",
    fileName: "aba-insight-ABA品牌分析洞察.md",
  },
  {
    skillId: "global-expand",
    name: "多站点扩张规划",
    category: "选品与市场",
    fileName: "global-expand-多站点扩张规划.md",
  },
  // ── Listing 与内容 ──
  {
    skillId: "listing-opt",
    name: "Listing 生成与八维体检",
    category: "Listing 与内容",
    fileName: "listing-opt-Listing生成与八维体检.md",
  },
  {
    skillId: "aplus",
    name: "A+ 内容规划",
    category: "Listing 与内容",
    fileName: "aplus-A+内容规划.md",
  },
  {
    skillId: "main-images",
    name: "主图与副图规划",
    category: "Listing 与内容",
    fileName: "main-images-主图与副图规划.md",
  },
  {
    skillId: "photo-plan",
    name: "产品摄影方案",
    category: "Listing 与内容",
    fileName: "photo-plan-产品摄影方案.md",
  },
  {
    skillId: "backend-kw",
    name: "后台关键词优化",
    category: "Listing 与内容",
    fileName: "backend-kw-后台关键词优化.md",
  },
  {
    skillId: "a9-seo",
    name: "A9 搜索排名优化",
    category: "Listing 与内容",
    fileName: "a9-seo-A9搜索排名优化.md",
  },
  // ── 广告与流量 ──
  {
    skillId: "ppc-build",
    name: "PPC 活动搭建与优化",
    category: "广告与流量",
    fileName: "ppc-build-PPC活动搭建与优化.md",
  },
  {
    skillId: "sd-ads",
    name: "SD 展示型推广",
    category: "广告与流量",
    fileName: "sd-ads-SD展示型推广.md",
  },
  {
    skillId: "ad-portfolio",
    name: "广告策略与预算分配",
    category: "广告与流量",
    fileName: "ad-portfolio-广告策略与预算分配.md",
  },
  {
    skillId: "neg-kw",
    name: "否定关键词挖掘",
    category: "广告与流量",
    fileName: "neg-kw-否定关键词挖掘.md",
  },
  {
    skillId: "kw-monitor",
    name: "关键词表现监控",
    category: "广告与流量",
    fileName: "kw-monitor-关键词表现监控.md",
  },
  // ── 定价与利润 ──
  {
    skillId: "buybox",
    name: "购物车赢得策略",
    category: "定价与利润",
    fileName: "buybox-购物车赢得策略.md",
  },
  {
    skillId: "profit-waterfall",
    name: "利润瀑布分析",
    category: "定价与利润",
    fileName: "profit-waterfall-利润瀑布分析.md",
  },
  {
    skillId: "price-watch",
    name: "竞品价格盯盘",
    category: "定价与利润",
    fileName: "price-watch-竞品价格盯盘.md",
  },
  {
    skillId: "deal-roi",
    name: "秒杀与促销 ROI",
    category: "定价与利润",
    fileName: "deal-roi-秒杀与促销ROI.md",
  },
  {
    skillId: "ship-calc",
    name: "配送与仓储成本测算",
    category: "定价与利润",
    fileName: "ship-calc-配送与仓储成本测算.md",
  },
  // ── 运营与节奏 ──
  {
    skillId: "fba-prep",
    name: "FBA 备货与发货计划",
    category: "运营与节奏",
    fileName: "fba-prep-FBA备货与发货计划.md",
  },
  {
    skillId: "rank-track",
    name: "排名追踪与增长复盘",
    category: "运营与节奏",
    fileName: "rank-track-排名追踪与增长复盘.md",
  },
]

// 公开直链根地址（= Spaces SPACES_BASE_URL）；对象 public-read，下载文件名烧在对象元数据里
export const SKILL_MARKET_PUBLIC_BASE = "https://erp-pro.nyc3.digitaloceanspaces.com"
const SKILL_MARKET_OBJECT_KEY_PREFIX = "skill-market/skills"

/** 技能正文公开直链（免鉴权可直接下载） */
export function skillMarketFileUrl(skillId: string): string {
  return `${SKILL_MARKET_PUBLIC_BASE}/${SKILL_MARKET_OBJECT_KEY_PREFIX}/${skillId}.md`
}

export async function seedSkillMarket(prisma: PrismaClient) {
  await prisma.$transaction(
    SKILL_MARKET_SKILLS.map(s =>
      prisma.skillMarketSkill.upsert({
        where: { skillId: s.skillId },
        update: {
          name: s.name,
          category: s.category,
          fileUrl: skillMarketFileUrl(s.skillId),
        },
        create: {
          skillId: s.skillId,
          name: s.name,
          category: s.category,
          fileUrl: skillMarketFileUrl(s.skillId),
          status: "ACTIVE",
        },
      })
    )
  )
  return { skills: SKILL_MARKET_SKILLS.length }
}
