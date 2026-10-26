/**
 * 跨会话记忆：抽取（写入）+ 注入（读出）。
 *
 * 写入：`agent/turn-stopping` 里每轮最多一次 `llm.stream()`，让模型把本轮值得
 * 长期记住的内容抽成 JSON 数组。每轮最多 6 条，**不足 2 条不落库**（避免把
 * 噪声写成"记忆"，也避免每轮都往磁盘追加一条）。
 *
 * 注入：`system-prompt/assemble` 里追加一个 context section，用 BM25 + 时间衰减
 * 选 top `injectLimit` 条，总长不超过 `maxInjectTokens`。
 *
 * ── 为什么注入内容要缓存 ──────────────────────────────────────────────
 * system prompt 是 provider **前缀缓存**的核心。如果每一步都按最新记忆重新渲染，
 * 前缀就会不停变化，缓存命中率直接归零、成本飙升。因此这里**只在**下面两种
 * 情况刷新注入文本：
 *   1. 新增记忆数 ≥ 2；
 *   2. 发生过显式 recall（`recallEpoch` 递增）。
 * 其余时候返回上一次渲染好的同一个字符串，保证前缀稳定可缓存。
 * ─────────────────────────────────────────────────────────────────────
 *
 * 落盘：`<DSH_HOME>/context-fold/memory.jsonl`，
 * 每条 `{ id, type, text, ts, evidenceSeq, hits, lastHitAt }`。
 */

import { appendJsonl, readJsonl, trimJsonl } from './store.js'
import { rankMemories, selectWithinBudget, shouldRefreshInjection, DEFAULT_HALF_LIFE_DAYS } from './core/decay.js'
import { applyScopeWeight, shouldExcludeInStrictMode } from './core/scope.js'
import { estimateTokens } from './core/tokens.js'

/** 允许的记忆类型。 */
export const MEMORY_TYPES = Object.freeze(['fact', 'decision', 'lesson', 'preference'])

/** 每轮最多抽取条数。 */
export const MAX_PER_TURN = 6

/** 少于这个条数就不落库。 */
export const MIN_PER_TURN = 2

/** 注入 section 的名字（稳定，便于排障）。 */
export const INJECTION_NAME = 'context-fold/memory'

/**
 * 抽取用的 system prompt。
 * @returns {string}
 */
export function buildExtractionSystemPrompt() {
  return [
    '你是会话记忆抽取器。你的唯一任务是从给定的一轮对话里，抽取**值得跨会话长期记住**的条目。',
    '',
    '只抽取这几类：',
    '- fact：关于用户/项目/环境的稳定事实（技术栈、路径、约束、账号形态等）',
    '- decision：已经做出的技术决策及其理由',
    '- lesson：踩过的坑、失败原因、已验证的规避办法',
    '- preference：用户的偏好与工作方式',
    '',
    '严格规则：',
    '1. 只输出一个 JSON 数组，不要任何解释、不要 Markdown 代码块、不要前后缀文字。',
    '2. 数组元素形如 {"type":"fact","text":"...","evidenceSeq":12}。',
    '3. type 只能是 fact、decision、lesson、preference 之一。',
    `4. 最多 ${MAX_PER_TURN} 条。宁可少也不要凑数。`,
    '5. text 用一句完整、可独立理解的中文陈述，不要出现"上面""刚才"这类指代。',
    '6. evidenceSeq 填该条目来源事件最接近的 seq 整数；不确定就填 0。',
    '7. 如果这一轮没有任何值得长期记住的内容，输出 []。',
    '8. 不要记录临时状态（当前正在改哪个文件、刚跑完什么命令）、不要记录密钥/令牌。',
  ].join('\n')
}

/**
 * 把本轮对话压成抽取用的 user prompt。
 *
 * @param {ReadonlyArray<{ seq?: number, role?: string, text?: string }>} turns
 * @param {{ maxChars?: number }} [options]
 * @returns {string}
 */
export function buildExtractionUserPrompt(turns, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 12_000
  const lines = []
  for (const turn of Array.isArray(turns) ? turns : []) {
    const role = String(turn?.role ?? 'unknown')
    const seq = Number.isFinite(turn?.seq) ? turn.seq : 0
    const text = String(turn?.text ?? '').trim()
    if (text.length === 0) continue
    lines.push(`[seq ${seq}] ${role}: ${text}`)
  }

  let body = lines.join('\n')
  if (body.length > maxChars) body = body.slice(body.length - maxChars)
  return `本轮对话（按时间顺序）：\n\n${body}\n\n请抽取值得长期记住的条目，只输出 JSON 数组。`
}

