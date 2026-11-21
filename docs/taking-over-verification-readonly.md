# 阶段 1 只读宿主核验记录

日期：2026-11-21。目标：在不改 profile、不重启宿主的前提下，判断占槽 patch 的必要性与风险。
结论一句话：**契约层面接口稳定且明确；但"当前 compaction 槽位由谁占"无法靠 inspect 定性——结合磁盘 A 级证据，bili 已实际接管 compaction，占槽必须走"全接管"变体（关 bili-native + 保留 gate + preset 插 engine），与草稿一致。**

## 一、方法

使用 `cordis_inspect_query`（host / client 两个 plane）查 Service 与 Event catalog；
查 profile 磁盘 patch 与已装 bundle 的 patch 文件。全程只读。

## 二、能确认的（A 级）

1. **`compaction` 服务契约存在且稳定**（host Service catalog）：三方法齐全——
   `compactIfNeeded(agent, trigger, signal)`、`compactNow(agent, signal, sourceCommandId?)`、
   `compactRegion(start, end, agent, signal?)`。与插件自包含引擎的实现签名一致。
2. **`compaction/summary-error` 事件存在**（host Event catalog，waterfall）：
   `'(compaction/summary-error'(payload:{session,sourceEventSeqs,error,signal?}, next)=>boolean): boolean`
   ——即引擎的 recover 通路有宿主挂载点。
3. **`toolResultPruner` / `tokenMeter` / `systemPrompt` 契约在册**：与路线图四层矩阵的接口假设一致
   （tokenMeter 已含 `contextPressure`，systemPrompt 已含 `suppressRuntimeContext` / `refreshContext`）。
4. **profile 主 patch（`C:\Users\YYF\.dsh\profiles\desktop\cordis.patch.yml`）无 compaction 相关自定义 entry**
   （grep 仅命中无关的 `thinking-effort-compaction`）——占槽 patch 尚未落到真实环境，
   engine 模式默认关闭，当前会话不受影响。

## 三、不能确认的（工具能力边界，非结论）

- `cordis_inspect_query` 的 `input` 参数在本 harness 恒被拒 `"input" must be an object`
  （传 `{}`、`{"service":"compaction"}` 均失败），无法用单服务精确查询。
- Service / Event catalog 是**声明式能力目录**，只列契约签名，**不列当前哪个 loader entry 实际提供该服务**。
  因此 inspect 无法回答"compaction 槽位现在空着 / 被 dsh-compaction-basic 占 / 被 bili 占"。
- 结论：纯只读 inspect **不足以判定占槽是否空位**，必须结合磁盘证据 + 最终重启实测。

## 四、结合磁盘证据的关键判断（改写"空位"假设）

来自 `billion-context/docs/configuration.md`（已在前序调研逐行读过，A 级）：

- bili 的 gate overlay（独立 always-on entry `bili-compaction-gate`）在 load-time 把 preset 的
  `dsh-compaction-basic` / `dsh-command-compact` 行标 `disabled:true`（`:2545`）。
- `BILI_ALLOW_DSH_COMPACTION` / `dsh.allowDshCompaction` 已在 #3666 删除；dsh native compaction
  被 wire guard **无条件拒绝**（422 `dsh_compaction_refused`，`:126/:127/:385`）。
- 替代开关 `dsh.authoredCompaction` / `BILI_DSH_AUTHORED_COMPACTION` **默认 true**（#3901 flip）：
  bili **本地伪造** compaction 的 summarize 答复（folded snapshot + identity header，零 egress，
  #3723/#3733），设 false 恢复 #1729 拒绝路径。
- 先例 `dsh-live-compact`（`:2538`）：禁用 stock compaction-basic 行 + 注册自有 engine row +
  preset takeover 把 compaction row 改名为自己；bili overlay 只认 stock 行名 → 结构性失明。

**判断**：bili 并非"不占槽"，而是用 wire guard + 伪造答复**实际接管了 compaction 行为**。
因此补丁必须走草稿里的**变体 B（全接管）**：
1. preset compaction group 内 `compaction-basic` 标 `disabled:true`；
2. 插入 `context-fold-engine` entry（`mode: engine`）；
3. 关闭 `bili-native`，但**保留 `bili-compaction-gate`**（关掉会重现 session 创建卡死，`:2549`）；
4. 可选设 `BILI_DSH_AUTHORED_COMPACTION=0` 关闭 bili 伪造。

这与 `docs/takeover-patch.example.yml` 草稿一致，无需改设计。

## 五、仍未覆盖的风险（只能重启实测）

- bili gate overlay 与自定义 engine row 的实际交互（是否真正"结构性失明"）。
- 双后端在 Cordis 同名注册时的优先级（阶段 0 已证明直接同名 provide 抛错，占槽是绕开它的唯一路径）。
- preset 快照与 DSH 版本绑定：宿主为 `0.2.2-rc.3`，升级后须重 dump/diff/复制。
- 回退：移除 profile 中的占槽 patch 行并重启即可恢复到当前 complement 行为。

## 六、结论与建议

阶段 1 代码已完整交付（v0.3.0，102/102 测试 + 25/25 patch 断言，已推送 + Release）。
只读核验确认占槽路径正确、接口稳定、草稿策略与 bili 实际机制一致。
**在"不重启"约束下，最高价值的下一步是阶段 2：让引擎摘要算法真正超越官方**
（当前引擎是逐行移植、效果与官方等价；主目标是"更好效果"）。等实现稳定后，
再一次性做"重启占槽 + 效果验收"的端到端验证。
