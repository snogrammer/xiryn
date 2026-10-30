"use client"

import * as React from "react"
import {
  CheckIcon,
  CreditCardIcon,
  HandIcon,
  KeyRoundIcon,
  PlusIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react"

import { decidePayment, paymentRequest, provideSecret } from "@/actions/vault"
import { useTakeover } from "@/components/thread/takeover"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { VAULT_FORMS, VaultForm } from "@/components/vault/vault-form"
import type { VaultKind } from "@/lib/vault"
import { cn } from "@/lib/utils"

type Payment = NonNullable<Awaited<ReturnType<typeof paymentRequest>>>

function Shell({
  icon,
  kicker,
  tone = "attention",
  children,
}: {
  icon: React.ReactNode
  kicker: string
  tone?: "attention" | "done" | "muted"
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "my-1 flex flex-col gap-3 rounded-lg border p-3.5",
        tone === "attention"
          ? "border-betelgeuse/30 bg-betelgeuse-soft"
          : tone === "done"
            ? "border-ok/25 bg-ok/5"
            : "bg-surface/50"
      )}
    >
      <span
        className={cn(
          "flex items-center gap-1.5 font-mono text-[11px]",
          tone === "attention"
            ? "text-betelgeuse"
            : tone === "done"
              ? "text-ok"
              : "text-muted-foreground"
        )}
      >
        {icon}
        {kicker}
      </span>
      {children}
    </div>
  )
}

/* ─────────────────────────── payment ─────────────────────────── */

// An agent wants to pay. Nothing is paid until the person chooses.
export function PaymentApprovalCard({
  approvalId,
  awaiting,
}: {
  approvalId: string
  // The latest thing in the thread, so it can still be answered
  awaiting: boolean
}) {
  const { send, start, available } = useTakeover()
  const [payment, setPayment] = React.useState<Payment | null | undefined>(undefined)
  const [method, setMethod] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState<"card" | "upi" | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    const next = await paymentRequest(approvalId)
    setPayment(next)
    setMethod((current) => current ?? next?.methods[0]?.id ?? null)
  }, [approvalId])

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  if (payment === undefined) {
    return (
      <Shell icon={<CreditCardIcon className="size-3.5" />} kicker="payment request">
        <Spinner className="size-4" />
      </Shell>
    )
  }
  if (payment === null) return null

  const decide = async (choice: "approve" | "takeover" | "decline") => {
    setBusy(choice)
    setError(null)
    const result = await decidePayment(
      payment.id,
      choice === "approve" ? { itemId: method! } : choice
    )
    setBusy(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    await load()
    if (result.text) send(result.text, result.marker)
    if (choice === "takeover") start()
  }

  const decided = payment.status !== "pending"
  const open = !decided && awaiting

  return (
    <Shell
      icon={<CreditCardIcon className="size-3.5" />}
      kicker={
        payment.status === "approved"
          ? "payment approved"
          : payment.status === "declined"
            ? "payment declined"
            : payment.status === "taken-over"
              ? "you're paying yourself"
              : open
                ? "wants to pay · nothing is paid until you choose"
                : "payment request"
      }
      tone={payment.status === "approved" ? "done" : open ? "attention" : "muted"}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[20px] font-semibold tracking-tight">{payment.amount}</span>
        <span className="text-[13.5px]">to {payment.merchant}</span>
        <span className="rounded-sm border px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
          {payment.host ?? "site unknown"}
        </span>
      </div>
      {payment.purpose && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {payment.purpose}
        </p>
      )}

      {payment.status === "approved" && payment.item && (
        <p className="flex items-center gap-1.5 font-mono text-[12px]">
          <ShieldCheckIcon className="size-3.5 text-ok" />
          paying with {payment.item.hint}
        </p>
      )}

      {open && (
        <>
          {payment.methods.length > 0 && !adding && (
            <div className="flex flex-col gap-1.5">
              {payment.methods.map((item) => (
                <label
                  key={item.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 transition-colors",
                    method === item.id
                      ? "border-ring bg-background/70"
                      : "hover:bg-background/40"
                  )}
                >
                  <input
                    type="radio"
                    name={`pay-${payment.id}`}
                    checked={method === item.id}
                    onChange={() => setMethod(item.id)}
                    className="accent-current"
                  />
                  <span className="text-[13px] font-medium">{item.label}</span>
                  <span className="ml-auto font-mono text-[11.5px] text-muted-foreground">
                    {item.hint}
                  </span>
                </label>
              ))}
            </div>
          )}

          {adding ? (
            <div className="rounded-md border bg-background/50 p-3">
              <VaultForm
                kind={adding}
                compact
                saveOption
                submitLabel={`Add ${VAULT_FORMS[adding].title.toLowerCase()}`}
                onCancel={() => setAdding(null)}
                onSubmit={async (data, options) => {
                  const result = await provideSecret(adding, data, options)
                  if (!result.ok) return result.error
                  setAdding(null)
                  const next = await paymentRequest(approvalId)
                  setPayment(next)
                  setMethod(next?.methods.find((m) => m.hint === result.hint)?.id ?? null)
                  return null
                }}
              />
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="xs" variant="ghost" onClick={() => setAdding("card")}>
                <PlusIcon data-icon="inline-start" />
                Card
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setAdding("upi")}>
                <PlusIcon data-icon="inline-start" />
                UPI ID
              </Button>
            </div>
          )}

          {error && <p className="text-[12px] text-destructive">{error}</p>}

          {!adding && (
            <div className="flex flex-wrap items-center gap-2 border-t border-dashed pt-3">
              <Button
                size="sm"
                disabled={!method || !!busy}
                onClick={() => decide("approve")}
              >
                {busy === "approve" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <CheckIcon data-icon="inline-start" />
                )}
                Approve — let it pay
              </Button>
              {available && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!!busy}
                  onClick={() => decide("takeover")}
                >
                  <HandIcon data-icon="inline-start" />
                  I&apos;ll pay myself
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => decide("decline")}
              >
                <XIcon data-icon="inline-start" />
                Decline
              </Button>
            </div>
          )}
        </>
      )}

      {!decided && !awaiting && (
        <p className="text-[12px] text-muted-foreground">
          No longer waiting for an answer.
        </p>
      )}
    </Shell>
  )
}