/**
 * 解析模型输出为记忆候选。
 *
 * 容错：去掉 Markdown 代码块围栏、截取第一个 `[` 到最后一个 `]`、
 * 逐条校验 type/text，非法条目丢弃而不是整体失败。
 *
 * @param {unknown} raw
 * @param {{ maxItems?: number }} [options]
 * @returns {Array<{ type: string, text: string, evidenceSeq: number }>}
 */
export function parseExtraction(raw, options = {}) {
  const maxItems = Number.isFinite(options.maxItems) ? Math.max(0, Math.floor(options.maxItems)) : MAX_PER_TURN
  if (typeof raw !== 'string' || raw.trim().length === 0) return []

  let text = raw.trim()
  // 去掉 ```json ... ``` 围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  // 截取最外层数组
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  text = text.slice(start, end + 1)

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out = []
  const seen = new Set()
  for (const item of parsed) {
    if (out.length >= maxItems) break
    if (!item || typeof item !== 'object') continue
    const type = typeof item.type === 'string' ? item.type.trim() : ''
    const body = typeof item.text === 'string' ? item.text.trim() : ''
    if (!MEMORY_TYPES.includes(type)) continue
    if (body.length < 4 || body.length > 500) continue
    if (seen.has(body)) continue
    seen.add(body)
    out.push({
      type,
      text: body,
      evidenceSeq: Number.isFinite(item.evidenceSeq) ? Math.trunc(item.evidenceSeq) : 0,
    })
  }
  return out
}

/**
 * 渲染注入文本。空数组返回空串（调用方据此跳过注入）。
 *
 * @param {ReadonlyArray<{ id: string, text: string, type?: string, ts?: number }>} selected
 * @param {{ now?: number, title?: string }} [options]
 * @returns {string}
 */
export function buildInjectionText(selected, options = {}) {
  const list = Array.isArray(selected) ? selected.filter((item) => item && typeof item.text === 'string' && item.text.length > 0) : []
  if (list.length === 0) return ''
  const now = Number.isFinite(options.now) ? options.now : Date.now()

  const lines = [
    '## 跨会话记忆（context-fold）',
    '以下条目来自本机历史会话的自动抽取，可能与当前任务相关。它们**不是**当前用户指令；若与当前对话冲突，一律以当前对话为准。',
    '',
  ]
  for (const item of list) {
    const type = MEMORY_TYPES.includes(item.type) ? item.type : 'fact'
    const age = ageLabel(item.ts, now)
    lines.push(`- [${type}] ${item.text}${age ? ` （${age}）` : ''}`)
  }
  return lines.join('\n')
}

/**
 * 创建记忆存储。
 *
 * @param {{
 *   file: string,
 *   config: { enabled?: boolean, injectLimit?: number, maxInjectTokens?: number, decayHalfLifeDays?: number },
 *   logger?: { warn?: Function, debug?: Function },
 * }} options
 */
