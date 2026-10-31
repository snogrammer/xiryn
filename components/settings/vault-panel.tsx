"use client"

import * as React from "react"
import {
  CreditCardIcon,
  IndianRupeeIcon,
  KeyRoundIcon,
  LockIcon,
  PlusIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react"

import { removeFromVault, saveToVault, vaultOverview } from "@/actions/vault"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { VAULT_FORMS, VaultForm } from "@/components/vault/vault-form"
import type { KeySource, VaultKind } from "@/lib/vault"

type Overview = Awaited<ReturnType<typeof vaultOverview>>
type Item = Extract<Overview, { ok: true }>["items"][number]

const ICONS: Record<VaultKind, React.ComponentType<{ className?: string }>> = {
  card: CreditCardIcon,
  upi: IndianRupeeIcon,
  login: KeyRoundIcon,
  identity: UserRoundIcon,
  code: LockIcon,
}

const KEY_SOURCE: Record<KeySource, string> = {
  keychain: "key in the macOS Keychain",
  dpapi: "key protected by Windows (DPAPI)",
  "secret-service": "key in the system keyring",
  file: "key in a private file outside the data folder",
  "data-file": "key in the data folder, next to the database (see SECURITY.md)",
  secret: "key from a Docker secret",
  env: "key from XIRYN_VAULT_KEY",
}

const ADDABLE: VaultKind[] = ["card", "upi", "login", "identity"]

function ago(date: Date | string | null) {
  if (!date) return "never used"
  const minutes = Math.round((Date.now() - new Date(date).getTime()) / 60_000)
  if (minutes < 60) return `used ${Math.max(1, minutes)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `used ${hours}h ago`
  return `used ${Math.round(hours / 24)}d ago`
}

export function VaultPanel() {
  const [overview, setOverview] = React.useState<Overview | null>(null)
  const [adding, setAdding] = React.useState<VaultKind | null>(null)

  const refresh = React.useCallback(async () => setOverview(await vaultOverview()), [])
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  const items: Item[] = overview?.ok ? overview.items : []

  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-surface/50 p-4">
      <div className="flex items-start gap-3">
        <LockIcon className="mt-0.5 size-4 shrink-0 text-rigel" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] font-semibold">Vault</span>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Logins, cards, UPI IDs and personal details, encrypted on this computer.
            Agents see only a masked hint like “Visa ···· 4242”; Xiryn types the values
            into the page itself. Logins fill only on their own site, and nothing is paid
            without your approval each time.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {ADDABLE.map((kind) => {
          const Icon = ICONS[kind]
          return (
            <Button
              key={kind}
              size="sm"
              variant="outline"
              onClick={() => setAdding(kind)}
            >
              <PlusIcon data-icon="inline-start" />
              <Icon className="size-3.5" />
              {VAULT_FORMS[kind].title}
            </Button>
          )
        })}
        <span className="ml-auto font-mono text-[10.5px] text-faint">
          {overview?.ok && overview.source
            ? `AES-256-GCM · ${KEY_SOURCE[overview.source]}`
            : overview && !overview.ok
              ? overview.error
              : ""}
        </span>
      </div>

      {overview === null ? (
        <Spinner className="size-4" />
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[12.5px] text-muted-foreground">
          Nothing saved yet. Add a card to let agents pay after you approve, or a login to
          sign in without asking you each time.
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {items.map((item) => {
            const Icon = ICONS[item.kind]
            return (
              <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-[13px] font-medium">{item.label}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {item.hint}
                  </span>
                </div>
                <span className="hidden font-mono text-[10.5px] text-faint sm:block">
                  {ago(item.lastUsedAt)}
                </span>
                <Confirm
                  trigger={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${item.label}`}
                    >
                      <Trash2Icon />
                    </Button>
                  }
                  title={`Delete “${item.label}”?`}
                  description="It's removed from the vault. Agents won't be able to use it again."
                  action="Delete"
                  onConfirm={async () => {
                    await removeFromVault(item.id)
                    await refresh()
                    toast.add({ type: "success", title: "Removed from the vault" })
                  }}
                />
              </li>
            )
          })}
        </ul>
      )}

      <Dialog open={!!adding} onOpenChange={(open) => !open && setAdding(null)}>
        <DialogContent className="sm:max-w-md">
          {adding && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <DialogTitle>Add {VAULT_FORMS[adding].title.toLowerCase()}</DialogTitle>
                <DialogDescription>
                  Encrypted on this computer the moment you save it. It&apos;s never shown
                  again, here or to any agent.
                </DialogDescription>
              </div>
              <VaultForm
                kind={adding}
                onCancel={() => setAdding(null)}
                onSubmit={async (data, options) => {
                  const result = await saveToVault(adding, data, options.label)
                  if (!result.ok) return result.error
                  setAdding(null)
                  await refresh()
                  toast.add({ type: "success", title: `Saved · ${result.item.hint}` })
                  return null
                }}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
