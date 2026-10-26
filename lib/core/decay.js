/**
 * 记忆衰减打分与注入预算选择（纯函数，不依赖 ctx）。
 *
 * 打分公式（刻意简单、可解释、可测）：
 *   score = relevance * 1.0 + recency * 0.5
 * 其中
 *   relevance = 该条记忆的 BM25 分 / 本次候选集的最高 BM25 分（归一化到 0..1）
 *   recency   = 0.5 ^ (ageDays / halfLifeDays)   —— 半衰期 30 天
 *
 * 没有查询词（或全都不命中）时 relevance 全为 0，排序自然退化为「越新越前」。
 *
 * **排序必须稳定**：先按 score 降序，同分按 id 升序。
 */

import { createIndex, scoreIndex, compareId } from './bm25.js'
import { estimateTokens } from './tokens.js'

/** 记忆衰减半衰期的默认值（天）。 */
export const DEFAULT_HALF_LIFE_DAYS = 30

/**
 * 时间衰减因子。
 * @param {number} ts 记录时间（epoch ms）
 * @param {number} now 当前时间（epoch ms）
 * @param {number} halfLifeDays 半衰期（天）
 * @returns {number} (0, 1]
 */
export function decayFactor(ts, now, halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  const recorded = Number.isFinite(ts) ? ts : now
  const current = Number.isFinite(now) ? now : Date.now()
  const halfLife = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : DEFAULT_HALF_LIFE_DAYS
  const ageDays = Math.max(0, (current - recorded) / 86_400_000)
  return Math.pow(0.5, ageDays / halfLife)
}

/**
 * 对记忆条目排序（稳定）。
 *
 * @param {ReadonlyArray<{ id: string, text?: string, ts?: number }>} entries
 * @param {string} query 可为空
 * @param {{ now?: number, halfLifeDays?: number }} [options]
 * @returns {Array<{ id: string, entry: object, score: number, relevance: number, recency: number }>}
 */
export function rankMemories(entries, query, options = {}) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === 'object') : []
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const halfLifeDays = Number.isFinite(options.halfLifeDays) ? options.halfLifeDays : DEFAULT_HALF_LIFE_DAYS
  const q = typeof query === 'string' ? query.trim() : ''

  const index = createIndex(list.map((entry) => ({ id: String(entry.id ?? ''), text: String(entry.text ?? ''), entry })))
  const scored = q.length > 0 ? scoreIndex(index, q) : index.items.map((item) => ({ id: item.id, doc: item.doc, score: 0 }))
  const maxScore = scored.reduce((max, row) => (row.score > max ? row.score : max), 0)

  const ranked = scored.map((row) => {
    const entry = row.doc?.entry ?? {}
    const relevance = maxScore > 0 ? row.score / maxScore : 0
    const recency = decayFactor(Number(entry.ts), now, halfLifeDays)
    return {
      id: row.id,
      entry,
      score: relevance * 1.0 + recency * 0.5,
      relevance,
      recency,
    }
  })

  ranked.sort((a, b) => (b.score - a.score) || compareId(a.id, b.id))
  return ranked
}

/**
 * 在 token 预算内挑出要注入的条目。
 *
 * 规则：按排名依次加入，累计估算 token 不超过 `maxTokens`；
 * 一条都放不下时，把第一条按预算截断（保证注入非空且确定）。
 *
 * @param {ReadonlyArray<{ id: string, entry: object, score: number }>} ranked
 * @param {{ limit?: number, maxTokens?: number }} [options]
 * @returns {{ selected: Array<{ id: string, text: string, type?: string, ts?: number, score: number }>, usedTokens: number, truncated: boolean }}
 */
export function selectWithinBudget(ranked, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 6
  const maxTokens = Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? Math.floor(options.maxTokens) : 1200
  const list = Array.isArray(ranked) ? ranked : []

  const selected = []
  let usedTokens = 0
  let truncated = false

  for (const row of list) {
    if (selected.length >= limit) break
    const text = String(row?.entry?.text ?? '')
    if (text.length === 0) continue
    const tokens = estimateTokens(text)
    if (usedTokens + tokens <= maxTokens) {
      selected.push({ id: row.id, text, type: row.entry?.type, ts: row.entry?.ts, score: row.score })
      usedTokens += tokens
      continue
    }
    if (selected.length === 0) {
      const budgetChars = Math.max(0, Math.floor((maxTokens - usedTokens) * 3.5))
      if (budgetChars > 0) {
        selected.push({ id: row.id, text: text.slice(0, budgetChars), type: row.entry?.type, ts: row.entry?.ts, score: row.score })
        usedTokens += estimateTokens(text.slice(0, budgetChars))
        truncated = true
      }
    }
    break
  }

  return { selected, usedTokens, truncated }
}

/**
 * 判断注入缓存是否需要重建。
 *
 * **为什么需要这个函数**：system prompt 是 provider 前缀缓存的核心。
 * 如果每一步都按最新记忆重新渲染，前缀就会不停变化，缓存命中率归零。
 * 因此只在下面两种情况刷新内容：
 *   1. 新增记忆数 ≥ 2（`threshold`）；
 *   2. 发生了显式 recall（`recallEpoch` 递增）。
 *
 * @param {{ built: boolean, count: number, recallEpoch: number, lastRecallEpoch: number }} cache
 * @param {number} totalCount 当前记忆总条数
 * @param {number} recallEpoch 当前 recall 代数
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function shouldRefreshInjection(cache, totalCount, recallEpoch, threshold = 2) {
  if (!cache || cache.built !== true) return true
  if (Number(recallEpoch) > Number(cache.lastRecallEpoch ?? 0)) return true
  return Number(totalCount) - Number(cache.count ?? 0) >= threshold
}
