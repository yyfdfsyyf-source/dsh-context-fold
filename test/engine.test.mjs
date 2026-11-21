/**
 * test/engine.test.mjs —— 自包含压缩引擎测试。
 *
 * 使用 faithful mock session：surface.nodes / replaceGeneration / seq /
 * eventAt / append（含 surfaceOp replace）/ requestHeader / deriveEventMessage /
 * toolHistory，形状对齐真实 DSH session API。
 *
 * @module test/engine
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ManualCompactionError,
  errorChain,
  compactCheckpointSource,
  isCompactCheckpointSource,
  frameSummary,
  SUMMARY_OPEN_TAG,
  SUMMARY_CLOSE_TAG,
  CHECKPOINT_PREAMBLE,
} from '../lib/engine/core.js'
import { eventDelta, toolPairingBalancedBefore, toolPairingBalancedAfter } from '../lib/engine/tool-pairing.js'
import { resolveCompactSpec, resolveTargetPolicy, DEFAULT_ENGINE_CONFIG, TargetPressureConfigError } from '../lib/engine/config.js'
import {
  SurfaceChangedError,
  selectCompactableRange,
  validateSurfaceRegion,
  inspectCompactionEntryState,
  assertCompactionInactive,
  assertNoActiveCompaction,
} from '../lib/engine/region.js'
import { createEngine, apply, name as engineName } from '../lib/engine/index.js'

/* ── faithful mock session ─────────────────────────────────────────── */

class MockSession {
  constructor(specs = []) {
    this.id = 'mock-session'
    this.events = []
    this.surface = { nodes: [], replaceGeneration: 0 }
    this.seq = 0
    this.ops = []
    this.lastOp = null
    this.header = {
      config: { provider: 'test-provider', model: 'test-model' },
      tools: undefined,
    }
    this._tokenBySeq = new Map()
    for (const spec of specs) this._seed(spec)
  }

  _seed(spec) {
    const seq = this.seq++
    const event = { seq, type: spec.type, data: spec.data ?? {} }
    this.events[seq] = event
    this.surface.nodes.push(seq)
    this._tokenBySeq.set(seq, {
      tokens: spec.tokens ?? 10,
      heuristicTokens: spec.heuristicTokens ?? spec.tokens ?? 10,
    })
    return event
  }

  eventAt(seq) {
    return this.events[seq]
  }

  requestHeader() {
    return this.header
  }

  toolHistory() {
    return []
  }

  deriveEventMessage(event) {
    if (event === null || event === undefined) return null
    const text = typeof event.data?.text === 'string' ? event.data.text : ''
    return {
      role: event.type === 'system/message' ? 'system' : 'user',
      content: [{ type: 'text', text }],
    }
  }

  append(type, data, opts, callRecord) {
    const seq = this.seq++
    const event = { seq, type, data, ...(callRecord === undefined ? {} : { callRecord }) }
    this.events[seq] = event
    const op = { seq, type, data, opts, callRecord }
    this.ops.push(op)
    this.lastOp = op
    if (opts?.surfaceOp?.op === 'replace') {
      const { startSeq, endSeq } = opts.surfaceOp
      const nodes = this.surface.nodes
      const startIdx = nodes.indexOf(startSeq)
      const endIdx = nodes.indexOf(endSeq)
      if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
        nodes.splice(startIdx, endIdx - startIdx + 1, seq)
        this.surface.replaceGeneration++
      }
    }
    return event
  }

  /** 测试用：手动注入一条日志事件（不改变 surface）。 */
  inject(type, data) {
    const seq = this.seq++
    const event = { seq, type, data: data ?? {} }
    this.events[seq] = event
    return event
  }

  types() {
    return this.ops.map((op) => op.type)
  }
}

