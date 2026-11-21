# dsh-context-fold 主压缩接管路线图（v0.3.0+ 规划）

> 目标：把 dsh-context-fold 从「补充官方压缩的事件层插件」升级为「接管 DSH 整个内置上下文管理层」的主后端——覆盖压缩、token 计量、systemPrompt 组装、记忆注入四层，并在四个维度上实现可量化的更好效果。
>
> 本文基于三路只读调研（billion-context 安装版源码、DSH 0.2.2-rc.3 官方文档/源码、本插件 v0.2.0 源码审计），所有关键结论附 file:line 证据。状态：**规划中，尚未实施**。

---

## 一、目标与边界（已与用户对齐）

| 项 | 决定 |
| --- | --- |
| 替代对象 | DSH 整个内置上下文管理层（compaction + tokenMeter + systemPrompt + memory） |
| 替代方式 | 分阶段接管主压缩，官方退为兜底，**每步可回退** |
| 效果优先 | ① 长会话不劣化 + 节省率 ② 信息可恢复性 ③ 记忆质量/跨会话复用 ④ 延迟与成本（四者全要） |

---

## 二、现状：为什么当前还不是主后端

v0.2.0 的四层覆盖矩阵（审计证据 `docs/design.md:291-301`、`lib/index.js:45-265`、`lib/core/tokens.js:4-6`）：

| 层 | 现状 | 证据 |
| --- | --- | --- |
| compaction | ❌ 未覆盖：不提供 `compaction` 服务、不发 checkpoint、只被动旁观 `compaction/prune` | `docs/design.md:291-301`、`lib/ledger.js:68-86` |
| token 计量 | ❌ 未覆盖：`chars/3.5` 粗估，非真实计量 | `lib/core/tokens.js:4-6,10,17-20` |
| systemPrompt | ⚠️ 仅 append 一个 context，不注册 section、不控制排序 | `lib/index.js:250-265` |
| memory | ✅ 完整覆盖（唯一真正完整的一层） | `lib/memory.js`、`lib/store.js` |

硬缺口（审计 §2）：
1. 宿主 `compaction` 服务三方法 `compactIfNeeded / compactNow / compactRegion` 一个都没实现，无 `ctx.provide('compaction')`。
2. 不发 `compaction/start → summary → user/message{replace} → end` 检查点括号。
3. 无 `toolPairingBalancedBefore/After`、无收敛判据、无 `SurfaceChangedError`、无 `ManualCompactionError` + signal 转发。
4. 决策逻辑是「单工具结果字符阈值」，不是「会话级 token 驱动压缩」。
5. 配置无 `engine` 模式（`lib/config.js:45` 只有 `{complement, off}`）。

---

## 三、关键约束：billion-context 的真实独占机制（必须先理解）

调研结论（`node_modules/billion-context/` 安装版 0.1.214，commit `c26e001b`）：**它不是通过可替换的 Cordis 服务抢占压缩，而是三件套事实独占**：

1. **bundle patch**（`dsh.bundle.patch.yml:26-39`）：把 `compaction-basic` 设 `auto:false`，给四个 preset 注入 `biliBasicCompactionPolicy`。
2. **常开 gate entry**（`dist/agent/dsh-compaction-gate.js`）：挂 `internal/config` 的 global 中间件，递归把 plugin 树里的 `dsh-compaction-basic` / `dsh-command-compact` 行标 `disabled:true`。
3. **全局 fetch/WS 拦截 + 422 wire guard**（`dsh-native.js`）：拦截所有模型流量；识别 compaction summarize 请求（final user 以 `You are now acting as a compaction engine for this AI coding assistant` 开头）就返回 422 `dsh_compaction_refused`。

**已删除的旧开关**：`allowDshCompaction` / `BILI_ALLOW_DSH_COMPACTION` 在 0.1.214 已移除（`docs/configuration.md:126`），旧写法仅告警。新开关 `BILI_DSH_AUTHORED_COMPACTION` 默认 true（伪造答复而非拒绝）。

### ⚠️ 需要用户拍板的核心矛盾

> 用户选择的「官方退为兜底」在 billion-context 当前机制下**无法字面实现**——它只有三态：自己接管 / 完全退出（回退 STOCK 原生压缩）/ 冲突。它没有「别人压缩时我兜底」的模式（`docs/configuration.md:2543-2549`）。
>
> 因此「官方退为兜底」能落地的含义只能是：让 `bili-native` 退出拥有态，由本插件占用原生压缩槽位；bili 的 ACP 压缩不再位于该 lane（其 gate 仍需常开以防 preset 卡死）。这是**替换**，不是共存兜底。
>
> 干净让位路径：`BILLION_CONTEXT_PLUGIN=0` 或 `BILI_NATIVE_DSH=0` → `plan.mode='off'` → 不调 `declareDshCompactionActive()` → gate overlay 放行 → preset 回退 STOCK（`dsh-native.js` apply 段 + `docs/configuration.md:2549`）。**不要**禁用 `bili-compaction-gate` 本身（会重现 session 创建卡死）。

