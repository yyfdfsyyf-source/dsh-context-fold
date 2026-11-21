/**
 * engine/core.js —— 自包含压缩引擎的基础工具。
 *
 * 为什么这里没有 `import ... from '@deepseek-ai/...'`：
 * 插件通过符号链接装进 profile，Node 按 realpath 解析，裸导入 DSH 包会
 * ERR_MODULE_NOT_FOUND。因此本目录只使用 `node:*` 内建模块与相对导入，
 * 运行时依赖全部通过 ctx.get() / 传入的 session、agent 获取。
 *
 * 本文件尽量逐字移植官方 @deepseek-ai/dsh-compaction 与
 * @deepseek-ai/dsh-compaction-basic 对应模块（0.2.2-rc.3），只有 LLM 流装配
 * 与错误链做了自包含降级（见函数注释）。
 *
 * @module engine/core
 */

import { randomUUID } from 'node:crypto'

/**
 * 生成一个新的不透明标识（官方 CompactionId 就是字符串 brand，直接返回 UUID）。
 *
 * @returns {string}
 */
export function randomId() {
  return randomUUID()
}

/** checkpoint 消息 source 的不可变标记。 */
export const COMPACT_CHECKPOINT_MARKER = Object.freeze({ kind: 'compact-checkpoint' })

/**
 * 构造 checkpoint 消息的 source（来源于 dsh-compaction/src/checkpoint.ts）。
 *
 * @param {string} id compactionId
 * @param {string} [sourceCommandId] 触发压缩的手动命令 id
 * @returns {Readonly<{kind: string, compactionId: string, sourceCommandId?: string}>}
 */
export function compactCheckpointSource(id, sourceCommandId) {
  return Object.freeze({
    kind: 'compact-checkpoint',
    compactionId: id,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
  })
}

/**
 * 判断一个消息 source 是否为本引擎写入的 checkpoint。
 *
 * @param {unknown} source
 * @returns {boolean}
 */
export function isCompactCheckpointSource(source) {
  return source?.kind === 'compact-checkpoint'
}

/**
 * 手动压缩失败的领域错误（移植自 dsh-compaction/src/index.ts）。
 * code 取值为 busy | cancelled | changed | summary | commit | persistence。
 */
export class ManualCompactionError extends Error {
  /**
   * @param {'busy'|'cancelled'|'changed'|'summary'|'commit'|'persistence'} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'ManualCompactionError'
    this.code = code
  }
}

/**
 * 沿 `.cause` 链把所有错误信息拼起来（region.ts 的 errorChain）。
 *
 * @param {unknown} error
 * @returns {string}
 */
export function errorChain(error) {
  const parts = []
  let current = error
  while (current != null) {
    if (current instanceof Error || typeof current === 'string') {
      parts.push(current.message ?? String(current))
    } else {
      parts.push(String(current))
    }
    current = current.cause
  }
  return parts.join(': ')
}

/**
 * 构造 checkpoint user 消息，形状对齐 dsh-llm 的 createUserMessage：
 * { role: 'user', source, content, id }（role/source/content/id 四个字段）。
 *
 * @param {{content: unknown[], source: unknown, id?: string}} params
 */
export function createUserMessage({ content, source, id }) {
  return { role: 'user', content, source, id: id ?? randomId() }
}

/**
 * 递归冻结对象（可选工具，测试与防御性代码可用）。
 *
 * @template T
 * @param {T} value
 * @param {WeakSet<object>} [seen]
 * @returns {T}
 */
export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
  if (seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const child = value[key]
    if (child !== null && (typeof child === 'object' || typeof child === 'function')) deepFreeze(child, seen)
  }
  return Object.freeze(value)
}

/* ── 摘要提示词（逐字移植自 dsh-compaction-basic/src/summarizer.ts） ── */

export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

export const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * 把摘要 ContentBlock[] 包成 checkpoint user 消息内容：
 * preamble + open tag + 摘要块 + close tag。
 *
 * @param {Array<{type: string, text?: string}>} summary
 * @returns {Array<{type: string, text: string}>}
 */
