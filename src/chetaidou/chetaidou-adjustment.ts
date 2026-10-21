import { ConflictException, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { randomUUID } from "crypto"
import { TaskSnapshot } from "./chetaidou-context.service"
import { stableHash } from "./chetaidou-storage.service"

type Draft = Prisma.ChetaidouDraftGetPayload<Record<string, never>>
type Task = Prisma.ChetaidouTaskGetPayload<Record<string, never>>
export type AdjustmentState = Pick<
  Draft,
  | "settings"
  | "selections"
  | "customDimensions"
  | "activeIdeationTaskId"
  | "activeCompositionTaskId"
  | "activeGroupRefs"
  | "pendingRefreshTaskId"
> & {
  facts?: { id: number; version: number; contentHash: string }
  breakdown?: { id: number; version: number; contentHash: string } | null
}

export function workspaceChanged(): ConflictException {
  return new ConflictException({
    code: "SETTINGS_CHANGED",
    message: "当前调整已变化，请重新读取草稿后重试",
  })
}

export function assertWorkspace(draft: Draft, workspaceId?: string, revision?: number) {
  if (
    (workspaceId !== undefined && draft.workspaceId !== workspaceId) ||
    (revision !== undefined && draft.revision !== revision)
  )
    throw workspaceChanged()
}

export function adjustmentState(
  draft: Draft,
  snapshot?: Pick<TaskSnapshot, "facts" | "breakdown">
): AdjustmentState {
  return {
    settings: draft.settings,
    selections: draft.selections,
    customDimensions: draft.customDimensions,
    activeIdeationTaskId: draft.activeIdeationTaskId ?? null,
    activeCompositionTaskId: draft.activeCompositionTaskId ?? null,
    activeGroupRefs: draft.activeGroupRefs ?? [],
    pendingRefreshTaskId: draft.pendingRefreshTaskId ?? null,
    ...(snapshot
      ? {
          facts: {
            id: snapshot.facts.id,
            version: snapshot.facts.version,
            contentHash: snapshot.facts.contentHash,
          },
          breakdown: snapshot.breakdown
            ? {
                id: snapshot.breakdown.id,
                version: snapshot.breakdown.version,
                contentHash: snapshot.breakdown.contentHash,
              }
            : null,
        }
      : {}),
  }
}

export async function ownedAdjustment(
  tx: Pick<Prisma.TransactionClient, "chetaidouAdjustment">,
  ownerId: number,
  imageId: number,
  id: string
) {
  const row = await tx.chetaidouAdjustment.findUnique({ where: { id } })
  if (!row || row.ownerId !== ownerId || row.imageId !== imageId)
    throw new NotFoundException("调整记录不存在")
  return row
}

export async function lockAdjustmentDraft(tx: Prisma.TransactionClient, draft: Draft) {
  const id = draft.activeAdjustmentId ?? draft.restoredFromAdjustmentId
  if (id) await tx.$queryRaw`SELECT id FROM ChetaidouAdjustment WHERE id = ${id} FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM ChetaidouDraft WHERE id = ${draft.id} FOR UPDATE`
  const current = await tx.chetaidouDraft.findUniqueOrThrow({ where: { id: draft.id } })
  assertWorkspace(current, draft.workspaceId ?? undefined, draft.revision)
  return current
}

/** 历史、命令及工作区指针由调用者的同一事务提交。 */
export async function prepareAdjustment(
  tx: Prisma.TransactionClient,
  draft: Draft,
  snapshot: TaskSnapshot,
  type: string
) {
  // 尚无工作区的开发旧行不生成历史；正式入口先 GET draft 分配令牌。
  if (!draft.workspaceId) return { workspaceId: null, adjustmentId: null }
  await lockAdjustmentDraft(tx, draft)
  const source = draft.activeAdjustmentId ?? draft.restoredFromAdjustmentId
  // 新要求会清空联想指针；重新组织继承的联想仍算已执行，不能当作首次。
  const reideation = type === "IDEATION" && !!draft.activeIdeationTaskId
  // 选择变更会清空组合指针，因此也检查本轮关联过的任务。
  const recompose =
    type === "COMPOSE" &&
    (!!draft.activeCompositionTaskId ||
      (!!draft.activeAdjustmentId &&
        !!(await tx.chetaidouTask.findFirst({
          where: { adjustmentId: draft.activeAdjustmentId, type: "COMPOSE" },
          select: { id: true },
        }))))
  const create =
    reideation ||
    recompose ||
    (!source && ["IDEATION", "COMPOSE", "DIVERGE", "ANSWERS"].includes(type)) ||
    (!!draft.restoredFromAdjustmentId && type !== "GENERATE")
  if (!create) return { workspaceId: draft.workspaceId, adjustmentId: source ?? null }
  return forkAdjustment(tx, draft, adjustmentState(draft, snapshot), snapshot.image.skuId)
}

/** 调用方先锁定草稿，在同一事务内保存新历史及工作区指针。 */
export async function forkAdjustment(
  tx: Prisma.TransactionClient,
  draft: Draft,
  state: AdjustmentState,
  skuId: number
) {
  const source = draft.activeAdjustmentId ?? draft.restoredFromAdjustmentId
  const id = randomUUID()
  const workspaceId = randomUUID()
  await tx.chetaidouAdjustment.create({
    data: {
      id,
      ownerId: draft.ownerId,
      imageId: draft.imageId,
      skuId,
      parentAdjustmentId: source ?? null,
      state: state as unknown as Prisma.InputJsonValue,
    },
  })
  const changed = await tx.chetaidouDraft.updateMany({
    where: { id: draft.id, workspaceId: draft.workspaceId, revision: draft.revision },
    data: { workspaceId, activeAdjustmentId: id, restoredFromAdjustmentId: null },
  })
  if (!changed.count) throw workspaceChanged()
  return { workspaceId, adjustmentId: id }
}

export async function saveDraftAdjustment(
  tx: Prisma.TransactionClient,
  draftId: number,
  snapshot?: Pick<TaskSnapshot, "facts" | "breakdown">
) {
  const draft = await tx.chetaidouDraft.findUniqueOrThrow({ where: { id: draftId } })
  if (!draft.activeAdjustmentId || draft.restoredFromAdjustmentId) return
  await tx.$queryRaw`SELECT id FROM ChetaidouAdjustment WHERE id = ${draft.activeAdjustmentId} FOR UPDATE`
  const row = await ownedAdjustment(tx, draft.ownerId, draft.imageId, draft.activeAdjustmentId)
  await tx.chetaidouAdjustment.update({
    where: { id: row.id },
    data: {
      state: {
        ...(row.state as object),
        ...adjustmentState(draft, snapshot),
      } as Prisma.InputJsonValue,
      revision: { increment: 1 },
    },
  })
}

/** 即使用户切走，产物仍补齐所属历史；仅匹配提交令牌时同步当前草稿。 */
export async function writeTaskAdjustment(
  tx: Prisma.TransactionClient,
  task: Task,
  patch:
    | Partial<AdjustmentState>
    | ((state: AdjustmentState) => Partial<AdjustmentState> | Promise<Partial<AdjustmentState>>),
  expected: Partial<AdjustmentState> = {}
) {
  if (!task.adjustmentId || !task.workspaceId) return { applied: false, revision: null }
  await tx.$queryRaw`SELECT id FROM ChetaidouAdjustment WHERE id = ${task.adjustmentId} FOR UPDATE`
  const row = await ownedAdjustment(tx, task.ownerId, task.imageId, task.adjustmentId)
  const state = row.state as unknown as AdjustmentState
  const matches = (value: Partial<AdjustmentState>) =>
    Object.entries(expected).every(
      ([key, entry]) =>
        stableHash(value[key as keyof AdjustmentState] ?? null) === stableHash(entry ?? null)
    )
  if (!matches(state)) return { applied: false, revision: null }
  const changes = typeof patch === "function" ? await patch(state) : patch
  if (!Object.keys(changes).length) return { applied: false, revision: null }
  await tx.chetaidouAdjustment.update({
    where: { id: row.id },
    data: {
      state: { ...state, ...changes } as unknown as Prisma.InputJsonValue,
      revision: { increment: 1 },
    },
  })
  const draft = await tx.chetaidouDraft.findUnique({
    where: { ownerId_imageId: { ownerId: task.ownerId, imageId: task.imageId } },
  })
  if (
    !draft ||
    draft.workspaceId !== task.workspaceId ||
    !matches(draft) ||
    (draft.activeAdjustmentId !== row.id && draft.restoredFromAdjustmentId !== row.id)
  )
    return { applied: false, revision: null }
  const updated = await tx.chetaidouDraft.updateMany({
    where: { id: draft.id, workspaceId: task.workspaceId, revision: draft.revision },
    data: {
      ...changes,
      revision: { increment: 1 },
    } as Prisma.ChetaidouDraftUpdateManyMutationInput,
  })
  return { applied: updated.count > 0, revision: updated.count ? draft.revision + 1 : null }
}
