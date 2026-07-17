function padDatePart(value: number): string {
  return value.toString().padStart(2, '0')
}

/**
 * Formats a timestamp as `[本地时间 YYYY-MM-DD HH:MM:SS]\n` in the user's local timezone.
 *
 * Use when:
 * - Annotating user messages so the model has a concrete time anchor on
 *   every turn — historic and current user turns use the same shape so that
 *   prefix-cache stays valid when a "current" turn becomes "historic" on
 *   the next send.
 * - Not used for assistant messages — that caused the model to mirror the
 *   prefix into its own output.
 *
 * Returns:
 * - String including a trailing newline, e.g. `"[本地时间 2026-04-25 18:47:12]\n"`.
 *
 * Before:
 * - createdAt = 1745570820000  (a Unix ms in Asia/Shanghai)
 *
 * After:
 * - "[本地时间 2026-04-25 18:47:00]\n"
 */
export function formatTimePrefix(createdAt: number): string {
  const date = new Date(createdAt)
  const year = date.getFullYear()
  const month = padDatePart(date.getMonth() + 1)
  const day = padDatePart(date.getDate())
  const hour = padDatePart(date.getHours())
  const minute = padDatePart(date.getMinutes())
  const second = padDatePart(date.getSeconds())

  return `[本地时间 ${year}-${month}-${day} ${hour}:${minute}:${second}]\n`
}
