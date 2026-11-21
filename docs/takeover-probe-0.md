# 阶段 0 可行性探针报告：能否接管 `compaction` 主服务

日期：2026-11-21　范围：**纯只读**——不改运行环境、不关 bili、不装包。
方法：读当前安装版源码（Cordis 4.1.0、billion-context 0.1.214）与 dsh-doc 参考文档；尝试 `dsh --dump-config`（只读）。

## 结论（一句话）

**直接 `ctx.provide('compaction')` 同名覆盖不可行**；唯一可行路径是 **bundle patch 把 preset 的 `compaction` group 内 `compaction-basic` 行替换为本插件 engine**，并同时关闭 `bili-native`（保留 gate）。这条路径可行但代价高，且当前 Electron 管理的 profile 无法直接 dump-config / 手写 patch，需要在隔离 bundle 里验证。

## 决定性证据

### 1. 同名 provide 抛错（`ctx.provide('compaction')` 死路）

`@deepseek-ai/cordis/src/reflect.ts:303-305`：

```ts
if (this.store[key]) {
  throw new Error(`service "${name}" has been registered at <${this.store[key].ctx.fiber.name}>`)
}
```

默认 `compaction-basic` 已在 preset 的 `compaction` group（已 `isolate: {compaction: true}`）注册，本插件再从别处 provide 同名 → 直接抛错。

### 2. `ctx.set` 跨 fiber 抛错（替换死路）

`@deepseek-ai/cordis/src/reflect.ts:268-279`：

```ts
if (!impl) throw new Error('cannot set property "${name}" without provide')
if (impl.ctx.fiber !== this.ctx.fiber) throw new Error('cannot set property "${name}" in multiple fibers')
```

`set` 只能由**提供该服务的同一 fiber** 调用。别的插件无法用它夺取服务。
（`:44` 签名 `provide<K extends string & keyof this>(name, value): () => void`，`:46` 非类型化重载。）

### 3. 唯一可行路径：patch 占槽（有先例）

`billion-context/docs/configuration.md:2538` 明确记载先例 `dsh-live-compact`：

> "its bundled `cordis.patch.yml` disables the stock `compaction-basic` row and registers its own engine row, and its preset takeover renames the preset's compaction row to itself"

同文档 `:2541`、`:2563-2605` 给出完整配方：

```yaml
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      # …完整快照，逐字不变…
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true
          toolResultPruner: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
            disabled: true          # 腾槽
          - id: dsh-context-fold-engine
            name: 'dsh-context-fold'  # 本插件占槽
          # …其余逐字不变…
```

关键约束（A 级，文档 `:2597-2606`）：
- `config` **替换而非合并**——必须复制 preset 完整 `plugins` 列表（35 项量级），漏一项就静默丢失 persona/tools。
- 嵌套行不能用 `preset-standard.compaction.compaction-basic` 这种点路径定位（会 `patch: entry not found`，无效果）。
- 快照**冻结在复制时的 dsh 版本**——DSH 升级改了 preset 行，旧快照会让新插件永不加载。必须每次升级重 dump、diff、重复制。
- 必须**四个 preset 都改**：`preset-standard` / `preset-ptc` / `preset-cordis`（`preset-minimal` 无 compaction group），否则切模式会复活 native compaction。
- 同时要关闭 `bili-native`（`disabled: true` 或环境变量 `BILLION_CONTEXT_PLUGIN=0`），**但绝不能关 `bili-compaction-gate`**（会重现 session 创建卡死，见 `:2549`）。bili gate 只认 stock 行名，对我们自己命名的 engine row 结构性失明（`:2538`），但 422 wire guard 仍在——需 `BILI_DSH_AUTHORED_COMPACTION` 相关路径验证。

### 4. 备选机制 `isolate`（理论可行但消费方不可见）

`@deepseek-ai/cordis/src/context.ts:121-125` `isolate(name, label)` 创建子 context，让同名服务在不同 isolation scope 解析到不同 label。
但宿主消费方（agent loop）在 root scope，读不到子 realm 的实现。**除非**整个 agent preset 连同消费方一起 isolate 到同一 realm——这正是上面 patch 配方里 `isolate: {compaction: true}` 做的事。所以 isolate 不是独立方案，而是 patch 占槽方案的底层机制。

## 环境限制（本次探针实测）

- `dsh --profile desktop --dump-config` → `error: profile "desktop" is managed exclusively by the Electron application`。**无法从 CLI dump** 出 shipped preset 的完整 config 快照。
- 按 dsh-doc 约束，也**不能手写** profile 的 `package.json` / `cordis.patch.yml`；只能通过 workspace bundle + `plugin_manager install_bundle`。
- `dsh-live-compact` 包不在本机（`C:\Users\YYF\.dsh` 下 glob 无结果），无法直接读它的 patch 来抄结构。

## 对四维度目标的影响判断

| 维度 | 占槽方案的预期 |
|---|---|
| 长会话不劣化 + 节省率 | 需重建整个 checkpoint 事务（P0-1~5，2-3 周），理论可达 >55% |
| 信息可恢复性 | 已有 spill 逐字节还原可复用；需把 ledger 重构为 checkpoint 感知 |
| 记忆质量 / 跨会话复用 | 现有 memory 层可直接迁入，是四层里唯一已完成的 |
| 延迟与成本 | 自建 LLM 摘要调用有成本；需 benchmark M7 实测 |

## 建议下一步（待用户选择）

1. **方案 A（推进占槽）**：在 workspace 建隔离 bundle，用 `dsh-web-app` 的 shipped preset 文件（`presets/standard.patch.yml`，asar 内可读）构造完整 config 快照，实现 `CompactionEngine` 三方法骨架 + patch，在**新会话**里验证占槽是否成功（不改现有 profile 行为）。风险：需要重启宿主、patch 快照维护成本高。
2. **方案 B（退回 policy 层）**：不碰主控权，继续在事件层强化折叠率/账本/记忆，用 benchmark 证明四维度提升，作为"事实上的上下文管理"而非"名义上的主后端"。
3. **方案 C（暂停）**：保留报告，等 DSH 升级提供更干净的 service 替换接缝再动。

## 探针合规性

本次全程只读：未改任何 profile 文件、未装/卸 bundle、未关 bili、未重启宿主。唯一写入是本报告文件（workspace 内）。