先例：`dsh-live-compact` 已用自己的 engine row + preset 覆写占槽；bili 的 overlay 只认 stock 行名，对它结构性失明（`docs/configuration.md:2538`）——这条路径已被第三方走过。

---

## 四、官方接缝（DSH 0.2.2-rc.3，已验证）

- **主后端** = 继承 `CompactionEngine` 并 `super(ctx,'compaction')` 的服务类，作为插件挂载；`dsh-compaction/README.md:49-51`、`:110`、`docs/subsystems/compaction.md:84,145-147`。每 context 只加载一个实现；默认桌面运行时已挂 `dsh-compaction-basic`（`package.json:120`），必须先在 patch 里移除/覆盖它。
- **三方法**（`dsh-compaction/src/index.ts:136-140,162-166,187-192`）：
  - `compactIfNeeded(agent, trigger:'pressure'|'context-overflow', signal): Promise<CompactionResult|null>`
  - `compactNow(agent, signal, sourceCommandId?): Promise<CompactionResult|null>`
  - `compactRegion(start, end, agent, signal?): Promise<CompactionResult>`
- **CompactionResult**（`src/types.ts:94-119`）：`compactionId, startSeq, summarySeq, endSeq, summary:ContentBlock[], shadowedRange, shadowedSeqs, shadowedTokenCount`。
- **检查点事务**（`README.md:93-97`、`dsh-compaction-basic/README.md:115`）：`compaction/start`（取锁，log-only）→ `compaction/summary`（log-only）→ **唯一 surface 变更** `user/message{surfaceOp:{op:'replace',startSeq,endSeq}, source:compactCheckpointSource(...)}` → `compaction/end`（释放锁）。两事件邻接是契约性的（`types.ts:28-33`）。
- **错误码**（`src/index.ts:35-41`）：`busy|cancelled|changed|summary|commit|persistence`；signal 必须透传给 `ctx.llm.stream()` 的 `GenerateOptions.signal`。
- **tokenMeter**：`super(ctx,'tokenMeter')` 替换单例；`measure/contextPressure/estimateMessage`（`docs/subsystems/compaction.md:84`）。
- **systemPrompt**：弱接管 `ctx.systemPrompt.section()`（`practices.md:18`）；强接管 `system-prompt/assemble` waterfall，但 `complete:true` section 会锁死整段且监听器不可改（`README.md:142`、`src/index.ts:22-26`）。工具声明只归 `ctx.tools.register(definition,{when})`，waterfall 里 `assembly.tools` 是 undefined（升级指南 `v0.2.1-rc.2/conditional-tools/guide.md:14`）。
- **Session.append 双重载**（`v0.2.2-rc.1/session-append-overloads/guide.md:6-17`）：包装必须用 Proxy + `Reflect.apply`，同时支持单事件与数组。
- **不得新增事件类型**（`practices.md:21`：需 `ignorable:true`，活的 `Session.append` 无法设置）。`compaction/summary-error` waterfall 的 `next()` 返回 boolean，恒 true 会死循环（`docs/design.md:479`）。

---

## 五、分阶段实施计划

### 阶段 0 — 可行性探针（P0-0，1–2 天，最高优先）
- 验证 `ctx.provide('compaction')` 同名覆盖是否抛 duplicate、apply 阶段能否拿到实例、宿主是否 `instanceof` 检查。
- **若不可行**：整条服务层路线退回「policy 层接管」，路线与工作量重写。
- 本阶段只读/低风险，不改宿主配置。

### 阶段 1 — 接管主压缩（P0-1~5，核心，约 2–3 周）
1. 新增 `engine` 配置模式 + bili 让位开关（环境变量说明 + 文档）；保留 `complement/off` 可回退。
2. 实现 `CompactionEngine` 子类三方法 + `CompactionResult` + bracket-first 事务（含 `compactCheckpointSource`、`sourceEventSeqs`）。
3. 接入真实 `tokenMeter` 替换 `chars/3.5`；实现双门控触发（token 压力 + 增量增长）。
4. 不变量与错误：`toolPairingBalanced*`、`assert*` / `SurfaceChangedError`、收敛判据、`ManualCompactionError` + signal 转发。
5. bundle patch：移除默认 `dsh-compaction-basic`，插入本插件 engine row；preset 覆写接管 compaction 行（参照 `dsh-live-compact`）。

