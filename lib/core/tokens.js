/**
 * Token 估算与长度工具（纯函数，不依赖 ctx）。
 *
 * 这里刻意使用一个粗糙的常数 3.5 chars/token：它只用于「大概省了多少」的
 * 展示与注入预算截断，**不是**精确计量。真正的精确计量请用 harness 的
 * `tokenMeter` 服务（本插件不注入它，以便在没有该服务时也能工作）。
 */

/** 粗估比例：3.5 个字符 ≈ 1 个 token。 */
export const CHARS_PER_TOKEN = 3.5

/**
 * 粗估文本 token 数。
 * @param {unknown} text
 * @returns {number} 向上取整的估算值；非字符串返回 0。
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * 把 token 预算换算成字符预算。
 * @param {number} maxTokens
 * @returns {number} 字符数；非法输入返回 0。
 */
export function maxCharsForTokens(maxTokens) {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return 0
  return Math.floor(maxTokens * CHARS_PER_TOKEN)
}

/**
 * 按 token 预算截断文本。
 * @param {unknown} text
 * @param {number} maxTokens
 * @returns {string}
 */
export function truncateToTokens(text, maxTokens) {
  const limit = maxCharsForTokens(maxTokens)
  if (!limit || typeof text !== 'string') return ''
  return text.length <= limit ? text : text.slice(0, limit)
}

/**
 * UTF-8 字节长度。
 * @param {unknown} text
 * @returns {number}
 */
export function byteLength(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 由任意字符串派生一个可安全用作文件名的稳定 id。
 * @param {unknown} value
 * @returns {string}
 */
export function slugId(value) {
  const raw = typeof value === 'string' ? value : String(value ?? '')
  const cleaned = raw.replace(/[^0-9A-Za-z_-]/g, '').slice(0, 64)
  return cleaned.length > 0 ? cleaned : 'unknown'
}
