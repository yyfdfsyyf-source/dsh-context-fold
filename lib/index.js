/**
 * dsh-context-fold —— 上下文折叠插件。
 *
 * 三块能力：
 *  A. 确定性工具结果折叠（`tools/post-execute`）：超长结果原文落盘，上下文只留
 *     head + tail + 一行回捞标记。**只改写内容，不动事件**，tool-call/tool-result
 *     配对永远完整。
 *  B. 折叠账本 + 回捞（`session/event`）：把每次 `compaction/summary` 的被遮蔽
 *     区间记到 ledger.jsonl，`context_fold recall` 仍能把摘要片段找回来。
 *     与 billion-context（ACP）互补：ACP 负责省 context，本账本负责可检索。
 *  C. 跨会话记忆（`agent/turn-stopping` 写入 + `system-prompt/assemble` 注入）。
 *
 * ── 为什么这里没有 `export const Config` ──────────────────────────────
 * 插件通过符号链接装进 profile 的 node_modules，Node 按 realpath 解析，真实路径
 * 在 workspace 下，裸导入 `@deepseek-ai/schemastery` 会 ERR_MODULE_NOT_FOUND 并
 * 让整个插件加载失败。所以配置在 `lib/config.js` 里**手工校验**并补默认值；
 * schemastery 只作为可选路径尝试加载（`loadSchema()`），加载不到就纯手工。
 * 因此本文件不导出 Config —— 那样会重新引入对 schemastery 的硬依赖。
 *
 * 所有注册都通过 `ctx.effect(() => cleanup)` 或 `ctx.on(...)`；
 * 任何 LLM / IO 失败都只降级，**永不抛错阻塞 turn**。
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { normalizeConfig } from './config.js'
import { createLedger, recordFromSessionEvent } from './ledger.js'
import { createMemoryStore, buildExtractionSystemPrompt, buildExtractionUserPrompt, parseExtraction, collectTurnTranscript, INJECTION_NAME, MAX_PER_TURN } from './memory.js'
import { foldContentBlocks, scanSessionForFoldables } from './prune.js'
import { saveSpill, readSpill, spillDir } from './spill.js'
import { estimateTokens, byteLength, slugId } from './core/tokens.js'

/** 插件名（Cordis 用它做 id 关联）。 */
export const name = 'context-fold'

/**
 * `tools` 是核心服务，必须就绪才能注册工具。
 * 其它服务（llm / sessions / systemPrompt）都是**可选**的，用 `ctx.get()` 探测，
 * 缺失时对应能力静默禁用而不是加载失败。
 */
export const inject = ['tools']

/** 工具名。 */
const TOOL_NAME = 'context_fold'

/**
 * 插件入口。
 *
 * @param {object} ctx Cordis 上下文
 * @param {object} [config] 来自 cordis.patch.yml 的原始配置（可能不完整）
 */
