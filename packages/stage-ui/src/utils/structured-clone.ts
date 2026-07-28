import { toRaw } from 'vue'

/**
 * Normalizes renderer-owned values for structured-clone transport.
 *
 * Before:
 * - A Pinia/Vue reactive data graph containing nested proxies.
 *
 * After:
 * - A detached JSON data graph accepted by BroadcastChannel and Eventa.
 */
export function toStructuredCloneSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, nested) => {
    return nested && typeof nested === 'object' ? toRaw(nested) : nested
  })) as T
}
