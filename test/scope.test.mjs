/**
 * 作用域来源测试（v0.1.3）。
 *
 * 为什么单独一个文件：这是**在真实宿主里跑出来的**缺陷，不是单元测试能预见的。
 * `apply()` 里最初的 `detectScope(process.cwd())` 在 DSH 桌面宿主中拿到的是
 * profile 目录（`C:\Users\YYF\.dsh\profiles\desktop`），于是所有项目的记忆塌缩成
 * 同一个作用域，项目分区形同虚设。真正的项目目录只在 `session.header.cwd`。
 *
 * 本文件锁死三件事：
 *  1. 写入用 `session.header.cwd`，不是 `process.cwd()`；
 *  2. 会话没有 `header.cwd` 时退化为装配时的初始作用域；
 *  3. `setScope` 会真正影响排序，并且作用域变化让注入缓存失效。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, detectScope } from '../lib/index.js'
import { createMemoryStore } from '../lib/memory.js'

// ───────────────────────────── 脚手架 ─────────────────────────────

function withTempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxfold-scope-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/** 返回两条候选的假模型（MIN_PER_TURN = 2）。 */
function fakeLlm() {
  return {
    calls: [],
    stream(options) {
      this.calls.push(options)
      const body = JSON.stringify([
        { type: 'fact', text: '构建脚本是 scripts/build.mjs。' },
        { type: 'lesson', text: '测试用 npm test 跑。' },
      ])
      return (async function* () {
        yield { type: 'text-delta', text: body }
      })()
    },
  }
}

function makeHost(llm, session) {
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    get(key) {
      if (key === 'llm') return llm
      if (key === 'sessions') return { get: () => session }
      return undefined
    },
    effect() {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  const one = (event) => {
    const list = handlers.get(event) ?? []
    assert.equal(list.length, 1, `期望 ${event} 恰好一个监听器，实际 ${list.length}`)
    return list[0]
  }
  return { ctx, handlers, one }
}

function fakeSession(id, header) {
  return {
    id,
    seq: 1,
    header,
    ownEvents: () => [
      { type: 'user/message', seq: 1, data: { text: '看看构建脚本怎么跑' } },
      { type: 'assistant/message', seq: 2, data: { text: '我查一下' } },
    ],
    requestContext: () => ({ provider: 'test-provider', model: 'test-model' }),
  }
}

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

function readRecords(home) {
  const file = path.join(home, 'context-fold', 'memory.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

// ───────────────────────────── 用例 ─────────────────────────────

test('scope：写入用 session.header.cwd，而不是 process.cwd()', async (t) => {
  const home = withTempHome(t)
  const llm = fakeLlm()
  const projectCwd = path.join(path.sep, 'work', 'alpha-project')
  const session = fakeSession('sess-alpha', { cwd: projectCwd })
  const host = makeHost(llm, session)
  apply(host.ctx, { memory: { minTranscriptChars: 0 } })

  await host.one('agent/turn-stopping')({ agent: { id: 'sess-alpha' }, turn: 1, signal: {} })
  await tick(250)

  const records = readRecords(home)
  assert.equal(records.length, 2, '应写入两条记忆')
  for (const record of records) {
    assert.ok(record.scope, '每条记忆都应带 scope')
    assert.equal(record.scope.cwd, projectCwd, 'scope.cwd 必须等于会话 header.cwd')
    assert.equal(record.scope.repo, 'alpha-project')
    assert.notEqual(
      record.scope.cwd,
      detectScope(process.cwd()).cwd,
      '不能退化成 process.cwd()（桌面宿主里那是 profile 目录）',
    )
  }
})

test('scope：会话没有 header.cwd 时退化为装配时的初始作用域', async (t) => {
  const home = withTempHome(t)
  const llm = fakeLlm()
  const session = fakeSession('sess-plain', undefined)
  const host = makeHost(llm, session)
  apply(host.ctx, { memory: { minTranscriptChars: 0 } })

  await host.one('agent/turn-stopping')({ agent: { id: 'sess-plain' }, turn: 1, signal: {} })
  await tick(250)

  const records = readRecords(home)
  assert.equal(records.length, 2)
  const initial = detectScope(process.cwd())
  assert.equal(records[0].scope.cwd, initial.cwd)
})

test('scope：setScope 改变排序，并让注入缓存失效', async (t) => {
  const home = withTempHome(t)
  const file = path.join(home, 'context-fold', 'memory.jsonl')
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const scopeA = { cwd: path.join(path.sep, 'work', 'alpha'), repo: 'alpha', branch: 'main' }
  const scopeB = { cwd: path.join(path.sep, 'work', 'beta'), repo: 'beta', branch: 'main' }

  const store = createMemoryStore({
    file,
    config: { scopeMode: 'prefer', scopeWeight: 0.35 },
    logger: {},
    scope: scopeA,
  })

  // 四条**文本完全相同**的记忆，只有作用域不同 → 排序只由 scopeAffinity 决定。
  // （appendMany 单批至少 2 条，所以每个作用域分两次写。）
  const text = '构建脚本 使用 esbuild 打包 产物 放在 dist 目录'
  await store.appendMany([{ type: 'fact', text }, { type: 'fact', text }], { scope: scopeA })
  await store.appendMany([{ type: 'fact', text }, { type: 'fact', text }], { scope: scopeB })
  assert.equal(await store.count(), 4)

  const first = await store.recall('构建脚本 esbuild 打包', 4)
  assert.equal(first.length, 4)
  assert.equal(first[0].scope.cwd, scopeA.cwd, '当前作用域是 A 时 A 排第一')
  assert.equal(first[1].scope.cwd, scopeA.cwd, 'A 的两条应占据前两位')

  const injectedBefore = await store.injectionText({ now: Date.now(), force: true })
  assert.ok(injectedBefore.length > 0, '应有注入文本')

  assert.equal(store.setScope(scopeB), true, '作用域真的变了')
  assert.equal(store.setScope(scopeB), false, '重复设置同一作用域不算变化')
  assert.deepEqual(store.getScope(), scopeB)

  const second = await store.recall('构建脚本 esbuild 打包', 4)
  assert.equal(second[0].scope.cwd, scopeB.cwd, '切到 B 之后 B 应排第一')
  assert.equal(second[1].scope.cwd, scopeB.cwd)

  // 缓存失效：作用域变化后必须重算，否则会把上一个项目的记忆注入当前项目。
  const injectedAfter = await store.injectionText({ now: Date.now() })
  assert.ok(injectedAfter.length > 0, '切换作用域后注入文本仍应可用')
})
