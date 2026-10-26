# 开源 Agent 压缩与记忆机制调研

> 调研目的：为设计一个 DSH（DeepSeek Harness）上下文压缩 / 记忆插件做前置研究。
> 调研时间：2026-10-25。调研方式：包源码与包内文档直读 + 文件级代码片段检索 + 论文摘要元数据 + 插件市场数据统计。
> 读者：懂技术的开发者。全文结论均带证据级别，凡未亲自核对的实现细节一律标注"未验证"。

---

## 1. 摘要

开源 agent 压缩分五类：阈值触发的 LLM 摘要、滑窗丢弃、无 LLM 结构化裁剪、模型自写交接笔记、引擎托管无损递归。触发点趋同（窗口 50%–92%），差异在选择策略与可逆性，而可逆性才是分水岭。压缩与前缀缓存结构性冲突，仅尾部追加、头部固定注入、只改未缓存段能保缓存，且少有实测。学术强证据在"损伤什么"：`/compact` 五轮后安全规则剩 10%，拍平对话使伪造指令 87–100% 洗白。DSH 有 292 个 memory 插件、252 个自称压缩，头部却多不压缩。空白：无跨系统同条件对照，须自建基准。【A】

### 1.1 六条结论展开

1. **"压缩"在开源 agent 里几乎是同一个动作的五种方言**：按阈值触发的一次性 LLM 摘要（Claude Code / Codex / OpenHands / Roo / Cline）、按窗口滑动的丢弃（SWE-agent / Roo 旧版）、无 LLM 的结构化裁剪（OpenCode 的 tool-output prune、Hermes 的 Phase 1）、模型自己写的交接笔记（dsh-block-ptc、dsh-auto-memory 的 handoff）、以及引擎托管的无损递归（LCM）。它们的**触发时机高度趋同（窗口占用 50%–92%），差异几乎全在"选择策略"和"可逆性"上**。【A/B】
2. **可逆性是分水岭，而不是压缩率**。凡是"摘要替换原文"的方案，原文在模型上下文中永久消失，只能靠外部存储 + 检索工具补回；凡是"只裁剪工具输出并留指针"的方案，可以在一步内恢复。**后者在工程上便宜得多，且几乎不损失推理质量**。【A】
3. **前缀缓存（KV cache）与压缩是结构性冲突**。任何替换历史中段的压缩都会让缓存后缀失效。真正缓存友好的设计只有三种：只在尾部追加、只在头部注入固定文本、或只替换"尚未被缓存的部分"。**市面上大量插件宣称"缓存友好"，但公开材料中只有极少数给出缓存命中率的实测数字**。【A】
4. **学术界的强证据集中在"压缩会损伤什么"而非"压缩能省多少"**：Compaction Cliff 给出 Claude Code `/compact` 五轮后安全规则只剩 10%；Compaction Laundering 证明"把对话拍平成纯文本"会在代码层破坏消息来源，导致伪造指令 87–100% 概率洗白。**这两篇是本项目最应该先读的论文**。【A（论文自报）】
5. **DSH 生态里，"压缩类"头部插件多数并不压缩**：按 stars 排名第一的 `dsh-context`（3541★）是纯观测面板，`dsh-conversation-navigator`（23★）是纯前端大纲。真正的压缩实现是 `billion-context`（分层增量折叠）与 `dsh-block-ptc`（模型自写块摘要）。**生态的营销标签与实现能力严重错位**。【A】
6. **最大的空白：没有任何公开材料做过跨系统的同条件对照实验**。每个项目都在自己的场景、自己的模型、自己的任务集上自报收益，指标口径互不相同（billed tokens / context tokens / peak tokens / 成功率），无法横向比较。**这正是本项目需要自建基准的理由**。【A】

---

## 2. 证据分级说明

