# dsh-context-fold

DSH（DeepSeek Harness）的**上下文折叠**插件。三块互补能力：把超长工具结果确定性地折叠落盘、给 compaction 折叠建可检索的账本、跨会话沉淀并注入记忆。

它与已装的 [billion-context (ACP)](https://github.com/ranxianglei/billion-context) **互补**，不是替代。

---

## 一、为什么需要它

长会话里 context 会被三类东西吃掉：

1. **一次性的巨大工具输出**（跑测试、读大文件、`git diff`）——看完就没人再需要全文，但它一直占着 context。
2. **ACP 折叠掉的历史**——ACP 把旧内容遮蔽以省 token，代价是那些内容之后**再也搜不到**。
3. **跨会话的经验**——上个会话定下的技术决策、踩过的坑，新会话完全不知道。

本插件分别对应：**A 折叠**、**B 账本**、**C 记忆**。

---

## 二、能力

### A. 确定性工具结果折叠（`tools/post-execute`）

工具结果文本超过 `pruner.maxChars`（默认 8000 字符）时：

- 完整原文落盘到 `<DSH_HOME>/context-fold/spill/<id>.txt`；
- 上下文里只保留 **head**（默认 2000 字符）+ **tail**（默认 2000 字符）+ 一行标记：

  ```
  [context-fold: 已折叠 <id>，原文 <bytes> 字节，用 context_fold recall <id> 取回]
  ```

- **只改写结果内容，绝不删除或替换事件**。tool-call / tool-result 配对因此永远完整，会话仍可回放、可审计。
- 已经折叠过的文本不会二次折叠（靠标记行识别）。
- 工具**报错**的结果（`result.isError === true`）不折叠——错误信息通常很短，而且往往是关键线索。
- 计数：累计折叠次数、估算节省 token（`chars / 3.5` 粗估，仅用于量级参考，不是精确计费口径）。

### B. 折叠账本 + 回捞（`session/event`）

监听 `session/event`，当事件类型是 `compaction/summary` 时，把被遮蔽区间追加到
`<DSH_HOME>/context-fold/ledger.jsonl`：

```json
{ "blockId": "...", "startSeq": 10, "endSeq": 40, "shadowedTokenCount": 1234,
  "summary": "...", "ts": 1700000000000, "summarySeq": 42, "sessionId": "..." }
```

> **字段来源说明（重要）**：真实的 `compaction/summary` payload 里**没有** `blockId`，也没有顶层
> `startSeq` / `endSeq`。实际结构是
> `{ compactionId, summary, shadowedRange: { start, end }, shadowedSeqs, shadowedTokenCount, provider, model, ... }`。
> 本插件做映射：`blockId ← compactionId`、`startSeq ← shadowedRange.start`、`endSeq ← shadowedRange.end`、
> `ts ← event.time`；另外补充 `summarySeq ← event.seq`、`sessionId ← session.id` 便于精确定位。

`context_fold recall <id|关键词>`：

- 先按 **id 精确匹配**（`blockId` 或 `summarySeq`）；
- 否则对 `summary` 做 **BM25**（`k1=1.2`, `b=0.75`，中文按**字 bigram** 切分）返回 top-k 摘要片段及其 seq 范围。

### C. 跨会话记忆（写入 + 注入）

**写入**（`agent/turn-stopping`）：每轮最多触发 **1 次** `llm.stream()`，让模型从本轮对话抽取

```json
[{ "type": "fact|decision|lesson|preference", "text": "...", "evidenceSeq": 12 }]
```

- 每轮最多 6 条；**不足 2 条不落库**（避免噪声变"记忆"，也避免每轮都写盘）；
- 存 `<DSH_HOME>/context-fold/memory.jsonl`，字段 `{ id, type, text, ts, evidenceSeq, hits, lastHitAt, scope? }`；
- `llm` 服务不可用时**整块静默禁用**，不影响其它能力。

**延迟（v0.1.2 关键修正）**：`agent/turn-stopping` 是**串行**事件，宿主会等监听器 resolve 才结束本轮。
早期版本在这里 `await` 抽取，等于**每一轮都多付一次完整模型往返**。现在默认
`memory.extractMode: background`——监听器立即返回，抽取在后台跑（同一 session 单飞去重，
卸载时统一 abort）；需要确定性时序时才用 `blocking`。另外 `minTranscriptChars`（默认 400）
让过短的回合直接跳过，连一次调用都不发。

**注入**（`system-prompt/assemble`）：追加一个 context section，用 **BM25 + 时间衰减**
（半衰期 30 天，`score = relevance + 0.5 × recency`）选 top `injectLimit`（默认 6）条，
总长不超过 `maxInjectTokens`（默认 1200 token，按 3.5 chars/token 截断）。

排序**必须稳定**：先按分数降序，同分按 `id` 升序。

**缓存策略（关键）**：system prompt 是 provider 前缀缓存的核心。如果每一步都按最新记忆重新渲染，
前缀就会不停变化，缓存命中率归零。因此注入内容**只在**下面两种情况刷新：

1. 新增记忆数 **≥ 2**；
2. 发生过**显式 recall**。

其余时候复用上一次渲染好的同一个字符串，保证前缀稳定可缓存。该逻辑在 `lib/memory.js` 与
`lib/core/decay.js` 的 `shouldRefreshInjection()` 里，并有单元测试覆盖。

**项目分区（`scope`，v0.1.1 引入、v0.1.3 修对来源）**：记忆库是单个全局文件，但记忆有项目归属。写入时每条打
`scope: { cwd, repo, branch }`，注入与 `recall` 时按 `memory.scopeMode` 处理：

| 模式 | 行为 |
|---|---|
| `prefer`（默认） | 按亲和度加权：同 cwd ×1.0 / 同 repo ×0.85 / 无 scope ×0.5 / 跨 repo ×0.25，再乘 `scopeWeight`（默认 0.35） |
| `strict` | 亲和度 < 0.5 直接丢弃；无 scope 的历史条目保留 |
| `off` | 不处理作用域，退化为 v0.1.0 的全局行为 |

`repo` 取 `basename(cwd)` 而**不是** git 仓库根——实测本工作区向上找到 `D:\dev\.git`，
那个仓库覆盖整个 `dev` 目录，用 git 根会把多个不相干项目误判成同一仓库。

**`cwd` 从哪来（v0.1.3 修正）**：取 `session.header.cwd`，**不是** `process.cwd()`。
在 DSH 桌面宿主里进程 cwd 是 profile 目录（实测 `C:\Users\YYF\.dsh\profiles\desktop`），
用它会让所有项目的记忆塌缩成同一个作用域——v0.1.1 只修了排序、没修来源，v0.1.3 才修对。
`session.header.cwd` 是宿主在创建会话时校验过的绝对路径（`sessions.create` 的
`meta.cwd` 传非绝对路径会直接抛错）。没有 `header.cwd` 的会话（例如子代理）退化为
装配时的初始作用域。

---

## 三、工具：`context_fold`

| `action` | 作用 |
| --- | --- |
| `status` | 各能力是否就绪 + 计数器（折叠次数、账本条数、记忆条数、估算节省 token） |
| `recall` | 参数 `query`（折叠块 id 或关键词）：同时搜账本、记忆、spill 原文 |
| `prune` | 对当前会话手动跑一次折叠扫描，返回折叠/落盘了几条 |
| `ledger` | 列出最近 N 条账本条目 |

> `prune` 的语义说明：会话事件是 **append-only** 的，历史事件无法就地改写。所以 `prune` 做的是
> "把当前会话里超过阈值的工具结果落盘"，让它们之后可以通过 `recall <id>` 取回；它不会、也不能
> 修改已经写入的历史事件。新产生的工具结果由能力 A 自动折叠。

---

## 四、配置项

写在 `cordis.patch.yml` 的 `config` 下（patch 会**整体替换** `config` 对象，所以需要哪些键就都写上）：

```yaml
mode: complement          # complement | off
pruner:
  enabled: true
  maxChars: 8000          # 超过这个字符数才折叠
  keepHead: 2000          # 保留开头多少字符
  keepTail: 2000          # 保留结尾多少字符
memory:
  enabled: true
  injectLimit: 6          # 最多注入几条
  maxInjectTokens: 1200   # 注入总预算（token，按 3.5 chars/token 换算）
  decayHalfLifeDays: 30   # 时间衰减半衰期
  scopeMode: prefer       # prefer | strict | off，记忆的项目分区策略
  scopeWeight: 0.35       # 仅 prefer：跨作用域记忆的分数折扣
  extractMode: background # background | blocking | off，默认不阻塞 turn
  minTranscriptChars: 400 # 本轮转录短于此值则跳过抽取（省一次模型往返）
ledger:
  enabled: true
  maxBlocks: 2000         # 账本最多保留多少条（超出裁剪最旧的）
```

约束：`keepHead + keepTail` 必须**小于** `maxChars`，否则永远不会折叠（`status` 与 `validateConfig` 会报出来）。

配置由 `lib/config.js` **手工校验**并补默认值：未知键忽略并 warning，类型错误回退默认值，数值收敛到下界。
**任何非法配置都不会让插件加载失败。**

---

## 五、与 billion-context (ACP) 的关系

| | ACP (billion-context) | dsh-context-fold |
| --- | --- | --- |
| 目标 | 主动折叠旧内容以**省 context** | 折叠超长工具输出 / 让被折叠内容**仍可检索** / 跨会话**记忆** |
| 折叠粒度 | 会话块（block） | 单条工具结果（确定性的 head+tail） |
| 折叠后能否找回 | 依赖 ACP 自身的回捞 | 本插件账本记录 seq 范围 + 摘要，`recall` 可搜 |
| 对模型的影响 | 减少可见 token | 减少可见 token，同时在 system prompt 里补少量长期记忆 |

两者可以同时启用：ACP 负责大块历史压缩，本插件负责"单次巨大输出"和"跨会话记忆"。
`mode: off` 只会关掉本插件，不影响 ACP。

**关于"压缩插件拖慢任务"**：ACP 的实现方式是把模型调用改道经本地 HTTP 代理
（`/bili/origin` relay），每次调用多一跳，折叠也在代理侧完成——这是它下载量第一
（约 178 万）却也被用户吐槽"极大加长任务时间"的机制来源。本插件**不在请求路径上**
做任何事：没有代理、不改 `agent/request`、不碰 `llm.stream` 的参数；唯一可能进入
关键路径的是 `agent/turn-stopping` 的抽取，而它从 v0.1.2 起默认 `background`，
监听器立即返回。**本插件对每轮延迟的增量目标是 0。**

---

## 六、数据目录

```
<DSH_HOME>/context-fold/
  spill/<id>.txt      # 被折叠的完整原文
  ledger.jsonl        # compaction 折叠账本
  memory.jsonl        # 跨会话记忆
```

`DSH_HOME` 取环境变量 `DSH_HOME`，未设置时回退到 `~/.dsh`。

---

## 七、安装 / 卸载 / 回滚

**安装（推荐，直接从 GitHub 装）**：

```bash
dsh plugin --profile desktop add github:yyfdfsyyf-source/dsh-context-fold
```

装完重启 DSH 即可。`package.json` 里声明了 `dsh.bundle.patch`，插件管理器会自动应用
`cordis.patch.yml`，**不需要手工改 profile 的 `cordis.yml`**。

**本地开发安装**（改代码即时生效，适合二次开发）：

```bash
# 在 profile 目录下
ln -s /path/to/plugins/dsh-context-fold node_modules/dsh-context-fold   # Windows: mklink /D
```

本地链接安装后，仍需让 bundle patch 生效（`dsh plugin` 命令会做这件事；手工安装时把
`cordis.patch.yml` 的 `insert` 一条 `context-fold` 合并进 profile 的 `cordis.yml`）。

**回滚（三种粒度，从轻到重）**：

1. **只关功能、保留插件**：把 `config.mode` 改成 `off`。三块能力全部静默禁用，
   `context_fold` 工具仍可用（`status` 会显示 `mode=off`），不写任何文件。
2. **停用插件**：从 `cordis.yml` 里删掉（或 `disabled: true`）`context-fold` 这条 insert，重启。
   已产生的 `ledger.jsonl` / `memory.jsonl` / `spill/` 保留在磁盘上，不删不读。
3. **完全卸载**：删掉 `node_modules/dsh-context-fold` 符号链接，再删 `<DSH_HOME>/context-fold/` 整个目录。

本插件**不修改**任何其它插件、profile 或 bench 目录；所有落盘都在 `<DSH_HOME>/context-fold/` 下。

---

## 八、开发与测试

```bash
npm test          # = node --test "test/*.test.mjs"
```

**81 个用例，全部通过**（约 1.5s），分三层：

| 文件 | 用例数 | 测什么 |
|---|---:|---|
| `test/core.test.mjs` | 44 | 纯函数，不碰 `ctx`：BM25 排序稳定性与中文 bigram、`decideFold` 边界、时间衰减单调性、区域切分、配置校验、账本字段映射、记忆解析 |
| `test/integration.test.mjs` | 34 | 通过公开入口 `apply(ctx, config)` 装配，用 mock ctx 驱动宿主事件、真实临时 `DSH_HOME` 落盘，验证三块能力端到端闭环、记忆作用域（prefer/strict/off）、**turn-stopping 不阻塞**（含 `background`/`blocking`/`off` 三模式与短转录跳过）以及所有降级路径 |
| `test/scope.test.mjs` | 3 | 作用域**来源**：写入用 `session.header.cwd` 而非 `process.cwd()`、无 header 时退化、`setScope` 改变排序并让注入缓存失效 |

集成测试同时充当**最小宿主契约文档**：mock ctx 只实现插件真正用到的四个成员 `on` / `get` / `effect` / `logger`——插件对宿主的依赖面就这么窄。

> 注意：本机 Node 24.22.1 上 `node --test test/`（传**目录**）会报 `Cannot find module`，
> 这是 Node 测试运行器在该版本对目录参数的行为，与本插件无关（任意目录都复现）。
> 请用上面的 glob 形式或 `npm test`。

`lib/core/` 下的纯函数（`bm25`、`prune` 判定、`decay` 打分、`region` 选择、`tokens`）
**不依赖 ctx**，可被基准测试直接 `import`：

```js
import { search } from 'dsh-context-fold/core/bm25'
import { decideFold } from 'dsh-context-fold/core/prune'
import { rankMemories, selectWithinBudget } from 'dsh-context-fold/core/decay'
import { selectKeptRegions } from 'dsh-context-fold/core/region'
```

---

## 九、设计约束（为什么代码长这样）

- **禁止裸导入 `@deepseek-ai/*` 或 `cordis`**。插件通过符号链接装进 profile 的 `node_modules`，
  Node 按 **realpath** 解析，真实路径落在 workspace 下，裸导入会 `ERR_MODULE_NOT_FOUND` 并让插件
  加载失败。因此全部只用 `node:` 内置模块 + 传入的 `ctx`。
- **不 `export const Config`**。那需要 schemastery，会重新引入硬依赖。配置在 `lib/config.js` 手工校验。
  `lib/config.js` 里保留了**可选**的 `loadSchema()`（`createRequire` + `try/catch`）路径：能加载到就额外做一次
  交叉校验，加载不到就纯手工——两种情况下模块都能正常加载。
- **所有注册都走 `ctx.effect(() => cleanup)` 或 `ctx.on(...)`**，卸载时干净释放。
- **任何 LLM / IO 失败都只降级，永不抛错阻塞 turn**。
- **不要在串行事件里 `await` 模型调用**。`agent/turn-stopping`、`tools/pre-execute` 这类
  串行/前置钩子，宿主会等监听器 resolve 才继续；在里面等一次 LLM 等于给每一轮加一次完整
  往返。要抽取就丢后台（`extractMode: background`），并自己拿 `AbortController`——
  `payload.signal` 在本轮结束时就 abort 了，不能直接交给后台任务。

---

## 十、相关文档

- [`docs/design.md`](docs/design.md) — 设计文档：宿主扩展点、DSH 压缩契约（源码级）、
  三块能力的数据流与失败模式、自建基准的方法与结果、安装与回滚、已知限制。
- [`docs/ecosystem-survey.md`](docs/ecosystem-survey.md) — 生态调研：20+ 个开源 agent 与
  50+ 个 DSH 插件在压缩 / 记忆上的实现对照，含证据分级、真实故障案例与运行时开销分析。
