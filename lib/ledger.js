/**
 * 折叠账本：记录每一次 compaction 折叠的「被遮蔽区间」，让内容仍然可检索回捞。
 *
 * 与 billion-context（ACP）的关系是**互补**：
 * ACP 负责把旧内容折叠/遮蔽以省 context；被遮蔽后原文就不再出现在模型眼前。
 * 本账本把「哪个 block、遮蔽了哪段 seq、多少 token、摘要是什么」持久化下来，
 * 于是 `context_fold recall <关键词>` 还能把摘要片段找回来，并给出精确 seq 范围，
 * 让模型知道该去哪里取原文。
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
 * @param {{ id?: string }} session
 * @param {{ type?: string, seq?: number, time?: number, data?: object }} event
 * @returns {object | null} 非 compaction/summary 事件返回 null。
 */
export function recordFromSessionEvent(session, event) {
  if (!event || event.type !== 'compaction/summary') return null
  const data = event.data ?? {}

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
    ts: Number.isFinite(event.time) ? event.time : Date.now(),
    // 附加字段：便于精确定位与去重（不改变约定的核心字段）。
    summarySeq: Number.isFinite(event.seq) ? event.seq : 0,
    sessionId: typeof session?.id === 'string' ? session.id : '',
    shadowedCount: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0,
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
