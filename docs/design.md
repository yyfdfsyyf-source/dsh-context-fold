# dsh-context-fold — DSH 上下文折叠与长期记忆插件设计

> 状态：MVP 已实现并安装启用（`mode: complement`）
> 目标 profile：`desktop`（`C:\Users\YYF\.dsh\profiles\desktop`）
> 依赖：零 npm 运行时依赖，零 `@deepseek-ai/*` 导入

---

## 1. 摘要

现有 DSH 生态里，上下文压缩与记忆是两个各自为战的阵营：压缩派（`billion-context` 的 ACP、`dsh-compaction-basic`）解决"塞不下"，记忆派（`OpenViking`、`hindsight`、`ReMe`）解决"记不住"。但两者之间存在一个**结构性缺口**：

> **压缩把内容遮蔽之后，就没有任何东西能把它找回来。**

`dsh-compaction` 的契约明确规定：被折叠的事件仍留在原始日志里（`deriveMessages()` 只渲染摘要），但**对模型不可见**——模型只能看到那条承载摘要的 `user/message`。ACP 提供了块级 restore，但那是 UI/命令层面的能力，模型自己在对话里没有回捞手段。

本插件补的正是这个缺口，外加一个前置的"少折叠"手段：

| 能力 | 解决什么 | 与现有方案的关系 |
|---|---|---|
| **A. 确定性工具结果折叠** | 超大工具输出占满预算，逼着压缩器提前折叠有价值的历史 | 前置减负，与 ACP 正交 |
| **B. 折叠账本 + 回捞** | 折叠后信息不可达 | 补 ACP 的缺口，不替换它 |
| **C. 跨会话记忆注入** | 换个会话就失忆 | 与 OpenViking 互补（本方案零外部服务） |

设计原则：**不抢 `compaction` 服务**。每 context 只能有一个 `compaction` 实现，抢服务意味着与 ACP 二选一、且升级即碎。本插件全部能力都挂在**事件 seam** 上，装上去就生效，卸下来就干净。

### 调研给出的三条硬约束

完整调研见 [`context-compression-memory-survey.md`](./context-compression-memory-survey.md)（916 行，15 个 agent + 7 个记忆系统 + 42 篇论文 + 9 个 DSH 插件解包直读，DSH 压缩契约部分为 A 级源码直读）。其中三条直接决定了本设计：

1. **压缩的收益可能主要来自"提示结构"而不是压缩本身。** `billion-context` 论文自己的静默对照组（只加 doctrine 文本 + 每条消息 ref 标签，**一次压缩都没执行**）复现了头条 re-fetch 降幅 −63% 里的 **−62%**，作者明确承认效应应归因于"doctrine + 标签 + 布局"这一束。→ **任何没有静默对照臂的"压缩省了 X%"结论都不可信**，所以本项目的基准设了三臂（见 §6.3）。
2. **越激进的压缩越亏钱。** `dsh-plugin-save-token` 引用的生产 RCT：keep ratio 0.2 使总成本 **+1.8%**，0.5 才是 **−27.9%**——被压掉的内容会被 agent 重新查询，re-fetch 的成本超过省下的 token。→ **本插件默认不激进**（`maxChars: 8000`，只折 8000 字符以上的工具结果）。
3. **压缩最先摧毁的不是事实，而是规范性内容。** Compaction Cliff 测得 Claude Code `/compact` 一轮后安全规则只剩 53%、五轮后 10%，且"把摘要 prompt 写得更好"救不回来。→ **本插件不做摘要**，只做"留指针 + 可回捞"，从机制上避免这一退化。

### 自建基准的关键数字

详见 §6.3 / §6.4。一句话版本：**只剪工具输出（`s6`）一次 LLM 都不调就把上下文压掉 60%，还保住 91.7% 的针和 100% 的前缀稳定性**；增量 fold 更省（−79%）但规范性内容先掉；跨会话记忆能把确定性留存买到 97.2%、LLM 探针准确率 95.8%，代价是前缀稳定性掉到 17.2%——所以注入刷新必须限流。而**最贵的滑窗策略（吃满预算）LLM 准确率反而最低（90.3%）**，说明预算不是瓶颈、保留哪一段才是。约束类信息是全场最先被牺牲的一列（`constraint` 针 s1 仅 69%）。

---

## 2. 约束：为什么不能走"子类化压缩后端"这条路

这是本设计最关键的一条，且是**实测结论**，不是偏好。

原计划打算 `import { CompactionEngine } from '@deepseek-ai/dsh-compaction'` 然后覆盖 `summarize()` 钩子（该钩子是 `BasicCompactionEngine` 唯一的扩展点，源码注释原文："Override this sole hook for a template or remote summarizer"）。这条路在**本机不可行**：

1. `plugin_manager install_bundle` 对本地目录做的是**符号链接**，不是拷贝：
   `C:\Users\YYF\.dsh\profiles\desktop\node_modules\dsh-hard-gate -> D:\dev\dsh配置\plugins\dsh-hard-gate`
2. Node 的 ESM 解析默认按 **realpath** 走（`preserveSymlinks=false`），所以插件的真实路径是 `D:\dev\dsh配置\plugins\dsh-context-fold\lib\index.js`。
3. 该路径向上查找 `node_modules` 只会命中 `D:\dev\dsh配置\plugins\node_modules`、`D:\dev\dsh配置\node_modules`、`D:\node_modules`——**全都不存在** `@deepseek-ai/*`。
4. 实测：从插件目录 `import('@deepseek-ai/dsh-compaction')`、`('@deepseek-ai/schemastery')`、`('cordis')` **全部 `ERR_MODULE_NOT_FOUND`**。

`dsh-hard-gate` 的源码注释已经把这条写死了：

