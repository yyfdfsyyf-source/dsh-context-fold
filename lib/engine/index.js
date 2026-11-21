/**
 * engine/index.js —— 自包含压缩引擎的公共入口。
 *
 * 暴露与官方 @deepseek-ai/dsh-compaction-basic 一致的三个方法：
 *  - compactIfNeeded(agent, trigger, signal)
 *  - compactNow(agent, signal, sourceCommandId?)
 *  - compactRegion(start, end, agent, signal?)
 *
 * 运行时依赖全部经 ctx.get() 获取（tokenMeter / llm / sessions），缺失时
 * 优雅降级（返回 null），绝不因为服务未装载而抛错阻塞 turn。
 *
 * @module engine/index
 */

import {
  DEFAULT_ENGINE_CONFIG,
  resolveTargetPolicy,
  resolveCompactSpec,
  reservedCompletionTokens,
  routedTarget,
  conversationTarget,
  TargetPressureConfigError,
} from './config.js'
import { summarizeWithLlm, ManualCompactionError } from './core.js'
import {
  assertNoActiveCompaction,
  selectCompactableRange,
  compactSurfaceRegion,
} from './region.js'

/** 插件名（由 lead 在 lib/index.js 的 apply 中装配）。 */
export const name = 'context-fold-engine'

/** 把传入配置与官方默认值合并。 */
function normalizeEngineConfig(config) {
  return {
    ...DEFAULT_ENGINE_CONFIG,
    ...(config ?? {}),
  }
}

/** 摘要委托：根据会话目标解析 per-target 策略后调用自包含 summarizeWithLlm。 */
function createSummarize(ctx, config) {
  return (input, agent, signal) => {
    const llm = ctx?.get?.('llm')
    if (llm === undefined || typeof llm.stream !== 'function') {
      throw new Error('llm service is not available for summarization')
    }
    const target = conversationTarget(agent)
    const targetConfig = target === undefined ? config : resolveTargetPolicy(config, target)
    return summarizeWithLlm(ctx, targetConfig, input, agent, signal)
  }
}

/** regionDependencies()：压缩事务需要的 meter / summarize / recover。 */
export function regionDependencies(ctx, config) {
  return {
    meter: ctx?.get?.('tokenMeter'),
    summarize: createSummarize(ctx, config),
    recover: (error, agent, sourceEventSeqs, signal) => {
      const waterfall = ctx?.waterfall
      if (typeof waterfall !== 'function') return false
      return waterfall(
        'compaction/summary-error',
        {
          session: agent.session,
          sourceEventSeqs,
          error,
          ...(signal === undefined ? {} : { signal }),
        },
        () => false,
      )
    },
  }
}

/**
 * pressure 触发的自动压缩（移植 compaction-basic/src/index.ts:316-371）。
 *
 * @returns {Promise<object|null>}
 */
async function compactPressure(ctx, config, deps, agent, header, signal, requireBelowThreshold) {
  const meter = deps.meter
  if (meter === undefined) return null
  const llm = ctx?.get?.('llm')
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return null

  const target = header.config
  const policy = resolveTargetPolicy(config, target)
  const measurement = meter.measure(agent.session, header)
  const pruner = ctx?.get?.('toolResultPruner')

  const info = await llm.resolveModelInfo(target.provider, target.model, signal)
  assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
  if (info?.context === undefined) {
    throw new TargetPressureConfigError(`${target.provider}/${target.model}`, 'no context window information available for automatic compaction')
  }

  const spec = resolveCompactSpec(
    policy,
    info.context.contextWindow,
    reservedCompletionTokens(header, info.defaultMaxTokens),
  )
  if (measurement.totalTokens < spec.thresholdTokens) return null

  let currentMeasurement = measurement
  if (pruner !== undefined && typeof pruner.pruneSession === 'function') {
    pruner.pruneSession(agent.session)
    currentMeasurement = meter.measure(agent.session, header)
    if (currentMeasurement.totalTokens < spec.thresholdTokens) return null
  }

  let result = null
  for (let attempt = 0; attempt <= spec.compactionRetries; attempt++) {
    const range = selectCompactableRange(agent.session, currentMeasurement, spec.retainTokens)
    if (range === null) {
      if (result === null && !requireBelowThreshold) return null
      throw new Error(`no safe compaction range can reduce context below threshold (total ${currentMeasurement.totalTokens} >= threshold ${spec.thresholdTokens})`)
    }
    result = await compactSurfaceRegion(
      deps,
      agent.session,
      range.start,
      range.end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface' },
      signal,
    )
    currentMeasurement = meter.measure(agent.session, header)
    if (currentMeasurement.totalTokens < spec.thresholdTokens) return result
  }
  throw new Error(`compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts (total ${currentMeasurement.totalTokens} >= threshold ${spec.thresholdTokens})`)
}

