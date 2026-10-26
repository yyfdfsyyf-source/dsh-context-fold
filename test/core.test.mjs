/**
 * 核心逻辑测试（`node --test test/`）。
 *
 * 覆盖：BM25 分词与排序、折叠判定与 region 选择、记忆衰减与预算、配置校验、
 * compaction 事件到账本记录的映射、记忆抽取解析。
 *
 * 这些被测模块**全部不依赖 ctx**，所以基准测试可以直接 import 复用。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { tokenize, createIndex, scoreIndex, search, searchDocs, BM25_K1, BM25_B, compareId } from '../lib/core/bm25.js'
import { selectKeptRegions, sliceRegions } from '../lib/core/region.js'
import { decideFold, buildFoldMarker, buildFoldedText, savedTokens, FOLD_MARKER_PREFIX } from '../lib/core/prune.js'
import { decayFactor, rankMemories, selectWithinBudget, shouldRefreshInjection, DEFAULT_HALF_LIFE_DAYS } from '../lib/core/decay.js'
import { normalizePath, deriveScope, scopeAffinity, shouldExcludeInStrictMode, applyScopeWeight } from '../lib/core/scope.js'
import { estimateTokens, byteLength, maxCharsForTokens, truncateToTokens, slugId, CHARS_PER_TOKEN } from '../lib/core/tokens.js'
import { DEFAULT_CONFIG, normalizeConfig, validateConfig } from '../lib/config.js'
import { recordFromSessionEvent } from '../lib/ledger.js'
import { parseExtraction, buildInjectionText, MEMORY_TYPES, MAX_PER_TURN, MIN_PER_TURN } from '../lib/memory.js'
import { foldContentBlocks, scanSessionForFoldables } from '../lib/prune.js'

// ───────────────────────────── tokens ─────────────────────────────

test('tokens: 常数与粗估', () => {
  assert.equal(CHARS_PER_TOKEN, 3.5)
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(null), 0)
  assert.equal(estimateTokens('abcd'), 2) // ceil(4/3.5)=2
  assert.equal(maxCharsForTokens(1200), 4200)
  assert.equal(truncateToTokens('abcdefgh', 1).length, 3)
  assert.equal(byteLength('中'), 3)
  assert.equal(slugId('a/b:c d'), 'abcd')
  assert.equal(slugId(''), 'unknown')
})

// ───────────────────────────── bm25 ─────────────────────────────

test('bm25: 中文按字 bigram 切分', () => {
  assert.deepEqual(tokenize('上下文折叠'), ['上下', '下文', '文折', '折叠'])
  // 单字片段退化为该字本身
  assert.deepEqual(tokenize('折'), ['折'])
  // 拉丁词小写、数字保留
  assert.deepEqual(tokenize('Foo Bar 42'), ['foo', 'bar', '42'])
  // 中英混排会被切成独立片段
  assert.deepEqual(tokenize('用 BM25 检索'), ['用', 'bm25', '检索'])
})

test('bm25: 参数是约定的 k1=1.2 b=0.75', () => {
  assert.equal(BM25_K1, 1.2)
  assert.equal(BM25_B, 0.75)
})

test('bm25: 相关文档排第一', () => {
  const docs = [
    { id: 'd1', text: '今天天气很好，适合出门散步' },
    { id: 'd2', text: '上下文折叠插件会把超长的工具结果落盘，只保留头尾' },
    { id: 'd3', text: '数据库连接池的配置需要调整' },
  ]
  const hits = searchDocs(docs, '折叠 工具结果', 3)
  assert.ok(hits.length > 0)
  assert.equal(hits[0].id, 'd2')
})

test('bm25: 同分时按 id 升序稳定排序', () => {
  const docs = [
    { id: 'z-last', text: '完全一样的内容 abc' },
    { id: 'a-first', text: '完全一样的内容 abc' },
    { id: 'm-mid', text: '完全一样的内容 abc' },
  ]
  const hits = searchDocs(docs, 'abc', 3)
  assert.deepEqual(hits.map((hit) => hit.id), ['a-first', 'm-mid', 'z-last'])
})

test('bm25: 0 分被过滤；空查询返回空', () => {
  const docs = [{ id: 'd1', text: '苹果香蕉' }]
  assert.equal(searchDocs(docs, '橙子', 5).length, 0)
  assert.equal(searchDocs(docs, '', 5).length, 0)
  assert.equal(searchDocs([], 'x', 5).length, 0)
})

test('bm25: 词频与长度归一化影响分数', () => {
  const index = createIndex([
    { id: 'short', text: '折叠' },
    { id: 'long', text: `折叠${'填充内容'.repeat(50)}` },
  ])
  const rows = scoreIndex(index, '折叠')
  const short = rows.find((row) => row.id === 'short')
  const long = rows.find((row) => row.id === 'long')
  assert.ok(short.score > long.score, '短文档应该因为长度归一化得分更高')
})

test('compareId: 稳定比较器', () => {
  assert.equal(compareId('a', 'b'), -1)
  assert.equal(compareId('b', 'a'), 1)
  assert.equal(compareId('a', 'a'), 0)
})

// ───────────────────────── region / prune ─────────────────────────

test('region: 保留头尾并给出被丢弃区间', () => {
  const text = 'x'.repeat(100)
  const result = selectKeptRegions(text, { keepHead: 10, keepTail: 10 })
  assert.equal(result.truncated, true)
  assert.deepEqual(result.regions, [
    { kind: 'head', start: 0, end: 10 },
    { kind: 'tail', start: 90, end: 100 },
  ])
  assert.deepEqual(result.dropped, [{ start: 10, end: 90 }])
  assert.equal(result.keptChars, 20)
  assert.equal(result.droppedChars, 80)
})

test('region: 头尾预算已覆盖全文时不截断', () => {
  const text = 'x'.repeat(20)
  const result = selectKeptRegions(text, { keepHead: 10, keepTail: 10 })
  assert.equal(result.truncated, false)
  assert.deepEqual(result.dropped, [])
  assert.equal(result.keptChars, 20)
})

test('region: sliceRegions 拼回保留部分', () => {
  const text = '0123456789'
  const result = selectKeptRegions(text, { keepHead: 3, keepTail: 2 })
  assert.equal(sliceRegions(text, result.regions), '01289')
})

test('prune: 短文本不折叠', () => {
  assert.equal(decideFold('短文本', { maxChars: 8000, keepHead: 2000, keepTail: 2000 }), null)
  assert.equal(decideFold('', { maxChars: 10 }), null)
  assert.equal(decideFold(undefined, { maxChars: 10 }), null)
  assert.equal(decideFold(null, { maxChars: 10 }), null)
})

test('prune: 超长文本折叠并保留头尾', () => {
  const text = `${'H'.repeat(50)}${'M'.repeat(200)}${'T'.repeat(50)}`
  const plan = decideFold(text, { maxChars: 100, keepHead: 40, keepTail: 40 })
  assert.ok(plan)
  assert.equal(plan.head, 'H'.repeat(40))
  assert.equal(plan.tail, 'T'.repeat(40))
  assert.equal(plan.keptChars, 80)
  assert.equal(plan.droppedChars, 220)
  assert.equal(plan.bytes, Buffer.byteLength(text, 'utf8'))
})

test('prune: 头尾预算 >= maxChars 时不折叠', () => {
  const text = 'x'.repeat(200)
  assert.equal(decideFold(text, { maxChars: 100, keepHead: 60, keepTail: 60 }), null)
  // 恰好相等也不折叠
  assert.equal(decideFold(text, { maxChars: 100, keepHead: 50, keepTail: 50 }), null)
})

test('prune: 已折叠的文本不会被二次折叠', () => {
  const folded = `${FOLD_MARKER_PREFIX}abc-0，原文 9000 字节，用 context_fold recall abc-0 取回]\n`
  assert.equal(decideFold(folded + 'x'.repeat(9000), { maxChars: 100, keepHead: 10, keepTail: 10 }), null)
})

test('prune: 标记行与拼装格式符合约定', () => {
  const marker = buildFoldMarker({ id: 'abc-0', bytes: 12345 })
  assert.equal(marker, '\n[context-fold: 已折叠 abc-0，原文 12345 字节，用 context_fold recall abc-0 取回]\n')
  const text = buildFoldedText({ head: 'HEAD', tail: 'TAIL', marker })
  assert.equal(text, 'HEAD\n[context-fold: 已折叠 abc-0，原文 12345 字节，用 context_fold recall abc-0 取回]\nTAIL')
})

test('prune: savedTokens 是 chars/3.5 的粗估且非负', () => {
  assert.equal(savedTokens('a'.repeat(100), 'a'.repeat(20)), Math.ceil(80 / 3.5))
  assert.equal(savedTokens('short', 'much longer than before'), 0)
})

test('prune: foldContentBlocks 落盘并只改文本块', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxfold-'))
  try {
    const long = `${'A'.repeat(100)}${'B'.repeat(200)}${'C'.repeat(100)}`
    const blocks = [
      { type: 'text', text: long },
      { type: 'image', source: 'whatever' },
      { type: 'text', text: 'short' },
    ]
    const result = await foldContentBlocks(blocks, {
      callId: 'call-1',
      dir,
      pruner: { maxChars: 100, keepHead: 40, keepTail: 40 },
    })

    assert.equal(result.folds.length, 1)
    assert.equal(result.content.length, 3)
    // 非文本块原样透传
    assert.deepEqual(result.content[1], { type: 'image', source: 'whatever' })
    assert.equal(result.content[2].text, 'short')
    // 文本块被改写但仍是 text 块
    assert.equal(result.content[0].type, 'text')
    assert.ok(result.content[0].text.includes(FOLD_MARKER_PREFIX))
    assert.ok(result.content[0].text.startsWith('A'.repeat(40)))
    assert.ok(result.content[0].text.endsWith('C'.repeat(40)))
    // 原文完整落盘
    const spilled = await fs.readFile(path.join(dir, 'call-1-0.txt'), 'utf8')
    assert.equal(spilled, long)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ───────────────────────────── decay ─────────────────────────────

test('decay: 半衰期常数与衰减因子', () => {
  assert.equal(DEFAULT_HALF_LIFE_DAYS, 30)
  const now = Date.UTC(2025, 0, 31)
  assert.equal(decayFactor(now, now, 30), 1)
  assert.ok(Math.abs(decayFactor(now - 30 * 86_400_000, now, 30) - 0.5) < 1e-9)
  assert.ok(Math.abs(decayFactor(now - 60 * 86_400_000, now, 30) - 0.25) < 1e-9)
  // 未来时间不放大
  assert.equal(decayFactor(now + 86_400_000, now, 30), 1)
})

test('decay: 排序稳定（分数降序，同分按 id 升序）', () => {
  const now = Date.UTC(2025, 0, 31)
  const entries = [
    { id: 'mem-000003', text: '相同内容', ts: now },
    { id: 'mem-000001', text: '相同内容', ts: now },
    { id: 'mem-000002', text: '相同内容', ts: now },
  ]
  const ranked = rankMemories(entries, '', { now, halfLifeDays: 30 })
  assert.deepEqual(ranked.map((row) => row.id), ['mem-000001', 'mem-000002', 'mem-000003'])
})

test('decay: 相关记忆优先于仅靠新鲜度取胜的记忆', () => {
  const now = Date.UTC(2025, 0, 31)
  const old = now - 90 * 86_400_000
  const entries = [
    { id: 'mem-000001', text: '用户偏好使用 pnpm 而不是 npm', ts: old },
    { id: 'mem-000002', text: '今天天气不错适合散步', ts: now },
  ]
  const ranked = rankMemories(entries, 'pnpm 包管理器', { now, halfLifeDays: 30 })
  assert.equal(ranked[0].id, 'mem-000001')
})

test('decay: 空查询时纯按新鲜度排序', () => {
  const now = Date.UTC(2025, 0, 31)
  const entries = [
    { id: 'mem-000001', text: '旧记忆', ts: now - 60 * 86_400_000 },
    { id: 'mem-000002', text: '新记忆', ts: now },
  ]
  const ranked = rankMemories(entries, '', { now, halfLifeDays: 30 })
  assert.equal(ranked[0].id, 'mem-000002')
})

test('decay: selectWithinBudget 遵守条数上限', () => {
  const now = Date.UTC(2025, 0, 31)
  const entries = Array.from({ length: 10 }, (_, i) => ({
    id: `mem-${String(i).padStart(6, '0')}`,
    text: `记忆条目 ${i}`,
    ts: now - i * 86_400_000,
  }))
  const ranked = rankMemories(entries, '', { now })
  const { selected } = selectWithinBudget(ranked, { limit: 3, maxTokens: 1200 })
  assert.equal(selected.length, 3)
})

test('decay: selectWithinBudget 遵守 token 预算并截断首条', () => {
  const now = Date.UTC(2025, 0, 31)
  const entries = [
    { id: 'mem-000001', text: 'A'.repeat(400), ts: now },
    { id: 'mem-000002', text: 'B'.repeat(400), ts: now - 1000 },
  ]
  const ranked = rankMemories(entries, '', { now })
  const { selected, truncated } = selectWithinBudget(ranked, { limit: 6, maxTokens: 10 })
  // 预算 10 token ≈ 35 字符，只能放一条且被截断
  assert.equal(selected.length, 1)
  assert.equal(truncated, true)
  assert.equal(selected[0].text.length, 35)
})

test('decay: shouldRefreshInjection 的刷新条件', () => {
  // 从未构建 → 必须刷新
  assert.equal(shouldRefreshInjection({ built: false }, 5, 0, 2), true)
  // 构建后记忆数未增长 → 不刷新（保证前缀可缓存）
  assert.equal(shouldRefreshInjection({ built: true, count: 5, lastRecallEpoch: 0 }, 5, 0, 2), false)
  // 只增长 1 条 → 不刷新
  assert.equal(shouldRefreshInjection({ built: true, count: 5, lastRecallEpoch: 0 }, 6, 0, 2), false)
  // 增长 >= 2 条 → 刷新
  assert.equal(shouldRefreshInjection({ built: true, count: 5, lastRecallEpoch: 0 }, 7, 0, 2), true)
  // 显式 recall → 刷新
  assert.equal(shouldRefreshInjection({ built: true, count: 5, lastRecallEpoch: 0 }, 5, 1, 2), true)
})

// ───────────────────────────── config ─────────────────────────────

test('config: 空配置等于默认值', () => {
  const { config, warnings } = normalizeConfig(undefined)
  assert.deepEqual(config, {
    mode: 'complement',
    pruner: { enabled: true, maxChars: 8000, keepHead: 2000, keepTail: 2000 },
    memory: {
      enabled: true,
      injectLimit: 6,
      maxInjectTokens: 1200,
      decayHalfLifeDays: 30,
      scopeMode: 'prefer',
      scopeWeight: 0.35,
      extractMode: 'background',
      minTranscriptChars: 400,
    },
    ledger: { enabled: true, maxBlocks: 2000 },
  })
  assert.deepEqual(warnings, [])
  assert.deepEqual(DEFAULT_CONFIG.pruner, { enabled: true, maxChars: 8000, keepHead: 2000, keepTail: 2000 })
})

test('config: 部分配置与默认值合并', () => {
  const { config } = normalizeConfig({ mode: 'off', pruner: { maxChars: 100 } })
  assert.equal(config.mode, 'off')
  assert.equal(config.pruner.maxChars, 100)
  assert.equal(config.pruner.keepHead, 2000)
  assert.equal(config.ledger.maxBlocks, 2000)
})

test('config: 未知键被忽略并产生 warning', () => {
  const { config, warnings } = normalizeConfig({ nope: 1, pruner: { unknown: true } })
  assert.equal(config.mode, 'complement')
  assert.ok(warnings.some((w) => w.includes('nope')))
  assert.ok(warnings.some((w) => w.includes('pruner.unknown')))
})

test('config: 非法 mode 回退并 warning', () => {
  const { config, warnings } = normalizeConfig({ mode: 'weird' })
  assert.equal(config.mode, 'complement')
  assert.ok(warnings.some((w) => w.includes('mode')))
})

test('config: 类型错误回退默认值且不抛错', () => {
  const { config, warnings } = normalizeConfig({
    pruner: { enabled: 'yes', maxChars: 'big', keepHead: null },
    memory: { injectLimit: -3 },
  })
  assert.equal(config.pruner.enabled, true)
  assert.equal(config.pruner.maxChars, 8000)
  assert.equal(config.pruner.keepHead, 2000)
  assert.equal(config.memory.injectLimit, 1) // 收敛到下界
  assert.ok(warnings.length >= 3)
})

test('config: validateConfig 检查 head+tail 与 maxChars 的矛盾', () => {
  const bad = validateConfig({ pruner: { maxChars: 100, keepHead: 60, keepTail: 60 } })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((e) => e.includes('maxChars')))

  const good = validateConfig({ pruner: { maxChars: 8000, keepHead: 2000, keepTail: 2000 } })
  assert.equal(good.ok, true)
})

test('config: 非对象输入整体回退', () => {
  const { config, warnings } = normalizeConfig('oops')
  assert.equal(config.mode, 'complement')
  assert.ok(warnings.length > 0)
})

// ───────────────────────────── ledger ─────────────────────────────

test('ledger: 从真实 compaction/summary payload 映射记录', () => {
  const session = { id: 'sess-1' }
  const event = {
    type: 'compaction/summary',
    seq: 42,
    time: 1700000000000,
    data: {
      compactionId: 'cmp-9',
      summary: '这一段在讨论折叠策略与回捞',
      shadowedRange: { start: 10, end: 40 },
      shadowedSeqs: [11, 12, 13],
      shadowedTokenCount: 1234,
      provider: 'deepseek',
      model: 'deepseek-chat',
    },
  }
  const record = recordFromSessionEvent(session, event)
  assert.equal(record.blockId, 'cmp-9')
  assert.equal(record.startSeq, 10)
  assert.equal(record.endSeq, 40)
  assert.equal(record.shadowedTokenCount, 1234)
  assert.equal(record.summary, '这一段在讨论折叠策略与回捞')
  assert.equal(record.ts, 1700000000000)
  assert.equal(record.summarySeq, 42)
  assert.equal(record.sessionId, 'sess-1')
  assert.equal(record.shadowedCount, 3)
})

test('ledger: 非 compaction/summary 事件返回 null', () => {
  assert.equal(recordFromSessionEvent({ id: 's' }, { type: 'tool/result', seq: 1, data: {} }), null)
  assert.equal(recordFromSessionEvent({ id: 's' }, null), null)
  assert.equal(recordFromSessionEvent({ id: 's' }, { type: 'compaction/start', seq: 1, data: {} }), null)
})

test('ledger: 缺失 shadowedRange 时降级到 0', () => {
  const record = recordFromSessionEvent({ id: 's' }, { type: 'compaction/summary', seq: 5, data: { compactionId: 'c' } })
  assert.equal(record.startSeq, 0)
  assert.equal(record.endSeq, 0)
  assert.equal(record.shadowedTokenCount, 0)
  assert.equal(record.summary, '')
})

// ───────────────────────────── memory ─────────────────────────────

test('memory: 解析裸 JSON 数组', () => {
  const raw = '[{"type":"fact","text":"项目使用 pnpm","evidenceSeq":12},{"type":"decision","text":"选择 jsonl 而非 sqlite","evidenceSeq":15}]'
  const parsed = parseExtraction(raw)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].type, 'fact')
  assert.equal(parsed[0].evidenceSeq, 12)
})

test('memory: 解析带 Markdown 围栏的输出', () => {
  const raw = '好的，结果如下：\n```json\n[{"type":"lesson","text":"符号链接安装会导致裸导入失败","evidenceSeq":7}]\n```\n'
  const parsed = parseExtraction(raw)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].type, 'lesson')
})

test('memory: 丢弃非法 type / 过短 / 重复条目', () => {
  const raw = JSON.stringify([
    { type: 'nonsense', text: '这条应该被丢掉' },
    { type: 'fact', text: '短' },
    { type: 'fact', text: '这条是合法的记忆内容' },
    { type: 'fact', text: '这条是合法的记忆内容' },
  ])
  const parsed = parseExtraction(raw)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].text, '这条是合法的记忆内容')
})

test('memory: 最多返回 MAX_PER_TURN 条', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ type: 'fact', text: `这是一条足够长的记忆内容编号 ${i}` }))
  const parsed = parseExtraction(JSON.stringify(items))
  assert.equal(parsed.length, MAX_PER_TURN)
  assert.equal(MAX_PER_TURN, 6)
  assert.equal(MIN_PER_TURN, 2)
})

test('memory: 非法输入返回空数组而不抛错', () => {
  assert.deepEqual(parseExtraction(''), [])
  assert.deepEqual(parseExtraction('not json at all'), [])
  assert.deepEqual(parseExtraction('{"a":1}'), [])
  assert.deepEqual(parseExtraction(null), [])
  assert.deepEqual(parseExtraction('[broken'), [])
})

test('memory: 注入文本包含标题与条目，空输入返回空串', () => {
  assert.equal(buildInjectionText([]), '')
  const text = buildInjectionText([
    { id: 'mem-000001', type: 'decision', text: '选择 jsonl 存储', ts: Date.now() },
  ])
  assert.ok(text.includes('跨会话记忆'))
  assert.ok(text.includes('[decision] 选择 jsonl 存储'))
  assert.ok(text.includes('以当前对话为准'))
})

test('memory: MEMORY_TYPES 与约定一致', () => {
  assert.deepEqual([...MEMORY_TYPES], ['fact', 'decision', 'lesson', 'preference'])
})

test('prune: scanSessionForFoldables 只挑超长工具结果', () => {
  const long = 'x'.repeat(500)
  const session = {
    id: 's1',
    seq: 10,
    ownEvents: () => [
      { type: 'tool/result', seq: 3, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: long }] } } },
      { type: 'tool/result', seq: 4, data: { message: { toolCallId: 'c2', content: [{ type: 'text', text: 'short' }] } } },
      { type: 'user/message', seq: 5, data: { text: long } },
    ],
  }
  const foldables = scanSessionForFoldables(session, { maxChars: 100, keepHead: 10, keepTail: 10 })
  assert.equal(foldables.length, 1)
  assert.equal(foldables[0].callId, 'c1')
  assert.equal(foldables[0].seq, 3)
  assert.equal(foldables[0].text, long)
})

test('prune: scanSessionForFoldables 对缺失会话返回空数组', () => {
  assert.deepEqual(scanSessionForFoldables(undefined, { maxChars: 10 }), [])
  assert.deepEqual(scanSessionForFoldables({}, { maxChars: 10 }), [])
})

// ───────────────────────────── scope ─────────────────────────────

test('scope: normalizePath 统一分隔符并去尾斜杠', () => {
  assert.equal(normalizePath('D:\\dev\\dsh配置\\'), 'd:/dev/dsh配置')
  assert.equal(normalizePath('D:/dev/dsh配置'), 'd:/dev/dsh配置')
  assert.equal(normalizePath('/'), '/')
  assert.equal(normalizePath('  '), '')
  assert.equal(normalizePath(undefined), '')
})

test('scope: deriveScope 从 cwd 派生 repo，显式 repo 优先', () => {
  assert.deepEqual(deriveScope({ cwd: 'D:\\dev\\dsh配置\\' }), { cwd: 'd:/dev/dsh配置', repo: 'dsh配置', branch: '' })
  assert.deepEqual(deriveScope({ cwd: '/tmp/x', repo: 'override' }), { cwd: '/tmp/x', repo: 'override', branch: '' })
  assert.deepEqual(deriveScope(), { cwd: '', repo: '', branch: '' })
})

test('scope: scopeAffinity 的四档亲和度', () => {
  const current = { cwd: 'd:/dev/a', repo: 'a' }
  // 同一 cwd → 1
  assert.equal(scopeAffinity({ cwd: 'D:\\dev\\a' }, current), 1)
  // 同一 repo 不同 cwd → 0.85
  assert.equal(scopeAffinity({ cwd: 'd:/other/a', repo: 'a' }, current), 0.85)
  // 条目无作用域（历史遗留）→ 0.5
  assert.equal(scopeAffinity(null, current), 0.5)
  assert.equal(scopeAffinity({}, current), 0.5)
  // 不同 repo → 0.25
  assert.equal(scopeAffinity({ cwd: 'd:/dev/b', repo: 'b' }, current), 0.25)
  // 无当前作用域 → 1（退化为旧行为，不惩罚）
  assert.equal(scopeAffinity({ repo: 'b' }, null), 1)
  assert.equal(scopeAffinity({ repo: 'b' }, { cwd: '', repo: '' }), 1)
})

test('scope: shouldExcludeInStrictMode 只排除明确跨项目', () => {
  const current = { cwd: 'd:/dev/a', repo: 'a' }
  assert.equal(shouldExcludeInStrictMode({ repo: 'b' }, current), true)
  assert.equal(shouldExcludeInStrictMode({ repo: 'a' }, current), false)
  // 无作用域的历史条目保留，否则老记忆全部失效
  assert.equal(shouldExcludeInStrictMode(null, current), false)
  assert.equal(shouldExcludeInStrictMode({}, current), false)
})

test('scope: applyScopeWeight 让同项目条目升到前面', () => {
  // 两条 BM25 完全同分的记忆：一条本仓库、一条别的仓库。
  const ranked = [
    { id: 'mem-000001', entry: { text: 'x', scope: { cwd: 'd:/other', repo: 'other' } }, score: 1, relevance: 1, recency: 1 },
    { id: 'mem-000002', entry: { text: 'x', scope: { cwd: 'd:/dev/a', repo: 'a' } }, score: 1, relevance: 1, recency: 1 },
  ]
  const current = { cwd: 'd:/dev/a', repo: 'a' }
  const weighted = applyScopeWeight(ranked, current, 0.35)
  assert.equal(weighted[0].id, 'mem-000002')
  assert.equal(weighted[0].affinity, 1)
  assert.equal(weighted[1].id, 'mem-000001')
  assert.equal(weighted[1].affinity, 0.25)
  // weight=0 时保持原顺序
  assert.deepEqual(applyScopeWeight(ranked, current, 0).map((r) => r.id), ['mem-000001', 'mem-000002'])
  // 无 currentScope 时原样返回
  assert.deepEqual(applyScopeWeight(ranked, null, 0.9), ranked)
  // weight 越界收敛到 [0,1]
  assert.ok(applyScopeWeight(ranked, current, 5).every((r) => Number.isFinite(r.score)))
})

