/**
 * 「保留区域」选择（纯函数，不依赖 ctx）。
 *
 * 折叠一个超长文本时，我们不是简单截断，而是显式挑出 **head 区** 与
 * **tail 区**，中间被丢弃的区间由调用方落盘。这里只负责计算区间，
 * 不碰文件系统，因此可被基准测试直接 import。
 */

/**
 * 选出要保留的区间。
 *
 * @param {string} text 原文
 * @param {{ keepHead?: number, keepTail?: number }} [options]
 * @returns {{ regions: Array<{ kind: 'head' | 'tail', start: number, end: number }>, dropped: Array<{ start: number, end: number }>, keptChars: number, droppedChars: number, truncated: boolean }}
 *   `start` 含、`end` 不含。
 */
export function selectKeptRegions(text, options = {}) {
  const source = typeof text === 'string' ? text : ''
  const length = source.length
  const keepHead = normalizeCount(options.keepHead, 2000)
  const keepTail = normalizeCount(options.keepTail, 2000)

  if (length === 0) {
    return { regions: [], dropped: [], keptChars: 0, droppedChars: 0, truncated: false }
  }

  // 两边预算之和超过全文时没有可丢弃的区间，不折叠。
  if (keepHead + keepTail >= length) {
    return {
      regions: [{ kind: 'head', start: 0, end: length }],
      dropped: [],
      keptChars: length,
      droppedChars: 0,
      truncated: false,
    }
  }

  const regions = []
  if (keepHead > 0) regions.push({ kind: 'head', start: 0, end: keepHead })
  if (keepTail > 0) regions.push({ kind: 'tail', start: length - keepTail, end: length })

  const dropped = []
  const dropStart = keepHead
  const dropEnd = length - keepTail
  if (dropEnd > dropStart) dropped.push({ start: dropStart, end: dropEnd })

  const keptChars = regions.reduce((sum, region) => sum + (region.end - region.start), 0)
  return {
    regions,
    dropped,
    keptChars,
    droppedChars: length - keptChars,
    truncated: dropped.length > 0,
  }
}

/**
 * 按区间拼回文本。
 * @param {string} text
 * @param {ReadonlyArray<{ start: number, end: number }>} regions
 * @returns {string}
 */
export function sliceRegions(text, regions) {
  const source = typeof text === 'string' ? text : ''
  const list = Array.isArray(regions) ? regions : []
  let out = ''
  for (const region of list) {
    const start = Math.max(0, Math.min(source.length, region.start | 0))
    const end = Math.max(start, Math.min(source.length, region.end | 0))
    out += source.slice(start, end)
  }
  return out
}

function normalizeCount(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  const n = Math.floor(value)
  return n < 0 ? 0 : n
}
