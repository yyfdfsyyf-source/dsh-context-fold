/**
 * engine/region.js —— 自包含压缩事务的核心。
 *
 * 逐字移植自 @deepseek-ai/dsh-compaction-basic/src/region.ts（0.2.2-rc.3）。
 * 关键不变量：
 *  - compaction/start 在第一个 await 之前同步写入（持久锁）；
 *  - compaction/summary 与 user/message replace 相邻，中间没有任何 yield；
 *  - shadowedTokenCount 用 heuristicTokens（遮蔽价），shrink 比较用 tokens（路由价）；
 *  - 失败时最多补一条带 error 的 compaction/end；关闭失败留下未配对的 start（故意，
 *    作为下一次压缩的 busy 信号）。
 *
 * @module engine/region
 */

import { isDeepStrictEqual } from 'node:util'
import {
  createUserMessage,
  compactCheckpointSource,
  frameSummary,
  errorChain,
  ManualCompactionError,
  randomId,
} from './core.js'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from './tool-pairing.js'

/** surface 在摘要期间被改写时抛出的错误。 */
export class SurfaceChangedError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'SurfaceChangedError'
  }
}

/** 自动压缩（pressure/overflow）在无开放 turn 时的错误。 */
export class NoOpenTurnError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NoOpenTurnError'
  }
}

/**
 * 把内部错误映射成手动压缩领域错误（region.ts throwManualFailure）。
 *
 * @param {{error: unknown, stage: string}} failure
 */
export function throwManualFailure(failure) {
  // 已经是领域错误（如 busy）就原样保留，避免被降级成 summary。
  if (failure.error instanceof ManualCompactionError) throw failure.error
  if (failure.stage === 'commit') {
    throw new ManualCompactionError('commit', 'manual compaction did not commit cleanly', { cause: failure.error })
  }
  if (failure.error instanceof SurfaceChangedError) {
    throw new ManualCompactionError('changed', 'the compacted history changed during manual compaction', { cause: failure.error })
  }
  throw new ManualCompactionError('summary', 'manual compaction could not produce a smaller summary', { cause: failure.error })
}

/** 系统 head 事件（surface 第一个节点是 system/message 时）。 */
export function systemHead(session, headSeq) {
  const head = session.eventAt(headSeq)
  return head?.type === 'system/message' ? head : undefined
}

/**
 * 选出可压缩区间：从尾部按 retainTokens 保留，吸附到 tool pairing 平衡边界，
 * 永不遮蔽 system head（第一个节点）。
 *
 * @param {object} session
 * @param {{nodes: Array<{seq: number, tokens: number, heuristicTokens: number}>}} measurement
 * @param {number} retainTokens
 */
export function selectCompactableRange(session, measurement, retainTokens) {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null

  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length ||
      surfaceNodes.some((seq, index) => pricedNodes[index].seq !== seq)) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }

  const firstIdx = systemHead(session, surfaceNodes[0]) === undefined ? 0 : 1
  let accumulated = 0
  let keepFromIdx = surfaceNodes.length
  for (let index = surfaceNodes.length - 1; index >= 0; index--) {
    accumulated += pricedNodes[index].tokens
    if (accumulated >= retainTokens) {
      keepFromIdx = index
      break
    }
  }
  if (keepFromIdx <= firstIdx) return null

  // 吸附到工具调用/结果的平衡边界，避免拆开一步。
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break
    keepFromIdx--
  }
  if (keepFromIdx <= firstIdx) return null

  return { start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] }
}

/**
 * 校验显式区间：边界必须存在、顺序正确、两侧 tool pairing 平衡。
 *
 * @param {object} session
 * @param {number} start
 * @param {number} end
 */