function makeCtx({ summary = '## Primary Request and Intent\n- short checkpoint text', streamError = null } = {}) {
  const provided = {}
  let flushCount = 0
  let streamOptions = null
  const meter = {
    measure(session) {
      const nodes = session.surface.nodes.map((seq) => {
        const t = session._tokenBySeq.get(seq) ?? { tokens: 10, heuristicTokens: 10 }
        return { seq, tokens: t.tokens, heuristicTokens: t.heuristicTokens }
      })
      const totalTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
      return { nodes, totalTokens, surfaceTokens: totalTokens, compressedTokens: 0 }
    },
    estimateMessage(message) {
      return Math.ceil(JSON.stringify(message?.content ?? '').length / 3.5)
    },
  }
  const llm = {
    async resolveModelInfo() {
      return { context: { contextWindow: 200000 }, defaultMaxTokens: 8192 }
    },
    async *stream(options) {
      streamOptions = options
      if (streamError !== null) throw streamError
      yield { type: 'text-delta', index: 0, text: summary }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const sessions = {
    async flush() { flushCount++ },
  }
  const ctx = {
    get(key) {
      if (key === 'tokenMeter') return meter
      if (key === 'llm') return llm
      if (key === 'sessions') return sessions
      return undefined
    },
    waterfall() { return false },
    provide(key, value) { provided[key] = value },
    provided,
    meter,
    llm,
    sessions,
    get flushCount() { return flushCount },
    get streamOptions() { return streamOptions },
  }
  return ctx
}

function makeAgent(session, { maintenanceBusy = false, allowMaintenance = true } = {}) {
  let busy = false
  return {
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    runMaintenance(task) {
      if (!allowMaintenance) throw new Error('runMaintenance unavailable')
      if (maintenanceBusy || busy) throw new Error('agent is busy')
      busy = true
      const signal = new AbortController().signal
      return Promise.resolve(task(signal)).finally(() => { busy = false })
    },
  }
}

/** 标准事务 session：turn/start + system + 两条消息，token 足够大以通过 shrink。 */
function standardSession() {
  return new MockSession([
    { type: 'turn/start', data: { turn: 1 }, tokens: 5, heuristicTokens: 5 },
    { type: 'system/message', data: { text: 'sys' }, tokens: 5, heuristicTokens: 5 },
    { type: 'user/message', data: { text: 'question' }, tokens: 200, heuristicTokens: 300 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer' }] } }, tokens: 200, heuristicTokens: 300 },
  ])
}

/* ── 1) 完整事务事件顺序 ───────────────────────────────────────────── */

test('完整事务按 start → summary → replace → end 顺序发出事件', async () => {
  const session = standardSession()
  const ctx = makeCtx()
  const engine = createEngine(ctx)
  const result = await engine.compactRegion(1, 3, makeAgent(session))

  assert.deepEqual(session.types(), ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])

  const startOp = session.ops[0]
  assert.equal(startOp.type, 'compaction/start')
  assert.equal(typeof startOp.data.compactionId, 'string')
  assert.equal(startOp.data.turn, 1)
  assert.equal('sourceCommandId' in startOp.data, false)

  const replaceOp = session.ops[2]
  assert.deepEqual(replaceOp.opts.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 3 })
  assert.deepEqual(replaceOp.opts.sourceEventSeqs, [startOp.seq, session.ops[1].seq, 1, 2, 3])
  assert.ok(isCompactCheckpointSource(replaceOp.data.source))
  assert.equal(replaceOp.data.source.compactionId, startOp.data.compactionId)

  const endOp = session.ops[3]
  assert.equal(endOp.data.compactionId, startOp.data.compactionId)
  assert.equal('error' in endOp.data, false)

  assert.equal(result.compactionId, startOp.data.compactionId)
  assert.equal(result.startSeq, startOp.seq)
  assert.equal(result.summarySeq, session.ops[1].seq)
  assert.equal(result.endSeq, endOp.seq)
  assert.deepEqual(result.shadowedSeqs, [1, 2, 3])
  assert.deepEqual(result.shadowedRange, { start: 1, end: 3 })
  assert.equal(result.summary.length, 1)
  assert.equal(result.summary[0].type, 'text')
})

/* ── 2) summary + replace 相邻，无其他事件 ─────────────────────────── */

test('compaction/summary 与 user/message replace 相邻，中间没有 yield', async () => {
  const session = standardSession()
  const ctx = makeCtx()
  const engine = createEngine(ctx)
  await engine.compactRegion(1, 3, makeAgent(session))

  const types = session.types()
  const summaryIndex = types.indexOf('compaction/summary')
  assert.equal(types[summaryIndex + 1], 'user/message')

  const summaryOp = session.ops[summaryIndex]
  assert.equal(summaryOp.callRecord?.llmStreamCall, true)
  assert.ok(Array.isArray(summaryOp.callRecord.rawOutput))
  assert.equal(summaryOp.data.shadowedTokenCount, 605)
})

/* ── 3) shadowedTokenCount 用 heuristicTokens，shrink 用 tokens ────── */

test('shadowedTokenCount 使用 heuristicTokens，而 shrink 比较使用 tokens', async () => {
  const session = standardSession()
  const ctx = makeCtx()
  const engine = createEngine(ctx)
  const result = await engine.compactRegion(1, 3, makeAgent(session))

  // nodes 1/2/3: heuristicTokens = 5 + 300 + 300 = 605; tokens = 5 + 200 + 200 = 405
  assert.equal(result.shadowedTokenCount, 605)
  const framed = ctx.meter.estimateMessage(result.summary)
  assert.ok(framed < 405, `framed summary ${framed} must be < route tokens 405`)
})

/* ── 4) shrink 拒绝：摘要不够小 ───────────────────────────────────── */

test('摘要不小于遮蔽内容时拒绝提交，并补一条带 error 的 compaction/end', async () => {
  const session = new MockSession([
    { type: 'turn/start', data: { turn: 1 }, tokens: 5, heuristicTokens: 5 },
    { type: 'user/message', data: { text: 'tiny' }, tokens: 5, heuristicTokens: 5 },
    { type: 'user/message', data: { text: 'tiny2' }, tokens: 5, heuristicTokens: 5 },
  ])
  const ctx = makeCtx({ summary: 'x'.repeat(2000) })
  const engine = createEngine(ctx)

  await assert.rejects(
    () => engine.compactRegion(1, 2, makeAgent(session)),
    /summary is not smaller than the shadowed content/,
  )

  const types = session.types()
  assert.equal(types[0], 'compaction/start')
  assert.equal(types[1], 'compaction/end')
  assert.equal(types.includes('user/message'), false)
  assert.match(session.ops[1].data.error, /summary is not smaller/)
})

/* ── 5) tool-pairing 边界吸附 ─────────────────────────────────────── */

test('tool-pairing 边界吸附不会拆开 tool-call/result 对', () => {
  const session = new MockSession([
    { type: 'system/message', data: { text: 'sys' }, tokens: 5, heuristicTokens: 5 },
    { type: 'user/message', data: { text: 'u1' }, tokens: 100, heuristicTokens: 100 },
    { type: 'user/message', data: { text: 'u2' }, tokens: 100, heuristicTokens: 100 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 't', arguments: '{}' }] } }, tokens: 300, heuristicTokens: 300 },
    { type: 'tool/result', data: {}, tokens: 300, heuristicTokens: 300 },
    { type: 'user/message', data: { text: 'u3' }, tokens: 100, heuristicTokens: 100 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } }, tokens: 100, heuristicTokens: 100 },
  ])

  // node 3 是 tool-call（+1），node 4 是 result（-1）；切口 3 之前/4 之前都不平衡。
  assert.equal(eventDelta(session.eventAt(3)), 1)
  assert.equal(eventDelta(session.eventAt(4)), -1)
  assert.equal(toolPairingBalancedBefore(session, 3), true)
  assert.equal(toolPairingBalancedAfter(session, 3), false)
  assert.equal(toolPairingBalancedBefore(session, 4), false)
  assert.equal(toolPairingBalancedAfter(session, 4), true)

  const range = selectCompactableRange(session, makeCtx().meter.measure(session), 250)
  // 自然落点是 node 4 之前（不平衡），吸附后到 node 3 之前 → end 落在 node 2。
  assert.deepEqual(range, { start: 1, end: 2 })

  assert.throws(
    () => validateSurfaceRegion(session, 3, 3),
    /would split a step/,
  )
})