export function apply(ctx, config) {
  const { config: cfg, warnings } = normalizeConfig(config)
  const logger = createLogger(ctx?.logger)

  for (const warning of warnings) logger.warn(`[context-fold] ${warning}`)

  const dshHome = resolveDshHome()
  const root = path.join(dshHome, 'context-fold')
  const files = {
    ledger: path.join(root, 'ledger.jsonl'),
    memory: path.join(root, 'memory.jsonl'),
    spill: spillDir(root),
  }

  const enabled = cfg.mode !== 'off'
  const stats = {
    folded: 0,
    savedTokens: 0,
    spilledBytes: 0,
    prunedSessions: 0,
    memoryWrites: 0,
    llmCalls: 0,
    llmFailures: 0,
    extractSkipped: 0,
  }

  const ledger = createLedger({
    file: files.ledger,
    maxBlocks: cfg.ledger.maxBlocks,
    logger,
  })

  // 作用域的**初始**值来自 process.cwd()，但它在 DSH 桌面宿主里是 profile
  // 目录（实测 C:\Users\YYF\.dsh\profiles\desktop），不是用户工作区。
  // 真正的项目目录在 session.header.cwd；一旦识别到会话就会覆盖它。
  let currentScope = detectScope(process.cwd())

  const memory = createMemoryStore({
    file: files.memory,
    config: cfg.memory,
    logger,
    scope: currentScope,
  })

  /** ctx.effect 不可用时的兜底清理函数列表（先声明，避免 TDZ）。 */
  const disposers = []

  /** sessionId -> 最近一次看到的 Session 实例（供 prune 动作在没有 agent 时兜底）。 */
  const sessionRefs = new Map()
  /** sessionId -> 最近已抽取的 turn（保证每轮最多一次 llm.stream）。 */
  const extractedTurns = new Map()
  /** 正在后台抽取的 sessionId 集合（单飞去重，避免慢模型时任务堆积）。 */
  const inflightExtractions = new Set()
  /** 后台抽取用的 AbortController（dispose 时统一取消，不阻塞进程退出）。 */
  const backgroundAborts = new Set()

  const services = {
    get tools() { return safeGet(ctx, 'tools') ?? ctx?.tools },
    get llm() { return safeGet(ctx, 'llm') },
    get sessions() { return safeGet(ctx, 'sessions') },
    get systemPrompt() { return safeGet(ctx, 'systemPrompt') },
  }

  registerTool()

  // 卸载时取消仍在跑的后台记忆抽取，避免插件已 dispose 还留着模型流。
  registerDispose(() => {
    for (const controller of backgroundAborts) {
      try {
        controller.abort()
      } catch {
        // 忽略。
      }
    }
    backgroundAborts.clear()
    inflightExtractions.clear()
  })

  if (enabled) {
    if (cfg.pruner.enabled) registerPruner()
    if (cfg.ledger.enabled) registerLedger()
    if (cfg.memory.enabled) registerMemory()
  }

  logger.debug?.(`[context-fold] 已装配（mode=${cfg.mode}），数据目录 ${root}`)

  // ───────────────────────────── 能力 A：折叠 ─────────────────────────────

  function registerPruner() {
    const listener = async (exec, result, next) => {
      const decision = await next()
      if (!decision || decision.kind !== 'accept') return decision
      // 错误结果不折叠：错误信息通常很短且是关键线索。
      if (result?.isError === true) return decision
      if (!Array.isArray(decision.content)) return decision

      try {
        const { content, folds, savedTokens: saved } = await foldContentBlocks(decision.content, {
          callId: exec?.callId,
          dir: files.spill,
          pruner: cfg.pruner,
          onFold: (info) => {
            stats.folded += 1
            stats.savedTokens += info.savedTokens
            stats.spilledBytes += info.bytes
          },
        })
        if (folds.length === 0) return decision
        // 只替换 content，不带 additionalContexts（避免污染上下文）。
        return { ...decision, content }
      } catch (error) {
        logger.warn(`[context-fold] 折叠失败，保留原始结果：${describe(error)}`)
        return decision
      }
    }

    addListener('tools/post-execute', listener)
  }

  // ───────────────────────── 能力 B：账本 + 回捞 ─────────────────────────

  function registerLedger() {
    const listener = (session, event) => {
      try {
        if (session?.id) rememberSession(session)
        const record = recordFromSessionEvent(session, event)
        if (!record) return
        // 事件监听器必须同步返回，落盘 fire-and-forget，失败只记日志。
        void ledger.append(record).catch(() => {})
      } catch (error) {
        logger.warn(`[context-fold] 账本记录失败：${describe(error)}`)
      }
    }

    addListener('session/event', listener)
  }

  // ─────────────────────── 能力 C：记忆写入 + 注入 ───────────────────────

  function registerMemory() {
    const mode = cfg.memory.extractMode

    if (mode !== 'off') {
      addListener('agent/turn-stopping', (payload) => {
        const run = (signal) => extractMemories(payload, signal).catch((error) => {
          // 记忆抽取永远不能阻塞 turn 结束，也永远不能把错误抛给宿主。
          logger.warn(`[context-fold] 记忆抽取失败（已忽略）：${describe(error)}`)
        })

        if (mode === 'blocking') return run(payload?.signal)

        // ── background（默认）──────────────────────────────────────────
        // 为什么必须不 await：`agent/turn-stopping` 是串行事件，宿主会等它
        // resolve 才结束本轮。在这里等一次完整的模型往返，等于每一轮都多付
        // 一次 LLM 延迟——这正是"下载量最高的压缩插件极大加长任务时间"的
        // 同类问题。这里改为 fire-and-forget，并对同一 session 做单飞去重。
        //
        // 同时**不能**沿用 payload.signal：turn 一结束宿主就会 abort 它，
        // 后台抽取会被立刻取消。改用插件自己的 controller，dispose 时统一 abort。
        const sessionId = payload?.agent?.id
        if (typeof sessionId === 'string' && inflightExtractions.has(sessionId)) {
          stats.extractSkipped += 1
          return
        }
        const controller = new AbortController()
        backgroundAborts.add(controller)
        if (typeof sessionId === 'string') inflightExtractions.add(sessionId)

        // 注意：extractMemories 的函数体在第一个 await 之前会同步执行到
        // `collectTurnTranscript`，所以这里不会读到"下一轮"的会话内容。
        void run(controller.signal)
          .finally(() => {
            backgroundAborts.delete(controller)
            if (typeof sessionId === 'string') inflightExtractions.delete(sessionId)
          })
      })
    }

    addListener('system-prompt/assemble', async (assembly, _context, next) => {
      const result = await next()
      if (!result || typeof result !== 'object') return result
      try {
        const text = await memory.injectionText({})
        if (typeof text !== 'string' || text.length === 0) return result
        const contexts = Array.isArray(result.contexts) ? result.contexts : []
        return {
          ...result,
          contexts: [...contexts, { name: INJECTION_NAME, text }],
        }
      } catch (error) {
        logger.warn(`[context-fold] 记忆注入失败（已忽略）：${describe(error)}`)
        return result
      }
    })
  }

  async function extractMemories(payload, overrideSignal) {
    const llm = services.llm
    if (!llm || typeof llm.stream !== 'function') return

    const agent = payload?.agent
    const session = resolveSession(agent?.id)
    if (!session) return

    const turn = Number.isFinite(payload?.turn) ? payload.turn : -1
    const key = `${session.id}#${turn}`
    if (extractedTurns.get(session.id) === turn) return
    extractedTurns.set(session.id, turn)

    const target = resolveModelTarget(session)
    if (!target) {
      logger.debug?.('[context-fold] 拿不到 provider/model，跳过本轮记忆抽取')
      return
    }

    const transcript = collectTurnTranscript(session, { maxEvents: 24 })
    if (transcript.length === 0) return
    // 短回合没有值得长期记住的东西：省掉一次模型往返（延迟与成本都要省）。
    const minChars = Number.isFinite(cfg.memory.minTranscriptChars) ? cfg.memory.minTranscriptChars : 0
    if (minChars > 0 && transcript.length < minChars) {
      stats.extractSkipped += 1
      return
    }

    const signal = overrideSignal ?? payload?.signal
    if (signal?.aborted === true) return

    stats.llmCalls += 1
    let text = ''
    try {
      const stream = llm.stream({
        provider: target.provider,
        model: target.model,
        system: buildExtractionSystemPrompt(),
        messages: [{ role: 'user', content: [{ type: 'text', text: buildExtractionUserPrompt(transcript) }] }],
        maxTokens: 800,
        temperature: 0,
        signal,
        sessionId: session.id,
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (signal?.aborted === true) return
      }
    } catch (error) {
      stats.llmFailures += 1
      logger.debug?.(`[context-fold] llm.stream 失败：${describe(error)}`)
      return
    }

    const candidates = parseExtraction(text, { maxItems: MAX_PER_TURN })
    if (candidates.length < 2) return

    const written = await memory.appendMany(candidates, { scope: scopeOfSession(session) })
    if (written > 0) {
      stats.memoryWrites += written
      logger.debug?.(`[context-fold] 写入 ${written} 条记忆（turn ${turn}）`)
    }
    // 注意：这里**不**主动刷新注入缓存。缓存只在「新增 ≥2 条」或「显式 recall」
    // 之后刷新，以保证 system prompt 前缀稳定可缓存（见 lib/memory.js 文件头）。
  }

  function resolveModelTarget(session) {
    try {
      const context = session?.requestContext?.()
      if (context && typeof context.provider === 'string' && typeof context.model === 'string') {
        return { provider: context.provider, model: context.model }
      }
    } catch {
      // 继续尝试后备路径。
    }
    const llm = services.llm
    const fallback = llm?.defaultModel ?? llm?.model
    if (fallback && typeof fallback.provider === 'string' && typeof fallback.model === 'string') {
      return { provider: fallback.provider, model: fallback.model }
    }
    return undefined
  }

  /**
   * 取某个会话的作用域。
   *
   * **必须用 `session.header.cwd`，不能用 `process.cwd()`**：DSH 桌面宿主的
   * 进程 cwd 是 profile 目录，所有项目会塌缩成同一个作用域（实测缺陷：
   * 记忆全部写成 `cwd=C:\Users\YYF\.dsh\profiles\desktop, repo=desktop`）。
   * `SessionHeader.cwd` 是会话创建时校验过的绝对路径，才是真正的项目目录。
   *
   * @param {object} [session]
   * @returns {{ cwd: string, repo: string, branch: string } | null}
   */
  function scopeOfSession(session) {
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd.trim().length > 0) {
      try {
        return detectScope(cwd)
      } catch {
        // 落到当前作用域。
      }
    }
    return currentScope
  }

  /**
   * 记住一个会话的作用域，并在变化时刷新记忆注入缓存。
   * @param {object} [session]
   */
  function noteScope(session) {
    const next = scopeOfSession(session)
    if (!next) return
    if (next.cwd === currentScope?.cwd) return
    currentScope = next
    try {
      memory.setScope(next)
    } catch {
      // 作用域更新失败不应影响主流程。
    }
  }

  function rememberSession(session) {
    if (!session?.id) return
    noteScope(session)
    sessionRefs.set(session.id, session)
    // 防止长期运行下 Map 无界增长。
    if (sessionRefs.size > 64) {
      const oldest = sessionRefs.keys().next().value
      if (oldest !== undefined) sessionRefs.delete(oldest)
    }
  }

  function resolveSession(sessionId) {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const cached = sessionRefs.get(sessionId)
      if (cached) {
        noteScope(cached)
        return cached
      }
      try {
        const got = services.sessions?.get?.(sessionId)
        if (got) {
          noteScope(got)
          return got
        }
      } catch {
        // 忽略。
      }
    }
    // 兜底：最近一个见过的会话。
    const keys = [...sessionRefs.keys()]
    const fallback = keys.length > 0 ? sessionRefs.get(keys[keys.length - 1]) : undefined
    if (fallback) noteScope(fallback)
    return fallback
  }

  // ───────────────────────────── 工具面 ─────────────────────────────

  function registerTool() {
    const tools = services.tools
    if (!tools || typeof tools.register !== 'function') {
      logger.debug?.('[context-fold] tools 服务不可用，context_fold 工具未注册')
      return
    }

    const definition = {
      name: TOOL_NAME,
      description: [
        '查看并操作 context-fold 的上下文折叠状态。',
        '',
        '何时使用：',
        '1. 你在上下文里看到 `[context-fold: 已折叠 <id>，原文 <bytes> 字节，用 context_fold recall <id> 取回]` 这样的标记，',
        '   说明那段工具输出被折叠了 —— 用 `action: "recall"` 加 `query: "<id>"` 取回完整原文。',
        '2. 你觉得某段更早的内容（被压缩/折叠掉的）可能还有用，但记不清细节 —— 用 `action: "recall"` 加关键词，',
        '   会同时搜索折叠账本（compaction 摘要）和跨会话记忆，返回命中的摘要片段与精确 seq 范围。',
        '3. 想确认本插件是否正常工作、省了多少 context —— 用 `action: "status"`。',
        '4. 想对当前会话手动跑一次折叠扫描（把超长工具结果落盘以便回捞）—— 用 `action: "prune"`。',
        '5. 想查看最近被折叠的块 —— 用 `action: "ledger"`。',
        '',
        '注意：`recall` 返回的是**摘要/片段**，不是原始 token 流；原文完整内容需要按返回的 seq 范围回看会话。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'recall', 'prune', 'ledger'],
            description: 'status=状态与计数；recall=按 id 或关键词回捞；prune=手动折叠扫描；ledger=最近账本条目。',
          },
          query: {
            type: 'string',
            description: 'recall 用：折叠块 id（如 abc-0）或关键词。省略则返回空。',
          },
          limit: {
            type: 'integer',
            description: 'recall / ledger 返回条数上限，默认 5（ledger 默认 20）。',
            minimum: 1,
            maximum: 50,
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
        ],
      },
      async execute(args, exec) {
        return runTool(args, exec)
      },
    }

    try {
      const dispose = tools.register(definition)
      if (typeof dispose === 'function') {
        registerDispose(dispose)
      }
    } catch (error) {
      logger.warn(`[context-fold] 注册 ${TOOL_NAME} 失败：${describe(error)}`)
    }
  }

  async function runTool(args, exec) {
    const action = typeof args?.action === 'string' ? args.action : 'status'
    const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 0

    switch (action) {
      case 'status':
        return statusReport()

      case 'recall': {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query.length === 0) {
          return { ok: false, action, error: 'recall 需要 query（折叠块 id 或关键词）' }
        }
        const topK = limit > 0 ? limit : 5
        const [ledgerResult, memoryHits, spill] = await Promise.all([
          cfg.ledger.enabled ? ledger.recall(query, topK) : Promise.resolve({ mode: 'none', hits: [] }),
          cfg.memory.enabled ? memory.recall(query, topK) : Promise.resolve([]),
          readSpill(files.spill, query),
        ])
        return {
          ok: true,
          action,
          query,
          spill: spill === undefined
            ? { found: false }
            : { found: true, bytes: byteLength(spill), text: spill },
          ledger: ledgerResult,
          memory: memoryHits,
          hint: ledgerResult.mode === 'none' && memoryHits.length === 0 && spill === undefined
            ? '没有命中。可以换更短的关键词，或确认内容是否真的被折叠过。'
            : undefined,
        }
      }

      case 'prune': {
        const session = resolveSession(exec?.agent?.id)
        if (!session) {
          return { ok: false, action, error: '找不到当前会话，无法扫描' }
        }
        const foldables = scanSessionForFoldables(session, cfg.pruner)
        let spilled = 0
        let bytes = 0
        for (const item of foldables) {
          const id = `${slugId(item.callId)}-${item.index}`
          try {
            const saved = await saveSpill(files.spill, id, item.text)
            spilled += 1
            bytes += saved.bytes
          } catch (error) {
            logger.warn(`[context-fold] prune 落盘失败 ${id}：${describe(error)}`)
          }
        }
        stats.prunedSessions += 1
        return {
          ok: true,
          action,
          sessionId: session.id,
          scannedEvents: Number(session.seq) || 0,
          foldable: foldables.length,
          spilled,
          bytes,
          note: foldables.length === 0
            ? '当前会话没有超过 maxChars 的工具结果，无需折叠。'
            : '历史事件是 append-only 的，无法就地改写；这里已把超长结果落盘，之后可用 recall <id> 取回。',
        }
      }

      case 'ledger': {
        const topN = limit > 0 ? limit : 20
        const entries = cfg.ledger.enabled ? await ledger.recent(topN) : []
        return {
          ok: true,
          action,
          enabled: cfg.ledger.enabled,
          total: cfg.ledger.enabled ? await ledger.count() : 0,
          entries,
        }
      }

      default:
        return { ok: false, error: `未知 action "${action}"，可用：status | recall | prune | ledger` }
    }
  }

  async function statusReport() {
    let ledgerCount = 0
    let memoryCount = 0
    try {
      ledgerCount = cfg.ledger.enabled ? await ledger.count() : 0
    } catch {
      ledgerCount = 0
    }
    try {
      memoryCount = cfg.memory.enabled ? await memory.count() : 0
    } catch {
      memoryCount = 0
    }

    return {
      ok: true,
      action: 'status',
      plugin: name,
      mode: cfg.mode,
      root,
      capabilities: {
        pruner: {
          ready: enabled && cfg.pruner.enabled,
          reason: cfg.pruner.enabled ? (enabled ? 'ok' : 'mode=off') : 'config 关闭',
          config: cfg.pruner,
        },
        ledger: {
          ready: enabled && cfg.ledger.enabled,
          reason: cfg.ledger.enabled ? (enabled ? 'ok' : 'mode=off') : 'config 关闭',
          config: cfg.ledger,
        },
        memory: {
          ready: enabled && cfg.memory.enabled && typeof services.llm?.stream === 'function',
          extractReady: typeof services.llm?.stream === 'function',
          injectReady: typeof services.systemPrompt !== 'undefined',
          reason: !cfg.memory.enabled
            ? 'config 关闭'
            : (typeof services.llm?.stream === 'function' ? 'ok' : 'llm 服务不可用，写入已静默禁用'),
          config: cfg.memory,
        },
      },
      counters: {
        folds: stats.folded,
        savedTokensEstimate: stats.savedTokens,
        spilledBytes: stats.spilledBytes,
        ledgerEntries: ledgerCount,
        memoryEntries: memoryCount,
        memoryWrites: stats.memoryWrites,
        llmCalls: stats.llmCalls,
        llmFailures: stats.llmFailures,
        extractSkipped: stats.extractSkipped,
      },
      estimateNote: 'savedTokensEstimate 是按 chars/3.5 的粗估，仅用于量级参考，不是精确计费口径。',
      configWarnings: warnings,
    }
  }

  // ───────────────────────────── 装配工具 ─────────────────────────────

  function addListener(event, handler) {
    if (typeof ctx?.on !== 'function') return
    try {
      ctx.on(event, handler)
    } catch (error) {
      logger.warn(`[context-fold] 注册 ${event} 监听失败：${describe(error)}`)
    }
  }

  function registerDispose(dispose) {
    if (typeof ctx?.effect === 'function') {
      try {
        ctx.effect(() => dispose, `context-fold:${TOOL_NAME}`)
        return
      } catch {
        // 落到直接托管。
      }
    }
    disposers.push(dispose)
  }
}