export function validateSurfaceRegion(session, start, end) {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
  if (startIdx > endIdx) {
    throw new Error(`compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`)
  }
  if (!toolPairingBalancedBefore(session, nodes[startIdx])) {
    throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
  }
  if (!toolPairingBalancedAfter(session, nodes[endIdx])) {
    throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
  }
  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

/**
 * 构造传给 LLM 的压缩输入：可选 system head + 区间消息 + 可选 tools。
 */
export function buildSummarizationInput(session, shadowedSeqs) {
  const header = session.requestHeader?.()
  const head = systemHead(session, session.surface.nodes[0])
  const system = head === undefined ? null : session.deriveEventMessage(head)
  const regionMessages = shadowedSeqs
    .map((seq) => session.deriveEventMessage(session.eventAt(seq)))
    .filter((message) => message !== null && message !== undefined)
  return {
    ...(header?.tools === undefined ? {} : { tools: header.tools }),
    messages: system === null ? regionMessages : [system, ...regionMessages],
  }
}

/** 准备阶段：计量 + 选中的测量节点 + 摘要输入。 */
export function prepareCompaction(deps, session, selection) {
  const measurement = deps.meter.measure(session)
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1)
  if (selectedNodes.length !== selection.shadowedSeqs.length ||
      selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) {
    throw new SurfaceChangedError('compaction: selected surface changed before summarization began')
  }
  const shadowedTokenCount = selectedNodes.reduce((sum, node) => sum + node.heuristicTokens, 0)
  const shadowedRouteTokenCount = selectedNodes.reduce((sum, node) => sum + node.tokens, 0)
  return {
    ...selection,
    measurement,
    selectedNodes,
    shadowedTokenCount,
    shadowedRouteTokenCount,
    input: buildSummarizationInput(session, selection.shadowedSeqs),
  }
}

/** 整个 surface 未变断言（自动压缩用）。 */
export function assertWholeSurfaceUnchanged(deps, session, prepared) {
  const current = deps.meter.measure(session)
  if (!isDeepStrictEqual(current.nodes, prepared.measurement.nodes)) {
    throw new SurfaceChangedError('compaction: session surface changed during summarization')
  }
}

/** 选中区间未变断言（手动压缩用，允许区间外变化）。 */
export function assertSelectedSpanStable(deps, session, prepared) {
  let current
  try {
    current = validateSurfaceRegion(session, prepared.start, prepared.end)
  } catch (error) {
    throw new SurfaceChangedError('compaction: the selected span is no longer a valid replacement target', { cause: error })
  }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) {
    throw new SurfaceChangedError('compaction: the selected span changed during summarization')
  }
  const measured = deps.meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1)
  if (!isDeepStrictEqual(measured, prepared.selectedNodes)) {
    throw new SurfaceChangedError('compaction: the selected span was rewritten during summarization')
  }
}

/**
 * 摘要阶段（带 recover 重试）：失败后先断言 surface 未变，再询问 recover 是否
 * 重试；重试前重新校验区间并重新计量。然后生成 checkpoint 消息并做 shrink 检查。
 *
 * @param {object} lifecycle {stability, compactionId, sourceCommandId, owner}
 */
export function summarizeCompaction(deps, agent, prepared, lifecycle, signal) {
  return (async () => {
    let summaryResult
    for (;;) {
      signal?.throwIfAborted()
      try {
        summaryResult = await deps.summarize(prepared.input, agent, signal)
        break
      } catch (error) {
        if (signal?.aborted) throw error
        if (lifecycle.stability === 'whole-surface') {
          assertWholeSurfaceUnchanged(deps, agent.session, prepared)
        } else {
          assertSelectedSpanStable(deps, agent.session, prepared)
        }
        if (!deps.recover(error, agent, prepared.shadowedSeqs, signal)) throw error
        prepared = prepareCompaction(
          deps,
          agent.session,
          validateSurfaceRegion(agent.session, prepared.start, prepared.end),
        )
      }
    }

    const checkpointMessage = createUserMessage({
      content: frameSummary(summaryResult.summary),
      source: compactCheckpointSource(lifecycle.compactionId, lifecycle.sourceCommandId),
    })
    const framedSummaryTokenCount = deps.meter.estimateMessage(checkpointMessage)
    if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) {
      throw new Error(`summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`)
    }
    return { ...prepared, ...summaryResult, checkpointMessage }
  })()
}

