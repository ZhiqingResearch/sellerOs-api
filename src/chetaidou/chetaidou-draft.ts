import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { randomUUID } from "crypto"
import { PrismaService } from "../prisma/prisma.service"
import {
  assertWorkspace,
  ownedAdjustment,
  prepareAdjustment,
  saveDraftAdjustment,
  writeTaskAdjustment,
} from "./chetaidou-adjustment"
import { TaskSnapshot } from "./chetaidou-context.service"
import { contentSettingsOf } from "./chetaidou-execution"
import { stableHash } from "./chetaidou-storage.service"
import { ChetaidouOption, ChetaidouSettings } from "./chetaidou.schemas"

export interface CustomDimensionInput {
  id?: string
  label: string
  selectionMode: string
  guidance?: string
  options: { key?: string; text: string; origin?: "USER" | "AI"; sourceTaskId?: string }[]
  selectedKeys?: string[]
}

/** 来源只从已保存数据继承，不能通过客户端声明把手写项冒充 AI。 */
export function normalizeCustomDimensions(
  input: CustomDimensionInput[],
  previous: CustomDimensionInput[]
) {
  const dimensionIds = new Set<string>()
  return input.map(dim => {
    const id = dim.id || `dim_${randomUUID()}`
    if (dimensionIds.has(id)) throw new BadRequestException("自建维度 ID 重复")
    dimensionIds.add(id)
    const old = previous.find(d => d.id === id)
    const optionKeys = new Set<string>()
    const options = dim.options.map(opt => {
      const key = opt.key || `user_${randomUUID()}`
      if (optionKeys.has(key)) throw new BadRequestException("自建方案 key 重复")
      optionKeys.add(key)
      const saved = old?.options.find(o => o.key === key)
      return {
        key,
        text: opt.text.trim(),
        origin: saved?.origin ?? ("USER" as const),
        ...(saved?.sourceTaskId ? { sourceTaskId: saved.sourceTaskId } : {}),
      }
    })
    const selectedKeys = [...new Set(dim.selectedKeys ?? [])]
    if (selectedKeys.some(key => !optionKeys.has(key)))
      throw new BadRequestException("所选自建方案不存在，请先保存新增方案")
    if (dim.selectionMode === "single" && selectedKeys.length > 1)
      throw new BadRequestException("单选维度不可选择多个方案")
    return {
      id,
      label: dim.label.trim(),
      selectionMode: dim.selectionMode,
      guidance: dim.guidance ?? "",
      options,
      selectedKeys,
    }
  })
}

