/**
 * engine/tool-pairing.js —— 工具调用/结果配平的边界判定。
 *
 * 逐字移植自 @deepseek-ai/dsh-compaction/src/tool-pairing.ts。
 * 用 WeakMap 按 session 缓存，缓存以 `session.surface.replaceGeneration` 失效，
 * 因此一次 replace 之后所有边界重新计算。
 *
 * @module engine/tool-pairing
 */

const caches = new WeakMap()

/**
 * 单个事件对「进行中的 tool-call 计数」的增量。
 *
 * @param {{type: string, data?: object}} event
 * @returns {number}
 */
export function eventDelta(event) {
  switch (event.type) {
    case 'assistant/message': {
      const content = event.data?.message?.content
      return Array.isArray(content) ? content.filter((block) => block?.type === 'tool-call').length : 0
    }
    case 'tool/result':
      return -1
    default:
      return 0
  }
}

/**
 * 沿 surface 序列增量构建配平缓存。
 *
 * @param {object} session
 * @param {{generation: number, cutBalanced: boolean[], indexBySeq: Map<number, number>, inProgressToolCalls: number}} cache
 * @param {number[]} seqs
 */
function extendCache(session, cache, seqs) {
  const processed = cache.cutBalanced.length - 1
  const tail = seqs.slice(processed)
  const pendingCuts = []
  let inProgress = cache.inProgressToolCalls

  for (const seq of tail) {
    const event = session.eventAt(seq)
    if (!event || event.seq !== seq) {
      throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event (corrupt surface)`)
    }
    inProgress += eventDelta(event)
    if (inProgress < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`)
    }
    pendingCuts.push(inProgress === 0)
  }

  tail.forEach((seq, offset) => cache.indexBySeq.set(seq, processed + offset))
  cache.cutBalanced = cache.cutBalanced.concat(pendingCuts)
  cache.inProgressToolCalls = inProgress
  return cache
}

/** 取得（或重建/扩展）session 的配平缓存。 */
function balanceCache(session) {
  const surface = session.surface
  const seqs = surface.nodes
  const generation = surface.replaceGeneration
  let cached = caches.get(session)

  if (cached === undefined || cached.generation !== generation || cached.cutBalanced.length - 1 > seqs.length) {
    cached = { generation, cutBalanced: [true], indexBySeq: new Map(), inProgressToolCalls: 0 }
    caches.set(session, cached)
  }
  if (cached.cutBalanced.length - 1 < seqs.length) {
    return extendCache(session, cached, seqs)
  }
  return cached
}

/** 读取某个 seq 切口处（offset=0 之前 / 1 之后）是否配平。 */
function cutBalance(session, seq, offset) {
  const cache = balanceCache(session)
  const index = cache.indexBySeq.get(seq)
  const balanced = index === undefined ? undefined : cache.cutBalanced[index + offset]
  if (balanced === undefined) throw new Error(`tool-pairing balance: surface seq ${seq} not found`)
  return balanced
}

/** 在 surface seq 之前切是否安全（不会拆开 tool-call/result 对）。 */
export function toolPairingBalancedBefore(session, seq) {
  return cutBalance(session, seq, 0)
}

/** 在 surface seq 之后切是否安全。 */
export function toolPairingBalancedAfter(session, seq) {
  return cutBalance(session, seq, 1)
}