> "A linked local directory makes bare imports resolve from the checkout, not from the profile, so `@deepseek-ai/schemastery` may be absent at runtime ... a missing schema degrades to 'no settings form', never to 'no gate'."

**推论**：任何第三方本地插件都必须满足
- 只用 `node:` 内置模块；
- 不 `export const Config`（那需要 schemastery）；配置手动校验；
- 只用插件收到的 `ctx` 对象访问宿主能力；
- 所有可选能力用 `try/catch` 降级，**加载失败绝不允许**。

这条约束直接决定了 MVP 的形态，也让 `engine` 模式退居路线图（见 §8）。

---

## 3. 已确认的宿主事实（本机实测）

### 3.1 可用扩展点

| 类型 | 名称 | 用途 | 本插件是否使用 |
|---|---|---|---|
| Event | `agent/pre-step` | 可替换进入该 step 的消息 | 否（留给 engine 模式） |
| Event | `agent/request` | 替换冻结的 `LlmCallConfig` | 否 |
| Event | `system-prompt/assemble` | PromptAssembly 瀑布，可加 section/context/tools/variables | **是（能力 C 注入）** |
| Event | `tools/pre-execute` | 工具调用前 | 否 |
| Event | `tools/post-execute` | 可改写工具结果 | **是（能力 A 折叠）** |
| Event | `session/event` | 提交后事件流 | **是（能力 B 账本）** |
| Event | `agent/turn-stopping` | 回合结束 | **是（能力 C 抽取）** |
| Event | `compaction/summary-error` | 摘要失败恢复（waterfall） | 否 |
| Service | `compaction` | 压缩后端（每 context 唯一） | **否（刻意不抢）** |
| Service | `tokenMeter` | measure/estimate | 可选（有则用，无则估算） |
| Service | `toolResultPruner` | 确定性 head/middle/tail 剪枝 | 可选（有则并用） |
| Service | `storage` / `storageDomain` | 持久化 | 否（改用 jsonl，见 §7.4） |
| Service | `llm` | 模型调用 | 是（能力 C 抽取，缺失则整块禁用） |

### 3.2 压缩契约（读 `dsh-compaction` 与 `dsh-compaction-basic` 源码得到）

- `CompactionEngine extends Service`，服务名 `"compaction"`，**每 context 只能有一个实现**。
- 后端三方法：`compactIfNeeded(agent, trigger, signal)` / `compactRegion(start, end, agent, signal)` / `compactNow(agent, signal, sourceCommandId)`。
- 成功运行的**括号顺序**（唯一合法的表层变更序列）：

  ```
  session.append('compaction/start')                    // 取锁
  session.append('compaction/summary', {...})           // 仅日志，不进表层
  session.append('user/message', checkpoint, {
    surfaceOp: { op:'replace', startSeq, endSeq }       // ← 唯一表层变更
  })
  session.append('compaction/end')                      // 放锁
  ```

- `compaction/summary` 事件字段：`{compactionId, summary, shadowedRange:{start,end}, shadowedSeqs, shadowedTokenCount, provider, model, maxTokens?, usage?, rawOutput?, llmStreamCall?}`。
- 边界必须用 `toolPairingBalancedBefore/After(session, seq)`，保证不跨越"发了 tool-call 但没收到 tool-result"的断点。
- 收敛判据（源码原文）：`summary is not smaller than the shadowed content (${framed} >= ${shadowed})` —— 摘要不比原文小就报错，不落盘。
- 稳定性：`assertWholeSurfaceUnchanged` / `assertSelectedSpanStable`，被并发改写则抛 `SurfaceChangedError`。
- 手动路径失败抛 `ManualCompactionError(code, msg)`，`code ∈ {busy, cancelled, ...}`；`signal` 必须转发到 `ctx.llm.stream()` 的 `GenerateOptions.signal`。

**对本插件的意义**：`compaction/summary` 是一个**带完整元数据的、只进日志的事件**——这正是做账本的理想锚点。我们不需要理解摘要内容，只需要把它记下来并在模型问起时还回去。

### 3.3 与 billion-context（ACP）的共存分析

ACP 的 `dsh.bundle.patch.yml` 做了四件事：

```yaml
insert:
  - { id: bili-native,          name: billion-context }
  - { id: bili-compaction-gate, name: billion-context/dsh-compaction-gate }
- id: compaction-basic
  config: { auto: false }        # 关掉 host 平面的自动压缩
- id: preset-standard           # 以及 preset-ptc / preset-minimal / preset-cordis
  inject: [biliBasicCompactionPolicy]
```

它的注释解释了为什么这么绕：**Web 版 profile 的 `compaction-basic` 在 host 平面被禁用，真正运行的实例在 agent preset 内**，而 preset 行按 id 无法被 patch 层寻址，所以用 gate entry + preset inject 的方式注入策略。

关键事实：**ACP 的包不 import 任何 `@deepseek-ai/*`**（它的 `dependencies` 只有 `mysql2` 和 `zod`），说明它走的是 policy 层而非服务替换。它通过 `compaction` 服务（21 处引用）和 `session/event`（1 处）工作。

**结论**：ACP 是"策略层"，不是"服务层"。我们的插件只要也待在事件层、不注册 `compaction`，就与它零冲突。这是 `mode: complement` 的技术基础。

---

## 4. 插件设计

### 4.1 定位

> 一个**减负 + 记忆**插件，不是压缩器。它让压缩器少干活，并让压缩的产物可回收。

### 4.2 三块能力

#### A. 确定性工具结果折叠（`tools/post-execute`）

触发：工具结果文本长度 > `pruner.maxChars`（默认 8000）。

动作：
1. 完整原文落盘 `<DSH_HOME>/context-fold/spill/<id>.txt`；
2. 上下文内保留 head（默认 2000 字符）+ tail（默认 2000 字符）；
3. 中间插入一行可机读标记：
   `[context-fold: 已折叠 <id>，原文 <bytes> 字节，用 context_fold recall <id> 取回]`