/* ── 6) 未配对 compaction/start → busy ────────────────────────────── */

test('未配对的 compaction/start 使后续压缩报 busy', async () => {
  const session = standardSession()
  session.inject('compaction/start', { compactionId: 'orphan', turn: 1 })

  const entry = inspectCompactionEntryState(session)
  assert.equal(entry.unmatchedCompactionStart.seq, 4)
  assert.throws(
    () => assertCompactionInactive(entry.unmatchedCompactionStart, entry.latestEndSeedSeq, 'compaction'),
    (error) => error instanceof ManualCompactionError && error.code === 'busy',
  )
  assert.throws(
    () => assertNoActiveCompaction(session, 'automatic pressure compaction'),
    (error) => error instanceof ManualCompactionError && error.code === 'busy',
  )

  const engine = createEngine(makeCtx())
  await assert.rejects(
    () => engine.compactRegion(1, 3, makeAgent(session)),
    (error) => error instanceof ManualCompactionError && error.code === 'busy',
  )
  // busy 发生在写 start 之前，不应产生新的 compaction 事件。
  assert.deepEqual(session.types(), [])
})

/* ── 7) selectCompactableRange 永不遮蔽 system head ───────────────── */

test('selectCompactableRange 永不遮蔽 node 0 的 system head', () => {
  const session = new MockSession([
    { type: 'system/message', data: { text: 'sys' }, tokens: 5, heuristicTokens: 5 },
    { type: 'user/message', data: { text: 'a' }, tokens: 20, heuristicTokens: 20 },
    { type: 'user/message', data: { text: 'b' }, tokens: 20, heuristicTokens: 20 },
  ])
  const range = selectCompactableRange(session, makeCtx().meter.measure(session), 0)
  // retainTokens=0 时从尾部只保留最后一个节点（node 2），起点吸附到 system head 之后。
  assert.deepEqual(range, { start: 1, end: 1 })
  assert.notEqual(range.start, 0)
})

