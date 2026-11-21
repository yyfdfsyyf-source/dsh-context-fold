/**
 * engine/anchors.js —— 确定性关键事实锚点（阶段2 benchmark 胜出逻辑迁移）。
 *
 * 背景：真实引擎用 LLM 摘要，而 bench/results/phase2.md 证明——埋在长消息
 * 中段的约束句（如「所有请求必须带 x-request-id」「签名是 normalizeError...」）
 * 会被 LLM 摘要漏掉。基线 s3 的 constraint 针留存只有 7/9。
 *
 * 解法（非 oracle，只靠句子自身的语言标记）：压缩前扫描被遮蔽消息，抽取
 * 带标记词的完整句，去重、限长后作为「Recovered Critical Facts」硬附加到
 * LLM 摘要。benchmark 中同样逻辑（s7 标记词摘要）把针留存从 88.9% 提到
 * 100%，且 prompt token 反而略降。
 *
 * 设计约束：
 *  - 只用 node 内建/纯函数，无裸导入 @deepseek-ai/*（symlink 解析风险）。
 *  - 严格限长（总字符上限），避免附加锚点撑破 shrink 检查
 *    （framedSummaryTokenCount >= shadowedRouteTokenCount 会拒绝压缩）。
 *  - 输入是 deriveEventMessage 产出的 {role, content:[{type:'text',text}]}。
 *
 * @module engine/anchors
 */

/**
 * 高价值句的语言标记（约束/决策/偏好/签名/根因）。
 * 刻意不包含任何具体 needle 内容，避免 oracle 泄漏。
 */
export const ANCHOR_MARKERS =
  /必须|不能|不得|禁止|不允许|硬性|要求|约定|决定|改成|统一|固定|偏好|喜好|不要用|务必|以后都|签名是|函数签名|签名|接口|根因|约束|不再|默认|注意/;

const SENT_END = /[。！？!?\n]/;

/** 锚点默认上限：防止撑破 shrink 检查。 */
export const DEFAULT_ANCHOR_LIMITS = Object.freeze({
  maxSentences: 6, // 每条消息最多抽几句
  maxCharsPerSentence: 300, // 单句截断长度
  totalChars: 2400, // 全部锚点合计字符上限（≈686 tokens）
  minChars: 8, // 短于此的句子忽略
});

/**
 * 把 ContentBlock[] 消息数组投影成纯文本（只取 text block）。
 */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * 从一段文本里抽出带标记词的完整句，去重、限长。
 * @returns {string[]}
 */
export function markerSentences(text, opts = {}) {
  const maxSentences = opts.maxSentences ?? DEFAULT_ANCHOR_LIMITS.maxSentences
  const maxChars = opts.maxCharsPerSentence ?? DEFAULT_ANCHOR_LIMITS.maxCharsPerSentence
  const minChars = opts.minChars ?? DEFAULT_ANCHOR_LIMITS.minChars
  const sentences = String(text ?? '')
    .split(SENT_END)
    .map((s) => s.trim())
    .filter((s) => s.length >= minChars)
  const out = []
  const seen = new Set()
  for (const sentence of sentences) {
    if (!ANCHOR_MARKERS.test(sentence)) continue
    // 归一化去重：去空白与常见标点差异，抓同一事实的重复表述。
    const key = sentence.replace(/\s+/g, '').slice(0, 48)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(sentence.length > maxChars ? sentence.slice(0, maxChars) + '…' : sentence)
    if (out.length >= maxSentences) break
  }
  return out
}

/**
 * 从被遮蔽消息中抽取关键事实锚点句（全局去重 + 总长上限）。
 *
 * @param {Array} messages deriveEventMessage 产出的消息数组
 * @param {object} [opts] 覆盖 DEFAULT_ANCHOR_LIMITS
 * @returns {string[]} 锚点句（可能为空）
 */
export function extractAnchors(messages, opts = {}) {
  if (!Array.isArray(messages)) return []
  const totalChars = opts.totalChars ?? DEFAULT_ANCHOR_LIMITS.totalChars
  const perMessage = {
    maxSentences: opts.maxSentences ?? DEFAULT_ANCHOR_LIMITS.maxSentences,
    maxCharsPerSentence: opts.maxCharsPerSentence ?? DEFAULT_ANCHOR_LIMITS.maxCharsPerSentence,
    minChars: opts.minChars ?? DEFAULT_ANCHOR_LIMITS.minChars,
  }
  const anchors = []
  const seen = new Set()
  let used = 0
  for (const message of messages) {
    for (const sentence of markerSentences(messageText(message), perMessage)) {
      const key = sentence.replace(/\s+/g, '').slice(0, 48)
      if (seen.has(key)) continue
      const cost = sentence.length + 1 // +1 for the bullet marker
      if (used + cost > totalChars) continue
      seen.add(key)
      anchors.push(sentence)
      used += cost
    }
  }
  return anchors
}

/**
 * 把锚点句包成一个 text ContentBlock，附加到摘要块数组末尾。
 * 无锚点时返回原数组（不改变引用语义由调用方保证）。
 *
 * @param {Array<{type:string,text?:string}>} summary LLM 摘要块
 * @param {string[]} anchors
 * @returns {Array<{type:string,text:string}>}
 */
export function appendAnchors(summary, anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) return summary
  const text = '\n\n## Recovered Critical Facts (deterministic anchors)\n' +
    anchors.map((a) => `- ${a}`).join('\n')
  return [...summary, { type: 'text', text }]
}
