"use client"

import { memo, useState, type ComponentProps } from "react"
import { createCodePlugin } from "@streamdown/code"
import { ImageIcon } from "lucide-react"
import { Streamdown } from "streamdown"

import { cn } from "@/lib/utils"

const code = createCodePlugin({ themes: ["github-light", "github-dark-dimmed"] })

// An image in an agent's reply is a request to whatever address it names,
// made the moment it renders. An agent that read a hostile page could put
// your data in that address, so remote images wait for a click.
function RemoteImage({ src, alt }: ComponentProps<"img">) {
  const [shown, setShown] = useState(false)
  const url = typeof src === "string" ? src : ""
  if (!/^https?:/i.test(url)) return null
  if (shown) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={alt ?? ""} className="max-w-full rounded-md border" />
  }
  let host = ""
  try {
    host = new URL(url).host
  } catch {}
  if (!host) return null
  return (
    <button
      type="button"
      onClick={() => setShown(true)}
      className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 font-mono text-[11.5px] text-muted-foreground hover:bg-surface"
      title={url}
    >
      <ImageIcon className="size-3.5" />
      load image from {host}
      {alt ? ` · ${alt}` : ""}
    </button>
  )
}

const components = { img: RemoteImage }

export const Markdown = memo(function Markdown({
  children,
  streaming,
  className,
}: {
  children: string
  streaming?: boolean
  className?: string
}) {
  return (
    <Streamdown
      className={cn("prose-xiryn min-w-0", className)}
      plugins={{ code }}
      components={components}
      isAnimating={streaming}
      parseIncompleteMarkdown
    >
      {children}
    </Streamdown>
  )
})
