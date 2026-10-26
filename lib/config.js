/**
 * 配置：默认值 + 手动校验 + **可选的** schemastery 交叉校验。
 *
 * 为什么不用 `export const Config`：
 * 本插件通过符号链接安装进 profile 的 `node_modules`，Node 会按 realpath
 * 解析，真实路径落在 workspace 下，此时裸导入 `@deepseek-ai/schemastery`
 * 会 `ERR_MODULE_NOT_FOUND` 并让整个插件加载失败。所以配置必须能**在没有任何
 * 外部依赖的情况下**完成校验并补默认值。
 *
 * 这里仍然保留一条**可选**的 schemastery 路径（照抄 dsh-hard-gate 的
 * `loadSchema()` 模式）：加载得到就额外做一次交叉校验，加载不到就纯手工校验。
 * 任何情况下都不会让模块加载失败。
 */

import { createRequire } from 'node:module'

/** 全部默认值。`cordis.patch.yml` 里出现的键必须与此保持一致。 */
export const DEFAULT_CONFIG = Object.freeze({
  mode: 'complement',
  pruner: Object.freeze({
    enabled: true,
    maxChars: 8000,
    keepHead: 2000,
    keepTail: 2000,
  }),
  memory: Object.freeze({
    enabled: true,
    injectLimit: 6,
    maxInjectTokens: 1200,
    decayHalfLifeDays: 30,
    scopeMode: 'prefer',
    scopeWeight: 0.35,
    // 记忆抽取在哪个时机跑：background=不阻塞 turn（默认），blocking=阻塞，off=不抽取。
    // 默认 background 是实测教训：billion-context 那类"每轮都等一次模型"的做法会显著拉长任务时间。
    extractMode: 'background',
    // 本轮转录短于该字符数就不抽（闲聊/单次问答没有可记的东西，省一次模型往返）。
    minTranscriptChars: 400,
  }),
  ledger: Object.freeze({
    enabled: true,
    maxBlocks: 2000,
  }),
})

const VALID_MODES = new Set(['complement', 'off'])

let schemaCache
let schemaLoaded = false

/**
 * 可选加载 `@deepseek-ai/schemastery`。失败返回 undefined，永不抛错。
 * @returns {object | undefined}
 */
export function loadSchema() {
  if (schemaLoaded) return schemaCache
  schemaLoaded = true
  try {
    const require = createRequire(import.meta.url)
    schemaCache = require('@deepseek-ai/schemastery')
  } catch {
    schemaCache = undefined
  }
  return schemaCache
}

/**
 * 用 schemastery 构造一份配置 schema；不可用时返回 undefined。
 * 这里对 schemastery 的 API 形状做了防御：拿不到 `object` 就直接放弃。
 * @returns {object | undefined}
 */
export function optionalConfigSchema() {
  const schema = loadSchema()
  if (!schema) return undefined
  try {
    const builder = typeof schema.object === 'function'
      ? schema
      : (typeof schema.default?.object === 'function' ? schema.default : undefined)
    if (!builder) return undefined
    return builder.object({
      mode: builder.union(['complement', 'off']).default('complement'),
      pruner: builder.object({
        enabled: builder.boolean().default(true),
        maxChars: builder.number().default(8000),
        keepHead: builder.number().default(2000),
        keepTail: builder.number().default(2000),
      }).default({ enabled: true, maxChars: 8000, keepHead: 2000, keepTail: 2000 }),
      memory: builder.object({
        enabled: builder.boolean().default(true),
        injectLimit: builder.number().default(6),
        maxInjectTokens: builder.number().default(1200),
        decayHalfLifeDays: builder.number().default(30),
        scopeMode: builder.union(['prefer', 'strict', 'off']).default('prefer'),
        scopeWeight: builder.number().min(0).max(1).default(0.35),
        extractMode: builder.union(['background', 'blocking', 'off']).default('background'),
        minTranscriptChars: builder.number().default(400),
      }).default({ enabled: true, injectLimit: 6, maxInjectTokens: 1200, decayHalfLifeDays: 30, scopeMode: 'prefer', scopeWeight: 0.35, extractMode: 'background', minTranscriptChars: 400 }),
      ledger: builder.object({
        enabled: builder.boolean().default(true),
        maxBlocks: builder.number().default(2000),
      }).default({ enabled: true, maxBlocks: 2000 }),
    })
  } catch {
    return undefined
  }
}

/**
 * 把任意输入规范成完整配置。
 *
 * 规则：
 *  - 未知顶层/嵌套键 → 忽略并记 warning；
 *  - 类型不对 → 回退默认值并记 warning（**不抛错**，保证插件总能起来）；
 *  - 数值做下界收敛，避免负值造成奇怪行为。
 *
 * @param {unknown} raw
 * @returns {{ config: typeof DEFAULT_CONFIG, warnings: string[] }}
 */
