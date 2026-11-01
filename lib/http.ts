// Reads a response body as JSON, refusing one larger than `maxBytes`. A
// service answering with something huge (or endless) shouldn't be able to
// fill the server's memory.
export async function readJson<T>(
  response: Response,
  maxBytes: number
): Promise<T | null> {
  if (!response.body) return null
  const declared = Number(response.headers.get("content-length"))
  if (declared > maxBytes) {
    await response.body.cancel()
    throw new Error(`The response was larger than ${Math.round(maxBytes / 1e6)} MB.`)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error(`The response was larger than ${Math.round(maxBytes / 1e6)} MB.`)
    }
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T
  } catch {
    return null
  }
}
