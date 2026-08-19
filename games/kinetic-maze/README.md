# 夜间机关 · Kinetic Maze（v4.3 ripple）

竖屏 9×16 几何机关乐器：144 个近方格里各有一台机关（钟摆 30、贴墙滑块 28、八音盒转盘 28、毛毡软槌 30、丝带轨道球 28）。
基础因果不变：**暗格静止无声，亮起才开始运动并进入声音时间轴**；每次亮起都是 1–3 个整数完整周期，回到初始姿态后才熄灭。

## 玩法（默认模式 ripple）

1. 页面底部只有一个「▶ 开始」按钮。点它：解锁 Web Audio、隐藏按钮、进入演奏。
2. **划过点亮**：手指划过手机屏幕（或鼠标划过页面，不需要按住），轨迹所经过的格子立即亮起——这一批就是"初始种子"。每划一次点亮新的一批；正在亮着的格子不会被重复触发。
3. **彼此唤醒**：每个亮着的机关在自己的重音时刻产生一次"火花"，按当前"目标亮数 − 实际亮数"的赤字概率点亮一个暗着的邻居（8 邻域优先，其次距离 2）。于是种子会向外依次点亮，走完周期后各自熄灭。
4. **不划也会长**：点开始后不动，会从随机一格开始（ember），单灯在邻格之间接力游走，随后按连续曲线慢慢变多，自动进入上面的流程。没有写死的阶段表。
5. **总数可控且大幅波动**：目标亮数 = 慢启动 ramp（对数尺度爬升，约 2 分钟接近漂移带）× 三个慢正弦叠加的漂移带（默认 8–80）+ 划动注入的临时抬升（约 14 s 衰减）。亮数高于目标就不再蔓延，多余的自然走完周期熄灭；最后一盏灯熄灭时会把火种直接交给邻居，画面不会全暗。
6. 全部随机决定使用无状态 hash，与帧率、决策顺序无关；30/60fps 下事件序列完全一致。

## URL 参数

| 参数 | 说明 |
| --- | --- |
| `seed=xxx` | 世界种子（墙图、机关、传播随机）。默认 `v4-growth-preview`。 |
| `sound=off` | 关闭默认声音意图。 |
| `debug=1` | 显示顶部状态条（秒数、已亮、目标、区间）。 |
| `mode=growth` | 旧版自动生长演示（1→2→4→…→128 阶段表，无开始按钮，自动开始）。 |
| `mode=interactive` | 旧版点击试听（点哪格哪格完整演奏，最多 6 个并发 + FIFO 排队）。 |
| `performance=export&duration=180` | 离线成片使用的 180 秒弧线（配合 `render-video.mjs`）。 |

## ripple 可调参数

所有调参数字都集中在 `RIPPLE_DEFAULTS`（[kinetic-maze-v4.js](kinetic-maze-v4.js) 顶部），覆盖优先级：**URL 参数 > `window.KINETIC_MAZE_CONFIG.ripple` > 默认值**。宿主（网站 / WKWebView / Android WebView）可在加载脚本前注入：

```html
<script>window.KINETIC_MAZE_CONFIG = { ripple: { litMin: 6, litMax: 60, rampSeconds: 45 } };</script>
<script src="./kinetic-maze-v4.js"></script>
```

