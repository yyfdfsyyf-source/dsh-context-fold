/**
 * 中文 bigram BM25（纯函数，不依赖 ctx）。
 *
 * 分词策略：
 *  - CJK 连续片段按 **字 bigram** 切分（单字段落退化为该字本身）；
 *  - 拉丁字母 / 数字按单词切分并小写；
 *  - 其它字符视作分隔符。
 *
 * 这样中文不需要词典就能获得可用的检索质量，且对「折叠」「上下文」这类
 * 双字术语的匹配效果明显好于整串匹配。
 *
 * 打分使用标准 BM25：k1 = 1.2，b = 0.75。
 */

/** BM25 参数（固定值，符合设计约定）。 */
export const BM25_K1 = 1.2
/** BM25 参数（固定值，符合设计约定）。 */
export const BM25_B = 0.75

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/
const WORD_RE = /[0-9A-Za-z_]/

/**
 * 把文本切成检索词项。
 * @param {unknown} text
 * @returns {string[]} 词项序列（可重复，用于统计词频）。
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const out = []
  let cjkRun = []
  let wordRun = []

  const flushCjk = () => {
    if (cjkRun.length === 1) out.push(cjkRun[0])
    else {
      for (let i = 0; i + 1 < cjkRun.length; i += 1) out.push(cjkRun[i] + cjkRun[i + 1])
    }
    cjkRun = []
  }
  const flushWord = () => {
    if (wordRun.length > 0) {
      out.push(wordRun.join(''))
      wordRun = []
    }
  }

  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      flushWord()
      cjkRun.push(ch)
    } else if (WORD_RE.test(ch)) {
      flushCjk()
      wordRun.push(ch.toLowerCase())
    } else {
      flushCjk()
      flushWord()
    }
  }
  flushCjk()
  flushWord()
  return out
}

/** 稳定的 id 比较器：同分时按 id 升序，保证排序确定。 */
export function compareId(a, b) {
  const x = String(a ?? '')
  const y = String(b ?? '')
  if (x < y) return -1
  if (x > y) return 1
  return 0
}

/**
 * 建立内存倒排索引。
 * @param {ReadonlyArray<{ id: string, text?: string }>} docs
 * @returns {{ items: Array<{ id: string, doc: object, tf: Map<string, number>, len: number }>, df: Map<string, number>, avgdl: number, N: number }}
 */
export function createIndex(docs) {
  const list = Array.isArray(docs) ? docs : []
  const df = new Map()
  const items = []
  let totalLen = 0

  for (const doc of list) {
    if (!doc || typeof doc !== 'object') continue
    const tokens = tokenize(typeof doc.text === 'string' ? doc.text : '')
    const tf = new Map()
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1)
    totalLen += tokens.length
    items.push({ id: String(doc.id ?? ''), doc, tf, len: tokens.length })
  }

  const N = items.length
  return { items, df, avgdl: N > 0 ? totalLen / N : 0, N }
}

/**
 * 对索引里每个文档算 BM25 分（不做截断，交给调用方）。
 * @param {ReturnType<typeof createIndex>} index
 * @param {string} query
 * @returns {Array<{ id: string, doc: object, score: number }>}
 */
export function scoreIndex(index, query) {
  const { items, df, avgdl, N } = index ?? {}
  if (!Array.isArray(items) || items.length === 0) return []
  const terms = [...new Set(tokenize(query))]

  return items.map((item) => {
    let score = 0
    for (const term of terms) {
      const docFreq = df.get(term) ?? 0
      if (docFreq === 0) continue
      const tf = item.tf.get(term) ?? 0
      if (tf === 0) continue
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5))
      const norm = avgdl > 0 ? item.len / avgdl : 0
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * norm)
      score += (idf * (tf * (BM25_K1 + 1))) / denom
    }
    return { id: item.id, doc: item.doc, score }
  })
}

/**
 * 检索 topK：过滤 0 分，按分数降序、同分按 id 升序（稳定排序）。
 * @param {ReturnType<typeof createIndex>} index
 * @param {string} query
 * @param {number} [topK]
 * @returns {Array<{ id: string, doc: object, score: number }>}
 */
export function search(index, query, topK = 5) {
  const limit = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 5
  return scoreIndex(index, query)
    .filter((row) => row.score > 0)
    .sort((a, b) => (b.score - a.score) || compareId(a.id, b.id))
    .slice(0, limit)
}

/**
 * 对一组文档直接检索（便捷封装）。
 * @param {ReadonlyArray<{ id: string, text?: string }>} docs
 * @param {string} query
 * @param {number} [topK]
 */
export function searchDocs(docs, query, topK = 5) {
  return search(createIndex(docs), query, topK)
}
