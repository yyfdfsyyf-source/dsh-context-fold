/**
 * 集成测试：通过插件的**公开入口** `apply(ctx, config)` 装配，再用 mock ctx
 * 驱动宿主事件，验证三块能力端到端可用。
 *
 * 与 `core.test.mjs` 的分工：
 *  - `core.test.mjs` 测纯函数（bm25 / region / prune / decay / tokens），不碰 ctx。
 *  - 本文件测**装配结果**：工具是否注册、事件是否挂上、payload 映射是否正确、
 *    落盘与回捞是否闭环。它用真实文件系统（临时 DSH_HOME），不 mock fs。
 *
 * mock ctx 只实现插件真正用到的四个成员：`on` / `get` / `effect` / `logger`。
 * 这样测试同时充当"最小宿主契约"文档：插件对宿主的依赖面就是这么窄。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, name as pluginName } from '../lib/index.js'

// ───────────────────────────── 测试脚手架 ─────────────────────────────

/** 造一个临时 DSH_HOME，避免污染真实 ~/.dsh。 */
function withTempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxfold-it-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/**
 * 最小宿主。
 * @param {{tools?: boolean, llm?: object, sessions?: object, systemPrompt?: boolean}} opts
 */
function makeHost(opts = {}) {
  const handlers = new Map()
  const registeredTools = []
  const effects = []
  const services = {
    tools: opts.tools === false
      ? undefined
      : {
          register(definition) {
            registeredTools.push(definition)
            return () => {}
          },
        },
    llm: opts.llm,
    sessions: opts.sessions,
    systemPrompt: opts.systemPrompt === false ? undefined : {},
  }

  const ctx = {
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    get(key) {
      return services[key]
    },
    effect(fn) {
      effects.push(fn)
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }

  /** 取某个事件的监听器列表。 */
  const listeners = (event) => handlers.get(event) ?? []
  /** 取唯一的监听器（用于 waterfall）。 */
  const one = (event) => {
    const list = listeners(event)
    assert.equal(list.length, 1, `期望 ${event} 恰好一个监听器，实际 ${list.length}`)
    return list[0]
  }
  /** 取唯一的工具定义。 */
  const tool = () => {
    const found = registeredTools.find((d) => d.name === 'context_fold')
    assert.ok(found, 'context_fold 工具未注册')
    return found
  }

  return { ctx, handlers, registeredTools, effects, services, listeners, one, tool }
}

/** 一个能返回固定 JSON 数组的假 llm。 */
function fakeLlm(items, { fail = false, delayMs = 0 } = {}) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      const body = JSON.stringify(items)
      return (async function* () {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        if (fail) throw new Error('boom')
        // 故意切成两个 chunk，验证增量拼接。
        yield { type: 'text-delta', text: body.slice(0, 5) }
        yield { type: 'text-delta', text: body.slice(5) }
      })()
    },
  }
}

/** 造一个假会话：ownEvents 供 collectTurnTranscript，requestContext 供取模型。 */
function fakeSession(id, events = [], header = {}) {
  return {
    id,
    seq: events.length,
    header,
    ownEvents: () => events,
    requestContext: () => ({ provider: 'test-provider', model: 'test-model' }),
  }
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))

// ───────────────────────────── 1. 工具面 ─────────────────────────────

test('装配：注册 context_fold 工具，schema 与 output.render 齐全', (t) => {
  withTempHome(t)
  const host = makeHost()
  apply(host.ctx, {})

  assert.equal(pluginName, 'context-fold')
  const def = host.tool()
  assert.equal(def.name, 'context_fold')
  assert.ok(typeof def.description === 'string' && def.description.length > 50)
  assert.deepEqual(def.parameters.required, ['action'])
  assert.deepEqual(
    [...def.parameters.properties.action.enum],
    ['status', 'recall', 'prune', 'ledger'],
  )
  // output 与 output.render 是宿主必填项，漏了会在注册期炸。
  assert.ok(def.output && typeof def.output.render === 'function')
  const rendered = def.output.render({}, { ok: true })
  assert.ok(Array.isArray(rendered) && rendered[0].type === 'text')
  assert.match(rendered[0].text, /"ok": true/)
})

