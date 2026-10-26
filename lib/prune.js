/**
 * 折叠引擎：判定 + 改写 + 落盘。
 *
 * 本文件**不依赖 ctx**（只依赖 node: 内置模块与纯函数），因此既被 `apply()`
 * 使用，也可以被测试/基准直接调用。纯判定逻辑本身在 `lib/core/prune.js`。
 *
 * 关键安全约束：**只改写文本内容，绝不删除或替换事件**。tool-call 与
 * tool-result 的配对因此始终保持完整，历史可回放。
 */

import { decideFold, buildFoldMarker, buildFoldedText, savedTokens } from './core/prune.js'
import { saveSpill } from './spill.js'
import { slugId } from './core/tokens.js'

export {
  FOLD_MARKER_PREFIX,
  decideFold,
  buildFoldMarker,
  buildFoldedText,
  savedTokens,
} from './core/prune.js'

/**
 * 折叠一组 ContentBlock。非文本块原样透传。
 *
 * @param {ReadonlyArray<object>} blocks
 * @param {{
 *   callId?: string,
 *   dir: string,
 *   pruner: { maxChars: number, keepHead: number, keepTail: number },
 *   onFold?: (info: { id: string, bytes: number, before: number, after: number, savedTokens: number }) => void,
 * }} options
 * @returns {Promise<{ content: object[], folds: Array<{ id: string, bytes: number, before: number, after: number, savedTokens: number }>, savedTokens: number }>}
 */
export async function foldContentBlocks(blocks, options) {
  const list = Array.isArray(blocks) ? blocks : []
  const dir = options?.dir
  const pruner = options?.pruner ?? { maxChars: 8000, keepHead: 2000, keepTail: 2000 }
  const baseId = slugId(options?.callId ?? 'block')
  const content = []
  const folds = []
  let totalSaved = 0

  for (let index = 0; index < list.length; index += 1) {
    const block = list[index]
    if (!block || block.type !== 'text' || typeof block.text !== 'string') {
      content.push(block)
      continue
    }

    const plan = decideFold(block.text, pruner)
    if (!plan) {
      content.push(block)
      continue
    }

    const id = `${baseId}-${index}`
    try {
      await saveSpill(dir, id, block.text)
    } catch {
      // 落盘失败就不折叠：宁可上下文大一点，也不能丢原文。
      content.push(block)
      continue
    }

    const marker = buildFoldMarker({ id, bytes: plan.bytes })
    const folded = buildFoldedText({ head: plan.head, tail: plan.tail, marker })
    const saved = savedTokens(block.text, folded)

    const info = { id, bytes: plan.bytes, before: block.text.length, after: folded.length, savedTokens: saved }
    folds.push(info)
    totalSaved += saved
    if (typeof options?.onFold === 'function') {
      try {
        options.onFold(info)
      } catch {
        // 统计回调失败不影响折叠结果。
      }
    }

    content.push({ ...block, text: folded })
  }

  return { content, folds, savedTokens: totalSaved }
}

/**
 * 扫描会话里「可以折叠」的工具结果（供 `prune` 动作使用）。
 *
 * 注意：历史事件无法被改写（session 是 append-only 的），所以这里的语义是
 * **把超长结果落盘，让它们可以通过 recall 取回**，并报告有多少条符合折叠条件。
 *
 * @param {{ ownEvents?: () => Array<object>, snapshotEvents?: (from: number, to: number) => Array<object> }} session
 * @param {{ maxChars: number, keepHead: number, keepTail: number }} pruner
 * @returns {Array<{ seq: number, callId: string, index: number, text: string, bytes: number }>}
 */
export function scanSessionForFoldables(session, pruner) {
  const events = readEvents(session)
  const out = []
  for (const event of events) {
    if (!event || event.type !== 'tool/result') continue
    const message = event.data?.message
    const blocks = Array.isArray(message?.content) ? message.content : []
    const callId = message?.toolCallId ?? event.data?.callId ?? `seq-${event.seq}`
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
      const plan = decideFold(block.text, pruner)
      if (!plan) continue
      out.push({
        seq: Number(event.seq) || 0,
        callId: String(callId),
        index,
        text: block.text,
        bytes: plan.bytes,
      })
    }
  }
  return out
}

function readEvents(session) {
  if (!session) return []
  try {
    if (typeof session.ownEvents === 'function') {
      const events = session.ownEvents()
      if (Array.isArray(events)) return events
    }
  } catch {
    // 继续尝试 snapshotEvents。
  }
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents(0, Number(session.seq) + 1)
      if (Array.isArray(events)) return events
    }
  } catch {
    // 读不到就当没有。
  }
  return []
}
