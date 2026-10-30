import { subscribe } from "@/lib/events"

// A server-sent event stream of finished turns and hand-offs, for
// notifications. Like everything else it only answers on localhost.
export async function GET(request: Request) {
  const encoder = new TextEncoder()
  let close = () => {}

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        // A client that stopped reading but whose socket is still open would
        // have heartbeats queued for it indefinitely; drop it instead
        if (controller.desiredSize !== null && controller.desiredSize < -100) {
          close()
          try {
            controller.close()
          } catch {}
          return
        }
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          close()
        }
      }
      const unsubscribe = subscribe((event) => send(`data: ${JSON.stringify(event)}\n\n`))
      // Keeps proxies and the browser from dropping an idle connection
      const heartbeat = setInterval(() => send(": keep-alive\n\n"), 25_000)
      close = () => {
        clearInterval(heartbeat)
        unsubscribe()
      }
      request.signal.addEventListener("abort", () => {
        close()
        try {
          controller.close()
        } catch {}
      })
      send("retry: 3000\n\n")
    },
    cancel() {
      close()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