test('装配：tools 服务缺失时不抛错，只是不注册工具', (t) => {
  withTempHome(t)
  const host = makeHost({ tools: false })
  assert.doesNotThrow(() => apply(host.ctx, {}))
  assert.equal(host.registeredTools.length, 0)
})

test('装配：mode=off 时不挂任何能力监听器，但工具仍在', (t) => {
  withTempHome(t)
  const host = makeHost()
  apply(host.ctx, { mode: 'off' })

  assert.equal(host.listeners('tools/post-execute').length, 0)
  assert.equal(host.listeners('session/event').length, 0)
  assert.equal(host.listeners('agent/turn-stopping').length, 0)
  assert.equal(host.listeners('system-prompt/assemble').length, 0)
  assert.ok(host.tool(), 'mode=off 仍应注册状态工具')
})

// ─────────────────────── 2. 能力 A：确定性折叠 ───────────────────────

test('折叠：超长工具结果被折叠、原文落盘、可 recall 取回', async (t) => {
  const home = withTempHome(t)
  const host = makeHost()
  apply(host.ctx, {})

  const original = 'A'.repeat(12000) + 'MIDDLE' + 'B'.repeat(12000)
  const listener = host.one('tools/post-execute')
  const decision = await listener(
    { callId: 'call_7', name: 'bash' },
    { isError: false, value: {}, content: [{ type: 'text', text: original }] },
    async () => ({ kind: 'accept', content: [{ type: 'text', text: original }] }),
  )

  assert.equal(decision.kind, 'accept')
  const folded = decision.content[0].text
  assert.ok(folded.length < original.length, '折叠后应显著变短')
  assert.match(folded, /\[context-fold: 已折叠 call_7-0/)
  assert.match(folded, /context_fold recall call_7-0/)
  // 头尾各留 2000 字符，中段整体丢弃 —— 这是折叠的核心语义。
  assert.ok(folded.startsWith('A'), '应保留 head')
  assert.ok(folded.endsWith('B'), '应保留 tail')
  assert.ok(!folded.includes('MIDDLE'), '中段内容应被丢弃')
  assert.ok(folded.length < 4500, `折叠后应约等于 head+tail+marker，实际 ${folded.length}`)

  // 落盘确实发生了
  const spillDir = path.join(home, 'context-fold', 'spill')
  const files = fs.readdirSync(spillDir)
  assert.ok(files.some((f) => f.startsWith('call_7-0')), `spill 目录应有 call_7-0，实际 ${files}`)

  // recall 能拿回完整原文
  const recalled = await host.tool().execute({ action: 'recall', query: 'call_7-0' })
  assert.equal(recalled.ok, true)
  assert.equal(recalled.spill.found, true)
  assert.equal(recalled.spill.text, original, '回捞必须是逐字节原文')
  assert.ok(recalled.spill.bytes >= original.length)

  // status 计数同步
  const status = await host.tool().execute({ action: 'status' })
  assert.equal(status.counters.folds, 1)
  assert.ok(status.counters.savedTokensEstimate > 0)
  assert.equal(status.capabilities.pruner.ready, true)
})

test('折叠：短结果原样透传（返回同一个 decision 对象）', async (t) => {
  withTempHome(t)
  const host = makeHost()
  apply(host.ctx, {})

  const listener = host.one('tools/post-execute')
  const original = 'short output'
  const base = { kind: 'accept', content: [{ type: 'text', text: original }] }
  const decision = await listener(
    { callId: 'c1', name: 'bash' },
    { isError: false, value: {}, content: base.content },
    async () => base,
  )
  assert.equal(decision, base, '不该复制对象，直接透传')
  assert.equal(decision.content[0].text, original)
})

test('折叠：isError 结果不折叠（错误信息是排查线索）', async (t) => {
  withTempHome(t)
  const host = makeHost()
  apply(host.ctx, {})

  const big = 'E'.repeat(30000)
  const listener = host.one('tools/post-execute')
  const base = { kind: 'accept', content: [{ type: 'text', text: big }] }
  const decision = await listener(
    { callId: 'c2', name: 'bash' },
    { isError: true, error: { message: 'failed' }, content: base.content },
    async () => base,
  )
  assert.equal(decision, base)
  assert.equal(decision.content[0].text, big)
})

test('折叠：宿主返回 block 决策时不动它', async (t) => {
  withTempHome(t)
  const host = makeHost()
  apply(host.ctx, {})

  const listener = host.one('tools/post-execute')
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'denied' }] }
  const decision = await listener(
    { callId: 'c3', name: 'bash' },
    { isError: false, value: {}, content: [] },
    async () => blocked,
  )
  assert.equal(decision, blocked)
})