/**
 * 构造压缩引擎对象（供测试直接调用，也供 apply 装配）。
 *
 * @param {object} ctx Cordis 上下文
 * @param {object} [rawConfig] 压缩配置（与官方 BasicCompactionConfig 对齐）
 */
export function createEngine(ctx, rawConfig) {
  const config = normalizeEngineConfig(rawConfig)

  const engine = {
    config,

    /**
     * 自动压缩入口。
     *
     * @param {object} agent
     * @param {'pressure'|'context-overflow'} trigger
     * @param {AbortSignal} [signal]
     */
    async compactIfNeeded(agent, trigger, signal) {
      const deps = regionDependencies(ctx, config)
      if (deps.meter === undefined) return null
      const header = agent?.session?.requestHeader?.()
      if (header === undefined || routedTarget(agent.session) === undefined) return null

      if (trigger === 'pressure') {
        return compactPressure(ctx, config, deps, agent, header, signal, false)
      }
      if (trigger === 'context-overflow') {
        const pruner = ctx?.get?.('toolResultPruner')
        if (pruner !== undefined && typeof pruner.pruneSession === 'function') pruner.pruneSession(agent.session)
        const measurement = deps.meter.measure(agent.session)
        const range = selectCompactableRange(agent.session, measurement, 0)
        if (range === null) return null
        return compactSurfaceRegion(
          deps,
          agent.session,
          range.start,
          range.end,
          agent,
          { owner: 'current-turn', stability: 'whole-surface' },
          signal,
        )
      }
      throw new Error(`unknown compaction trigger: ${trigger}`)
    },

    /**
     * 手动压缩入口（runMaintenance 内执行，owner=null）。
     *
     * @param {object} agent
     * @param {AbortSignal} signal
     * @param {string} [sourceCommandId]
     */
    compactNow(agent, signal, sourceCommandId) {
      signal?.throwIfAborted()
      const runMaintenance = agent?.runMaintenance
      if (typeof runMaintenance !== 'function') return Promise.resolve(null)

      try {
        return Promise.resolve(runMaintenance(async (agentSignal) => {
          const operationSignal = AbortSignal.any([agentSignal, ...(signal === undefined ? [] : [signal])])
          const deps = regionDependencies(ctx, config)
          if (deps.meter === undefined) return null
          try {
            operationSignal.throwIfAborted()
            const measurement = deps.meter.measure(agent.session)
            const range = selectCompactableRange(agent.session, measurement, 0)
            if (range === null) return null
            const sessions = ctx?.get?.('sessions')
            const flush = sessions !== undefined && typeof sessions.flush === 'function'
              ? async () => { await sessions.flush(agent.session) }
              : undefined
            return await compactSurfaceRegion(
              deps,
              agent.session,
              range.start,
              range.end,
              agent,
              {
                owner: null,
                stability: 'selected-span',
                ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
                ...(flush === undefined ? {} : { flush }),
              },
              operationSignal,
            )
          } catch (error) {
            if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
              throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error })
            }
            operationSignal.throwIfAborted()
            throw error
          }
        }))
      } catch (error) {
        throw new ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work', { cause: error })
      }
    },

    /**
     * 显式区间压缩（当前 turn 内，owner=current-turn）。
     *
     * @param {number} start
     * @param {number} end
     * @param {object} agent
     * @param {AbortSignal} [signal]
     */
    compactRegion(start, end, agent, signal) {
      const deps = regionDependencies(ctx, config)
      if (deps.meter === undefined) return Promise.resolve(null)
      return compactSurfaceRegion(
        deps,
        agent.session,
        start,
        end,
        agent,
        { owner: 'current-turn', stability: 'whole-surface' },
        signal,
      )
    },
  }

  return engine
}

/**
 * Cordis 插件入口：构造引擎并注册为 `compaction` 服务。
 *
 * @param {object} ctx
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const engine = createEngine(ctx, config)
  ctx.provide('compaction', engine)
  return engine
}
