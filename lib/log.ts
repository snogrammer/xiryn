// What's safe to print about an error. Provider SDK errors can carry the
// whole request (the prompt, memories, tool output), so only the name,
// message and status codes are logged unless XIRYN_DEBUG is set.
export function safeError(error: unknown) {
  if (process.env.XIRYN_DEBUG) return error
  if (!(error instanceof Error)) return String(error)
  const { statusCode, status, code } = error as {
    statusCode?: number
    status?: number
    code?: string
  }
  return {
    name: error.name,
    message: error.message,
    ...((statusCode ?? status) !== undefined && { status: statusCode ?? status }),
    ...(code !== undefined && { code }),
  }
}
