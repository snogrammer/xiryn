"use server"

import { revalidatePath } from "next/cache"

import {
  addVaultItem,
  approvalScreen,
  deleteVaultItem,
  getApproval,
  getVaultItem,
  isExpiredRequest,
  listVault,
  vaultKeySource,
  type VaultKind,
} from "@/lib/vault"
import {
  answerLogin,
  answerPayment,
  answerSecret,
  signMarker,
  type LoginChoice,
  type PaymentChoice,
} from "@/lib/vault-requests"

// The browser only ever receives labels and masked hints. Values travel one
// way: from a form into the encrypted vault.

const KINDS: VaultKind[] = ["card", "upi", "login", "identity", "code"]

function reason(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function vaultOverview() {
  try {
    return { ok: true as const, items: listVault(), source: vaultKeySource() }
  } catch (error) {
    return { ok: false as const, error: reason(error) }
  }
}

export async function saveToVault(
  kind: VaultKind,
  data: Record<string, string>,
  label?: string
) {
  if (!KINDS.includes(kind) || kind === "code")
    return { ok: false as const, error: "Unknown kind." }
  try {
    const item = addVaultItem(kind, data, { label })
    revalidatePath("/settings")
    return { ok: true as const, item }
  } catch (error) {
    return { ok: false as const, error: reason(error) }
  }
}

export async function removeFromVault(id: string) {
  deleteVaultItem(id)
  revalidatePath("/settings")
}

// A payment an agent asked to make, and the methods it could use
export async function paymentRequest(approvalId: string) {
  const approval = getApproval(approvalId)
  if (!approval) return null
  return {
    id: approval.id,
    merchant: approval.merchant,
    amount: approval.amount,
    purpose: approval.purpose,
    host: approval.host,
    status: isExpiredRequest(approval) ? ("expired" as const) : approval.status,
    // Only while it's waiting for an answer: that's when it's checked
    screen:
      approval.status === "pending" && !isExpiredRequest(approval)
        ? approvalScreen(approval.id)
        : null,
    item: approval.itemId ? getVaultItem(approval.itemId) : null,
    methods: listVault({ temporary: true }).filter(
      (item) => item.kind === "card" || item.kind === "upi"
    ),
  }
}

export async function decidePayment(approvalId: string, choice: PaymentChoice) {
  try {
    const answer = answerPayment(approvalId, choice)
    // The same request on Telegram or Discord no longer needs answering
    const { closeApprovalNotice } = await import("@/lib/remote/core")
    const outcome = {
      approved: "Approved",
      declined: "Declined",
      "taken-over": "You're paying yourself",
      provided: "Done",
    }[answer.marker.action]
    await closeApprovalNotice(approvalId, `${outcome} · ${answer.marker.summary}`)
    return { ok: true as const, ...answer, marker: signMarker(answer.marker) }
  } catch (error) {
    return { ok: false as const, error: reason(error) }
  }
}

// A sign-in an agent asked to make with a saved login
export async function loginRequest(approvalId: string) {
  const approval = getApproval(approvalId)
  if (!approval || approval.kind !== "login") return null
  return {
    id: approval.id,
    host: approval.host,
    status: isExpiredRequest(approval) ? ("expired" as const) : approval.status,
    // Only while it's waiting for an answer: that's when it's checked
    screen:
      approval.status === "pending" && !isExpiredRequest(approval)
        ? approvalScreen(approval.id)
        : null,
    login: approval.itemId ? getVaultItem(approval.itemId) : null,
  }
}

export async function decideLogin(approvalId: string, choice: LoginChoice) {
  try {
    const answer = answerLogin(approvalId, choice)
    const { closeApprovalNotice } = await import("@/lib/remote/core")
    const outcome = {
      approved: "Approved",
      declined: "Declined",
      "taken-over": "You're signing in yourself",
      provided: "Done",
    }[answer.marker.action]
    await closeApprovalNotice(approvalId, `${outcome} · ${answer.marker.summary}`)
    return { ok: true as const, ...answer, marker: signMarker(answer.marker) }
  } catch (error) {
    return { ok: false as const, error: reason(error) }
  }
}

export async function provideSecret(
  kind: VaultKind,
  data: Record<string, string>,
  options: { save: boolean; label?: string }
) {
  if (!KINDS.includes(kind)) return { ok: false as const, error: "Unknown kind." }
  try {
    const { item, text, marker } = answerSecret(kind, data, options)
    if (options.save) revalidatePath("/settings")
    return { ok: true as const, hint: item.hint, text, marker: signMarker(marker) }
  } catch (error) {
    return { ok: false as const, error: reason(error) }
  }
}