**硬约束：只改写结果内容，绝不删除或替换事件。** 这是保证 `toolPairingBalanced*` 仍然成立的前提——孤儿 tool-call 会让压缩器拒绝在附近下刀，反而更糟。

为什么值得做：合成基准里 3–5 条 20K–40K 字符的工具输出就能吃掉 60K 预算的一半以上，而其中只有 1 条含关键信息。先剪掉这部分，压缩器就不必去折叠真正有价值的历史。

#### B. 折叠账本 + 回捞（`session/event` + `context_fold recall`）

监听 `session/event`，命中 `compaction/summary` 时记录：

```json
{ "blockId": "...", "startSeq": 0, "endSeq": 0,
  "shadowedTokenCount": 0, "summary": "...", "ts": 0 }
```

追加到 `<DSH_HOME>/context-fold/ledger.jsonl`。

`context_fold recall <id|关键词>`：先按 `blockId` 精确匹配；否则对 `summary` 做 BM25（中文按字 bigram 切分，`k1=1.2, b=0.75`）返回 top-k 片段及其 `seq` 范围。

这条能力的价值在基准的 S4 变体里被量化：**折叠不丢内容、且模型能主动 recall** 时，`constraint` 类针的留存率显著高于纯折叠。

#### C. 跨会话记忆（写入 `agent/turn-stopping` + 注入 `system-prompt/assemble`）

**写入**：每轮最多 1 次 `ctx.llm.stream()`，要求模型返回 JSON 数组
`[{ type:'fact'|'decision'|'lesson'|'preference', text, evidenceSeq }]`。
每轮最多 6 条；**不足 2 条不落库**（避免把噪声写成记忆）。
存 `<DSH_HOME>/context-fold/memory.jsonl`：`{id, type, text, ts, evidenceSeq, hits, lastHitAt}`。

**注入**：在 `system-prompt/assemble` 里加一个 context section。排序 = BM25 分数 × 时间衰减，半衰期 30 天；取 top `injectLimit`（默认 6）；总长按 3.5 chars/token 截断到 `maxInjectTokens`（默认 1200）。

**前缀缓存策略（关键设计决策）**：
记忆 section 的内容**不能每轮都变**，否则每次注入都会击穿 KV 前缀缓存，省下的 token 又赔回去。因此：
- 排序必须**全序稳定**（分数降序，同分按 `id` 升序）；
- 只在「新增记忆数 ≥ 2」或「显式 recall 之后」才刷新该 section；
- 未刷新时沿用上一轮的 section 文本（存在内存里）。

这条权衡在基准的 `prefixStability` 指标上被直接度量。

**项目分区（`scope`，v0.1.1 引入、v0.1.3 修对来源）**：

记忆库是单个全局 jsonl，但记忆本身有项目归属。写入时给每条打 `scope: { cwd, repo, branch }`；注入与 `recall` 时按 `scopeMode` 处理：

| `scopeMode` | 行为 | 适用 |
|---|---|---|
| `prefer`（默认） | 分数按亲和度加权：同 cwd ×1.0、同 repo ×0.85、无 scope ×0.5、跨 repo ×0.25（乘以 `scopeWeight`=0.35 的权重） | 大多数场景——跨项目经验仍有价值，但同项目必须显著优先 |
| `strict` | 亲和度 < 0.5 的条目直接丢弃；**无 scope 的历史条目保留**（否则旧记忆全失效） | 多项目混用、噪声严重时 |
| `off` | 不做任何作用域处理，退化为 v0.1.0 的全局行为 | 排障 / 回滚 |

`repo` **刻意取 `basename(cwd)` 而非 git 仓库根**：实测本工作区向上找到的是 `D:\dev\.git`，那个仓库覆盖整个 `dev` 目录（多个互不相干的项目），用 git 根会把它们误判成同一仓库，作用域直接失效。git 根只用来读分支名，不参与亲和度计算。

**`cwd` 的来源（v0.1.3 修正，这条比排序更致命）**：作用域里的 `cwd` 取自 **`session.header.cwd`**，不是 `process.cwd()`。v0.1.1 在 `apply()` 里写的是 `detectScope(process.cwd())`，而在 DSH 桌面宿主中**进程 cwd 就是 profile 目录**（实测 `C:\Users\YYF\.dsh\profiles\desktop`）——于是所有项目的记忆都打上同一个 `scope`，排序逻辑再正确也等于没分区。这个缺陷是在真实宿主里跑起来后才暴露的：`memory.jsonl` 最新条目的 `scope.repo` 是 `desktop`，而不是当前项目名。

`session.header.cwd` 是宿主创建会话时校验过的绝对路径（`sessions.create` 的 `meta.cwd` 传相对路径会抛 `meta.cwd is a non-absolute path`），也是 `SessionHeader` 上唯一可靠的路径来源——`Session.requestContext()` 只有 `provider`/`model`/`contextWindow`，`AssembleContext` 只有 `ScopeKey`（对象，不是路径），都拿不到项目目录。没有 `header.cwd` 的会话（子代理、种子会话）退化为装配时的初始作用域。作用域变化时 `memory.setScope()` 会**清空注入缓存**——否则会把上一个项目的记忆注入到当前项目。

为什么默认是 `prefer` 而不是 `strict`：`strict` 会让"别在日志里打 token"这类真正通用的教训在别的项目里消失，而这类记忆恰恰是跨项目记忆库最大的价值。加权能同时满足"同项目优先"和"通用经验不丢"。

### 4.3 数据流