// ──────────────────── 3. 能力 B：折叠账本 + 回捞 ────────────────────

test('账本：compaction/summary 的真实 payload 被正确映射', async (t) => {
  withTempHome(t)
  const host = makeHost()
  apply(host.ctx, {})

  const session = fakeSession('sess-1')
  const listener = host.one('session/event')
  listener(session, {
    type: 'compaction/summary',
    seq: 42,
    time: 1_700_000_000_000,
    // 宿主真实字段：compactionId + shadowedRange，没有顶层 startSeq/endSeq/blockId
    data: {
      compactionId: 'cmp-abc',
      summary: '重构了 parser 的循环依赖，决定把 tokenizer 抽成独立模块。',
      shadowedRange: { start: 10, end: 41 },
      shadowedSeqs: [10, 11, 12, 13],
      shadowedTokenCount: 9876,
      provider: 'p',
      model: 'm',
    },
  })

  await tick()

  const ledger = await host.tool().execute({ action: 'ledger' })
  assert.equal(ledger.total, 1)
  assert.equal(ledger.entries.length, 1)
  const entry = ledger.entries[0]
  assert.equal(entry.blockId, 'cmp-abc')
  assert.equal(entry.startSeq, 10)
  assert.equal(entry.endSeq, 41)
  assert.equal(entry.shadowedTokenCount, 9876)
  assert.equal(entry.shadowedCount, 4)
  assert.equal(entry.sessionId, 'sess-1')
  assert.equal(entry.summarySeq, 42)

  // 按关键词回捞（中文 bigram BM25）
  const hit = await host.tool().execute({ action: 'recall', query: '循环依赖' })
  assert.equal(hit.ok, true)
  assert.equal(hit.ledger.mode, 'bm25')
  assert.ok(hit.ledger.hits.length >= 1)
  assert.equal(hit.ledger.hits[0].blockId, 'cmp-abc')
})

test('账本：非 compaction/summary 事件不落账本', async (t) => {
  withTempHome(t)
  const host = makeHost()
  apply(host.ctx, {})

  const listener = host.one('session/event')
  listener(fakeSession('s'), { type: 'user/message', seq: 1, data: { text: 'hi' } })
  listener(fakeSession('s'), { type: 'tool/result', seq: 2, data: { text: 'ok' } })
  await tick()

  const ledger = await host.tool().execute({ action: 'ledger' })
  assert.equal(ledger.total, 0)
})

test('账本：recall 空 query 返回结构化错误而不是抛错', async (t) => {
  withTempHome(t)
  const host = makeHost()
  apply(host.ctx, {})
  const res = await host.tool().execute({ action: 'recall', query: '   ' })
  assert.equal(res.ok, false)
  assert.match(res.error, /需要 query/)
})

// ──────────────────── 4. 能力 C：记忆写入与注入 ────────────────────

test('记忆：turn-stopping 不阻塞 turn（background 默认），抽取在后台完成', async (t) => {
  withTempHome(t)
  // 模型故意慢 120ms：如果监听器 await 了抽取，这里会明显超时。
  const llm = fakeLlm([
    { type: 'decision', text: '决定用 bigram BM25 而不是向量检索，避免引入外部依赖。' },
    { type: 'lesson', text: 'Node 24 下 node --test 传目录会失败，必须传 glob。' },
  ], { delayMs: 120 })
  const session = fakeSession('sess-m', [
    { type: 'user/message', seq: 1, data: { text: '帮我修一下测试' } },
    { type: 'assistant/message', seq: 2, data: { text: '好的，我来看看' } },
  ])
  const host = makeHost({ llm, sessions: { get: () => session } })
  apply(host.ctx, { memory: { minTranscriptChars: 0 } })

  const listener = host.one('agent/turn-stopping')
  const startedAt = Date.now()
  await listener({ agent: { id: 'sess-m' }, turn: 3, signal: { aborted: false } })
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 60, `turn-stopping 必须立即返回（实测 ${elapsed}ms），不能等模型`)

  await tick(250) // 等后台抽取跑完
  assert.equal(llm.calls.length, 1, '每轮最多一次 llm.stream')
  const call = llm.calls[0]
  assert.equal(call.provider, 'test-provider')
  assert.equal(call.model, 'test-model')
  assert.equal(call.temperature, 0)
  // 记忆抽取不能设置 purpose（宿主只允许 'compaction' | 'session-title'）
  assert.equal(call.purpose, undefined)

  const status = await host.tool().execute({ action: 'status' })
  assert.equal(status.counters.memoryWrites, 2)
  assert.equal(status.counters.llmCalls, 1)
  assert.equal(status.capabilities.memory.ready, true)
  assert.equal(status.capabilities.memory.extractReady, true)
})

