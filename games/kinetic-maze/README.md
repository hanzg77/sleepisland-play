# 夜间机关 · Kinetic Maze（4.8-live-capture-r17）

竖屏 9×16 几何机关乐器：144 个近方格里各有一台机关（钟摆 30、贴墙滑块 28、八音盒转盘 28、毛毡软槌 30、丝带轨道球 28）。
默认玩法把它们组成一件可以随手画的睡前乐器：**划过的顺序就是旋律，划动的快慢就是节奏**。

## 玩法（默认模式 melody）

1. 页面底部的「▶ 开始」是真正的交互入口：点击前，鼠标划过、点击画布和触屏都保持静止；点击后才同时进入 melody 玩法并在同一次可信手势里解锁 Web Audio。开始后，桌面端移动鼠标或触控板即可产生无循环的真实线波，按住则记录乐句。
2. 按住并画一笔（触屏直接按住划）：光迹立即跟手，36×64 波场沿真实线段连续产生波源，穿格短音按真实划动顺序立即响；9×16 详细机关各用 3 个真实几何接触点读取同一张可见波场，只在波峰当场抵达时启动，并在碰撞点扩开一次柔和光环。每个 coalesced pointer sample 的时间戳都会保留，快速划就是快旋律，慢慢画就是慢旋律。
3. 抬手后，这一笔按原顺序和原时间差再循环 3 遍，每一遍更轻，最后连同波纹一起消失。极短笔画有最小周期，极长笔画最多保存 8 秒周期。
4. 再画一笔就是第二个独立声部；默认最多同时保留 3 笔，超过后淘汰最旧声部。
5. 轨迹跨过的每个 36×64 波格都会在原位置产生涟漪；18×32 微型簧片只在可见波峰附近轻微弯动。划线不会再向外复制成长直线；两个声部的真实波场会加强或抵消，声音仍各自保留。
6. 只有随种子散落的 12 个特殊机关拥有「旋律能力」，其余 132 个仍只是普通机关。每个特殊机关固定绑定一条不同的 1–2 小节短句；波唤醒哪个，就只演奏哪个自己的短句，多枚同时被唤醒时会各自演奏。能力从 22 条池中按种子抽取，默认每张地图为 9 首公版名曲 + 3 条原创爵士；名曲使用固定可辨识调性，不再跟随机关换调。

「旋律能力」与划线本身按经过顺序产生的基础短音是两条独立声部：基础短音不会临时赋予普通组件一首名曲；`motifs=off` 只关闭少数特殊组件的能力，不影响光迹、波、普通机关声或原始划线节奏。

详细机关仍是 9×16；新增的 18×32（576 个）响应簧片只保存 TypedArray 几何并读取现有波场，不拥有独立时钟或音源。36×64 也只是固定数组里的 2304 个波场采样点，不会生成 2304 台昂贵机关。视觉响应、传播波、详细机关和声音分别使用独立预算。

手机竖屏下机关框使用画布宽度的 93.3%（左右各留 36 / 1080），不再沿用桌面草案中过宽的 72 px 留白；上下范围、9×16 交互语义及音频声像保持不变。

涟漪显示增益比 r11 约轻 25%：只降低 36×64 雾状波层、短暂源点圆环和局部波峰微光；手势光迹、物理传播能量、远端机关阈值及声音增益不变。

## URL 参数

| 参数 | 说明 |
| --- | --- |
| `seed=xxx` | 世界种子（墙图、机关、传播随机）。默认 `v4-growth-preview`。 |
| `sound=off` | 关闭默认声音意图。 |
| `debug=1` | 显示顶部状态条。 |
| `denseDetails=1` | 仅用于 A/B：真实绘制 18×32（576 次）半尺寸详细机关，仍共享原 144 个状态、命中和声音；不代表 576 个独立机关。`denseDetails=plus` 会再叠加响应簧片作为压力上界。 |
| `mode=melody` | 当前默认的划线录旋律玩法。 |
| `mode=ripple` | v4.3 自动火种 / 邻格蔓延玩法。 |
| `mode=beacon` | 未完成的「引光到灯塔」实验玩法。 |
| `mode=growth` | 旧版自动生长演示（1→2→4→…→128 阶段表，无开始按钮，自动开始）。 |
| `mode=interactive` | 旧版点击试听（点哪格哪格完整演奏，最多 6 个并发 + FIFO 排队）。 |
| `performance=export&duration=180` | 离线成片使用的 180 秒弧线（配合 `render-video.mjs`）。 |