```
  工具结果 ──► tools/post-execute ──► [A 折叠] ──► 落盘 spill/ + 上下文留 head/tail
                                                        │
  压缩器折叠 ──► session/event ──► [B 账本] ──► ledger.jsonl
                                                        │
  模型 recall ◄── context_fold recall ◄─────────────────┘

  回合结束 ──► agent/turn-stopping ──► [C 抽取] ──► memory.jsonl
                                                        │
  下一回合 ──► system-prompt/assemble ──► [C 注入] ◄────┘
```

### 4.4 配置

```yaml
mode: complement          # complement | off
pruner:
  enabled: true
  maxChars: 8000
  keepHead: 2000
  keepTail: 2000
memory:
  enabled: true
  injectLimit: 6
  maxInjectTokens: 1200
  decayHalfLifeDays: 30
  scopeMode: prefer        # prefer | strict | off
  scopeWeight: 0.35        # 仅 prefer 生效：跨作用域记忆的分数折扣
  extractMode: background  # background | blocking | off（默认不阻塞 turn）
  minTranscriptChars: 400  # 本轮转录短于此值则跳过抽取
ledger:
  enabled: true
  maxBlocks: 2000
```

`mode: off` 是**即时回滚开关**：所有能力短路返回，不注册任何监听。这比卸载 bundle 更快，适合"装上发现不对"的场景。

### 4.5 工具面

`context_fold(action, ...)`：

| action | 参数 | 返回 |
|---|---|---|
| `status` | — | 各能力就绪状态 + 计数器（折叠次数、账本条数、记忆条数、估算节省 token） |
| `recall` | `query` | 命中的账本条目 / 记忆条目 / spill 文件 |
| `prune` | — | 对当前会话跑一次折叠扫描，返回折叠条数 |
| `ledger` | `limit?` | 最近 N 条账本条目 |

工具描述要让模型能自己判断何时用——尤其 `recall` 的触发场景（"当你不确定某个已折叠的历史细节时"）。

### 4.6 失败模式矩阵

| 场景 | 处理 | 是否阻塞会话 |
|---|---|---|
| `llm` 服务不可用 | 能力 C 整块静默禁用，`status` 里标记 `memory: unavailable` | 否 |
| 记忆抽取超时/返回非 JSON | 跳过本轮，计数 `extractFailures++` | 否 |
| spill 落盘失败（磁盘满/权限） | 放弃折叠该条，原样保留 | 否 |
| ledger 写失败 | 丢该条，不重试 | 否 |
| 记忆注入超预算 | 按分数截断到 `maxInjectTokens` | 否 |
| `mode` 非法值 | 回落到 `complement` 并记 warning | 否 |
| 插件加载异常 | 不应发生（无裸导入）；`apply` 内整体 try/catch，失败只记日志 | 否 |
| 与 ACP 同时折叠 | 无交互——本插件不注册 `compaction`，不参与锁 | 否 |

**设计铁律：任何一块能力的失败都只能降级，不能让 turn 失败。** 上下文管理是"锦上添花"，不是关键路径。

### 4.7 运行时延迟（v0.1.2 的设计目标：每轮增量 0）

上下文管理插件最容易犯、也最伤用户的错误不是"压得不好"，而是**把压缩做进了请求路径**。一旦如此，省下的 token 会被多出来的等待时间抵消，任务总时长反而变长。

**外部证据（A 级：本机插件包源码直读）**：下载量第一的 `billion-context`（1,784,720 次，约为第二名 `dsh-context` 的 12 倍）在 `dist/agent/dsh-native.js` 里只注册了 `session/created` 与 `session/event` 两个事件，**没有** `agent/pre-step` / `agent/turn-stopping` / `agent/request`，`ctx.get` 零次。它的压缩不在宿主进程内，而是维护一个本地 HTTP 代理（`register.base`、`/bili/origin`、`/__bili` 前缀 relay），模型调用被改道经代理，折叠在代理侧完成。→ **每次模型调用多一次本地 HTTP 往返，折叠再叠加模型调用**。这就是用户所说"极大加长任务时间"的机制来源。

**本插件的三条自检**：

| 检查项 | 结论 |
|---|---|
| 是否注册 `agent/request` / 改 `llm.stream` 参数 / 建代理 | 否——完全不碰请求路径 |
| 是否在串行钩子里 `await` 模型 | v0.1.1 及以前**是**（`agent/turn-stopping`），v0.1.2 起默认 `background`，监听器立即返回 |
| 是否有其它同步 IO 在热路径 | 只有 `tools/post-execute` 里的落盘（异步、失败即放弃）；不阻塞 turn |

**为什么 `background` 必须自建 AbortController**：`payload.signal` 是宿主的本轮信号，turn 一结束就 abort。若把后台抽取挂在这个 signal 上，抽取会在启动瞬间被取消——看起来"没报错"，实际一条记忆都写不进去。所以后台任务用独立 controller，并在 `ctx.effect` 的 dispose 里统一 abort。

**代价**：后台抽取与下一轮并发，`status` 里可能出现"本轮已结束但记忆还没落库"的瞬时状态；需要确定性时序的脚本用 `extractMode: 'blocking'`。

---

## 5. 为什么 MVP 不做 `engine` 模式

`engine` 模式（真正替换压缩后端、做增量 fold）的价值是明确的：ACP 的成长门控是 ~50K 新增才折，对短会话不友好；而一个按"任务已消费的增量"细粒度折叠的后端理论上更省。

但本轮不做，理由有三条，按重要性排序：

1. **技术不可行（已实测）**：无法导入 `CompactionEngine` / `BasicCompactionEngine`，无法 `extends`，无法复用 `commitCompactionBody` 的括号逻辑与 `assertSelectedSpanStable` 校验。手写一遍等于重实现 1000 行的高风险逻辑。
2. **服务独占**：`compaction` 每 context 唯一，注册即与 ACP 二选一。用户当前正在用 ACP，替换意味着放弃其成熟的分层 restore 与生产验证。
3. **回滚成本高**：服务替换需要改 preset inject + 重启，失败会让人整个会话不可用；而 `mode: off` 是零成本回滚。