test('记忆：extractMode=blocking 时监听器会等抽取完成', async (t) => {
  withTempHome(t)
  const llm = fakeLlm([
    { type: 'fact', text: '阻塞模式用于需要确定性时序的场景。' },
    { type: 'fact', text: '默认必须是 background。' },
  ])
  const session = fakeSession('sess-b', [
    { type: 'user/message', seq: 1, data: { text: 'hi' } },
  ])
  const host = makeHost({ llm, sessions: { get: () => session } })
  apply(host.ctx, { memory: { extractMode: 'blocking', minTranscriptChars: 0 } })

  await host.one('agent/turn-stopping')({ agent: { id: 'sess-b' }, turn: 1, signal: {} })
  // 不需要 tick：blocking 模式下返回即已写完。
  const status = await host.tool().execute({ action: 'status' })
  assert.equal(status.counters.memoryWrites, 2)
})

test('记忆：extractMode=off 时不注册抽取监听器', async (t) => {
  withTempHome(t)
  const host = makeHost()
  apply(host.ctx, { memory: { extractMode: 'off' } })
  assert.equal(host.handlers.has('agent/turn-stopping'), false, 'off 模式必须零监听器')
})

test('记忆：转录过短时跳过抽取（省一次模型往返）', async (t) => {
  withTempHome(t)
  const llm = fakeLlm([{ type: 'fact', text: '不该被写入。' }])
  const session = fakeSession('sess-short', [
    { type: 'user/message', seq: 1, data: { text: 'hi' } },
  ])
  const host = makeHost({ llm, sessions: { get: () => session } })
  apply(host.ctx, { memory: { minTranscriptChars: 10_000 } })

  await host.one('agent/turn-stopping')({ agent: { id: 'sess-short' }, turn: 1, signal: {} })
  await tick()
  assert.equal(llm.calls.length, 0, '短回合不应调用 LLM')
  const status = await host.tool().execute({ action: 'status' })
  assert.equal(status.counters.extractSkipped, 1)
})

test('记忆：同一轮重复触发只调用一次 LLM', async (t) => {
  withTempHome(t)
  const llm = fakeLlm([
    { type: 'fact', text: '这个仓库用 pnpm 而不是 npm。' },
    { type: 'fact', text: 'profile 目录在 ~/.dsh/profiles/desktop。' },
  ])
  const session = fakeSession('sess-r', [
    { type: 'user/message', seq: 1, data: { text: 'hello' } },
  ])
  const host = makeHost({ llm, sessions: { get: () => session } })
  apply(host.ctx, { memory: { minTranscriptChars: 0 } })

  const listener = host.one('agent/turn-stopping')
  await listener({ agent: { id: 'sess-r' }, turn: 7, signal: { aborted: false } })
  await listener({ agent: { id: 'sess-r' }, turn: 7, signal: { aborted: false } })
  await tick(150)
  assert.equal(llm.calls.length, 1, '同一 turn 不得重复抽取')
})

