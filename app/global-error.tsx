"use client"

import { useEffect } from "react"

import { reportClientError } from "@/lib/sentry-client"

// The last resort when even the root layout fails to render
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error(error)
    reportClientError(error)
  }, [error])

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <h1 style={{ fontSize: "1.1rem" }}>
          Xiryn hit an error it couldn&apos;t recover from.
        </h1>
        <p>Reload the page. If it keeps happening, the server log has the details.</p>
      </body>
    </html>
  )
}