export function normalizeConfig(raw) {
  const warnings = []
  const input = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    warnings.push(`config 不是对象（收到 ${typeof raw}），已整体回退默认值`)
  }

  for (const key of Object.keys(input)) {
    if (!(key in DEFAULT_CONFIG)) warnings.push(`忽略未知配置项 "${key}"`)
  }

  let mode = DEFAULT_CONFIG.mode
  if (input.mode !== undefined) {
    if (typeof input.mode === 'string' && VALID_MODES.has(input.mode)) mode = input.mode
    else warnings.push(`mode 只能是 complement|off，收到 ${JSON.stringify(input.mode)}，已用 complement`)
  }

  return {
    config: {
      mode,
      pruner: normalizeGroup('pruner', input.pruner, DEFAULT_CONFIG.pruner, warnings, {
        enabled: 'boolean',
        maxChars: { kind: 'int', min: 0 },
        keepHead: { kind: 'int', min: 0 },
        keepTail: { kind: 'int', min: 0 },
      }),
      memory: normalizeGroup('memory', input.memory, DEFAULT_CONFIG.memory, warnings, {
        enabled: 'boolean',
        injectLimit: { kind: 'int', min: 1 },
        maxInjectTokens: { kind: 'int', min: 1 },
        decayHalfLifeDays: { kind: 'number', min: 0.001 },
        scopeMode: 'string',
        scopeWeight: { kind: 'number', min: 0, max: 1 },
        extractMode: 'string',
        minTranscriptChars: { kind: 'int', min: 0 },
      }),
      ledger: normalizeGroup('ledger', input.ledger, DEFAULT_CONFIG.ledger, warnings, {
        enabled: 'boolean',
        maxBlocks: { kind: 'int', min: 1 },
      }),
    },
    warnings,
  }
}

/**
 * 校验配置，返回结构化结果（测试与 `status` 动作都用它）。
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: string[], warnings: string[], config: typeof DEFAULT_CONFIG }}
 */
export function validateConfig(raw) {
  const { config, warnings } = normalizeConfig(raw)
  const errors = []

  if (config.pruner.enabled && config.pruner.keepHead + config.pruner.keepTail >= config.pruner.maxChars) {
    errors.push(
      `pruner.keepHead(${config.pruner.keepHead}) + keepTail(${config.pruner.keepTail}) 必须小于 maxChars(${config.pruner.maxChars})，否则永远不会折叠`,
    )
  }
  if (config.memory.enabled && config.memory.maxInjectTokens <= 0) {
    errors.push('memory.maxInjectTokens 必须为正数')
  }
  if (config.memory.enabled && !['prefer', 'strict', 'off'].includes(config.memory.scopeMode)) {
    errors.push(`memory.scopeMode 只能是 prefer|strict|off，收到 ${JSON.stringify(config.memory.scopeMode)}`)
  }
  if (config.memory.enabled && !['background', 'blocking', 'off'].includes(config.memory.extractMode)) {
    errors.push(
      `memory.extractMode 只能是 background|blocking|off，收到 ${JSON.stringify(config.memory.extractMode)}`,
    )
  }

  // 可选交叉校验：只有 schemastery 真的加载得到时才做，且失败仅记 warning。
  const schema = optionalConfigSchema()
  if (schema && typeof schema === 'function') {
    try {
      schema(isPlainObject(raw) ? raw : {})
    } catch (error) {
      warnings.push(`schemastery 交叉校验提示：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { ok: errors.length === 0, errors, warnings, config }
}

function normalizeGroup(name, raw, defaults, warnings, spec) {
  const input = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    warnings.push(`config.${name} 不是对象，已回退默认值`)
  }
  for (const key of Object.keys(input)) {
    if (!(key in defaults)) warnings.push(`忽略未知配置项 "${name}.${key}"`)
  }

  const out = {}
  for (const [key, defaultValue] of Object.entries(defaults)) {
    const rule = spec[key]
    const value = input[key]
    if (value === undefined) {
      out[key] = defaultValue
      continue
    }
    const result = coerce(key, `${name}.${key}`, value, rule, warnings)
    out[key] = result === undefined ? defaultValue : result
  }
  return out
}

function coerce(key, label, value, rule, warnings) {
  if (rule === 'boolean') {
    if (typeof value === 'boolean') return value
    warnings.push(`${label} 必须是布尔值，收到 ${JSON.stringify(value)}，已用默认值`)
    return undefined
  }
  if (rule === 'string') {
    if (typeof value === 'string') return value
    warnings.push(`${label} 必须是字符串，收到 ${JSON.stringify(value)}，已用默认值`)
    return undefined
  }
  const { kind, min, max } = rule
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warnings.push(`${label} 必须是数字，收到 ${JSON.stringify(value)}，已用默认值`)
    return undefined
  }
  const n = kind === 'int' ? Math.floor(value) : value
  if (n < min) {
    warnings.push(`${label} 不能小于 ${min}，已收敛为 ${min}`)
    return min
  }
  if (Number.isFinite(max) && n > max) {
    warnings.push(`${label} 不能大于 ${max}，已收敛为 ${max}`)
    return max
  }
  return n
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
