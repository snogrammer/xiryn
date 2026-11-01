import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { getSetting } from "@/lib/config"
import { getProviderMeta } from "@/lib/providers/catalog"
import { readJson } from "@/lib/http"

// Ollama on this computer: what's running, what's downloaded, and pulls.
// Only ever talks to the Ollama endpoint configured for Xiryn (by default
// 127.0.0.1), never anywhere else.

export type LocalModel = {
  name: string
  size: number
  parameters?: string
  family?: string
}

export type RecommendedModel = {
  model: string
  size: string
  note: string
  // Smallest total memory it's comfortable on, in GB
  minMemory: number
}

// Tool calling and vision, so agents can also work their desktop
export const recommendedModels: RecommendedModel[] = [
  {
    model: "qwen3.5:2b",
    size: "2.7 GB",
    note: "Light. Chat and simple tasks",
    minMemory: 0,
  },
  {
    model: "qwen3.5:4b",
    size: "3.3 GB",
    note: "Good balance for 16 GB machines",
    minMemory: 12,
  },
  {
    model: "gemma4:e4b",
    size: "6.6 GB",
    note: "Google's efficient small model",
    minMemory: 16,
  },
  {
    model: "qwen3.5:9b",
    size: "6.6 GB",
    note: "Better reasoning and desktop use",
    minMemory: 20,
  },
  {
    model: "qwen3.6:27b",
    size: "about 17 GB",
    note: "Strongest; needs a big machine",
    minMemory: 40,
  },
]

export function memoryGb() {
  return Math.round(os.totalmem() / 1024 ** 3)
}

// The largest recommended model this machine can comfortably run
export function bestModelForThisMachine() {
  const gb = os.totalmem() / 1024 ** 3
  const fits = recommendedModels.filter(
    (m) => m.minMemory <= gb && m.model !== "gemma4:e4b"
  )
  return fits[fits.length - 1]?.model ?? recommendedModels[0].model
}

// The configured OpenAI-style endpoint ("…/v1") without its suffix, which is
// where Ollama's own API lives
export function ollamaRoot() {
  const meta = getProviderMeta("ollama")!
  const base = (getSetting("provider.ollama.baseUrl") ?? meta.defaultBaseUrl).replace(
    /\/+$/,
    ""
  )
  return base.replace(/\/v1$/, "")
}

export async function ollamaStatus() {
  const root = ollamaRoot()
  try {
    const version = await fetch(`${root}/api/version`, {
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    })
    if (!version.ok) throw new Error(`${version.status}`)
    const tags = await fetch(`${root}/api/tags`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    })
    const json = ((await readJson(tags, 5_000_000)) ?? {}) as {
      models?: {
        name: string
        size: number
        details?: { parameter_size?: string; family?: string }
      }[]
    }
    const models = json.models ?? []
    return {
      running: true as const,
      root,
      version: ((await version.json()) as { version?: string }).version ?? null,
      models: models.map((m): LocalModel => ({
        name: m.name,
        size: m.size,
        parameters: m.details?.parameter_size,
        family: m.details?.family,
      })),
    }
  } catch {
    return { running: false as const, root, version: null, models: [] as LocalModel[] }
  }
}

/* Context. Unless told otherwise, Ollama runs a model with a small context
   (4K on many machines) and quietly cuts longer prompts, which drops most of
   an agent's instructions. Xiryn asks for enough with every request, through
   Ollama's own API, so the models themselves are left as they are. */

export function agentContext() {
  return os.totalmem() / 1024 ** 3 < 12 ? 16_384 : 32_768
}

// How long Ollama keeps a model loaded after a request, so the next step of
// a turn doesn't wait for it to load again
export const OLLAMA_KEEP_ALIVE = "30m"

// Model names as Ollama writes them: "qwen3.5:9b", "library/name:tag"
export const OLLAMA_MODEL = /^[a-z0-9][a-z0-9._/-]{0,80}(:[a-z0-9._-]{1,60})?$/i

/* Downloads. Ollama streams progress as lines of JSON; the latest line per
   model is kept here so Settings can follow along by polling. */

export type PullState =
  | { model: string; state: "pulling"; status: string; completed: number; total: number }
  | { model: string; state: "done" }
  | { model: string; state: "failed"; error: string }

const globalForPulls = globalThis as unknown as {
  xirynOllamaPulls?: Map<string, PullState>
}
const pulls = (globalForPulls.xirynOllamaPulls ??= new Map())

export function pullStates() {
  return [...pulls.values()]
}

export function pullModel(model: string) {
  if (pulls.get(model)?.state === "pulling") return
  pulls.set(model, {
    model,
    state: "pulling",
    status: "starting",
    completed: 0,
    total: 0,
  })
  void (async () => {
    try {
      // A pull can take an hour on a slow line, so there's no overall limit;
      // it fails only when Ollama goes quiet for two minutes
      const stalled = new AbortController()
      let quiet = setTimeout(() => stalled.abort(), 120_000)
      const alive = () => {
        clearTimeout(quiet)
        quiet = setTimeout(() => stalled.abort(), 120_000)
      }
      const response = await fetch(`${ollamaRoot()}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true }),
        signal: stalled.signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const layers = new Map<string, { total: number; completed: number }>()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        alive()
        buffer += decoder.decode(value, { stream: true })
        if (buffer.length > 1_000_000)
          throw new Error("Ollama sent an unreadable answer.")
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line) as {
            status?: string
            digest?: string
            completed?: number
            total?: number
            error?: string
          }
          if (event.error) throw new Error(event.error)
          // A model comes in several layers; progress is their sum
          if (event.digest && event.total) {
            layers.set(event.digest, {
              total: event.total,
              completed: event.completed ?? 0,
            })
          }
          const sizes = [...layers.values()]
          pulls.set(model, {
            model,
            state: "pulling",
            status: event.digest ? "downloading" : (event.status ?? ""),
            completed: sizes.reduce((sum, layer) => sum + layer.completed, 0),
            total: sizes.reduce((sum, layer) => sum + layer.total, 0),
          })
        }
      }
      clearTimeout(quiet)
      pulls.set(model, { model, state: "done" })
    } catch (error) {
      pulls.set(model, {
        model,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })()
}

/* Starting Ollama when it's installed but not running */

export function ollamaBinary() {
  const candidates = [
    "ollama",
    ...(process.platform === "win32"
      ? [
          path.join(
            /*turbopackIgnore: true*/ process.env.LOCALAPPDATA ?? "",
            "Programs",
            "Ollama",
            "ollama.exe"
          ),
        ]
      : process.platform === "darwin"
        ? [
            "/usr/local/bin/ollama",
            "/opt/homebrew/bin/ollama",
            "/Applications/Ollama.app/Contents/Resources/ollama",
          ]
        : ["/usr/local/bin/ollama", "/usr/bin/ollama"]),
  ]
  for (const candidate of candidates) {
    const result = spawnSync(/*turbopackIgnore: true*/ candidate, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    })
    if (!result.error && result.status === 0) return candidate
  }
  return null
}

export async function startOllama() {
  const binary = ollamaBinary()
  if (!binary) throw new Error("Ollama isn't installed on this computer.")
  if (process.platform === "darwin" && existsSync("/Applications/Ollama.app")) {
    spawn("open", ["-a", "Ollama"], { detached: true, stdio: "ignore" }).unref()
  } else {
    spawn(/*turbopackIgnore: true*/ binary, ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref()
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if ((await ollamaStatus()).running) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error("Ollama didn't start. Open it yourself, or run `ollama serve`.")
}
