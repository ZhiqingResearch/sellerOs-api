import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common"
import { Prisma, SkillsKeyCredential } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { SkillsKeyOperationDto } from "./dto/skills-key.dto"
import { SKILLS_KEY_ISSUE_TIMEOUT_MS, SkillsKeyConfigService } from "./skills-key-config.service"
import { isValidKeyB, SkillsKeyCryptoService } from "./skills-key-crypto.service"
import { SkillsKeyIssueError, SkillsKeyIssuerService } from "./skills-key-issuer.service"

const RECOVERY_MESSAGE =
  "密钥签发结果待恢复，已暂停复制及扣费；请联系运维核对远端签发状态，勿自动重新签发"
const PROJECT_CHANGED_MESSAGE = "接入项目已变更，请主动重置密钥以使用当前项目"
export const KEY_ROTATION_STALE_MS = SKILLS_KEY_ISSUE_TIMEOUT_MS + 60_000
type OperationKind = "GENERATE" | "RESET"

@Injectable()
export class SkillsKeysService {
  private readonly logger = new Logger(SkillsKeysService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: SkillsKeyConfigService,
    private readonly crypto: SkillsKeyCryptoService,
    private readonly issuer: SkillsKeyIssuerService
  ) {}

  async status(userId: number, projectCode?: string) {
    return this.safe(async () => {
      const project = this.config.getProject(projectCode)
      await this.requireUser(userId)
      const row = await this.findCurrent(userId, project.code)
      if (!row) return { projectCode: project.code, status: "NOT_CREATED", maskedKey: null }
      return this.publicStatus(await this.markStale(row), project.projectId)
    })
  }

  async reveal(userId: number, projectCode: string) {
    return this.safe(async () => {
      const project = this.config.getProject(projectCode)
      await this.requireUser(userId)
      const row = await this.findCurrent(userId, project.code)
      if (!row) throw this.conflict("SKILLS_KEY_NOT_CREATED", "请先生成密钥")
      const current = await this.markStale(row)
      this.requireActive(current, project.projectId)
      return this.deliver(current)
    })
  }

  async generate(userId: number, dto: SkillsKeyOperationDto, reset = false) {
    return this.safe(async () => {
      const project = this.config.getProject(dto.projectCode)
      const user = await this.requireUser(userId)
      if (user.phone.length !== 11 || !/^1[3-9]\d{9}$/.test(user.phone)) {
        throw new BadRequestException({
          code: "SKILLS_PHONE_INVALID",
          message: "当前账号手机号不符合签发要求，请先联系管理员更正",
        })
      }
      const kind: OperationKind = reset ? "RESET" : "GENERATE"
      let row = await this.findCurrent(userId, project.code)
      if (row) {
        row = await this.markStale(row)
        const replay = this.checkOperation(row, dto.operationId, kind, project.projectId)
        if (replay) return this.deliver(row)
        // 明确重置按当前配置重新签发，旧项目只约束旧凭证的读取与使用。
        // 实际 ROTATING / SYNC_UNKNOWN 仍不可重签，operationId 检查也不能绕过。
        this.requireActive(row, reset ? row.externalProjectId : project.projectId)
        if (!reset) throw this.conflict("SKILLS_KEY_EXISTS", "密钥已存在，请主动复制或明确重置")
        const claimed = await this.prisma.skillsKeyCredential.updateMany({
          where: { id: row.id, revision: row.revision, status: "ACTIVE" },
          data: {
            status: "ROTATING",
            externalProjectId: project.projectId,
            // 切换项目时先占用目标项目+手机号唯一键，不把旧密文归到新项目。
            ...(row.externalProjectId !== project.projectId
              ? {
                  keyCiphertext: null,
                  keyHash: null,
                  encryptionVersion: null,
                  maskedKey: null,
                  activatedAt: null,
                }
              : {}),
            issuedPhone: user.phone,
            operationId: dto.operationId,
            operationKind: kind,
            usedOperationIds: [...this.usedOperations(row), dto.operationId],
            operationStartedAt: new Date(),
            lastErrorCode: null,
            revision: { increment: 1 },
          },
        })
        if (!claimed.count) return this.concurrentResult(userId, dto, kind, project.projectId)
        row = {
          ...row,
          revision: row.revision + 1,
          operationId: dto.operationId,
          status: "ROTATING",
        }
      } else {
        if (reset) throw this.conflict("SKILLS_KEY_NOT_CREATED", "请先生成密钥")
        try {
          row = await this.prisma.skillsKeyCredential.create({
            data: {
              userId,
              projectCode: project.code,
              externalProjectId: project.projectId,
              issuedPhone: user.phone,
              status: "ROTATING",
              operationId: dto.operationId,
              operationKind: kind,
              usedOperationIds: [dto.operationId],
              operationStartedAt: new Date(),
            },
          })
        } catch (error) {
          if (!this.isUniqueError(error)) throw error
          return this.concurrentResult(userId, dto, kind, project.projectId)
        }
      }

      // Claim commits before the non-idempotent remote call. No transaction holds a DB lock over HTTP.
      // Every uncertain outcome fails closed; a crashed worker leaves ROTATING and is lazily marked unknown.
      let failureCode = "ISSUE_RESULT_UNKNOWN"
      try {
        const issued = await this.issuer.issue(project, user.phone)
        failureCode = "KEY_ENCRYPT_FAILED"
        const encrypted = this.crypto.encrypt(issued.key, userId, project.projectId)
        failureCode = "KEY_SAVE_FAILED"
        const saved = await this.prisma.skillsKeyCredential.updateMany({
          where: {
            id: row.id,
            revision: row.revision,
            status: "ROTATING",
            operationId: dto.operationId,
          },
          data: {
            ...encrypted,
            status: "ACTIVE",
            activatedAt: new Date(),
            lastErrorCode: null,
            revision: { increment: 1 },
          },
        })
        if (!saved.count) {
          failureCode = "KEY_SAVE_CONFLICT"
          throw this.unknown()
        }
        failureCode = "KEY_READBACK_FAILED"
        const current = await this.findCurrent(userId, project.code)
        if (!current || current.operationId !== dto.operationId || current.status !== "ACTIVE") {
          failureCode = "KEY_READBACK_CONFLICT"
          throw this.conflict("SKILLS_OPERATION_SUPERSEDED", "操作已被后续重置替代，请查询当前状态")
        }
        failureCode = "KEY_DELIVERY_FAILED"
        return this.deliver(current)
      } catch (error) {
        // Do not log original errors: HTTP/Prisma errors can contain credentials and phone snapshots.
        const issueError = error instanceof SkillsKeyIssueError ? error : undefined
        const lastErrorCode = issueError?.failureCode ?? failureCode
        this.logger.warn(
          JSON.stringify({
            event: "skills_key_issue_failed",
            operationId: dto.operationId,
            lastErrorCode,
            upstreamStatus: issueError?.upstreamStatus,
            transportCode: issueError?.transportCode,
          })
        )
        try {
          await this.prisma.skillsKeyCredential.updateMany({
            where: {
              id: row.id,
              operationId: dto.operationId,
              status: { in: ["ROTATING", "ACTIVE"] },
            },
            data: { status: "SYNC_UNKNOWN", lastErrorCode },
          })
        } catch {
          this.logger.error("密钥签发状态保存失败，凭证须由运维核查")
        }
        throw this.unknown()
      }
    })
  }