## melody 可调参数

覆盖优先级：**URL 参数 > `window.KINETIC_MAZE_CONFIG.melody` > 默认值**。

| URL 键 | 配置键 | 默认 | 含义 |
| --- | --- | --- | --- |
| `phraseLoops=3` | `repeatCount` | 3 | 原笔实时演奏后再循环的次数 |
| `phraseFade=.72` | `repeatFade` | 0.72 | 每轮相对上一轮的音量 |
| `wavePhraseFade=1` | `waveRepeatFade` | 1 | 三圈物理传播波保持远端可触发；声音仍独立渐弱 |
| `phraseGap=.3` | `loopGap` | 0.3 s | 抬手和循环接缝的呼吸间隔 |
| `phraseMin=.72` / `phraseMax=8` | `minPeriod` / `maxPeriod` | 0.72 / 8 s | 乐句周期边界 |
| `noteGap=.04` | `minNoteInterval` | 0.04 s | 同一笔的最小声音间隔 |
| `phraseNotes=48` | `maxNotes` | 48 | 每笔最多保存的声音格数 |
| `phraseLayers=3` | `maxPhrases` | 3 | 同时循环的声部上限 |
| `voiceCap=16` | `voiceLimit` | 16 | melody 实际短音并发上限 |
| `mechanismCap=24` | `mechanismVoiceLimit` | 24 | 波唤醒详细机关的瞬态声源并发上限 |
| `frictionCap=12` | `frictionVoiceLimit` | 12 | 详细机关连续摩擦声并发上限 |
| `waveGrid=36x64` | `waveCols` / `waveRows` | 36 / 64 | 轻量波场密度；总点数限制在 2304 内 |
| `waveSpeed=230` / `waveLife=9` / `waveWidth=60` | 同名 | 230 / 9 / 60 | 波速、寿命和波峰宽度；传播由真实绕墙距离场负责，手绘光迹不会向外复制成长直线 |
| `waveWall=140` | `wallPenalty` | 140 px | 穿过一段墙的固定传播代价；仍倾向绕墙端/缺口，但不把远端路径推到寿命之外 |
| `waveCap=48` | `maxWaves` | 48 | 同时存在的传播源上限；低帧率批量输入仍按各自事件时刻进入 60 Hz 波场，不会让后波提前淘汰尚未采样的前波 |
| `componentCap=24` | `componentLimit` | 24 | 同时被波唤醒的 9×16 详细机关上限；没拿到槽位的旧波峰不会稍后补亮 |
| `strokeCap=12` | `strokeComponentLimit` | 12 | 兼容旧宿主的保留预算；当前 melody 详细机关统一由波前唤醒 |
| `componentThreshold=.13` | `componentThreshold` | 0.13 | 波前唤醒详细机关的强度阈值；真实慢划的第三圈在远端仍可越过 |
| `componentCycles=1` | `componentCycles` | 1 | 被唤醒后完成一次完整闭合周期，不随瞬时波幅闪烁 |
| `componentPeriod=.30` | `componentPeriodScale` | 0.30 | melody 机关相对原周期的缩放；约 0.54–2.04 秒，避免旧机关落在波后 |
| `componentGain=.66` | `componentGain` | 0.66 | 波唤醒机关相对前景手势音的音量 |
| `motifCount=12` | `motifCount` | 12 | 随种子散落的旋律能力数量；从 22 条能力池抽取，最多 16 |
| `motifGain=.82` | `motifGain` | 0.82 | 旋律能力的相对音量 |
| `motifCooldown=10` | `motifCooldown` | 10 s | 同一能力再次演奏前的冷却 |
| `motifVoices=12` | `motifVoiceLimit` | 12 | 完整旋律能力演奏的并发硬上限；容量不足时整句不开始，已开始的句子不会被掐掉中间音 |