/**
 * 提交阶段：先写 compaction/summary，紧接着写 user/message replace。两者之间
 * 没有 await，保证 shadow price 记账的相邻性。
 */
export function commitCompactionBody(session, startEvent, start, end, summarized, lifecycle) {
  const summaryEvent = session.append(
    'compaction/summary',
    {
      compactionId: startEvent.data.compactionId,
      ...(lifecycle.sourceCommandId === undefined ? {} : { sourceCommandId: lifecycle.sourceCommandId }),
      summary: summarized.summary,
      shadowedRange: { start, end },
      shadowedSeqs: [...summarized.shadowedSeqs],
      shadowedTokenCount: summarized.shadowedTokenCount,
      provider: summarized.provider,
      model: summarized.model,
      ...(summarized.maxTokens === undefined ? {} : { maxTokens: summarized.maxTokens }),
      ...(summarized.usage === undefined ? {} : { usage: summarized.usage }),
    },
    undefined,
    { rawOutput: summarized.rawOutput, llmStreamCall: true },
  )

  session.append('user/message', summarized.checkpointMessage, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...summarized.shadowedSeqs],
  })

  return {
    compactionId: startEvent.data.compactionId,
    ...(lifecycle.sourceCommandId === undefined ? {} : { sourceCommandId: lifecycle.sourceCommandId }),
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    summary: summarized.summary,
    shadowedRange: { start, end },
    shadowedSeqs: [...summarized.shadowedSeqs],
    shadowedTokenCount: summarized.shadowedTokenCount,
  }
}

/** 收尾：补上 endSeq。 */
export function completeCompaction(pending, endEvent) {
  return { ...pending, endSeq: endEvent.seq }
}

/**
 * 扫描 session 尾部，找出未配对的 compaction/start、开放 turn、最近的 end-seed。
 *
 * @param {object} session
 */
export function inspectCompactionEntryState(session) {
  let openTurn
  let openTurnKnown = false
  let unmatchedCompactionStart
  let unmatchedCompactionStartKnown = false
  let latestEndSeedSeq
  let latestEndSeedSeqKnown = false

  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (!openTurnKnown) {
      if (event.type === 'turn/start' || event.type === 'turn/end') {
        openTurn = event.type === 'turn/start' ? event.data?.turn : null
        openTurnKnown = true
      }
    }
    if (!unmatchedCompactionStartKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        unmatchedCompactionStartKnown = true
      } else if (event.type === 'compaction/end') {
        unmatchedCompactionStart = undefined
        unmatchedCompactionStartKnown = true
      }
    }
    if (!latestEndSeedSeqKnown) {
      if (event.type === 'session/end-seed') {
        latestEndSeedSeq = event.seq
        latestEndSeedSeqKnown = true
      }
    }
    if (openTurnKnown && unmatchedCompactionStartKnown && latestEndSeedSeqKnown) break
  }

  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}

/** 若 compaction 锁已激活（未被 end-seed 清除）则抛 busy。 */
export function assertCompactionInactive(unmatched, latestSeed, stage) {
  if (unmatched === undefined || (latestSeed !== undefined && latestSeed > unmatched.seq)) return
  throw new ManualCompactionError('busy', `${stage}: compaction already in progress; the session compaction lock is already active`)
}

/** 以 session 当前状态断言无活动压缩。 */
export function assertNoActiveCompaction(session, stage) {
  const entry = inspectCompactionEntryState(session)
  assertCompactionInactive(entry.unmatchedCompactionStart, entry.latestEndSeedSeq, stage)
}

/**
 * 完整压缩事务（region.ts:182-251）。
 *
 * @param {object} deps {meter, summarize, recover}
 * @param {object} session
 * @param {number} start
 * @param {number} end
 * @param {object} agent
 * @param {{owner: 'current-turn'|null, stability: 'whole-surface'|'selected-span', sourceCommandId?: string, flush?: () => Promise<void>}} options
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} CompactionResult
 */