  async resolveForDeduction(keyB: string, appId: string) {
    return this.safe(async () => {
      if (!isValidKeyB(keyB)) throw this.invalidKey()
      const row = await this.prisma.skillsKeyCredential.findUnique({
        where: { keyHash: this.crypto.hash(keyB) },
      })
      if (!row || row.status !== "ACTIVE") throw this.invalidKey()
      const project = this.config.getProject(row.projectCode)
      if (row.externalProjectId !== project.projectId) throw this.invalidKey()
      // 项目授权按请求读取数据库：授予/撤销不依赖进程配置或缓存，也不改变消费幂等身份。
      const app = await this.prisma.openApiApp.findUnique({
        where: { appId },
        select: { status: true, keybProjectCodes: true },
      })
      if (!app) {
        throw new UnauthorizedException({ code: "OPEN_AUTH_INVALID", message: "服务身份无效" })
      }
      if (app.status !== "ACTIVE") {
        throw new ForbiddenException({ code: "OPEN_APP_DISABLED", message: "接入方已停用" })
      }
      if (
        !Array.isArray(app.keybProjectCodes) ||
        !app.keybProjectCodes.every(code => typeof code === "string") ||
        !app.keybProjectCodes.includes(project.code)
      ) {
        throw new ForbiddenException({
          code: "SKILLS_PROJECT_FORBIDDEN",
          message: "接入方无此项目扣费权限",
        })
      }
      await this.requireUser(row.userId)
      return {
        userId: row.userId,
        projectCode: row.projectCode,
        externalProjectId: row.externalProjectId,
      }
    })
  }

  private async concurrentResult(
    userId: number,
    dto: SkillsKeyOperationDto,
    kind: OperationKind,
    projectId: string
  ) {
    const current = await this.findCurrent(userId, dto.projectCode)
    if (!current)
      throw this.conflict("SKILLS_KEY_ASSOCIATION_CONFLICT", "接入项目凭证关联冲突，请联系管理员")
    const row = await this.markStale(current)
    if (this.checkOperation(row, dto.operationId, kind, projectId)) return this.deliver(row)
    throw this.conflict("SKILLS_OPERATION_CONFLICT", "其他密钥操作已先完成，请查询当前状态")
  }

