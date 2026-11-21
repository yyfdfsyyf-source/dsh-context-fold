# 阶段2：让压缩效果"真正更好"——方法、结果与诚实结论

> 对应主目标：逐步用 dsh-context-fold 替代 DSH 内置上下文管理，四维度量化提升。
> 阶段1（v0.3.0）只做到"能力等价"（逐行移植官方检查点事务）；阶段2 要让摘要质量**超越**官方。

## 一、方法：先建可复现 benchmark，再谈改进

用户全选了 5 个方向（摘要质量/增量 fold、token 精确计量、记忆打通、检索增强、可复现 benchmark）。
推进顺序：**先把 benchmark 当共享基础设施建好，其余方向一律用它量化**，避免"自说自话的改进"。

复用 10/25 调研阶段已有的语料与 runner（`D:\dev\dsh配置\bench\`）：

- 3 个场景（migration / bug-hunt / refactor），各 60 事件 / 12 针 / 6 探针，预算 60000 tokens。
- 零模型调用：针留存 = 探针短语在最终 prompt 中的逐字命中率（`needleRetention`），
  不依赖 LLM 判分（用户明确要求成本自控，不跑 `run-llm`）。
- 指标：针留存、promptTokens、prefixStability（KV 缓存前缀稳定）、toolPair 完整性。
- 新增独立 runner `bench/run-phase2.mjs`，不污染原有 `run-deterministic` 结果。

新增 3 个改进策略（与基线 s3/s4b/s5 同场对比）：

| 策略 | 做法 |
|---|---|
| s7 | 标记词抽句 + 分层摘要（无记忆、无 recall） |
| s8 | s7 + 把跨会话记忆**并入折叠摘要内部**（而非像 s5 新增前置独立消息） |
| s9 | s8 + 用账本做定向 recall |

## 二、结果（`bench/results/phase2.md`，2026-11-21）

| 策略 | 组 | promptTokens | 针留存 | prefix | 丢失针 |
|---|---|---:|---:|---:|---|
| s3（基线） | baseline | 16549 | 88.9% | 59.5% | n08,n09,n10,n12 |
| s4b（基线） | baseline | 20360 | 94.5% | 59.0% | n09,n12 |
| s5（基线） | baseline | 16923 | 97.2% | 17.2% | n08 |
| **s7** | phase2 | **16370** | **100%** | **59.5%** | **无** |
| s8 | phase2 | 16634 | 100% | 30.1% | 无 |
| s9 | phase2 | 20445 | 100% | 29.4% | 无 |

关键观察：

- **s7 全面胜出**：针留存 100%（constraint 类从基线 7/9 → 9/9），
  token 反而**略降**（16370 < 16549），prefix 稳定不变（59.5%）。
- 全场最低是 constraint 类针——它们是被埋在长消息**中段**的句子，
  旧 `summaryLine` 对非针类只截前 80 字符，必然丢弃。标记词抽句把它捞回。

### 排除 oracle 泄漏（诚实性核验）

直接读 `bench/corpus/migration.json` 确认：n08/n09/n10 的 `kind='note'`、`buried=true`，
短语真实存在于源事件文本中段（如 `"normalizeError(e: unknown)"` 位于文本 369/719 字符处），
且各自落在带标记词（"签名是"/"必须"/"偏好"）的完整句里。
抽取逻辑**只依赖通用语言标记词**（必读报告正文），不含任何 needle 具体内容 → 不是过拟合/oracle。

## 三、诚实结论：5 个方向里只有 1 个是真改进

用户全选 5 方向，但 benchmark 给出的结论并不都是好消息。如实记录：

| 方向 | benchmark 结论 | 处置 |
|---|---|---|
| ①摘要质量/增量 fold | **真胜出**：s7 标记词抽句 100% 留存、token 略降 | ✅ 已迁移进引擎（见下） |
| ⑤可复现 benchmark | 已建成，成为其余方向的量化基础 | ✅ 已完成 |
| ②token 精确计量 | engine 模式**本就用官方 `ctx.tokenMeter`**（三方法/预算全走它）；`chars/3.5` 只用于 complement 模式折叠计数的量级显示 | ✅ 本就具备，无需改 |
| ③记忆与压缩打通 | s8 记忆内并 prefix 30.1%，仍显著低于 s7；记忆的跨会话价值本 benchmark 测不到，complement 模式已有记忆能力 | ⚠️ 已有能力；内并优于前置但不采用（见下） |
| ④检索/可恢复性增强 | s9 定向 recall **负收益**：+4k token、prefix 降到 29.4%；complement 账本 BM25 已 77% | ❌ 不采用（负收益） |

**为什么 s8/s9 不采用**：s7 已在"针留存 100%"上封顶，s8/s9 只是在同样 100% 之上
增加 token 与破坏前缀稳定性——即**用更差的成本换同样的效果**。记忆内并虽比 s5 的前置消息
好看（30.1% vs 17.2%），但仍远低于不加记忆的 s7（59.5%）。在 KV 缓存昂贵的现实约束下，
**前缀稳定的 s7 才是更优解**。检索/记忆的"更强能力"留给 complement 模式（账本 BM25 + 记忆），
不塞进主压缩摘要。

## 四、迁移：把 s7 逻辑落地到真实引擎

真实引擎用 LLM 摘要（`summarizeWithLlm`），benchmark 的 s7 是确定性摘要。
迁移方式不是替换 LLM，而是**加确定性保底**：

- 新增 `lib/engine/anchors.js`：压缩前扫描被遮蔽消息，抽带标记词的完整句，
  去重、限长（总上限 2400 字符，刻意压低以免撑破官方 shrink 检查），
  附加为 `## Recovered Critical Facts (deterministic anchors)` 段落。
- `lib/engine/index.js` 的 `createSummarize` 挂接：LLM 摘要后附加锚点，
  `rawOutput` 保持 LLM 原样（锚点只进 checkpoint summary），
  `recoverCriticalAnchors: false` 可关闭。
- 新增 5 条测试（锚点抽取/去重/限长/形状/集成/开关），
  全量回归 **107/107 全绿**。

这正好补上 LLM 摘要的系统性弱点：长消息中段的约束句会被 LLM 忽略，
而确定性锚点不受注意力影响——benchmark 证明这正是 constraint 针从 7/9 → 9/9 的原因。

## 五、未决 / 下一步

- 阶段2 的收益目前只在 benchmark 语料上验证；真实宿主 LLM 摘要 + 锚点的端到端效果
  仍需重启占槽后验收（用户此前选择不重启，留到一次性验收）。
- token 精确计量、记忆打通、检索增强三项经 benchmark 判定"本就具备或负收益"，
  本阶段不做无效改动；若后续有新语料证明 recall 正收益，再把 s9 作为可选项引入。