/** 把清理函数交给 ctx.effect，缺失时静默跳过。 */
function createLogger(raw) {
  const pick = (level) => (typeof raw?.[level] === 'function' ? raw[level].bind(raw) : () => {})
  return {
    debug: pick('debug'),
    info: pick('info'),
    warn: pick('warn'),
    error: pick('error'),
  }
}

function safeGet(ctx, key) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/**
 * 探测当前工作目录的归属（用于记忆作用域）。
 *
 * **`repo` 取 `basename(cwd)`，不取 git 仓库根**——这是刻意的选择。
 * 实测踩过：本工作区 `D:\dev\dsh配置` 里没有 `.git`，向上找到的是
 * `D:\dev\.git`，而那个仓库覆盖了整个 `dev` 目录（里面是多个互不相干的项目）。
 * 若把 `repo` 定成 git 根目录名，这些项目会被误判成"同一个仓库"，
 * 作用域就失效了。`basename(cwd)` 虽然会在深层子目录会话上分得偏细，
 * 但配合默认的 `scopeMode: prefer`（跨作用域只降权、不排除）代价可接受。
 *
 * 仍然向上找 `.git`，但**只用来读分支名**（`ref: refs/heads/<branch>`），
 * 分支不参与亲和度计算，纯作排障信息。
 *
 * **永不抛错**：任何读取失败都退化为"只有 cwd"，最差情况就是旧的全局行为。
 *
 * @param {string} cwd
 * @returns {{ cwd: string, repo: string, branch: string }}
 */
export function detectScope(cwd) {
  const base = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : process.cwd()
  const result = { cwd: base, repo: path.basename(base), branch: '' }

  try {
    let dir = path.resolve(base)
    for (let depth = 0; depth < 24; depth += 1) {
      const gitPath = path.join(dir, '.git')
      let stat = null
      try {
        stat = fs.statSync(gitPath)
      } catch {
        stat = null
      }
      if (stat) {
        try {
          const head = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf8').trim()
          const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
          if (match) result.branch = match[1].trim()
        } catch {
          // .git 是文件（worktree）或 HEAD 不可读：分支留空，不影响其它字段。
        }
        break
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // 完全忽略：返回只有 cwd/basename 的退化结果。
  }

  return result
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 导出内部工具函数，便于测试与排障（不影响 Cordis 装配）。 */
export { estimateTokens }