替代路径见 §8。

---

## 6. 验证方法

### 6.1 测试

```bash
cd plugins/dsh-context-fold && npm test        # = node --test "test/*.test.mjs"
```

**81 个用例全部通过**（约 1.5s）：

- `test/core.test.mjs`（44 个）—— 纯函数层，不碰 `ctx`：BM25 排序稳定性与中文 bigram 切分、`decideFold` 的边界（刚好等于阈值 / 已折叠过 / 头尾预算之和 ≥ maxChars）、时间衰减单调性、`selectKeptRegions` 的区域切分、配置校验与非法值回落。
- `test/integration.test.mjs`（34 个）—— **通过插件公开入口 `apply(ctx, config)` 装配**，再用 mock ctx 驱动宿主事件，用真实临时 `DSH_HOME` 落盘，验证：工具 schema 与 `output.render` 齐全、`tools/post-execute` 折叠闭环（折叠→落盘→recall 逐字节取回）、`isError` 与 `block` 决策不被改写、`compaction/summary` 真实 payload 映射到账本字段、中文关键词回捞、**`agent/turn-stopping` 不阻塞 turn**（`background` 默认下监听器 60ms 内返回、`blocking` 会等、`off` 零监听器、短转录跳过）、每轮最多一次 `llm.stream`、LLM 失败只降级不抛错、候选 <2 条不落库、`system-prompt/assemble` 注入走 `contexts` 而非 `sections`、`mode=off` 时零监听器、`prune` 不改写历史事件，以及**记忆作用域**（写入打 scope、prefer 排序、strict 过滤、off 退化、无 scope 旧数据不被误杀）。
- `test/scope.test.mjs`（3 个）—— 作用域**来源**（v0.1.3 补）：写入必须用 `session.header.cwd` 而不是 `process.cwd()`、没有 `header.cwd` 时退化为装配初始作用域、`setScope` 真的改变排序并让注入缓存失效。这三个用例锁死的是"单测看不见、只有跑进真实宿主才暴露"的那类缺陷。

> 注意：本机 Node **v24.22.1** 下 `node --test <目录>` 对**任意目录**都报 `Cannot find module`（已用最小复现确认是环境问题，不是本仓库的问题）。必须传 glob：`node --test "test/*.test.mjs"`，或直接 `npm test`。

### 6.2 装后验证（已完成）

安装命令与结果：

```
plugin_manager action=install_bundle target=D:\dev\dsh配置\plugins\dsh-context-fold
→ {"stage":"enable","bundle":"dsh-context-fold","version":"0.1.0","enabled":true,"application":"applied"}
```

已核对的静态事实：

| 检查项 | 结果 |
|---|---|
| profile `package.json` 的 `dependencies` | 出现 `dsh-context-fold: link:D:/dev/dsh配置/plugins/dsh-context-fold` |
| profile `dsh.profile.bundles` | 24 项，末位为 `dsh-context-fold` |
| `node_modules/dsh-context-fold` | 符号链接 → `/d/dev/dsh配置/plugins/dsh-context-fold` |
| 其余 22 个 bundle | 全部仍在（`billion-context` / `dshmarket` / `dsh-ops` / `@openviking/dsh-memory-plugin` / `dsh-free-search` 逐个 `-e` 检查通过） |
| 裸导入扫描 | 无 `@deepseek-ai/*`、无 `cordis` 裸导入（唯一的 `@deepseek-ai/schemastery` 是**可选** peer，加载不到时纯手工校验） |
| 装前快照 | `snapshots/20261025-161244/`（`cordis.patch.yml`、`package.json`、`node_modules-list.txt`、`.dsh-market/state.json`） |

**尚未做的**：宿主进程内的运行时验证。`context_fold status` 要等 DSH 重启后才会出现在工具列表里（服务端插件不走 HMR）。这一步留给用户重启后自查，命令见 §7。

### 6.3 基准：自建对照实验

调研结论（见 `context-compression-memory-survey.md` §8）指出：**没有任何公开材料做过跨系统的同条件对照实验**，各家指标口径互不相同，无法横向比较。所以本项目的基准是自建的，且刻意采用三臂结构——因为 billion-context 论文自己的静默对照臂显示，头条收益的 −62% 可由"仅改提示结构、零压缩执行"复现：

- **臂 A：无压缩**（`s0`）—— 全量事件，作为上限对照，必然超预算。
- **臂 B：只改结构、不做摘要**（`s6`）—— 只对超长工具结果做 head/tail 剪枝 + 落盘，零 LLM 调用。这是"静默对照"的近似。
- **臂 C：目标机制**（`s1`/`s2`/`s3`/`s4`/`s4b`/`s5`）—— 滑窗、一次性摘要、增量 fold、fold+账本、fold+账本自动 recall、fold+跨会话记忆。

**设置**：预算 60000 tokens（`chars/3.5` 估算），3 个合成场景（`migration` API 迁移 / `bug-hunt` 间歇性空帧 bug / `refactor` 拆分 monolith 并处理循环依赖），每场景 60 个事件、12 个针、6 个探针。指标全部确定性计算，**零模型调用**，因此可完全复现。

**结果（3 场景均值）**：