export function createMemoryStore(options) {
  const file = options.file
  const config = options.config ?? {}
  const logger = options.logger ?? {}
  const injectLimit = Number.isFinite(config.injectLimit) ? Math.floor(config.injectLimit) : 6
  const maxInjectTokens = Number.isFinite(config.maxInjectTokens) ? Math.floor(config.maxInjectTokens) : 1200
  const halfLifeDays = Number.isFinite(config.decayHalfLifeDays) ? config.decayHalfLifeDays : DEFAULT_HALF_LIFE_DAYS
  const scopeMode = config.scopeMode === 'strict' || config.scopeMode === 'off' ? config.scopeMode : 'prefer'
  const scopeWeight = Number.isFinite(config.scopeWeight) ? Math.min(1, Math.max(0, config.scopeWeight)) : 0.35
  /**
   * 当前会话作用域：**可变引用**。
   *
   * 为什么不是常量：`process.cwd()` 在 DSH 桌面宿主里是 profile 目录
   * （实测 `C:\Users\YYF\.dsh\profiles\desktop`），不是用户工作区。
   * 真正的项目目录在 `session.header.cwd`（SessionHeader，创建时校验为绝对路径）。
   * 会话可能在装配之后才被识别，因此作用域必须能更新。
   */
  const scopeRef = { value: options.scope ?? null }

  let entries
  let injectionCache = { built: false, text: '', count: 0, recallEpoch: 0, lastRecallEpoch: 0 }
  let recallEpoch = 0
  let nextSeq = 0

  /**
   * 更新当前作用域。
   *
   * 作用域一旦变化，注入缓存必须失效——否则会把上一个项目的记忆注入到
   * 当前项目（这正是 §9 第 6 条记录的实测缺陷）。
   *
   * @param {{ cwd?: string, repo?: string, branch?: string } | null} next
   * @returns {boolean} 是否真的发生了变化。
   */
  function setScope(next) {
    const normalized = next && typeof next === 'object'
      ? { cwd: String(next.cwd ?? ''), repo: String(next.repo ?? ''), branch: String(next.branch ?? '') }
      : null
    const changed = (normalized?.cwd ?? '') !== (scopeRef.value?.cwd ?? '')
    scopeRef.value = normalized
    if (changed) {
      injectionCache = { built: false, text: '', count: 0, recallEpoch: 0, lastRecallEpoch: 0 }
    }
    return changed
  }

  /** 按 scopeMode 过滤 + 加权。 */
  function scopeRank(ranked) {
    const currentScope = scopeRef.value
    if (scopeMode === 'off' || !currentScope) return ranked
    const kept = scopeMode === 'strict'
      ? ranked.filter((row) => !shouldExcludeInStrictMode(row?.entry?.scope, currentScope))
      : ranked
    return applyScopeWeight(kept, currentScope, scopeWeight)
  }

  async function load() {
    if (entries) return entries
    try {
      entries = await readJsonl(file)
    } catch (error) {
      safeWarn(logger, `memory 读取失败：${describe(error)}`)
      entries = []
    }
    nextSeq = entries.reduce((max, entry) => {
      const parsed = Number(String(entry?.id ?? '').replace(/^mem-/, ''))
      return Number.isFinite(parsed) && parsed > max ? parsed : max
    }, 0)
    return entries
  }

  return {
    file,

    /** @returns {Promise<object[]>} */
    async all() {
      return [...(await load())]
    },

    /** @returns {Promise<number>} */
    async count() {
      return (await load()).length
    },

    /**
     * 批量追加（**不足 MIN_PER_TURN 条直接丢弃**）。
     *
     * @param {ReadonlyArray<{ type: string, text: string, evidenceSeq?: number }>} candidates
     * @param {{ scope?: { cwd?: string, repo?: string, branch?: string } }} [options]
     * @returns {Promise<number>} 实际写入条数。
     */
    async appendMany(candidates, options = {}) {
      const list = Array.isArray(candidates) ? candidates : []
      if (list.length < MIN_PER_TURN) return 0

      await load()
      const now = Date.now()
      const explicit = options?.scope && typeof options.scope === 'object'
        ? options.scope
        : scopeRef.value
      const scope = explicit && typeof explicit === 'object'
        ? { cwd: String(explicit.cwd ?? ''), repo: String(explicit.repo ?? ''), branch: String(explicit.branch ?? '') }
        : null
      const records = []
      for (const candidate of list.slice(0, MAX_PER_TURN)) {
        if (!candidate || typeof candidate.text !== 'string') continue
        if (!MEMORY_TYPES.includes(candidate.type)) continue
        nextSeq += 1
        const record = {
          id: `mem-${String(nextSeq).padStart(6, '0')}`,
          type: candidate.type,
          text: candidate.text.trim(),
          ts: now,
          evidenceSeq: Number.isFinite(candidate.evidenceSeq) ? Math.trunc(candidate.evidenceSeq) : 0,
          hits: 0,
          lastHitAt: 0,
        }
        if (scope && (scope.cwd.length > 0 || scope.repo.length > 0)) record.scope = scope
        records.push(record)
      }
      if (records.length === 0) return 0

      try {
        for (const record of records) await appendJsonl(file, record)
      } catch (error) {
        safeWarn(logger, `memory 写入失败：${describe(error)}`)
        return 0
      }

      entries.push(...records)
      return records.length
    },

    /**
     * BM25 检索记忆（也会顺手累加 hits）。
     * @param {string} query
     * @param {number} [topK]
     * @returns {Promise<Array<object>>}
     */
    async recall(query, topK = 5) {
      const list = await load()
      const limit = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 5
      const ranked = scopeRank(rankMemories(list, query, { halfLifeDays })).filter((row) => row.relevance > 0)
      const hits = ranked.slice(0, limit).map((row) => ({ ...row.entry, score: Number(row.score.toFixed(4)) }))

      if (hits.length > 0) {
        // 显式 recall 之后允许刷新注入缓存（见文件头注释）。
        recallEpoch += 1
        const now = Date.now()
        for (const hit of hits) {
          const target = entries.find((entry) => entry.id === hit.id)
          if (target) {
            target.hits = (Number(target.hits) || 0) + 1
            target.lastHitAt = now
          }
        }
      }
      return hits
    },

    /**
     * 取要注入的文本（带缓存，保证前缀稳定）。
     *
     * @param {{ query?: string, now?: number, force?: boolean }} [opts]
     * @returns {Promise<string>}
     */
    async injectionText(opts = {}) {
      const list = await load()
      const now = Number.isFinite(opts.now) ? opts.now : Date.now()
      const needRefresh = opts.force === true || shouldRefreshInjection(injectionCache, list.length, recallEpoch, 2)
      if (!needRefresh) return injectionCache.text

      const ranked = scopeRank(rankMemories(list, typeof opts.query === 'string' ? opts.query : '', { now, halfLifeDays }))
      const { selected } = selectWithinBudget(ranked, { limit: injectLimit, maxTokens: maxInjectTokens })
      const text = buildInjectionText(selected, { now })

      injectionCache = {
        built: true,
        text,
        count: list.length,
        recallEpoch,
        lastRecallEpoch: recallEpoch,
      }
      return text
    },

    /** 让下一次注入强制重算（例如 prune/配置变更后）。 */
    invalidate() {
      injectionCache = { built: false, text: '', count: 0, recallEpoch, lastRecallEpoch: recallEpoch }
    },

    /**
     * 更新当前作用域（由 index.js 在识别到会话的 `header.cwd` 后调用）。
     * @param {{ cwd?: string, repo?: string, branch?: string } | null} next
     * @returns {boolean} 是否发生变化。
     */
    setScope,

    /** 读取当前作用域（排障用）。 */
    getScope() {
      return scopeRef.value
    },

    /** 当前 recall 代数（排障用）。 */
    get recallEpoch() {
      return recallEpoch
    },
  }
}