export function compactSurfaceRegion(deps, session, start, end, agent, options, signal) {
  return (async () => {
    let lifecycle
    let startEvent
    let stage = 'prepare'
    let closing = false
    let closed = false
    let failure
    let flushFailure

    // 1) 手动压缩（owner===null）先检查中断。
    if (options.owner === null) signal?.throwIfAborted()

    try {
      // 2) 只读校验区间。
      const selection = validateSurfaceRegion(session, start, end)

      // 3) 读入口状态并做 busy 检查（锁检查在写 start 之前，避免双重锁）。
      const entry = inspectCompactionEntryState(session)
      assertCompactionInactive(entry.unmatchedCompactionStart, entry.latestEndSeedSeq, 'compaction')

      // 4) owner 解析。
      let owner
      if (options.owner === null) {
        if (entry.openTurn !== null && entry.openTurn !== undefined) {
          throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn')
        }
        owner = null
      } else {
        if (entry.openTurn === null || entry.openTurn === undefined) {
          throw new NoOpenTurnError('compactRegion: no open turn — automatic compaction events must be enclosed in a turn')
        }
        owner = entry.openTurn
      }

      // 5) 生命周期标识。
      const compactionId = randomId()
      lifecycle = {
        compactionId,
        ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
        turn: owner,
      }
      const stabilityOptions = { ...lifecycle, stability: options.stability, owner }

      // 6) ① 同步写 compaction/start（第一个 await 之前，持久锁）。
      startEvent = session.append('compaction/start', lifecycle)
      stage = 'summarize'

      // 8) 准备 + 摘要（summarizeCompaction 内含 retry / recover / shrink 检查）。
      const prepared = prepareCompaction(deps, session, selection)
      const summarized = await summarizeCompaction(deps, agent, prepared, stabilityOptions, signal)

      // 10) 提交前再次检查中断与稳定性。
      if (owner === null) signal?.throwIfAborted()
      if (options.stability === 'whole-surface') {
        assertWholeSurfaceUnchanged(deps, session, prepared)
      } else {
        assertSelectedSpanStable(deps, session, prepared)
      }
      stage = 'commit'

      // 11) ② compaction/summary + ③ user/message replace，相邻无 yield。
      const pending = commitCompactionBody(session, startEvent, start, end, summarized, lifecycle)

      // 12) ④ compaction/end。
      closing = true
      const endEvent = session.append('compaction/end', lifecycle)
      closed = true
      closing = false

      // 手动压缩落盘 durability checkpoint。
      if (closed && options.flush !== undefined) {
        try {
          await options.flush()
        } catch (error) {
          flushFailure = error
        }
      }

      return completeCompaction(pending, endEvent)
    } catch (error) {
      failure = { error, stage: closing ? 'commit' : stage }

      // 未关闭时补一条带 error 的 end（只尝试一次；失败覆盖为 commit 阶段）。
      if (!closing && startEvent !== undefined) {
        try {
          session.append('compaction/end', {
            compactionId: lifecycle.compactionId,
            ...(lifecycle.sourceCommandId === undefined ? {} : { sourceCommandId: lifecycle.sourceCommandId }),
            turn: lifecycle.turn,
            error: errorChain(error),
          })
        } catch (closeError) {
          failure = { error: closeError, stage: 'commit' }
        }
      }

      // 13) 最终错误优先级：abort > 事务失败 > flush 失败。
      if (options.owner === null) signal?.throwIfAborted()
      if (failure !== undefined) {
        if (options.owner === null) throwManualFailure(failure)
        throw failure.error
      }
      if (flushFailure !== undefined) {
        throw new ManualCompactionError('persistence', 'manual compaction durability checkpoint failed', { cause: flushFailure })
      }
      throw error
    }
  })()
}