| 策略 | promptTokens | 针留存 | toolPair 完整性 | fold 次数 | 摘要字符 | 前缀稳定性 |
|---|---:|---:|---:|---:|---:|---:|
| `s0` 全量（上限对照） | 79218 | 100.0% | OK | 0 | 0 | 100.0% |
| `s1` 滑窗 | 58524 | 86.1% | OK | 0 | 0 | 79.3% |
| `s2` 一次性摘要（oracle 上界） | 27951 | 100.0% | OK | 1 | 43711 | 66.7% |
| `s3` 增量 fold | **16549** | 88.9% | OK | 4 | 5533 | 59.5% |
| `s4` 增量 fold + 折叠账本 | 16549 | 88.9% | OK | 4 | 5533 | 59.5% |
| `s4b` fold + 账本自动 recall | 20360 | 94.5% | OK | 4 | 5533 | 59.0% |
| `s5` fold + 跨会话记忆 | 16923 | **97.2%** | OK | 4 | 5533 | **17.2%** |
| `s6` 仅工具结果剪枝（静默对照） | 31948 | 91.7% | OK | 0 | 0 | **100.0%** |

**四条可直接用于设计的读法**：

1. **"只剪工具输出"是性价比拐点**。`s6` 一次 LLM 都没调，就把 79218 压到 31948（−60%），还保住 91.7% 的针和 100% 的前缀稳定性。**这验证了本插件把能力 A 放在第一优先级的判断**——它便宜、可逆、且不碰历史。
2. **省得最狠的是增量 fold，但代价是规范性内容先掉**。`s3` 只用 16549 tokens（−79%）却掉到 88.9%，丢的针集中在 `constraint` 类（3 场景合计 7/9）。这与 Compaction Cliff 的结论一致：压缩最先摧毁的不是事实，是"约束/规范"。
3. **账本本身不改上下文，收益只能通过 recall 兑现**。`s3` 与 `s4` 的确定性指标完全相同是**预期的**——`s4` 的账本只进 `stats.ledger`、不进 messages。真正的差异在 `s4b`：自动 recall 把留存从 88.9% 拉到 94.5%，代价是 +23% token（16549 → 20360）。**这就是"可逆性有价格"的定量表达**——但注意这是**确定性留存**的价格；LLM 探针显示这 +23% token 并没换来准确率提升，反而在宽松判分下更差，见 §6.4 第 2 条。
4. **记忆注入能买到最高的留存，但会击穿前缀缓存**。`s5` 用 16923 tokens（几乎不比 `s3` 多）拿到 97.2%，是全部策略里留存最高的；但 `prefixStability` 只有 17.2%，因为记忆被注入在最前面，每轮变一次就让整个前缀失效。**这正是本插件 `shouldRefreshInjection` 只在"新增 ≥2 条或显式 recall"后才刷新的原因**——用一点新鲜度换回缓存命中。

**必须声明的局限**（诚实性）：

- `s2` 与 `s3`/`s4`/`s4b`/`s5` 的"100% / 88.9% 针留存"含 **oracle 特权**：这些策略在压缩时被告知哪些事件是针，并优先保留。真实 agent 没有这个信息，所以**这些留存率是上界，不是预期值**。`s1`（滑窗，无 oracle）与 `s6`（剪枝，无 oracle）的数字才是"无先验"参照。
- 语料是合成的，工具输出密度与真实仓库差异较大；绝对 token 数不可外推到生产。
- 判分是确定性的"针是否仍在上下文里"，**不衡量"模型是否还能用这些信息正确推理"**——后者需要 LLM 探针（见 §6.4）。
- 初版基准曾把 `toolPairIntegrity` 在 `s0`/`s6` 上误报为 BROKEN，根因是语料生成器有 5 条巨型 tool-result 没写 `toolCallId`，检测器退化成按数量比对。已修正语料并改为按 id 集合双向比对，现在每个场景都是 10 calls / 10 results / 0 orphan。**这条留在文档里，因为它同时说明了"检测器必须在已知无损的臂上先自证正确"。**

### 6.4 LLM 探针（已完成）

确定性指标只回答"信息还在不在"，不回答"模型还能不能用"。探针设计：5 个策略 × 3 个场景 × 2 轮 = 30 次调用，每场景每策略**批量成一次调用**返回 JSON 数组（而非 6 次单独调用），以压低成本与方差。实际执行 **30 次调用、0 失败**，累计输入约 841,840 tokens，走 harness 的 `workflow` `agent()`（本机无模型 API key，无外部账单）。判分用确定性 `expectedFacts` 子串命中（严格），并另给一列宽松判分（忽略"必须/保持/的"等虚词）估计同义改写造成的低估。

**结果**：

| 策略 | promptTokens | 针留存（确定性） | 探针准确率（严格） | 探针准确率（宽松） |
|---|---:|---:|---:|---:|
| `s2` 一次性摘要（oracle） | 27951 | 100.0% | **97.2%** | 97.2% |
| `s5` fold + 跨会话记忆 | 16923 | 97.2% | 95.8% | **98.6%** |
| `s3` 增量 fold | **16549** | 88.9% | 93.1% | 94.4% |
| `s4b` fold + 账本自动 recall | 20360 | 94.5% | 93.1% | 93.1% |
| `s1` 滑窗 | 58524 | 86.1% | 90.3% | 93.1% |

**按针类型拆开看，`constraint` 是全场最低的一列**（s1 69% / s3 81% / s4b 81% / s5 88% / s2 100%），`decision` 全部 93% 上下，`api-signature`/`root-cause`/`preference` 全部 100%。这独立复现了文献里的 Compaction Cliff：**约束句通常是"必须/不能/不得超过"这类短句，混在长进度汇报里，压缩时最先被牺牲**。s1 的 69% 是因为滑窗从尾部往前填，早期约束（`UV_THREADPOOL_SIZE=4`、`Node 22`）直接被挤出窗口；s5 的 88% 是因为它的记忆抽取用了"必须/决定/约定/以后都/不要用/改成"标记词，恰好把埋在闲聊里的约束句捞了出来。

**三个必须记下的、与直觉相反的结果**：