export function frameSummary(summary) {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/**
 * 只保留 text block；遇到图片 block 直接拒绝（checkpoint 不支持图片）。
 *
 * @param {Array<{type: string, text?: string}>} blocks
 * @returns {Array<{type: string, text: string}>}
 */
export function summaryText(blocks) {
  if (blocks.some((block) => block.type === 'image')) {
    throw new Error('compaction summary cannot contain image output')
  }
  return blocks.filter((block) => block.type === 'text')
}

/** 流装配器可能的 finish reason 判定。 */
function finishFailure(finish) {
  if (finish === undefined) return undefined
  const kind = typeof finish === 'string' ? finish : finish.kind
  if (kind === 'error' || kind === 'aborted') {
    const message = typeof finish === 'string' ? finish : (finish.message ?? finish.reason ?? 'llm stream failed')
    return new Error(message)
  }
  if (kind === 'max-tokens') {
    const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
    error.code = 'MAX_TOKENS'
    return error
  }
  return undefined
}

/**
 * 自包含的最小 BlockAssembler：把 text-delta / 完整 text block 依 index 顺序
 * 装配成 ContentBlock[]，记录 usage 与 finish reason。真实 dsh-llm 的
 * BlockAssembler 还处理 reasoning / tool-call / replay；摘要按契约只产出文本，
 * 这里只实现文本路径（deviation，见报告）。
 */
class TextBlockAssembler {
  constructor() {
    this.partials = new Map()
    this.order = []
    this.usage = undefined
    this.finish = { kind: 'stop' }
  }

  ensure(index, blockType) {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  push(chunk) {
    if (chunk === null || typeof chunk !== 'object') return
    switch (chunk.type) {
      case 'block-start':
        this.ensure(chunk.index, chunk.blockType ?? 'text')
        return
      case 'text-delta': {
        const partial = this.ensure(chunk.index, 'text')
        partial.text += chunk.text ?? ''
        return
      }
      case 'block-end':
        this.ensure(chunk.index, chunk.block?.type ?? 'text')
        return
      case 'usage':
        this.usage = chunk.usage
        return
      case 'finish':
        this.finish = chunk.reason ?? { kind: 'stop' }
        return
      default:
        return
    }
  }

  blocks() {
    return this.order.map((index) => {
      const partial = this.partials.get(index)
      if (partial.block) return partial.block
      return { type: 'text', text: partial.text }
    })
  }
}

/**
 * 用 LLM 生成压缩摘要（移植 summarizeWithLlm）。
 *
 * target 解析优先级：配置的 summarizationProvider/Model → session 最近一次
 * requestHeader().config → agent.options.provider/model。
 *
 * @returns {Promise<{summary: Array, rawOutput: Array, llmStreamCall: boolean, provider: string, model: string, maxTokens: number, usage?: object}>}
 */
export async function summarizeWithLlm(ctx, config, input, agent, signal) {
  const configured = config.summarizationProvider && config.summarizationModel
    ? { provider: config.summarizationProvider, model: config.summarizationModel }
    : undefined
  const headerTarget = agent.session?.requestHeader?.()?.config
  const latest = headerTarget?.provider && headerTarget?.model
    ? { provider: headerTarget.provider, model: headerTarget.model }
    : undefined
  const agentOptions = agent.options ?? {}
  const agentTarget = agentOptions.provider && agentOptions.model
    ? { provider: agentOptions.provider, model: agentOptions.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error('no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields')
  }

  const messages = [
    ...input.messages,
    { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
  ]
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    toolHistory: agent.session?.toolHistory?.() ?? [],
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    maxTokens: config.maxTokens,
    sessionId: agent.session?.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  }

  const llm = ctx?.llm
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new Error('llm service is not available for summarization')
  }

  const assembler = new TextBlockAssembler()
  for await (const chunk of llm.stream(options)) assembler.push(chunk)

  const failure = finishFailure(assembler.finish)
  if (failure !== undefined) throw failure

  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (summary.length === 0) throw new Error('summarization produced no text summary content')

  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}
