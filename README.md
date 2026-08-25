# sleepisland-play

睡眠岛 / SleepWell 的互动小项目合集：小游戏、解压场景、氛围互动。
每个项目都是**纯前端、零依赖、单目录自包含**（HTML + JS + Canvas/WebAudio），
可以直接用浏览器打开，也可以被网站或 App（WKWebView / Android WebView）以本地资源方式加载。

这个仓库是唯一的源码副本（single source of truth）。网站 [sleepisland.org](https://sleepisland.org) 与 SleepWell App 通过 git submodule 引用它，不要在各自仓库里改拷贝。

## 项目列表

| 目录 | 名称 | 说明 |
| --- | --- | --- |
| [`games/kinetic-maze`](games/kinetic-maze) | 夜间机关 · Kinetic Maze | 9×16 几何机关乐器：划过屏幕点亮一批机关，机关彼此唤醒、依次亮起熄灭；亮数在可配区间内大幅波动，全 Web Audio 空间音频。 |
| [`games/mathematical-jellyfish`](games/mathematical-jellyfish) | 数学水母 · Mathematical Jellyfish | 9:16 深海点阵动画：一个参数曲面主水母与 16 组原公式远景水母，以不同相位松弛漂游；附 30 秒视频导出器与小红书封面。 |

## 约定

- 一个项目一个目录：`games/<name>/`。
- 每个目录至少包含 `index.html`（可独立运行的 demo / 宿主页）、`README.md`（玩法与参数说明）。
- 不引入构建步骤、不引入 npm 依赖；宿主通过 `<script src>` 或 WebView 直接加载。
- 宿主特定的东西（SEO、页面排版、原生桥接）留在宿主仓库，不要放进来。

## 作为 submodule 使用

```bash
git submodule add https://github.com/hanzg77/sleepisland-play.git <path>
git submodule update --init
# 更新到最新
git submodule update --remote <path>
```

## License

MIT