1. **最贵的策略不是最准的**。`s1` 吃满预算（58524 tokens）只有 90.3%；`s3` 只用 16549（省 72%）反而 93.1%。"多省 token 就多丢准确率"在这组语料上不成立——**预算不是准确率的瓶颈，"保留哪一段"才是**。滑窗丢的是开头的决策与约束，而 fold 的摘要区恰好把它们留下了。
2. **账本自动 recall 在准确率上是负收益**——这是对 §6.3 读法 3 的重要修正。`s4b` 比 `s3` 多花 3811 tokens，严格准确率**持平**（93.1% vs 93.1%），宽松判分反而**低 1.3pp**（93.1% vs 94.4%），尽管确定性针留存从 88.9% 升到 94.5%。也就是说：recall 确实把信息捞回了上下文，但**捞回的噪声稀释了关键约束**，模型答对的比例没有提高。→ 设计含义：自动 recall 默认应当是**保守的、按需的**，而不是"每轮都尽量多捞"。本插件的 `shouldRefreshInjection` 限流与"候选 <2 条不注入"正是这个方向的保守取值。
3. **记忆注入的代价不在 token 而在 KV 缓存**。`s5` 只比 `s3` 多 374 tokens，却把 `prefixStability` 从 59.5% 打到 17.2%——每轮在最前面插一段会变的记忆，等于每轮作废整个 KV 前缀。**省下的 token 会被重复 prefill 吃掉**，这是 §6.3 读法 4 的量化补充。

**局限**：判分器是子串匹配，对同义改写偏严（答案"抛 `RangeError`" vs expectedFact"抛错"），所以严格列应视为**下界**，真实值在严格与宽松之间；每（策略×场景）只跑 2 轮，方差未充分估计；`s2` 的 100% 约束命中是 oracle 特权，不代表真实摘要器能力；`s0`/`s4`/`s6` 不在探针集合内（规格只要求 S1/S2/S3/S4b/S5）。完整明细见 `bench/results/llm.md`、`bench/results/report.md` §4。


---

## 7. 安装、启用、回滚

### 安装
```
plugin_manager action=install_bundle target=D:\dev\dsh配置\plugins\dsh-context-fold
```

### 启用
`install_bundle` 会写 profile `package.json`（`dsh-context-fold: link:D:/dev/dsh配置/plugins/dsh-context-fold`）并加入 `dsh.profile.bundles`。若未自动启用，用 `plugin_manager action=set_bundle target=dsh-context-fold enabled=true`。

### 回滚
按成本从低到高：
1. **`mode: off`** —— 改 `cordis.patch.yml` 的 config，重启生效。零风险。
2. **`plugin_manager action=set_bundle target=dsh-context-fold enabled=false`** —— 停用但保留安装。
3. **`plugin_manager action=remove_bundle target=dsh-context-fold`** —— 完全移除。
4. **快照还原** —— 装前已存 `snapshots/<stamp>/`（`cordis.patch.yml`、`package.json`、`node_modules-list.txt`、`.dsh-market/state.json`）。把 `cordis.patch.yml` 与 `package.json` 拷回 profile 即可精确复原。

---

## 8. `engine` 模式路线图（未实现，但技术路线已探明）

如果将来要做真正的增量 fold 后端，绕开"不能导入"的约束有三条路，按可行性排序：

**路径 1：动态原型继承（推荐）**
在 `apply` 里 `ctx.get('compaction')` 拿到**活的实例**，用 `Object.getPrototypeOf(instance)` 拿到真实原型链，动态构造子类：

```js
const live = ctx.get('compaction')
const Base = live.constructor            // 运行时的真实类，无需 import
class FoldEngine extends Base {
  async summarize(input, agent, signal) { /* 我们的实现 */ }
}
```

然后替换服务。**待验证**：cordis 是否允许同名服务二次 `provide`（可能抛 `duplicate service`），以及 `ctx.get` 在 `apply` 阶段能否拿到实例（可能因加载顺序拿不到）。这两点必须在动手前用一个探针确认。

**路径 2：自带 Service 基类**
若 `cordis` 不可导入但 `ctx.provide(name, value)` 是公开 API，可用鸭子类型注册：

```js
ctx.provide('compaction')   // 声明
ctx.set('compaction', impl) // 注入
```

风险：宿主若有 `instanceof CompactionEngine` 检查会失败。**未验证**宿主是否做此类检查。

**路径 3：只做 policy 层（最稳）**
完全不碰 `compaction`，改用 `agent/pre-step` 改写进入 step 的消息列表——即"在压缩器看到之前先自己折一遍"。这是 ACP 的同款手法，零服务冲突。缺点是无法复用宿主的括号/锁/配对校验，需要自己保证 `toolPairingBalanced*` 语义。

**增量 fold 的算法设计（三路通用）**：
- 布局 = 折叠摘要区（前缀）+ 最近原始工作区（保留 `retainTokens`，默认 40000）+ 首末消息保护；
- 触发 = `tokenMeter.measure(session) > thresholdRatio × 窗口` **且** 「上次折叠以来新增且已消费」的增量 ≥ `growthTokens`（默认 24000）——双门控，避免小会话被反复折叠；
- 摘要目标 ≤ `maxSummaryTokens`（默认 1800）；
- 边界用 `toolPairingBalancedBefore/After` 求最近的安全切点；
- 收敛判据照抄 basic：摘要不比原文小就放弃。

---

## 9. 已知限制

