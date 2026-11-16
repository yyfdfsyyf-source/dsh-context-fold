/**
 * 折叠账本：记录「被遮蔽/折叠的内容」，让它们仍然可检索回捞。
 *
 * 与 billion-context（ACP）的关系是**互补**：
 * ACP 负责把旧内容遮蔽以省 context；被遮蔽后原文就不再出现在模型眼前。
 * 本账本把「哪个 block、遮蔽了哪段 seq、多少 token、摘要是什么」持久化下来，
 * 于是 `context_fold recall <关键词>` 还能把摘要片段找回来，并给出精确 seq 范围，
 * 让模型知道该去哪里取原文。
 *
 * 真实环境（2026-11 实测）有三类来源，全部入账：
 *   1. `compaction/summary` —— DSH 原生压缩后端（dsh-compaction-basic / /compact）。
 *      ⚠️ 在 billion-context 接管的 lane 上**永不触发**：bili 会主动拒绝 DSH 原生
 *      compaction（`dsh_compaction_refused: bili owns compression on this lane`），
 *      否则落地的 checkpoint 会遮蔽原始历史、破坏 bili 的压缩基质。
 *      因此仅靠监听这个事件会让账本完全空置（本插件 v0.1.3 的实际缺陷）。
 *   2. `compaction/prune` —— billion-context 实际产生的遮蔽事件，真实 payload 为
 *      `{ shadowedRange: {start,end}, shadowedSeqs: number[], shadowedTokenCount }`。
 *      它没有摘要字段，本模块会从被遮蔽事件的文本里抽一段 preview 供 BM25 检索。
 *   3. 本插件自身的折叠（post-execute 阶段的超长工具结果）——由 `recordFromFold()` 记录。
 *      这才是在 bili lane 上真实发生的上下文缩减，必须入账才能 `recall` 关键词命中。
 *
 * 落盘：`<DSH_HOME>/context-fold/ledger.jsonl`，每行一条。
 */

import { appendJsonl, readJsonl, trimJsonl } from './store.js'
import { createIndex, search as bm25Search, compareId } from './core/bm25.js'

/**
 * 从 `session/event` 事件里抽出账本记录。
 *
 * **真实 payload**（`@deepseek-ai/dsh-compaction-basic` 的 `commitCompactionBody`）：
 *   `{ compactionId, sourceCommandId?, summary, rawOutput?, llmStreamCall?,
 *      shadowedRange: { start, end }, shadowedSeqs: number[],
 *      shadowedTokenCount, provider, model, maxTokens?, usage? }`
 * 注意：**没有** `blockId`，也**没有**顶层 `startSeq` / `endSeq`。
 * 这里做映射：blockId ← compactionId，startSeq ← shadowedRange.start，
 * endSeq ← shadowedRange.end。同时保留 summarySeq / sessionId 便于精确定位。
 *
 * @param {{ id?: string, eventAt?: Function }} session
 * @param {{ type?: string, seq?: number, time?: number, data?: object }} event
 * @returns {object | null} 非折叠类事件返回 null。
 */
export function recordFromSessionEvent(session, event) {
  if (!event) return null
  const data = event.data ?? {}

  if (event.type === 'compaction/summary') {
    const blockId = String(data.compactionId ?? data.blockId ?? `seq-${event.seq ?? 0}`)
    const startSeq = toInt(data.shadowedRange?.start ?? data.startSeq, 0)
    const endSeq = toInt(data.shadowedRange?.end ?? data.endSeq, startSeq)
    const summary = typeof data.summary === 'string' ? data.summary : ''
    return {
      blockId,
      startSeq,
      endSeq,
      shadowedTokenCount: toInt(data.shadowedTokenCount, 0),
      summary,
      source: 'compaction-summary',
      ts: Number.isFinite(event.time) ? event.time : Date.now(),
      summarySeq: Number.isFinite(event.seq) ? event.seq : 0,
      sessionId: typeof session?.id === 'string' ? session.id : '',
      shadowedCount: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0,
    }
  }

  // billion-context 接管的 lane 上真实发生的遮蔽事件。它没有 summary 字段，
  // 这里从被遮蔽的 seq 里抽一段文本 preview 供 BM25 检索。
  if (event.type === 'compaction/prune') {
    const startSeq = toInt(data.shadowedRange?.start ?? data.startSeq, 0)
    const endSeq = toInt(data.shadowedRange?.end ?? data.endSeq, startSeq)
    const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
    const preview = previewFromSession(session, seqs.length > 0 ? seqs : [startSeq, endSeq])
    const blockId = `prune-${startSeq}-${endSeq}-${event.seq ?? 0}`
    return {
      blockId,
      startSeq,
      endSeq,
      shadowedTokenCount: toInt(data.shadowedTokenCount, 0),
      summary: preview,
      source: 'compaction-prune',
      ts: Number.isFinite(event.time) ? event.time : Date.now(),
      summarySeq: Number.isFinite(event.seq) ? event.seq : 0,
      sessionId: typeof session?.id === 'string' ? session.id : '',
      shadowedCount: seqs.length,
    }
  }

  return null
}