能力开关不走数值配置：URL 用 `motifs=off` 整体关闭，或用 `motifOff=fate-four,blue-note-call` 关闭指定能力。宿主配置支持：

```html
<script>
window.KINETIC_MAZE_CONFIG = {
  melody: {
    motifEnabled: true,
    motifAbilities: { "fate-four": false },
    customMotifs: [{
      id: "owned-hook", title: "自有短句", composer: "My Studio",
      transposePolicy: "fixed", rootPitch: 60, beatSeconds: 0.24,
      notes: [[0, .5, .9], [3, .5, .8], [7, 1, 1]]
    }]
  }
};
</script>
```

`notes` 每项为 `[相对半音, 拍数, 力度]`。`transposePolicy: "fixed"` 会以 MIDI `rootPitch` 为固定根音；整句的最终 MIDI 音高必须全部落在 40–88，否则这条 custom 会被明确忽略，不会静默 clamp 后换调。省略策略时沿用旧行为，让自定义短句跟随所在机关移调。内置只合成公版作品旋律和原创爵士短句，不携带第三方录音；现代歌曲可用同一接口注入，但权利由宿主自行确认。

当前 22 条能力池包括 18 首公版名曲：第五交响曲四音、欢乐颂、致爱丽丝、小星星、Joplin《枫叶拉格》《演艺人》、Mozart《小夜曲》《土耳其进行曲》、Petzold《G 大调小步舞曲》、Vivaldi《春》、Grieg《晨曲》《山魔王宫中》、Dvořák《自新大陆·广板》、Brahms《摇篮曲》、Bizet / Iradier《哈巴涅拉》、Chopin《葬礼进行曲》、Tchaikovsky《天鹅湖》及法国传统《两只老虎》；另有 4 条原创爵士语汇。所有名曲均由 Web Audio 现场合成，不使用现代演奏、录音或电影配器。

例如：

```html
<script>
window.KINETIC_MAZE_CONFIG = {
  melody: { repeatCount: 4, maxPhrases: 2, waveCols: 24, waveRows: 40 }
};
</script>
<script src="./kinetic-maze-v4.js"></script>
```

## ripple 可调参数（旧模式）

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

调试对象 `window.__KINETIC_V4_DEBUG__` 还提供 `start()`、`step(seconds)`、`previewMelody(strokes, seconds, step, options)`、`createLiveCaptureStream(fps)`、`auditMelody()`、`auditMotifAbilities()`、`auditDenseDetailRendering()`、`auditMelodyAudioCap()`，以及旧模式的 `sweepCells()`、`previewRipple()` 与 `auditRipple()`。实时录制流把可见 Canvas 与安全限幅后的 WebAudio 立体声合并，供 `MediaRecorder` 使用；不会录入 Start、提示和状态栏等 DOM 覆盖层。

## 性能与后台行为