  private checkOperation(
    row: SkillsKeyCredential,
    id: string,
    kind: OperationKind,
    projectId: string
  ) {
    if (row.operationId === id) {
      if (row.operationKind !== kind)
        throw this.conflict("SKILLS_OPERATION_CONFLICT", "operationId 不可跨操作类型复用")
      this.requireActive(row, projectId)
      return true
    }
    if (this.usedOperations(row).includes(id)) {
      throw this.conflict("SKILLS_OPERATION_SUPERSEDED", "操作已被后续重置替代，请查询当前状态")
    }
    return false
  }

  private usedOperations(row: SkillsKeyCredential): string[] {
    if (
      !Array.isArray(row.usedOperationIds) ||
      !row.usedOperationIds.every(id => typeof id === "string")
    ) {
      throw this.unknown()
    }
    return row.usedOperationIds
  }

  private findCurrent(userId: number, projectCode: string) {
    return this.prisma.skillsKeyCredential.findUnique({
      where: { userId_projectCode: { userId, projectCode } },
    })
  }

  private async markStale(row: SkillsKeyCredential): Promise<SkillsKeyCredential> {
    if (
      row.status !== "ROTATING" ||
      Date.now() - row.operationStartedAt.getTime() <= KEY_ROTATION_STALE_MS
    )
      return row
    await this.prisma.skillsKeyCredential.updateMany({
      where: { id: row.id, revision: row.revision, status: "ROTATING" },
      data: { status: "SYNC_UNKNOWN", lastErrorCode: "ISSUE_RESULT_UNKNOWN" },
    })
    return (
      (await this.findCurrent(row.userId, row.projectCode)) ?? { ...row, status: "SYNC_UNKNOWN" }
    )
  }

  private async requireUser(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, phone: true, isActive: true },
    })
    if (!user?.isActive)
      throw new UnauthorizedException({
        code: "SKILLS_USER_INACTIVE",
        message: "用户不存在或已停用",
      })
    return user
  }

  private requireActive(row: SkillsKeyCredential, projectId: string) {
    if (row.status === "SYNC_UNKNOWN") throw this.unknown()
    if (row.status === "ROTATING")
      throw this.conflict(
        "SKILLS_KEY_ROTATING",
        "密钥正在签发，请稍后使用相同 operationId 查询结果"
      )
    if (row.externalProjectId !== projectId)
      throw this.conflict("SKILLS_PROJECT_CHANGED", PROJECT_CHANGED_MESSAGE)
    if (!row.keyCiphertext || !row.encryptionVersion || !row.keyHash) throw this.unknown()
  }

  private deliver(row: SkillsKeyCredential) {
    this.requireActive(row, row.externalProjectId)
    return {
      ...this.publicStatus(row, row.externalProjectId),
      key: this.crypto.decrypt(
        row.keyCiphertext!,
        row.encryptionVersion!,
        row.userId,
        row.externalProjectId
      ),
    }
  }

  private publicStatus(row: SkillsKeyCredential, projectId: string) {
    const changed = row.externalProjectId !== projectId
    // 仅配置不匹配可由用户明确重置；不能覆盖真实签发中的状态或失败原因。
    const needsProjectReset = changed && row.status === "ACTIVE"
    return {
      projectCode: row.projectCode,
      status: needsProjectReset ? "SYNC_UNKNOWN" : row.status,
      maskedKey: row.status === "ACTIVE" && !changed ? row.maskedKey : null,
      operationId: row.operationId,
      activatedAt: row.activatedAt,
      updatedAt: row.updatedAt,
      lastErrorCode: needsProjectReset ? "SKILLS_PROJECT_CHANGED" : row.lastErrorCode,
      recoveryMessage: needsProjectReset
        ? PROJECT_CHANGED_MESSAGE
        : row.status === "SYNC_UNKNOWN"
          ? RECOVERY_MESSAGE
          : null,
    }
  }

  private invalidKey() {
    return new UnauthorizedException({
      code: "SKILLS_KEY_INVALID",
      message: "密钥无效或当前不可用",
    })
  }
  private unknown() {
    return this.conflict("SKILLS_KEY_SYNC_UNKNOWN", RECOVERY_MESSAGE)
  }
  private conflict(code: string, message: string) {
    return new ConflictException({ code, message })
  }
  private isUniqueError(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  }
  private async safe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof HttpException) throw error
      if (this.isUniqueError(error))
        throw this.conflict("SKILLS_KEY_ASSOCIATION_CONFLICT", "接入项目凭证关联冲突，请联系管理员")
      throw new ServiceUnavailableException({
        code: "SKILLS_KEYS_UNAVAILABLE",
        message: "密钥服务暂不可用，请保留 operationId 并稍后查询状态",
      })
    }
  }
}