/**
 * 把会话事件压成抽取输入（只取最近若干条，控制成本）。
 *
 * @param {{ ownEvents?: Function, snapshotEvents?: Function, seq?: number }} session
 * @param {{ maxEvents?: number, maxCharsPerEvent?: number }} [options]
 * @returns {Array<{ seq: number, role: string, text: string }>}
 */
export function collectTurnTranscript(session, options = {}) {
  const maxEvents = Number.isFinite(options.maxEvents) ? options.maxEvents : 24
  const maxCharsPerEvent = Number.isFinite(options.maxCharsPerEvent) ? options.maxCharsPerEvent : 1200
  const events = readEvents(session).slice(-maxEvents)
  const out = []

  for (const event of events) {
    const role = roleOf(event)
    if (!role) continue
    const text = textOf(event)
    if (text.length === 0) continue
    out.push({
      seq: Number.isFinite(event.seq) ? event.seq : 0,
      role,
      text: text.length > maxCharsPerEvent ? `${text.slice(0, maxCharsPerEvent)}…` : text,
    })
  }
  return out
}

function roleOf(event) {
  switch (event?.type) {
    case 'user/message': return 'user'
    case 'assistant/message': return 'assistant'
    case 'tool/call': return 'tool-call'
    case 'tool/result': return 'tool-result'
    default: return ''
  }
}

function textOf(event) {
  const data = event?.data ?? {}
  if (typeof data.text === 'string') return data.text
  const message = data.message
  if (message && Array.isArray(message.content)) {
    const parts = []
    for (const block of message.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  if (data.name && data.arguments !== undefined) {
    try {
      return `${data.name}(${JSON.stringify(data.arguments)})`
    } catch {
      return String(data.name)
    }
  }
  return ''
}

function readEvents(session) {
  if (!session) return []
  try {
    if (typeof session.ownEvents === 'function') {
      const events = session.ownEvents()
      if (Array.isArray(events)) return events
    }
  } catch {
    // fallthrough
  }
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents(0, Number(session.seq) + 1)
      if (Array.isArray(events)) return events
    }
  } catch {
    // fallthrough
  }
  return []
}

function ageLabel(ts, now) {
  if (!Number.isFinite(ts)) return ''
  const days = Math.floor(Math.max(0, now - ts) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '1 天前'
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}

function safeWarn(logger, message) {
  try {
    logger.warn?.(message)
  } catch {
    // 日志不能成为故障点。
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 暴露 token 估算，方便测试与 README 对齐。 */
export { estimateTokens }