### 阶段 2 — 效果超越（P1-6~11，约 1–2 周）
1. 增量 fold 算法：摘要前缀 + retainTokens 40000 + 首末保护 + maxSummaryTokens 1800 + 分层 tier-1/2/3。
2. 账本升级为权威 summary store：自发全字段 `compaction/summary`，对齐 prune/self-fold（明确唯一真相源，避免重复）。
3. 检索增强：BM25 之上加同义/语义召回，命中率 77% → >90%（与零依赖原则冲突，需权衡）。
4. 保留区从「工具结果内容」泛化到「事件 span」；spill 自动清理接线（`cleanSpills` 已存在未用）。
5. 建立记忆质量 benchmark（当前四维度里唯一无量化指标的）。

### 阶段 3 — 全层接管与加固（P2-12~16，约 1 周）
1. systemPrompt 强接管（评估 `complete` section 的取舍）。
2. tokenMeter 单例替换落地。
3. 存储迁移 `storage/storageDomain`；持久化指标替代进程内计数器。
4. LLM 抽取成本优化（批量/增量）与延迟回归测试。

---

## 六、量化验收目标（四维度，待用户确认数值）

| 维度 | 当前基线 | 目标 | measurement |
| --- | --- | --- | --- |
| 节省率 | 40.4%（约 147.7 万 token） | **>55%**（超越 bili 论文 54% 上限） | `bench/benchmark.mjs` M1，88 会话语料 |
| 长会话不劣化 | 无 >1M token 数据 | >1M token 会话 recall probe 不下降，宏观折叠 ≥70× | 新增长会话语料 + recall probe |
| 信息可恢复 | 逐字节 100%；BM25 77% | 逐字节 100% 保持；BM25 **>90%** | M2/M3 |
| 记忆质量 | 无量化指标 | 建立 benchmark：抽取准确率 + 注入命中率 + scope 隔离正确率 | 新建 M6 |
| 延迟/成本 | 异步落盘、LLM 每轮抽取 | 抽取调用数下降、主流程零阻塞 | 新增 M7 计时 |

---

## 七、回退方案（每阶段独立可回退）

1. **bili 让位**：设 `BILI_NATIVE_DSH=1` 恢复 bili 接管；本插件 `mode:'off'` 或 `complement`。
2. **插件侧**：`engine / complement / off` 三态；engine 失败自动降级到原事件层折叠。
3. **配置侧**：任何 patch 改动前 dump 全量配置快照（bili `docs/configuration.md:2543-2608` 警告 partial plugins 会整体替换致 preset 崩塌）。
4. **事件面**：不新增事件类型；checkpoint 严格遵循 bracket-first，失败时只关闭不落盘。

---

## 附录 A：三路调研证据索引

- **billion-context 内部机制**：`dsh.bundle.patch.yml:21-54`、`dist/agent/dsh-compaction-gate.js`（gate overlay 全文）、`dist/agent/dsh-native.js`（fetch 拦截 2324400+ / 422 guard 2339311 / declare verdict 2240133 / apply 2480553）、`docs/configuration.md:126-127,2530-2608`。
- **DSH 接缝**：`dsh-compaction/README.md:12,49-51,93-97,109-115,142`、`src/index.ts:35-41,48-64,77-86,88-108,110,119-122,136-192`、`src/types.ts:17-119`、`docs/subsystems/compaction.md:5,84,145-147`、`dsh-token-meter/src/index.ts:87-101`、`dsh-system-prompt/src/index.ts:22-26,452-494`、`docs/upgrade-guide/v0.2.2-rc.1/session-append-overloads/guide.md:6-17`、`v0.2.1-rc.2/conditional-tools/guide.md:14`。
- **插件审计**：`lib/index.js:45-265,434-493`、`lib/config.js:45`、`lib/core/{tokens,prune,region,bm25,decay,scope}.js`、`lib/{memory,ledger,spill,store}.js`、`docs/design.md:69-128,291-301,441-492`、`README.md:247-253`。

## 附录 B：术语

- **bracket-first 事务**：先 append log-only start 取锁，再准备摘要，revalidate 后 append summary + 唯一 replace，最后恰好一次 close。
- **Compaction Laundering（洗白）**：插件若私自 append `user/message` 而不带正确 `compactCheckpointSource`/`sourceEventSeqs`，会被归入 87–100% 洗白组（`docs/design.md:480`）。
- **fold 布局**：可恢复摘要块（tier-1/2/3，置于会话开头）+ 最近原文工作区（~50K token）+ 首末消息永久保护。
