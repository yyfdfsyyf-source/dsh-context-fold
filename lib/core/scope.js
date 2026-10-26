/**
 * 记忆作用域（纯函数，不依赖 ctx / fs）。
 *
 * **为什么需要它**：记忆库是一个全局 jsonl 文件（`<DSH_HOME>/context-fold/memory.jsonl`），
 * 但记忆本身是**有项目归属**的。"这个仓库必须在 Node 22 上跑" 对另一个仓库毫无意义，
 * 却会因为 BM25 命中或时间新鲜而挤进注入预算，把真正相关的记忆挤出去。
 *
 * 实测证据（开发本插件时撞到）：本会话的 `system-prompt/assemble` 注入里出现了
 * 另一个项目的记忆（帧解析 bug、CI 线程池规格、日志不得打印 token），纯属噪声。
 *
 * 设计取舍：**默认不做硬过滤，只做加权**（`scopeMode: 'prefer'`）。
 * 理由：跨项目经验有价值（"别在日志里打 token" 是通用教训），一刀切会丢掉它；
 * 但同项目必须显著优先。需要严格隔离时把 `scopeMode` 设为 `'strict'`。
 */

/** 作用域处理模式。 */
export const SCOPE_MODES = Object.freeze(['prefer', 'strict', 'off'])

/**
 * 归一化路径：统一分隔符、去掉尾部斜杠、Windows 下大小写不敏感。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePath(value) {
  if (typeof value !== 'string') return ''
  let out = value.trim().replace(/\\/g, '/')
  if (out.length === 0) return ''
  // 折叠重复分隔符，但保留开头的 //（UNC）不动
  out = out.replace(/\/{2,}/g, '/')
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  if (process.platform === 'win32') out = out.toLowerCase()
  return out
}

/**
 * 从原始信息派生归一化作用域。
 *
 * @param {{ cwd?: string, repo?: string, branch?: string }} [input]
 * @returns {{ cwd: string, repo: string, branch: string }}
 */
export function deriveScope(input = {}) {
  const cwd = normalizePath(input?.cwd)
  let repo = typeof input?.repo === 'string' ? input.repo.trim() : ''
  if (repo.length === 0 && cwd.length > 0) {
    const parts = cwd.split('/').filter(Boolean)
    repo = parts.length > 0 ? parts[parts.length - 1] : ''
  }
  return {
    cwd,
    repo,
    branch: typeof input?.branch === 'string' ? input.branch.trim() : '',
  }
}

/**
 * 作用域亲和度（0..1）。
 *
 * 档位刻意少而可解释：
 *   - 同一 cwd        → 1.00
 *   - 同一 repo 不同 cwd → 0.85
 *   - 条目无作用域（历史遗留 / 手工写入）→ 0.50
 *   - 不同 repo       → 0.25
 *   - 无当前作用域信息 → 1.00（不惩罚，退化为旧行为）
 *
 * @param {{ cwd?: string, repo?: string, branch?: string } | null | undefined} entryScope
 * @param {{ cwd?: string, repo?: string } | null | undefined} currentScope
 * @returns {number}
 */
export function scopeAffinity(entryScope, currentScope) {
  const current = currentScope ? deriveScope(currentScope) : null
  if (!current || (current.cwd.length === 0 && current.repo.length === 0)) return 1

  if (!entryScope || typeof entryScope !== 'object') return 0.5
  const entry = deriveScope(entryScope)
  if (entry.cwd.length === 0 && entry.repo.length === 0) return 0.5

  if (current.cwd.length > 0 && entry.cwd.length > 0 && entry.cwd === current.cwd) return 1
  if (current.repo.length > 0 && entry.repo.length > 0 && entry.repo === current.repo) return 0.85
  return 0.25
}

/**
 * 是否应在 `strict` 模式下丢弃该条目。
 *
 * 只丢弃**明确属于其它项目**的条目；无作用域的条目保留（否则历史记忆全部失效）。
 *
 * @param {object | null | undefined} entryScope
 * @param {{ cwd?: string, repo?: string } | null | undefined} currentScope
 * @returns {boolean}
 */
export function shouldExcludeInStrictMode(entryScope, currentScope) {
  return scopeAffinity(entryScope, currentScope) < 0.5
}

/**
 * 把亲和度乘进排名分数并重新稳定排序。
 *
 * @param {ReadonlyArray<{ id: string, entry: object, score: number }>} ranked
 * @param {{ cwd?: string, repo?: string } | null | undefined} currentScope
 * @param {number} weight 亲和度权重（0 = 忽略作用域，1 = 完全按作用域）
 * @returns {Array<object>}
 */
export function applyScopeWeight(ranked, currentScope, weight = 0.35) {
  const list = Array.isArray(ranked) ? ranked : []
  const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0.35
  if (w === 0 || !currentScope) return list

  const adjusted = list.map((row) => {
    const affinity = scopeAffinity(row?.entry?.scope, currentScope)
    return { ...row, affinity, score: Number(row.score) * (1 - w) + Number(row.score) * affinity * w }
  })

  adjusted.sort((a, b) => (b.score - a.score) || compareIdLoose(a.id, b.id))
  return adjusted
}

/** 与 `core/bm25.js` 的 compareId 同语义，这里避免循环依赖就地实现。 */
function compareIdLoose(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}
