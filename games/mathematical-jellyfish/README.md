# 数学水母 · Mathematical Jellyfish

一个纯前端、零依赖的 9:16 生成艺术项目。画面里没有水母模型：主水母的伞盖、放射纹和 7 条触手由参数方程逐点生成；远景水母则沿用一组三角函数和幂函数构造，分成 16 组缓慢漂游的点云。

## 主水母公式

主水母的伞盖取自一组会呼吸的半椭圆参数曲线，内部再叠加 10 层弧面和 9 条放射曲线：

```text
W(t) = W₀ [1 - 0.045 sin(2t + 0.35)]
H(t) = H₀ [1 + 0.055 sin(2t + 0.35)]
x_b(u,t) = W(t) cos(u)
y_b(u,t) = -H(t) sin(u),  0 ≤ u ≤ π
```

第 `s` 条触手使用独立的长度 `Lₛ`、频率 `ωₛ`、相位 `φₛ` 与循环次数 `nₛ`：

```text
xₛ(v,t) = bₛW(t)(1 - 0.2v) + A(v) sin(ωₛv + φₛ + nₛt)
yₛ(v,t) = y₀ + Lₛv + B sin(3πv + φₛ + 2t),  0 ≤ v ≤ 1
```

## 远景水母原公式

对点索引 `i`、组相位 `m` 和时间 `t`：

```text
k = 9 cos(5i) sin(i)
e = 9 cos(3i) cos(2i)
d = (sqrt(k² + e²))³ / 1999 + 1.5 - sin³(t / 2 + m) / 3
c = d / 16 - t / 48 + m
p = d ^ sin(d² - t + m)
x = 99 sin(c) + kp + 200
y = 99 sin(4c) + ep + 200
```

`mathematical-jellyfish.js` 保留这组点云构造，并用嵌套余弦弧面、放射曲线和不同频率的正弦曲线生成画面中央的大水母。主水母与每组远景水母的横漂、升降、呼吸和轻微摇摆都拆成独立的 30 秒整数周期，这样既不会整齐地上下往复，也能让首尾自然闭环。

## 运行

可以直接用浏览器打开 `index.html`。本地服务器方式：

```bash
cd games/mathematical-jellyfish
python3 -m http.server 8000
```

然后访问 `http://localhost:8000`。页面隐藏或离开视口时会自动暂停动画。

## 文件

- `index.html`：9:16 宿主页和公式面板。
- `mathematical-jellyfish.js`：Canvas 2D 实时动画源码。
- `render-video.mjs`：固定时间步的视频导出器，内部 540×960 渲染后放大为 1080×1920。
- `cover-background.png`：AI 生成的无字深海底图。
- `make-cover.py`：使用 Pillow 叠加准确中文标题与公式。
- `cover.png`：1080×1920 小红书封面成品。
- `exports/`：本地导出目录，不提交到 Git。

## 生成封面

底图由 OpenAI 内置图像生成工具制作；文字不交给生成模型，而是用 Pillow 精确排版：

```bash
python3 make-cover.py
```

封面标题为「数学公式生成的深海水母？」；公式与正文保持可编辑，不会出现生成图片常见的错字。

## 导出小红书竖屏视频

需要 Node.js 与 FFmpeg。音频不随仓库分发，请传入自己有权使用的本地文件：

```bash
node render-video.mjs \
  --duration 30 \
  --audio /absolute/path/to/audio_clean.mp3 \
  --audio-start 60 \
  --output exports/mathematical-jellyfish-xhs-30s.mp4
```

默认输出 1080×1920、30fps、H.264 High、AAC 48kHz 双声道。导出器限制为 2 个编码线程，并为音频添加 0.8 秒淡入、1 秒淡出与安全限幅。

## 性能

- 30fps 画面更新、10fps 水下光更新。
- Canvas 后备分辨率不跟随 Retina 倍增。
- 背景缓存到离屏 Canvas；水母使用单个 `ImageData` 批量写入。
- `IntersectionObserver` 与 `visibilitychange` 会在离屏和后台停止帧循环。
- `prefers-reduced-motion` 下只显示静态画面。

## Attribution

水母的核心点云构造改写自 [@yuruyurau 发布的 Processing 公式](https://x.com/yuruyurau/status/2090832898488459699?s=20)。本项目增加了竖屏布局、独立漂移、低占用渲染、水下光和确定性视频导出。原始公式的署名与相关权利仍归原作者。

仓库中的新增实现代码遵循根目录的 MIT License；外部音频不包含在授权范围内。
