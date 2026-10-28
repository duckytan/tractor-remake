# smallnest 插件桥 · 单局冒烟

把本项目的 AI 接进 smallnest 的引擎，**让它的规则当裁判、它的机器人当对手** ——
这是目前唯一可行的"外部锚"（方案与审计见 `docs/41` / `docs/42`）。

> **当前阶段：冒烟**。只做「最小的单张/对子、永不甩牌」，目的是先证明管道通畅。
> 冒烟过了再接正式 AI（见文末）。

---

## 为什么先冒烟

`smallnest` 的 `Algorithm.cs` 里，插件出的牌要先过 `TractorRules.IsInvalid` / `CheckSendCards`；
**一次不合法就 `UserAlgorithms[seat] = null`（永久踢掉）并静默回退内置算法**，界面上毫无提示。
所以顺序必须是：**先证明"出的牌不会被拒"，再谈胜率**（`docs/42` F1）。

---

## 一、编译插件（需要你在本机执行一次）

沙箱会拦截编译器，这一步要在你自己的终端里跑。用 .NET Framework 4.x 自带的编译器即可：

```bat
cd /d D:\WorkBuddy\逆向REA\tractor-remake\tools\smallnest-bridge\plugin

"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" ^
  /target:library /out:RemakeAiPlugin.dll RemakeAiPlugin.cs ^
  /reference:"D:\WorkBuddy\逆向REA\reference\smallnest-Tractor\release\Kuaff.Tractor.Plugins.dll"
```

> 如果 `Framework64` 下没有编译器，换 `Framework`（32 位）同一路径再试；
> 或直接装一次 Visual Studio Build Tools。

## 二、部署

```bat
mkdir "D:\WorkBuddy\逆向REA\reference\smallnest-Tractor\release\plugins"
copy RemakeAiPlugin.dll "D:\WorkBuddy\逆向REA\reference\smallnest-Tractor\release\plugins\"
```

插件按 `plugins\*.dll` 反射加载（`SelectUserAlgorithm.cs:82-108`），**不需要改它源码或重编译主程序**。

## 三、跑一局

1. 先验管道（不用开 C#，在仓库根目录）：
   ```bash
   npx vite-node tools/smallnest-bridge/bridge/selftest.ts      # 牌 id 映射自检（23 项）
   npx vite-node .tmp/bridge-pipe-test.mjs                       # 行协议冒烟（3 个场景）
   ```
2. 启动 `reference\smallnest-Tractor\release\Tractor.exe`
3. 菜单 →「选择算法」→ 四个座位各选 `TractorRemake-AI` → 确定
4. 菜单勾上「**机器人罗伯特**」（= `gameConfig.IsDebug`，让人类的座位也自动出牌）
5. 开一局，等它自己打完

## 四、验三件事（这是冒烟的全部目的）

```bash
npx vite-node tools/smallnest-bridge/bridge/checkKick.ts
```

| 现象 | 含义 |
|---|---|
| `读不到日志` / `日志是空的` | 插件**没被加载**或没选中 → 检查 `plugins\` 路径与 DLL 名 |
| 四个座位都有几十手、`未发现被踢迹象 ✅` | **冒烟通过**：管道通了，牌都被接受 |
| 某座位 `⚠️ 疑似被踢` | 我们的牌被 `TractorRules` 拒了 → 看 `out/decisions.jsonl` 里那一手的 `hand`/`lead`/`picked` 复现 |

日志默认写在 `tools/smallnest-bridge/out/decisions.jsonl`（每行一手，含 seq / 手牌 / 本墩 / 出的牌）。

## 五、冒烟通过之后（还没做）

- 把 `bridge.ts` 的 `pickCards()` 换成 `choosePlay()`：需要把插件给的信息拼成一个最小 `GameState`
  （`hands` 里非我方的三家用「未见牌池」占位、`belief` 传 `buildBelief`），见文件末尾注释
- 加座位互换配对（`docs/42` F5）：我们坐 (1,3) 与 (2,4) 各打同批牌
- 规则差异表（`docs/42` F4）：见下

## 规则口径差异（胜率必须标注口径）

| 项 | smallnest | 本项目 | 可比性 |
|---|---|---|---|
| 2 为常主 | 无 | 默认开（对齐原版，KN-4） | 桥里用 `TWO_AS_PERMANENT` 对齐；默认按**开** |
| 甩牌合法性 | 只比最大一对（已知缺陷） | 逐组逐单位校验 | **不可比**：它可能放行我们会拒绝的甩牌 |
| 连对长度 | 只认 2 连对 | 任意长度（ADR-016） | **不可比** |
| 必打 | 默认 `",3,8,11,12,13,"`（→ 5/10/K/A/王） | 5/10/K/A/打王 | 一致 |

> 以上据既有逆向记录整理，**本轮未逐条复验**；跑正式对局前应先在两边各出一手同样的牌核对。

---

## 文件

| 文件 | 作用 |
|---|---|
| `plugin/RemakeAiPlugin.cs` | 实现 `IUserAlgorithm`，按行（JSON）与本桥通信 |
| `bridge/smallnestMap.ts` | 牌 id ↔ value、花色参数 ↔ trump、本墩出牌顺序 |
| `bridge/bridge.ts` | stdin/stdout 行协议；冒烟策略；决策日志 |
| `bridge/selftest.ts` | 映射自检（23 项，无 C# 也能跑） |
| `bridge/checkKick.ts` | 被踢检测（seq 断流） |

**运行前提**：Node + 仓库 `node_modules`（桥用 `vite-node` 跑 TS，以便直接 import 我们的 `@core` / `@ai`）。
插件通过环境变量覆盖默认路径：`TRACTOR_REPO` / `TRACTOR_BRIDGE` / `TRACTOR_NODE`。
