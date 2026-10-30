import { readScreenFile } from "@/lib/screens"

// A saved screenshot, for the transcript. Behind proxy.ts like every route.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ threadId: string; screenId: string }> }
) {
  const { threadId, screenId } = await params
  const image = readScreenFile(`${threadId}/${screenId}`)
  if (!image) return new Response("Screenshot not kept.", { status: 404 })
  // A saved screenshot never changes, but it can expire or go with its
  // thread, so the browser checks back each time (a 304 while it exists)
  // rather than keeping a deleted one in its cache
  const headers = {
    "cache-control": "private, no-cache",
    etag: `"${threadId}/${screenId}"`,
  }
  if (request.headers.get("if-none-match") === headers.etag) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(new Uint8Array(image), {
    headers: { ...headers, "content-type": "image/jpeg" },
  })
}