| URL 键 | 配置键 | 默认 | 含义 |
| --- | --- | --- | --- |
| `lit=8-80` | `litMin` / `litMax` | 8 / 80 | 目标亮数的漂移区间（1–144） |
| `ramp=60` | `rampSeconds` | 60 | 慢启动时间常数（秒），目标沿对数尺度从 1 爬向漂移带 |
| `rampCurve=1.2` | `rampCurve` | 1.2 | 慢启动曲线指数，>1 起步更缓 |
| `wander=61,97,149` | `wanderPeriods` | 61,97,149 | 漂移带三条慢正弦的周期（秒） |
| `wanderWeights=0.5,0.32,0.18` | `wanderWeights` | 0.5,0.32,0.18 | 三条正弦的权重 |
| `wanderDepth=1.15` | `wanderDepth` | 1.15 | 漂移幅度放大，越大越常触到区间两端 |
| `boost=1.1` | `boostPerSeed` | 1.1 | 每个划动种子给目标的临时抬升 |
| `boostDecay=14` | `boostDecay` | 14 | 抬升衰减时间常数（秒） |
| `sparkAccent=0.7` | `sparkAccent` | 0.7 | 事件 accent ≥ 此值才算一次火花机会 |
| `sparkCap=0.55` | `sparkCap` | 0.55 | 单次火花点亮邻居的概率上限 |
| `sparkGain=0.35` / `sparkFloor=3` | `sparkGain` / `sparkFloor` | 0.35 / 3 | 概率 = 赤字 ÷ max(sparkFloor, 目标 × sparkGain) |
| `cycles=1-3` | `cyclesMin` / `cyclesMax` | 1 / 3 | 传播点亮的整数周期数区间（钟摆自动 ≥ 2） |
| `neighborOrthogonal` / `neighborDiagonal` | 同名 | 1 / 0.55 | 8 邻域中正交 / 对角邻居的抽样权重 |
| `ring2Orthogonal` / `ring2Diagonal` | 同名 | 0.5 / 0.3 | 无空邻居时，距离 2 圈格子的权重 |
| `emberDelay=0.5` | `emberDelay` | 0.5 | 接力失败后补 ember 的延迟（秒） |
| `trail=0.9` / `seedMark=0.7` | `trailSeconds` / `seedMarkSeconds` | 0.9 / 0.7 | 划动光迹渐隐 / 种子扩散环时长（秒） |
| `hint=6` | `hintSeconds` | 6 | 开始后提示文字停留（秒） |
| `sweepStep=0.35` | `sweepStep` | 0.35 | 轨迹采样步长（相对最小格边） |
| `fps=30` | `renderFps` | 30 | 画面重绘上限（帧/秒）。逻辑与声音仍按每个 rAF 推进；机关周期 2–7 s，30 fps 肉眼无差别，CPU 约减半 |

区间类参数写法 `min-max`，列表写法逗号分隔；非法值忽略、越界值自动收敛（如 `litMax` 始终 > `litMin`）。`__KINETIC_V4_DEBUG__.getRippleConfig()` 返回当前生效的配置，`resolveRippleConfig(search, hostConfig)` 可离线解析。

调试对象 `window.__KINETIC_V4_DEBUG__` 还提供 `start()`（等同点开始）、`step(seconds)`（手动推进一帧，用于无 rAF 的环境）、`sweepCells(ids)`（模拟划过一组格子）、`previewRipple(seed, seconds, step, { sweeps, config })` 与 `auditRipple(seed)`。

## 性能与后台行为

- 发光不用 `shadowBlur`（Canvas 最贵的操作），改为"粗线低透明度光晕层 + 正常层"两遍绘制；墙图/背景缓存到离屏画布，每帧只 `drawImage`；默认 30 fps 重绘（`fps=` 可调）；点「开始」前不跑帧循环。
- 页面隐藏（切标签、切后台、WebView 被遮住）或 `pagehide` 时：立即停掉所有连续声源、静音并 `suspend()` AudioContext；回到前台自动 `resume()`。`beforeunload` 时 `close()`。
- 滑块摩擦声（循环噪声源）另有两道保险：启动时按该次亮起的剩余时长 `source.stop()`；每帧预约 0.3 s 后自动衰减到静音的看门狗——帧循环一停，摩擦声半秒内自己消失，不会残留。

## 测试与导出

```bash
node test-p4-t1.cjs
node render-video.mjs --duration 180 --seed v4-three-minute --output exports/kinetic-maze-v4-3min.mp4
```

测试覆盖：暗格冻结、整数周期闭合、真实墙锚、旧版 128 声部生长与 180 秒成片的 30/60fps 确定性、点击 FIFO，以及 ripple 模式的：单 ember 起始、永不全暗、慢启动（10 s 内 ≤ 8 亮）、进入漂移带、不超上限、只向邻近扩散、划过即亮且抬高目标、亮数大幅波动。

`render-video.mjs` 仍使用 export performance（阶段表 + 128 秒达峰 + 完整周期退场），与网页默认的 ripple 模式互不影响。
