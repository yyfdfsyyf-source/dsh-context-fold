/**
 * 折叠判定与改写（纯函数，不依赖 ctx）。
 *
 * 「折叠」= 原文落盘 + 上下文里只留 head/tail + 一行可回捞标记。
 * 这里只做**判定**与**文本拼装**；落盘由 lib/spill.js 负责，
 * 因此基准测试可以直接 import 本模块验证判定逻辑。
 */

import { selectKeptRegions } from './region.js'
import { byteLength } from './tokens.js'

/** 折叠标记的固定前缀，用来识别「这段已经被折叠过」。 */
export const FOLD_MARKER_PREFIX = '[context-fold: 已折叠 '

/**
 * 判断一段文本是否需要折叠。
 *
 * @param {unknown} text
 * @param {{ maxChars?: number, keepHead?: number, keepTail?: number }} [options]
 * @returns {null | { head: string, tail: string, keptChars: number, droppedChars: number, bytes: number }}
 *   返回 null 表示不需要折叠（太短、不是字符串、或 head+tail 已覆盖全文）。
 */
export function decideFold(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return null
  const maxChars = Number.isFinite(options.maxChars) ? Math.floor(options.maxChars) : 8000
  if (maxChars <= 0) return null
  // 已经折叠过的不再重复折叠（避免多轮 listener 叠加）。
  if (text.includes(FOLD_MARKER_PREFIX)) return null
  if (text.length <= maxChars) return null

  const keepHead = normalizeCount(options.keepHead, 2000)
  const keepTail = normalizeCount(options.keepTail, 2000)
  // 头尾预算之和 >= maxChars 时，折叠省不下多少东西，不值得做。
  // （config 校验里对这条不变式有显式检查，这里保持一致。）
  if (keepHead + keepTail >= maxChars) return null

  const selection = selectKeptRegions(text, { keepHead, keepTail })
  if (!selection.truncated) return null

  const headRegion = selection.regions.find((region) => region.kind === 'head')
  const tailRegion = selection.regions.find((region) => region.kind === 'tail')
  const head = headRegion ? text.slice(headRegion.start, headRegion.end) : ''
  const tail = tailRegion ? text.slice(tailRegion.start, tailRegion.end) : ''

  return {
    head,
    tail,
    keptChars: selection.keptChars,
    droppedChars: selection.droppedChars,
    bytes: byteLength(text),
  }
}

/**
 * 生成回捞标记行。
 * @param {{ id: string, bytes: number }} input
 * @returns {string}
 */
export function buildFoldMarker(input) {
  const id = String(input?.id ?? '')
  const bytes = Number.isFinite(input?.bytes) ? input.bytes : 0
  return `\n${FOLD_MARKER_PREFIX}${id}，原文 ${bytes} 字节，用 context_fold recall ${id} 取回]\n`
}

/**
 * 拼装折叠后的文本：head + 标记 + tail。
 * @param {{ head: string, tail: string, marker: string }} input
 * @returns {string}
 */
export function buildFoldedText(input) {
  const head = typeof input?.head === 'string' ? input.head : ''
  const tail = typeof input?.tail === 'string' ? input.tail : ''
  const marker = typeof input?.marker === 'string' ? input.marker : ''
  return head + marker + tail
}

/**
 * 估算这次折叠省下的 token（粗估，chars/3.5）。
 * @param {string} before
 * @param {string} after
 * @returns {number} 非负整数
 */
function normalizeCount(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  const n = Math.floor(value)
  return n < 0 ? 0 : n
}

export function savedTokens(before, after) {
  const a = typeof before === 'string' ? before.length : 0
  const b = typeof after === 'string' ? after.length : 0
  const delta = a - b
  if (delta <= 0) return 0
  return Math.ceil(delta / 3.5)
}