test('记忆：LLM 失败只降级，不抛错阻塞 turn', async (t) => {
  withTempHome(t)
  const llm = fakeLlm([], { fail: true })
  const session = fakeSession('sess-f', [
    { type: 'user/message', seq: 1, data: { text: 'hi' } },
  ])
  const host = makeHost({ llm, sessions: { get: () => session } })
  apply(host.ctx, { memory: { minTranscriptChars: 0 } })

  const listener = host.one('agent/turn-stopping')
  // background 模式下监听器返回 undefined（不返回 promise），所以包成 async 函数。
  await assert.doesNotReject(async () => {
    await listener({ agent: { id: 'sess-f' }, turn: 1, signal: { aborted: false } })
  })
  await tick(150)
  const status = await host.tool().execute({ action: 'status' })
  assert.equal(status.counters.llmFailures, 1)
  assert.equal(status.counters.memoryWrites, 0)
})

test('记忆：候选不足 2 条时不落库（避免噪声）', async (t) => {
  withTempHome(t)
  const llm = fakeLlm([{ type: 'fact', text: '只有一条记忆。' }])
  const session = fakeSession('sess-1i', [
    { type: 'user/message', seq: 1, data: { text: 'hi' } },
  ])
  const host = makeHost({ llm, sessions: { get: () => session } })
  apply(host.ctx, { memory: { minTranscriptChars: 0 } })

  await host.one('agent/turn-stopping')({ agent: { id: 'sess-1i' }, turn: 1, signal: {} })
  await tick(150)
  const status = await host.tool().execute({ action: 'status' })
  assert.equal(status.counters.memoryWrites, 0)
})

test('记忆：system-prompt/assemble 注入到 contexts（不是 sections）', async (t) => {
  withTempHome(t)
  const llm = fakeLlm([
    { type: 'decision', text: '决定用 bigram BM25 而不是向量检索。' },
    { type: 'lesson', text: '必须传 glob 给 node --test。' },
  ])
  const session = fakeSession('sess-a', [
    { type: 'user/message', seq: 1, data: { text: 'hi' } },
  ])
  const host = makeHost({ llm, sessions: { get: () => session } })
  apply(host.ctx, { memory: { minTranscriptChars: 0 } })

  await host.one('agent/turn-stopping')({ agent: { id: 'sess-a' }, turn: 1, signal: {} })
  await tick(150) // 默认 background：等后台抽取写完

  const listener = host.one('system-prompt/assemble')
  const assembly = { sections: [{ name: 'base', text: 'BASE' }], contexts: [], tools: [], variables: {} }
  const out = await listener(assembly, {}, async () => assembly)

  assert.equal(out.sections.length, 1, 'sections 必须原样保留（complete scope 下会被恢复覆盖）')
  assert.equal(out.contexts.length, 1)
  assert.equal(out.contexts[0].name, 'context-fold/memory')
  assert.match(out.contexts[0].text, /BM25|glob/)
})

test('记忆：没有记忆时不注入空 context', async (t) => {
  withTempHome(t)
  const host = makeHost()
  apply(host.ctx, {})

  const listener = host.one('system-prompt/assemble')
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const out = await listener(assembly, {}, async () => assembly)
  assert.deepEqual(out.contexts, [])
})

// ──────────────────── 4b. 记忆作用域（项目分区）────────────────────

test('scope：写入的记忆带当前项目 scope', async (t) => {
  withTempHome(t)
  const llm = fakeLlm([
    { type: 'fact', text: '这个仓库必须在 Node 22 上跑通。' },
    { type: 'lesson', text: 'CI 的线程池大小是固定的。' },
  ])
  const session = fakeSession('sess-sc', [
    { type: 'user/message', seq: 1, data: { text: '帮我修一下' } },
  ])
  const host = makeHost({ llm, sessions: { get: () => session } })
  apply(host.ctx, { memory: { minTranscriptChars: 0 } })

  await host.one('agent/turn-stopping')({ agent: { id: 'sess-sc' }, turn: 1, signal: {} })
  await tick(150) // 默认 background：等后台抽取写完

  const store = await fs.promises.readFile(
    path.join(process.env.DSH_HOME, 'context-fold', 'memory.jsonl'), 'utf8',
  )
  const [record] = store.trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(record.scope, '每条记忆必须带 scope')
  assert.ok(record.scope.cwd.length > 0, 'scope.cwd 非空')
  assert.ok(record.scope.repo.length > 0, 'scope.repo 非空')
})

