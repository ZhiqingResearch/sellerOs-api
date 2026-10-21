export interface PermissionSeed {
  key: string
  label: string
  groupCode: "tools" | "management" | "agents" | "company"
  parentKey: string | null
  route: string | null
  subRoutes: string[] | null
  sortOrder: number
}

/** 内置菜单/权限分组（code 创建后不可改；isBuiltin 组不可删除；后续新分组走管理接口） */
export const PERMISSION_GROUPS: { code: string; label: string; sortOrder: number }[] = [
  { code: "tools", label: "工具", sortOrder: 1 },
  { code: "management", label: "管理", sortOrder: 2 },
  { code: "agents", label: "智能体", sortOrder: 3 },
  { code: "company", label: "企业", sortOrder: 4 },
]

export const PERMISSIONS: PermissionSeed[] = [
  { key: "tool.market_research", label: "市场前调", groupCode: "tools", parentKey: null, route: null, subRoutes: null, sortOrder: 0 },
  { key: "tool.category_analysis", label: "类目分析", groupCode: "tools", parentKey: "tool.market_research", route: "/category-analysis", subRoutes: ["/selection-analysis-records"], sortOrder: 0 },
  // ===== tools =====
  {
    key: "tool.listing_generate",
    label: "Listing 生成",
    groupCode: "tools",
    parentKey: null,
    route: "/listing",
    subRoutes: null,
    sortOrder: 1,
  },
  {
    key: "tool.listing_score",
    label: "Listing 打分",
    groupCode: "tools",
    parentKey: null,
    route: "/listing-score",
    subRoutes: null,
    sortOrder: 2,
  },
  {
    key: "tool.product_score",
    label: "选品打分",
    groupCode: "tools",
    parentKey: null,
    route: "/score",
    subRoutes: null,
    sortOrder: 3,
  },
  {
    key: "tool.flow_workbench",
    label: "选品工作台",
    groupCode: "tools",
    parentKey: null,
    route: "/flow",
    subRoutes: null,
    sortOrder: 4,
  },
  {
    key: "tool.product_factory",
    label: "AI商品工厂",
    groupCode: "tools",
    parentKey: null,
    route: "/product-factory",
    subRoutes: ["/product-factory/[recordId]"],
    sortOrder: 5,
  },
  {
    key: "tool.promotion_plan",
    label: "新品推广计划",
    groupCode: "tools",
    parentKey: null,
    route: "/promotion-plan",
    subRoutes: [],
    // 与 AI商品工厂 同序（并列时按 seed 顺序紧随其后）
    sortOrder: 5,
  },
  {
    key: "tool.smart_pricing",
    label: "商品智能定价",
    groupCode: "tools",
    parentKey: null,
    route: "/smart-pricing",
    subRoutes: [],
    sortOrder: 6,
  },
  {
    key: "tool.digital_human_video",
    label: "数字人视频",
    groupCode: "tools",
    parentKey: null,
    route: "/digital-human-video",
    subRoutes: ["/digital-human-video/[id]"],
    sortOrder: 50,
  },
  {
    key: "tool.ai_chat",
    label: "AI 问一问",
    groupCode: "tools",
    parentKey: null,
    route: "/ai-chat",
    subRoutes: null,
    sortOrder: 7,
  },
  {
    key: "tool.consumer_lab",
    label: "AI 消费者实验室",
    groupCode: "tools",
    parentKey: null,
    route: "/consumer-lab",
    subRoutes: [],
    sortOrder: 6,
  },
  // {
  //   key: "tool.ai_creative_studio",
  //   label: "图片创作",
  //   groupCode: "tools",
  //   parentKey: null,
  //   route: "/image-creation",
  //   subRoutes: [],
  //   sortOrder: 8,
  // },
  {
    key: "tool.ai_creative_studio",
    label: "图片创作",
    groupCode: "tools",
    parentKey: null,
    route: null,
    subRoutes: [],
    sortOrder: 7,
  },
  {
    key: "tool.ai_creative_studio.general",
    label: "通用创作",
    groupCode: "tools",
    parentKey: "tool.ai_creative_studio",
    route: "/image-creation",
    subRoutes: [],
    sortOrder: 1,
  },
  {
    key: "tool.ai_creative_studio.ecommerce",
    label: "电商创作",
    groupCode: "tools",
    parentKey: "tool.ai_creative_studio",
    route: "/ecommerce-creation",
    subRoutes: [],
    sortOrder: 2,
  },
  {
    key: "tool.ai_creative_studio.image_processing",
    label: "图像处理",
    groupCode: "tools",
    parentKey: "tool.ai_creative_studio",
    route: "/image-processing",
    subRoutes: [],
    sortOrder: 3,
  },
  {
    key: "tool.video_creation",
    label: "视频创作",
    groupCode: "tools",
    parentKey: null,
    route: null,
    subRoutes: [],
    sortOrder: 70,
  },
  {
    key: "tool.video_creation.general",
    label: "通用创作",
    groupCode: "tools",
    parentKey: "tool.video_creation",
    route: "/video-creation",
    subRoutes: [],
    sortOrder: 71,
  },
  // {
  //   key: "tool.image_processing",
  //   label: "图像处理",
  //   groupCode: "tools",
  //   parentKey: null,
  //   route: "/image-processing",
  //   subRoutes: [],
  //   sortOrder: 9,
  // },
  {
    key: "tool.template_library",
    label: "模版库",
    groupCode: "tools",
    parentKey: null,
    route: "/template-library",
    subRoutes: [],
    sortOrder: 10,
  },
  // {
  //   key: "tool.ai_creative_studio",
  //   label: "AI 创作平台",
  //   groupCode: "tools",
  //   parentKey: null,
  //   route: "/ai-creative",
  //   subRoutes: ["/ai-creative/product-image", "/ai-creative/image-to-image"],
  //   sortOrder: 60,
  // },

  // ===== management =====
  {
    key: "management.product",
    label: "产品管理",
    groupCode: "management",
    parentKey: null,
    route: null,
    subRoutes: null,
    sortOrder: 10,
  },
  {
    key: "management.product.reports",
    label: "产品分析报告",
    groupCode: "management",
    parentKey: "management.product",
    route: "/product-reports",
    subRoutes: null,
    sortOrder: 11,
  },
  {
    key: "management.product.listing_records",
    label: "Listing 生成记录",
    groupCode: "management",
    parentKey: "management.product",
    route: "/listing-records",
    subRoutes: null,
    sortOrder: 12,
  },
  {
    // key 故意不挂在 management.product.* 下，避免被 PermissionsGuard 的「父级隐含子级」
    // 逻辑误带入：OPS_SPECIALIST / OPS_SPECIALIST_EXTERNAL 持有 management.product（菜单容器），
    // 会自动获得所有 management.product.* 子权限。这里降到 management.* 直系，
    // 只有 matcher 全开的 ADMIN/USER 能匹中。前端菜单仍可通过 parentKey 渲染在「产品管理」组下。
    key: "management.sensitive_words",
    label: "敏感词提示库",
    groupCode: "management",
    parentKey: "management.product",
    route: "/sensitive-words",
    subRoutes: null,
    sortOrder: 14,
  },
  {
    key: "management.customers",
    label: "客户管理",
    groupCode: "management",
    parentKey: null,
    route: "/customers",
    subRoutes: ["/customers/[id]"],
    sortOrder: 13,
  },
  {
    key: "management.users",
    label: "用户管理",
    groupCode: "management",
    parentKey: null,
    route: "/users",
    subRoutes: null,
    sortOrder: 15,
  },
  {
    key: "management.roles",
    label: "角色管理",
    groupCode: "management",
    parentKey: null,
    route: "/roles",
    subRoutes: null,
    sortOrder: 16,
  },
  {
    key: "management.usage",
    label: "用量看板",
    groupCode: "management",
    parentKey: null,
    route: "/usage-dashboard",
    subRoutes: [],
    sortOrder: 130,
  },
  {
    // 后台分销管理（关系树 + 全局返利规则 + 导出）。C1（2026-08-30）已定：落在客户运营页
    // 第三个 tab，故 route 指向 /customer-operations；接口仍走 management.users 权限点（不变），
    // 本键只解决「侧栏菜单下发」。parentKey 不用前端建议的 management.user_permission——该键不存在，
    // 与 management.users/roles 一样平铺顶级。label 如需显示「客户运营」可在管理端改。
    key: "management.distribution",
    label: "分销管理",
    groupCode: "management",
    parentKey: null,
    route: "/customer-operations",
    subRoutes: null,
    sortOrder: 17,
  },
  {
    // C 端「邀请/分销」独立页（P8，面向分销代理本人）；前端页面已落地 /distribution（2026-08-30）
    key: "tool.distribution",
    label: "邀请分销",
    groupCode: "tools",
    parentKey: null,
    route: "/distribution",
    subRoutes: null,
    sortOrder: 11,
  },
  {
    key: "management.prompt_library",
    label: "内置提示词管理",
    groupCode: "management",
    parentKey: null,
    route: "/prompt-library",
    subRoutes: [],
    sortOrder: 10,
  },
  {
    key: "tool.ai_creative_studio.chetaidou",
    label: "车泰斗素材工作台",
    groupCode: "tools",
    parentKey: "tool.ai_creative_studio",
    route: "/chetaidou",
    subRoutes: [],
    sortOrder: 12,
  },
  {
    key: "management.chetaidou",
    label: "车泰斗资料维护",
    groupCode: "management",
    parentKey: null,
    route: "/chetaidou-admin",
    subRoutes: [],
    sortOrder: 11,
  },
  {
    key: "tool.clothes_edit",
    label: "一键换肤",
    groupCode: "tools",
    parentKey: null,
    route: "",
    subRoutes: [],
    sortOrder: 10000,
  },

  // ===== agents =====
  {
    key: "agent.category_analyst",
    label: "类目分析师",
    groupCode: "agents",
    parentKey: null,
    route: null,
    subRoutes: null,
    sortOrder: 20,
  },
  {
    key: "agent.competitor",
    label: "竞品分析师",
    groupCode: "agents",
    parentKey: null,
    route: null,
    subRoutes: null,
    sortOrder: 21,
  },
  {
    key: "agent.ad_analyst",
    label: "广告分析师",
    groupCode: "agents",
    parentKey: null,
    route: null,
    subRoutes: null,
    sortOrder: 22,
  },
  {
    key: "agent.product_analyst",
    label: "单品分析师",
    groupCode: "agents",
    parentKey: null,
    route: null,
    subRoutes: null,
    sortOrder: 23,
  },
  {
    key: "agent.review_miner",
    label: "Review 挖掘师",
    groupCode: "agents",
    parentKey: null,
    route: null,
    subRoutes: null,
    sortOrder: 24,
  },
  {
    key: "agent.listing_writer",
    label: "Listing 写手",
    groupCode: "agents",
    parentKey: null,
    route: null,
    subRoutes: null,
    sortOrder: 25,
  },
  {
    key: "agent.listing_scorer",
    label: "Listing 评分师",
    groupCode: "agents",
    parentKey: null,
    route: null,
    subRoutes: null,
    sortOrder: 26,
  },
  {
    key: "agent.pricing",
    label: "定价优化师",
    groupCode: "agents",
    parentKey: null,
    route: null,
    subRoutes: null,
    sortOrder: 27,
  },
  {
    key: "agent.ad_optimizer",
    label: "广告优化师",
    groupCode: "agents",
    parentKey: null,
    route: null,
    subRoutes: null,
    sortOrder: 28,
  },
  {
    key: "agent.supply_chain",
    label: "供应链顾问",
    groupCode: "agents",
    parentKey: null,
    route: null,
    subRoutes: null,
    sortOrder: 29,
  },
  {
    key: "agent.social_media",
    label: "社媒运营员",
    groupCode: "agents",
    parentKey: null,
    route: "/agents/social_media",
    subRoutes: null,
    sortOrder: 110,
  },

  // ===== company =====
  {
    key: "company.org",
    label: "组织架构",
    groupCode: "company",
    parentKey: null,
    route: "/org",
    subRoutes: null,
    sortOrder: 90,
  },
  {
    key: "company.admin",
    label: "后台管理",
    groupCode: "company",
    parentKey: null,
    route: null,
    subRoutes: null,
    sortOrder: 91,
  },
]

/**
 * 角色权限匹配入参：来自数据库的权限行（而非 PERMISSIONS 种子数组）。
 * 这样匹配范围天然覆盖管理端运行时新增的菜单/权限，key + 分组足以做匹配。
 */
export interface RoleMatcherInput {
  key: string
  groupCode: string
}

export interface RoleDefinition {
  code: string
  name: string
  description: string
  color?: string
  isSystem: boolean
  matcher: (p: RoleMatcherInput) => boolean
}

/**
 * 内置角色只剩「超级管理员」一个：拥有全部权限、不可在管理端修改/删除。
 * 其余业务角色一律改由用户/角色管理界面创建（isSystem=false），不再 seed。
 */
export const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    code: "ADMIN",
    name: "超级管理员",
    description: "系统超级管理员（内置），拥有全部权限，不可修改或删除",
    color: "#ff3b30",
    isSystem: true,
    matcher: () => true,
  },
]
