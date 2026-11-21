/**
 * engine/config.js —— 压缩目标策略与阈值解析。
 *
 * 逐字移植自 @deepseek-ai/dsh-compaction-basic/src/config.ts 的默认值、
 * resolveCompactSpec / resolveTargetPolicy / reservedCompletionTokens /
 * conversationTarget / routedTarget。
 *
 * @module engine/config
 */

/** 官方默认压缩配置（来自 resolveConfig 68-109）。 */
export const DEFAULT_ENGINE_CONFIG = Object.freeze({
  thresholdRatio: 0.8,
  headroomTokens: 65536,
  maxTokens: 65536,
  retainRatio: 0.16,
  compactionRetries: 1,
  maxOverflowRetries: 1,
  auto: true,
})

/** 目标配置错误的领域错误，携带 targetKey。 */
export class TargetPressureConfigError extends Error {
  /**
   * @param {string} targetKey
   * @param {string} message
   */
  constructor(targetKey, message) {
    super(message)
    this.name = 'TargetPressureConfigError'
    this.targetKey = targetKey
  }
}

/** 合并 retention 字段：显式 retainTokens > 显式 retainRatio > 继承值。 */
function resolveRetention(config, fallback) {
  if (config.retainTokens !== undefined) return { retainTokens: config.retainTokens }
  if (config.retainRatio !== undefined) return { retainRatio: config.retainRatio }
  return fallback
}

/**
 * 把顶层配置与 per-{provider,model} override 逐字段 `??` 合并成目标策略。
 *
 * @param {object} config
 * @param {{provider: string, model: string}} target
 */
export function resolveTargetPolicy(config, target) {
  const overrides = Array.isArray(config.modelPolicies) ? config.modelPolicies : []
  const override = overrides.find((policy) => policy.provider === target.provider && policy.model === target.model)
  const inheritedRetention = config.retainTokens === undefined
    ? { retainRatio: config.retainRatio }
    : { retainTokens: config.retainTokens }

  return Object.freeze({
    target: { provider: target.provider, model: target.model },
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    ...resolveRetention(override ?? {}, inheritedRetention),
    summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
    summarizationModel: override?.summarizationModel ?? config.summarizationModel,
    maxTokens: override?.maxTokens ?? config.maxTokens,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries,
  })
}

/**
 * 解析具体目标（provider/model）在给定上下文窗口下的压缩阈值。
 * 守卫逻辑与 config.ts:159-217 完全一致。
 *
 * @param {object} policy resolveTargetPolicy 的结果
 * @param {number} contextWindow
 * @param {number} reservedCompletionTokens
 */
export function resolveCompactSpec(policy, contextWindow, reservedCompletionTokens) {
  const targetKey = `${policy.target.provider}/${policy.target.model}`

  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new TargetPressureConfigError(targetKey, `BasicCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`)
  }
  if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) {
    throw new TargetPressureConfigError(targetKey, `BasicCompactionConfig: reservedCompletionTokens (${reservedCompletionTokens}) must be a non-negative integer`)
  }

  const messageBudgetTokens = contextWindow - reservedCompletionTokens
  if (messageBudgetTokens <= 0) {
    throw new TargetPressureConfigError(targetKey, `compaction-basic: ${targetKey} reserves ${reservedCompletionTokens} completion tokens of its ${contextWindow}-token context window, leaving no message budget; reduce maxTokens or use a model with a larger context window`)
  }

  const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens
  if (pressureBudgetTokens <= 0) {
    throw new TargetPressureConfigError(targetKey, `compaction-basic: ${targetKey} has a message budget of ${messageBudgetTokens} tokens but reserves ${policy.headroomTokens} headroom tokens, leaving no pressure budget; reduce headroomTokens or use a model with a larger context window`)
  }

  const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens))
  const retainTokens = policy.retainTokens === undefined
    ? Math.floor(messageBudgetTokens * policy.retainRatio)
    : policy.retainTokens
  if (retainTokens >= thresholdTokens) {
    throw new TargetPressureConfigError(targetKey, `BasicCompactionConfig: ${policy.target.provider}/${policy.target.model} retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`)
  }

  return Object.freeze({
    target: { ...policy.target },
    contextWindow,
    thresholdRatio: policy.thresholdRatio,
    thresholdTokens,
    retainTokens,
    summarizationProvider: policy.summarizationProvider,
    summarizationModel: policy.summarizationModel,
    maxTokens: policy.maxTokens,
    compactionRetries: policy.compactionRetries,
    maxOverflowRetries: policy.maxOverflowRetries,
  })
}

/** 请求头里为完成预留的 token 数。 */
export function reservedCompletionTokens(header, defaultMaxTokens) {
  return header.config.maxTokens ?? defaultMaxTokens ?? 0
}

/** session 最近一次路由到的 provider/model（若齐全）。 */
export function routedTarget(session) {
  const config = session?.requestHeader?.()?.config
  if (config === undefined || !config.provider || !config.model) return undefined
  return { provider: config.provider, model: config.model }
}

/** agent 当前会话的目标：优先 session 路由，其次 agent.options。 */
export function conversationTarget(agent) {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  const options = agent.options ?? {}
  if (options.provider && options.model) return { provider: options.provider, model: options.model }
  return undefined
}
