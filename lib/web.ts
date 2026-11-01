import { getSetting } from "@/lib/config"
import { readJson } from "@/lib/http"

// Web access goes through Firecrawl: search returns ranked results, fetch
// returns any page as clean markdown. Both are off without a key.

export function isWebConfigured() {
  return !!getSetting("firecrawl.apiKey")
}

async function firecrawl<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
) {
  const apiKey = getSetting("firecrawl.apiKey")
  if (!apiKey) {
    throw new Error(
      "Web access is off: add FIRECRAWL_API_KEY to .env or paste a key in Settings → Integrations."
    )
  }
  const base = (getSetting("firecrawl.apiUrl") ?? "https://api.firecrawl.dev").replace(
    /\/+$/,
    ""
  )
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(60_000),
    cache: "no-store",
  })
  // A scraped page is a few hundred KB at most; anything far bigger is refused
  const json = (await readJson(response, 20_000_000).catch(() => null)) as {
    success: boolean
    data?: T
    error?: string
  } | null
  if (!response.ok || !json?.success) {
    throw new Error(
      json?.error ?? `Firecrawl answered ${response.status} ${response.statusText}`
    )
  }
  return json.data as T
}

const clip = (text: string, max: number) =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n… ${text.length - max} more characters`

export async function webSearch(query: string, limit = 5) {
  const data = await firecrawl<{
    web?: { url: string; title?: string; description?: string }[]
  }>("/v2/search", { body: { query, limit } })

  return (data.web ?? []).map((result) => ({
    title: result.title ?? result.url,
    url: result.url,
    snippet: clip((result.description ?? "").replace(/\s+/g, " ").trim(), 400),
  }))
}

export async function webFetch(url: string, maxChars = 12_000) {
  const data = await firecrawl<{
    markdown?: string
    metadata?: { title?: string; sourceURL?: string; statusCode?: number }
  }>("/v2/scrape", { body: { url, formats: ["markdown"], onlyMainContent: true } })

  return {
    url: data.metadata?.sourceURL ?? url,
    title: data.metadata?.title ?? null,
    status: data.metadata?.statusCode ?? null,
    markdown: clip(data.markdown ?? "", maxChars),
  }
}

// Free call used by Settings to prove the key works
export async function pingFirecrawl() {
  const data = await firecrawl<{ remainingCredits?: number; planCredits?: number }>(
    "/v2/team/credit-usage",
    { method: "GET" }
  )
  return {
    remainingCredits: data.remainingCredits ?? null,
    planCredits: data.planCredits ?? null,
  }
}