/**
 * 从本插件自身的一次折叠生成账本记录。
 *
 * 让 `context_fold recall <关键词>` 能对「被本插件折叠的超长工具结果」做 BM25 命中。
 * 精确 id 回捞本来就走 spill 文件；这里补的是关键词检索通路。
 *
 * @param {object} info foldContentBlocks 的 onFold 信息 { id, bytes, before, after, savedTokens }
 * @param {{ sessionId?: string, callId?: string, originalText?: string, seq?: number, time?: number }} [extra]
 * @returns {object}
 */
export function recordFromFold(info, extra = {}) {
  const id = String(info?.id ?? 'unknown')
  const original = typeof extra.originalText === 'string' ? extra.originalText : ''
  return {
    blockId: id,
    startSeq: Number.isFinite(extra.seq) ? extra.seq : 0,
    endSeq: Number.isFinite(extra.seq) ? extra.seq : 0,
    // 摘要用原文头部，BM25 才能按关键词命中；长度限制避免账本膨胀。
    summary: original.slice(0, 1200),
    source: 'self-fold',
    bytes: toInt(info?.bytes, byteLengthSafe(original)),
    savedTokens: toInt(info?.savedTokens, 0),
    callId: typeof extra.callId === 'string' ? extra.callId : '',
    ts: Number.isFinite(extra.time) ? extra.time : Date.now(),
    sessionId: typeof extra.sessionId === 'string' ? extra.sessionId : '',
    summarySeq: 0,
    shadowedCount: 1,
  }
}

/** 从 session 的若干 seq 里抽文本 preview（tool/result、user/message 等）。 */
function previewFromSession(session, seqs, maxChars = 1200) {
  if (!session || typeof session.eventAt !== 'function' || !Array.isArray(seqs)) return ''
  const parts = []
  let total = 0
  for (const seq of seqs) {
    if (total >= maxChars) break
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      continue
    }
    const text = textOfEvent(event)
    if (!text) continue
    parts.push(text)
    total += text.length
  }
  return parts.join('\n').slice(0, maxChars)
}

/** 从一个 session event 里抽出可读文本。 */
function textOfEvent(event) {
  const data = event?.data ?? {}
  const blocks = Array.isArray(data.message?.content)
    ? data.message.content
    : (Array.isArray(data.content) ? data.content : null)
  if (blocks) {
    return blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  if (typeof data.text === 'string') return data.text
  return ''
}

function byteLengthSafe(text) {
  try {
    return Buffer.byteLength(text, 'utf8')
  } catch {
    return text.length
  }
}

/**
 * 创建账本访问器。
 *
 * @param {{ file: string, maxBlocks?: number, logger?: { warn?: Function, debug?: Function } }} options
 */
export function createLedger(options) {
  const file = options.file
  const maxBlocks = Number.isFinite(options.maxBlocks) ? Math.floor(options.maxBlocks) : 2000
  const logger = options.logger ?? {}
  let cache

  async function load() {
    if (cache) return cache
    cache = await readJsonl(file)
    return cache
  }

  return {
    file,

    /**
     * 追加一条记录（写入后让缓存失效）。
     * @param {object} record
     * @returns {Promise<boolean>} 成功与否，失败不抛错。
     */
    async append(record) {
      if (!record || typeof record !== 'object') return false
      try {
        await appendJsonl(file, record)
        cache = undefined
        if (maxBlocks > 0) {
          const records = await readJsonl(file)
          if (records.length > maxBlocks) await trimJsonl(file, maxBlocks)
        }
        return true
      } catch (error) {
        safeWarn(logger, `ledger 写入失败：${describe(error)}`)
        return false
      }
    },

    /** @returns {Promise<object[]>} 全部记录（新的在后）。 */
    async all() {
      try {
        return await load()
      } catch (error) {
        safeWarn(logger, `ledger 读取失败：${describe(error)}`)
        return []
      }
    },

    /**
     * 最近 N 条。
     * @param {number} [n]
     * @returns {Promise<object[]>}
     */
    async recent(n = 20) {
      const records = await this.all()
      const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 20
      return records.slice(Math.max(0, records.length - limit))
    },

    /** @returns {Promise<number>} */
    async count() {
      const records = await this.all()
      return records.length
    },

    /**
     * 回捞：先按 id（blockId / summarySeq）精确匹配，否则 BM25。
     *
     * @param {string} query
     * @param {number} [topK]
     * @returns {Promise<{ mode: 'id' | 'bm25' | 'none', hits: Array<object> }>}
     */
    async recall(query, topK = 5) {
      const q = typeof query === 'string' ? query.trim() : ''
      const records = await this.all()
      if (q.length === 0 || records.length === 0) return { mode: 'none', hits: [] }

      const exact = records.filter((record) => String(record.blockId) === q || String(record.summarySeq) === q)
      if (exact.length > 0) {
        return {
          mode: 'id',
          hits: exact
            .sort((a, b) => compareId(a.blockId, b.blockId))
            .map((record) => ({ ...record, score: 1 })),
        }
      }

      const docs = records.map((record, index) => ({
        id: `${record.blockId}#${index}`,
        text: `${record.summary ?? ''}`,
        record,
      }))
      const index = createIndex(docs)
      const hits = bm25Search(index, q, Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 5)
        .map((row) => ({ ...row.doc.record, score: Number(row.score.toFixed(4)) }))

      return { mode: hits.length > 0 ? 'bm25' : 'none', hits }
    },
  }
}

function toInt(value, fallback) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback
}

function safeWarn(logger, message) {
  try {
    logger.warn?.(message)
  } catch {
    // 日志本身不能成为故障点。
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