/* ── 8) ManualCompactionError codes + errorChain ───────────────────── */

test('ManualCompactionError 保留 code 与 name，errorChain 沿 cause 拼接', () => {
  for (const code of ['busy', 'cancelled', 'changed', 'summary', 'commit', 'persistence']) {
    const error = new ManualCompactionError(code, `message-${code}`)
    assert.equal(error.name, 'ManualCompactionError')
    assert.equal(error.code, code)
    assert.equal(error.message, `message-${code}`)
  }

  const root = new Error('root cause')
  const middle = new Error('middle', { cause: root })
  const top = new ManualCompactionError('summary', 'top', { cause: middle })
  assert.equal(errorChain(top), 'top: middle: root cause')
  assert.equal(errorChain('plain'), 'plain')
})

/* ── 9) 三个入口的 happy path + null path ─────────────────────────── */

test('compactRegion / compactIfNeeded / compactNow happy path', async () => {
  // compactRegion
  const s1 = standardSession()
  const r1 = await createEngine(makeCtx()).compactRegion(1, 3, makeAgent(s1))
  assert.ok(r1 && typeof r1.compactionId === 'string')

  // compactIfNeeded(pressure)：token 总量需超过阈值 136272。
  const s2 = new MockSession([
    { type: 'system/message', data: { text: 'sys' }, tokens: 40000, heuristicTokens: 40000 },
    ...Array.from({ length: 4 }, (_, i) => ({
      type: 'user/message', data: { text: `u${i}` }, tokens: 40000, heuristicTokens: 40000,
    })),
  ])
  s2.inject('turn/start', { turn: 2 })
  const r2 = await createEngine(makeCtx()).compactIfNeeded(makeAgent(s2), 'pressure')
  assert.ok(r2 && typeof r2.compactionId === 'string')
  assert.ok(s2.types().includes('compaction/start'))

  // compactNow：走 runMaintenance，owner=null，flush 被调用。
  const s3 = new MockSession([
    { type: 'user/message', data: { text: 'a' }, tokens: 50000, heuristicTokens: 50000 },
    { type: 'user/message', data: { text: 'b' }, tokens: 50000, heuristicTokens: 50000 },
  ])
  const ctx3 = makeCtx()
  const r3 = await createEngine(ctx3).compactNow(makeAgent(s3), new AbortController().signal, 'cmd-42')
  assert.ok(r3 && typeof r3.compactionId === 'string')
  assert.equal(r3.sourceCommandId, 'cmd-42')
  assert.equal(ctx3.flushCount, 1)
  assert.equal(s3.ops[0].data.turn, null)
})