- 详细机关世界在离屏 back buffer 中保持 30 fps；可见画布每个显示帧只合成上一张完整世界图，再画轨迹和波场。这样既不会在手指移动时重画 144 个机关，也避开部分 WebView 的多画布透明层错位；没有活跃乐句、轨迹或波时，帧循环会自动停止。
- 36×64 波场使用固定 `Float32Array` 坐标和最多 48 个传播源；每个轨迹小段会先栅格化成整条多源线，再用一张墙感知距离场向外传播，中点不会退化成两个端点圆波之间的空洞。每道活波只多带 5 个 `Uint32` 的机关消费位图，保证同一物理波不重复启动同一机关。动态距离缓存使用 48 项 LRU；按压轨迹的单个 segment 最多同步创建 12 张距离场。Start 之后的 hover 会合并全部 coalesced 光迹，每个外层 PointerEvent 最多创建 1 张距离场，并限制在每秒约 10 张。
- 18×32 响应簧片仅需每帧扫描 576 个数并按能量分桶批量绘制；没有 576 份组件对象、动画时钟或音源。stroke、wave 和详细机关仍使用独立预算：每笔最多 48 音、同时 3 个循环声部、48 个传播源、24 个被波唤醒的 9×16 机关。每台机关只多 3 个 TypedArray 接触点；启动后完成 1 个缩短的完整周期，不跟随瞬时波幅闪烁。
- melody 实际短音并发上限为 16；旋律能力演奏、详细机关瞬态声和连续摩擦声分别有 12、24、12 个并发硬上限。每句旋律能力复用一个持续 oscillator 改频并重做音符包络，因此硬上限按完整演奏准入：第 13 句会整句不开始，已准入的 12 句则不会因逐音抢槽而缺音。瞬态噪声复用初始化时生成的共享 buffer，不再为每个事件填充新 buffer。
- 实时音频末级增加独立快速 peak compressor 与 4× 过采样软限幅（不替代原来的音乐性压缩），最终 ceiling 约为 `0.92 × 0.95 = 0.874`；软槌、滑块与摆锤的随机噪声加入 5 ms 柔起音，滑块循环摩擦的缓冲首尾使用 8 ms 短窗消除接缝，快速旋律换音先用 6 ms 释放旧包络再重启。卡帧后补送的事件保留相对先后并压入最多 70 ms 的短窗口，不再全部堆到同一个 2 ms 起点。它们只削平爆破尖峰与不连续点，普通声部的平均响度和远近关系基本不变。
- 发光不用 `shadowBlur`；墙图/背景缓存到离屏画布，每帧只 `drawImage`。
- Start 会在同步点击事件栈内调用 `AudioContext.resume()`，避免严格 WebView 的手势授权在微任务后失效；Start 前的 pointer 完全无效，不会创建 AudioContext 或排队声音。开始后的恢复性 pointerdown 仍可重试一次被系统挂起的声音。页面隐藏（切标签、切后台、WebView 被遮住）或 `pagehide` 时：立即停掉所有连续声源、静音并 `suspend()` AudioContext；回到前台自动 `resume()`。
- 滑块摩擦声（循环噪声源）另有两道保险：启动时按该次亮起的剩余时长 `source.stop()`；每帧预约 0.3 s 后自动衰减到静音的看门狗——帧循环一停，摩擦声半秒内自己消失，不会残留。

## 测试与导出

```bash
node test-p4-t1.cjs
node record-live-demo.mjs --duration 15 --seed v4-growth-preview --output exports/kinetic-maze-live-15s.mp4
node render-video.mjs --duration 180 --seed v4-three-minute --output exports/kinetic-maze-v4-3min.mp4
```

`record-live-demo.mjs` 会启动 1080×1920 的手机触屏虚拟视口，真实点击 Start 后，以实时 Pointer/Touch 时序画出 S 形穿场、中央 8 字与展开螺旋三笔；画布和 WebAudio 直接由浏览器录成 WebM，再转为 H.264/AAC MP4。它至少需要运行视频本身的时长，换来与网页一致的光迹、涟漪、机关和声音；默认的波/机关预算会收紧到适合 15 秒成片的轻量配置，结尾留给循环渐弱。

P4.8 测试覆盖：整段栅格化多源波场及中点即时能量、真实 `0.45` 慢划到达远端、第三圈远端峰值、24 槽满时严格消费阈值上升沿且禁止迟到补亮、单个物理波即使跨越 signed 暗节点也不会重复启动同一机关、跨 `waveLife` 帧先补历史采样再清理、每台机关 3 个几何接触点、Start 前鼠标与触屏完全静止、Start 后 hover 每事件 1 波上限、18×32 响应层、576 次详细绘制 A/B、零 pressure 的 active touch move、严格同步音频解锁、`sound=off` 纯视觉启动、真实非均匀轨迹时序、循环渐弱、绕墙衍射、机关完整周期与低帧率历史占用、22 条能力池/跨作曲家抽样/18 首名曲黄金音高、fixed custom 越界拒绝、真实多音短句的整句准入与无中途缺音、各类声音硬上限、`sleep/wake` 竞态，以及旧模式回归。

`render-video.mjs` 仍强制使用 export performance（阶段表 + 128 秒达峰 + 完整周期退场），与网页默认 melody 模式互不影响；需要当前 melody 的真实划线画面时使用 `record-live-demo.mjs`。