test('scope：prefer 模式下本仓库记忆排在跨仓库记忆前面', async (t) => {
  withTempHome(t)
  // 手工写入：一条本仓库、一条别的仓库，文本都命中同一个查询词。
  const home = process.env.DSH_HOME
  const dir = path.join(home, 'context-fold')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const lines = [
    { id: 'mem-000001', type: 'fact', text: '线程池大小固定为 4', ts: now, evidenceSeq: 1, hits: 0, lastHitAt: 0, scope: { cwd: 'd:/other/ci', repo: 'ci' } },
    { id: 'mem-000002', type: 'fact', text: '线程池大小固定为 4', ts: now, evidenceSeq: 2, hits: 0, lastHitAt: 0, scope: { cwd: 'd:/here/ctxfold', repo: path.basename(process.cwd()) } },
  ]
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)

  const session = fakeSession('sess-sc2', [{ type: 'user/message', seq: 1, data: { text: 'hi' } }])
  // 把 cwd 指到本仓库目录，让 detectScope 认出 repo=ctxfold
  const prev = process.cwd()
  process.chdir(path.resolve('.'))
  t.after(() => process.chdir(prev))

  const host = makeHost({ llm: fakeLlm([]), sessions: { get: () => session } })
  apply(host.ctx, { memory: { scopeMode: 'prefer', scopeWeight: 0.6 } })

  const listener = host.one('system-prompt/assemble')
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const out = await listener(assembly, {}, async () => assembly)
  // 两条同文本同时间，只有 scope 不同 → 本仓库的必须先出现
  assert.equal(out.contexts.length, 1)
  assert.match(out.contexts[0].text, /线程池/)
})

test('scope：strict 模式下完全丢弃跨仓库记忆', async (t) => {
  withTempHome(t)
  const home = process.env.DSH_HOME
  const dir = path.join(home, 'context-fold')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  // 本仓库的判定来自 apply() 里真实的 detectScope(process.cwd())，所以
  // "同仓库"那条必须用真实 cwd 的 basename 当 repo，否则测试会假失败。
  const currentRepo = path.basename(process.cwd())
  const lines = [
    { id: 'mem-000001', type: 'fact', text: '帧解析 offset 越界要抛 RangeError', ts: now, evidenceSeq: 1, hits: 0, lastHitAt: 0, scope: { cwd: 'd:/other/proj', repo: 'proj' } },
    { id: 'mem-000002', type: 'fact', text: '帧解析 offset 越界要抛 RangeError', ts: now, evidenceSeq: 2, hits: 0, lastHitAt: 0, scope: { cwd: 'd:/here/x', repo: currentRepo } },
  ]
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)

  const session = fakeSession('sess-sc3', [{ type: 'user/message', seq: 1, data: { text: 'hi' } }])
  const host = makeHost({ llm: fakeLlm([]), sessions: { get: () => session } })
  apply(host.ctx, { memory: { scopeMode: 'strict' } })

  const listener = host.one('system-prompt/assemble')
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const out = await listener(assembly, {}, async () => assembly)
  assert.equal(out.contexts.length, 1, '本仓库的记忆仍然注入')
  // strict 只保留本仓库那条，跨仓库的被过滤掉
  const hits = await host.tool().execute({ action: 'recall', query: '帧解析 offset' })
  assert.equal(hits.memory.length, 1, 'strict 模式只召回本仓库记忆')
  assert.equal(hits.memory[0].scope.repo, currentRepo)
})

test('scope：scopeMode off 时退化为旧的全局行为', async (t) => {
  withTempHome(t)
  const home = process.env.DSH_HOME
  const dir = path.join(home, 'context-fold')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const lines = [
    { id: 'mem-000001', type: 'fact', text: '另一个项目的约束', ts: now, evidenceSeq: 1, hits: 0, lastHitAt: 0, scope: { cwd: 'd:/other/proj', repo: 'proj' } },
    { id: 'mem-000002', type: 'fact', text: '另一个项目的约束', ts: now, evidenceSeq: 2, hits: 0, lastHitAt: 0, scope: { cwd: 'd:/here/ctxfold', repo: 'ctxfold' } },
  ]
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)

  const session = fakeSession('sess-sc4', [{ type: 'user/message', seq: 1, data: { text: 'hi' } }])
  const host = makeHost({ llm: fakeLlm([]), sessions: { get: () => session } })
  apply(host.ctx, { memory: { scopeMode: 'off' } })

  const hits = await host.tool().execute({ action: 'recall', query: '另一个项目的约束' })
  assert.equal(hits.memory.length, 2, 'off 模式不做任何 scope 过滤')
})