test('三个入口在无可压缩区间 / 服务缺失时返回 null', async () => {
  const ctx = makeCtx()
  const engine = createEngine(ctx)

  // compactIfNeeded：token 远低于阈值。
  const low = standardSession()
  assert.equal(await engine.compactIfNeeded(makeAgent(low), 'pressure'), null)

  // compactIfNeeded：无路由配置。
  const noRoute = standardSession()
  noRoute.header.config = {}
  assert.equal(await engine.compactIfNeeded(makeAgent(noRoute), 'pressure'), null)

  // compactNow：只有 system head，无可压缩区间。
  const onlySystem = new MockSession([
    { type: 'system/message', data: { text: 'sys' }, tokens: 10, heuristicTokens: 10 },
  ])
  assert.equal(await engine.compactNow(makeAgent(onlySystem), new AbortController().signal), null)

  // tokenMeter 缺失时全部返回 null。
  const bareCtx = { get() { return undefined }, waterfall() { return false }, provide() {} }
  const bareEngine = createEngine(bareCtx)
  assert.equal(await bareEngine.compactIfNeeded(makeAgent(standardSession()), 'pressure'), null)
  assert.equal(await bareEngine.compactRegion(1, 2, makeAgent(standardSession())), null)
  assert.equal(await bareEngine.compactNow(makeAgent(standardSession()), new AbortController().signal), null)
})

/* ── 额外：apply 注册 compaction 服务 / checkpoint helpers / config ── */

test('apply(ctx) 通过 provide 注册 compaction 服务', () => {
  const ctx = makeCtx()
  const engine = apply(ctx)
  assert.equal(engineName, 'context-fold-engine')
  assert.equal(ctx.provided.compaction, engine)
  assert.equal(typeof engine.compactIfNeeded, 'function')
  assert.equal(typeof engine.compactNow, 'function')
  assert.equal(typeof engine.compactRegion, 'function')
})

test('checkpoint source 与 frameSummary 形状正确', () => {
  const source = compactCheckpointSource('id-1', 'cmd-1')
  assert.equal(source.kind, 'compact-checkpoint')
  assert.equal(source.compactionId, 'id-1')
  assert.equal(source.sourceCommandId, 'cmd-1')
  assert.ok(Object.isFrozen(source))
  assert.equal('sourceCommandId' in compactCheckpointSource('id-2'), false)
  assert.equal(isCompactCheckpointSource({ kind: 'other' }), false)

  const framed = frameSummary([{ type: 'text', text: 'body' }])
  assert.equal(framed.length, 3)
  assert.ok(framed[0].text.startsWith(CHECKPOINT_PREAMBLE))
  assert.ok(framed[0].text.endsWith(SUMMARY_OPEN_TAG))
  assert.equal(framed[2].text, SUMMARY_CLOSE_TAG)
})

test('resolveTargetPolicy / resolveCompactSpec 遵循官方默认值与守卫', () => {
  const config = {
    ...DEFAULT_ENGINE_CONFIG,
    summarizationProvider: '',
    summarizationModel: '',
    modelPolicies: [{ provider: 'p', model: 'm', retainTokens: 1000 }],
  }
  const policy = resolveTargetPolicy(config, { provider: 'p', model: 'm' })
  assert.equal(policy.retainTokens, 1000)
  assert.equal(policy.thresholdRatio, 0.8)
  assert.equal(policy.headroomTokens, 65536)

  const spec = resolveCompactSpec(policy, 200000, 8192)
  // threshold = floor(min(200000*0.8=160000, (200000-8192)-65536=126272)) = 126272
  assert.equal(spec.thresholdTokens, 126272)
  assert.equal(spec.retainTokens, 1000)

  assert.throws(
    () => resolveCompactSpec(policy, 0, 0),
    (error) => error instanceof TargetPressureConfigError && /positive integer/.test(error.message),
  )
  assert.throws(
    () => resolveCompactSpec(policy, 200000, -1),
    (error) => error instanceof TargetPressureConfigError && /non-negative integer/.test(error.message),
  )
})

test('SurfaceChangedError 是独立错误类型', () => {
  const error = new SurfaceChangedError('changed')
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'SurfaceChangedError')
})
