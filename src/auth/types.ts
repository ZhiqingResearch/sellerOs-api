export interface AuthenticatedUser {
  id: number
  phone: string
  roleCode: string | null
  /** 当前组织 id（切换组织时重签 token 写入；无则为 null）。供后续按组织隔离数据用 */
  currentOrgId: number | null
}