/** 自动/手动应用共用事务：串行处理同一产物，草稿 CAS 与 applied 标记一起提交。 */
export async function applyDivergeOutput(
  prisma: PrismaService,
  ownerId: number,
  taskId: string,
  revision: number,
  automatic = false,
  workspaceId?: string
) {
  return prisma.$transaction(async tx => {
    const locked = await tx.$queryRaw<{ adjustmentId: string | null }[]>`
      SELECT adjustmentId FROM ChetaidouTask WHERE id = ${taskId} FOR UPDATE`
    // 先锁来源记录再读取状态，避免并发组织提交后仍读到旧组合指针。
    if (locked[0]?.adjustmentId)
      await tx.$queryRaw`SELECT id FROM ChetaidouAdjustment WHERE id = ${locked[0].adjustmentId} FOR UPDATE`
    const task = await tx.chetaidouTask.findUnique({ where: { id: taskId } })
    if (!task || task.ownerId !== ownerId || task.type !== "DIVERGE")
      throw new NotFoundException("发散任务不存在")
    const output = (task.output ?? {}) as Record<string, any>
    if (task.workspaceId) {
      const current = await tx.chetaidouDraft.findUnique({
        where: { ownerId_imageId: { ownerId, imageId: task.imageId } },
      })
      if (!automatic) {
        if (!current) throw new NotFoundException("草稿不存在")
        assertWorkspace(current, workspaceId, revision)
      }
      const binding =
        !automatic && current
          ? await prepareAdjustment(
              tx,
              current,
              task.snapshot as unknown as TaskSnapshot,
              "DIVERGE"
            )
          : { workspaceId: task.workspaceId, adjustmentId: task.adjustmentId }
      if (binding.adjustmentId) {
        if (!automatic && current) await saveDraftAdjustment(tx, current.id)
        const record = await ownedAdjustment(tx, ownerId, task.imageId, binding.adjustmentId)
        const state = record.state as unknown as {
          settings: ChetaidouSettings
          customDimensions: CustomDimensionInput[]
          activeCompositionTaskId?: string | null
        }
        const sourceCompositionTaskId =
          (task.input as { sourceCompositionTaskId?: string | null }).sourceCompositionTaskId ??
          null
        if (automatic && (state.activeCompositionTaskId ?? null) !== sourceCompositionTaskId)
          throw new ConflictException("当前组合已变化，请确认后重新应用")
        if (
          automatic &&
          stableHash(contentSettingsOf(state.settings)) !==
            stableHash(contentSettingsOf((task.snapshot as unknown as TaskSnapshot).settings))
        )
          throw new ConflictException("出图要求已变化，请确认后重新应用")
        const dims = state.customDimensions
        const targetId = (task.input as { customDimensionId?: string }).customDimensionId
        const target = dims.find(d => d.id === targetId)
        if (!target) throw new ConflictException("目标自建维度已不存在")
        const original = (task.snapshot as unknown as TaskSnapshot).customDimensions.find(
          dimension => (dimension as CustomDimensionInput).id === targetId
        ) as CustomDimensionInput | undefined
        if (
          automatic &&
          (!original ||
            (["label", "guidance", "selectionMode"] as const).some(
              key => (original[key] ?? "") !== (target[key] ?? "")
            ))
        )
          throw new ConflictException("目标自建维度已变化，请确认后重新应用")
        if (output.discarded) throw new ConflictException("该发散结果已放弃")
        if (!automatic && task.status !== "SUCCEEDED")
          throw new BadRequestException("任务未成功，不可应用")
        const keys = new Set(target.options.map(option => option.key))
        const labels = new Set(target.options.map(option => option.text.trim()))
        const fresh = ((output.newOptions ?? []) as ChetaidouOption[]).filter(option => {
          if (keys.has(option.key) || labels.has(option.label.trim())) return false
          keys.add(option.key)
          labels.add(option.label.trim())
          return true
        })
        const dimensions = dims.map(d =>
          d.id === targetId
            ? {
                ...d,
                options: [
                  ...d.options,
                  ...fresh.map(o => ({
                    key: o.key,
                    text: o.label,
                    origin: "AI" as const,
                    sourceTaskId: task.id,
                  })),
                ],
              }
            : d
        )
        const result = await writeTaskAdjustment(
          tx,
          { ...task, ...binding },
          {
            customDimensions: dimensions as unknown as Prisma.JsonValue,
            activeCompositionTaskId: null,
          }
        )
        await tx.chetaidouTask.update({
          where: { id: task.id },
          data: {
            output: {
              ...output,
              applied: true,
              canApply: !result.applied,
              appliedDraftRevision: result.revision,
            },
            appliedDraftRevision: result.revision,
            appliedAt: new Date(),
          },
        })
        return result
      }
      if (automatic && current?.workspaceId !== task.workspaceId)
        return { applied: false, revision: null }
    }
    if (output.applied)
      return {
        applied: true,
        alreadyApplied: true,
        revision: output.appliedDraftRevision as number,
      }
    if (output.discarded) throw new ConflictException("该发散结果已放弃")
    if (!automatic && task.status !== "SUCCEEDED")
      throw new BadRequestException("任务未成功，不可应用")
    const draft = await tx.chetaidouDraft.findUnique({
      where: { ownerId_imageId: { ownerId, imageId: task.imageId } },
    })
    if (!draft || draft.revision !== revision || (workspaceId && draft.workspaceId !== workspaceId))
      throw new ConflictException({
        message: "草稿已变化，请确认后重新应用",
        code: "SETTINGS_CHANGED",
      })
    const dims = draft.customDimensions as unknown as CustomDimensionInput[]
    const targetId = (task.input as { customDimensionId?: string }).customDimensionId
    const target = dims.find(d => d.id === targetId)
    if (!target) throw new ConflictException("目标自建维度已不存在")
    const labels = new Set(target.options.map(o => o.text.trim()))
    const keys = new Set(target.options.map(o => o.key))
    const fresh = ((output.newOptions ?? []) as ChetaidouOption[]).filter(o => {
      if (labels.has(o.label.trim()) || keys.has(o.key)) return false
      labels.add(o.label.trim())
      keys.add(o.key)
      return true
    })
    const dimensions = dims.map(d =>
      d.id === targetId
        ? {
            ...d,
            options: [
              ...d.options,
              ...fresh.map(o => ({
                key: o.key,
                text: o.label,
                origin: "AI",
                sourceTaskId: task.id,
              })),
            ],
          }
        : d
    )
    const updated = await tx.chetaidouDraft.updateMany({
      where: { id: draft.id, revision },
      data: {
        customDimensions: dimensions as unknown as Prisma.InputJsonValue,
        activeCompositionTaskId: null,
        revision: { increment: 1 },
      },
    })
    if (!updated.count)
      throw new ConflictException({
        message: "草稿已变化，请确认后重新应用",
        code: "SETTINGS_CHANGED",
      })
    await tx.chetaidouTask.update({
      where: { id: task.id },
      data: {
        output: { ...output, applied: true, canApply: false, appliedDraftRevision: revision + 1 },
        appliedDraftRevision: revision + 1,
        appliedAt: new Date(),
      },
    })
    return { applied: true, revision: revision + 1 }
  })
}