1. **无法与其他开源 agent 做端到端实测**——环境不允许安装运行。基准用"策略移植 + 合成语料"替代，结论是**策略间相对比较**，不是绝对能力排名。
2. **记忆抽取依赖 `llm` 服务**，缺失时能力 C 整块不可用（能力 A/B 不受影响）。
3. **BM25 是词法检索**，同义改写召回弱；中文 bigram 对长句的语义匹配有限。这是有意的取舍——换向量检索需要嵌入模型与额外依赖，与"零依赖"原则冲突。
4. **`engine` 模式未实现**，见 §8。
5. **spill 文件无自动清理**，长期使用需手动清理 `<DSH_HOME>/context-fold/spill/`。已在 README 说明。
6. **记忆库曾全局无项目分区——已修复（排序 v0.1.1 / 来源 v0.1.3）。** 原始缺陷：存储路径固定为 `<DSH_HOME>/context-fold/memory.jsonl`，注入时按 BM25 + 时间衰减排序，**不区分当前会话属于哪个仓库**。开发本插件的过程中就复现了这个问题：本会话的 `system-prompt/assemble` 注入里出现了**另一个项目**的记忆条目（帧解析 bug、CI 线程池规格、日志不得打印 token 等），与本任务完全无关，纯属占位噪声。修法分两步落地：
   - **v0.1.1（排序）**：写入时给每条记忆打 `scope: { cwd, repo, branch }` 标签；注入/召回时按 `scopeMode` 处理：`prefer`（默认，跨作用域乘 `scopeWeight` 降权但保留）/ `strict`（完全排除跨作用域）/ `off`（旧的全局行为）。
   - **v0.1.3（来源，关键）**：v0.1.1 的 `scope` 取自 `detectScope(process.cwd())`，但**桌面宿主的进程 cwd 是 profile 目录**，导致所有项目塌缩成同一作用域——排序逻辑白写。改为取 `session.header.cwd`（宿主校验过的绝对项目路径），并在会话切换时调 `memory.setScope()` 更新、同时清空注入缓存。缺陷是在真实宿主里跑起来后发现的，单测预不见；现已补 `test/scope.test.mjs` 三个用例锁死来源、退化与缓存失效。
   - `repo` **刻意取 `basename(cwd)` 而不是 git 仓库根**——实测踩过：本工作区向上找到的是 `D:\dev\.git`，那个仓库覆盖整个 `dev` 目录（多个互不相干的项目），用 git 根会把它们误判成同一个仓库。git 根只用来读分支名，不参与亲和度计算。
   - **无 scope 的历史记忆不会被误杀**：`strict` 下缺少 `scope` 字段的旧条目视为"未知来源"，仍可召回。
   - 测试覆盖 prefer 排序、strict 过滤、off 退化、旧数据兼容、header.cwd 来源、setScope 缓存失效。
   - **遗留数据**：v0.1.3 之前写入的 36 条记忆带有错误的 `scope`（指向 profile 目录）。已在部署时剥离该字段，让它们退回"未知来源"中性档，而不是猜测一个项目路径。对比之下 OpenViking 用 `viking://` 命名空间做了这件事，本插件因为要"零外部服务"而退化成单库，代价就是必须自己补这层作用域逻辑。
7. **`compaction/summary-error` 的 `recover` 钩子不能乱接。** 调研（`context-compression-memory-survey.md` §6.5.5）发现宿主的恢复逻辑在 `for(;;)` 循环里，除成功外唯一退出条件是 `recover` 返回 `false`——**任何恒返回 `true` 的实现都会造成压缩死循环**。本插件不注册这个钩子，刻意回避。
8. **不要绕过 `compactCheckpointSource` 自己往 `user/message` 塞纯文本摘要。** DSH 目前属于 Compaction Laundering 分类里的"0% 组"（checkpoint 带 `source: compactCheckpointSource(...)` 且 `user/message` 带 `sourceEventSeqs`），但第三方插件若自己拼一个纯文本摘要塞进去，就会把它拖进"87–100% 伪造指令洗白"组。本插件**从不创建 `user/message`**，只做 `tools/post-execute` 的内容改写与账本记录，从机制上不触碰这个风险面。
9. **不要在串行事件里 `await` 模型调用——已修复（v0.1.2）。** 原始缺陷：`agent/turn-stopping` 是**串行**事件，宿主等监听器 resolve 才结束本轮；v0.1.1 及以前在这里直接 `await extractMemories(payload)`，等于**每一轮都给任务加一次完整模型往返**（抽取 prompt + 最多 800 output tokens）。这与用户反馈"下载量最多的 dsh 压缩插件会极大加长任务时间"是同一类错误——billion-context 的机制是把模型调用改道经本地 HTTP 代理（`/bili/origin` relay），每次调用多一跳；本插件则是在串行钩子里等模型。修法：
   - 默认 `memory.extractMode: 'background'`——监听器立即返回，`void run(controller.signal)` 在后台跑，卸载时统一 abort。
   - 必须自建 `AbortController`：`payload.signal` 在本轮结束时就 abort，直接传给后台任务会让抽取刚启动就被取消。
   - 同一 session 单飞去重（`inflightExtractions`），重复触发只记 `extractSkipped`。
   - `memory.minTranscriptChars`（默认 400）：过短回合直接跳过，连一次调用都不发。
   - `blocking` 仅保留给需要确定性时序的场景（测试/脚本），`off` 彻底关闭。
   - 测试用 `delayMs: 120` 的假 LLM 断言监听器在 60ms 内返回，并覆盖 blocking/off/短转录三条分支。

---

## 10. 参考

- `D:\deepseek-h\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-compaction\lib\index.js`（契约、`toolPairingBalanced*`、`ManualCompactionError`）
- `D:\deepseek-h\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js`（`summarize()` 钩子、括号提交、收敛判据）
- `D:\dev\dsh配置\plugins\dsh-hard-gate\lib\index.js`（本地链接插件的导入约束与降级模式）
- `C:\Users\YYF\.dsh\profiles\desktop\node_modules\billion-context\dsh.bundle.patch.yml`（ACP 的共存手法）
- 调研报告：`context-compression-memory-survey.md`
- 基准结果：`bench/results/report.md`