| 级别 | 定义 | 本次调研中的具体来源 |
|---|---|---|
| **A** | 亲自读过源码、包内 README/ARCHITECTURE/论文全文，或对包做了解包与字段核对 | `billion-context@0.1.206`（README 659 行 + paper/*.md 387 行 + CONFIGURATION.md）、`@openviking/dsh-memory-plugin@0.5.29`（README + `index.mjs` + `recall-core.mjs` + `recall-compress-core.mjs`）、`dsh-block-ptc@0.4.0`、`dsh-plugin-save-token@2.4.1`、`dsh-memento@0.5.28`、`meow-memory@0.31.1`、`@a9i5k4/dsh-auto-memory@3.3.17`、`dsh-context@0.76.0`、`dsh-conversation-navigator@0.2.11`、`dsh-plugin-catalog` 的 `plugins.json` 统计；**`@deepseek-ai/dsh-compaction` 与 `@deepseek-ai/dsh-compaction-basic`（经 `read` 工具直读 `app.asar` 归档内 `lib/index.js`，175 + 1027 行）** |
| **B** | 官方文档、权威二手描述、论文摘要（arXiv API 原文）、可信的代码片段检索结果（带文件路径与行号，但未读全文） | 各 agent 的官方文档站；arXiv 摘要原文；`advanced_search engine=exa` 返回的 GitHub 文件级片段 |
| **C** | 推断、未验证、或仅有第三方逆向描述 | Claude Code 的逆向分析（闭源）；未读到源码的内部常量；仅凭 README 营销文案推断的行为 |

**方法学声明（重要）**：

- 本机 `web_fetch` / `research` 的正文抓取全部失败（缺少上游 API key），因此**没有一次完整的网页正文抓取**。所有网页信息来自搜索引擎返回的标题+摘要，以及 `curl https://export.arxiv.org/api/query` 返回的论文摘要 XML。
- `raw.githubusercontent.com` 与 `api.github.com` 在本机被阻断（curl exit 7），因此**无法直接 clone 任何仓库**。代码证据依赖搜索引擎的文件级片段（含路径与行号），这类片段的级别定为 **B**，而非 A。
- 本报告**没有安装、也没有运行**除 DSH 之外的任何 agent 做端到端实测。所有性能数字均为**他人自报**，且逐条注明。
- 数字冲突时以我重算的为准：`plugins.json` 全市场 **6896** 条，`memory` 类 **292** 条，压缩关键词命中 **252** 条（与委派方给的 253 差 1，差异来自正则是否匹配 `description.zh`）。

---

## 3. 开源 Agent 的压缩机制横向表

### 3.1 总表

| 系统 | 触发时机 | 选择策略（压缩什么） | 摘要/压缩生成方式 | 是否可逆 | 是否保前缀缓存 | 级别 |
|---|---|---|---|---|---|---|
| **Claude Code** | 上下文达 **92%**（`autoCompactEnabled`）；另有一层在 `effectiveContextWindow - 13K` 触发的 Tier 4 自动压缩 | 中段整体替换；保护首条消息与最近若干轮；有 9 段式模板强制覆盖"意图/技术概念/文件与代码/错误/待办" | 派生子 agent（`runForkedAgent()`）执行 LLM 摘要；该 fork **共享父 agent 的模型与 prompt cache 前缀** | **否**（原文离开上下文，只能靠会话日志人工回溯） | 压缩调用本身复用缓存前缀，但**压缩结果替换历史 → 缓存后缀失效** | C（闭源，第三方逆向） |
| **OpenAI Codex CLI** | `model_auto_compact_token_limit` 阈值；新增 `AutoCompactTokenLimitScope` 支持只按"压缩后新增部分"计费 | 保留 `SUMMARY_PREFIX` + 摘要体；压缩输入上限 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` | `SUMMARIZATION_PROMPT`（`codex-rs/prompts/templates/compact/`），单次 LLM 摘要 | **否** | **是（设计目标）**：`body_after_prefix` scope 明确为"保留大段 carried prefix 的会话"设计 | B |
| **OpenHands** | `CondensationRequirement` 的 soft / **hard** 两级；`max_size` 事件数阈值 | 由 `Condenser` 策略决定；`RollingCondenser` 滚动窗口 + hard-context-reset；可 `PipelinableCondenserBase` 串联 | 默认 `LLMSummarizingCondenser`（LLM 摘要） | **否**（替换事件流） | 否 | B |
| **Cline** | 用户/模型主动调用 `summarize_task`；另有 auto-compact 特性 | "clear the context history at this point in time"，**不含当前 assistant 消息**（后续删除） | LLM 摘要（`summarizeTask` prompt） | **否** | 否 | B |
| **Roo Code** | ~90% 窗口（旧版为静默滑窗） | 旧版：滑动窗口**静默丢弃**历史；v2：LLM 摘要，**摘要作为 `user` 消息放在历史末尾**，API 历史"真正重新开始" | LLM 摘要 | 部分（UI 侧 `condenseParent` 标记可重新展开，但**模型侧不可逆**） | 否 | B |
| **SWE-agent** | 每步无条件执行 history processor | `LastNObservations`：只保留最近 n 条 observation（论文同款）；`ClosedWindowHistoryProcessor`：按"哪个窗口展示过"决定保留 | **无 LLM**，纯规则丢弃/保留 | 否（丢弃即消失） | 是（只改尾部，天然前缀友好） | B |
| **Aider** | 每次请求前重建 repo map | **不是压缩对话，而是压缩"代码库"**：tree-sitter 抽符号 → 构图 → `nx.pagerank(G, weight="weight")` 排序 → 按 `map_tokens` 预算截断；`get_ranked_tags(chat_fnames, other_fnames, mentioned_fnames, mentioned_idents)` 用聊天中提到的文件/标识符做 personalization | 无 LLM，图排序 + 预算截断 | 是（下次请求可重建，非破坏性） | 是（repo map 是每轮重算的独立段） | B |
| **Gemini CLI** | 默认压缩阈值 **0.5**（API key 用户，PR #13517）；此前为 0.5 的分数常量 | 整体历史压缩 | `chatCompressionService.ts` 内 LLM 摘要 | 否 | 否 | B |
| **Qwen Code** | **三级阶梯**：`warn = max(0.6 × window, …)` → auto → **hard-tier rescue**（在 API 拒绝前一次强制压缩）；旧版为单一 70% 阈值 | 整体历史压缩；压缩输出预算曾被固定为 20K（PR #9109 改为按剩余窗口 clamp） | LLM 摘要；支持 `/model --compaction` 指定专用小模型 | 否 | 否 | B |
| **OpenCode** | 先 prune 后 compact；`PRUNE_PROTECT = 40_000` / `PRUNE_MINIMUM = 20_000`；触发点修正为 `usable() = context - maxOutputTokens` | **两段式**：① 工具输出超过 40K 保护尾部后按 `TOOL_OUTPUT_MAX_CHARS = 2_000` 截断（无 LLM）；② 仍超限才 LLM compact | ① 纯截断 ② LLM 摘要 | ① 否（截断）② 否 | 部分（prune 只动尾部） | B |
| **Goose** | `GOOSE_CONTEXT_STRATEGY` ∈ {summarize, truncate, clear, prompt}；上下文超限时 | 整体 | prompt 原文要求"**Generate a version of the below messages with only the most verbose parts removed**"——是**有损改写**而非摘要 | 否 | 否 | B |
| **Hermes Agent** | 4 阶段流水线；`ContextCompressor` 迭代触发 | ① 先剪旧工具结果（>200 字符且不在保护尾）；② 中段摘要，头尾保护；③ `~20K tokens` 尾部预算（PR #2323，替代固定 `protect_last_n=4`）；④ 结构化迭代摘要 | 廉价辅助模型摘要 + 无 LLM 的规则裁剪 | 部分（工具结果被占位符替换） | 部分（头尾保护，只动中段） | B |
| **Letta / MemGPT** | 不压缩对话，靠模型主动调工具 | core memory 块常驻（**永不检索，直接 prepend**）；archival memory 只能工具检索 | 无自动摘要；模型自己 `core_memory_append/replace` | 是（archival 原文长期保存） | 是（core memory 在 prompt 头部固定） | B |
| **mini-swe-agent** | **无** | 无 | 无 | — | 是（无任何改写） | B（作为"无压缩"对照组） |
| **DSH 原生压缩（对照）** | `thresholdRatio = 0.8`，但实际压力线是**动态预算**：`pressureBudget = (contextWindow − reservedCompletionTokens) − headroomTokens`（headroom 默认 **65536**）；另有 `agent/request-error` 溢出兜底路径 | 保留尾部 `retainRatio = 0.16`（溢出路径置 0，只要能救回来）；切点强制工具对平衡；摘要不小于被遮蔽区则直接抛错 | 唯一钩子 `summarize(input, agent, signal)`；`input` 复用对话自身的 system + tools + 区间消息，**压缩调用本身是对话的真前缀 → 命中 KV 缓存** | 否（`surfaceOp: replace` 替换区间；原文留在 append-only 日志，模型侧不可恢复） | **压缩调用命中缓存；压缩之后的缓存后缀失效** | **A**（`app.asar` 内 `dsh-compaction{,-basic}/lib/index.js` 经 `read` 直读） |

### 3.2 从表里能读出的四件事

**(1) 触发阈值高度趋同，且都在"剩余 8%–50%"这个宽带里。** Claude Code 92%、Roo 90%、DSH 80%、Qwen 70%（旧）/60%（warn）、Gemini 50%、OpenCode 按 `context - maxOutput` 算。**没有一个系统在 30% 以下主动压缩**——因为压缩本身要花一次完整上下文的钱，早压缩是纯亏损。【A/B】

**(2) 只有两类系统真正做到"可逆"**：SWE-agent 式丢弃（不可逆，但也不假装可逆）与 Aider 式重建（repo map 每轮重算，天然无损）。**摘要型压缩全部不可逆**，这是结构性代价，不是实现缺陷。【A】

**(3) 前缀缓存的处理分三派**，且互相排斥：
- **尾部追加派**（SWE-agent、Aider、OpenViking、meow-memory）：只往上下文尾部或头部固定位置加东西，从不改中段 → 缓存永远有效。
- **中段替换派**（Claude Code、Codex、OpenHands、Gemini、Qwen、Goose、Hermes）：压缩即断缓存，接受这个代价。
- **头部固定派**（Letta core memory、dsh-memento 的 frozen snapshot）：文本恒定，注册一次永不变 → 缓存友好，代价是记忆无法在会话内更新。

**(4) Codex 的 `AutoCompactTokenLimitScope` 是最值得抄的一个设计**。它把"上下文有多满"和"自上次压缩以来涨了多少"拆成两个可分别计费的维度。原 PR 描述直白说明了动机：`model_auto_compact_token_limit` 过去只能对整个活跃上下文计费，"这让为**保留大段 carried prefix** 的会话设置一个小的'自压缩以来增长'预算变得很困难：被保留的前缀会吃掉整个预算，导致立刻重复压缩"。这正是"保前缀缓存"与"按窗口比例触发"之间的根本矛盾，而 Codex 选择了用配置项化解它。【B】

### 3.3 已知的真实故障（比宣传更有信息量）

| 系统 | 故障 | 含义 | 级别 |
|---|---|---|---|
| Codex CLI | issue #55508：模型用 tool call 回答摘要提示时，**压缩把 tool-call 片段当成了摘要**，无校验无重试 | 摘要生成必须校验产物形态 | B |
| OpenHands | issue #2255：`NoCondensationAvailableException` "Cannot condense 0 events"，当工具循环几乎占满整个 view 时发生，HARD 要求下无法回退 | 压缩的"最小可压缩区间"必须显式建模 | B |
| OpenCode | PR #46136：大窗口模型下自动压缩**永不触发**，因为溢出检查只看"最后一条完成消息"的 token 数 | 触发条件读错字段是最常见的实现级 bug | B |
| OpenCode | PR #10123 引入 `min_messages` "to prevent infinite compaction loops" | 压缩后仍超限 → 无限循环是真实风险 | B |
| Qwen Code | PR #9109：压缩 side-query 曾固定请求 20K 输出预算，不管会话还剩多少空间 | 压缩调用的输出预算必须与剩余窗口联动 | B |
| billion-context | 论文自述：**自发工具采用率为零**——模型只有被明确指示时才会去 `decompress` 恢复 | "可恢复"不等于"会恢复" | A（作者自报） |
### 3.4 逐系统档案（实现细节与常量）

> 这一节只写"表里放不下的东西"：具体常量、产物形态、已知 bug。**级别随行标注。**

**Claude Code**【C，闭源逆向】
- 阈值：上下文 **92%**（`autoCompactEnabled`）；另有 Tier 4 在 `effectiveContextWindow - 13K` 触发。`effectiveContextWindow = context − output reservation`。
- 产物：`BASE_COMPACT_PROMPT`（`src/services/compact/prompt.ts`，约 302 行）要求输出**9 个固定段落**：意图、技术概念、涉及文件与代码段、错误与修复、待办、当前工作、下一步……
- 压缩调用本身**走 fork 子 agent**（`runForkedAgent()`），共享父 agent 的模型与 prompt cache 前缀。这意味着"压缩这一次调用"是缓存友好的，但**它输出的摘要替换历史后，后续请求的缓存前缀全部失效**。
- `systemPromptAssembler()` 会在压缩时换入专用片段（`system-prompt-context-compaction-summary.md`、`analysis-instructions-for-full-compact-prompt-*.md`）。
- **对 DSH 的启示**：9 段式模板是"用结构对抗遗忘"的最早工程化尝试，但它治不了乘性衰减（见 Compaction Cliff：五轮后安全规则剩 10%）。

**OpenAI Codex CLI**【B，开源 Rust】
- `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`：压缩请求里"待压缩的用户消息"最多 20K token，超出部分如何处置未验证。
- `SUMMARY_PREFIX` + `SUMMARIZATION_PROMPT` 分离：摘要正文与"前缀说明"分开，便于模型识别"这是摘要不是原始对话"。
- `AutoCompactTokenLimitScope` 是 enum，取值包含 `body_after_prefix`（PR #22870）。语义："选择活跃上下文的哪一部分被计入 `model_auto_compact_token_limit`"。**这是把"压缩预算"与"保留前缀"解耦的官方机制**。
- 已知 bug #55508：模型用 tool call 回答摘要提示 → 压缩把 tool-call 片段存成摘要，**无校验、无重试**。
- **启示**：摘要产物必须做形态校验（至少检查非空、非 tool-call、长度下界）。

**OpenHands**【B，开源 Python】
- `openhands-sdk/openhands/sdk/context/condenser/base.py`：
  - `class CondenserBase(DiscriminatedUnionMixin, ABC)`（`:16-78`）
  - `class CondensationRequirement(Enum)`：`HARD = "hard"`，另有 soft 级
  - `condensation_requirement()`（`:138-151`）—— 由 view 的状态推导出"必须压/可以压"
  - `RollingCondenser`（`:107-252`）—— 滚动窗口 + soft/hard 要求 + hard-context-reset
  - `PipelinableCondenserBase` —— 允许 condenser 串联成流水线
- 默认实现 `LLMSummarizingCondenser`（`llm_summarizing_condenser.py`）：LLM 摘要。
- 触发文档原话："Threshold exceeded (e.g., event count > `max_size`)"——**注意是按事件数而非 token 数**。
- 已知 bug #2255：`NoCondensationAvailableException` "Cannot condense 0 events"。场景：一次工具循环几乎占满整个 view，没有可压缩的事件；HARD 要求下无法降级。
- V0 的 `openhands/core/config/condenser_config.py` 自 1.0.0 起废弃，计划 2026-04-01 移除；V1 全走 SDK。
- **启示**：soft/hard 两级要求 + 最小可压区间检查，是避免"压不动却必须压"的必要设计。

**Cline**【B，开源 TS】
- `src/core/prompts/contextManagement.ts`：`export const summarizeTask = (focusChainSettings?, cwd?, isMultiRootEnabled?) =>`
- `src/core/task/tools/handlers/SummarizeTaskHandler.ts`：`async execute(config: TaskConfig, block: ToolUse)`，注释写明"clear the context history at this point in time. note that this will not include the assistant message // for summarizing, which we will need to delete later apiConversationHistory"。
- `src/core/prompts/commands.ts`：`export const condenseToolResponse = (…) => \`<explicit_instructions type="condense"> The user has explicitly asked you to create a detailed summary…\``
- **注意**：Cline 的"摘要"是**工具调用**（`summarize_task`），由模型决定何时调用；不是纯自动阈值。另有 auto-compact 特性（PR #5520）。
- **启示**：把压缩做成"模型可调用的工具"而非纯后台行为，是主流做法之一（billion-context、dsh-block-ptc 同路线）。

**Roo Code**【B，开源 TS】
- 文件：`src/core/condense/index.ts`、`src/core/context-management/index.ts`
- PR #3582 原话："Currently, once **~90% of the context window is full**, Roo will **drop historical messages silently using a sliding window**"——**这是"静默滑窗"的典型反面教材**：用户不知道历史被丢了。
- PR #10873 "Intelligent Context Condensation v2" 改为：**"After: Effective API history contains only the summary (true fresh start) after a condensing event; Summary is a `user` message placed at the end of message history"**。
- UI 侧用 `condenseParent: "condense-1"` 标签把被压缩区间折叠，**可重新展开**——但那是给人看的，模型侧已不可逆。
- **启示**："真·重新开始"（只留摘要 + 摘要作为 user 消息置于末尾）是缓存最友好的摘要式方案之一：因为后续请求的前缀就是"摘要 + 新内容"，不再引用旧历史。

**SWE-agent**【B，开源 Python】
- `sweagent/agent/history_processors.py`：
  - `class LastNObservations(BaseModel)`，文档串："Elide all but the last n observations or remove tagged observations. **This is our most classic history processor, used in the original paper**"
  - `class ClosedWindowHistoryProcessor(BaseModel)`，文档串："For each value in history, keep track of which windows have been shown. We want to mark windows that should stay open (they're the last window for a particular file)"
- 配置文档：`swe-agent.com/latest/reference/history_processor_config/`
- **启示**：`ClosedWindowHistoryProcessor` 是唯一按"语义单元是否仍在使用"（某个文件的最后一个窗口）来选择的实现，比"最近 N 条"精细得多。这个思路值得移植。

**Aider**【B，开源 Python】
- `aider/repomap.py`：`def get_ranked_tags(self, chat_fnames, other_fnames, mentioned_fnames, mentioned_idents, progress=None)`，内部 `ranked = nx.pagerank(G, weight="weight", **pers_args)`（有 `except ZeroDivisionError: # Issue #1536`）。
- 机制：tree-sitter 解析出定义/引用 → 建图 → **PageRank 排序** → 按 `map_tokens` 预算截断 → 只把最相关的部分塞进 prompt。
- personalization：聊天中提到的文件名与标识符作为 PageRank 的 personalization 向量——**这是"用对话内容引导检索"的早期实现**。
- 官方文档："Aider solves this problem by sending just the most relevant portions of the repo map. It does this by analyzing the full repo map using a graph ranking algorithm"。
- **启示**：repo map 是"每次请求重建"的**无损**压缩：它不消耗历史，只是每轮重新算一遍。代价是 CPU 时间，收益是永不衰减。

**Gemini CLI**【B，开源 TS】
- `packages/core/src/context/chatCompressionService.ts` 注释："Default threshold for compression token count as a fraction of the model's token limit. If the chat history exceeds this threshold, it will be compressed."
- 默认值历史：commit 68afb72 "Change default compression threshold (#12306)" → PR #13517 "**Change default compress threshold to 0.5** for api key users"。
- `packages/core/src/core/client.ts` 明确区分"display content"与"the processed one for the API and durable history"——**展示层与模型层分离**，这是 Roo/Cline 的 UI 折叠能存在的前提。
- **启示**：`0.5` 是个很激进的默认值（一半窗口就压）。这意味着大量 Gemini CLI 会话在还很"新鲜"时就被压缩过——是一个天然的高压缩频率样本。

**Qwen Code**【B，开源 TS，Gemini CLI fork】
- `packages/core/src/services/chatCompressionService.ts`
- PR #4345 "feat(core)!: redesign auto-compaction thresholds with **three-tier ladder**"：从"单一比例阈值（**70% of window**）"改为"warn / auto / … **hard-tier rescue**"，后者"forces compaction one send before the API would reject an oversized proactive"，并给出 `warn = max(0.6 × window, …)`。
- DeepWiki 提到 `_BUFFER`（13,000 tokens）——与 Claude Code 的 13K 是同一个数量级（未验证是否同源）。
- PR #9109 "Clamp compression output budget to remaining context window"："The compression side-query previously requested a fixed **20K-token** output budget regardless of how much room the session's prompt actually left"。
- commit 933d78a：`/model --compaction` 可指定专用压缩模型，并有守卫——若瘦身后的 payload 超过压缩模型的窗口，**回退到主模型**。
- **启示**：三级阶梯（warn / auto / rescue）是比单一阈值更稳的结构：warn 层可以只提示、不动作；rescue 层保证不撞 API 墙。

**OpenCode**【B，开源 TS】
- `packages/opencode/src/session/compaction.ts`：
  - `export const PRUNE_MINIMUM = 20_000` —— 至少回收 20K 才值得 prune
  - `export const PRUNE_PROTECT = 40_000` —— 最近 40K token 的工具输出受保护
  - `const TOOL_OUTPUT_MAX_CHARS = 2_000` —— 被 prune 的工具输出截到 2K 字符
- 配置 `compaction.reserved` 是**溢出缓冲**（给输出留的空间），不是触发阈值；`compaction.trigger_at` 是社区请求（issue #27706）。
- PR #46136 修的是"大窗口模型下永不触发"，根因：溢出检查只传了**最后一条完成消息**的 token 数（`lastFinished.tokens`）。
- PR #45933 把触发点改为 `usable() = context - maxOutputTokens`，`OUTPUT_TOKEN_MAX = 32000`。
- PR #10123 加 `min_messages` 以防无限压缩循环。
- **启示**："先 prune 再 compact"的两段式是成本最优的常见结构（Hermes 同构）。prune 无 LLM 成本，且只动尾部，缓存友好。

**Goose**【B，开源 Rust】
- `GOOSE_CONTEXT_STRATEGY` ∈ {"summarize", "truncate", "clear", "prompt"}（commit 522bf0a，`documentation/docs/guides/environment-variables.md`）。
- `crates/goose/src/prompts/compaction.md` 原文："An llm context limit was reached when a user was in a working session with an agent (you) - **Generate a version of the below messages with only the most verbose parts removed**"。
- **这是"有损改写"而非"摘要"**：不要求模型写"发生了什么"，而要求它"把啰嗦的部分删掉"。区别在于：改写保留原有叙事顺序与措辞，摘要则重新组织。前者更省 token 但也更容易丢约束（因为模型会认为某句"啰嗦"）。
- PR #1457 "feat(agent): memory condensation for longer context"；PR #2207 "present options to user when context length is exceeded"。
- 文档描述"two-tiered approach: 1. Auto-Compaction… 2. …"（第二层未验证）。
- **启示**：`clear` 策略（直接清空）与 `prompt` 策略（问用户）是两种常被忽略的合法选项——不是所有场景都该压缩。

**Hermes Agent**【B，开源 Python】
- `agent/context_engine.py`：`ContextEngine` ABC —— **可插拔上下文引擎**，这是本调研见到的唯一把"压缩策略"做成正式扩展点的设计（Goose 的 env var 是弱版本）。
- `agent/context_compressor.py` 文档串："Automatic context window compression: a cheap auxiliary model summarizes middle turns while head and tail are protected (iterative summaries, token-budget tail, tool-output pruning first, scaled budgets)."
- 文档 `website/docs/developer-guide/context-compression-and-caching.md` 给 4 阶段：
  1. **Prune Old Tool Results（cheap, no LLM call）** —— 保护尾之外、>200 字符的旧工具结果替换为占位符
  2. 中段摘要（头尾保护）
  3. **Token-budget tail protection** —— PR #2323："Before: Fixed `protect_last_n=4` … After: Walks backward keeping **~20K tokens** of recent context. Falls back to `protect_last_n` for small conversations"
  4. 结构化迭代摘要（"iterative summaries, scaled budgets"）
- 社区插件 `hermes-vcc-engine`："builds the compaction summary in **milliseconds with no LLM call**, keeping the exact commands, exit codes, errors and files, each linked back to its original message"——**确定性压缩**路线。
- 文档**显式把 LCM 列为可选替代引擎**。
- **启示**：`ContextEngine` ABC 是最值得抄的架构决策。DSH 插件若做成"引擎 + 策略注册"，就能同时容纳 LLM 摘要、确定性裁剪、LCM 三种范式。

**Letta / MemGPT**【B，开源 Python】
- `letta/schemas/memory.py`：`class Memory(BaseModel, validate_assignment=True)`，文档串："Represents the in-context memory (i.e. Core memory) of the agent. This includes both the `Block` objects (labelled by sections), as well as tools to edit the blocks."
- `letta/functions/function_sets/base.py`：`def conversation_search(self: "Agent", query: Optional[str] = None, …)`
- 官方文档："memory blocks … are **always visible - no retrieval needed** … simply prepended to the agent's prompt"；"archival memory fragments **cannot be pinned to the context window**, and must be queried on-demand via tools"。
- **启示**：Letta 不压缩，它**重新定义了上下文的构成**：core 块 = 常驻且可编辑的"工作记忆"，对话历史 = 可丢弃的"日志"，archival = 可检索的"档案"。**这是与压缩正交的一条路，DSH 插件值得同时支持。**

**mini-swe-agent**【B，开源 Python】
- `src/minisweagent/agents/default.py`：`class AgentConfig(BaseModel)`；`src/minisweagent/config/mini.yaml`。
- 默认 agent **没有任何 history processor / compaction**——每步把完整历史发给模型，撞墙即失败。
- **启示**：这是唯一的"纯净对照臂"。任何压缩实验都必须有它。

### 3.5 压缩失败模式分类学

> 把 §3.3 与 §5 里的故障归纳成 9 类。**这张表可以直接当测试用例清单用。**

| # | 失败模式 | 真实案例 | 症状 | 检测方法 | 级别 |
|---|---|---|---|---|---|
| F1 | **从不触发** | OpenCode PR #46136（读错字段，大窗口模型永不压） | 上下文撞墙、请求被 API 拒绝 | 在多种窗口尺寸下跑满窗口，断言压缩事件发生 | B |
| F2 | **触发过早 / 过度压缩** | save-token 引用的 RCT：keep ratio 0.2 使成本 **+1.8%** | 成本不降反升、重查率上升 | 记录 re-fetch 次数与 billed token，对比 0.2 / 0.5 / 0.72 三档 | B |
| F3 | **无限压缩循环** | OpenCode PR #10123 引入 `min_messages` | 压缩后仍超限 → 反复压缩 → 会话卡死 | 断言"单轮内压缩次数 ≤ 1" | B |
| F4 | **无可压区间** | OpenHands issue #2255 `Cannot condense 0 events` | 抛异常，会话无法继续 | 构造"单个工具循环占满 view"的用例 | B |
| F5 | **产物形态错误** | Codex issue #55508（tool-call 片段被当摘要） | 摘要位置是一段 JSON/工具调用 | 摘要产物做 schema + 长度 + 非 tool-call 校验 | B |
| F6 | **来源破坏（安全）** | Compaction Laundering：拍平型 harness **87–100%** 被洗白，角色类型化 **0%** | 伪造的用户指令在压缩后成为真指令 | 压缩前后比对消息角色元数据；注入"伪造批准"用例 | B |
| F7 | **约束丢失** | Compaction Cliff：Claude Code `/compact` 五轮后安全规则剩 **10%** | agent 违反早前设定的禁令/审批要求 | 用"安全规则保留率"作指标，跑 ≥5 轮压缩 | B |
| F8 | **恢复不可达** | billion-context 自述：**自发工具采用率为零** | 有 `decompress` 工具但模型从不主动用 | 埋"必须恢复才能答对"的探针题，统计自发恢复率 | A |
| F9 | **压缩后记忆失联** | 生态里仅 `meow-memory` 显式处理（压缩后重注入） | 压缩后 agent 忘记用户偏好/项目约定 | 压缩前后各问一次"你知道我的偏好吗" | A |

**这张表的一个额外含义**：F6 与 F7 都属于"规范性内容最先丢失"，而 F1–F5 都是工程实现级 bug。**换句话说，压缩系统的失败大部分不是"压得不够好"，而是"根本没压/压错东西/压坏了权威"。**
---

## 4. 开源 Agent 的记忆机制横向表

> 注意：**"记忆"与"压缩"是两个正交的轴**。压缩解决"窗口满了怎么办"，记忆解决"窗口里应该放什么"。多数 DSH 记忆插件两者都不做——它们做的是**检索注入**（retrieval-augmented prompting），即在每轮请求前把外部条目拼进上下文。这张表按"存储形态 / 写入 / 检索 / 跨会话 / 衰减"五维对比。

### 4.1 总表

| 系统 | 存储形态 | 写入时机 | 检索方式 | 跨会话 | 衰减 / 合并策略 | 级别 |
|---|---|---|---|---|---|---|
| **MemGPT / Letta** | 三级：**core memory**（in-context `Block` 对象，按 section 分块）/ **recall memory**（完整消息历史）/ **archival memory**（向量库） | 模型主动调 `core_memory_append` / `core_memory_replace` / `archival_insert`；系统在窗口压力下发 **interrupt** 强制它整理 | core memory **永不检索，直接 prepend 到 prompt**；archival 通过 `conversation_search` / `archival_memory_search` 工具按需查 | 是（agent 状态持久化在 DB） | 无自动衰减；靠模型自己 `replace` 覆盖。压缩即"把旧消息压进 recall 层" | B（`letta/schemas/memory.py` 的 `class Memory` 文档串 + 官方文档） |
| **Mem0** | 向量库 + 可选 **graph memory**（实体-关系图）；每条记忆是自然语言"事实" | **两阶段**：extraction（从对话抽候选事实）→ update（与已有记忆比对，执行 ADD / UPDATE / DELETE / NOOP）。**v3 文档改为单遍 ADD-only，取消 UPDATE/DELETE** | 向量相似度 +（graph 模式下）图遍历 | 是 | 靠 update 阶段的 DELETE/UPDATE 去重合并；**v3 取消后，去重责任转移到抽取阶段** | B（论文 2504.19413 + 官方 v3 文档） |
| **Zep / Graphiti** | **时序知识图谱**：`EntityEdge` 带 `name` / `fact` / `valid_at` / `invalid_at`；**双时间轴**（事实在世界上为真的时间 + 系统摄入时间） | 每轮对话后异步抽取实体与边；`extract_edges` → `resolve_extracted_edges`，冲突时**不删除旧边，而是给旧边打 `invalid_at`** | 图检索（实体锚定 + 边遍历）+ 向量混合；社区摘要 | 是 | **靠时间失效而非删除**：旧事实保留但标记失效，可回答"当时是什么" | B（`graphiti_core/edges.py`、`prompts/extract_edges.py` 片段 + 论文 2501.13956） |
| **A-MEM** | **Zettelkasten 卡片盒**：每条记忆是一张 note，含上下文描述、关键词、标签、向量 | 新记忆到来即建 note；随后**自动链接**到历史 note，并触发 **memory evolution**——修改既有 note 的属性（标签/上下文） | 向量检索 + 链接图扩展 | 是 | **演化式**：不是删除，而是让旧 note 因新 note 而"长大" | B（论文 2502.12110 摘要） |
| **Cognee** | **知识图谱 + 向量索引双写**；默认 SQLite + LanceDB + Ladybug，嵌入式部署 | **ECL 流水线**（extract → cognify → load）；文档级批处理，非逐轮 | 图查询 + 向量检索并跑 | 是 | 由 cognify 阶段的重建决定；无逐条衰减 | B（docs.cognee.ai） |
| **LangMem** | LangGraph 长期记忆 store（namespace 分区） | 两条路径：**Hot Path**（当轮内同步写）/ **Background**（等对话"settle"后延迟巩固） | 语义检索 + namespace 过滤 | 是 | Background 路径做**延迟巩固**（consolidation），是"写时合并"而非"读时合并" | B（langchain-ai.github.io/langmem） |
| **OpenViking**（`viking://` 存储模型） | **URI 命名空间文件系统**：`viking://~/memories`、`viking://~/skills`、`viking://user/<uid>/memories`、`viking://agent/skills`；底层是带向量索引的文档库，可 `read` / `list` / `tree` / `grep` / `glob` | `session/event` 捕获 user/assistant（可选 tool-result）；`turn/end` 累计到 `commitTokenThreshold`（默认 20000 token）才落盘；失败写走 pending 队列 + 60s 后台 drainer | `POST /api/v1/search/search` `mode:"context"`，按六类（events / entities / preferences / experiences / resources / skills）各分配 ≥1 个召回位；`scoreThreshold` 默认 0.35 | 是（peer 由工作区 git 身份派生，`recallPeerScope: all` 默认扫全部 peer） | **读时压缩**：检索到的碎片由 LLM 压成 ≤6 条 bullet，每条必须带 `来源：viking://...`；`repairDigestUris()` 用编辑距离把幻觉 URI 拉回真实集合 | **A**（README + `recall-core.mjs` + `recall-compress-core.mjs` 直读） |

### 4.2 三个值得单独说的设计

**(1) OpenViking 的"读时压缩"是对的方向，但有个陷阱。** 它不在会话里压历史，而是在**检索结果回注前**把碎片压成 6 条带来源的 bullet。好处是压缩成本与"召回量"挂钩而非与"会话长度"挂钩，且每次都重新生成、不会累积误差。陷阱是**它必须防止模型编造 URI**——`repairDigestUris()` 用 `max(4, floor(len*0.25))` 的编辑距离容差做校正，纠不回来的 bullet 直接丢弃。这说明"带来源的压缩"是一个必须工程化的不变量，不能只写在 prompt 里。【A】

**(2) OpenViking 刻意不走 system prompt，这个反直觉决定有硬理由。** 它的 recall/profile 通过 `agent/pre-step` 以**带来源的用户消息**注入，而不是拼进 system prompt。README 给的理由是：某个声明了 `complete: true` 的 persona 在装配后会**静默丢弃其它所有 prompt section**，"基于 system prompt 的记忆插件在这种 preset 下会无声地失去上下文"。同时 pre-step 注入是会话事件，可重放、对压缩可见、且不进 `request/header`。**对比 `dsh-memento` 恰好选了相反路线**（把冻结快照写进 `system/message`，靠"冻结一次永不改"来保缓存）。两条路线都自洽，但**在同一宿主上不能假设哪一种"正确"——这取决于宿主的事件语义**。【A】

**(3) Zep 的"失效而非删除"是唯一能回答时序问题的方案。** `EntityEdge` 的 `valid_at` / `invalid_at` 让"用户去年住在柏林、今年搬到慕尼黑"变成两条边而非一次覆盖。代价是图会单调增长，必须靠社区摘要（community summary）来控制检索规模。**Mem0 的 v3 取消 UPDATE/DELETE 恰恰走向反面**：单遍 ADD-only 更便宜，但把冲突解决完全推给了检索期的排序。【B】

### 4.3 记忆系统的"跨会话"成色差异很大

| 系统 | 跨会话的真实含义 | 级别 |
|---|---|---|
| Letta | agent 级持久化，同一 agent id 跨会话共享 core + archival | B |
| Mem0 / Zep / Cognee / LangMem | 按 `user_id` / namespace 隔离，跨会话共享 | B |
| OpenViking | 按 **peer**（工作区 git 身份）+ user 双层隔离；同一仓库的所有会话共享，跨仓库默认也可见（`recallPeerScope: all`） | A |
| dsh-memento | 两轨（user / agent）× 两层（global / workspace）× per-`agentPreset` 隔离 | A |
| meow-memory | 七层表 + `project` 锚定；未锚定时只搜全局，"用户闲聊不误伤" | A |

---

## 5. 学术方法表

> 数字全部来自论文摘要原文（arXiv API），**均为作者自报**。本次调研**没有找到任何第三方独立复现**这些数字的材料。

| 方法 | 核心机制（一句话） | 报告的效果数字 | 自报 / 复现 | 级别 |
|---|---|---|---|---|
| **LLMLingua-2** (2403.12968) | 用数据蒸馏把"删哪些 token"训成一个**token 分类任务**，XLM-RoBERTa-large/mBERT 编码器做双向上下文判断，替代 LLMLingua-1 的因果 LM 困惑度打分 | "比现有 prompt 压缩方法**快 3–6 倍**"，端到端延迟加速 **1.6–2.9 倍**；在 MeetingBank / LongBench / ZeroScrolls / GSM8K / BBH 上评测 | 作者自报 | B（arXiv 摘要原文） |
| **Selective Context** (2304.12102) | 用**自信息**（self-information）过滤低信息量内容，只保留高信息密度片段 | 摘要中**无压缩率数字**，只给出在学术论文/新闻/对话转写上的摘要与 QA 评测 | 作者自报 | B |
| **RECOMP** (2310.04408) | 训练**抽取式 + 生成式**两个压缩器，端到端为下游 LM 优化；可返回空串实现"选择性增强" | "压缩率低至 **6%** 且性能损失极小"；压缩器可跨 LM 迁移 | 作者自报 | B |
| **LCM: Lossless Context Management** (2605.04050) | **确定性**架构：分层摘要 DAG 自动压缩旧消息，但**保留指向每条原文的无损指针**；第二机制是"递归任务分区"，用引擎托管的 LLM-Map 取代模型自己写的循环 | LCM 增强的编码 agent **Volt** 在 **OOLONG** 上、用 Opus 4.6，**在 32K–1M 每一个上下文长度档位都超过 Claude Code** | 作者自报 | B |
| **AgentFold** (2510.24699) | 把"折叠"做成**多尺度操作**：细粒度condense ↔ 对整段子任务的深度consolidate；**仅用 SFT 训练**，不依赖推理期脚手架 | AgentFold-30B-A3B：**BrowseComp 36.2%**、**BrowseComp-ZH 47.3%**，超过 DeepSeek-V3.1-671B-A37B 与 OpenAI o4-mini | 作者自报 | B |
| **ACON** (2510.00615, ICML 2026) | **不训模型，训"压缩指南"**：从 agent 的失败轨迹里分析出该保留什么/该丢什么，写成自然语言 guideline；再把 compressor 蒸馏进小模型 | 峰值 token 用量**降 26–54%**，同时任务成功率上升；小模型因缓解"上下文分心"获得**最高 46%** 性能提升；评测 AppWorld / OfficeBench / 多目标 QA | 作者自报 | B |
| **SWE-Pruner** (2601.16746) | agent 显式给出 **goal hint**（如"focus on error handling"），一个训练过的 **0.6B** 神经剪枝器据此**按行**选代码 | SWE-Bench Verified 上 **token 减少 23–54% 且成功率提升**；单轮任务如 LongCodeQA 达 **14.84× 压缩** | 作者自报 | B |
| **The Compaction Cliff** (2608.22752, CIKM 2026) | 诊断 + 修复：把"压缩掉什么"从"按长度"改成**按行类型**（Knowledge Triage），三个确定性算子 **TypeCompact / TypeDecompose / TypeRetrieve** | Claude Code `/compact`（Sonnet 4.6）**一轮后仅保留 53% 安全规则，五轮后剩 10%**；TypeCompact 比最强单次 LLM 压缩器多保 **2–4×** 安全规则、五轮 **96% recall**；TypeDecompose **局部性违规 0% vs 93%**；TypeRetrieve **recall@50 100% vs 73%**；在医疗合规（McNemar p<1e-8, N=200）、零售通过率（p<0.01, N=115）、航空（p=0.024）上胜过生产级 Sonnet 压缩器。附带发布 **AgentArtifactCorpus：54,628 个公开 GitHub 仓库的 396,934 个 agent 配置** | 作者自报（有统计检验） | B |
| **Compaction Laundering** (2610.29869) | **安全**：证明"把类型化对话拍平成一个字符串"会在**摘要器运行之前的代码层**破坏消息来源，使伪造的用户轮次在压缩后变成真指令 | **5 个拍平型 harness（pi / opencode / Cline / Aider / OpenHands）**：伪造批准洗白成功率 **87–100%**，窗口上限约 **908,000 token**；**4 个角色类型化 harness（Codex / Gemini CLI / Qwen Code / Continue）**：**0%**。代码级来源校验可拦 **77%**，代价是降级 **2%** 的合法摘要内容 | 作者自报 | B |
| **MemGPT** (2310.08560) | "虚拟上下文管理"：把 OS 的分层内存 + 中断机制搬到 LLM，主上下文 / 外部上下文两级，模型通过工具在两级间搬数据 | 文档分析与多会话对话两个场景；摘要中无统一百分比 | 作者自报 | B |
| **Mem0** (2504.19413) | 抽取 + 更新两阶段，把对话压成"事实"入库；可选图记忆 | 相对 OpenAI 记忆方案 LLM-as-a-Judge **提升 26%**（相对值）；图记忆再 **+~2%**；相比全上下文 **p95 延迟低 91%**、**token 成本省 >90%** | 作者自报 | B |
| **A-MEM** (2502.12110) | Zettelkasten 卡片 + 自动链接 + 记忆演化 | 六个基座模型上"优于现有 SOTA 基线"，**摘要未给数字** | 作者自报 | B |
| **Zep** (2501.13956) | Graphiti 时序知识图谱 | DMR **94.8% vs 93.4%**（对 MemGPT）；LongMemEval 最高 **+18.5%** 准确率，**延迟降 90%** | 作者自报 | B |

### 5.1 学术侧的三条硬结论

**结论一：压缩的伤害是"非线性加速"的，不是线性的。** Compaction Cliff 的 53% → 10%（1 轮到 5 轮）说明每轮压缩都在**乘性**损失，而不是加性。这与 billion-context 论文里给的传统压缩留存模型 `R(k) ≈ ρ^k`（ρ≈0.4–0.6，4 轮后 3–13%，8 轮后 0.7–1.7%）在形状上一致——两篇独立工作给出了同一个函数形式。**这是本报告里最强的跨来源互证**。【A（billion-context 论文自述模型）+ B（Compaction Cliff 实测）】

**结论二：能救回损失的只有"按类型/按结构"的策略，不是"更好的摘要 prompt"。** TypeCompact 相对"最强单次 LLM 压缩器"多保 2–4×，而所有"把摘要 prompt 写得更好"的路线（包括 Claude Code 的 9 段式模板）在五轮后都掉到 10%。**换句话说，摘要 prompt 的边际收益已经耗尽。** 【B】

**结论三：压缩是攻击面。** Compaction Laundering 的 87–100% vs 0% 对照是本年度最干净的实验设计之一：**同一攻击、同一模型，唯一变量是"消息是否保留角色类型"**。这对 DSH 插件设计的直接含义是：**任何要替换历史中段的插件，必须保证替换产物保留来源元数据**，否则它就是一个权限提升通道。【B】

### 5.2 论文层面的"空白"

- 上述所有论文的评测集互不相同：LLMLingua-2 用 MeetingBank/LongBench，RECOMP 用摘要+QA，ACON 用 AppWorld/OfficeBench，AgentFold 用 BrowseComp，Compaction Cliff 用自建的 agent 配置语料。**没有任何一篇在同一任务集上横向对比三种以上压缩范式**。【B】
- 所有"token 节省"指标口径不同：billed tokens（含缓存）、peak tokens、context tokens、prompt tokens。**跨论文比较这些数字在方法学上是无效的**。【A】
---

## 6. DSH 生态盘点

### 6.1 市场规模与分布

数据源：`npm pack dsh-plugin-catalog` 解出的 `plugins.json`（字段 `name` / `owner` / `url` / `description{en,zh}` / `npm` / `version` / `stars` / `downloads` / `capabilities[]` / `install`）。**级别 A**（我自己解析统计，与委派方给的数字有 1 条差异，见 §2 方法学）。

| 指标 | 数值 |
|---|---|
| 插件总数（`count` 字段与数组长度一致） | **6896** |
| 分类数 | 23 |
| `memory` 类 | **292**（占 4.2%） |
| 名称/描述命中 `compress｜compaction｜compact｜context window｜token budget｜压缩` | **252**（占 3.7%） |

分类分布（按条数降序，`▉` ≈ 40 条）：

```
ui       1326 ▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉
tools     903 ▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉
session   492 ▉▉▉▉▉▉▉▉▉▉▉▉
dev       441 ▉▉▉▉▉▉▉▉▉▉▉
workflow  391 ▉▉▉▉▉▉▉▉▉▉
model     371 ▉▉▉▉▉▉▉▉▉
usage     364 ▉▉▉▉▉▉▉▉▉
memory    292 ▉▉▉▉▉▉▉      ← 本调研目标区
theme     274 ▉▉▉▉▉▉▉
skill     256 ▉▉▉▉▉▉
notify    255 ▉▉▉▉▉▉
fun       210 ▉▉▉▉▉
remote    207 ▉▉▉▉▉
security  199 ▉▉▉▉▉
git       149 ▉▉▉▉
browser   146 ▉▉▉▉
vision    140 ▉▉▉
docs      109 ▉▉▉
market    104 ▉▉▉
voice      85 ▉▉
wsl        81 ▉▉
identity   60 ▉
agi        41 ▉
```

**读法**：`memory` 类 292 个插件、252 个自称涉及压缩——**这个赛道已经极度拥挤**。差异化不能靠"我也能压缩"，只能靠"我压缩得对/可验证/不破坏来源"。

### 6.1.1 `memory` 类 Top 21（按 stars）

> **重要口径警告**：`stars` 是**所属 GitHub 仓库**的星数，不是插件的。同一 owner 的多个插件共享同一份 stars，因此**跨插件比较 stars 是无效的**。榜单前两名（hindsight 53473、OpenViking 40754）本质上是两个大仓库的"外溢"，不代表这两个插件本身被 5 万人用过。【A】

| # | 插件 | npm 包 | stars | 一句话机制 | 级别 |
|---|---|---|---|---|---|
| 1 | hindsight#coding-agents | `@vectorize-io/hindsight-coding-agents` 0.8.2 | 53473 | 会学习的长期记忆：知识页 + 深度反思，按仓库隔离记忆银行 | B（仅描述） |
| 2 | OpenViking#examples/dsh-memory-plugin | `@openviking/dsh-memory-plugin` 0.5.29 | 40754 | pre-step 自动召回 + 画像注入；`viking://` URI 存储；读时压缩成带来源的 bullet | **A** |
| 3 | ReMe#dsh | `@agentscope-ai/reme-dsh-plugin` 0.1.2 | 3683 | 本地优先的自进化知识库，沉淀为 Markdown | B |
| 4 | memsearch#MemSearch | `@zilliz/memsearch-dsh` 0.1.7 | 2787 | 共享 Markdown 记忆 + 自动捕获 + 步骤前注入 | B |
| 5 | deja-vu#extensions/dsh | `dsh-deja` 0.23.1 | 1303 | 读取本机 **33 个**其它 agent 的会话文件，做跨工具记忆 | B |
| 6 | dsh-mnemon | `dsh-mnemon` 0.5.34 | 696 | 描述未取 | 未验证 |
| 7 | graph-memory | 无 npm 包 | 663 | 图记忆 | 未验证 |
| 8 | MisakaNet | `misakanet` 2.50.0 | 543 | 失败恢复记忆库：BM25 + 语义 RAG | B |
| 9 | flowix | 未解析到包 | 483 | 未取证 | 未验证 |
| 10 | dsh-memory-evolve | 未解析到包 | 438 | 自演化记忆 | 未验证 |
| 11 | dsh-meow-memory | `meow-memory` 0.31.1 | 277 | `node:sqlite` 七层存储（soul/user/project/fact/lesson/rules/topic），首条消息缓存友好注入，**压缩后重注入** | **A** |
| 12 | EduWork/dsh-memory | `@eduwork/dsh-memory` 0.2.0 | 233 | 未取证 | 未验证 |
| 13 | engramory | `dsh-engramory` 0.2.5 | 195 | 纯 markdown，一事实一文件，`MEMORY.md` 做索引 | B |
| 14 | mneme | `@modusensus/dsh-mneme` 0.9.4 | 178 | `autoDream` 空闲巩固 / 冲突冻结 | B |
| 15 | dsh-memory | `dsh-git-memory` 0.8.1 | 169 | 本地 Git 作为记忆存储 | B |
| 16 | billion-context-dsh | `billion-context-dsh` | 162 | ACP 分层压缩在 DSH 的适配入口（`dist/agent/dsh-native.js`） | **A** |
| 17 | dsh-auto-memory | `@a9i5k4/dsh-auto-memory` 3.3.17 | 148 | 固定边界注入 / 前缀缓存友好 / 水位感知（0.75）+ **handoff 四段笔记** | **A** |
| 18 | dsh-memento | `dsh-memento` 0.5.28 | 141 | 有界分层 / 审批门 / 可审计 `ctx.memory` 服务 + 零依赖 SQLite | **A** |
| 19 | dsh-fish-memory | 未解析到包 | 134 | 按会话分开 / 随时间变淡 / 证据分召回 | B |
| 20 | dsh-noema | `@zseven-w/dsh-noema` 0.1.0-rc.6 | 131 | 未取证 | 未验证 |
| 21 | StrataGate-AgentMemory | `stratagate-dsh` 0.3.23 | 127 | 六层时间衰减记忆 | B |

**读法**：Top 21 里 **6 个连 npm 包都解析不到**（`graph-memory` / `flowix` / `dsh-memory-evolve` / `dsh-fish-memory` 等），说明这个生态有大量"仓库型插件"（只发 GitHub，不进 npm），**可安装性与可审计性不成正比**。真正读了源码/包内文档的只有 6 个（OpenViking、meow-memory、billion-context-dsh、dsh-auto-memory、dsh-memento，加上压缩侧的 dsh-block-ptc / save-token）。【A】

### 6.2 "压缩类"头部：stars 与实际能力的错位

| 插件 | stars | 实际是什么 | 级别 |
|---|---|---|---|
| `dsh-context` | 3541 | **纯观测面板**：Context Insights 页、Context tab、Fleet tab、`/context` 命令。读宿主的 `contextPressure` / `contextBreakdown` 投影做可视化。**不做任何压缩** | A |
| `billion-context` | 2655 | **真正的分层增量压缩**（ACP）：`compress` / `decompress` / `search_context` / `acp_status` 四工具 + 增长门控 + 多代折叠 | A |
| `billion-context-dsh` | 162 | 同一体系在 DSH 上的适配包（`dist/agent/dsh-native.js` 为入口） | A |
| `dsh-block-ptc` | 104 | **模型自写块摘要**：`[block: <ids>]` 头 + `tools.block_compact({ids, content})` | A |
| `agent-context-editor` | 62 | npm 上 **404**，无法取证 | 未验证 |
| `dsh-plugin-save-token` | 34 | **工具输出结构化瘦身 + 落盘可恢复**（唯一给出完整 A/B RCT 报告的插件） | A |
| `GraphFlow` | 27 | 未在 npm 解析到包，未取证 | 未验证 |
| `dsh-conversation-navigator` | 23 | **纯浏览器端会话大纲面板**，零宿主行为、零依赖。**不做任何压缩** | A |

**结论**：压缩类 Top 8 里，**2 个（dsh-context、dsh-conversation-navigator，合计 3564★，占 Top 8 的 96%）根本不做压缩**。如果按"是否真的改变模型可见上下文"筛选，这个榜单会重排成 `billion-context` > `dsh-block-ptc` > `dsh-plugin-save-token`。【A】

### 6.3 九个头部插件的机制判定

判定维度：**注入时机 / 存储形态 / 是否前缀缓存友好 / 是否可审计**。

#### ① `billion-context@0.1.206`（A）

| 维度 | 事实 |
|---|---|
| 注入时机 | 增长门控（上下文下限 ∧ 自基线增长量 ∧ 最小可压区间，三者取交）。生产默认增长下限 **50K token**，有效下限 **22.5K**。nudge **不告知上下文填充率**（刻意设计：模型会锚定百分比并拒绝压缩），只给候选区间的真实尺寸（token 数、消息数、工具/文本构成）。压缩调用本身被"隐藏"（`hide-compress-calls`），事后不留痕 |
| 选择策略 | 模型自己选区间并写摘要；硬保护 = 压缩调用自身；软保护 = 最近工作区（~50K token）、最后一条用户消息、逐字的用户意图/约束/未决问题 |
| 存储形态 | 摘要块置于会话**头部**；原文以"停用区间"形式留在 append-only 日志中，不删除。多代：块本身可再被压缩成 tier-2 / tier-3，每代保留指向来源的引用 |
| 前缀缓存 | **友好**（设计核心）：只停用后缀区间，KV 前缀永不失效；`decompress` 的 `toFile` 模式可在不扰动缓存前缀的前提下恢复全保真内容 |
| 可审计 | 强：`acp_status` 给上下文用量与可压区间；每块保留来源引用；论文给出 `[V]`/`[A]`/`[P]` 三级证据标注 |

**反直觉点**：它把"压缩"从"一次性事件"改造成"**多代 LSM 树式的摘要谱系**"，并且**主动不告诉模型上下文有多满**。后者的理由是行为学的：模型看到 87% 会拒绝压缩，看到"这段有 40K token 且已无用"才会动手。

#### ② `dsh-block-ptc@0.4.0`（A）

| 维度 | 事实 |
|---|---|
| 注入时机 | 模型主动。`run_code` 的 `description` 必须以 `[block: <ids>] <goal>` 开头（preset 里有 guard 强制），块 id 隐式标记整条 assistant 消息及其工具结果 |
| 选择策略 | 模型按"工作单元"划线，`tools.block_compact({ids, content})` 替换"最早到最晚出现的完整区间"。摘要继承区间内**未被目标化的** id，因此可参与后续摘要（`A A B A C B --compact([A])--> S[B] C B`） |
| 存储形态 | 替换产物包在 `<block-summary>…</block-summary>` 中；**原始消息留在 append-only 会话日志里**，人类 transcript 完整、replay 确定性 |
| 前缀缓存 | **不承诺**。README 罕见地明说："Replacing history can also invalidate the cached suffix: **smaller context does not guarantee a higher cache-hit rate or a lower bill**"；其对比图标注为 "Mechanism illustration, **not an API benchmark**"，缓存命中是**建模值**而非实测 |
| 可审计 | 强：走宿主原生四个事件 `compaction/start` → `compaction/summary`（声明被替换区间的确切 token 价格）→ `user/message`（`surfaceOp: replace`，`compact-checkpoint` 来源）→ `compaction/end`（释放 durable lock）。**内置压缩引擎从不被调用，也不发生任何摘要模型调用**——摘要就是模型自己写的文本 |

**最值得抄的一点**：它把"能否替换"变成可证明的守卫——区间内含 system/developer 消息则**整段拒绝**（"no prefix is silently replaced"）；工具对未完成则请求排队等结果落地；失败只尝试一次关闭，**绝不留 durable lock**。

#### ③ `dsh-plugin-save-token@2.4.1`（A）

| 维度 | 事实 |
|---|---|
| 注入时机 | 每次模型请求入口（`llm/stream` 之前）改写超长工具输出；另有"压缩压力耦合"：每步边界检查最近真实上下文，超 **120k token**（10 分钟冷却）就以 `'pressure'` 调用宿主 `compaction.compactIfNeeded()` |
| 选择策略 | 五级：① **结构感知表格压缩**（≥70% 行同分隔符 → 首 60 行逐字 + 中段按 N 行步进采样并保留原行号 `L61: ...` + 末 40 行逐字）；② **TOON 式无损重编码**（同构 JSON 数组 → `prices[300]{model,input,output}:` + CSV 行，零信息损失）；③ **跨轮去重**（90 秒内字节相同的工具结果替换为存根）；④ **错误行保护**（省略区内保留最多 25 行匹配 `error/fatal/traceback/timeout`）；⑤ **永不更差双闸**（字节闸 ≤72% 且绝对省 ≥500B；token 闸必须严格下降） |
| 存储形态 | **压缩即落盘**（CCR）：替换前把原文写进宿主 `spillStore`，替换文本内嵌两条取回路径——`save_token_expand` 工具按 marker id 一步取回 + 文件定位符。**落盘失败则放弃压缩**（"reversibility is a hard precondition, not an option"） |
| 前缀缓存 | **友好且实测**：第二轮 A/B 中 provider 缓存命中率 90.0% → **90.7%**，最重的一集（1.86M token 的反复 dump/expand 循环）仍保持 **91.1%**。靠"cache-aware marker-replay 层"实现 |
| 可审计 | 强：全链路计量（拦截每个 `llm/stream`，分别记 billed input/cached/output/reasoning 与"从上下文里避免的 token"），历史消息扫描 `[save-token #id]` 标记累计节省（含多轮重放） |

**它给的实测数字（作者自报，A 级但仅 n=2）**：2026-08-29 首轮，GAIA / Terminal-Bench / SWE-bench-Verified，24/24 episodes，成功率 **100% vs 100%**，总 token **5.25M → 4.32M（−17.6%）**，单集节省中位数 **−56%**；2026-09-03 第二轮（v2.4.1），24/24，缓存命中 90.0%→90.7%，SWE 长上下文任务 sympy **−19.7%** / django **−18.0%**。**并自曝反模式**：早期版本对 35.5KB 的 LiteLLM 价格表做盲式首尾截断，子 agent 找不到中段行而反复重查——"结构感知策略就是从这个失败里长出来的"。

#### ④ `dsh-memento@0.5.28`（A）

| 维度 | 事实 |
|---|---|
| 注入时机 | **每会话首次 prompt 装配时注入一次，之后冻结**（"frozen once per session at first prompt assembly and never changes mid-session"） |
| 选择策略 | 两轨（`user` 事实 / `agent` 环境与约定）× 两层（`user-global` / `workspace`）× per-`agentPreset` 隔离 |
| 存储形态 | `node:sqlite`（WAL、`0600`、`$DSH_HOME/dsh-memento/memory.db`）；硬字符预算（默认 user 2000 / agent 4000），**满则结构化报错，绝不截断、绝不自动压缩** |
| 前缀缓存 | **友好**（冻结快照文本恒定） |
| 可审计 | **本调研所见最强**：写审批闸在 service 层强制（`writePolicy: ask/auto/off` 对模型不可见），`replace`/`remove`/`consolidate` 的审批载荷携带被改条目的全文，**被拒绝的写也落 `*-denied` 审计行**；"Model-visible ⟺ logged"——注入快照逐字落 `system/message`；并**主动承认审计缺口**：本宿主不认识 `memory/*` 事件类型，追加未知类型会让会话不可加载，所以改走 `approval/asked` + `approval/decided` + 插件自建表 |

**它定义了 DSH 记忆插件该有的"接缝"**：`ctx.memory` 服务 + 本地 provider + `memory` 工具 + 冻结快照注入，**而不是又一个记忆仓库**。

#### ⑤ `meow-memory@0.31.1`（A）

| 维度 | 事实 |
|---|---|
| 注入时机 | **首轮**：第一条真实用户消息之前注入 soul / user / 设计原则 / 记忆导引（作为独立 plugin snapshot 消息放在真实 user 消息前，**不改写用户 prompt**，首轮**不跑**关键词命中）；**第二轮起**：每条真实用户消息检索 fact/lesson/rules/topic（全局 + 当前 project 锚定），top-2 命中注入 |
| 选择策略 | 七层：`soul` / `user` / `project`（含 subcategory）/ `fact` / `lesson` / `topic`（带目标句）/ `rules`。命中基于**条目关键词**而非全文 |
| 存储形态 | 每层一张 `node:sqlite` 表，UUID 带时间前缀（id 顺序即创建顺序） |
| 前缀缓存 | **友好**：静态 `meow-memory:guide` section 在 system prompt 中注册一次，文本恒定，"破坏不了 provider 的 KV 缓存"；每消息命中只追加在尾部 |
| 可审计 | 中：写入自动去重合并、按 `updated_at` 展示时间戳、全局标记区分 |

**独有机制——"压缩后重注入"**：会话压缩后，下一轮自动重新注入长期记忆快照 + 本会话查阅过的项目全景 + 本会话写入过的记忆原文，"AI 不会因为压缩突然失忆"。**这是对"压缩会摧毁注入型记忆"这个真实缺陷的直接补丁**，也是唯一在 README 里明确处理该问题的插件。【A】

**巩固机制**：按窗口 dream——窗口空闲 ≥3 小时允许整理，由该窗口自己的主 agent 分三轮处理（原子记忆 / topic / 项目总结），**峰时抑制**（默认北京时间 09:00–12:00、14:00–18:00，对齐 API 峰谷电价）；也可 `/dream` 手动触发。另有反思：单次任务内连续 ≥7 个工具 step 后询问模型是否有值得记忆的内容。

#### ⑥ `@a9i5k4/dsh-auto-memory@3.3.17`（A，但营销密度高）

| 维度 | 事实 |
|---|---|
| 注入时机 | **"固定边界注入，前缀缓存友好"**；回忆由宿主侧在"模型开口之前"触发，不依赖模型主动检索。上下文水位感知：handoff 阈值 **0.75**，"just below the host's 0.80 auto-compaction line" |
| 选择策略 | 三层引擎（用户规则 → 项目笔记 → 日志）+ 三层降序检索（自称 OpenViking-style）+ 激活资格判定（"判断'该不该回忆'，而不是'有多相似'"） |
| 存储形态 | 磁盘 Markdown：`handoff/handoff-*.md`（四段式）、`handoff/PLAN.md`（白板）、记忆文件内嵌锚点 `<!-- memory:mem_<32hex> -->`（**身份寻址，非位置寻址**） |
| 前缀缓存 | 宣称友好（固定边界注入）；**未给出缓存命中率实测** |
| 可审计 | 强：每次激活决策带完整证据链，可在 Recall review 页逐条打分；`appendAnchoredRecord()` 先解析现有文件，任何非干净状态**fail closed**，正文出现保留语法则**当场带行号拒绝** |

**它代表的路线是"handoff 而非压缩"**：窗口满时不烧掉整本书写一行书评，而是写**四段式交接笔记**——任务状态 / 目标 / 试过什么以及为什么失败 / 进度与下一步——关窗开新窗，全文归档可检索（`memory_search`）。README 明确对标"GPT-6 Astra 在 2026 年 9 月把 Context Management 作为实验性旗舰特性"。**注意：这条对标是营销引用，我未能核实 Astra 的行为，级别 C。** 四段式的**工程约束**倒是实的：四个标题必须**逐字匹配**（错一个就破坏下游加权截断与注入侧解析器），每段有最小长度，不合格直接拒绝。

#### ⑦ `@openviking/dsh-memory-plugin@0.5.29`（A）—— 详见 §4.1、§4.2

一句话：**检索型记忆，不是对话压缩器**。`viking://` URI 命名空间 + 六类召回 + 读时压缩（≤6 条带来源 bullet）+ 编辑距离修正幻觉 URI。**刻意不走 system prompt**（因为 `complete: true` 的 persona 会静默清空其它 section），改由 `agent/pre-step` 以带来源的用户消息注入。

#### ⑧ `dsh-context@0.76.0`（A）—— 观测，不压缩

提供 Context Insights 页、Context tab（Context Stats / Token Stats / Timing Stats / Current Context / Context Trend / **Context Browser** / **Context Events** / File Activity / Command Executions）、Fleet tab、`/context` 命令、右侧 Context panel。**它读宿主官方的 `contextPressure` / `contextBreakdown` 投影**，"所以数字永远和输入框的上下文环一致"。Context Trend 里"compactions and prunes are pinned to the bar where they happened"——**它是唯一能把压缩事件可视化的工具**。

**对本项目的价值**：如果要做基准实验，**它的 Context Events + Context Browser 就是现成的测量探针**。

#### ⑨ `dsh-conversation-navigator@0.2.11`（A）—— 纯前端

按轮折叠的对话大纲面板，点击跳转、滚动高亮、三态形态、可拖动可缩放、`localStorage` 持久化。**零宿主行为、零 npm 依赖、零构建**。唯一与压缩相关的是它把"压缩点"作为一种事件类型渲染成中性灰徽标。

### 6.4 DSH 生态的四条判断

**(1) 宿主已提供压缩基元，插件不该重造。** `dsh-block-ptc` 直接复用 `@deepseek-ai/dsh-compaction` 与 `@deepseek-ai/dsh-session` 的四个事件，并明说"插件不能定义新事件类型，否则会话日志不可读"。`dsh-plugin-save-token` 直接调 `compaction.compactIfNeeded()`。**新插件正确的姿势是"在宿主压缩之外加一层可逆的、结构感知的预处理"，而不是替换宿主引擎。**【A】

**(2) 前缀缓存友好性有四种可落地做法**：冻结快照（memento）、静态 guide section（meow）、固定边界注入（auto-memory）、只停用后缀区间（billion-context）。**四种都成立，但只有 billion-context 与 save-token 给出了实测缓存命中率。**【A】

**(3) 记忆与压缩的耦合点被普遍忽略，只有一个插件处理了。** 压缩会摧毁注入型记忆（因为注入发生在压缩之前、内容被折叠进摘要后语义失真）。`meow-memory` 的"压缩后重注入"是唯一显式补丁。**这是本项目最值得做的一个空白。**【A】

**(4) 生态里"可审计"正在成为卖点**，`dsh-memento`（审批闸 + 审计表 + 主动声明缺口）与 `@a9i5k4/dsh-auto-memory`（激活证据链 + fail-closed 写入）是标杆。但**没有任何插件提供"压缩质量"的可审计性**——即"这次压缩丢了什么、丢得对不对"。**这是第二个空白。**【A】
---

### 6.5 DSH 压缩契约（A 级，源码直读）

> **证据说明**：本节所有事实来自 `read` 工具**直接读取 `app.asar` 归档内文件**——`D:\deepseek-h\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-compaction\lib\index.js`（175 行）与 `...\dsh-compaction-basic\lib\index.js`（1027 行）。asar 是单文件归档，`find` / `glob` / `grep` / Node 的 `fs` 都进不去（实测 `fs.readFileSync` 报 `ENOENT`），但 `read` 工具可以按路径直读。**因此本节的级别是 A，不是 B。** 引用格式为 `文件:行号`。

**这一节是本报告对"设计一个 DSH 插件"最有直接价值的部分**：它把宿主的压缩契约从"插件侧猜测"变成了"可依赖的接口事实"。

#### 6.5.1 分层：seam 与实现

DSH 把压缩拆成**两个包**，职责严格分离：

| 包 | 角色 | 关键事实 |
|---|---|---|
| `@deepseek-ai/dsh-compaction` | **只定义 seam，不做压缩** | `var CompactionEngine = class extends Service { constructor(ctx) { super(ctx, "compaction"); } }`（`dsh-compaction/lib/index.js:169-173`）——服务名字符串就是 `"compaction"`。文档注释原文：**"Load one implementation per context as `ctx.compaction`."**（同文件 `:167`） |
| `@deepseek-ai/dsh-compaction-basic` | 默认实现 | `var BasicCompactionEngine = class extends CompactionEngine`（`dsh-compaction-basic/lib/index.js:800`），`static inject = ["llm","tokenMeter","sessions"]`（`:801-805`） |

**"每个 context 只能有一个实现"是本节最重要的一条约束**：因为 `ctx.compaction` 是 cordis 的单实例 Service，第三方插件**无法"叠加"第二个压缩引擎**，只能二选一：替换实现，或在 policy 层（事件 / 工具 / 预处理）做增强。这从机制上解释了为什么生态里的压缩插件都走"预处理 + 复用宿主事件"路线，而不是"再加一个压缩器"。

seam 包的公开导出（`dsh-compaction/lib/index.js:175`）：`CompactionEngine`、`CompactionId`、`ManualCompactionError`、`compactCheckpointSource`、`isCompactCheckpointSource`、`toolPairingBalancedAfter`、`toolPairingBalancedBefore`。

三个操作在**类型层**声明（运行时基类只做服务注册）：

| 操作 | 语义 | 实现位置 |
|---|---|---|
| `compactIfNeeded(agent, trigger, signal)` | 按阈值/溢出决定是否压；不需要时返回 `null` | `dsh-compaction-basic/lib/index.js:914` |
| `compactNow(agent, signal, sourceCommandId)` | 手动强制压一次（可低于阈值），要求 agent 空闲 | `:985` |
| `compactRegion(start, end, agent, signal)` | 压缩一个**闭区间**的表面节点序列 | `:971` |

#### 6.5.2 配置与预算公式（源码常量，不再是推断）

| 配置键 | 默认值 | 源码位置 |
|---|---|---|
| `thresholdRatio` | **`0.8`**（`const DEFAULT_THRESHOLD_RATIO = .8`） | `:15` |
| `retainRatio` | **`0.16`**（`const DEFAULT_RETAIN_RATIO = .16`） | `:17` |
| `headroomTokens` | `config.headroomTokens ?? 65536` | `:63` |
| `maxTokens` | `config.maxTokens ?? headroomTokens` | `:64` |
| `compactionRetries` | `?? 1` | `:82` |
| `maxOverflowRetries` | `?? 1` | `:83` |
| `auto` | `?? true` | `:85` |

**预算不是简单的"窗口 × 0.8"**，而是两级相减（`resolveCompactSpec`，`:124-130`）：

```
messageBudgetTokens  = contextWindow - reservedCompletionTokens   // :128
pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens // :130
```

源码注释（`:113-118`）原文：**"Pressure is capped by both the window fraction and the capacity remaining after the routed output reservation plus compaction headroom. Retention scales the message budget before headroom is deducted."**

这条对插件设计的含义很具体：**"窗口占用 80%"是一个会随 `reservedCompletionTokens`（每请求预留输出）和 `headroomTokens`（默认 64K）浮动的动态阈值**，不是一个固定比例。第三方插件若按"窗口 × 0.75"自行计算水位（`@a9i5k4/dsh-auto-memory` 就宣称把水位设在 0.75），在 1M 窗口 + 大 headroom 的模型上会与宿主实际阈值产生系统性偏差。【A】

#### 6.5.3 唯一的扩展钩子：`summarize`

`BasicCompactionEngine.summarize(input, agent, signal)`（`:899-903`）是**唯一的子类化钩子**，源码注释原文（`:889-898`）：

> "Summarize the replayed conversation region through a direct one-shot `ctx.llm.stream()` call whose prefix reuses the conversation's own system prompt, tools, and messages so the provider's KV cache is not invalidated. **Override this sole hook for a template or remote summarizer.**"

`input` 由 `buildSummarizationInput(session, shadowedSeqs)` 构造（`:695-704`），形状是 `{ tools?, messages: [systemMessage?, ...regionMessages] }`。其文档注释（`:683-694`）明确说明设计意图：

> "Reconstruct the last routed request's **cacheable prefix** for the shadowed region: the system prompt held by the `system/message` at surface node 0, the header's tool schemas, then the region's own derived messages in surface order. The summarizer appends only the compaction instruction after this, **so the call is a genuine prefix of the conversation and reuses the provider's KV cache.**"

**这直接印证了本报告 §3.2 的"前缀缓存三派"结论**，而且给出了第四种更精细的做法：**压缩调用本身是对话的一个真前缀**，因此压缩这一次调用的 input 几乎全命中缓存——被牺牲的只是压缩**之后**的缓存。也就是说，DSH 的压缩成本远低于"另起一个总结 prompt"的方案。【A】

返回结构不是纯字符串：文档说返回 "safe text summary blocks and the exact auxiliary call envelope and output"（`:897`），随后由 `frameSummary(...)` 包成 checkpoint 消息（`:597`）。

#### 6.5.4 成功路径的事件序列（顺序有约束）

`compactSurfaceRegion`（`:450-522`）内，一次成功压缩严格按此顺序写 4 个事件：

| # | 事件 | 作用 | 源码 |
|---|---|---|---|
| 1 | `compaction/start` | **取锁**（唯一的 durable lock）。注释：`compaction/start` 与空闲校验"同步相邻"，因此未匹配的 start 标记就是锁 | `:469` |
| 2 | `compaction/summary` | **仅日志**，不改表面 | `:634-649` |
| 3 | `user/message` | **唯一一次表面变更**：`{ surfaceOp: { op: "replace", startSeq, endSeq }, sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs] }` | `:650-661` |
| 4 | `compaction/end` | 释放锁；失败时带 `error: errorChain(error)` | `:484`、`:495-498` |

失败路径的关键不变量（`:487-507`）：**任何失败都只做一次 `compaction/end` 尝试；若连关闭都失败，未匹配的 `compaction/start` 会保持可检测**——即系统宁可留下"卡住的锁"也不静默吞掉状态。被遮蔽的事件仍留在原始日志里（append-only），`deriveMessages()` 把摘要渲染成 user 消息。

**payload 真实字段**（很多第三方插件猜错了）：

| 事件 | 字段 | 源码 |
|---|---|---|
| `compaction/start` / `compaction/end` | `{ compactionId, sourceCommandId?, turn }`（end 多一个 `error?`） | `:464-468`、`:495-498` |
| `compaction/summary` | `{ compactionId, sourceCommandId?, summary, rawOutput?, llmStreamCall?, shadowedRange: { start, end }, shadowedSeqs, shadowedTokenCount, provider, model, maxTokens?, usage? }` | `:634-649` |

**注意：没有 `blockId`，也没有顶层 `startSeq` / `endSeq`**（区间在 `shadowedRange` 里，而 `startSeq`/`endSeq` 是 `surfaceOp` 的字段，不是 payload 的字段）。第三方插件若按自己猜的字段名读写，会静默拿不到值。

#### 6.5.5 正确性不变量（可直接当测试用例）

| 不变量 | 规则 | 源码原文 / 位置 |
|---|---|---|
| **不允许"压缩后更大"** | 摘要消息的估算 token 若 ≥ 被遮蔽区的 routed token，直接抛错 | `summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`（`:601`） |
| **不跨未闭合的工具对** | 切点前/后都必须 `toolPairingBalanced`；判定是 `assistant/message` 里 `content.filter(b => b.type === "tool-call").length` 计 **+N**、`tool/result` 计 **−1**，计数为 0 才算平衡 | `eventDelta`（`:21-27`）、`toolPairingBalancedBefore/After`（`dsh-compaction/lib/index.js:80-93`）、校验点 `:557-558` |
| **区间必须当前存在且有序** | start/end 不在表面、或 start 在 end 之后 → 抛错 | `:550-566` |
| **稳定性校验（5 条错误）** | 摘要期间表面/区间被改动则拒绝提交 | ① `compaction: selected surface changed before summarization began`（`:571`）② `compaction: session surface changed during summarization`（`:610`）③ `compaction: the selected span is no longer a valid replacement target`（`:622`）④ `compaction: the selected span changed during summarization`（`:624`）⑤ `compaction: the selected span was rewritten during summarization`（`:625`） |
| **两种稳定性等级** | 自动压力压缩要求**整个表面**不变（`stability: "whole-surface"`，`:974`）；手动压缩只要求**选中区间**稳定（`"selected-span"`，`:996`）——区间外新增节点不会作废手动压缩结果 | `:470`、`:609-626` |
| **单飞（无并发压缩）** | 未匹配的 `compaction/start` 即视为锁被占用 | `compaction already in progress; the session compaction lock is already active`（`:536-539`）；`assertNoActiveCompaction`（`:545-548`） |
| **自动压缩必须在 turn 内** | 手动压缩要求无未闭合 turn；自动压缩要求**有**未闭合 turn | `manual compaction: the session already has an open turn`（`:457`）、`compactRegion: no open turn — automatic compaction events must be enclosed in a turn`（`:460`） |
| **摘要失败可重试，但重试由 hook 决定** | `for (;;)` 循环：失败 → 稳定性校验 → `ctx.waterfall("compaction/summary-error", …)`；`recover` 返回 false 才抛错，否则重新 `prepareCompaction` 再来一次 | `:584-595`、`:1017-1022` |

**最后一条值得单独警示**：`summarizeCompaction` 是一个 `for (;;)` 无限循环，唯一的退出条件（除成功外）是 `recover` 钩子返回 false。**任何实现 `compaction/summary-error` 钩子并恒返回 `true` 的插件，都会造成压缩死循环。** 这是宿主契约里一个真实的可用性陷阱。【A】

#### 6.5.6 自动触发的三条路径

`_registerAutomaticCompaction()`（`:834-888`）只在 `config.auto` 为真时注册（`:827`）：

| 宿主事件 | 行为 | 源码 |
|---|---|---|
| `agent/pre-step` | `await this.compactIfNeeded(agent, "pressure", signal)`；**异常被捕获并降级为 warning，"continuing the turn"**——压缩失败不会中断回合 | `:839-852` |
| `agent/request-error` | 仅当 `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE` 时以 `"context-overflow"` 触发；成功则返回 `{ kind: "retry" }`；超过 `maxOverflowRetries` 则 `next()` 保留原始错误 | `:861-887` |
| `agent/status` | `status === "idle"` 时清空该 agent 的 `overflowRetries` | `:853-855` |
| `session/event` | 收到 `assistant/message` 时清空该 session 的 overflow 重试计数 | `:856-860` |

**"先剪枝后摘要"是宿主自己的既有策略，不是插件发明**。两条路径都先调 `ctx.get("toolResultPruner")?.pruneSession(...)` 再测量：

- 溢出路径（`:926-934`）：先剪枝 → 重测 → 用 `retainTokens = 0` 选区间（**溢出时绕过保留尾部策略**，只要能救回来就行）。
- 压力路径（`:942-946`）：先判阈值 → 超了才剪枝 → **重测，若剪枝后已低于阈值就直接 `return null`（不做摘要）**。

这条直接支撑本报告 §8.5 的"第一优先级做工具输出结构化瘦身"：**宿主自己在付一次摘要的钱之前，也是先尝试零成本的剪枝**。插件在这一层做增强，与宿主策略是同向的，而不是竞争关系。

压力路径还有一层重试（`:948-960`）：`for (attempt = 0; attempt <= compactionRetries; attempt++)`，默认 `compactionRetries = 1` 即**最多压 2 次**；仍不达标则抛 `compaction still above threshold after ${n} compaction attempts (...)`。

#### 6.5.7 手动压缩的错误码（比插件作者通常以为的多）

`ManualCompactionError(code, message, options)`（`dsh-compaction/lib/index.js:146-159`）的 `code` 是**稳定分类**，共 6 个：

| code | 触发条件 | 源码 |
|---|---|---|
| `busy` | 已有未匹配 start（锁被占）、已有未闭合 turn、或 agent 非空闲 | `:538`、`:457`、`:1009` |
| `cancelled` | 操作被取消（优先于其它分类） | `:1003` |
| `commit` | 提交阶段失败（含关闭事件自身失败） | `:525` |
| `changed` | 摘要期间历史被改动（`SurfaceChangedError`） | `:526` |
| `summary` | 无法产出更小的摘要 | `:527` |
| `persistence` | 落盘检查点失败（仅手动路径有 `flush`） | `:518` |

`compactNow` 还通过 `agent.runMaintenance(...)` 预留下一回合的准入（`:988`），并用 `AbortSignal.any([agentSignal, signal])` 合并取消信号（`:989`）。

#### 6.5.8 与 Compaction Laundering 的呼应：DSH 没有拍平

`commitCompactionBody` 里，checkpoint 是**带类型化 source 的 user 消息**：

```js
const checkpointMessage = createUserMessage({
  content: frameSummary(summaryResult.summary),
  source: compactCheckpointSource(compactionId, sourceCommandId)   // :596-599
});
```

而 `compactCheckpointSource` 产生的是 `{ kind: "compact-checkpoint", compactionId, sourceCommandId? }`（`dsh-compaction/lib/index.js:109`、`:116-122`），且 `user/message` 事件额外携带 `sourceEventSeqs: [start, summary, ...shadowedSeqs]`（`:656-660`）。

**这正是 §5 中 Compaction Laundering 那篇论文所要求的防线**：论文指出"把类型化对话拍平成一个字符串"会让伪造指令以 87–100% 概率洗白，而"保留消息角色类型"的 harness 是 0%。**DSH 的 checkpoint 保留了 `source` 与 `sourceEventSeqs`，属于角色类型化那一类——因此在这一点上它不是易感架构。** 反过来说：**任何绕过 `compactCheckpointSource`、自己往 `user/message` 里塞纯文本摘要的插件，都会把 DSH 从"0% 组"拖进"87–100% 组"**。这是对第三方压缩插件最硬的一条安全约束。【A（DSH 源码）+ B（论文结论）】

#### 6.5.9 组合层面的真实门槛

这一条解释了"为什么在 DSH 里做压缩插件这么别扭"，也解释了 `billion-context` 为什么要绕那么大一圈：

- Web profile 里，**host 平面的 `compaction-basic` 是禁用状态（`auto: false`）**，真正运行的实例在 **agent preset 内**。
- preset 里的行**按 id 无法被 bundle patch 层寻址**，所以第三方无法简单地"替换宿主压缩引擎"。
- 实际可行的做法只有：加一个自己的 entry（如 `bili-compaction-gate`），再给 `preset-standard` / `ptc` / `minimal` / `cordis` 各加一条 `inject: [<自己的 policy 服务>]`。

**对插件设计的直接含义**：如果要增强压缩，最省事的落点是**事件层（`agent/pre-step` 前后）与工具层（预处理 + 落盘恢复）**，而不是试图接管 `ctx.compaction`。前者不需要动 preset，后者需要动。这同时解释了 §6.3 里那些插件为什么几乎全部选择了"注入 / 预处理 / 观测"三类形态。【A（源码 + 组合层事实）+ B（billion-context 的绕行方案来自其 CONFIGURATION.md）】

#### 6.5.10 一句话总结这一节

> **DSH 的压缩契约是"单实例 seam + 唯一 summarize 钩子 + 四事件事务 + 强不变量"。它对第三方最友好的位置是 `summarize` 钩子与 `agent/pre-step` 事件；最危险的位置是 `compaction/summary-error` 的 `recover`（可致死循环）与 `user/message` 的 source 元数据（丢了就是权限提升通道）。**

---

### 6.6 运行时开销：被忽略的第五个维度

前面几节比较的是"压缩率 / 可逆性 / 前缀缓存"，都是**省了多少**。实际使用中还有一个同等重要的维度：**慢了多少**。它几乎从不出现在插件的 README 里，却直接决定用户是否愿意长期开着。

**(1) 用户实测：下载量第一的插件"极大加长任务时间"。**【C（用户口述，本机）】
本机用户对 `billion-context` 的直接反馈是"现有下载量最多的 dsh 压缩插件会极大加长任务时间"。它确实是生态里下载量第一：**1,784,720 次**，约为第二名 `dsh-context`（149,484，纯观测面板）的 **12 倍**。【A（`dsh-plugin-catalog` 的 `plugins.json` 统计）】

**(2) 机制取证：它的压缩在进程外，走本地 HTTP 代理。**【A（`billion-context@0.1.206` 的 `dist/agent/dsh-native.js` 源码直读，2,389,936 字节单行 minified）】
- `ctx.on` 只注册 **两个**事件：`session/created` 与 `session/event`（后者只处理 `session/title` 上报）；**没有** `agent/pre-step`、`agent/turn-stopping`、`agent/request`；`ctx.get` 零次。
- `llm.stream` 出现 2 次，但都在 `ctx.inject(["llm"], ...)` 里做**归属 / fork 采纳**（`maybeForkAdoptBeforeSend`、`attributionOf`），不是压缩本身。
- 真正的压缩在**本地 HTTP 代理**里：插件维护 `register.base`、路由 `/bili/origin`、`/__bili` 前缀 relay、`adminRelayEnabled`。模型调用被改道经代理，折叠在代理侧完成。
- 配套的 `dist/agent/dsh-compaction-gate.js`（2,589 字节）只做一件事：`internal/config` 钩子里，当 `globalThis.__BILI_DSH_COMPACTION_VERDICT__ === "active"` 时把宿主 `@deepseek-ai/dsh-compaction-basic` 与 `@deepseek-ai/dsh-command-compact` 两行改成 `disabled: true`。与延迟无关。

→ **每次模型调用多一次本地 HTTP 往返；折叠本身再叠加模型调用。** 这是"拖慢"的合理机制来源。注意它换来的是真正的分层增量压缩（见 §6.3），不是纯浪费——但**代价被计入了每一轮**。

**(3) 通用规律：压缩的成本位置决定它是否可长期开启。**

| 成本位置 | 典型做法 | 对每轮延迟的影响 | 例子 |
|---|---|---|---|
| 请求路径上（同步） | 改 `agent/request`、代理改道、串行钩子里 `await` 模型 | **每轮 +1 跳 / +1 次模型往返** | `billion-context` 的代理；本插件 v0.1.1 的 `turn-stopping` |
| 请求路径上（异步，不阻塞） | 后台抽取、`void run()` | 近似 0（只占 CPU/网络，不占 turn） | 本插件 v0.1.2 起的 `extractMode: background` |
| 请求路径外（工具层） | `tools/post-execute` 改写结果、落盘 | 只在工具调用那一轮，且是本地 IO | 本插件的能力 A |
| 纯观测 | 只读 `session/event`，不写 | 0 | `dsh-context` |

**(4) 一条可操作的设计规则**：**串行事件（`agent/turn-stopping`、`tools/pre-execute`）里绝不 `await` 模型调用。** 宿主会等监听器 resolve 才继续，等待时间直接叠加到用户感知的任务时长上。要抽取就丢后台，并且**必须自建 `AbortController`**——`payload.signal` 在本轮结束时就 abort，直接交给后台任务会让它刚启动就被取消（看起来"没报错"，实际一条都没写进去）。这条规则在本项目的 `dsh-context-fold` v0.1.2 里落地并有测试覆盖（假 LLM 延迟 120ms，断言监听器 60ms 内返回）。【A（本机实现 + 测试）】

---

## 7. 横向对比矩阵

> 把 agent、记忆系统、学术方法放进同一张表。**维度定义**：
> - **压缩触发**：什么时候动手（阈值 / 每步 / 模型主动 / 无）
> - **粒度**：以什么为单位选择（消息区间 / 单条 observation / 工具输出 / 代码行 / token / 子任务 / 整段历史）
> - **可逆性**：原文能否在**不离开模型上下文**的前提下回来
> - **跨会话**：状态是否跨会话存活
> - **检索**：靠什么把东西找回来（无 / 关键词 / 向量 / 图 / URI / 文件系统）
> - **成本**：每次压缩的边际成本（无 LLM = 低；一次摘要调用 = 中；一次完整上下文摘要 = 高）
> - **前缀缓存友好**：是否会打断 KV 缓存后缀

### 7.1 Agent / Harness

| 系统 | 压缩触发 | 粒度 | 可逆性 | 跨会话 | 检索 | 成本 | 前缀缓存 | 级别 |
|---|---|---|---|---|---|---|---|---|
| Claude Code | 92% 窗口；`effCtx-13K` 的 Tier 4 | 消息区间（中段） | ✗ | ✗ | 仅人工翻日志 | 高（fork 子 agent 读全上下文） | ✗（结果替换历史） | C |
| Codex CLI | `model_auto_compact_token_limit`，可按"压缩后增量"计 | 消息区间（保 `SUMMARY_PREFIX`） | ✗ | ✗ | 无 | 中（输入上限 20K） | ✓（设计目标） | B |
| OpenHands | soft / **hard** 两级 + `max_size` | 事件流区间 | ✗ | ✗ | 无 | 中 | ✗ | B |
| Cline | 主动调用 / auto-compact | 整段历史（不含当前 assistant） | ✗ | ✗ | 无 | 中 | ✗ | B |
| Roo Code | ~90%（旧版静默滑窗） | 整段历史 → 单条 user 摘要 | ✗（UI 可展开，模型不可） | ✗ | 无 | 中 | ✗ | B |
| SWE-agent | **每步无条件** | 单条 observation（`LastNObservations`）/ 文件窗口 | ✗ | ✗ | 无 | **低（无 LLM）** | ✓（只改尾部） | B |
| Aider | 每次请求重建 | **代码符号**（非对话） | ✓（可重建） | ✗ | PageRank + 聊天提及做 personalization | 低（tree-sitter + 图排序） | ✓（独立段） | B |
| Gemini CLI | 0.5 窗口 | 整段历史 | ✗ | ✗ | 无 | 中 | ✗ | B |
| Qwen Code | 三级阶梯 warn/auto/**hard-rescue** | 整段历史 | ✗ | ✗ | 无 | 中（可指定专用小模型） | ✗ | B |
| OpenCode | prune 后 compact；`usable()=ctx-maxOutput` | 工具输出（2K 字符）+ 整段 | ✗ | ✗ | 无 | 低（prune）+ 中（compact） | 部分 | B |
| Goose | `GOOSE_CONTEXT_STRATEGY` | 整段历史（有损改写） | ✗ | ✗ | 无 | 中 | ✗ | B |
| Hermes Agent | 4 阶段，迭代 | 工具结果 → 中段 → 尾部预算 | 部分 | ✗ | 无 | 低（Phase 1 无 LLM）+ 中 | 部分（头尾保护） | B |
| Letta / MemGPT | 不压缩；靠 interrupt | core 块 / archival 条目 | ✓（原文长存） | ✓ | 向量（archival）+ 工具 | 低（无摘要调用） | ✓（core 在头部） | B |
| mini-swe-agent | **无** | — | — | ✗ | — | 0 | ✓ | B |
| **billion-context** | 三闸取交，增长门控（默认 50K / 有效 22.5K） | **任意消息区间**，多代 | **✓**（`decompress`，含 `toFile` 全保真模式） | ✗（会话内） | `search_context` 关键词（摘要 + 可见消息） | 中（模型自己写摘要，中位输出 185 token） | **✓**（只停用后缀） | A |
| **dsh-block-ptc** | 模型主动 | 块区间（`[block: ids]` 标记的完整区间） | 部分（日志保留，模型侧不可逆） | ✗ | 无（但日志可读） | 中 | ✗（自认会失效） | A |
| **dsh-plugin-save-token** | 每次请求入口 + 120K 压力触发 | **工具输出**（表格/JSON/日志） | **✓ 强**（落盘 + `save_token_expand` 一步取回） | ✗ | marker id / 文件定位符 | 低（无 LLM） | **✓ 实测 90.7%** | A |
| **dsh 原生压缩** | 动态预算：`(window − 预留输出) − 65536` | 区间（强制工具对平衡） | ✗ | ✗ | 无（原文留 append-only 日志） | 中 | 压缩调用命中缓存、其后失效 | **A** |

### 7.2 记忆系统

| 系统 | 压缩触发 | 粒度 | 可逆性 | 跨会话 | 检索 | 成本 | 前缀缓存 | 级别 |
|---|---|---|---|---|---|---|---|---|
| MemGPT / Letta | 不压缩；interrupt 强制整理 | core 块 / 消息 / archival 条目 | ✓ | ✓ | 向量 + 工具调用 | 低 | ✓ | B |
| Mem0 | 每轮后抽取 | **事实**（自然语言三元组化） | ✓（原文可另存） | ✓ | 向量（+ 图） | 中（每轮一次 LLM） | ✓（注入在头部/尾部） | B |
| Zep / Graphiti | 每轮后异步 | **实体-关系边**（双时间轴） | ✓（`invalid_at` 而非删） | ✓ | 图遍历 + 向量 | 中高（抽取 + 消解） | ✓ | B |
| A-MEM | 新记忆到来即触发演化 | **note**（Zettelkasten 卡） | ✓ | ✓ | 向量 + 链接图 | 中（每条都要 LLM 建卡+链接） | ✓ | B |
| Cognee | 文档级 ECL 流水线 | **文档 / 图谱节点** | ✓ | ✓ | 图 + 向量并跑 | 高（离线批处理） | ✓ | B |
| LangMem | 当轮（Hot）/ 延迟（Background） | **记忆条目**（namespace 分区） | ✓ | ✓ | 语义 + namespace | 中（Background 可摊销） | ✓ | B |
| OpenViking | 写入按 `commitTokenThreshold`（20K）；**读时压缩** | 检索碎片 → ≤6 条 bullet | ✓（`viking://` 原文可 `read`） | ✓（peer 作用域） | `search` `mode:"context"` 六类配额 + `grep`/`glob`/`tree` | 中（每次召回一次摘要 LLM） | ✓（pre-step 注入在尾部） | A |
| meow-memory | 首轮 + 每消息 + 空闲 ≥3h dream | **七层条目**（关键词命中 top-2） | ✓（SQLite 原文） | ✓ | 关键词（非全文） | 低（关键词）；dream 中 | ✓（静态 guide section） | A |
| dsh-memento | 会话首装配一次（冻结） | 条目（两轨两层） | ✓ | ✓ | 工具 + 冻结快照 | 低 | ✓ | A |
| @a9i5k4/auto-memory | 0.75 水位 handoff | 四段式交接笔记 | ✓（归档 + `memory_search`） | ✓ | 语义 + 归档检索 | 中（每轮子 agent 评估） | ✓（固定边界） | A |

### 7.3 学术方法

| 方法 | 压缩触发 | 粒度 | 可逆性 | 跨会话 | 检索 | 成本 | 前缀缓存 | 级别 |
|---|---|---|---|---|---|---|---|---|
| LLMLingua-2 | 推理前 | **token** | ✗（不可还原） | ✗ | 无 | 低（3–6× 更快） | ✗（改写前缀） | B |
| Selective Context | 推理前 | **短语/句**（自信息阈值） | ✗ | ✗ | 无 | 低 | ✗ | B |
| RECOMP | 检索后、生成前 | **文档片段**（抽取/生成） | ✗ | ✗ | 依赖上游检索 | 低（小模型） | ✗ | B |
| LCM | 引擎自动 | **消息 → 摘要 DAG 节点** | **✓ 强**（无损指针指向每条原文） | ✓（架构级） | 指针 + DAG 遍历 | 中 | 部分（确定性 DAG，非替换式） | B |
| AgentFold | 模型主动（训练习得） | **子任务 / 多尺度** | ✗ | ✗ | 无 | 中 | ✗ | B |
| ACON | 触发点 + **学出来的 guideline** | 交互历史（按 guideline 选择） | ✗ | ✗ | 无 | 低（蒸馏后小模型） | ✗ | B |
| SWE-Pruner | 每次观察前 | **代码行**（0.6B 剪枝器） | ✗（原文可留盘） | ✗ | goal hint | 低（0.6B） | 部分（只改新观察） | B |
| SWE-Pruner Pro | 同上 | 代码行（用 agent 自身内部表示） | ✗ | ✗ | 复用 agent 表征，免独立分类器 | **更低**（免额外模型） | 部分 | B |
| Compaction Cliff / Knowledge Triage | 压缩时 | **行类型** | 部分（TypeRetrieve 走外部存储） | 部分 | 类型化检索 + 置顶 | 中 | ✗ | B |
| Compaction Laundering | （攻击面研究） | 消息**角色类型** | — | — | — | — | — | B |

### 7.4 矩阵读出的结构性事实

**事实一：可逆性与前缀缓存友好度高度相关，但不是同一件事。** 所有"✓ 可逆"的系统里，只有 billion-context 做到了"可逆 + 保缓存"（靠 `toFile` 模式绕开缓存前缀）；save-token 靠"落盘 + marker 取回"做到，但它只动工具输出、不动对话。**其余可逆系统（Letta / Mem0 / Zep / OpenViking / meow / memento）之所以可逆，是因为它们根本不替换历史——它们只往上下文里加东西。** 这是一个重要的分类学结论：**"记忆型可逆"和"压缩型可逆"是两种完全不同的东西。**【A】

**事实二：成本与粒度强相关，与压缩率弱相关。** 无 LLM 的方法（SWE-agent、Aider、OpenCode prune、Hermes Phase 1、save-token）边际成本接近零；一次摘要调用的方法成本与"被压缩的 token 量"成正比。**所以"压缩得越多越省钱"是错的**——save-token 引用的生产 RCT 显示 keep ratio 0.2（激进）反而让成本 **+1.8%**，0.5（中等）才是 **−27.9%**。原因是压缩后的重查与重读成本会吃掉节省。**这条数据是本报告最重要的成本结论，级别 B（二手引用，未拿到原始 RCT）。**【B】

**事实三：没有任何一行同时满足"可逆 + 保缓存 + 跨会话 + 低边际成本"。** 这是真实的四难困境，也是本项目的机会所在：
- billion-context：可逆 + 保缓存 + 低边际成本（模型自写摘要），但**不跨会话**。
- OpenViking：跨会话 + 可逆 + 低边际成本，但**不压缩对话**。
- Compaction Cliff 的 TypeRetrieve：跨会话 + 可逆，但**不保缓存**。
- LCM：可逆 + 跨会话，但**依赖引擎重写控制流**（模型失去灵活性）。

---

## 8. 关键结论与"营销 vs 实证"辨析

### 8.1 有硬证据的机制（可以放心抄）

| 机制 | 硬证据 | 级别 |
|---|---|---|
| **工具输出结构化瘦身 + 落盘可恢复** | save-token 两轮 A/B：48/48 episodes 成功率无损，token −17.6%，缓存命中 90.0%→90.7%；且失败时"放弃压缩"而非降级 | A（作者自报，n=2） |
| **只停用后缀区间以保 KV 前缀** | billion-context：4,843 会话 / 174,327 次调用 / 18.76B input token，缓存读取占比 **90.7%**；窗口违规 **0 次**（42,986 次 204,800 窗口调用，峰值 198,628） | A（作者自报，日志口径） |
| **压缩产物中位极短** | billion-context：每次压缩输出**中位 185 token**，p90 1.2K，**97.5% ≤ 2K** | A |
| **按行类型而非按长度选择保留内容** | Compaction Cliff：TypeCompact 五轮 **96% recall**，比最强单次压缩器多保 2–4× 安全规则；TypeDecompose 局部性违规 **0% vs 93%** | B（论文自报，带统计检验） |
| **保留消息角色类型以阻断伪造洗白** | Compaction Laundering：拍平型 **87–100%** 成功 vs 角色类型化 **0%** | B |
| **模型自写摘要优于独立摘要模型（成本维度）** | dsh-block-ptc 零摘要调用；billion-context 中位 185 token 输出 | A |
| **冻结快照 / 静态 section 可完全保缓存** | dsh-memento 冻结一次；meow-memory 静态 guide section | A |

### 8.2 只是宣称、缺乏实证的机制（要打折听）

| 宣称 | 实际情况 | 级别 |
|---|---|---|
| "压缩后成本大降" | 唯一给出**分档归因**的 billion-context 自己承认：**静默对照组（只加 doctrine 文本 + 每条消息 ref 标签、零压缩执行）复现了几乎全部 re-fetch 下降**（−62% vs 头条 −63%）。也就是说效果主要来自"文本结构 + 标签"，**不是"任务条件化的压缩"本身** | A（作者自述，难得的诚实） |
| "缓存友好" | 9 个插件里只有 2 个（billion-context、save-token）给出缓存命中率数字。其余是设计意图 | A |
| "记忆提升效果" | Mem0 的 v3 分数（LoCoMo 91.6 / LongMemEval 93.4，+20/+26 点）**明确声明只适用于托管平台**，开源 SDK"expect d…"（更差）。这是本报告见到的最直白的营销-开源落差 | B |
| "handoff 优于压缩" | @a9i5k4/auto-memory 的核心主张，工程约束是真的（四段式逐字校验、fail-closed 锚点写入），但**没有给出 handoff vs 压缩的对照实验数字**；对标"GPT-6 Astra"属营销引用 | A（实现）/ C（对标） |
| "分层多代压缩" | billion-context 的 tier-2 再蒸馏只触发了 **60/1711 块（3.5%）**——多代机制在生产中几乎没被用到。论文自己的容量模型标为 `[A]`（模拟）并**承认循环论证**（用自家语料拟合再外推） | A |
| "dream / 空闲巩固提升记忆质量" | meow-memory 的 dream 机制描述完整（≥3h 空闲、三轮、峰时抑制），但**无效果数据** | A（机制）/ 未验证（效果） |

### 8.3 三个反直觉发现

**(1) 压缩的收益可能主要来自"结构"而不是"压缩"。** billion-context 的静默对照实验是全报告最有价值的单一数据点：一个**不执行任何压缩**、只改了文本结构和标签的对照组，拿到了与完整压缩几乎相同的 re-fetch 降幅。**这意味着很多"压缩插件"的收益其实来自它们顺带引入的 prompt 结构。** 任何基准实验必须设置这个对照组，否则会把结构收益误记为压缩收益。【A】

**(2) 最激进的压缩会亏钱。** keep ratio 0.2 → 成本 +1.8%；0.5 → −27.9%。**存在一个最优压缩率，且它不是"越小越好"。** 原因：过度压缩触发重查，重查的输入成本 > 省下的输入成本。【B】

**(3) 压缩的破坏是乘性的，而且破坏的是"规则"不是"事实"。** Compaction Cliff 的五轮 53%→10% 衰减对象是**安全规则**；Compaction Laundering 洗白的是**指令权威**。**两者都不是"忘了某个事实"，而是"忘了某条约束的效力"。** 这与直觉相反——大家以为压缩丢的是细节，实际最先丢的是**规范性内容**（约束、禁令、审批要求）。【B】

### 8.4 必须写清的空白：没有跨系统同条件对照实验

**这是本报告最重要的结论，也是本项目的立项理由。**

我逐一检查了 §3、§4、§5 里的全部 30+ 个系统，**没有找到任何一份公开材料，在同一任务集、同一模型、同一 token 计量口径下，横向对比过 3 个以上压缩/记忆范式**。具体缺口：

| 缺口 | 现状 | 后果 |
|---|---|---|
| **任务集不统一** | LLMLingua-2 用 MeetingBank/LongBench；RECOMP 用摘要+QA；ACON 用 AppWorld/OfficeBench；AgentFold 用 BrowseComp；Compaction Cliff 用自建 agent 配置语料；billion-context 用 18 个自建串行任务 | 无法判断"谁更好"，只能判断"谁在自己的场景里更好" |
| **计量口径不统一** | billed tokens（含缓存读）/ context tokens / peak tokens / prompt tokens / re-fetch 次数 / 成功率，各说各话 | −17.6%、−31.5%、−53.7%、−26~54% 这些数字**不可比** |
| **对照组设置不一致** | 只有 billion-context 设了"静默对照"；save-token 设了"唯一变量 = 插件开关"；其余多数只与"自己的旧版"比 | 多数收益数字无法归因 |
| **模型不可比** | Claude Code 用 Sonnet 4.6 / Opus 4.6；AgentFold 用自训 30B-A3B；billion-context 用 qwen3.8-27b；Qwen Code 用 Qwen 系列 | 模型能力差异淹没机制差异 |
| **缓存指标几乎无人测** | 30+ 系统里只有 2 个给出 provider 缓存命中率 | "缓存友好"这个最常被宣称的属性，**基本无实证** |
| **长期衰减无人测** | 只有 Compaction Cliff 做了 5 轮压缩的衰减曲线；billion-context 的衰减模型是解析推导 `[A]` | 真实长跑（数百轮）行为未知 |

**因此本项目的基准必须自己定义**：固定模型与温度、固定任务集（建议同时含"工具输出密集"与"约束密集"两类）、固定计量口径（billed input / cache read / cache write / output 四分开）、并强制三臂对照——**(a) 无压缩、(b) 仅结构改造不压缩（静默对照）、(c) 目标压缩机制**。少了 (b) 臂，实验结论一定被高估。

### 8.5 对 DSH 插件设计的直接含义（可执行）

1. **不要试图替换 `ctx.compaction`，在它之外加一层可逆预处理。** `ctx.compaction` 是 cordis 单实例 Service（源码注释原文：`Load one implementation per context as ctx.compaction`），第三方**无法叠加第二个压缩引擎**；且 Web profile 里 host 平面的 `compaction-basic` 是 `auto: false`，真正运行的实例在 agent preset 内，而 **preset 行按 id 无法被 bundle patch 层寻址**。可行落点只有三个：`agent/pre-step` 事件层、`summarize` 钩子、或工具层预处理。`dsh-block-ptc` 已证明必须复用宿主事件类型。【A】
2. **第一优先级做"工具输出结构化瘦身 + 落盘可恢复"**，因为它同时满足：无 LLM 成本、可逆、可实测缓存友好、失败可放弃。这是唯一有 A 级实证的组合。【A】
3. **必须处理"压缩后记忆失联"**：压缩会把注入型记忆折叠进摘要并失真。`meow-memory` 的"压缩后重注入"是唯一已知补丁，**应在设计里前置**。【A】
4. **必须保留消息角色元数据**。若压缩产物被拍平成字符串，插件就是一个权限提升通道（87–100% vs 0%）。【B】
5. **摘要产物要校验形态**（Codex #55508 把 tool-call 片段当摘要）、**要设最小可压区间**（OpenHands #2255 "Cannot condense 0 events"）、**要防无限循环**（OpenCode `min_messages`）。这三个是已知必踩的坑。【B】
6. **可审计性要做成"压缩质量"维度**：记录每次压缩丢了什么、哪些约束被保留、哪些被丢弃。生态里**没有任何插件做这件事**，而 Compaction Cliff 证明最先丢的恰是约束。【A/B】

---

## 9. 局限

1. **没有做端到端实测。** 本机无法安装或运行 Claude Code、Codex CLI、OpenHands、Cline、Roo、Goose、Hermes、Letta 等任何系统（`web_fetch` 抓取失败、`raw.githubusercontent.com` 与 `api.github.com` 被阻断、无法 clone）。**所有性能数字均为他人自报**，本报告只做交叉核对，不做独立复现。
2. **代码证据多为文件级片段而非全文。** 除 9 个 DSH 包（解包直读）与 `billion-context` 的论文全文外，其余 agent 的证据来自搜索引擎返回的带路径行号的代码片段，级别定为 B。**片段可能脱离上下文**，例如某常量可能已被后续 commit 修改。
3. **Claude Code 是闭源**，全部实现细节来自第三方逆向分析，级别 C。其 92% 阈值、9 段式模板、Tier 4 fork 行为均**未经官方确认**。
4. **论文数字未经复现。** 11 篇论文的效果数字全部来自 arXiv 摘要，**没有一篇有第三方独立复现**（`s2` API 返回 429，无法做引用网络核查）。
5. **插件统计口径有限。** `plugins.json` 的 `stars` 是 GitHub star，不代表质量或使用量；252 条"压缩相关"是正则命中，含大量仅提及关键词的插件。`agent-context-editor` 与 `GraphFlow` 在 npm 上无法解析，**未能取证**。
6. **DSH 宿主压缩实现已读到（本项由 B 修正为 A）。** 早期版本依据"`find` 未命中任何 `*compaction*` 文件"判定宿主实现不可读——**这个推断是错的**：`app.asar` 是单文件归档，`find` / `glob` / `grep` / Node `fs` 都进不去，但 `read` 工具可以按路径直读归档内文件。现已直读 `@deepseek-ai/dsh-compaction/lib/index.js`（175 行）与 `@deepseek-ai/dsh-compaction-basic/lib/index.js`（1027 行），0.80 阈值的真实语义（动态预算公式）、`compaction/*` 事件的完整字段、唯一 `summarize` 钩子、四条正确性不变量均已落到源码行号（见 §6.5）。**仍未读到的三项**：`toolResultPruner` 的实现（只确认了宿主在两条路径上都会调 `pruneSession()`）、`spillStore` 的 API、以及 `deriveMessages()` 的投影细节——这三项仍是 B/C 级。
7. **时间窗限制。** 调研时点 2026-10-25；`billion-context` 论文为 2026-09-07 的 v0.2 preprint，`Compaction Cliff` 为 CIKM 2026，`Compaction Laundering` 为 2026-10-21——**均在快速演进中，结论可能数月内失效**。
8. **单一调研者。** 无第二人交叉复核，表格中的"机制判定"存在主观归类成分（例如把 `dsh-context` 归为"不压缩"是基于 README 与包结构，未逐行读全部 `lib/`）。
---

## 10. 来源清单

### 10.1 论文（arXiv 摘要经 `export.arxiv.org/api/query` 原文取得）

| # | 论文 | 链接 |
|---|---|---|
| 1 | LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression | [2403.12968](https://arxiv.org/abs/2403.12968) |
| 2 | Selective Context (Compressing Context to Enhance Inference Efficiency) | [2304.12102](https://arxiv.org/abs/2304.12102) |
| 3 | RECOMP: Improving Retrieval-Augmented LMs with Compression and Selective Augmentation | [2310.04408](https://arxiv.org/abs/2310.04408) |
| 4 | LCM: Lossless Context Management | [2605.04050](https://arxiv.org/abs/2605.04050) |
| 5 | AgentFold: Long-Horizon Web Agents with Proactive Context Management | [2510.24699](https://arxiv.org/abs/2510.24699) |
| 6 | ACON: Optimizing Context Compression for Long-horizon LLM Agents | [2510.00615](https://arxiv.org/abs/2510.00615) |
| 7 | SWE-Pruner: Self-Adaptive Code Pruning for Coding Agents | [2601.16746](https://arxiv.org/abs/2601.16746) |
| 8 | SWE-Pruner Pro: The Coder LLM Already Knows What to Prune | [2607.18213](https://arxiv.org/abs/2607.18213) |
| 9 | The Compaction Cliff in Long-Running AI Agent Memory (CIKM 2026) | [2608.22752](https://arxiv.org/abs/2608.22752) |
| 10 | Compaction Laundering: Provenance Destruction in Context-Compacting Coding Agents | [2610.29869](https://arxiv.org/abs/2610.29869) |
| 11 | MemGPT: Towards LLMs as Operating Systems | [2310.08560](https://arxiv.org/abs/2310.08560) |
| 12 | Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory | [2504.19413](https://arxiv.org/abs/2504.19413) |
| 13 | A-MEM: Agentic Memory for LLM Agents | [2502.12110](https://arxiv.org/abs/2502.12110) |
| 14 | Zep: A Temporal Knowledge Graph Architecture for Agent Memory | [2501.13956](https://arxiv.org/abs/2501.13956) |
| 15 | Scaling Long-Horizon LLM Agent via Context-Folding | [2510.11967](https://arxiv.org/abs/2510.11967) |
| 16 | OOLONG: Long-Context Reasoning Benchmark | [2511.02817](https://arxiv.org/abs/2511.02817) |
| 17 | LoCoMo: Evaluating Very Long-Term Conversational Memory | [2402.17753](https://arxiv.org/abs/2402.17753) |
| 18 | LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory | [2410.10813](https://arxiv.org/abs/2410.10813) |
| 19 | Lost in the Middle: How Language Models Use Long Contexts | [2307.03172](https://arxiv.org/abs/2307.03172) |

**延伸阅读（本次未读，仅由 `billion-context` 论文的 prior-art 图谱列出，级别 C）**：
[AutoCompressors 2305.14788](https://arxiv.org/abs/2305.14788) ·
[ICAE 2307.06945](https://arxiv.org/abs/2307.06945) ·
[Gist Tokens 2304.08467](https://arxiv.org/abs/2304.08467) ·
[LLMLingua 2310.05736](https://arxiv.org/abs/2310.05736) ·
[Cartridges 2506.06266](https://arxiv.org/abs/2506.06266) ·
[CoALA 2309.02427](https://arxiv.org/abs/2309.02427) ·
[MemOS 2507.03724](https://arxiv.org/abs/2507.03724) ·
[MIRIX 2507.07957](https://arxiv.org/abs/2507.07957) ·
[CAM 2510.05520](https://arxiv.org/abs/2510.05520) ·
[Agent Workflow Memory 2409.07429](https://arxiv.org/abs/2409.07429) ·
[PRO-LONG 2607.20064](https://arxiv.org/abs/2607.20064) ·
[Context-ReAct 2605.05191](https://arxiv.org/abs/2605.05191) ·
[ACM 2607.23809](https://arxiv.org/abs/2607.23809) ·
[EvoDS 2606.03841](https://arxiv.org/abs/2606.03841) ·
[HyMem 2608.15703](https://arxiv.org/abs/2608.15703) ·
[Paritok-4B 2608.24188](https://arxiv.org/abs/2608.24188) ·
[MemoryWalker 2609.00865](https://arxiv.org/abs/2609.00865) ·
[String OS 2608.28027](https://arxiv.org/abs/2608.28027) ·
[harness-evolution 2607.03691](https://arxiv.org/abs/2607.03691) ·
[OPENDEV 2603.05344](https://arxiv.org/abs/2603.05344) ·
[interaction cost 2608.16370](https://arxiv.org/abs/2608.16370) ·
[TRACE 2608.06503](https://arxiv.org/abs/2608.06503) ·
[SWE-ContextBench 2602.08316](https://arxiv.org/abs/2602.08316)

### 10.2 开源 Agent 源码与官方文档

| 系统 | 来源 |
|---|---|
| OpenAI Codex CLI | [仓库](https://github.com/openai/codex) · [PR #22870（`body_after_prefix` auto-compact scope）](https://github.com/openai/codex/pull/22870) · [issue #55508（tool-call 片段被当摘要）](https://github.com/openai/codex/issues/55508) |
| OpenHands | [仓库](https://github.com/All-Hands-AI/OpenHands) · 关键文件 `openhands-sdk/openhands/sdk/context/condenser/base.py` · [issue #2255（Cannot condense 0 events）](https://github.com/All-Hands-AI/OpenHands/issues/2255) |
| SWE-agent | [仓库](https://github.com/SWE-agent/SWE-agent) · 关键文件 `sweagent/agent/history_processors.py` · [history processor 配置文档](https://swe-agent.com/latest/reference/history_processor_config/) |
| mini-SWE-agent | [仓库](https://github.com/SWE-agent/mini-swe-agent) |
| Aider | [仓库](https://github.com/Aider-AI/aider) · 关键文件 `aider/repomap.py` · [repo map 文档](https://aider.chat/docs/repomap.html) · [tree-sitter repo map 设计文](https://aider.chat/2023/10/22/repomap.html) |
| Claude Code（闭源，逆向） | [Inside Claude Code · 04 Context Compaction](https://y-agent.github.io/inside-claude-code/04-context-compaction.html) |
| Cline | [仓库](https://github.com/cline/cline) · [auto-compact 文档](https://docs.cline.bot/features/auto-compact) · [PR #5520](https://github.com/cline/cline/pull/5520) |
| Roo Code | [仓库](https://github.com/RooCodeInc/Roo-Code) · [PR #3582（滑窗 → 摘要）](https://github.com/RooCodeInc/Roo-Code/pull/3582) · [PR #10873（Intelligent Context Condensation v2）](https://github.com/RooCodeInc/Roo-Code/pull/10873) |
| Gemini CLI | [仓库](https://github.com/google-gemini/gemini-cli) · 关键文件 `packages/core/src/context/chatCompressionService.ts` · [PR #13517（默认阈值改 0.5）](https://github.com/google-gemini/gemini-cli/pull/13517) |
| Qwen Code | [仓库](https://github.com/QwenLM/qwen-code) · [PR #4345（三级阈值阶梯）](https://github.com/QwenLM/qwen-code/pull/4345) · [PR #9109（压缩输出预算 clamp）](https://github.com/QwenLM/qwen-code/pull/9109) |
| OpenCode | [仓库](https://github.com/sst/opencode) · 关键文件 `packages/opencode/src/session/compaction.ts` · [PR #46136](https://github.com/sst/opencode/pull/46136) · [PR #10123](https://github.com/sst/opencode/pull/10123) · [issue #27706](https://github.com/sst/opencode/issues/27706) |
| Goose | [仓库](https://github.com/block/goose) · [smart context management 文档](https://block.github.io/goose/docs/guides/smart-context-management/) · 关键文件 `crates/goose/src/prompts/compaction.md` |
| Hermes Agent | [项目站](https://hermes-agent.nousresearch.com) · 关键文件 `agent/context_compressor.py`、`agent/context_engine.py` · 文档 `website/docs/developer-guide/context-compression-and-caching.md` |
| Letta / MemGPT | [仓库](https://github.com/letta-ai/letta) · [memory blocks 文档](https://docs.letta.com/v1-sdk/memory/memory-blocks/) · [archival memory 文档](https://docs.letta.com/v1-sdk/memory/archival-memory/) · [memory architecture](https://github.com/letta-ai/skills/blob/HEAD/letta/letta-api-client/memory-architecture.md) |

### 10.3 记忆系统

| 系统 | 来源 |
|---|---|
| Mem0 | [论文 2504.19413](https://arxiv.org/abs/2504.19413) · [文档](https://docs.mem0.ai) |
| Zep / Graphiti | [论文 2501.13956](https://arxiv.org/abs/2501.13956) · [Graphiti 仓库](https://github.com/getzep/graphiti) |
| Cognee | [文档](https://docs.cognee.ai) · [仓库](https://github.com/topoteretes/cognee) |
| LangMem | [文档](https://langchain-ai.github.io/langmem) · [仓库](https://github.com/langchain-ai/langmem) |
| A-MEM | [论文 2502.12110](https://arxiv.org/abs/2502.12110) · [仓库](https://github.com/agiresearch/A-mem) |
| OpenViking | [仓库](https://github.com/volcengine/OpenViking) · 本机已装包 `@openviking/dsh-memory-plugin@0.5.29`（直读源码） |

### 10.4 DSH 生态

| 插件 / 资源 | 来源 | 取证方式 |
|---|---|---|
| DeepSeek Harness | [仓库](https://github.com/deepseek-ai/deepseek-harness) | — |
| `dsh-plugin-catalog`（市场数据） | [npm](https://www.npmjs.com/package/dsh-plugin-catalog) | `npm pack` 后解析 `plugins.json`（6896 条） |
| `@deepseek-ai/dsh-compaction`（seam 包） | `D:\deepseek-h\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-compaction\lib\index.js` | **经 `read` 工具直读 asar 归档内文件，A 级**（175 行全文） |
| `@deepseek-ai/dsh-compaction-basic`（默认实现） | `D:\deepseek-h\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js` | **经 `read` 工具直读 asar 归档内文件，A 级**（1027 行，读 1-130 / 425-639 / 640-1029） |
| `billion-context` 0.1.206 | [npm](https://www.npmjs.com/package/billion-context) · [仓库](https://github.com/ranxianglei/billion-context) | 直读 README + paper + CONFIGURATION（A） |
| `@openviking/dsh-memory-plugin` 0.5.29 | [npm](https://www.npmjs.com/package/@openviking/dsh-memory-plugin) | 直读 README + `index.mjs` + `recall-core.mjs` + `recall-compress-core.mjs`（A） |
| `dsh-block-ptc` 0.4.0 | [npm](https://www.npmjs.com/package/dsh-block-ptc) · [仓库](https://github.com/mengwEX/dsh-block-ptc) | `npm pack` + 直读 README（A） |
| `dsh-plugin-save-token` 2.4.1 | [npm](https://www.npmjs.com/package/dsh-plugin-save-token) | `npm pack` + 直读 README（A） |
| `dsh-memento` 0.5.28 | [npm](https://www.npmjs.com/package/dsh-memento) · [仓库](https://github.com/PerryLink/dsh-memento) | `npm pack` + 直读 README（A） |
| `meow-memory` 0.31.1 | [npm](https://www.npmjs.com/package/meow-memory) · [仓库](https://github.com/Phant0Meow/dsh-meow-memory) | `npm pack` + 直读 README（A） |
| `@a9i5k4/dsh-auto-memory` 3.3.17 | [npm](https://www.npmjs.com/package/@a9i5k4/dsh-auto-memory) · [项目站](https://aik358.github.io/dsh-auto-memory/landing/) | `npm pack` + 直读 README（A） |
| `dsh-context` 0.76.0 | [npm](https://www.npmjs.com/package/dsh-context) · [仓库](https://github.com/bowenliang123/dsh-context) | `npm pack` + 直读 README（A） |
| `dsh-conversation-navigator` 0.2.11 | [npm](https://www.npmjs.com/package/dsh-conversation-navigator) · [仓库](https://github.com/gjj-star/dsh-conversation-navigator) | `npm pack` + 直读 README（A） |
| `agent-context-editor` | npm **404**，未能取证 | 未验证 |
| `GraphFlow` | 未能解析到 npm 包，未能取证 | 未验证 |

### 10.5 本报告的检索与取证手段（可复现）

| 手段 | 状态 | 用途 |
|---|---|---|
| `advanced_search engine=exa` | **可用**，能返回 GitHub 文件级片段（标题含路径与行号） | 唯一的代码证据来源 |
| `curl https://export.arxiv.org/api/query?id_list=<id>` | **可用**（HTTP 200，返回摘要 XML） | 论文摘要原文 |
| `domain_search engine=arxiv / github_releases / dblp` | 可用 | 论文元数据、版本 |
| `domain_search engine=s2` | **HTTP 429**，不可用 | — |
| `web_fetch` / `research` | **全部失败**（缺上游 API key） | — |
| `curl raw.githubusercontent.com` / `api.github.com` | **被阻断**（exit 7） | — |
| `npm view` / `npm pack --registry=https://registry.npmmirror.com` | 可用 | 插件取证 |
| `platform_search`（github / hn / reddit / stackoverflow） | 可用 | 讨论检索 |

**教训（供后续调研复用）**：不要对 minified bundle 用 `grep`（单行超长会刷爆输出），应改用 `node -e` 取字段或 `read` 带 `offset`；`npm pack` 后 `tar xzf` 到独立目录再读，比 `npm view` 能拿到多得多的信息（README、ARCHITECTURE、CHANGELOG、bench 报告）。

---

*报告结束。全文结论均已标注证据级别；凡标 C 或"未验证"处，请勿直接引用为事实。*