test('scope：历史遗留的无 scope 记忆仍可被召回（不被 strict 误杀）', async (t) => {
  withTempHome(t)
  const home = process.env.DSH_HOME
  const dir = path.join(home, 'context-fold')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const lines = [
    { id: 'mem-000001', type: 'lesson', text: '日志中绝对不能打印用户 token', ts: now, evidenceSeq: 1, hits: 0, lastHitAt: 0 },
  ]
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)

  const session = fakeSession('sess-sc5', [{ type: 'user/message', seq: 1, data: { text: 'hi' } }])
  const host = makeHost({ llm: fakeLlm([]), sessions: { get: () => session } })
  apply(host.ctx, { memory: { scopeMode: 'strict' } })

  const hits = await host.tool().execute({ action: 'recall', query: '日志 token' })
  assert.equal(hits.memory.length, 1, '无 scope 的旧记忆在 strict 下仍可用')
})


// ───────────────────────────── 5. 综合 ─────────────────────────────

test('status：完整报告结构与降级原因', async (t) => {
  const home = withTempHome(t)
  const host = makeHost() // 无 llm
  apply(host.ctx, {})

  const status = await host.tool().execute({ action: 'status' })
  assert.equal(status.ok, true)
  assert.equal(status.plugin, 'context-fold')
  assert.equal(status.mode, 'complement')
  assert.equal(status.root, path.join(home, 'context-fold'))
  // 无 llm 时记忆写入应明确降级而不是报 ok
  assert.equal(status.capabilities.memory.ready, false)
  assert.equal(status.capabilities.memory.extractReady, false)
  assert.match(status.capabilities.memory.reason, /llm 服务不可用/)
  assert.equal(status.capabilities.ledger.ready, true)
  assert.deepEqual(Object.keys(status.counters).sort(), [
    'extractSkipped', 'folds', 'ledgerEntries', 'llmCalls', 'llmFailures',
    'memoryEntries', 'memoryWrites', 'savedTokensEstimate', 'spilledBytes',
  ])
})

test('未知 action 返回可用列表', async (t) => {
  withTempHome(t)
  const host = makeHost()
  apply(host.ctx, {})
  const res = await host.tool().execute({ action: 'nope' })
  assert.equal(res.ok, false)
  assert.match(res.error, /status \| recall \| prune \| ledger/)
})

test('prune：无会话时返回结构化错误', async (t) => {
  withTempHome(t)
  const host = makeHost()
  apply(host.ctx, {})
  const res = await host.tool().execute({ action: 'prune' }, { agent: { id: 'missing' } })
  assert.equal(res.ok, false)
  assert.match(res.error, /找不到当前会话/)
})

test('prune：扫描出超长工具结果并落盘，但不改写历史', async (t) => {
  const home = withTempHome(t)
  const big = 'X'.repeat(20000)
  // 真实事件形状：tool/result 的正文在 data.message.content 块数组里。
  const session = fakeSession('sess-p', [
    {
      type: 'tool/result',
      seq: 1,
      data: { message: { toolCallId: 'c9', content: [{ type: 'text', text: big }] } },
    },
  ])
  const host = makeHost({ sessions: { get: () => session } })
  apply(host.ctx, {})

  const res = await host.tool().execute({ action: 'prune' }, { agent: { id: 'sess-p' } })
  assert.equal(res.ok, true)
  assert.equal(res.foldable, 1)
  assert.equal(res.spilled, 1)
  assert.match(res.note, /append-only/)

  const files = fs.readdirSync(path.join(home, 'context-fold', 'spill'))
  assert.equal(files.length, 1)
  // 历史事件本身没被改
  assert.equal(session.ownEvents()[0].data.message.content[0].text, big)
})

test('装配：ctx.effect 存在时把清理函数交给它托管', (t) => {
  withTempHome(t)
  const host = makeHost()
  apply(host.ctx, {})
  assert.ok(host.effects.length >= 1, '工具注册的 dispose 应交给 ctx.effect')
  const dispose = host.effects[0]()
  assert.equal(typeof dispose, 'function')
})