/* ─────────────────────────── secrets ─────────────────────────── */

const ASKS: Record<VaultKind, string> = {
  login: "needs a login",
  card: "needs card details",
  upi: "needs a UPI ID",
  identity: "needs some personal details",
  code: "needs a code",
}

// A detail only the person has, entered here and stored in the vault
export function SecretRequestCard({
  kind,
  reason,
  site,
  awaiting,
}: {
  kind: VaultKind
  reason: string
  site: string | null
  awaiting: boolean
}) {
  const { send } = useTakeover()
  const [done, setDone] = React.useState<string | null>(null)

  if (done) {
    return (
      <Shell
        icon={<ShieldCheckIcon className="size-3.5" />}
        kicker="added to your vault"
        tone="done"
      >
        <p className="font-mono text-[12px]">{done}</p>
      </Shell>
    )
  }

  return (
    <Shell
      icon={<KeyRoundIcon className="size-3.5" />}
      kicker={`${ASKS[kind]}${site ? ` for ${site}` : ""}`}
      tone={awaiting ? "attention" : "muted"}
    >
      <p className="text-[13.5px] leading-relaxed">{reason}</p>
      {awaiting ? (
        <VaultForm
          kind={kind}
          defaults={site ? { site } : {}}
          saveOption={kind !== "code"}
          label={kind !== "code"}
          submitLabel={kind === "code" ? "Send code securely" : "Add securely"}
          onSubmit={async (data, options) => {
            const result = await provideSecret(kind, data, options)
            if (!result.ok) return result.error
            setDone(result.hint)
            send(result.text, result.marker)
            return null
          }}
        />
      ) : (
        <p className="text-[12px] text-muted-foreground">Answered.</p>
      )}
    </Shell>
  )
}
