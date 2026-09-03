(() => {
  "use strict";

  const WIDTH = 1080;
  const HEIGHT = 1920;
  // 手机竖屏优先：左右只留 36 px（3.3%），让 9×16 机关区真正使用屏幕宽度。
  // 上下节奏仍保持原设计，避免为了填宽而裁掉首尾机关或触控范围。
  const FRAME = Object.freeze({ x: 36, y: 160, width: 1008, height: 1640 });
  const COLS = 9;
  const ROWS = 16;
  const RESPONSE_COLS = COLS * 2;
  const RESPONSE_ROWS = ROWS * 2;
  const RESPONSE_REED_VISIBLE_FLOOR = 0.12;
  const CELL_W = FRAME.width / COLS;
  const CELL_H = FRAME.height / ROWS;
  const TAU = Math.PI * 2;
  const BEAT_SECONDS = 60 / 62;
  const TICK_SECONDS = BEAT_SECONDS / 2;
  const DEFAULT_SEED = "v4-growth-preview";
  const MAX_LIT = 128;
  const TYPES = Object.freeze(["pendulum", "glider", "rotor", "mallet", "ribbon"]);
  const TYPE_LABELS = Object.freeze({
    pendulum: "钟摆",
    glider: "贴墙滑块",
    rotor: "八音盒转盘",
    mallet: "毛毡软槌",
    ribbon: "丝带轨道球",
  });
  const TYPE_COLORS = Object.freeze({
    pendulum: "#e2b85f",
    glider: "#70b28d",
    rotor: "#69acd0",
    mallet: "#df7d60",
    ribbon: "#ad8bd0",
  });
  const WAVE_ACCENT_QUOTAS = Object.freeze([12, 24, 36, 48, 72]);
  // 只控制涟漪的显示增益；传播场、机关触发阈值和声音完全不读取这些值。
  // 相比 r11，主波层和局部峰值约轻 25%，保留原始手势光迹作为最亮的即时反馈。
  const WAVE_VISUALS = Object.freeze({
    texturePixelAlpha: 160,
    textureGamma: 0.9,
    textureLayerAlpha: 0.8,
    segmentRingAlpha: 0.16,
    pointRingAlpha: 0.35,
    accentBaseAlpha: 0.09,
    accentEnergyAlpha: 0.31,
  });
  // 平均响度尽量不动，只处理会被听成“爆破”的毫秒级不连续和总线尖峰。
  const AUDIO_SAFETY = Object.freeze({
    masterGain: 0.95,
    noiseAttackSeconds: 0.005,
    frictionSeamSeconds: 0.008,
    motifRetriggerReleaseSeconds: 0.006,
    limiterThresholdDb: -4.5,
    limiterKneeDb: 0,
    limiterRatio: 20,
    limiterAttackSeconds: 0.002,
    limiterReleaseSeconds: 0.08,
    softLimitKnee: 0.84,
    softLimitCeiling: 0.92,
    softLimitCurveSize: 2049,
    catchupLeadSeconds: 0.004,
    catchupWindowSeconds: 0.07,
  });
  const QUOTAS = Object.freeze({ pendulum: 30, glider: 28, rotor: 28, mallet: 30, ribbon: 28 });
  const COLORS = Object.freeze({
    background: "#071015",
    grid: "#35444c",
    gridStrong: "#52636b",
    dark: "#66767e",
    halo: "#dce8eb",
  });

  const canvas = document.querySelector("#kinetic-maze-v4");
  const seedLabel = document.querySelector("#seed-label");
  const statusLabel = document.querySelector("#status-label");
  const startControl = document.querySelector("#start-control");
  const chrome = document.querySelector("#chrome");
  const chromeHint = document.querySelector("#chrome-hint");
  const hintLabel = document.querySelector("#hint-label");
  if (!(canvas instanceof HTMLCanvasElement) || !seedLabel || !statusLabel) {
    throw new Error("V4 page elements are missing.");
  }
  const displayDraw = canvas.getContext("2d", { alpha: false });
  if (!displayDraw) throw new Error("Canvas 2D is unavailable.");
  let worldSurface = null;
  let waveTextureSurface = null;
  let waveTextureDraw = null;
  let waveTextureImage = null;
  let draw = displayDraw;
  if (typeof document.createElement === "function") {
    const surface = document.createElement("canvas");
    surface.width = WIDTH;
    surface.height = HEIGHT;
    const surfaceDraw = surface.getContext("2d", { alpha: false });
    if (surfaceDraw) { worldSurface = surface; draw = surfaceDraw; }
  }

  function clamp(value, minimum = 0, maximum = 1) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function lerp(from, to, amount) {
    return from + (to - from) * amount;
  }

  function smoothstep(value) {
    const amount = clamp(value);
    return amount * amount * (3 - 2 * amount);
  }

  // 波前前半程保留能量，最后一段再柔和淡出；线性衰减会让普通手势在到达远端前先跌破机关阈值。
  function waveLifeGain(age, lifetime) {
    if (age < 0 || age > lifetime || lifetime <= 0) return 0;
    return Math.pow(Math.max(0, 1 - age / lifetime), 0.52);
  }

  function waveTextureAlpha(energy) {
    const magnitude = Math.abs(Number(energy));
    if (!Number.isFinite(magnitude) || magnitude < 0.02) return 0;
    return Math.round(Math.pow(clamp((magnitude - 0.02) / 0.98), WAVE_VISUALS.textureGamma) * WAVE_VISUALS.texturePixelAlpha);
  }

  function makeSoftLimitCurve() {
    const curve = new Float32Array(AUDIO_SAFETY.softLimitCurveSize);
    const knee = AUDIO_SAFETY.softLimitKnee;
    const range = 1 - knee;
    for (let index = 0; index < curve.length; index += 1) {
      const input = index / (curve.length - 1) * 2 - 1;
      const magnitude = Math.abs(input);
      let output = magnitude;
      if (magnitude > knee) {
        const excess = magnitude - knee;
        // 在 knee 处斜率为 1、到满幅时斜率为 0；不会像硬 clamp 那样再制造新棱角。
        output = knee + excess - excess * excess / (2 * range);
      }
      curve[index] = Math.sign(input) * Math.min(AUDIO_SAFETY.softLimitCeiling, output);
    }
    return curve;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function spatialHash(index, columns) {
    const row = Math.floor(index / columns);
    const col = index - row * columns;
    let value = Math.imul(col + 1, 0x9e3779b1) ^ Math.imul(row + 1, 0x85ebca77);
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15;
    value = Math.imul(value, 0x846ca68b);
    value ^= value >>> 16;
    return value >>> 0;
  }

  function freezeMotif(definition) {
    const transposePolicy = definition.transposePolicy === "fixed" ? "fixed" : "component";
    const rootPitch = Number.isFinite(Number(definition.rootPitch)) ? Math.round(Number(definition.rootPitch)) : null;
    return Object.freeze({
      ...definition,
      composer: String(definition.composer || (definition.family === "original-jazz" ? "Sleep Island" : "Traditional")),
      collection: String(definition.collection || (definition.family === "original-jazz" ? "original" : "named-public-domain")),
      transposePolicy,
      rootPitch: transposePolicy === "fixed" ? rootPitch : null,
      notes: Object.freeze(definition.notes.map(([semitones, beats, accent = 0.82]) => Object.freeze({ semitones, beats, accent }))),
    });
  }

  // 内置只放公版旋律动机与原创爵士语汇；宿主可通过 customMotifs 注入自己拥有权利的短句。
  const BUILT_IN_MOTIFS = Object.freeze([
    freezeMotif({ id: "fate-four", title: "命运动机", composer: "Beethoven", family: "public-domain", transposePolicy: "fixed", rootPitch: 60, beatSeconds: 0.32, notes: [[7, 0.5, 0.9], [7, 0.5, 0.82], [7, 0.5, 0.86], [3, 2, 1]] }),
    freezeMotif({ id: "ode-opening", title: "欢乐颂", composer: "Beethoven", family: "public-domain", transposePolicy: "fixed", rootPitch: 62, beatSeconds: 0.28, notes: [[4, 1], [4, 1], [5, 1], [7, 1, 0.94], [7, 1], [5, 1], [4, 1], [2, 1, 0.94]] }),
    freezeMotif({ id: "fur-elise-turn", title: "致爱丽丝", composer: "Beethoven", family: "public-domain", transposePolicy: "fixed", rootPitch: 69, beatSeconds: 0.3, notes: [[7, 0.5, 0.9], [6, 0.5], [7, 0.5], [6, 0.5], [7, 0.5, 0.94], [2, 0.5], [5, 0.5], [3, 0.5], [0, 1, 1]] }),
    freezeMotif({ id: "twinkle-opening", title: "小星星", composer: "Traditional French", family: "public-domain", transposePolicy: "fixed", rootPitch: 60, beatSeconds: 0.24, notes: [[0, 1], [0, 1], [7, 1], [7, 1], [9, 1], [9, 1], [7, 2, 0.96]] }),
    freezeMotif({ id: "maple-leaf-rag", title: "枫叶拉格", composer: "Scott Joplin", family: "public-domain-ragtime", transposePolicy: "fixed", rootPitch: 56, beatSeconds: 0.34, leadInBeats: 0.25, notes: [[0, 0.25], [7, 0.25], [0, 0.25], [4, 0.25], [7, 0.5, 0.94], [-1, 0.25], [7, 0.25], [-1, 0.25], [2, 0.25], [7, 1.25, 1]] }),
    freezeMotif({ id: "entertainer-jump", title: "演艺人", composer: "Scott Joplin", family: "public-domain-ragtime", transposePolicy: "fixed", rootPitch: 62, beatSeconds: 0.36, notes: [[0, 0.25], [1, 0.25], [2, 0.25, 0.92], [10, 0.5], [2, 0.25], [10, 0.5], [2, 0.25], [10, 1.25, 1]] }),
    freezeMotif({ id: "eine-kleine-fanfare", title: "小夜曲", composer: "Mozart", family: "public-domain", transposePolicy: "fixed", rootPitch: 55, beatSeconds: 0.26, notes: [[0, 1], [7, 0.5], [12, 0.5], [16, 1], [19, 2, 1]] }),
    freezeMotif({ id: "rondo-alla-turca", title: "土耳其进行曲", composer: "Mozart", family: "public-domain", transposePolicy: "fixed", rootPitch: 57, beatSeconds: 0.23, notes: [[2, 0.5], [0, 0.5], [-1, 0.5], [0, 0.5], [3, 1], [5, 0.5], [3, 0.5], [2, 0.5], [3, 0.5], [7, 1.5, 1]] }),
    freezeMotif({ id: "minuet-in-g", title: "G大调小步舞曲", composer: "Christian Petzold", family: "public-domain", transposePolicy: "fixed", rootPitch: 55, beatSeconds: 0.3, notes: [[7, 1], [0, 0.5], [2, 0.5], [4, 0.5], [5, 0.5], [7, 1], [0, 1], [0, 2, 1]] }),
    freezeMotif({ id: "vivaldi-spring", title: "春", composer: "Vivaldi", family: "public-domain", transposePolicy: "fixed", rootPitch: 64, beatSeconds: 0.22, notes: [[0, 1], [4, 0.5], [4, 0.5], [4, 1], [2, 1], [0, 1], [7, 1], [7, 0.5], [5, 0.5], [4, 0.5], [4, 0.5], [4, 1, 1]] }),
    freezeMotif({ id: "morning-mood", title: "晨曲", composer: "Edvard Grieg", family: "public-domain", transposePolicy: "fixed", rootPitch: 64, beatSeconds: 0.34, notes: [[7, 1], [4, 0.5], [2, 0.5], [0, 1], [2, 0.5], [4, 0.5], [7, 1], [4, 0.5], [7, 0.5], [9, 1], [4, 2, 1]] }),
    freezeMotif({ id: "mountain-king", title: "山魔王宫中", composer: "Edvard Grieg", family: "public-domain", transposePolicy: "fixed", rootPitch: 59, beatSeconds: 0.2, notes: [[0, 0.5], [2, 0.5], [3, 0.5], [5, 0.5], [7, 0.5], [3, 0.5], [7, 0.5], [12, 0.5], [10, 0.5], [7, 0.5], [3, 0.5], [7, 1, 1]] }),
    freezeMotif({ id: "new-world-largo", title: "自新大陆·广板", composer: "Antonín Dvořák", family: "public-domain", transposePolicy: "fixed", rootPitch: 61, beatSeconds: 0.38, notes: [[4, 1], [7, 1.5], [7, 0.5], [4, 1], [2, 1], [0, 2], [2, 1], [4, 1], [7, 1.5], [4, 0.5], [2, 2, 1]] }),
    freezeMotif({ id: "brahms-lullaby", title: "摇篮曲", composer: "Johannes Brahms", family: "public-domain", transposePolicy: "fixed", rootPitch: 63, beatSeconds: 0.32, notes: [[4, 0.5], [4, 0.5], [7, 1.5], [4, 0.5], [4, 0.5], [7, 1.5], [4, 0.5], [7, 0.5], [12, 1], [11, 0.5], [9, 0.5], [9, 1.5, 1]] }),
    freezeMotif({ id: "carmen-habanera", title: "哈巴涅拉", composer: "Bizet / Iradier", family: "public-domain", transposePolicy: "fixed", rootPitch: 50, beatSeconds: 0.3, notes: [[12, 0.5], [11, 0.5], [10, 0.333], [10, 0.333], [10, 0.334], [9, 0.5], [8, 0.5], [7, 0.25], [7, 0.25], [6, 0.5], [5, 0.5], [3, 1, 1]] }),
    freezeMotif({ id: "chopin-funeral", title: "葬礼进行曲", composer: "Frédéric Chopin", family: "public-domain", transposePolicy: "fixed", rootPitch: 58, beatSeconds: 0.34, notes: [[0, 0.75], [0, 0.25], [0, 0.25], [0, 0.75], [3, 1], [2, 0.5], [2, 0.5], [0, 0.75], [0, 0.25], [0, 0.25], [0, 1.5, 1]] }),
    freezeMotif({ id: "swan-lake-theme", title: "天鹅湖", composer: "Tchaikovsky", family: "public-domain", transposePolicy: "fixed", rootPitch: 59, beatSeconds: 0.31, notes: [[7, 2], [0, 0.5], [2, 0.5], [3, 0.5], [5, 0.5], [7, 1.5], [3, 0.5], [7, 1.5], [3, 0.5], [7, 1.5], [0, 0.5], [3, 1, 1]] }),
    freezeMotif({ id: "frere-jacques", title: "两只老虎", composer: "Traditional French", family: "public-domain", transposePolicy: "fixed", rootPitch: 60, beatSeconds: 0.25, notes: [[0, 1], [2, 1], [4, 1], [0, 1], [0, 1], [2, 1], [4, 1], [0, 1], [4, 1], [5, 1], [7, 2, 1]] }),
    freezeMotif({ id: "blue-note-call", title: "蓝调问句", composer: "Sleep Island", family: "original-jazz", transposePolicy: "component", beatSeconds: 0.3, notes: [[0, 0.66, 0.88], [3, 0.34], [5, 0.66], [6, 0.34, 0.94], [7, 0.66], [10, 0.34], [7, 0.66], [5, 1, 0.96]] }),
    freezeMotif({ id: "ii-v-i-release", title: "二五一落句", composer: "Sleep Island", family: "original-jazz", transposePolicy: "component", beatSeconds: 0.27, notes: [[2, 0.5], [5, 0.5], [9, 1, 0.9], [7, 0.5], [11, 0.5], [14, 1, 0.94], [12, 0.5], [7, 0.5], [4, 0.5], [0, 1.5, 1]] }),
    freezeMotif({ id: "swing-answer", title: "摇摆答句", composer: "Sleep Island", family: "original-jazz", transposePolicy: "component", beatSeconds: 0.28, notes: [[7, 0.66], [10, 0.34, 0.9], [12, 0.66], [10, 0.34], [7, 0.66], [6, 0.34, 0.94], [5, 0.66], [3, 1.34, 1]] }),
    freezeMotif({ id: "walking-turnaround", title: "行走回转", composer: "Sleep Island", family: "original-jazz", transposePolicy: "component", beatSeconds: 0.25, notes: [[0, 1, 0.86], [4, 1], [7, 1], [9, 1], [10, 1, 0.92], [9, 1], [8, 1], [7, 1, 1]] }),
  ]);

  class SeededRandom {
    constructor(seed) { this.state = hashString(seed) || 0x9e3779b9; }
    next() {
      let value = this.state;
      value ^= value << 13;
      value ^= value >>> 17;
      value ^= value << 5;
      this.state = value >>> 0;
      return this.state / 4294967296;
    }
    between(minimum, maximum) { return lerp(minimum, maximum, this.next()); }
    integer(minimum, maximum) { return Math.floor(this.between(minimum, maximum + 1)); }
    pick(values) { return values[Math.floor(this.next() * values.length)]; }
    shuffle(values) {
      const copy = [...values];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const target = Math.floor(this.next() * (index + 1));
        [copy[index], copy[target]] = [copy[target], copy[index]];
      }
      return copy;
    }
  }

  function querySeed() {
    const seed = new URLSearchParams(window.location.search).get("seed");
    return seed?.trim() ? seed.trim().slice(0, 64) : DEFAULT_SEED;
  }

  function queryMode() {
    const mode = new URLSearchParams(window.location.search).get("mode");
    return mode === "interactive" || mode === "growth" || mode === "ripple" || mode === "beacon" || mode === "melody" ? mode : "melody";
  }

  function queryDenseDetails() {
    const value = new URLSearchParams(window.location.search).get("denseDetails");
    if (/^(?:plus|reeds|stress)$/i.test(String(value || ""))) return "details-plus-reeds";
    if (/^(?:1|on|true|details)$/i.test(String(value || ""))) return "details";
    return "off";
  }

  /**
   * melody：一笔就是一个乐句。真实划动时序被保存，抬手后独立循环并逐轮渐弱。
   * 36×64 是轻量波场采样密度；18×32 微型响应簧片负责贴合轨迹，详细机关仍保持 9×16。
   */
  const MELODY_DEFAULTS = Object.freeze({
    repeatCount: 3,          // 原笔实时演奏后，再循环几遍
    repeatFade: 0.72,        // 每轮相对上一轮的音量
    waveRepeatFade: 1,       // 三圈物理波保持可触发远端；声音仍独立按 repeatFade 渐弱
    loopGap: 0.3,            // 抬手 / 循环接缝处的呼吸间隔（秒）
    minPeriod: 0.72,         // 点按或极短笔画也不会形成事件风暴
    maxPeriod: 8,            // 极慢长笔画的回放周期上限
    minNoteInterval: 0.04,   // 单声部最快约 25 音/秒
    maxNotes: 48,            // 每笔保存的声音格数量上限
    maxPhrases: 3,           // 同时循环的独立声部上限，超出时淘汰最旧声部
    voiceLimit: 16,          // melody 短音实际 Web Audio 并发上限
    mechanismVoiceLimit: 24,// 详细机关离散声音的并发事件上限
    frictionVoiceLimit: 12,  // 旧机关连续摩擦声的独立上限
    waveCols: 36,
    waveRows: 64,
    waveSpeed: 230,          // 画布坐标 / 秒；让波先到、机关后起的因果能被肉眼读到
    waveLife: 9,             // 足够越过整张竖屏；划线不再额外复制欧氏直线波带
    waveWidth: 60,
    wallPenalty: 140,        // 仍偏好绕墙/缺口，但不再让远端路径长到波寿命之外
    maxWaves: 48,
    componentLimit: 24,      // 让当前波前有足够槽位；声音仍由独立的 24 voice cap 限制
    strokeComponentLimit: 12,// 兼容旧宿主参数；melody 详细机关现在统一只由波前触发
    componentThreshold: 0.13,// 真实慢划及渐弱第三圈到远端仍可触发；并发仍硬封 24
    componentCycles: 1,      // 波只负责启动；机关平滑完成一次完整闭合周期
    componentPeriodScale: 0.30,// 约 0.54–2.04 s，避免旧机关长期落在波后
    componentGain: 0.66,     // 机关声部低于直接手势音，但不能小到在手机扬声器上消失
    motifCount: 12,          // 从 22 条能力池中按种子藏进随机机关；默认 9 首名曲 + 3 条原创爵士
    motifGain: 0.82,
    motifCooldown: 10,       // 已解锁能力再次演奏前的冷却（秒）
    motifVoiceLimit: 12,    // 扩库后仍硬封顶，但减少并发短句被截掉中间音的概率
    trailSeconds: 1.15,
  });

  function normalizeMelodyConfig(config) {
    const result = { ...config };
    result.repeatCount = clamp(Math.round(Number(result.repeatCount)), 1, 6);
    result.repeatFade = clamp(Number(result.repeatFade), 0.35, 0.92);
    result.waveRepeatFade = clamp(Number(result.waveRepeatFade), 0.68, 1);
    result.loopGap = clamp(Number(result.loopGap), 0.08, 1.5);
    result.minPeriod = clamp(Number(result.minPeriod), 0.35, 3);
    result.maxPeriod = clamp(Number(result.maxPeriod), result.minPeriod, 16);
    result.minNoteInterval = clamp(Number(result.minNoteInterval), 0.025, 0.2);
    result.maxNotes = clamp(Math.round(Number(result.maxNotes)), 4, 96);
    result.maxPhrases = clamp(Math.round(Number(result.maxPhrases)), 1, 4);
    result.voiceLimit = clamp(Math.round(Number(result.voiceLimit)), 4, 24);
    result.mechanismVoiceLimit = clamp(Math.round(Number(result.mechanismVoiceLimit)), 8, 40);
    result.frictionVoiceLimit = clamp(Math.round(Number(result.frictionVoiceLimit)), 2, 20);
    result.waveCols = clamp(Math.round(Number(result.waveCols)), 9, 36);
    result.waveRows = clamp(Math.round(Number(result.waveRows)), 16, 64);
    // 防止宿主同时把两边都拉满，移动端热路径最多约 2304 个轻量采样点。
    if (result.waveCols * result.waveRows > 2304) result.waveRows = Math.max(16, Math.floor(2304 / result.waveCols));
    result.waveSpeed = clamp(Number(result.waveSpeed), 120, 1200);
    result.waveLife = clamp(Number(result.waveLife), 0.6, 12);
    result.waveWidth = clamp(Number(result.waveWidth), 18, 140);
    result.wallPenalty = clamp(Number(result.wallPenalty), 24, 320);
    result.maxWaves = clamp(Math.round(Number(result.maxWaves)), 6, 48);
    result.componentLimit = clamp(Math.round(Number(result.componentLimit)), 4, 32);
    result.strokeComponentLimit = clamp(Math.round(Number(result.strokeComponentLimit)), 1, 16);
    result.componentThreshold = clamp(Number(result.componentThreshold), 0.06, 0.72);
    result.componentCycles = clamp(Math.round(Number(result.componentCycles)), 1, 4);
    result.componentPeriodScale = clamp(Number(result.componentPeriodScale), 0.25, 1.25);
    result.componentGain = clamp(Number(result.componentGain), 0.18, 0.9);
    result.motifCount = clamp(Math.round(Number(result.motifCount)), 0, 16);
    result.motifGain = clamp(Number(result.motifGain), 0.2, 1);
    result.motifCooldown = clamp(Number(result.motifCooldown), 2, 60);
    result.motifVoiceLimit = clamp(Math.round(Number(result.motifVoiceLimit)), 2, 16);
    result.trailSeconds = clamp(Number(result.trailSeconds), 0.3, 3);
    return Object.freeze(result);
  }

  function parseWaveGrid(raw) {
    const match = /^\s*(\d+)\s*[x×,]\s*(\d+)\s*$/i.exec(String(raw));
    return match ? [Number(match[1]), Number(match[2])] : null;
  }

  function resolveMelodyConfig(search = "", hostConfig = null) {
    const merged = { ...MELODY_DEFAULTS };
    if (hostConfig && typeof hostConfig === "object") {
      for (const key of Object.keys(MELODY_DEFAULTS)) {
        if (hostConfig[key] !== undefined && hostConfig[key] !== null && Number.isFinite(Number(hostConfig[key]))) merged[key] = Number(hostConfig[key]);
      }
    }
    const parameters = new URLSearchParams(search);
    const numberKeys = {
      phraseLoops: "repeatCount", phraseFade: "repeatFade", wavePhraseFade: "waveRepeatFade", phraseGap: "loopGap", phraseMin: "minPeriod", phraseMax: "maxPeriod",
      noteGap: "minNoteInterval", phraseNotes: "maxNotes", phraseLayers: "maxPhrases", voiceCap: "voiceLimit", mechanismCap: "mechanismVoiceLimit", frictionCap: "frictionVoiceLimit",
      waveSpeed: "waveSpeed", waveLife: "waveLife", waveWidth: "waveWidth", waveWall: "wallPenalty", waveCap: "maxWaves", melodyTrail: "trailSeconds",
      componentCap: "componentLimit", strokeCap: "strokeComponentLimit", componentThreshold: "componentThreshold", componentCycles: "componentCycles", componentPeriod: "componentPeriodScale", componentGain: "componentGain",
      motifCount: "motifCount", motifGain: "motifGain", motifCooldown: "motifCooldown", motifVoices: "motifVoiceLimit",
    };
    for (const [urlKey, target] of Object.entries(numberKeys)) {
      const raw = parameters.get(urlKey);
      if (raw !== null && raw.trim() !== "" && Number.isFinite(Number(raw))) merged[target] = Number(raw);
    }
    const grid = parseWaveGrid(parameters.get("waveGrid"));
    if (grid) [merged.waveCols, merged.waveRows] = grid;
    return normalizeMelodyConfig(merged);
  }

  /**
   * ripple 模式全部可调参数的默认值。覆盖优先级：URL 参数 > window.KINETIC_MAZE_CONFIG.ripple > 默认值。
   * URL 键名见 RIPPLE_URL_KEYS；宿主（网站 / WebView）可在加载脚本前注入
   *   window.KINETIC_MAZE_CONFIG = { ripple: { litMin: 6, litMax: 60, rampSeconds: 45 } };
   */
  const RIPPLE_DEFAULTS = Object.freeze({
    litMin: 8,               // 目标亮数漂移带下限（1..143）
    litMax: 80,              // 目标亮数漂移带上限（litMin+1..144）
    rampSeconds: 60,         // 慢启动时间常数（秒）：目标沿对数尺度从 1 爬向漂移带
    rampCurve: 1.2,          // 慢启动曲线指数（>1 起步更缓）
    wanderPeriods: [61, 97, 149], // 漂移带三条慢正弦的周期（秒）
    wanderWeights: [0.5, 0.32, 0.18], // 三条正弦的权重
    wanderDepth: 1.15,       // 漂移幅度放大（越大越常触到区间两端）
    boostPerSeed: 1.1,       // 每个划动种子给目标的临时抬升
    boostDecay: 14,          // 抬升的衰减时间常数（秒）
    sparkAccent: 0.7,        // 事件 accent ≥ 此值才算一次火花机会
    sparkCap: 0.55,          // 单次火花点亮邻居的概率上限
    sparkGain: 0.35,         // 概率 = 赤字 / max(sparkFloor, 目标 × sparkGain)
    sparkFloor: 3,           // 上式的分母下限
    cyclesMin: 1,            // 传播点亮的整数周期数下限（钟摆自动 ≥ 2）
    cyclesMax: 3,            // 传播点亮的整数周期数上限
    neighborOrthogonal: 1,   // 8 邻域中正交邻居权重
    neighborDiagonal: 0.55,  // 8 邻域中对角邻居权重
    ring2Orthogonal: 0.5,    // 无空邻居时，距离 2 圈正交格权重
    ring2Diagonal: 0.3,      // 距离 2 圈其余格权重
    emberDelay: 0.5,         // 接力失败后补 ember 的延迟（秒）
    trailSeconds: 0.9,       // 划动光迹渐隐时间（秒）
    seedMarkSeconds: 0.7,    // 种子扩散环时长（秒）
    hintSeconds: 6,          // 开始后提示文字停留时间（秒）
    sweepStep: 0.35,         // 轨迹采样步长（相对最小格边）
    renderFps: 30,           // 画面重绘上限（帧/秒）；逻辑与声音仍按每个 rAF 推进，不受影响
  });

  const RIPPLE_URL_KEYS = Object.freeze({
    lit: ["litMin", "litMax"], ramp: "rampSeconds", rampCurve: "rampCurve", wander: "wanderPeriods", wanderWeights: "wanderWeights", wanderDepth: "wanderDepth",
    boost: "boostPerSeed", boostDecay: "boostDecay", sparkAccent: "sparkAccent", sparkCap: "sparkCap", sparkGain: "sparkGain", sparkFloor: "sparkFloor",
    cycles: ["cyclesMin", "cyclesMax"], neighborOrthogonal: "neighborOrthogonal", neighborDiagonal: "neighborDiagonal", ring2Orthogonal: "ring2Orthogonal", ring2Diagonal: "ring2Diagonal",
    emberDelay: "emberDelay", trail: "trailSeconds", seedMark: "seedMarkSeconds", hint: "hintSeconds", sweepStep: "sweepStep", fps: "renderFps",
  });

  function parseNumberList(raw, length) {
    const values = String(raw).split(/[-~,\s]+/).filter(Boolean).map(Number);
    return values.length === length && values.every(Number.isFinite) ? values : null;
  }

  function normalizeRippleConfig(config) {
    const result = { ...config };
    const cells = ROWS * COLS;
    result.litMin = clamp(Math.round(result.litMin), 1, cells - 1);
    result.litMax = clamp(Math.round(result.litMax), result.litMin + 1, cells);
    result.rampSeconds = Math.max(0.001, result.rampSeconds);
    result.rampCurve = Math.max(0.1, result.rampCurve);
    result.wanderPeriods = result.wanderPeriods.map((period) => Math.max(1, period));
    result.boostDecay = Math.max(0.001, result.boostDecay);
    result.sparkCap = clamp(result.sparkCap, 0, 1);
    result.sparkFloor = Math.max(1e-6, result.sparkFloor);
    result.cyclesMin = clamp(Math.round(result.cyclesMin), 1, 8);
    result.cyclesMax = clamp(Math.round(result.cyclesMax), result.cyclesMin, 8);
    result.emberDelay = Math.max(0, result.emberDelay);
    result.sweepStep = clamp(result.sweepStep, 0.05, 1);
    result.renderFps = clamp(result.renderFps, 1, 120);
    return Object.freeze(result);
  }

  /** 合并 默认值 ← 宿主配置对象 ← URL 参数，返回冻结后的 ripple 配置。 */
  function resolveRippleConfig(search = "", hostConfig = null) {
    const merged = { ...RIPPLE_DEFAULTS };
    if (hostConfig && typeof hostConfig === "object") {
      for (const key of Object.keys(RIPPLE_DEFAULTS)) {
        const value = hostConfig[key];
        if (value === undefined || value === null) continue;
        if (Array.isArray(RIPPLE_DEFAULTS[key])) {
          const list = Array.isArray(value) ? value.map(Number) : parseNumberList(value, RIPPLE_DEFAULTS[key].length);
          if (list && list.length === RIPPLE_DEFAULTS[key].length && list.every(Number.isFinite)) merged[key] = list;
        } else if (Number.isFinite(Number(value))) {
          merged[key] = Number(value);
        }
      }
    }
    const parameters = new URLSearchParams(search);
    for (const [urlKey, target] of Object.entries(RIPPLE_URL_KEYS)) {
      const raw = parameters.get(urlKey);
      if (raw === null || raw.trim() === "") continue;
      if (Array.isArray(target)) {
        const list = parseNumberList(raw, target.length);
        if (list) target.forEach((key, index) => { merged[key] = list[index]; });
      } else if (Array.isArray(RIPPLE_DEFAULTS[target])) {
        const list = parseNumberList(raw, RIPPLE_DEFAULTS[target].length);
        if (list) merged[target] = list;
      } else if (Number.isFinite(Number(raw))) {
        merged[target] = Number(raw);
      }
    }
    return normalizeRippleConfig(merged);
  }

  function querySoundIntent() {
    return new URLSearchParams(window.location.search).get("sound") !== "off";
  }

  function normalizeCustomMotif(value, index) {
    if (!value || typeof value !== "object" || !Array.isArray(value.notes)) return null;
    const notes = [];
    for (const rawNote of value.notes.slice(0, 12)) {
      const semitones = Number(Array.isArray(rawNote) ? rawNote[0] : rawNote?.semitones);
      const beats = Number(Array.isArray(rawNote) ? rawNote[1] : rawNote?.beats);
      const accent = Number(Array.isArray(rawNote) ? rawNote[2] : rawNote?.accent);
      if (!Number.isFinite(semitones) || !Number.isFinite(beats)) continue;
      notes.push([clamp(Math.round(semitones), -24, 24), clamp(beats, 0.125, 4), Number.isFinite(accent) ? clamp(accent, 0.45, 1) : 0.82]);
    }
    if (notes.length < 3) return null;
    const transposePolicy = value.transposePolicy === "fixed" ? "fixed" : "component";
    const minimumSemitone = Math.min(...notes.map((note) => note[0]));
    const maximumSemitone = Math.max(...notes.map((note) => note[0]));
    const requestedRootPitch = Number(value.rootPitch ?? value.rootMidi);
    let rootPitch = null;
    if (transposePolicy === "fixed") {
      if (!Number.isFinite(requestedRootPitch)) return null;
      rootPitch = Math.round(requestedRootPitch);
      // fixed 的契约是按宿主声明的 MIDI 根音原样演奏。越界时拒绝整条定义，
      // 不能为了塞进安全音域而静默 clamp，否则“固定调”仍会被换调。
      if (rootPitch + minimumSemitone < 40 || rootPitch + maximumSemitone > 88) return null;
    }
    const rawId = String(value.id || `custom-${index + 1}`).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    const id = (rawId || `custom-${index + 1}`).slice(0, 48);
    return freezeMotif({
      id,
      title: String(value.title || `自定义短句 ${index + 1}`).slice(0, 32),
      composer: String(value.composer || "Custom").slice(0, 48),
      family: "custom",
      collection: "custom",
      transposePolicy,
      rootPitch,
      beatSeconds: clamp(Number(value.beatSeconds) || 0.28, 0.14, 0.65),
      enabled: value.enabled !== false,
      notes,
    });
  }

  function resolveMotifSettings(search = "", hostConfig = null) {
    const parameters = new URLSearchParams(search);
    const rawEnabled = parameters.get("motifs") ?? parameters.get("motif");
    let enabled = hostConfig?.motifEnabled !== false;
    if (/^(?:off|false|0|no)$/i.test(String(rawEnabled || ""))) enabled = false;
    if (/^(?:on|true|1|yes)$/i.test(String(rawEnabled || ""))) enabled = true;
    const custom = Array.isArray(hostConfig?.customMotifs)
      ? hostConfig.customMotifs.map(normalizeCustomMotif).filter(Boolean)
      : [];
    const byId = new Map();
    for (const motif of [...BUILT_IN_MOTIFS, ...custom]) byId.set(motif.id, motif);
    const disabledIds = new Set(
      Object.entries(hostConfig?.motifAbilities || {}).filter(([, value]) => value === false).map(([id]) => id),
    );
    for (const id of String(parameters.get("motifOff") || "").split(",").map((item) => item.trim()).filter(Boolean)) disabledIds.add(id);
    return Object.freeze({
      enabled,
      library: Object.freeze([...byId.values()]),
      disabledIds: Object.freeze([...disabledIds]),
    });
  }

  function queryPerformance() {
    const parameters = new URLSearchParams(window.location.search);
    const duration = Number(parameters.get("duration"));
    const isExport = parameters.get("performance") === "export" && Math.abs(duration - 180) < 1e-9;
    return Object.freeze({ isExport, duration: isExport ? 180 : null });
  }

  function makeTypeSequence(random) {
    const remaining = { ...QUOTAS };
    const sequence = [];
    while (sequence.length < ROWS * COLS) {
      const prior = sequence.at(-1);
      const priorPrior = sequence.at(-2);
      let candidates = TYPES.filter((type) => remaining[type] > 0);
      if (prior === priorPrior) {
        const alternatives = candidates.filter((type) => type !== prior);
        if (alternatives.length) candidates = alternatives;
      }
      const total = candidates.reduce((sum, type) => sum + remaining[type], 0);
      let cursor = random.next() * total;
      let selected = candidates.at(-1);
      for (const type of candidates) {
        cursor -= remaining[type];
        if (cursor <= 0) { selected = type; break; }
      }
      sequence.push(selected);
      remaining[selected] -= 1;
    }
    return sequence;
  }

  function rotorPattern(random) {
    const patterns = [
      [0, 0.19, 0.47, 0.76],
      [0, 0.13, 0.39, 0.7],
      [0, 0.28, 0.51, 0.83],
      [0, 0.16, 0.36, 0.61, 0.84],
      [0, 0.11, 0.31, 0.52, 0.72, 0.9],
    ];
    return random.pick(patterns).map((onset, index) => ({
      onset,
      length: random.between(0.58, 1),
      degree: [0, 2, 4, 1, 5, 3][index % 6],
    }));
  }

  const WALL_SIDES = Object.freeze(["top", "right", "bottom", "left"]);

  function makeCell(id) {
    const row = Math.floor(id / COLS);
    const col = id % COLS;
    return { id, row, col, x: FRAME.x + col * CELL_W, y: FRAME.y + row * CELL_H, w: CELL_W, h: CELL_H };
  }

  function wallKeyForCell(cell, side) {
    if (side === "top") return `h:${cell.row}:${cell.col}`;
    if (side === "bottom") return `h:${cell.row + 1}:${cell.col}`;
    if (side === "left") return `v:${cell.col}:${cell.row}`;
    return `v:${cell.col + 1}:${cell.row}`;
  }

  function makeWallGraph(random) {
    const edgeMap = new Map();
    const horizontalEdges = [];
    const verticalEdges = [];
    const addHorizontal = (row, col) => {
      const key = `h:${row}:${col}`;
      if (edgeMap.has(key)) return;
      const edge = { key, orientation: "horizontal", row, col, x1: FRAME.x + col * CELL_W, y1: FRAME.y + row * CELL_H, x2: FRAME.x + (col + 1) * CELL_W, y2: FRAME.y + row * CELL_H };
      edgeMap.set(key, edge); horizontalEdges.push(edge);
    };
    const addVertical = (col, row) => {
      const key = `v:${col}:${row}`;
      if (edgeMap.has(key)) return;
      const edge = { key, orientation: "vertical", row, col, x1: FRAME.x + col * CELL_W, y1: FRAME.y + row * CELL_H, x2: FRAME.x + col * CELL_W, y2: FRAME.y + (row + 1) * CELL_H };
      edgeMap.set(key, edge); verticalEdges.push(edge);
    };
    for (let row = 0; row <= ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        if (row === 0 || row === ROWS || random.next() >= 0.18) addHorizontal(row, col);
      }
    }
    for (let col = 0; col <= COLS; col += 1) {
      for (let row = 0; row < ROWS; row += 1) {
        if (col === 0 || col === COLS || random.next() >= 0.18) addVertical(col, row);
      }
    }
    for (let id = 0; id < ROWS * COLS; id += 1) {
      const cell = makeCell(id);
      if (WALL_SIDES.some((side) => edgeMap.has(wallKeyForCell(cell, side)))) continue;
      const side = WALL_SIDES[hashString(`wall-fallback:${id}`) % WALL_SIDES.length];
      if (side === "top") addHorizontal(cell.row, cell.col);
      else if (side === "bottom") addHorizontal(cell.row + 1, cell.col);
      else if (side === "left") addVertical(cell.col, cell.row);
      else addVertical(cell.col + 1, cell.row);
    }
    const sidesForCell = (cell) => WALL_SIDES.filter((side) => edgeMap.has(wallKeyForCell(cell, side)));
    return { edgeMap, edgeKeys: new Set(edgeMap.keys()), horizontalEdges, verticalEdges, segments: [...horizontalEdges, ...verticalEdges], sidesForCell };
  }

  function wallAnchor(cell, side, amount = 0.5) {
    const t = clamp(amount, 0.08, 0.92);
    if (side === "top") return { x: lerp(cell.x, cell.x + cell.w, t), y: cell.y, inwardX: 0, inwardY: 1, tangentX: 1, tangentY: 0 };
    if (side === "right") return { x: cell.x + cell.w, y: lerp(cell.y, cell.y + cell.h, t), inwardX: -1, inwardY: 0, tangentX: 0, tangentY: 1 };
    if (side === "bottom") return { x: lerp(cell.x + cell.w, cell.x, t), y: cell.y + cell.h, inwardX: 0, inwardY: -1, tangentX: -1, tangentY: 0 };
    return { x: cell.x, y: lerp(cell.y + cell.h, cell.y, t), inwardX: 1, inwardY: 0, tangentX: 0, tangentY: -1 };
  }

  function chooseWallSide(cell, wallGraph, random, preferred = null) {
    const sides = wallGraph.sidesForCell(cell);
    if (preferred && sides.includes(preferred) && random.next() < 0.76) return preferred;
    return random.pick(sides);
  }

  function gliderSideEndpoints(cell, side, inset) {
    if (side === "top") return [{ x: cell.x + inset, y: cell.y + inset }, { x: cell.x + cell.w - inset, y: cell.y + inset }];
    if (side === "right") return [{ x: cell.x + cell.w - inset, y: cell.y + inset }, { x: cell.x + cell.w - inset, y: cell.y + cell.h - inset }];
    if (side === "bottom") return [{ x: cell.x + cell.w - inset, y: cell.y + cell.h - inset }, { x: cell.x + inset, y: cell.y + cell.h - inset }];
    return [{ x: cell.x + inset, y: cell.y + cell.h - inset }, { x: cell.x + inset, y: cell.y + inset }];
  }

  function makeGliderRoute(cell, wallGraph, random, size) {
    const present = new Set(wallGraph.sidesForCell(cell));
    const candidates = [];
    for (let start = 0; start < WALL_SIDES.length; start += 1) {
      if (!present.has(WALL_SIDES[start])) continue;
      const sides = [];
      for (let offset = 0; offset < 3; offset += 1) {
        const side = WALL_SIDES[(start + offset) % WALL_SIDES.length];
        if (!present.has(side)) break;
        sides.push(side);
      }
      candidates.push(sides);
    }
    const maximum = Math.max(...candidates.map((sides) => sides.length));
    const preferMultiple = maximum >= 2 && hashString(`glider-route:${cell.id}`) % 10 >= 3;
    const desired = preferMultiple ? Math.min(maximum, random.next() < 0.44 ? 3 : 2) : 1;
    const eligible = candidates.filter((sides) => sides.length >= desired);
    const sides = random.pick(eligible).slice(0, desired);
    const inset = size / 2;
    const points = [];
    for (const side of sides) {
      const [start, end] = gliderSideEndpoints(cell, side, inset);
      if (!points.length || Math.hypot(points.at(-1).x - start.x, points.at(-1).y - start.y) > 1e-7) points.push(start);
      points.push(end);
    }
    const lengths = [];
    let totalLength = 0;
    for (let index = 1; index < points.length; index += 1) {
      totalLength += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
      lengths.push(totalLength);
    }
    return { sides, edgeKeys: sides.map((side) => wallKeyForCell(cell, side)), points, lengths, totalLength };
  }

  function pointAlongRoute(route, amount) {
    const distance = clamp(amount) * route.totalLength;
    let priorDistance = 0;
    for (let index = 0; index < route.lengths.length; index += 1) {
      const boundary = route.lengths[index];
      if (distance <= boundary + 1e-9) {
        const span = boundary - priorDistance || 1;
        return {
          x: lerp(route.points[index].x, route.points[index + 1].x, (distance - priorDistance) / span),
          y: lerp(route.points[index].y, route.points[index + 1].y, (distance - priorDistance) / span),
        };
      }
      priorDistance = boundary;
    }
    return { ...route.points.at(-1) };
  }

  function makeRibbonCurve(cell, wallGraph, random) {
    const startSide = chooseWallSide(cell, wallGraph, random);
    const start = { ...wallAnchor(cell, startSide, random.between(0.24, 0.76)), side: startSide, edgeKey: wallKeyForCell(cell, startSide) };
    const otherSides = wallGraph.sidesForCell(cell).filter((side) => side !== startSide);
    const endSide = otherSides.length && random.next() < 0.52 ? random.pick(otherSides) : null;
    const end = endSide
      ? { ...wallAnchor(cell, endSide, random.between(0.24, 0.76)), side: endSide, edgeKey: wallKeyForCell(cell, endSide) }
      : { x: cell.x + random.between(0.36, 0.72) * cell.w, y: cell.y + random.between(0.3, 0.72) * cell.h, inwardX: 0, inwardY: 0, tangentX: 0, tangentY: 0, side: null, edgeKey: null };
    const depth = Math.min(cell.w, cell.h) * random.between(0.26, 0.38);
    const p0 = { x: start.x, y: start.y };
    const p1 = { x: start.x + start.inwardX * depth + start.tangentX * random.between(-10, 10), y: start.y + start.inwardY * depth + start.tangentY * random.between(-10, 10) };
    const p3 = { x: end.x, y: end.y };
    const p2 = endSide
      ? { x: end.x + end.inwardX * depth + end.tangentX * random.between(-10, 10), y: end.y + end.inwardY * depth + end.tangentY * random.between(-10, 10) }
      : { x: end.x + random.between(-22, 22), y: end.y + random.between(-22, 22) };
    return { start, end, points: [p0, p1, p2, p3] };
  }

  function makeComponent(id, type, random, wallGraph) {
    const cell = makeCell(id);
    const common = {
      id, type, cell,
      centerX: cell.x + cell.w / 2,
      centerY: cell.y + cell.h / 2,
      pitch: 50 + [0, 2, 4, 7, 9][(cell.row + cell.col * 2 + id) % 5] + (cell.row % 3) * 12,
    };
    if (type === "pendulum") {
      const side = chooseWallSide(cell, wallGraph, random, "top");
      return { ...common, variant: { anchor: { ...wallAnchor(cell, side, random.between(0.34, 0.66)), side, edgeKey: wallKeyForCell(cell, side) }, length: random.between(42, 69), amplitude: random.between(0.38, 0.76), material: random.pick(["wrapped", "wood", "ceramic", "bell"]), duration: random.between(3.4, 5.6) } };
    }
    if (type === "glider") {
      const size = random.between(21, 28);
      return { ...common, variant: { route: makeGliderRoute(cell, wallGraph, random, size), material: random.pick(["wood", "felt", "ceramic", "metal"]), duration: random.between(3.1, 5.2), size } };
    }
    if (type === "rotor") {
      return { ...common, variant: { duration: random.between(4.2, 6.8), radius: random.between(24, 34), spokes: rotorPattern(random), ring: random.pick(["plain", "double", "broken"]) } };
    }
    if (type === "mallet") {
      const count = random.integer(1, 4);
      const side = chooseWallSide(cell, wallGraph, random, random.next() > 0.42 ? "bottom" : null);
      const strikePhases = Array.from({ length: count }, (_, index) => 0.18 + index * (0.56 / Math.max(1, count - 1)));
      const anchors = Array.from({ length: count }, (_, index) => ({ ...wallAnchor(cell, side, (index + 1) / (count + 1)), side, edgeKey: wallKeyForCell(cell, side) }));
      return { ...common, variant: { duration: random.between(1.8, 3.1), count, strikePhases, anchors, side, travel: random.between(34, 61) } };
    }
    return { ...common, variant: { duration: random.between(4, 6.8), curve: makeRibbonCurve(cell, wallGraph, random), landmarks: random.pick([[0.26, 0.68], [0.2, 0.5, 0.82], [0.34, 0.74]]) } };
  }

  /**
   * 18×32 个微型响应簧片只保存 TypedArray 几何，不拥有独立时钟、事件或音源。
   * 它们把 9×16 详细机关之间的空白补成四倍密度，并直接读取已有波场，因此成本接近一次 576 点扫描。
   */
  function makeResponseField(seed) {
    const count = RESPONSE_COLS * RESPONSE_ROWS;
    const x = new Float32Array(count);
    const y = new Float32Array(count);
    const axisX = new Float32Array(count);
    const axisY = new Float32Array(count);
    const size = new Float32Array(count);
    const random = new SeededRandom(`${seed}:response-reeds`);
    const stepX = FRAME.width / RESPONSE_COLS;
    const stepY = FRAME.height / RESPONSE_ROWS;
    for (let row = 0, index = 0; row < RESPONSE_ROWS; row += 1) {
      for (let col = 0; col < RESPONSE_COLS; col += 1, index += 1) {
        const angle = random.between(-Math.PI, Math.PI);
        x[index] = FRAME.x + (col + 0.5) * stepX + random.between(-stepX * 0.1, stepX * 0.1);
        y[index] = FRAME.y + (row + 0.5) * stepY + random.between(-stepY * 0.1, stepY * 0.1);
        axisX[index] = Math.cos(angle);
        axisY[index] = Math.sin(angle);
        size[index] = random.between(5.5, 9.5);
      }
    }
    return Object.freeze({ cols: RESPONSE_COLS, rows: RESPONSE_ROWS, count, x, y, axisX, axisY, size });
  }

  function assignMotifAbilities(seed, components, motifSettings = null, requestedCount = BUILT_IN_MOTIFS.length) {
    const library = motifSettings?.library || BUILT_IN_MOTIFS;
    const disabledIds = new Set(motifSettings?.disabledIds || []);
    const random = new SeededRandom(`${seed}:motif-abilities`);
    const custom = library.filter((motif) => motif.family === "custom");
    const diverseByComposer = (motifs) => {
      const shuffled = random.shuffle(motifs);
      const firstPass = [];
      const laterPass = [];
      const seen = new Set();
      for (const motif of shuffled) {
        const composer = String(motif.composer || motif.id);
        if (seen.has(composer)) laterPass.push(motif);
        else { seen.add(composer); firstPass.push(motif); }
      }
      return [...firstPass, ...laterPass];
    };
    const jazz = random.shuffle(library.filter((motif) => motif.family === "original-jazz"));
    const named = diverseByComposer(library.filter((motif) => motif.family !== "custom" && motif.family !== "original-jazz"));
    const builtIn = [];
    // 名曲是主要发现内容；原创爵士约占四分之一，避免扩库后仍被某一类语汇占满。
    while (named.length || jazz.length) {
      for (let count = 0; count < 3 && named.length; count += 1) builtIn.push(named.shift());
      if (jazz.length) builtIn.push(jazz.shift());
    }
    const motifs = [...custom, ...builtIn].slice(0, clamp(Math.round(requestedCount), 0, Math.min(16, library.length)));
    // 先从一个随 seed 平移的 3×3 稀疏格中选位置：最多 16 个能力也能严格保持 Chebyshev 距离 ≥3。
    // 机关类型与墙图仍随机，因此不会形成视觉上重复的同款阵列。
    // 16 个能力需要 6×3=18 个候选格；此时只能使用拥有 6 行的 rowPhase=0。
    // 默认 12 个能力仍可在三个行、列相位间平移，跨 seed 覆盖整张 16×9 棋盘。
    const rowPhase = motifs.length > 15 ? 0 : random.integer(0, 2);
    const colPhase = random.integer(0, 2);
    const spacedCandidates = components.filter((component) => component.cell.row % 3 === rowPhase && component.cell.col % 3 === colPhase);
    const spacedIds = new Set(spacedCandidates.map((component) => component.id));
    const candidates = [
      ...random.shuffle(spacedCandidates.map((component) => component.id)),
      ...random.shuffle(components.filter((component) => !spacedIds.has(component.id)).map((component) => component.id)),
    ];
    const selected = [];
    for (let slot = 0; slot < motifs.length; slot += 1) {
      let candidateIndex = candidates.findIndex((componentId) => selected.every((selectedId) => {
        const left = components[componentId].cell;
        const right = components[selectedId].cell;
        return Math.max(Math.abs(left.row - right.row), Math.abs(left.col - right.col)) >= 3;
      }));
      if (candidateIndex < 0) candidateIndex = 0;
      const [componentId] = candidates.splice(candidateIndex, 1);
      if (!Number.isInteger(componentId)) break;
      const motif = motifs[slot];
      components[componentId].motifAbility = Object.freeze({
        id: motif.id,
        title: motif.title,
        composer: motif.composer,
        family: motif.family,
        transposePolicy: motif.transposePolicy,
        rootPitch: motif.rootPitch,
        slot,
        noteCount: motif.notes.length,
        enabled: motifSettings?.enabled !== false && motif.enabled !== false && !disabledIds.has(motif.id),
      });
      selected.push(componentId);
    }
  }

  function buildWorld(seed, motifSettings = null, motifCount = BUILT_IN_MOTIFS.length) {
    const wallGraph = makeWallGraph(new SeededRandom(`${seed}:walls`));
    const random = new SeededRandom(`${seed}:components`);
    const types = makeTypeSequence(random);
    const components = types.map((type, id) => makeComponent(id, type, random, wallGraph));
    assignMotifAbilities(seed, components, motifSettings, motifCount);
    return { seed, components, responseField: makeResponseField(seed), motifLibrary: motifSettings?.library || BUILT_IN_MOTIFS, wallGraph, segments: wallGraph.segments };
  }

  function basePeriod(component) {
    return component.variant.duration;
  }

  function tailDuration() {
    return 0;
  }

  function cycleCountFor(component, activationOrdinal, targetCount, mode, bounds = null) {
    let minimum = bounds ? bounds.min : mode === "oneShot" ? 1 : targetCount >= 36 ? 2 : 1;
    let maximum = bounds ? bounds.max : mode === "oneShot" ? 4 : targetCount >= 64 ? 4 : 3;
    if (component.type === "pendulum") minimum = Math.max(2, minimum);
    return minimum + hashString(`${component.id}:${activationOrdinal}:${targetCount}:${mode}:cycles`) % (maximum - minimum + 1);
  }

  function singleCycleEvents(component) {
    const period = basePeriod(component);
    if (component.type === "pendulum") {
      return [
        { offset: period * 0.25, kind: "pendulum-center", pitch: component.pitch, accent: 1, isImpact: true },
        { offset: period * 0.75, kind: "pendulum-center", pitch: component.pitch + 7, accent: 0.56, isImpact: false },
      ];
    }
    if (component.type === "glider") {
      const normalizedStops = component.variant.route.lengths.map((length) => length / component.variant.route.totalLength);
      const phases = [0.96];
      for (const stop of normalizedStops) {
        phases.push(stop * 0.5);
        if (stop < 0.999) phases.push(1 - stop * 0.5);
      }
      return [...new Set(phases.map((phase) => Number(phase.toFixed(6))))].sort((a, b) => a - b).map((phase, index) => ({
        offset: period * phase,
        kind: `glider-${component.variant.material}`,
        pitch: component.pitch - 12 + (index % 2) * 5,
        accent: phase === 0.5 ? 1 : 0.58,
        isImpact: phase === 0.5,
      }));
    }
    if (component.type === "rotor") {
      return component.variant.spokes.map((spoke, index) => ({
        offset: 0.06 + spoke.onset * (period - 0.12),
        kind: "rotor-tine",
        pitch: component.pitch + [0, 4, 7, 11, 14, 16][spoke.degree],
        accent: index === 0 ? 1 : 0.62,
        isImpact: false,
      }));
    }
    if (component.type === "mallet") {
      return component.variant.strikePhases.map((phase, index) => ({
        offset: phase * period,
        kind: "felt-mallet",
        pitch: component.pitch - 12 + index * 3,
        accent: index === 0 ? 1 : 0.72,
        isImpact: index === 0,
      }));
    }
    const phases = component.variant.landmarks.flatMap((landmark) => [landmark * 0.5, 1 - landmark * 0.5]);
    return phases.sort((a, b) => a - b).map((phase, index) => ({
      offset: phase * period,
      kind: index % 3 === 0 ? "ribbon-tap" : "ribbon-brush",
      pitch: component.pitch + (index % 4) * 2,
      accent: index % 3 === 0 ? 0.72 : 0.42,
      isImpact: false,
    }));
  }

  function eventBlueprints(component, cycleCount = 1) {
    const period = basePeriod(component);
    const single = singleCycleEvents(component);
    return Array.from({ length: cycleCount }, (_, cycleIndex) => single.map((event) => ({ ...event, offset: event.offset + cycleIndex * period, cycleNumber: cycleIndex + 1 }))).flat();
  }

  function restPose(component) {
    if (component.type === "mallet") return Object.freeze({ value: 0, heads: Array(component.variant.count).fill(0), energy: 0 });
    return Object.freeze({ value: component.type === "pendulum" ? -component.variant.amplitude : 0, energy: 0 });
  }

  function punchEnvelope(progress, center) {
    const anticipation = 0.105;
    const release = 0.19;
    if (progress < center - anticipation || progress > center + release) return 0;
    if (progress <= center) return smoothstep((progress - center + anticipation) / anticipation);
    return 1 - smoothstep((progress - center) / release);
  }

  function activePose(component, localTime, activation = null) {
    const period = activation?.basePeriod ?? basePeriod(component);
    const movementDuration = activation?.movementDuration ?? period;
    if (localTime <= 0 || localTime >= movementDuration - 1e-9) return restPose(component);
    const progress = (localTime % period) / period;
    if (component.type === "pendulum") {
      const value = -Math.cos(progress * TAU) * component.variant.amplitude;
      return { value, energy: 0.55 + Math.abs(Math.sin(progress * TAU)) * 0.45 };
    }
    if (component.type === "glider") {
      const value = (1 - Math.cos(progress * TAU)) / 2;
      return { value, energy: 0.5 + Math.abs(Math.sin(progress * TAU)) * 0.5 };
    }
    if (component.type === "rotor") return { value: progress, energy: 0.76 };
    if (component.type === "mallet") {
      const breathingTravel = (1 - Math.cos(progress * TAU)) * 0.04;
      const heads = component.variant.strikePhases.map((center, index) => Math.max(breathingTravel * (0.88 + index * 0.04), punchEnvelope(progress, center)));
      return { value: Math.max(...heads), heads, energy: 0.46 + Math.max(...heads) * 0.54 };
    }
    const value = (1 - Math.cos(progress * TAU)) / 2;
    return { value, energy: 0.5 + Math.abs(Math.sin(progress * TAU)) * 0.5 };
  }

  class ActivationManager {
    constructor(components) {
      this.components = components;
      this.active = new Map();
      this.completed = [];
      this.allActivations = [];
      this.lastActivationByComponent = new Array(components.length).fill(null);
      this.activationCounts = new Map();
      this.sequence = 0;
    }

    isOccupiedAt(componentId, at) {
      const activation = this.lastActivationByComponent[componentId];
      return Boolean(activation && at + 1e-9 >= activation.startedAt && at < activation.completeAt - 1e-9);
    }

    activeCountAt(at, predicate = null) {
      let count = 0;
      const matches = (activation) => at + 1e-9 >= activation.startedAt
        && at < activation.completeAt - 1e-9
        && (!predicate || predicate(activation));
      for (const activation of this.active.values()) if (matches(activation)) count += 1;
      // completed 按 completeAt 递增；低帧率补算历史 sampleTime 时，只需回看仍覆盖该时刻的尾部。
      for (let index = this.completed.length - 1; index >= 0; index -= 1) {
        const activation = this.completed[index];
        if (activation.completeAt <= at + 1e-9) break;
        if (matches(activation)) count += 1;
      }
      return count;
    }

    start(componentId, startedAt, mode = "oneShot", cycleIndex = 0, options = {}) {
      // melody 的 60 Hz 波前会在低帧率时补算过去的 sampleTime；即使旧 activation
      // 已被本帧 update() 移出 active，也不能在其历史占用区间内追溯重启。
      if (this.active.has(componentId) || this.isOccupiedAt(componentId, startedAt)) return null;
      const component = this.components[componentId];
      if (!component) return null;
      const ordinal = this.activationCounts.get(componentId) || 0;
      const targetCount = options.targetCount || (mode === "oneShot" ? 1 : 0);
      const cycleCount = options.cycleCount || cycleCountFor(component, ordinal, targetCount, mode);
      const periodScale = clamp(Number(options.periodScale) || 1, 0.25, 1.25);
      const period = basePeriod(component) * periodScale;
      const movementDuration = period * cycleCount;
      const activation = {
        id: ++this.sequence,
        componentId,
        mode,
        cycleIndex: cycleIndex ?? ordinal,
        cycleCount,
        basePeriod: period,
        periodScale,
        targetCount,
        startedAt,
        gestureDuration: movementDuration,
        movementDuration,
        tailDuration: 0,
        completeAt: startedAt + movementDuration,
        gainScale: Number.isFinite(Number(options.gainScale)) ? Number(options.gainScale) : 1,
        events: eventBlueprints(component, cycleCount).map((event) => ({ ...event, offset: event.offset * periodScale })),
      };
      this.activationCounts.set(componentId, ordinal + 1);
      this.active.set(componentId, activation);
      this.allActivations.push(activation);
      this.lastActivationByComponent[componentId] = activation;
      return activation;
    }

    update(now) {
      const finished = [];
      for (const [componentId, activation] of this.active) {
        if (now + 1e-9 < activation.completeAt) continue;
        this.active.delete(componentId);
        finished.push(activation);
      }
      finished.sort((left, right) => left.completeAt - right.completeAt || left.componentId - right.componentId);
      for (const activation of finished) this.completed.push({ ...activation, completedAt: activation.completeAt });
      if (this.completed.length > 4096) this.completed.splice(0, this.completed.length - 4096);
      return finished;
    }

    drainPersistent(now) {
      const retained = [];
      for (const [componentId, activation] of this.active) {
        if (activation.mode !== "persistent") continue;
        if (activation.startedAt > now + 1e-9) {
          this.active.delete(componentId);
          continue;
        }
        retained.push(componentId);
      }
      return retained.sort((left, right) => left - right);
    }

    stateFor(component, now) {
      const activation = this.active.get(component.id);
      if (!activation || now < activation.startedAt || now >= activation.completeAt) return { phase: "darkFrozen", pose: restPose(component), activation: activation || null, progress: 0, visualEnvelope: 0 };
      const localTime = clamp(now - activation.startedAt, 0, activation.movementDuration);
      const progress = localTime / activation.movementDuration;
      let phase = "active";
      if (progress < 0.04) phase = "anticipate";
      else if (progress >= 0.92) phase = "settle";
      const onsetSeconds = Math.min(0.11, activation.movementDuration * 0.25);
      const settleSeconds = Math.min(0.2, activation.movementDuration * 0.3);
      const onset = smoothstep(localTime / onsetSeconds);
      const settle = 1 - smoothstep((localTime - (activation.movementDuration - settleSeconds)) / settleSeconds);
      // 当前波峰撞到的机关最清楚；约半秒后退到持续演奏的次级亮度，但运动不会停、也不会闪暗。
      const freshAccent = lerp(0.58, 1, 1 - smoothstep(clamp((localTime - 0.12) / 0.46)));
      const visualEnvelope = activation.mode === "melodyWave" ? Math.min(onset, settle) * freshAccent : 1;
      return { phase, pose: activePose(component, localTime, activation), activation, progress, visualEnvelope };
    }

    eventsForActivationsBetween(activations, fromTime, toTime) {
      const events = [];
      for (const activation of activations) {
        const component = this.components[activation.componentId];
        for (const blueprint of activation.events) {
          const at = activation.startedAt + blueprint.offset;
          if (at > fromTime + 1e-9 && at <= toTime + 1e-9) {
            events.push({
              ...blueprint,
              at,
              activationId: activation.id,
              activationMode: activation.mode,
              componentId: component.id,
              type: component.type,
              sourceU: (component.centerX - FRAME.x) / FRAME.width,
              layer: component.type === "mallet" ? "pulse" : component.type === "rotor" ? "harmony" : component.type === "pendulum" ? "material" : "flow",
              gainScale: (component.type === "mallet" ? 0.72 : component.type === "rotor" ? 0.56 : component.type === "pendulum" ? 0.5 : component.type === "glider" ? 0.56 : 0.38) * activation.gainScale,
            });
          }
        }
      }
      return events.sort((left, right) => left.at - right.at || left.componentId - right.componentId);
    }

    eventsBetween(fromTime, toTime) {
      return this.eventsForActivationsBetween(this.active.values(), fromTime, toTime);
    }

    litCountAt(now) {
      let count = 0;
      for (const activation of this.active.values()) {
        if (now + 1e-9 >= activation.startedAt && now < activation.completeAt - 1e-9) count += 1;
      }
      return count;
    }

    snapshot(now) {
      const active = [...this.active.values()].map((activation) => ({
        ...activation,
        phase: this.stateFor(this.components[activation.componentId], now).phase,
      })).filter((activation) => activation.phase !== "darkFrozen");
      const litComponentIds = active.map((activation) => activation.componentId).sort((left, right) => left - right);
      return {
        active,
        litComponentIds,
        litCount: litComponentIds.length,
        completedCount: this.completed.length,
      };
    }
  }

  function eventLoad(event) {
    const impact = Boolean(event.isImpact);
    const pitched = event.type === "pendulum" || event.type === "rotor" || event.type === "mallet" || event.kind === "ribbon-tap";
    return { total: 1, impact: impact ? 1 : 0, pitched: pitched ? 1 : 0 };
  }

  function compactFutureTimes(times, after) {
    let write = 0;
    for (let read = 0; read < times.length; read += 1) {
      if (times[read] > after + 1e-9) times[write++] = times[read];
    }
    times.length = write;
    return times;
  }

  class PopulationConductor {
    constructor(seed, components, manager, options = {}) {
      this.seed = seed;
      this.components = components;
      this.manager = manager;
      this.exportMode = options.exportMode === true;
      this.duration = this.exportMode ? 180 : null;
      this.finalePrepAt = 140;
      this.retireStart = 168;
      this.retireEnd = 178;
      this.accepting = true;
      this.targetCount = 0;
      this.entries = this.makePlan();
      this.nextEntryIndex = 0;
      this.futureDebutIds = new Set(this.entries.map((entry) => entry.componentId));
      this.rotationOrder = this.orderedComponents(this.components.length).map((component) => component.id);
      this.rotationCursor = MAX_LIT;
      this.replacementCount = 0;
      this.retirements = [];
    }

    orderedComponents(limit = MAX_LIT) {
      const random = new SeededRandom(`${this.seed}:growth-order`);
      const candidates = random.shuffle(this.components).map((component, index) => ({ component, jitter: index / 10000 }));
      const selected = [];
      const typeCounts = new Map(TYPES.map((type) => [type, 0]));
      while (selected.length < limit) {
        const previous = selected.at(-1);
        candidates.sort((left, right) => {
          const leftDistance = previous ? Math.abs(left.component.cell.col - previous.cell.col) + Math.abs(left.component.cell.row - previous.cell.row) * 0.35 : 4;
          const rightDistance = previous ? Math.abs(right.component.cell.col - previous.cell.col) + Math.abs(right.component.cell.row - previous.cell.row) * 0.35 : 4;
          const leftScore = typeCounts.get(left.component.type) * 9 - Math.min(6, leftDistance) + left.jitter;
          const rightScore = typeCounts.get(right.component.type) * 9 - Math.min(6, rightDistance) + right.jitter;
          return leftScore - rightScore || left.component.id - right.component.id;
        });
        const next = candidates.shift().component;
        selected.push(next);
        typeCounts.set(next.type, typeCounts.get(next.type) + 1);
      }
      return selected;
    }

    makePlan() {
      const milestones = this.exportMode ? [
        { at: 0, count: 1 }, { at: 4, count: 2 }, { at: 9, count: 4 },
        { at: 16, count: 8 }, { at: 25, count: 16 }, { at: 36, count: 24 },
        { at: 49, count: 36 }, { at: 63, count: 48 }, { at: 78, count: 64 },
        { at: 94, count: 80 }, { at: 108, count: 96 }, { at: 118, count: 112 },
        { at: 128, count: 128 },
      ] : [
        { at: 0, count: 1 }, { at: 2, count: 2 }, { at: 5, count: 4 },
        { at: 9, count: 8 }, { at: 14, count: 16 }, { at: 20, count: 24 },
        { at: 27, count: 36 }, { at: 35, count: 48 }, { at: 44, count: 64 },
        { at: 54, count: 80 }, { at: 65, count: 96 }, { at: 77, count: 112 },
        { at: 90, count: 128 },
      ];
      const ordered = this.orderedComponents(MAX_LIT);
      const entries = [];
      let cursor = 0;
      let previousCount = 0;
      for (const milestone of milestones) {
        const additions = milestone.count - previousCount;
        const window = milestone.at === 0 ? 0 : TICK_SECONDS * 2;
        for (let index = 0; index < additions; index += 1) {
          const spread = additions === 1 ? 0 : index / (additions - 1);
          const at = milestone.at === 0 ? 0 : milestone.at - window + spread * window;
          entries.push({
            index: entries.length,
            componentId: ordered[cursor++].id,
            type: ordered[cursor - 1].type,
            at: Number(Math.max(0, at).toFixed(6)),
            milestoneAt: milestone.at,
            milestoneCount: milestone.count,
          });
        }
        previousCount = milestone.count;
      }
      return entries;
    }

    retireNotBefore(component) {
      const period = basePeriod(component);
      const available = Math.max(0, this.retireEnd - this.retireStart - period);
      const random = new SeededRandom(`${this.seed}:retire:${component.id}`);
      const columnDistance = Math.abs(component.cell.col - (COLS - 1) / 2) / ((COLS - 1) / 2);
      const rowDistance = Math.abs(component.cell.row - (ROWS - 1) / 2) / ((ROWS - 1) / 2);
      const edgeToCenter = clamp((columnDistance + rowDistance) * 0.5, 0, 1);
      const gentleTail = component.type === "pendulum" || component.type === "ribbon" ? 0.14 : component.type === "glider" ? -0.12 : 0;
      const fraction = clamp(edgeToCenter * 0.46 + random.next() * 0.54 + gentleTail, 0, 1);
      return this.retireStart + available * fraction;
    }

    advanceTo(now) {
      while (this.nextEntryIndex < this.entries.length && this.entries[this.nextEntryIndex].at <= now + 1e-9) {
        const entry = this.entries[this.nextEntryIndex++];
        this.targetCount = this.nextEntryIndex;
        this.futureDebutIds.delete(entry.componentId);
        this.manager.start(entry.componentId, entry.at, "persistent", 0, { targetCount: this.targetCount });
      }
    }

    nextReplacement(now, maximumPeriod = Infinity) {
      for (let offset = 0; offset < this.rotationOrder.length * 2; offset += 1) {
        const index = (this.rotationCursor + offset) % this.rotationOrder.length;
        const componentId = this.rotationOrder[index];
        if (this.manager.active.has(componentId) || this.futureDebutIds.has(componentId)) continue;
        if (basePeriod(this.components[componentId]) > maximumPeriod + 1e-9) continue;
        this.rotationCursor = (index + 1) % this.rotationOrder.length;
        return componentId;
      }
      return null;
    }

    retire(completion, component, retirementThreshold) {
      this.targetCount = Math.max(0, this.targetCount - 1);
      this.retirements.push({
        componentId: completion.componentId,
        type: component.type,
        at: Number(completion.completeAt.toFixed(6)),
        retireNotBefore: Number(retirementThreshold.toFixed(6)),
        activationId: completion.id,
      });
    }

    handleFinished(finished, now) {
      if (!this.accepting) return [];
      const replacements = [];
      for (const completion of finished.filter((activation) => activation.mode === "persistent")) {
        const component = this.components[completion.componentId];
        const retirementThreshold = this.exportMode ? this.retireNotBefore(component) : Infinity;
        if (this.exportMode && completion.completeAt >= this.retireStart - 1e-9 && completion.completeAt >= retirementThreshold - 1e-9) {
          this.retire(completion, component, retirementThreshold);
          continue;
        }
        if (this.manager.snapshot(now).litCount >= this.targetCount) break;
        const remainingFinaleTime = this.exportMode && completion.completeAt >= this.retireStart - 1e-9 ? this.retireEnd - completion.completeAt : Infinity;
        const componentId = this.nextReplacement(now, remainingFinaleTime);
        if (componentId === null) {
          if (this.exportMode && completion.completeAt >= this.retireStart - 1e-9) {
            this.retire(completion, component, retirementThreshold);
            continue;
          }
          break;
        }
        const cycleCount = this.exportMode && completion.completeAt >= this.finalePrepAt - 1e-9 ? 1 : undefined;
        const activation = this.manager.start(componentId, completion.completeAt, "persistent", completion.cycleIndex + 1, { targetCount: this.targetCount, cycleCount });
        if (activation) {
          this.replacementCount += 1;
          replacements.push(activation);
        }
      }
      return replacements;
    }

    stopReplacing() {
      this.accepting = false;
      this.futureDebutIds.clear();
    }

    planSnapshot() {
      return this.entries.map((entry) => ({ ...entry }));
    }
  }

  function advanceGrowthInterval(manager, conductor, fromTime, toTime) {
    const events = [];
    const finished = [];
    let cursor = fromTime;
    for (let guard = 0; guard < 4096; guard += 1) {
      const nextDebutAt = conductor.entries[conductor.nextEntryIndex]?.at ?? Infinity;
      const nextCompletionAt = Math.min(Infinity, ...[...manager.active.values()].filter((activation) => activation.mode === "persistent").map((activation) => activation.completeAt));
      const boundary = Math.min(nextDebutAt, nextCompletionAt);
      if (boundary > toTime + 1e-9 || !Number.isFinite(boundary)) break;
      events.push(...manager.eventsBetween(cursor, boundary));
      cursor = boundary;
      const boundaryFinished = manager.update(boundary);
      conductor.advanceTo(boundary);
      conductor.handleFinished(boundaryFinished, boundary);
      finished.push(...boundaryFinished);
    }
    events.push(...manager.eventsBetween(cursor, toTime));
    return { events, finished };
  }

  function unitHash(...parts) {
    return hashString(parts.join(":")) / 4294967296;
  }

  function neighborCandidates(component, components, active, ring, config = RIPPLE_DEFAULTS) {
    const candidates = [];
    for (let dRow = -ring; dRow <= ring; dRow += 1) {
      for (let dCol = -ring; dCol <= ring; dCol += 1) {
        if (Math.max(Math.abs(dRow), Math.abs(dCol)) !== ring) continue;
        const row = component.cell.row + dRow;
        const col = component.cell.col + dCol;
        if (row < 0 || row >= ROWS || col < 0 || col >= COLS) continue;
        const id = row * COLS + col;
        if (active.has(id)) continue;
        const orthogonal = dRow === 0 || dCol === 0;
        candidates.push({ id, weight: ring === 1 ? (orthogonal ? config.neighborOrthogonal : config.neighborDiagonal) : orthogonal ? config.ring2Orthogonal : config.ring2Diagonal, component: components[id] });
      }
    }
    return candidates;
  }

  /**
   * RippleConductor：无阶段、无固定人口表的自维持导演。
   * - 亮起人口跟随一个连续目标 target(t)：慢启动 ramp × 慢漂移 band(lo..hi) + 划动注入的 boost。
   * - 传播是因果的：每个亮着的组件在自己的重音时刻（accent ≥ 0.7）产生一次 spark 机会，
   *   按“目标 − 当前亮数”的赤字概率点亮一个暗邻居；亮数高于目标就不再蔓延，多余的自然走完整数周期后熄灭。
   * - 一旦全暗（或刚开始），在确定的时刻补一颗 ember 种子，所以从 1 个开始慢慢长起，且不会彻底死掉。
   * - 全部随机决定使用无状态 hash，与帧率、决策顺序无关。
   */
  class RippleConductor {
    constructor(seed, components, manager, config = RIPPLE_DEFAULTS) {
      this.seed = seed;
      this.components = components;
      this.manager = manager;
      this.config = normalizeRippleConfig({ ...RIPPLE_DEFAULTS, ...config });
      this.range = { min: this.config.litMin, max: this.config.litMax };
      this.phases = this.config.wanderPeriods.map((_, index) => unitHash(seed, "ripple-phase", index) * TAU);
      this.sparks = [];
      this.impulses = [];
      this.emberAt = 0;
      this.emberCount = 0;
      this.relayCount = 0;
      this.sparkCount = 0;
      this.spawnCount = 0;
      this.seedCount = 0;
      this.log = [];
    }

    band(now) {
      const { wanderPeriods, wanderWeights, wanderDepth } = this.config;
      const drift = wanderPeriods.reduce((sum, period, index) => sum + (wanderWeights[index] ?? 0) * Math.sin(TAU * now / period + (this.phases[index] ?? 0)), 0);
      const amount = 0.5 + 0.5 * clamp(drift * wanderDepth, -1, 1);
      return lerp(this.range.min, this.range.max, amount);
    }

    ramp(now) {
      return 1 - Math.exp(-Math.pow(Math.max(0, now) / this.config.rampSeconds, this.config.rampCurve));
    }

    boost(now) {
      let total = 0;
      for (const impulse of this.impulses) {
        if (impulse.at > now + 1e-9) continue;
        total += impulse.amount * Math.exp(-(now - impulse.at) / this.config.boostDecay);
      }
      return total;
    }

    /** 几何插值：从 1 沿对数尺度慢慢爬向漂移带，早期只是一两盏灯在游走，之后平滑加速，没有阶段跳变。 */
    target(now) {
      const grown = Math.exp(Math.log(Math.max(1, this.band(now))) * this.ramp(now));
      return Math.min(this.range.max, Math.max(1, grown) + this.boost(now));
    }

    scheduleSparks(activation) {
      let index = 0;
      for (const event of activation.events) {
        if (event.accent < this.config.sparkAccent) continue;
        this.sparks.push({ at: activation.startedAt + event.offset, componentId: activation.componentId, activationId: activation.id, index: index++ });
      }
      this.sparks.sort((left, right) => left.at - right.at || left.activationId - right.activationId || left.index - right.index);
    }

    light(componentId, at, source) {
      if (this.manager.active.has(componentId)) return null;
      const component = this.components[componentId];
      const ordinal = this.manager.activationCounts.get(componentId) || 0;
      const cycleCount = cycleCountFor(component, ordinal, 0, "ripple", { min: this.config.cyclesMin, max: this.config.cyclesMax });
      const activation = this.manager.start(componentId, at, "ripple", 0, { cycleCount });
      if (!activation) return null;
      this.scheduleSparks(activation);
      this.emberAt = null;
      if (this.log.length < 4096) this.log.push({ at: Number(at.toFixed(6)), componentId, source, activationId: activation.id });
      return activation;
    }

    /** 划动路径命中的一批初始种子：立即点亮，并把目标临时抬高，让这批种子有机会往外蔓延。 */
    seedMany(componentIds, at) {
      const started = [];
      for (const componentId of componentIds) {
        const activation = this.light(componentId, at, "seed");
        if (activation) started.push(activation);
      }
      if (started.length) {
        this.seedCount += started.length;
        this.impulses.push({ at, amount: started.length * this.config.boostPerSeed });
        if (this.impulses.length > 256) this.impulses.splice(0, this.impulses.length - 256);
      }
      return started;
    }

    nextBoundary(after) {
      const nextSpark = this.sparks.find((spark) => spark.at > after + 1e-9)?.at ?? Infinity;
      const nextCompletion = Math.min(Infinity, ...[...this.manager.active.values()].map((activation) => activation.completeAt));
      const ember = this.emberAt !== null && this.emberAt > after + 1e-9 ? this.emberAt : Infinity;
      const extra = this.extraBoundary(after);
      return Math.min(nextSpark, nextCompletion, ember, extra > after + 1e-9 ? extra : Infinity);
    }

    fireSparks(now) {
      const due = [];
      while (this.sparks.length && this.sparks[0].at <= now + 1e-9) due.push(this.sparks.shift());
      for (const spark of due) {
        if (this.manager.active.get(spark.componentId)?.id !== spark.activationId) continue;
        this.sparkCount += 1;
        this.handleSpark(spark, now);
      }
    }

    /** 子类钩子：额外的时间边界 / 边界回调 / 额外声音事件。基类全部为空实现，ripple 行为不变。 */
    extraBoundary() { return Infinity; }
    onBoundary() {}
    extraEventsBetween() { return []; }

    handleSpark(spark, now) {
      const lit = this.manager.active.size;
      const target = this.target(now);
      const deficit = target - lit;
      const probability = clamp(deficit / Math.max(this.config.sparkFloor, target * this.config.sparkGain), 0, this.config.sparkCap);
      if (unitHash(this.seed, "spark", spark.activationId, spark.index) >= probability) return;
      const parent = this.components[spark.componentId];
      let candidates = neighborCandidates(parent, this.components, this.manager.active, 1, this.config);
      if (!candidates.length) candidates = neighborCandidates(parent, this.components, this.manager.active, 2, this.config);
      if (!candidates.length) return;
      const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
      let cursor = unitHash(this.seed, "pick", spark.activationId, spark.index) * total;
      let chosen = candidates.at(-1);
      for (const candidate of candidates) {
        cursor -= candidate.weight;
        if (cursor <= 0) { chosen = candidate; break; }
      }
      if (this.light(chosen.id, now, "spark")) this.spawnCount += 1;
    }

    /** 最后一盏灯走完周期时，把火种直接交给它的邻居：画面永远不会全暗，早期的独奏会在格子间缓慢游走。 */
    handleFinished(finished, now) {
      if (this.manager.active.size > 0 || !finished.length) return;
      const last = finished.at(-1);
      const parent = this.components[last.componentId];
      let candidates = neighborCandidates(parent, this.components, this.manager.active, 1, this.config);
      if (!candidates.length) candidates = neighborCandidates(parent, this.components, this.manager.active, 2, this.config);
      const key = this.relayCount++;
      let chosenId;
      if (candidates.length) {
        const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
        let cursor = unitHash(this.seed, "relay", key) * total;
        chosenId = candidates.at(-1).id;
        for (const candidate of candidates) {
          cursor -= candidate.weight;
          if (cursor <= 0) { chosenId = candidate.id; break; }
        }
      } else {
        chosenId = Math.floor(unitHash(this.seed, "relay", key) * this.components.length) % this.components.length;
      }
      if (!this.light(chosenId, now, "relay") && this.emberAt === null) this.emberAt = now + this.config.emberDelay;
    }

    fireEmber(now) {
      if (this.emberAt === null || this.emberAt > now + 1e-9) return;
      this.emberAt = null;
      if (this.manager.active.size > 0 || this.target(now) < 0.5) return;
      const id = Math.floor(unitHash(this.seed, "ember", this.emberCount) * this.components.length) % this.components.length;
      this.emberCount += 1;
      this.light(id, now, "ember");
    }

    snapshot(now) {
      return {
        target: Number(this.target(now).toFixed(3)),
        band: Number(this.band(now).toFixed(3)),
        ramp: Number(this.ramp(now).toFixed(4)),
        boost: Number(this.boost(now).toFixed(3)),
        range: { ...this.range },
        config: { ...this.config },
        lit: this.manager.active.size,
        pendingSparks: this.sparks.length,
        sparkCount: this.sparkCount,
        spawnCount: this.spawnCount,
        seedCount: this.seedCount,
        emberCount: this.emberCount,
        relayCount: this.relayCount,
      };
    }
  }

  function advanceRippleInterval(manager, conductor, fromTime, toTime) {
    const events = [];
    const finished = [];
    let cursor = fromTime;
    for (let guard = 0; guard < 8192; guard += 1) {
      const boundary = conductor.nextBoundary(cursor);
      if (boundary > toTime + 1e-9 || !Number.isFinite(boundary)) break;
      events.push(...manager.eventsBetween(cursor, boundary), ...conductor.extraEventsBetween(cursor, boundary));
      cursor = boundary;
      const boundaryFinished = manager.update(boundary);
      conductor.handleFinished(boundaryFinished, boundary);
      conductor.fireEmber(boundary);
      conductor.onBoundary(boundary);
      conductor.fireSparks(boundary);
      finished.push(...boundaryFinished);
    }
    events.push(...manager.eventsBetween(cursor, toTime), ...conductor.extraEventsBetween(cursor, toTime));
    return { events: events.sort((left, right) => left.at - right.at || left.componentId - right.componentId), finished };
  }

  /**
   * 「引光」demo 导演（?mode=beacon）。在 ripple 之上加三条规则：
   * 1. 光只能从亮着的地方被牵出去：一笔划动的第一颗种子必须紧挨着亮格，后面的种子沿轨迹连续；每笔最多 strokeSeeds 颗。
   * 2. 灯塔（目标格）不能被直接点亮：只有当某个亮格紧挨着灯塔、并在自己的重音时刻放出火花时，灯塔才被"接到"。
   * 3. 一口气：每笔（真的种下了种子）消耗 1 口，共 breathMax 口，按时间缓慢回复，接到灯塔回 1 口。
   * 人口带压得很小，光团自己走不远；种下的光几秒后会灭——所以要接力。
   */
  const BEACON_TUNING = Object.freeze({
    litMin: 4, litMax: 12, rampSeconds: 4, rampCurve: 1,
    strokeSeeds: 4, breathMax: 3, breathRecover: 5,
    firstHops: [3, 4], hops: [4, 7], nextBeaconDelay: 1.6, beaconCycles: 3,
    seedCycles: [2, 3],
  });

  function chebyshev(a, b) {
    return Math.max(Math.abs(a.cell.row - b.cell.row), Math.abs(a.cell.col - b.cell.col));
  }

  class BeaconConductor extends RippleConductor {
    constructor(seed, components, manager, config = RIPPLE_DEFAULTS) {
      super(seed, components, manager, { ...config, litMin: BEACON_TUNING.litMin, litMax: BEACON_TUNING.litMax, rampSeconds: BEACON_TUNING.rampSeconds, rampCurve: BEACON_TUNING.rampCurve, cyclesMin: BEACON_TUNING.seedCycles[0], cyclesMax: BEACON_TUNING.seedCycles[1] });
      this.beaconId = null;
      this.nextBeaconAt = 0.8;
      this.beaconChosenAt = null;
      this.beaconHops = 0;
      this.lanterns = 0;
      this.breath = BEACON_TUNING.breathMax;
      this.breathUpdatedAt = 0;
      this.reached = [];
      this.chordEvents = [];
      this.lastStroke = null;
      this.gestureCount = 0;
    }

    breathAt(now) {
      return Math.min(BEACON_TUNING.breathMax, this.breath + Math.max(0, now - this.breathUpdatedAt) / BEACON_TUNING.breathRecover);
    }

    setBreath(value, now) {
      this.breath = clamp(value, 0, BEACON_TUNING.breathMax);
      this.breathUpdatedAt = now;
    }

    litNear(componentId, ring = 1) {
      const component = this.components[componentId];
      for (const activeId of this.manager.active.keys()) {
        if (chebyshev(this.components[activeId], component) <= ring) return true;
      }
      return false;
    }

    extraBoundary() {
      return this.beaconId === null && this.nextBeaconAt !== null ? this.nextBeaconAt : Infinity;
    }

    onBoundary(now) {
      if (this.beaconId !== null || this.nextBeaconAt === null || this.nextBeaconAt > now + 1e-9) return;
      this.chooseBeacon(now);
    }

    chooseBeacon(now) {
      const [hopMin, hopMax] = this.lanterns === 0 ? BEACON_TUNING.firstHops : BEACON_TUNING.hops;
      const lit = [...this.manager.active.keys()].map((id) => this.components[id]);
      if (!lit.length) { this.nextBeaconAt = now + 0.5; return; }
      const distanceOf = (component) => Math.min(...lit.map((source) => chebyshev(source, component)));
      const wantedHops = hopMin + Math.floor(unitHash(this.seed, "beacon-hops", this.lanterns) * (hopMax - hopMin + 1));
      let candidates = [];
      for (let hops = wantedHops; hops >= hopMin && !candidates.length; hops -= 1) {
        candidates = this.components.filter((component) => !this.manager.active.has(component.id) && distanceOf(component) === hops);
      }
      if (!candidates.length) {
        let best = -1;
        for (const component of this.components) {
          if (this.manager.active.has(component.id)) continue;
          const distance = distanceOf(component);
          if (distance > best) { best = distance; candidates = [component]; } else if (distance === best) candidates.push(component);
        }
      }
      if (!candidates.length) { this.nextBeaconAt = now + 0.5; return; }
      const chosen = candidates[Math.floor(unitHash(this.seed, "beacon", this.lanterns) * candidates.length) % candidates.length];
      this.beaconId = chosen.id;
      this.beaconHops = distanceOf(chosen);
      this.beaconChosenAt = now;
      this.nextBeaconAt = null;
    }

    /** 规则 2：紧挨灯塔的亮格在重音时刻放出火花 → 灯塔被接到（确定性），和弦 + 计数 + 回气 + 下一座灯塔。 */
    handleSpark(spark, now) {
      if (this.beaconId !== null && chebyshev(this.components[spark.componentId], this.components[this.beaconId]) <= 1 && !this.manager.active.has(this.beaconId)) {
        const beacon = this.components[this.beaconId];
        const ordinal = this.manager.activationCounts.get(beacon.id) || 0;
        const activation = this.manager.start(beacon.id, now, "ripple", 0, { cycleCount: BEACON_TUNING.beaconCycles });
        if (activation) {
          this.scheduleSparks(activation);
          this.emberAt = null;
          this.lanterns += 1;
          this.setBreath(this.breathAt(now) + 1, now);
          this.reached.push({ at: Number(now.toFixed(6)), componentId: beacon.id, from: spark.componentId, hops: this.beaconHops, lantern: this.lanterns });
          const sourceU = (beacon.centerX - FRAME.x) / FRAME.width;
          [0, 4, 7, 12].forEach((interval, index) => {
            this.chordEvents.push({ at: now + 0.02 + index * 0.07, kind: "beacon-chord", pitch: beacon.pitch + interval, accent: index === 0 ? 1 : 0.72, isImpact: false, activationId: activation.id, componentId: beacon.id, type: beacon.type, sourceU, layer: "harmony", gainScale: 0.5, cycleNumber: 1 });
          });
          this.beaconId = null;
          this.nextBeaconAt = now + BEACON_TUNING.nextBeaconDelay;
          void ordinal;
          return;
        }
      }
      super.handleSpark(spark, now);
    }

    extraEventsBetween(fromTime, toTime) {
      const due = this.chordEvents.filter((event) => event.at > fromTime + 1e-9 && event.at <= toTime + 1e-9);
      if (due.length) this.chordEvents = this.chordEvents.filter((event) => !due.includes(event));
      return due;
    }

    /**
     * 规则 1 + 3：一笔划动。ids 是这一段轨迹命中的格子（按经过顺序）。
     * 返回 { planted: [...activation], rejected: "noBreath" | "notFromLight" | null }。
     */
    stroke(ids, now, gesture) {
      gesture.seeds ??= [];
      gesture.anchored ??= false;
      gesture.charged ??= false;
      gesture.rejected ??= null;
      const planted = [];
      for (const id of ids) {
        if (gesture.seeds.length >= BEACON_TUNING.strokeSeeds) break;
        if (this.manager.active.has(id)) { gesture.anchored = true; continue; }
        if (id === this.beaconId) continue;
        const lastSeed = gesture.seeds.at(-1);
        const contiguous = lastSeed !== undefined && chebyshev(this.components[lastSeed], this.components[id]) <= 1;
        if (!gesture.anchored && !contiguous) {
          if (this.litNear(id, 1)) gesture.anchored = true;
          else { gesture.rejected = gesture.rejected || "notFromLight"; continue; }
        }
        if (!gesture.charged) {
          if (this.breathAt(now) < 1) { gesture.rejected = "noBreath"; break; }
          this.setBreath(this.breathAt(now) - 1, now);
          gesture.charged = true;
          this.gestureCount += 1;
        }
        const activation = this.light(id, now, "seed");
        if (!activation) continue;
        gesture.seeds.push(id);
        gesture.rejected = null;
        planted.push(activation);
      }
      if (planted.length) {
        this.seedCount += planted.length;
        this.impulses.push({ at: now, amount: planted.length * this.config.boostPerSeed });
      }
      return { planted, rejected: gesture.rejected };
    }

    snapshot(now) {
      return {
        ...super.snapshot(now),
        beaconId: this.beaconId,
        beaconHops: this.beaconHops,
        beaconChosenAt: this.beaconChosenAt,
        lanterns: this.lanterns,
        breath: Number(this.breathAt(now).toFixed(3)),
        breathMax: BEACON_TUNING.breathMax,
        reached: this.reached.map((entry) => ({ ...entry })),
        gestureCount: this.gestureCount,
      };
    }
  }

  const PHRASE_COLORS = Object.freeze(["#dce8eb", "#8fc8d9", "#d5b6e8", "#e6c67b"]);

  function gestureNoteEvent(component, at, phraseId, layer, gainScale = 1, accent = 0.86, repeat = 0) {
    return {
      at,
      kind: "gesture-note",
      pitch: component.pitch,
      accent: clamp(accent, 0.62, 1),
      isImpact: false,
      activationId: `phrase:${phraseId}:${repeat}`,
      componentId: component.id,
      type: component.type,
      sourceU: (component.centerX - FRAME.x) / FRAME.width,
      layer: `phrase-${layer}`,
      phraseId,
      phraseLayer: layer,
      repeat,
      gainScale,
    };
  }

  const COMPONENT_WAVE_CONTACTS = 3;

  /**
   * 波先碰到机关的可见结构，而不是抽象格子中心。每种机关只保留三个接触点，
   * 仍然走固定 TypedArray 热路径，但摆锤、滑轨、槌头与曲线不会错开几十像素才启动。
   */
  function componentWaveContactPoints(component) {
    if (component.type === "pendulum") {
      const { anchor, length, amplitude } = component.variant;
      const angle = -amplitude;
      const tangentX = -anchor.inwardY;
      const tangentY = anchor.inwardX;
      const directionX = anchor.inwardX * Math.cos(angle) + tangentX * Math.sin(angle);
      const directionY = anchor.inwardY * Math.cos(angle) + tangentY * Math.sin(angle);
      return [
        { x: anchor.x, y: anchor.y },
        { x: anchor.x + directionX * length, y: anchor.y + directionY * length },
        { x: component.centerX, y: component.centerY },
      ];
    }
    if (component.type === "glider") return [0, 0.5, 1].map((amount) => pointAlongRoute(component.variant.route, amount));
    if (component.type === "rotor") {
      const { radius } = component.variant;
      return [
        { x: component.centerX - radius, y: component.centerY },
        { x: component.centerX, y: component.centerY },
        { x: component.centerX + radius, y: component.centerY },
      ];
    }
    if (component.type === "mallet") {
      const anchors = component.variant.anchors;
      const head = (anchor) => ({ x: anchor.x + anchor.inwardX * 18, y: anchor.y + anchor.inwardY * 18 });
      return [head(anchors[0]), { x: component.centerX, y: component.centerY }, head(anchors.at(-1))];
    }
    return [curvePoint(component, 0), curvePoint(component, 0.5), curvePoint(component, 1)];
  }

  /**
   * 独立于 ActivationManager 的手势乐句时序器。
   * 这里故意不把短音塞进 componentId -> activation 的单值 Map：同格重复、多笔叠奏与旧模式完整周期互不干扰。
   */
  class MelodyConductor {
    constructor(seed, components, config = MELODY_DEFAULTS, wallGraph = null, responseField = null, motifSettings = null) {
      this.seed = seed;
      this.components = components;
      this.wallGraph = wallGraph;
      this.responseField = responseField || makeResponseField(seed);
      this.motifEnabled = motifSettings?.enabled !== false;
      this.motifLibrary = new Map((motifSettings?.library || BUILT_IN_MOTIFS).map((motif) => [motif.id, motif]));
      this.config = normalizeMelodyConfig({ ...MELODY_DEFAULTS, ...config });
      this.phrases = [];
      this.waves = [];
      // 输入事件可能在一次低帧率 catch-up 中批量到达。先按真实事件时刻排队，
      // 再在每个固定 60 Hz 波场样本前提升，避免后来的波在早期样本运行前把旧波挤掉。
      this.pendingWaves = [];
      this.pendingWavesDirty = false;
      this.motifPerformances = [];
      this.startedMotifPerformances = [];
      this.unlockedMotifComponents = new Set();
      this.motifNextAvailableAt = new Float64Array(components.length);
      this.motifNextAvailableAt.fill(-Infinity);
      this.newlyUnlockedMotifs = [];
      this.motifUnlockCount = 0;
      this.motifPlayCount = 0;
      this.motifPerformanceRejectCount = 0;
      this.waveSourceLog = [];
      this.sequence = 0;
      this.waveSequence = 0;
      this.liveEventCount = 0;
      this.replayEventCount = 0;
      this.peakWaveCount = 0;
      this.componentTriggerCount = 0;
      this.componentSkippedWaveEdgeCount = 0;
      this.peakActiveComponents = 0;
      this.waveRenderBuckets = Array.from({ length: 5 }, () => []);
      this.responseRenderBuckets = Array.from({ length: 10 }, () => []);
      this.trailRenderBuckets = Array.from({ length: PHRASE_COLORS.length * 6 }, () => []);
      const pointCount = this.config.waveCols * this.config.waveRows;
      this.waveX = new Float32Array(pointCount);
      this.waveY = new Float32Array(pointCount);
      this.waveField = new Float32Array(pointCount);
      this.waveAccentBucket = new Int8Array(pointCount);
      const accentRanks = new Uint32Array(pointCount);
      const accentOrder = Array.from({ length: pointCount }, (_, pointIndex) => {
        accentRanks[pointIndex] = spatialHash(pointIndex, this.config.waveCols);
        return pointIndex;
      });
      accentOrder.sort((left, right) => accentRanks[left] - accentRanks[right] || left - right);
      this.waveAccentOrder = Uint16Array.from(accentOrder);
      this.waveComponentId = new Uint16Array(pointCount);
      this.componentWaveIndex = new Uint16Array(components.length);
      this.componentEnergy = new Float32Array(components.length);
      this.componentContactWaveIndex = new Uint16Array(components.length * COMPONENT_WAVE_CONTACTS);
      this.componentContactX = new Float32Array(components.length * COMPONENT_WAVE_CONTACTS);
      this.componentContactY = new Float32Array(components.length * COMPONENT_WAVE_CONTACTS);
      this.componentPeakContact = new Uint8Array(components.length);
      this.componentDominantWaveIndex = new Int16Array(components.length);
      this.componentSourceIndex = new Uint8Array(pointCount);
      this.responseWaveIndex = new Uint16Array(this.responseField.count);
      this.componentWasAbove = new Uint8Array(components.length);
      this.triggerCandidateIds = new Uint16Array(components.length);
      this.triggerCandidateEnergy = new Float32Array(components.length);
      this.triggerCandidateWaveId = new Uint32Array(components.length);
      this.startedActivations = [];
      this.fieldSampledAt = -Infinity;
      this.nextWakeSampleAt = 0;
      this.wakeStep = 1 / 60;
      this.distanceCache = new Map();
      this.dynamicDistanceKeys = new Map();
      this.prewarmComponentIndex = 0;
      let index = 0;
      for (let row = 0; row < this.config.waveRows; row += 1) {
        for (let col = 0; col < this.config.waveCols; col += 1) {
          this.waveX[index] = FRAME.x + (col + 0.5) * FRAME.width / this.config.waveCols;
          this.waveY[index] = FRAME.y + (row + 0.5) * FRAME.height / this.config.waveRows;
          const componentRow = clamp(Math.floor((row + 0.5) * ROWS / this.config.waveRows), 0, ROWS - 1);
          const componentCol = clamp(Math.floor((col + 0.5) * COLS / this.config.waveCols), 0, COLS - 1);
          this.waveComponentId[index] = componentRow * COLS + componentCol;
          index += 1;
        }
      }
      for (const component of components) {
        const sourceIndex = this.waveIndexAt(component.centerX, component.centerY);
        this.componentWaveIndex[component.id] = sourceIndex;
        this.componentSourceIndex[sourceIndex] = 1;
        const contacts = componentWaveContactPoints(component);
        for (let contact = 0; contact < COMPONENT_WAVE_CONTACTS; contact += 1) {
          const point = contacts[contact] || contacts.at(-1) || component;
          const contactIndex = component.id * COMPONENT_WAVE_CONTACTS + contact;
          this.componentContactX[contactIndex] = clamp(point.x, FRAME.x, FRAME.x + FRAME.width);
          this.componentContactY[contactIndex] = clamp(point.y, FRAME.y, FRAME.y + FRAME.height);
          this.componentContactWaveIndex[contactIndex] = this.waveIndexAt(point.x, point.y);
        }
      }
      for (let responseIndex = 0; responseIndex < this.responseField.count; responseIndex += 1) {
        this.responseWaveIndex[responseIndex] = this.waveIndexAt(this.responseField.x[responseIndex], this.responseField.y[responseIndex]);
      }
      this.waveNeighborIndices = new Int16Array(pointCount * 8);
      this.waveNeighborIndices.fill(-1);
      this.waveNeighborCosts = new Float32Array(pointCount * 8);
      this.distanceHeapNodes = new Uint16Array(pointCount);
      this.distanceHeapPositions = new Int32Array(pointCount);
      this.buildWaveAdjacency();
    }

    prewarmComponentSources(maxSources = 1) {
      let warmed = 0;
      while (this.prewarmComponentIndex < this.components.length && warmed < maxSources) {
        const componentId = this.prewarmComponentIndex++;
        this.distancesFrom(this.componentWaveIndex[componentId]);
        warmed += 1;
      }
      return {
        warmed,
        remaining: this.components.length - this.prewarmComponentIndex,
        complete: this.prewarmComponentIndex >= this.components.length,
      };
    }

    waveIndexAt(x, y) {
      const col = clamp(Math.floor((x - FRAME.x) / FRAME.width * this.config.waveCols), 0, this.config.waveCols - 1);
      const row = clamp(Math.floor((y - FRAME.y) / FRAME.height * this.config.waveRows), 0, this.config.waveRows - 1);
      return row * this.config.waveCols + col;
    }

    wallBetweenCells(from, to) {
      if (!this.wallGraph || !from || !to || from.id === to.id) return false;
      if (from.row === to.row && to.col === from.col + 1) return this.wallGraph.edgeMap.has(wallKeyForCell(from, "right"));
      if (from.row === to.row && to.col === from.col - 1) return this.wallGraph.edgeMap.has(wallKeyForCell(from, "left"));
      if (from.col === to.col && to.row === from.row + 1) return this.wallGraph.edgeMap.has(wallKeyForCell(from, "bottom"));
      if (from.col === to.col && to.row === from.row - 1) return this.wallGraph.edgeMap.has(wallKeyForCell(from, "top"));
      return false;
    }

    edgeBlocked(from, to) {
      const dRow = to.row - from.row;
      const dCol = to.col - from.col;
      if (dRow === 0 || dCol === 0) return this.wallBetweenCells(from, to);
      // 对角线只有在两条正交绕行都被墙截断时才付穿墙代价；规则双向对称，避免从墙角漏入。
      const viaHorizontal = this.components[from.row * COLS + to.col]?.cell;
      const viaVertical = this.components[to.row * COLS + from.col]?.cell;
      const horizontalPathBlocked = this.wallBetweenCells(from, viaHorizontal) || this.wallBetweenCells(viaHorizontal, to);
      const verticalPathBlocked = this.wallBetweenCells(from, viaVertical) || this.wallBetweenCells(viaVertical, to);
      return horizontalPathBlocked && verticalPathBlocked;
    }

    edgeResistance(fromIndex, toIndex) {
      if (!this.wallGraph) return 1;
      const from = this.components[this.waveComponentId[fromIndex]]?.cell;
      const to = this.components[this.waveComponentId[toIndex]]?.cell;
      if (!from || !to || from.id === to.id || !this.edgeBlocked(from, to)) return 1;
      const direct = Math.hypot(this.waveX[toIndex] - this.waveX[fromIndex], this.waveY[toIndex] - this.waveY[fromIndex]);
      return 1 + this.config.wallPenalty / Math.max(1e-6, direct);
    }

    buildWaveAdjacency() {
      const stepX = FRAME.width / this.config.waveCols;
      const stepY = FRAME.height / this.config.waveRows;
      for (let index = 0; index < this.waveX.length; index += 1) {
        const row = Math.floor(index / this.config.waveCols);
        const col = index - row * this.config.waveCols;
        let slot = index * 8;
        for (let dRow = -1; dRow <= 1; dRow += 1) {
          for (let dCol = -1; dCol <= 1; dCol += 1) {
            if (dRow === 0 && dCol === 0) continue;
            const nextRow = row + dRow;
            const nextCol = col + dCol;
            if (nextRow >= 0 && nextRow < this.config.waveRows && nextCol >= 0 && nextCol < this.config.waveCols) {
              const next = nextRow * this.config.waveCols + nextCol;
              const direct = Math.hypot(dCol * stepX, dRow * stepY);
              this.waveNeighborIndices[slot] = next;
              this.waveNeighborCosts[slot] = direct * this.edgeResistance(index, next);
            }
            slot += 1;
          }
        }
      }
    }

    distancesFrom(sourceIndex) {
      return this.distancesFromSources([sourceIndex], sourceIndex, !this.componentSourceIndex[sourceIndex]);
    }

    segmentSourceIndices(fromSourceIndex, toSourceIndex) {
      if (fromSourceIndex === toSourceIndex) return [toSourceIndex];
      const fromRow = Math.floor(fromSourceIndex / this.config.waveCols);
      const fromCol = fromSourceIndex - fromRow * this.config.waveCols;
      const toRow = Math.floor(toSourceIndex / this.config.waveCols);
      const toCol = toSourceIndex - toRow * this.config.waveCols;
      const steps = Math.max(Math.abs(toRow - fromRow), Math.abs(toCol - fromCol));
      const sources = [];
      let prior = -1;
      for (let step = 0; step <= steps; step += 1) {
        const amount = steps > 0 ? step / steps : 0;
        const row = Math.round(lerp(fromRow, toRow, amount));
        const col = Math.round(lerp(fromCol, toCol, amount));
        const sourceIndex = row * this.config.waveCols + col;
        if (sourceIndex === prior) continue;
        sources.push(sourceIndex);
        prior = sourceIndex;
      }
      return sources;
    }

    distancesFromSegment(fromSourceIndex, toSourceIndex) {
      if (fromSourceIndex === toSourceIndex) return this.distancesFrom(toSourceIndex);
      const first = Math.min(fromSourceIndex, toSourceIndex);
      const last = Math.max(fromSourceIndex, toSourceIndex);
      return this.distancesFromSources(
        this.segmentSourceIndices(fromSourceIndex, toSourceIndex),
        `segment:${first}:${last}`,
        true,
      );
    }

    distancesFromSources(sourceIndices, cacheKey, dynamic) {
      const cached = this.distanceCache.get(cacheKey);
      if (cached) {
        if (dynamic && this.dynamicDistanceKeys.has(cacheKey)) {
          this.dynamicDistanceKeys.delete(cacheKey);
          this.dynamicDistanceKeys.set(cacheKey, true);
        }
        return cached;
      }
      const count = this.waveX.length;
      const distances = new Float32Array(count);
      distances.fill(Infinity);
      const heapNodes = this.distanceHeapNodes;
      const heapPositions = this.distanceHeapPositions;
      heapPositions.fill(-1);
      let heapSize = 0;
      for (const sourceIndex of sourceIndices) {
        if (heapPositions[sourceIndex] >= 0) continue;
        distances[sourceIndex] = 0;
        heapNodes[heapSize] = sourceIndex;
        heapPositions[sourceIndex] = heapSize;
        heapSize += 1;
      }
      while (heapSize > 0) {
        const poppedNode = heapNodes[0];
        const poppedCost = distances[poppedNode];
        heapPositions[poppedNode] = -1;
        heapSize -= 1;
        if (heapSize > 0) {
          const tail = heapNodes[heapSize];
          let position = 0;
          while (true) {
            const left = position * 2 + 1;
            if (left >= heapSize) break;
            const right = left + 1;
            const child = right < heapSize && distances[heapNodes[right]] < distances[heapNodes[left]] ? right : left;
            if (distances[heapNodes[child]] >= distances[tail]) break;
            heapNodes[position] = heapNodes[child];
            heapPositions[heapNodes[position]] = position;
            position = child;
          }
          heapNodes[position] = tail;
          heapPositions[tail] = position;
        }
        const adjacencyStart = poppedNode * 8;
        for (let slot = adjacencyStart; slot < adjacencyStart + 8; slot += 1) {
          const next = this.waveNeighborIndices[slot];
          if (next < 0 || heapPositions[next] === -2) continue;
          const cost = poppedCost + this.waveNeighborCosts[slot];
          if (cost >= distances[next] - 1e-5) continue;
          distances[next] = cost;
          let position = heapPositions[next];
          if (position < 0) {
            position = heapSize;
            heapSize += 1;
          }
          while (position > 0) {
            const parent = (position - 1) >> 1;
            const parentNode = heapNodes[parent];
            if (distances[parentNode] <= cost) break;
            heapNodes[position] = parentNode;
            heapPositions[parentNode] = position;
            position = parent;
          }
          heapNodes[position] = next;
          heapPositions[next] = position;
        }
        heapPositions[poppedNode] = -2;
      }
      this.distanceCache.set(cacheKey, distances);
      if (dynamic) {
        this.dynamicDistanceKeys.set(cacheKey, true);
        while (this.dynamicDistanceKeys.size > this.config.maxWaves) {
          const oldest = this.dynamicDistanceKeys.keys().next().value;
          this.dynamicDistanceKeys.delete(oldest);
          this.distanceCache.delete(oldest);
        }
      }
      return distances;
    }

    beginGesture(at, sourceTimestamp = 0, pointerId = 0) {
      const id = ++this.sequence;
      return {
        id,
        layer: (id - 1) % this.config.maxPhrases,
        pointerId,
        startedAt: at,
        sourceTimestamp,
        notes: [],
        wavePoints: [],
        visualHitCount: 0,
        lastVisualComponentId: null,
        lastWaveSourceIndex: null,
        lastWaveX: null,
        lastWaveY: null,
      };
    }

    addWave(note, at = note.at, amplitude = note.gainScale ?? 1) {
      const sourceIndex = Number.isInteger(note.sourceIndex)
        ? note.sourceIndex
        : Number.isInteger(note.componentId) && this.componentWaveIndex[note.componentId] !== undefined
        ? this.componentWaveIndex[note.componentId]
        : this.waveIndexAt(note.x, note.y);
      const fromX = Number.isFinite(note.fromX) ? note.fromX : Number.isFinite(note.x) ? note.x : this.waveX[sourceIndex];
      const fromY = Number.isFinite(note.fromY) ? note.fromY : Number.isFinite(note.y) ? note.y : this.waveY[sourceIndex];
      const fromSourceIndex = this.waveIndexAt(fromX, fromY);
      const segmentDistances = this.distancesFromSegment(fromSourceIndex, sourceIndex);
      const wave = {
        id: ++this.waveSequence,
        at,
        x: Number.isFinite(note.x) ? note.x : this.waveX[sourceIndex],
        y: Number.isFinite(note.y) ? note.y : this.waveY[sourceIndex],
        fromX,
        fromY,
        amplitude: clamp(amplitude, 0.12, 1.2),
        phraseId: note.phraseId,
        layer: note.layer,
        color: PHRASE_COLORS[note.layer % PHRASE_COLORS.length],
        sourceIndex,
        distances: segmentDistances,
        fromSourceIndex,
        triggeredComponentBits: new Uint32Array(Math.ceil(this.components.length / 32)),
        // 保留字段名供 debug/旧宿主读取；整段现在共享一张多源距离场，不再只是两个端点圆波的并集。
        fromDistances: segmentDistances,
      };
      const previousPending = this.pendingWaves.at(-1);
      if (previousPending && (previousPending.at > wave.at + 1e-9
        || (Math.abs(previousPending.at - wave.at) <= 1e-9 && previousPending.id > wave.id))) {
        this.pendingWavesDirty = true;
      }
      this.pendingWaves.push(wave);
      this.waveSourceLog.push({
        sourceIndex,
        fromSourceIndex,
        x: wave.x,
        y: wave.y,
        fromX: wave.fromX,
        fromY: wave.fromY,
        at,
        repeat: Number(note.repeat) || 0,
        phraseId: note.phraseId,
      });
      const logLimit = this.config.maxWaves * (this.config.repeatCount + 1) * this.config.maxPhrases;
      if (this.waveSourceLog.length > logLimit) this.waveSourceLog.splice(0, this.waveSourceLog.length - logLimit);
      return wave;
    }

    promoteWavesThrough(sampleAt) {
      if (!this.pendingWaves.length) return 0;
      if (this.pendingWavesDirty) {
        this.pendingWaves.sort((left, right) => left.at - right.at || left.id - right.id);
        this.pendingWavesDirty = false;
      }
      let readyCount = 0;
      while (readyCount < this.pendingWaves.length && this.pendingWaves[readyCount].at <= sampleAt + 1e-9) readyCount += 1;
      if (readyCount === 0) return 0;
      const ready = this.pendingWaves.splice(0, readyCount);
      for (const wave of ready) {
        // 正常运行时 active 与 ready 都已按 (at,id) 排序；保留插入路径也兼容 debug/宿主的乱序 addWave。
        let insertAt = this.waves.length;
        while (insertAt > 0) {
          const prior = this.waves[insertAt - 1];
          if (prior.at < wave.at - 1e-9 || (Math.abs(prior.at - wave.at) <= 1e-9 && prior.id < wave.id)) break;
          insertAt -= 1;
        }
        this.waves.splice(insertAt, 0, wave);
        if (this.waves.length > this.config.maxWaves) this.waves.splice(0, this.waves.length - this.config.maxWaves);
      }
      this.peakWaveCount = Math.max(this.peakWaveCount, this.waves.length);
      this.fieldSampledAt = -Infinity;
      return ready.length;
    }

    recordWavePoint(gesture, x, y, at, dynamics = {}) {
      if (!gesture || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(at)) return null;
      const sourceIndex = this.waveIndexAt(x, y);
      if (sourceIndex === gesture.lastWaveSourceIndex) return null;
      gesture.lastWaveSourceIndex = sourceIndex;
      const pressure = Number.isFinite(dynamics.pressure) && dynamics.pressure > 0 ? dynamics.pressure : 0.5;
      const speed = Number.isFinite(dynamics.speed) ? dynamics.speed : 0;
      const amplitude = clamp(0.34 + pressure * 0.22 + smoothstep(speed / 1500) * 0.16, 0.32, 0.78);
      const wavePoint = {
        at, x, y,
        fromX: Number.isFinite(gesture.lastWaveX) ? gesture.lastWaveX : x,
        fromY: Number.isFinite(gesture.lastWaveY) ? gesture.lastWaveY : y,
        sourceIndex, amplitude, phraseId: gesture.id, layer: gesture.layer, repeat: 0,
      };
      gesture.lastWaveX = x;
      gesture.lastWaveY = y;
      if (gesture.wavePoints.length >= this.config.maxWaves * 4) {
        let write = 1;
        for (let read = 2; read < gesture.wavePoints.length; read += 2) gesture.wavePoints[write++] = gesture.wavePoints[read];
        gesture.wavePoints.length = write;
      }
      gesture.wavePoints.push(wavePoint);
      this.addWave(wavePoint, at, amplitude);
      return wavePoint;
    }

    recordHit(gesture, componentId, at, dynamics = {}) {
      const component = this.components[componentId];
      if (!component || componentId === gesture.lastVisualComponentId) return null;
      gesture.lastVisualComponentId = componentId;
      gesture.visualHitCount += 1;
      const pressure = Number.isFinite(dynamics.pressure) && dynamics.pressure > 0 ? dynamics.pressure : 0.5;
      const speed = Number.isFinite(dynamics.speed) ? dynamics.speed : 0;
      const accent = clamp(0.72 + pressure * 0.18 + smoothstep(speed / 1500) * 0.08, 0.68, 0.98);
      const visualNote = { at, x: component.centerX, y: component.centerY, componentId, phraseId: gesture.id, layer: gesture.layer, gainScale: accent };
      const prior = gesture.notes.at(-1);
      if (gesture.notes.length >= this.config.maxNotes || (prior && at - prior.at < this.config.minNoteInterval - 1e-9)) return null;
      const note = { ...visualNote, accent };
      gesture.notes.push(note);
      this.liveEventCount += 1;
      return gestureNoteEvent(component, at, gesture.id, gesture.layer, accent, accent, 0);
    }

    finishGesture(gesture, endedAt) {
      if (!gesture || (!gesture.notes.length && !gesture.wavePoints.length)) return null;
      const firstAt = Math.min(gesture.notes[0]?.at ?? Infinity, gesture.wavePoints[0]?.at ?? Infinity);
      const lastRecordedAt = Math.max(gesture.notes.at(-1)?.at ?? firstAt, gesture.wavePoints.at(-1)?.at ?? firstAt);
      const rawDuration = Math.max(0, lastRecordedAt - firstAt);
      const maximumNotesDuration = Math.max(0, this.config.maxPeriod - this.config.loopGap);
      const timeScale = rawDuration > maximumNotesDuration && rawDuration > 0 ? maximumNotesDuration / rawDuration : 1;
      const notes = gesture.notes.map((note) => ({
        componentId: note.componentId,
        offset: (note.at - firstAt) * timeScale,
        x: note.x,
        y: note.y,
        accent: note.accent,
      }));
      const selectedWavePoints = [];
      const wavePointCount = Math.min(gesture.wavePoints.length, this.config.maxWaves);
      if (wavePointCount === 1) selectedWavePoints.push(gesture.wavePoints[0]);
      else if (wavePointCount > 1) {
        for (let index = 0; index < wavePointCount; index += 1) {
          selectedWavePoints.push(gesture.wavePoints[Math.round(index * (gesture.wavePoints.length - 1) / (wavePointCount - 1))]);
        }
      }
      const wavePoints = selectedWavePoints.map((wavePoint, index) => ({
        sourceIndex: wavePoint.sourceIndex,
        offset: (wavePoint.at - firstAt) * timeScale,
        x: wavePoint.x,
        y: wavePoint.y,
        fromX: selectedWavePoints[index - 1]?.x ?? wavePoint.x,
        fromY: selectedWavePoints[index - 1]?.y ?? wavePoint.y,
        amplitude: wavePoint.amplitude,
      }));
      const phraseDuration = Math.max(notes.at(-1)?.offset || 0, wavePoints.at(-1)?.offset || 0);
      const period = clamp(phraseDuration + this.config.loopGap, this.config.minPeriod, this.config.maxPeriod);
      const replayAt = Math.max(endedAt, lastRecordedAt) + this.config.loopGap;
      const lastEventAt = replayAt + (this.config.repeatCount - 1) * period + phraseDuration;
      const phrase = {
        id: gesture.id,
        layer: gesture.layer,
        recordedAt: gesture.startedAt,
        replayAt,
        duration: phraseDuration,
        period,
        repeatCount: this.config.repeatCount,
        notes,
        wavePoints,
        lastEventAt,
        endsAt: lastEventAt + this.config.waveLife,
      };
      this.phrases.push(phrase);
      if (this.phrases.length > this.config.maxPhrases) {
        const removed = this.phrases.splice(0, this.phrases.length - this.config.maxPhrases);
        const removedIds = new Set(removed.map((item) => item.id));
        this.waves = this.waves.filter((wave) => !removedIds.has(wave.phraseId));
        this.pendingWaves = this.pendingWaves.filter((wave) => !removedIds.has(wave.phraseId));
      }
      return phrase;
    }

    eventsBetween(fromTime, toTime, pruneAfter = true) {
      const events = [];
      for (const phrase of this.phrases) {
        for (let repeat = 0; repeat < phrase.repeatCount; repeat += 1) {
          const loopAt = phrase.replayAt + repeat * phrase.period;
          const soundGain = Math.pow(this.config.repeatFade, repeat + 1);
          const waveGain = Math.pow(this.config.waveRepeatFade, repeat + 1);
          for (const wavePoint of phrase.wavePoints) {
            const at = loopAt + wavePoint.offset;
            if (at <= fromTime + 1e-9 || at > toTime + 1e-9) continue;
            this.addWave({
              ...wavePoint,
              phraseId: phrase.id,
              layer: phrase.layer,
              repeat: repeat + 1,
            }, at, waveGain * wavePoint.amplitude);
          }
          for (const note of phrase.notes) {
            const at = loopAt + note.offset;
            if (at <= fromTime + 1e-9 || at > toTime + 1e-9) continue;
            const component = this.components[note.componentId];
            const event = gestureNoteEvent(component, at, phrase.id, phrase.layer, soundGain * note.accent, note.accent, repeat + 1);
            events.push(event);
            this.replayEventCount += 1;
          }
        }
      }
      events.push(...this.motifEventsForPerformancesBetween(this.motifPerformances, fromTime, toTime));
      if (pruneAfter) {
        this.promoteWavesThrough(toTime);
        this.prune(toTime);
      }
      return events.sort((left, right) => left.at - right.at || left.phraseId - right.phraseId || left.componentId - right.componentId);
    }

    motifEventsForPerformancesBetween(performances, fromTime, toTime) {
      const events = [];
      for (const performance of performances) {
        for (const event of performance.events) {
          if (event.at <= fromTime + 1e-9 || event.at > toTime + 1e-9) continue;
          events.push(event);
        }
      }
      return events;
    }

    prune(now) {
      let write = 0;
      for (let read = 0; read < this.waves.length; read += 1) {
        const wave = this.waves[read];
        if (wave.at <= now + 1e-9 && now - wave.at > this.config.waveLife + 1e-9) continue;
        this.waves[write++] = wave;
      }
      if (write !== this.waves.length) {
        this.waves.length = write;
        this.fieldSampledAt = -Infinity;
      }
      write = 0;
      for (let read = 0; read < this.phrases.length; read += 1) {
        const phrase = this.phrases[read];
        if (now > phrase.endsAt + 1e-9) continue;
        this.phrases[write++] = phrase;
      }
      this.phrases.length = write;
      write = 0;
      for (let read = 0; read < this.motifPerformances.length; read += 1) {
        const performance = this.motifPerformances[read];
        if (now > performance.endsAt + 1e-9) continue;
        this.motifPerformances[write++] = performance;
      }
      this.motifPerformances.length = write;
    }

    amplitudeAt(x, y, now) {
      this.promoteWavesThrough(now);
      let sum = 0;
      const fieldIndex = this.waveIndexAt(x, y);
      for (const wave of this.waves) {
        const age = now - wave.at;
        if (age < 0 || age > this.config.waveLife) continue;
        const radius = age * this.config.waveSpeed;
        const delta = wave.distances[fieldIndex] - radius;
        const distance = Math.abs(delta);
        if (distance >= this.config.waveWidth) continue;
        const envelope = (1 - distance / this.config.waveWidth) * waveLifeGain(age, this.config.waveLife) * wave.amplitude;
        sum += Math.cos(delta * Math.PI / this.config.waveWidth) * envelope;
      }
      return Math.tanh(sum);
    }

    /** 单独测量正能量包络，供远端衰减诊断；真实机关触发读取与屏幕完全相同的 signed 场。 */
    activationEnergyAt(fieldIndex, now) {
      this.promoteWavesThrough(now);
      let sum = 0;
      for (const wave of this.waves) {
        const age = now - wave.at;
        if (age < 0 || age > this.config.waveLife) continue;
        const delta = wave.distances[fieldIndex] - age * this.config.waveSpeed;
        const distance = Math.abs(delta);
        if (distance >= this.config.waveWidth) continue;
        sum += (1 - distance / this.config.waveWidth) * waveLifeGain(age, this.config.waveLife) * wave.amplitude;
      }
      return Math.tanh(sum);
    }

    waveHasTriggeredComponent(wave, componentId) {
      const mask = 1 << (componentId & 31);
      return Boolean(wave?.triggeredComponentBits?.[componentId >> 5] & mask);
    }

    markWaveTriggeredComponent(wave, componentId) {
      if (!wave?.triggeredComponentBits) return;
      const word = componentId >> 5;
      wave.triggeredComponentBits[word] |= 1 << (componentId & 31);
    }

    sampleComponentEnergy(now) {
      const energies = this.componentEnergy;
      // 与屏幕上的 signed 波场共用同一份 60 Hz 样本；干涉暗节点不再出现“看不见波却启动”。
      const field = this.sampleField(now);
      for (let componentId = 0; componentId < energies.length; componentId += 1) {
        const offset = componentId * COMPONENT_WAVE_CONTACTS;
        let strongest = 0;
        for (let contact = 1; contact < COMPONENT_WAVE_CONTACTS; contact += 1) {
          if (Math.abs(field[this.componentContactWaveIndex[offset + contact]]) > Math.abs(field[this.componentContactWaveIndex[offset + strongest]])) strongest = contact;
        }
        this.componentPeakContact[componentId] = strongest;
        const fieldIndex = this.componentContactWaveIndex[offset + strongest];
        const aggregateSigned = field[fieldIndex];
        energies[componentId] = Math.abs(aggregateSigned);
        let dominantWaveIndex = -1;
        let dominantStrength = 0;
        if (energies[componentId] >= this.config.componentThreshold * 0.55) {
          for (let waveIndex = 0; waveIndex < this.waves.length; waveIndex += 1) {
            const wave = this.waves[waveIndex];
            const age = now - wave.at;
            if (age < 0 || age > this.config.waveLife) continue;
            const delta = wave.distances[fieldIndex] - age * this.config.waveSpeed;
            const distance = Math.abs(delta);
            if (distance >= this.config.waveWidth) continue;
            const signedContribution = Math.cos(delta * Math.PI / this.config.waveWidth)
              * (1 - distance / this.config.waveWidth) * waveLifeGain(age, this.config.waveLife) * wave.amplitude;
            // 先在全部同相贡献中找真正主导当前可见峰的物理波；反相波不会借别人的亮峰取得身份。
            if (signedContribution * aggregateSigned <= 0) continue;
            const strength = Math.abs(signedContribution);
            if (strength <= dominantStrength) continue;
            dominantStrength = strength;
            dominantWaveIndex = waveIndex;
          }
        }
        // 主导波已经启动过这个机关时，不向更弱的未消费波 fallback，避免弱波借强波后续波瓣伪造第二次启动。
        if (dominantWaveIndex >= 0 && this.waveHasTriggeredComponent(this.waves[dominantWaveIndex], componentId)) dominantWaveIndex = -1;
        this.componentDominantWaveIndex[componentId] = dominantWaveIndex;
      }
      return energies;
    }

    sampleAt(x, y, now) {
      const signed = this.amplitudeAt(x, y, now);
      return { signed, energy: Math.abs(signed) };
    }

    sampleField(now) {
      this.promoteWavesThrough(now);
      if (Math.abs(this.fieldSampledAt - now) < 1e-9) return this.waveField;
      const field = this.waveField;
      field.fill(0);
      for (const wave of this.waves) {
        const age = now - wave.at;
        if (age < 0 || age > this.config.waveLife) continue;
        const radius = age * this.config.waveSpeed;
        const lifeAmplitude = waveLifeGain(age, this.config.waveLife) * wave.amplitude;
        for (let index = 0; index < field.length; index += 1) {
          const delta = wave.distances[index] - radius;
          const distance = Math.abs(delta);
          if (distance >= this.config.waveWidth) continue;
          field[index] += Math.cos(delta * Math.PI / this.config.waveWidth) * (1 - distance / this.config.waveWidth) * lifeAmplitude;
        }
      }
      for (let index = 0; index < field.length; index += 1) field[index] = Math.tanh(field[index]);
      this.fieldSampledAt = now;
      return field;
    }

    fieldForDisplay(now) {
      const sampleAge = now - this.fieldSampledAt;
      if (!Number.isFinite(sampleAge) || sampleAge < -1e-6 || sampleAge > this.wakeStep + 1e-4) return this.sampleField(now);
      return this.waveField;
    }

    prepareWaveAccents(field) {
      const buckets = this.waveRenderBuckets;
      for (const bucket of buckets) bucket.length = 0;
      const membership = this.waveAccentBucket;
      membership.fill(-1);
      for (let index = 0; index < this.waveX.length; index += 1) {
        const energy = Math.abs(field[index]);
        if (energy < 0.2) continue;
        const row = Math.floor(index / this.config.waveCols);
        const col = index - row * this.config.waveCols;
        const left = col > 0 ? Math.abs(field[index - 1]) : -1;
        const right = col + 1 < this.config.waveCols ? Math.abs(field[index + 1]) : -1;
        const up = row > 0 ? Math.abs(field[index - this.config.waveCols]) : -1;
        const down = row + 1 < this.config.waveRows ? Math.abs(field[index + this.config.waveCols]) : -1;
        if (energy + 1e-6 < Math.max(left, right, up, down)) continue;
        membership[index] = clamp(Math.floor((energy - 0.2) / 0.8 * buckets.length), 0, buckets.length - 1);
      }
      let openBuckets = buckets.length;
      for (let orderIndex = 0; orderIndex < this.waveAccentOrder.length && openBuckets > 0; orderIndex += 1) {
        const pointIndex = this.waveAccentOrder[orderIndex];
        const bucket = membership[pointIndex];
        if (bucket < 0) continue;
        const selected = buckets[bucket];
        const quota = WAVE_ACCENT_QUOTAS[bucket];
        if (selected.length >= quota) continue;
        selected.push(pointIndex);
        if (selected.length === quota) openBuckets -= 1;
      }
      return buckets;
    }

    prepareResponseReeds(field) {
      const buckets = this.responseRenderBuckets;
      for (const bucket of buckets) bucket.length = 0;
      for (let responseIndex = 0; responseIndex < this.responseField.count; responseIndex += 1) {
        const signed = field[this.responseWaveIndex[responseIndex]];
        const energy = Math.abs(signed);
        // 微型簧片只标记真正可见的波峰；低能量区域交给连续纹理，避免整屏像飘雪。
        if (energy < RESPONSE_REED_VISIBLE_FLOOR) continue;
        const energyBucket = clamp(Math.floor((energy - RESPONSE_REED_VISIBLE_FLOOR) / (1 - RESPONSE_REED_VISIBLE_FLOOR) * 5), 0, 4);
        buckets[(signed < 0 ? 5 : 0) + energyBucket].push(responseIndex);
      }
      return buckets;
    }

    startMotifAbility(component, at, activation) {
      const ability = component?.motifAbility;
      if (!this.motifEnabled || !ability?.enabled || ability.slot >= this.config.motifCount) return null;
      const definition = this.motifLibrary.get(ability.id);
      if (!definition?.notes.length) return null;
      const firstUnlock = !this.unlockedMotifComponents.has(component.id);
      if (!firstUnlock && at < this.motifNextAvailableAt[component.id] - 1e-9) return null;
      // 一个能力是一句不可拆分的演奏。容量不足时整句不开始，也不提前解锁或进入冷却；
      // AudioEngine 同样按 performanceId 保留一个持续音源，二者共享同一硬上限。
      const activeMotifPerformanceCount = this.motifPerformances.reduce(
        (count, performance) => count + (performance.startedAt <= at + 1e-9 && at < performance.endsAt - 1e-9 ? 1 : 0),
        0,
      );
      if (activeMotifPerformanceCount >= this.config.motifVoiceLimit) {
        this.motifPerformanceRejectCount += 1;
        return null;
      }
      if (firstUnlock) {
        this.unlockedMotifComponents.add(component.id);
        this.motifUnlockCount += 1;
        this.newlyUnlockedMotifs.push({ componentId: component.id, id: ability.id, title: ability.title, family: ability.family, at });
      }
      this.motifNextAvailableAt[component.id] = at + this.config.motifCooldown;
      // 公版名曲锁定其可辨识调性；只有原创爵士与未声明策略的旧 custom 才跟随机关移调。
      const rootPitch = definition.transposePolicy === "fixed" && Number.isFinite(definition.rootPitch)
        ? definition.rootPitch
        : clamp(component.pitch - 5, 43, 72);
      const events = [];
      let cursor = 0.06 + (Number(definition.leadInBeats) || 0) * definition.beatSeconds;
      for (let index = 0; index < definition.notes.length; index += 1) {
        const note = definition.notes[index];
        const noteSeconds = note.beats * definition.beatSeconds;
        events.push({
          at: at + cursor,
          kind: "motif-note",
          pitch: clamp(rootPitch + note.semitones, 40, 88),
          accent: note.accent,
          duration: clamp(noteSeconds * 0.86, 0.1, 0.72),
          activationId: `motif:${component.id}:${this.motifPlayCount + 1}`,
          activationMode: "motifAbility",
          componentId: component.id,
          type: component.type,
          sourceU: (component.centerX - FRAME.x) / FRAME.width,
          layer: "motif",
          gainScale: this.config.motifGain,
          motifId: definition.id,
          motifTitle: definition.title,
          motifComposer: definition.composer,
          motifFamily: definition.family,
          motifRootPitch: rootPitch,
          motifTransposePolicy: definition.transposePolicy,
          motifNoteIndex: index,
          motifUnlocked: firstUnlock,
        });
        cursor += noteSeconds;
      }
      const audibleEndsAt = events.at(-1).at + events.at(-1).duration + 0.04;
      for (const event of events) {
        event.motifNoteCount = events.length;
        event.motifPerformanceEndsAt = audibleEndsAt;
      }
      const performance = {
        id: ++this.motifPlayCount,
        componentId: component.id,
        motifId: definition.id,
        title: definition.title,
        composer: definition.composer,
        rootPitch,
        transposePolicy: definition.transposePolicy,
        startedAt: at,
        endsAt: at + cursor + 0.8,
        events,
      };
      this.motifPerformances.push(performance);
      this.startedMotifPerformances.push(performance);
      activation.motifAbilityId = definition.id;
      activation.motifAbilityTitle = definition.title;
      activation.motifUnlocked = firstUnlock;
      return performance;
    }

    startComponent(manager, componentId, at, source = "wave") {
      if (!manager || manager.isOccupiedAt(componentId, at)) return null;
      const strokeSource = source === "stroke";
      const totalActive = manager.activeCountAt(at);
      const strokeActive = manager.activeCountAt(at, (active) => active.melodySource === "stroke");
      const waveActive = manager.activeCountAt(at, (active) => active.mode === "melodyWave" && active.melodySource !== "stroke");
      if (totalActive >= this.config.componentLimit + this.config.strokeComponentLimit) return null;
      if (strokeSource ? strokeActive >= this.config.strokeComponentLimit : waveActive >= this.config.componentLimit) return null;
      const activation = manager.start(componentId, at, "melodyWave", 0, {
        cycleCount: this.config.componentCycles,
        periodScale: this.config.componentPeriodScale,
        gainScale: this.config.componentGain,
      });
      if (!activation) return null;
      activation.melodySource = source;
      this.startMotifAbility(this.components[componentId], at, activation);
      this.componentWasAbove[componentId] = 1;
      this.componentTriggerCount += 1;
      this.peakActiveComponents = Math.max(this.peakActiveComponents, manager.activeCountAt(at));
      return activation;
    }

    /**
     * 波前只负责“叫醒”机关。越过阈值后机关交给 ActivationManager 自己完成整周期，
     * 不再把每帧振幅映射成姿态，因此干涉纹理可以细密，详细机关也不会随之狂闪。
     */
    wakeComponentsAt(manager, fieldTime) {
      this.promoteWavesThrough(fieldTime);
      this.sampleField(fieldTime);
      const componentEnergy = this.sampleComponentEnergy(fieldTime);
      const threshold = this.config.componentThreshold;
      const releaseThreshold = threshold * 0.55;
      let candidateCount = 0;
      let crossingCount = 0;
      for (const component of this.components) {
        const energy = componentEnergy[component.id];
        if (this.componentWasAbove[component.id]) {
          if (energy < releaseThreshold) this.componentWasAbove[component.id] = 0;
          continue;
        }
        if (energy < threshold) continue;
        // 阈值上升沿就是唯一启动时刻。即使槽位已满也立刻锁存到波谷，禁止波走后“补票”启动。
        this.componentWasAbove[component.id] = 1;
        crossingCount += 1;
        const triggerWaveIndex = this.componentDominantWaveIndex[component.id];
        if (triggerWaveIndex < 0) continue;
        const triggerWave = this.waves[triggerWaveIndex];
        this.markWaveTriggeredComponent(triggerWave, component.id);
        if (manager.isOccupiedAt(component.id, fieldTime)) {
          continue;
        }
        this.triggerCandidateIds[candidateCount] = component.id;
        this.triggerCandidateEnergy[candidateCount] = energy;
        this.triggerCandidateWaveId[candidateCount] = triggerWave.id;
        candidateCount += 1;
      }
      const totalActive = manager.activeCountAt(fieldTime);
      const waveActive = manager.activeCountAt(fieldTime, (active) => active.mode === "melodyWave" && active.melodySource !== "stroke");
      const availableSlots = Math.max(0, Math.min(
        this.config.componentLimit - waveActive,
        this.config.componentLimit + this.config.strokeComponentLimit - totalActive,
      ));
      let started = 0;
      while (candidateCount > 0 && started < availableSlots) {
        let strongest = 0;
        for (let index = 1; index < candidateCount; index += 1) {
          if (this.triggerCandidateEnergy[index] > this.triggerCandidateEnergy[strongest]) strongest = index;
        }
        const componentId = this.triggerCandidateIds[strongest];
        const activation = this.startComponent(manager, componentId, fieldTime, "wavefront");
        if (activation) {
          activation.melodyTriggeredAt = fieldTime;
          activation.melodyTriggerEnergy = componentEnergy[componentId];
          activation.melodyTriggerWaveId = this.triggerCandidateWaveId[strongest];
          const contactIndex = componentId * COMPONENT_WAVE_CONTACTS + this.componentPeakContact[componentId];
          activation.melodyContactIndex = this.componentPeakContact[componentId];
          activation.melodyContactX = this.componentContactX[contactIndex];
          activation.melodyContactY = this.componentContactY[contactIndex];
          this.startedActivations.push(activation);
          started += 1;
        }
        candidateCount -= 1;
        this.triggerCandidateIds[strongest] = this.triggerCandidateIds[candidateCount];
        this.triggerCandidateEnergy[strongest] = this.triggerCandidateEnergy[candidateCount];
        this.triggerCandidateWaveId[strongest] = this.triggerCandidateWaveId[candidateCount];
      }
      this.componentSkippedWaveEdgeCount += Math.max(0, crossingCount - started);
      return started;
    }

    wakeComponents(manager, now) {
      this.startedActivations.length = 0;
      this.startedMotifPerformances.length = 0;
      this.newlyUnlockedMotifs.length = 0;
      let started = 0;
      let steps = 0;
      while (this.nextWakeSampleAt <= now + 1e-9 && steps < 8) {
        started += this.wakeComponentsAt(manager, this.nextWakeSampleAt);
        this.nextWakeSampleAt += this.wakeStep;
        steps += 1;
      }
      // 页面恢复等极端跳时不追赶无界历史；正常帧的 0.1 s delta 上限会完整覆盖 6 个子步。
      if (this.nextWakeSampleAt <= now + 1e-9) this.nextWakeSampleAt = now + this.wakeStep;
      // 最后一个固定样本与当前显示时刻之间的新波只进入画面，不倒流影响已经完成的历史采样。
      this.promoteWavesThrough(now);
      return started;
    }

    isAnimating(now) {
      return this.waves.some((wave) => wave.at > now + 1e-9 || now - wave.at <= this.config.waveLife + 1e-9)
        || this.pendingWaves.some((wave) => wave.at > now + 1e-9 || now - wave.at <= this.config.waveLife + 1e-9)
        || this.phrases.some((phrase) => now <= phrase.endsAt + 1e-9)
        || this.motifPerformances.some((performance) => now <= performance.endsAt + 1e-9);
    }

    snapshot(now) {
      this.promoteWavesThrough(now);
      this.prune(now);
      return {
        activePhrases: this.phrases.map((phrase) => ({
          id: phrase.id, layer: phrase.layer, noteCount: phrase.notes.length, period: phrase.period,
          wavePointCount: phrase.wavePoints.length, replayAt: phrase.replayAt, repeatCount: phrase.repeatCount, endsAt: phrase.endsAt,
        })),
        activePhraseCount: this.phrases.length,
        activeWaveCount: this.waves.length,
        peakWaveCount: this.peakWaveCount,
        liveEventCount: this.liveEventCount,
        replayEventCount: this.replayEventCount,
        componentTriggerCount: this.componentTriggerCount,
        componentSkippedWaveEdgeCount: this.componentSkippedWaveEdgeCount,
        peakActiveComponents: this.peakActiveComponents,
        motifEnabled: this.motifEnabled,
        motifUnlockCount: this.motifUnlockCount,
        motifPlayCount: this.motifPlayCount,
        motifPerformanceRejectCount: this.motifPerformanceRejectCount,
        unlockedMotifComponentIds: [...this.unlockedMotifComponents].sort((left, right) => left - right),
      };
    }
  }

  class InteractionController {
    constructor(manager, components, maximumConcurrent = 6) {
      this.manager = manager;
      this.components = components;
      this.maximumConcurrent = maximumConcurrent;
      this.queue = [];
      this.accepting = true;
      this.requestCount = 0;
      this.startedOrder = [];
      this.duplicateRequestCount = 0;
      this.maxConcurrentObserved = 0;
    }

    activeOneShots() {
      return [...this.manager.active.values()].filter((activation) => activation.mode === "oneShot");
    }

    hasComponent(componentId) {
      return this.manager.active.has(componentId) || this.queue.some((item) => item.componentId === componentId);
    }

    request(componentId, requestedAt) {
      if (!this.accepting || !this.components[componentId]) return { status: "unavailable", componentId };
      if (this.hasComponent(componentId)) {
        this.duplicateRequestCount += 1;
        return { status: "alreadyPlaying", componentId };
      }
      const request = { componentId, requestedAt, sequence: ++this.requestCount };
      if (this.activeOneShots().length < this.maximumConcurrent) {
        const activation = this.start(request, requestedAt);
        return { status: "started", componentId, activationId: activation.id };
      }
      this.queue.push(request);
      return { status: "queued", componentId, queuePosition: this.queue.length };
    }

    start(request, startedAt) {
      const activation = this.manager.start(request.componentId, startedAt, "oneShot", 0);
      if (!activation) throw new Error(`Unable to start interaction component ${request.componentId}.`);
      this.startedOrder.push({ componentId: request.componentId, sequence: request.sequence, startedAt: activation.startedAt, activationId: activation.id });
      this.maxConcurrentObserved = Math.max(this.maxConcurrentObserved, this.activeOneShots().length);
      return activation;
    }

    handleFinished(finished) {
      const completedSlots = finished.filter((activation) => activation.mode === "oneShot");
      for (const completion of completedSlots) {
        if (this.queue.length === 0) break;
        const request = this.queue.shift();
        this.start(request, completion.completeAt);
      }
    }

    stopAccepting() {
      this.accepting = false;
    }

    isIdle() {
      return this.activeOneShots().length === 0 && this.queue.length === 0;
    }

    snapshot(now) {
      return {
        accepting: this.accepting,
        maximumConcurrent: this.maximumConcurrent,
        active: this.activeOneShots().map((activation) => ({
          componentId: activation.componentId,
          activationId: activation.id,
          progress: clamp((now - activation.startedAt) / (activation.completeAt - activation.startedAt)),
          completeAt: activation.completeAt,
        })),
        queue: this.queue.map((request, index) => ({ ...request, position: index + 1 })),
        startedOrder: this.startedOrder.map((entry) => ({ ...entry })),
        duplicateRequestCount: this.duplicateRequestCount,
        maxConcurrentObserved: this.maxConcurrentObserved,
      };
    }
  }

  class AudioEngine {
    constructor(intentOn = true, limits = {}) {
      this.context = null;
      this.input = null;
      this.limiter = null;
      this.softLimiter = null;
      this.master = null;
      this.captureDestination = null;
      this.intentOn = intentOn;
      this.enabled = false;
      this.lifecycleRevision = 0;
      this.lifecycleQueue = Promise.resolve(false);
      this.scheduledEventCount = 0;
      this.gliderContactEvents = 0;
      this.gliderFrictionStarts = 0;
      this.frictionVoices = new Map();
      this.desiredFrictionIds = new Set();
      this.rejectedFrictionIds = new Set();
      this.frictionBuffer = null;
      this.frictionBufferDuration = 0.72;
      this.gestureVoiceLimit = limits.gestureVoiceLimit || MELODY_DEFAULTS.voiceLimit;
      this.motifVoiceLimit = limits.motifVoiceLimit || MELODY_DEFAULTS.motifVoiceLimit;
      this.mechanismVoiceLimit = limits.mechanismVoiceLimit || MELODY_DEFAULTS.mechanismVoiceLimit;
      this.frictionVoiceLimit = limits.frictionVoiceLimit || MELODY_DEFAULTS.frictionVoiceLimit;
      this.gestureVoiceEnds = [];
      // 每句 motif 只持有一个持续 oscillator；音符通过同一音源改频与重做包络。
      // 因而 voice cap 就是演奏级硬上限，不会在一句已经开始后丢掉中间音。
      this.motifPerformanceVoices = new Map();
      this.rejectedMotifPerformanceIds = new Set();
      this.mechanismVoiceEnds = [];
      this.pendingGestureEvents = [];
      this.pendingGestureLogicalNow = 0;
      this.pendingGesturePreserveTiming = false;
      this.gestureBatchPlayCount = 0;
      this.lastGestureBatchOffsets = [];
      this.oneShotSources = new Set();
      this.gestureVoicesAccepted = 0;
      this.gestureVoicesDropped = 0;
      this.maxGestureVoicesObserved = 0;
      this.motifVoicesAccepted = 0;
      this.motifVoicesDropped = 0;
      this.motifNotesAccepted = 0;
      this.motifNotesDropped = 0;
      this.motifAcceptedExpectedNotes = 0;
      this.motifRejectedExpectedNotes = 0;
      this.maxMotifVoicesObserved = 0;
      this.mechanismVoicesAccepted = 0;
      this.mechanismVoicesDropped = 0;
      this.maxMechanismVoicesObserved = 0;
      this.frictionVoicesDropped = 0;
      this.noiseVoicesScheduled = 0;
      this.lastNoiseAttackSeconds = 0;
      this.lastCatchupScheduleOffsets = [];
    }

    initialize() {
      if (this.context?.state === "closed") this.releaseContextReferences(this.context);
      if (this.context) return true;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return false;
      let context;
      try {
        context = new AudioContextClass({ latencyHint: "interactive", sampleRate: 48000 });
      } catch (_) {
        try {
          context = new AudioContextClass();
        } catch (e) {
          return false;
        }
      }
      const highpass = context.createBiquadFilter();
      const lowpass = context.createBiquadFilter();
      const compressor = context.createDynamicsCompressor();
      const limiter = context.createDynamicsCompressor();
      const softLimiter = typeof context.createWaveShaper === "function" ? context.createWaveShaper() : null;
      const master = context.createGain();
      const captureDestination = typeof context.createMediaStreamDestination === "function"
        ? context.createMediaStreamDestination()
        : null;
      highpass.type = "highpass";
      highpass.frequency.value = 72;
      lowpass.type = "lowpass";
      lowpass.frequency.value = 8800;
      compressor.threshold.value = -19;
      compressor.knee.value = 5;
      compressor.ratio.value = 2.4;
      compressor.attack.value = 0.012;
      compressor.release.value = 0.16;
      limiter.threshold.value = AUDIO_SAFETY.limiterThresholdDb;
      limiter.knee.value = AUDIO_SAFETY.limiterKneeDb;
      limiter.ratio.value = AUDIO_SAFETY.limiterRatio;
      limiter.attack.value = AUDIO_SAFETY.limiterAttackSeconds;
      limiter.release.value = AUDIO_SAFETY.limiterReleaseSeconds;
      if (softLimiter) {
        softLimiter.curve = makeSoftLimitCurve();
        softLimiter.oversample = "4x";
      }
      master.gain.value = 0.0001;
      highpass.connect(lowpass);
      lowpass.connect(compressor);
      compressor.connect(limiter);
      if (softLimiter) {
        limiter.connect(softLimiter);
        softLimiter.connect(master);
      } else limiter.connect(master);
      master.connect(context.destination);
      if (captureDestination) master.connect(captureDestination);
      this.context = context;
      this.input = highpass;
      this.limiter = limiter;
      this.softLimiter = softLimiter;
      this.master = master;
      this.captureDestination = captureDestination;
      const length = Math.round(context.sampleRate * this.frictionBufferDuration);
      this.frictionBuffer = context.createBuffer(1, length, context.sampleRate);
      const values = this.frictionBuffer.getChannelData(0);
      let state = hashString("v4-glider-friction");
      for (let index = 0; index < values.length; index += 1) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        values[index] = ((state >>> 0) / 2147483648 - 1) * 0.42;
      }
      // 共享噪声也被 glider 循环播放；首尾短窗归零，避免每 0.72 s 在接缝处产生 tic。
      const seamSamples = Math.min(Math.floor(values.length / 4), Math.max(1, Math.round(context.sampleRate * AUDIO_SAFETY.frictionSeamSeconds)));
      for (let index = 0; index < seamSamples; index += 1) {
        const phase = (index + 0.5) / seamSamples * Math.PI * 0.5;
        const windowGain = Math.sin(phase) ** 2;
        values[index] *= windowGain;
        values[values.length - 1 - index] *= windowGain;
      }
      return true;
    }

    releaseContextReferences(context) {
      if (!context || this.context !== context) return;
      this.enabled = false;
      this.context = null;
      this.input = null;
      this.limiter = null;
      this.softLimiter = null;
      this.master = null;
      this.captureDestination = null;
      this.frictionBuffer = null;
      this.oneShotSources.clear();
      this.frictionVoices.clear();
      this.desiredFrictionIds.clear();
      this.rejectedFrictionIds.clear();
      this.gestureVoiceEnds.length = 0;
      this.motifPerformanceVoices.clear();
      this.rejectedMotifPerformanceIds.clear();
      this.mechanismVoiceEnds.length = 0;
      this.pendingGestureEvents.length = 0;
      this.pendingGesturePreserveTiming = false;
    }

    queueLifecycleTransition(targetRunning, eagerResume = null) {
      const context = this.context;
      if (!context) return Promise.resolve(false);
      const revision = ++this.lifecycleRevision;
      const transition = this.lifecycleQueue.catch(() => false).then(async () => {
        if (revision !== this.lifecycleRevision || context !== this.context) return false;
        if (!targetRunning) {
          if (context.state === "running") {
            try { await context.suspend(); } catch (_) { /* Already closing. */ }
          }
          return false;
        }
        if (!this.intentOn) return false;
        if (eagerResume && !await eagerResume) return false;
        if (context.state !== "running" && context.state !== "closed") {
          try { await context.resume(); } catch (_) { return false; }
        }
        if (revision !== this.lifecycleRevision || context !== this.context || !this.intentOn) return false;
        return context.state === "running" ? this.setEnabled(true) : false;
      });
      this.lifecycleQueue = transition.catch(() => false);
      return this.lifecycleQueue;
    }

    async toggle() {
      if (this.enabled) {
        this.intentOn = false;
        this.lifecycleRevision += 1;
        this.setEnabled(false);
        return false;
      }
      this.intentOn = true;
      return this.ensureEnabled();
    }

    setEnabled(enabled) {
      if (!this.master || !this.context) return false;
      this.enabled = enabled && this.context.state === "running";
      const now = this.context.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(this.enabled ? AUDIO_SAFETY.masterGain : 0.0001, now, 0.025);
      if (!this.enabled) {
        this.pendingGestureEvents.length = 0;
        this.pendingGesturePreserveTiming = false;
        this.stopAllFriction();
        this.stopAllOneShots();
      } else if (this.pendingGestureEvents.length) {
        const pending = this.pendingGestureEvents.splice(0);
        const preserveGestureTiming = this.pendingGesturePreserveTiming;
        this.pendingGesturePreserveTiming = false;
        this.play(pending, this.pendingGestureLogicalNow, 1, { preserveGestureTiming });
      }
      return this.enabled;
    }

    ensureEnabled() {
      this.intentOn = true;
      if (!this.initialize()) return Promise.resolve(false);
      const context = this.context;
      let eagerResume = null;
      if (context.state !== "running" && context.state !== "closed") {
        try {
          // resume() 必须在 click / pointerdown 的同步调用栈里发生；部分 WebView 到下一个微任务就会失去手势授权。
          eagerResume = Promise.resolve(context.resume()).then(() => true, () => false);
        } catch (_) {
          eagerResume = Promise.resolve(false);
        }
      }
      return this.queueLifecycleTransition(true, eagerResume);
    }

    async attemptAutoplay() {
      if (!this.intentOn || !this.initialize()) return false;
      return this.wake();
    }

    panner(sourceU) {
      if (typeof this.context.createStereoPanner === "function") {
        const panner = this.context.createStereoPanner();
        panner.pan.value = clamp((sourceU - 0.5) * 1.35, -0.72, 0.72);
        return panner;
      }
      return this.context.createGain();
    }

    getCaptureStream() {
      return this.captureDestination?.stream || null;
    }

    trackOneShot(source) {
      this.oneShotSources.add(source);
      const previousOnEnded = source.onended;
      source.onended = (...args) => {
        this.oneShotSources.delete(source);
        if (typeof previousOnEnded === "function") previousOnEnded.apply(source, args);
      };
      return source;
    }

    stopAllOneShots() {
      if (!this.context) return;
      const now = this.context.currentTime;
      for (const source of this.oneShotSources) {
        try { source.stop(now); } catch (_) { /* Already ended or stopped. */ }
      }
      this.oneShotSources.clear();
      this.gestureVoiceEnds.length = 0;
      this.motifPerformanceVoices.clear();
      this.rejectedMotifPerformanceIds.clear();
      this.mechanismVoiceEnds.length = 0;
    }

    tone(event, when, options) {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      const panner = this.panner(event.sourceU);
      const frequency = 440 * Math.pow(2, (event.pitch - 69) / 12);
      oscillator.type = options.wave || "sine";
      oscillator.frequency.setValueAtTime(frequency * (options.scale || 1), when);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(options.gain * event.accent * event.gainScale, when + options.attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + options.decay);
      oscillator.connect(gain);
      gain.connect(panner);
      panner.connect(this.input);
      this.trackOneShot(oscillator);
      oscillator.start(when);
      oscillator.stop(when + options.decay + 0.04);
    }

    compactMotifPerformanceVoices(when) {
      for (const [performanceId, voice] of this.motifPerformanceVoices) {
        if (voice.endsAt <= when + 1e-9) this.motifPerformanceVoices.delete(performanceId);
      }
    }

    playMotifNote(event, when, options) {
      const hasIndex = Number.isInteger(event.motifNoteIndex);
      const noteIndex = hasIndex ? event.motifNoteIndex : 0;
      const noteCount = Number.isInteger(event.motifNoteCount) && event.motifNoteCount > 0
        ? event.motifNoteCount
        : 1;
      const isFirst = noteIndex === 0;
      const isLast = noteIndex >= noteCount - 1;
      const performanceId = String(event.activationId ?? `legacy-motif:${this.scheduledEventCount}`);
      let voice = this.motifPerformanceVoices.get(performanceId);

      if (!voice) {
        if (this.rejectedMotifPerformanceIds.has(performanceId) || !isFirst) {
          this.motifNotesDropped += 1;
          if (isLast) this.rejectedMotifPerformanceIds.delete(performanceId);
          return false;
        }
        this.compactMotifPerformanceVoices(when);
        if (this.motifPerformanceVoices.size >= this.motifVoiceLimit) {
          this.rejectedMotifPerformanceIds.add(performanceId);
          this.motifVoicesDropped += 1;
          this.motifNotesDropped += 1;
          this.motifRejectedExpectedNotes += noteCount;
          if (isLast) this.rejectedMotifPerformanceIds.delete(performanceId);
          return false;
        }

        const oscillator = this.context.createOscillator();
        const gain = this.context.createGain();
        const panner = this.panner(event.sourceU);
        oscillator.type = options.wave || "sine";
        gain.gain.value = 0.0001;
        oscillator.connect(gain);
        gain.connect(panner);
        panner.connect(this.input);
        const logicalEndsAt = Number(event.motifPerformanceEndsAt);
        const remaining = Number.isFinite(logicalEndsAt)
          ? Math.max(options.decay + 0.04, logicalEndsAt - event.at)
          : options.decay + 0.04;
        voice = { oscillator, gain, endsAt: when + remaining };
        oscillator.onended = () => {
          if (this.motifPerformanceVoices.get(performanceId) === voice) this.motifPerformanceVoices.delete(performanceId);
        };
        this.trackOneShot(oscillator);
        this.motifPerformanceVoices.set(performanceId, voice);
        this.motifVoicesAccepted += 1;
        this.motifAcceptedExpectedNotes += noteCount;
        this.maxMotifVoicesObserved = Math.max(this.maxMotifVoicesObserved, this.motifPerformanceVoices.size);
        oscillator.start(when);
        // 首音就预约整句的硬停止；即使页面卡顿导致末音事件没送达，也不会留下持续音源。
        oscillator.stop(voice.endsAt);
      }

      const frequency = 440 * Math.pow(2, (event.pitch - 69) / 12);
      const gainParam = voice.gain.gain;
      let noteWhen = when;
      if (!isFirst) {
        // 快速音型可能在上一音尚未衰完时进入；直接 setValue(.0001) 会在任意相位硬切出啪声。
        if (typeof gainParam.cancelAndHoldAtTime === "function") gainParam.cancelAndHoldAtTime(when);
        else gainParam.cancelScheduledValues(when);
        gainParam.setTargetAtTime(0.0001, when, AUDIO_SAFETY.motifRetriggerReleaseSeconds / 6);
        noteWhen += AUDIO_SAFETY.motifRetriggerReleaseSeconds;
      } else {
        gainParam.cancelScheduledValues(when);
      }
      gainParam.setValueAtTime(0.0001, noteWhen);
      voice.oscillator.frequency.setValueAtTime(frequency, noteWhen);
      gainParam.exponentialRampToValueAtTime(options.gain * event.accent * event.gainScale, noteWhen + options.attack);
      gainParam.exponentialRampToValueAtTime(0.0001, noteWhen + options.decay);
      this.motifNotesAccepted += 1;
      return true;
    }

    noise(event, when, options) {
      if (!this.frictionBuffer) return;
      const source = this.context.createBufferSource();
      const filter = this.context.createBiquadFilter();
      const gain = this.context.createGain();
      const panner = this.panner(event.sourceU);
      source.buffer = this.frictionBuffer;
      filter.type = options.filterType || "bandpass";
      filter.frequency.value = options.frequency;
      filter.Q.value = options.q || 0.8;
      const attack = clamp(Number(options.attack) || AUDIO_SAFETY.noiseAttackSeconds, 0.002, Math.max(0.002, options.decay * 0.25));
      const peakGain = Math.max(0.0001, options.gain * event.accent * event.gainScale);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(peakGain, when + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + options.decay);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(panner);
      panner.connect(this.input);
      const availableOffset = Math.max(0, this.frictionBufferDuration - options.decay - 0.01);
      const offset = unitHash(event.activationId, event.componentId, event.kind, "noise-offset") * availableOffset;
      this.trackOneShot(source);
      this.noiseVoicesScheduled += 1;
      this.lastNoiseAttackSeconds = attack;
      source.start(when, offset);
      source.stop(when + options.decay + 0.02);
    }

    startFriction(activation, component, remainingSeconds = Infinity) {
      if (!this.enabled || !this.context || !this.frictionBuffer || this.frictionVoices.has(activation.id) || this.rejectedFrictionIds.has(activation.id)) return;
      if (this.frictionVoices.size >= this.frictionVoiceLimit) {
        this.rejectedFrictionIds.add(activation.id);
        this.frictionVoicesDropped += 1;
        return;
      }
      const source = this.context.createBufferSource();
      const filter = this.context.createBiquadFilter();
      const gain = this.context.createGain();
      const panner = this.panner((component.centerX - FRAME.x) / FRAME.width);
      const material = component.variant.material;
      source.buffer = this.frictionBuffer;
      source.loop = true;
      source.playbackRate.value = 0.82 + (hashString(`${component.id}:${material}`) % 29) / 100;
      filter.type = "bandpass";
      filter.frequency.value = material === "metal" ? 2300 : material === "ceramic" ? 1650 : material === "wood" ? 760 : 430;
      filter.Q.value = material === "felt" ? 0.42 : 0.82;
      gain.gain.value = 0.0001;
      source.connect(filter); filter.connect(gain); gain.connect(panner); panner.connect(this.input);
      source.start();
      // 硬停止：即使页面被隐藏、rAF 不再驱动 syncFriction，噪声源也会在该次亮起结束时自行结束。
      if (Number.isFinite(remainingSeconds)) source.stop(this.context.currentTime + Math.max(0.05, remainingSeconds) + 0.25);
      this.frictionVoices.set(activation.id, { source, gain, componentId: component.id });
      this.gliderFrictionStarts += 1;
    }

    stopFriction(activationId) {
      const voice = this.frictionVoices.get(activationId);
      if (!voice || !this.context) return;
      const now = this.context.currentTime;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0.0001, now, 0.018);
      try { voice.source.stop(now + 0.08); } catch (_) { /* Already stopped. */ }
      this.frictionVoices.delete(activationId);
    }

    stopAllFriction() {
      for (const activationId of this.frictionVoices.keys()) this.stopFriction(activationId);
      this.desiredFrictionIds.clear();
      this.rejectedFrictionIds.clear();
    }

    admitGestureVoice(when, duration) {
      compactFutureTimes(this.gestureVoiceEnds, when);
      if (this.gestureVoiceEnds.length >= this.gestureVoiceLimit) {
        this.gestureVoicesDropped += 1;
        return false;
      }
      this.gestureVoiceEnds.push(when + duration);
      this.gestureVoicesAccepted += 1;
      this.maxGestureVoicesObserved = Math.max(this.maxGestureVoicesObserved, this.gestureVoiceEnds.length);
      return true;
    }

    admitMechanismVoice(when, duration, sourceCount = 1) {
      compactFutureTimes(this.mechanismVoiceEnds, when);
      if (this.mechanismVoiceEnds.length + sourceCount > this.mechanismVoiceLimit) {
        this.mechanismVoicesDropped += sourceCount;
        return false;
      }
      for (let index = 0; index < sourceCount; index += 1) this.mechanismVoiceEnds.push(when + duration);
      this.mechanismVoicesAccepted += sourceCount;
      this.maxMechanismVoicesObserved = Math.max(this.maxMechanismVoicesObserved, this.mechanismVoiceEnds.length);
      return true;
    }

    mechanismSourceCount(kind) {
      return kind === "felt-mallet" || kind === "pendulum-center" || kind === "beacon-chord" ? 2 : 1;
    }

    mechanismEventDuration(kind) {
      if (kind === "beacon-chord") return 1.94;
      if (kind === "pendulum-center") return 0.764;
      if (kind === "rotor-tine") return 0.66;
      if (kind === "ribbon-tap") return 0.38;
      if (kind === "felt-mallet") return 0.248;
      return 0.2;
    }

    syncFriction(activeActivations, components, logicalNow, litCount) {
      if (!this.enabled || this.context?.state !== "running") { this.stopAllFriction(); return; }
      const desired = this.desiredFrictionIds;
      desired.clear();
      const densityScale = Math.min(1, Math.sqrt(18 / Math.max(18, litCount)));
      for (const activation of activeActivations) {
        const component = components[activation.componentId];
        if (component?.type !== "glider" || logicalNow < activation.startedAt || logicalNow >= activation.completeAt) continue;
        desired.add(activation.id);
        this.startFriction(activation, component, activation.completeAt - logicalNow);
        const voice = this.frictionVoices.get(activation.id);
        if (!voice) continue;
        const progress = ((logicalNow - activation.startedAt) % activation.basePeriod) / activation.basePeriod;
        const speed = Math.abs(Math.sin(progress * TAU));
        const materialScale = component.variant.material === "felt" ? 0.65 : component.variant.material === "metal" ? 1.08 : 0.88;
        const now = this.context.currentTime;
        // 看门狗：每帧先取消旧的自动化，再设当前电平并预约 0.3 s 后自动衰减到静音。
        // 只要帧循环还在，衰减永远不会触发；帧一停（切后台、页面被遮住），摩擦声半秒内自己消失。
        voice.gain.gain.cancelScheduledValues(now);
        const activationGain = Number.isFinite(activation.gainScale) ? activation.gainScale : 1;
        voice.gain.gain.setTargetAtTime(0.0001 + speed * 0.012 * materialScale * densityScale * activationGain, now, 0.035);
        voice.gain.gain.setTargetAtTime(0.0001, now + 0.3, 0.08);
      }
      for (const activationId of this.frictionVoices.keys()) if (!desired.has(activationId)) this.stopFriction(activationId);
      for (const activationId of this.rejectedFrictionIds) if (!desired.has(activationId)) this.rejectedFrictionIds.delete(activationId);
    }

    playGestureBatch(events) {
      if (!events.length) return false;
      events.sort((left, right) => left.at - right.at || left.componentId - right.componentId);
      this.gestureBatchPlayCount += 1;
      this.lastGestureBatchOffsets = events.slice(0, 32).map((event) => Number((event.at - events[0].at).toFixed(6)));
      return this.play(events, events[0].at, 1, { preserveGestureTiming: true });
    }

    play(events, logicalNow, litCount = 1, options = {}) {
      if (!this.enabled || this.context?.state !== "running") {
        if (this.intentOn && this.context?.state !== "closed") {
          let queued = false;
          for (const event of events) {
            if (event.kind !== "gesture-note" || event.repeat !== 0) continue;
            if (this.pendingGestureEvents.length >= this.gestureVoiceLimit) this.pendingGestureEvents.shift();
            this.pendingGestureEvents.push(event);
            queued = true;
          }
          if (queued) {
            this.pendingGestureLogicalNow = Math.min(...this.pendingGestureEvents.map((event) => event.at));
            this.pendingGesturePreserveTiming ||= options.preserveGestureTiming === true;
          }
        }
        return false;
      }
      const base = this.context.currentTime;
      const densityScale = Math.min(1, Math.sqrt(16 / Math.max(16, litCount)));
      const preserveGestureBatch = options.preserveGestureTiming === true;
      const eventTimes = preserveGestureBatch
        ? []
        : events.map((event) => Number.isFinite(Number(event.at)) ? Number(event.at) : Number(logicalNow) || 0);
      const earliestEventAt = eventTimes.length ? Math.min(...eventTimes) : 0;
      const latestEventAt = eventTimes.length ? Math.max(...eventTimes) : earliestEventAt;
      const eventSpan = Math.max(0, latestEventAt - earliestEventAt);
      const catchupScale = eventSpan > AUDIO_SAFETY.catchupWindowSeconds
        ? AUDIO_SAFETY.catchupWindowSeconds / eventSpan
        : 1;
      this.lastCatchupScheduleOffsets = [];
      for (const event of events) {
        const mixedEvent = { ...event, gainScale: event.gainScale * densityScale };
        const preserveGestureTiming = preserveGestureBatch && event.kind === "gesture-note" && event.repeat === 0;
        const eventAt = Number.isFinite(Number(event.at)) ? Number(event.at) : Number(logicalNow) || 0;
        const catchupOffset = clamp((eventAt - earliestEventAt) * catchupScale, 0, AUDIO_SAFETY.catchupWindowSeconds);
        const when = preserveGestureTiming
          ? base + 0.012 + clamp(eventAt - logicalNow, 0, 0.5)
          : base + AUDIO_SAFETY.catchupLeadSeconds + catchupOffset;
        if (!preserveGestureTiming) this.lastCatchupScheduleOffsets.push(Number(catchupOffset.toFixed(6)));
        this.scheduledEventCount += 1;
        if (event.kind === "gesture-note") {
          const decay = 0.46 + (event.phraseLayer % 3) * 0.08;
          if (!this.admitGestureVoice(when, decay + 0.04)) continue;
          const wave = event.phraseLayer % 3 === 1 ? "triangle" : "sine";
          this.tone(mixedEvent, when, { wave, gain: 0.078, attack: 0.007, decay });
          continue;
        }
        if (event.kind === "motif-note") {
          const duration = clamp(Number(event.duration) || 0.32, 0.1, 0.76);
          this.playMotifNote(mixedEvent, when, {
            wave: /jazz|ragtime/.test(event.motifFamily || "") ? "triangle" : "sine",
            gain: 0.086,
            attack: 0.009,
            decay: duration,
          });
          continue;
        }
        if (event.activationMode === "melodyWave"
          && !this.admitMechanismVoice(when, this.mechanismEventDuration(event.kind), this.mechanismSourceCount(event.kind))) continue;
        if (event.kind === "felt-mallet") {
          this.noise(mixedEvent, when, { frequency: 520, q: 0.55, gain: 0.07, decay: 0.12 });
          this.tone(mixedEvent, when + 0.008, { wave: "sine", gain: 0.035, attack: 0.008, decay: 0.2 });
        } else if (event.kind === "rotor-tine") {
          this.tone(mixedEvent, when, { wave: "sine", gain: 0.055, attack: 0.006, decay: 0.62 });
        } else if (event.kind === "pendulum-center") {
          this.noise(mixedEvent, when, { frequency: 980, q: 0.9, gain: 0.045, decay: 0.09 });
          this.tone(mixedEvent, when + 0.004, { wave: "sine", gain: 0.045, attack: 0.01, decay: 0.72 });
        } else if (event.kind.startsWith("glider-")) {
          const metal = event.kind.endsWith("metal") || event.kind.endsWith("ceramic");
          this.gliderContactEvents += 1;
          this.noise(mixedEvent, when, { frequency: metal ? 1900 : 680, q: metal ? 1.15 : 0.5, gain: 0.082, decay: 0.16 });
        } else if (event.kind === "beacon-chord") {
          this.tone(mixedEvent, when, { wave: "sine", gain: 0.05, attack: 0.03, decay: 1.9 });
          this.tone(mixedEvent, when + 0.01, { wave: "triangle", gain: 0.012, attack: 0.05, decay: 1.2, scale: 2 });
        } else if (event.kind === "ribbon-tap") {
          this.tone(mixedEvent, when, { wave: "sine", gain: 0.034, attack: 0.012, decay: 0.34 });
        } else {
          this.noise(mixedEvent, when, { frequency: 1180, q: 0.7, gain: 0.026, decay: 0.16 });
        }
      }
      return true;
    }

    /** 页面隐藏 / 离开：立即停掉所有连续声源并挂起 AudioContext，保证没有任何声音残留。 */
    async sleep() {
      if (!this.context) return;
      this.stopAllFriction();
      this.stopAllOneShots();
      if (this.master) {
        const now = this.context.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setTargetAtTime(0.0001, now, 0.02);
      }
      this.enabled = false;
      this.pendingGestureEvents.length = 0;
      this.pendingGesturePreserveTiming = false;
      return this.queueLifecycleTransition(false);
    }

    async wake() {
      if (!this.context || !this.intentOn) return false;
      return this.queueLifecycleTransition(true);
    }

    async close() {
      if (!this.context) return;
      const context = this.context;
      this.lifecycleRevision += 1;
      this.stopAllFriction();
      this.stopAllOneShots();
      this.enabled = false;
      const closing = this.lifecycleQueue.catch(() => false).then(async () => {
        try {
          if (context.state !== "closed") await context.close();
        } catch (_) { /* Already closed. */ }
        this.gestureVoiceEnds.length = 0;
        this.motifPerformanceVoices.clear();
        this.rejectedMotifPerformanceIds.clear();
        this.mechanismVoiceEnds.length = 0;
        if (context.state === "closed") this.releaseContextReferences(context);
        else if (context.state === "running") {
          try { await context.suspend(); } catch (_) { /* Keep the muted reference so close can be retried. */ }
        }
        return false;
      });
      this.lifecycleQueue = closing.catch(() => false);
      return this.lifecycleQueue;
    }

    diagnostics() {
      if (this.context) {
        compactFutureTimes(this.gestureVoiceEnds, this.context.currentTime);
        this.compactMotifPerformanceVoices(this.context.currentTime);
        compactFutureTimes(this.mechanismVoiceEnds, this.context.currentTime);
      }
      return {
        intentOn: this.intentOn,
        initialized: Boolean(this.context),
        contextState: this.context?.state || "unavailable",
        enabled: this.enabled,
        scheduledEventCount: this.scheduledEventCount,
        gliderContactEvents: this.gliderContactEvents,
        gliderFrictionStarts: this.gliderFrictionStarts,
        activeFrictionVoices: this.frictionVoices.size,
        frictionVoiceLimit: this.frictionVoiceLimit,
        frictionVoicesDropped: this.frictionVoicesDropped,
        activeGestureVoices: this.gestureVoiceEnds.length,
        pendingGestureEvents: this.pendingGestureEvents.length,
        gestureBatchPlayCount: this.gestureBatchPlayCount,
        lastGestureBatchOffsets: [...this.lastGestureBatchOffsets],
        gestureVoiceLimit: this.gestureVoiceLimit,
        gestureVoicesAccepted: this.gestureVoicesAccepted,
        gestureVoicesDropped: this.gestureVoicesDropped,
        maxGestureVoicesObserved: this.maxGestureVoicesObserved,
        activeMotifVoices: this.motifPerformanceVoices.size,
        motifVoiceLimit: this.motifVoiceLimit,
        motifVoicesAccepted: this.motifVoicesAccepted,
        motifVoicesDropped: this.motifVoicesDropped,
        motifNotesAccepted: this.motifNotesAccepted,
        motifNotesDropped: this.motifNotesDropped,
        motifAcceptedExpectedNotes: this.motifAcceptedExpectedNotes,
        motifRejectedExpectedNotes: this.motifRejectedExpectedNotes,
        maxMotifVoicesObserved: this.maxMotifVoicesObserved,
        activeMechanismVoices: this.mechanismVoiceEnds.length,
        trackedOneShotSources: this.oneShotSources.size,
        mechanismVoiceLimit: this.mechanismVoiceLimit,
        mechanismVoicesAccepted: this.mechanismVoicesAccepted,
        mechanismVoicesDropped: this.mechanismVoicesDropped,
        maxMechanismVoicesObserved: this.maxMechanismVoicesObserved,
        noiseVoicesScheduled: this.noiseVoicesScheduled,
        lastNoiseAttackSeconds: this.lastNoiseAttackSeconds,
        outputLimiterReady: Boolean(this.limiter),
        outputSoftLimiterReady: Boolean(this.softLimiter),
        captureStreamReady: Boolean(this.captureDestination?.stream),
        lastCatchupScheduleOffsets: [...this.lastCatchupScheduleOffsets],
        outputSafety: { ...AUDIO_SAFETY },
      };
    }
  }

  function curvePoint(component, amount) {
    const t = clamp(amount);
    const [p0, p1, p2, p3] = component.variant.curve.points;
    const inverse = 1 - t;
    return {
      x: inverse ** 3 * p0.x + 3 * inverse ** 2 * t * p1.x + 3 * inverse * t ** 2 * p2.x + t ** 3 * p3.x,
      y: inverse ** 3 * p0.y + 3 * inverse ** 2 * t * p1.y + 3 * inverse * t ** 2 * p2.y + t ** 3 * p3.y,
    };
  }

  function paintGrid(context, world) {
    context.fillStyle = COLORS.background;
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.strokeStyle = COLORS.gridStrong;
    context.lineWidth = 4;
    context.strokeRect(FRAME.x, FRAME.y, FRAME.width, FRAME.height);
    context.strokeStyle = COLORS.grid;
    context.lineWidth = 3;
    context.beginPath();
    for (const segment of world.segments) {
      context.moveTo(segment.x1, segment.y1);
      context.lineTo(segment.x2, segment.y2);
    }
    context.stroke();

    const response = world.responseField;
    if (response) {
      context.strokeStyle = COLORS.dark;
      context.fillStyle = COLORS.dark;
      context.globalAlpha = 0.11;
      context.lineWidth = 1.15;
      context.beginPath();
      for (let index = 0; index < response.count; index += 1) {
        const half = response.size[index] * 0.52;
        context.moveTo(response.x[index] - response.axisX[index] * half, response.y[index] - response.axisY[index] * half);
        context.lineTo(response.x[index] + response.axisX[index] * half, response.y[index] + response.axisY[index] * half);
      }
      context.stroke();
      context.globalAlpha = 0.14;
      context.beginPath();
      for (let index = 0; index < response.count; index += 1) {
        const headX = response.x[index] + response.axisX[index] * response.size[index] * 0.52;
        const headY = response.y[index] + response.axisY[index] * response.size[index] * 0.52;
        context.moveTo(headX + 1.2, headY);
        context.arc(headX, headY, 1.2, 0, TAU);
      }
      context.fill();
      context.globalAlpha = 1;
    }
  }

  /** 墙图与背景是静态的：真实浏览器里画进离屏画布缓存一次，每帧只 drawImage。无 DOM 的宿主（测试 / 离线导出）退回逐帧绘制。 */
  // 有完整世界 back buffer 时直接重画轻量墙线，避免再常驻一张 1080×1920 静态缓存（约 8 MiB）。
  let gridCache = worldSurface ? undefined : null;
  function drawGrid(world) {
    if (gridCache === undefined) { paintGrid(draw, world); return; }
    if (gridCache === null) {
      const canDrawImage = typeof document.createElement === "function" && typeof draw.drawImage === "function";
      if (!canDrawImage) { gridCache = undefined; paintGrid(draw, world); return; }
      const offscreen = document.createElement("canvas");
      offscreen.width = WIDTH;
      offscreen.height = HEIGHT;
      const context = offscreen.getContext("2d", { alpha: false });
      if (!context) { gridCache = undefined; paintGrid(draw, world); return; }
      paintGrid(context, world);
      gridCache = offscreen;
    }
    draw.drawImage(gridCache, 0, 0);
  }

  /**
   * 发光不用 shadowBlur（Canvas 里最贵的操作，iOS 上尤其重）：
   * 亮着的机关先用粗线、低透明度画一遍"光晕层"，再正常画一遍。glowPad 让圆点在光晕层里同步放大。
   */
  let glowPad = 0;
  function dot(x, y, radius) {
    draw.beginPath(); draw.arc(x, y, radius + glowPad, 0, TAU); draw.fill();
  }

  function styleFor(component, state, pass = "body") {
    const active = state.phase !== "darkFrozen";
    const envelope = active ? state.visualEnvelope ?? 1 : 0;
    if (pass === "dark") {
      draw.strokeStyle = COLORS.dark;
      draw.fillStyle = COLORS.dark;
      draw.globalAlpha = 0.32;
      draw.lineWidth = 2.1;
      glowPad = 0;
      return;
    }
    draw.strokeStyle = TYPE_COLORS[component.type];
    draw.fillStyle = TYPE_COLORS[component.type];
    if (pass === "glow") {
      draw.globalAlpha = envelope * (0.08 + state.pose.energy * 0.12);
      draw.lineWidth = 8 + state.pose.energy * 6;
      glowPad = envelope * (3 + state.pose.energy * 3);
      return;
    }
    glowPad = 0;
    draw.globalAlpha = envelope * (0.82 + state.pose.energy * 0.18);
    draw.lineWidth = lerp(2.1, 3.4, envelope);
  }

  function drawPendulum(component, state) {
    const { anchor, length } = component.variant;
    const angle = state.pose.value;
    const tangentX = -anchor.inwardY;
    const tangentY = anchor.inwardX;
    const directionX = anchor.inwardX * Math.cos(angle) + tangentX * Math.sin(angle);
    const directionY = anchor.inwardY * Math.cos(angle) + tangentY * Math.sin(angle);
    const x = anchor.x + directionX * length;
    const y = anchor.y + directionY * length;
    draw.beginPath(); draw.moveTo(anchor.x, anchor.y); draw.lineTo(x, y); draw.stroke();
    dot(anchor.x, anchor.y, 3.2);
    dot(x, y, 9.5);
  }

  function drawGlider(component, state) {
    const { size, route } = component.variant;
    const { x, y } = pointAlongRoute(route, state.pose.value);
    draw.fillRect(x - size / 2 - glowPad, y - size / 2 - glowPad, size + glowPad * 2, size + glowPad * 2);
  }

  function drawRotor(component, state) {
    const { centerX: x, centerY: y, variant } = component;
    const angle = state.pose.value * TAU;
    draw.beginPath(); draw.arc(x, y, variant.radius, 0, TAU); draw.stroke();
    if (variant.ring === "double") { draw.beginPath(); draw.arc(x, y, variant.radius - 6, 0, TAU); draw.stroke(); }
    for (const spoke of variant.spokes) {
      const spokeAngle = angle + spoke.onset * TAU;
      draw.beginPath(); draw.moveTo(x, y); draw.lineTo(x + Math.cos(spokeAngle) * variant.radius * spoke.length, y + Math.sin(spokeAngle) * variant.radius * spoke.length); draw.stroke();
    }
    dot(x, y, 7.5);
  }

  function drawMallet(component, state) {
    const { variant } = component;
    for (let index = 0; index < variant.count; index += 1) {
      const punch = state.pose.heads?.[index] || 0;
      const anchor = variant.anchors[index];
      const reach = lerp(18, variant.travel, punch);
      const headX = anchor.x + anchor.inwardX * reach;
      const headY = anchor.y + anchor.inwardY * reach;
      draw.beginPath(); draw.moveTo(anchor.x, anchor.y); draw.lineTo(headX, headY); draw.stroke();
      dot(anchor.x, anchor.y, 2.8);
      dot(headX, headY, 7.5);
    }
  }

  function drawRibbon(component, state) {
    draw.beginPath();
    for (let index = 0; index <= 32; index += 1) {
      const point = curvePoint(component, index / 32);
      if (index === 0) draw.moveTo(point.x, point.y); else draw.lineTo(point.x, point.y);
    }
    draw.stroke();
    const point = curvePoint(component, state.pose.value);
    dot(point.x, point.y, 7.5);
  }

  function drawComponentShape(component, state) {
    if (component.type === "pendulum") drawPendulum(component, state);
    else if (component.type === "glider") drawGlider(component, state);
    else if (component.type === "rotor") drawRotor(component, state);
    else if (component.type === "mallet") drawMallet(component, state);
    else drawRibbon(component, state);
  }

  function drawComponent(component, state) {
    draw.save();
    // 灰色机关始终是底层；类型色只按 envelope 叠加，启动和结束都不会发生一次硬切变色。
    styleFor(component, state, "dark");
    drawComponentShape(component, state);
    if (state.phase !== "darkFrozen") {
      styleFor(component, state, "glow");
      drawComponentShape(component, state);
      styleFor(component, state, "body");
      drawComponentShape(component, state);
    }
    draw.restore();
  }

  function drawInteractionOverlay(interaction, now) {
    if (!interaction) return;
    const snapshot = interaction.snapshot(now);
    draw.save();
    draw.lineWidth = 3;
    for (const active of snapshot.active) {
      const component = world.components[active.componentId];
      const radius = Math.min(component.cell.w, component.cell.h) * 0.39;
      draw.strokeStyle = TYPE_COLORS[component.type];
      draw.globalAlpha = 0.88;
      draw.beginPath();
      draw.arc(component.centerX, component.centerY, radius, -Math.PI / 2, -Math.PI / 2 + TAU * active.progress);
      draw.stroke();
    }
    draw.textAlign = "center";
    draw.textBaseline = "middle";
    draw.font = "700 20px ui-rounded, system-ui, sans-serif";
    snapshot.queue.slice(0, 6).forEach((queued) => {
      const component = world.components[queued.componentId];
      draw.fillStyle = COLORS.halo;
      draw.globalAlpha = 0.82;
      draw.beginPath();
      draw.arc(component.cell.x + component.cell.w - 18, component.cell.y + 18, 13, 0, TAU);
      draw.fill();
      draw.fillStyle = COLORS.background;
      draw.globalAlpha = 1;
      draw.fillText(String(queued.position), component.cell.x + component.cell.w - 18, component.cell.y + 19);
    });
    draw.restore();
  }

  function render(world, manager, now, interaction = null) {
    if (denseDetailsMode !== "off") {
      draw.fillStyle = COLORS.background;
      draw.fillRect(0, 0, WIDTH, HEIGHT);
      for (let quadrantY = 0; quadrantY < 2; quadrantY += 1) {
        for (let quadrantX = 0; quadrantX < 2; quadrantX += 1) {
          const quadrantX0 = FRAME.x + quadrantX * FRAME.width / 2;
          const quadrantY0 = FRAME.y + quadrantY * FRAME.height / 2;
          draw.save();
          draw.beginPath();
          draw.rect(quadrantX0, quadrantY0, FRAME.width / 2, FRAME.height / 2);
          draw.clip();
          draw.translate(quadrantX0, quadrantY0);
          draw.scale(0.5, 0.5);
          draw.translate(-FRAME.x, -FRAME.y);
          paintGrid(draw, denseGridWorld);
          for (const component of world.components) drawComponent(component, manager.stateFor(component, now));
          draw.restore();
        }
      }
      // denseDetails 只复制绘制，不复制9×16交互语义；旧 interactive 的进度/队列仍按真实命中坐标显示。
      drawInteractionOverlay(interaction, now);
      return;
    }
    drawGrid(world);
    for (const component of world.components) {
      const state = manager.stateFor(component, now);
      drawComponent(component, state);
    }
    drawInteractionOverlay(interaction, now);
  }

  function presentWorld() {
    if (worldSurface) displayDraw.drawImage(worldSurface, 0, 0);
  }

  function ensureWaveTexture(conductor) {
    if (waveTextureSurface?.width === conductor.config.waveCols && waveTextureSurface?.height === conductor.config.waveRows && waveTextureImage?.data) return true;
    if (typeof document.createElement !== "function") return false;
    const surface = document.createElement("canvas");
    surface.width = conductor.config.waveCols;
    surface.height = conductor.config.waveRows;
    const context = surface.getContext("2d", { alpha: true });
    if (!context || typeof context.createImageData !== "function" || typeof context.putImageData !== "function") return false;
    const image = context.createImageData(surface.width, surface.height);
    if (!image?.data) return false;
    waveTextureSurface = surface;
    waveTextureDraw = context;
    waveTextureImage = image;
    return true;
  }

  function drawWaveResponseReeds(context, conductor, field) {
    const response = conductor.responseField;
    if (!response) return;
    const buckets = conductor.prepareResponseReeds(field);
    context.globalCompositeOperation = "screen";
    for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex += 1) {
      const bucket = buckets[bucketIndex];
      if (!bucket.length) continue;
      const amount = (bucketIndex % 5 + 1) / 5;
      const negative = bucketIndex >= 5;
      context.strokeStyle = negative ? "#aebbe3" : COLORS.halo;
      context.globalAlpha = 0.035 + amount * 0.07;
      context.lineWidth = 3 + amount * 2.5;
      context.beginPath();
      for (let item = 0; item < bucket.length; item += 1) {
        const index = bucket[item];
        const half = response.size[index] * 0.56;
        const signed = field[conductor.responseWaveIndex[index]];
        const bend = signed * (6 + response.size[index] * 0.75);
        const baseX = response.x[index] - response.axisX[index] * half;
        const baseY = response.y[index] - response.axisY[index] * half;
        const headX = response.x[index] + response.axisX[index] * half - response.axisY[index] * bend;
        const headY = response.y[index] + response.axisY[index] * half + response.axisX[index] * bend;
        context.moveTo(baseX, baseY);
        context.lineTo(headX, headY);
      }
      context.stroke();
      context.globalAlpha = 0.18 + amount * 0.28;
      context.lineWidth = 1 + amount * 0.55;
      // stroke() 不清空当前 path；同一批簧片直接复用几何画 body，避免每帧第二遍 moveTo/lineTo。
      context.stroke();
    }
    context.globalCompositeOperation = "source-over";
  }

  function drawWaveComponentImpacts(context, activationManager, components, now) {
    if (!activationManager) return;
    for (const activation of activationManager.active.values()) {
      if (activation.mode !== "melodyWave" || !Number.isFinite(activation.melodyContactX)) continue;
      const age = now - activation.startedAt;
      const duration = 0.52;
      if (age < 0 || age >= duration) continue;
      const progress = smoothstep(age / duration);
      const life = 1 - smoothstep(age / duration);
      const component = components[activation.componentId];
      const radius = lerp(7, Math.min(component.cell.w, component.cell.h) * 0.34, progress);
      const energy = clamp(Number(activation.melodyTriggerEnergy) || 0.5, 0.25, 1);
      context.strokeStyle = TYPE_COLORS[component.type];
      const copyCount = denseDetailsMode === "off" ? 1 : 4;
      for (let copy = 0; copy < copyCount; copy += 1) {
        const scale = copyCount === 1 ? 1 : 0.5;
        const copyX = copyCount === 1
          ? activation.melodyContactX
          : FRAME.x + (copy % 2) * FRAME.width / 2 + (activation.melodyContactX - FRAME.x) * 0.5;
        const copyY = copyCount === 1
          ? activation.melodyContactY
          : FRAME.y + Math.floor(copy / 2) * FRAME.height / 2 + (activation.melodyContactY - FRAME.y) * 0.5;
        context.beginPath();
        context.arc(copyX, copyY, radius * scale, 0, TAU);
        context.globalCompositeOperation = "screen";
        context.globalAlpha = life * (0.18 + energy * 0.32);
        context.lineWidth = (1.5 + life * 4.5) * scale;
        context.stroke();
        // 白色强波峰上仍保留一条类型色内环，不让碰撞点被 screen 合成洗白。
        context.globalCompositeOperation = "source-over";
        context.globalAlpha = life * (0.14 + energy * 0.18);
        context.lineWidth = 1.25 * scale;
        context.stroke();
      }
    }
    context.globalCompositeOperation = "source-over";
  }

  function drawMelodyOverlay(context, conductor, activationManager, now, clearLayer = true) {
    if (!context || !conductor) return;
    conductor.prune(now);
    if (clearLayer) context.clearRect(0, 0, WIDTH, HEIGHT);
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";

    // 直接跟手轨迹：独立透明层每个 rAF 更新，不要求 144 个详细机关同步重画。
    let expiredTrailCount = 0;
    while (expiredTrailCount < trail.length && now - trail[expiredTrailCount].t > conductor.config.trailSeconds) expiredTrailCount += 1;
    if (expiredTrailCount) trail.splice(0, expiredTrailCount);
    const trailAgeBuckets = 6;
    const trailBuckets = conductor.trailRenderBuckets;
    for (const bucket of trailBuckets) bucket.length = 0;
    for (let index = 1; index < trail.length; index += 1) {
      const from = trail[index - 1];
      const to = trail[index];
      if (from.gestureId !== to.gestureId || to.t - from.t > 0.25) continue;
      const age = clamp((now - to.t) / conductor.config.trailSeconds);
      const alpha = (1 - age) * 0.72;
      if (alpha < 0.015) continue;
      const ageBucket = clamp(Math.floor(age * trailAgeBuckets), 0, trailAgeBuckets - 1);
      trailBuckets[(to.layer % PHRASE_COLORS.length) * trailAgeBuckets + ageBucket].push(from.x, from.y, to.x, to.y);
    }
    for (let layer = 0; layer < PHRASE_COLORS.length; layer += 1) {
      context.strokeStyle = PHRASE_COLORS[layer];
      for (let ageBucket = 0; ageBucket < trailAgeBuckets; ageBucket += 1) {
        const segments = trailBuckets[layer * trailAgeBuckets + ageBucket];
        if (!segments.length) continue;
        const age = (ageBucket + 0.5) / trailAgeBuckets;
        const alpha = (1 - age) * 0.72;
        context.beginPath();
        for (let index = 0; index < segments.length; index += 4) {
          context.moveTo(segments[index], segments[index + 1]);
          context.lineTo(segments[index + 2], segments[index + 3]);
        }
        context.globalAlpha = alpha * 0.2; context.lineWidth = lerp(36, 8, age); context.stroke();
        context.globalAlpha = alpha; context.lineWidth = lerp(11, 2.6, age); context.stroke();
      }
    }

    // 单点点击和光迹最前端也必须有即时反馈；不能等到跨过第二个格子才看见线段。
    const trailHead = trail.at(-1);
    if (trailHead && now - trailHead.t >= -0.08 && now - trailHead.t < 0.24) {
      const headLife = 1 - clamp((now - trailHead.t) / 0.24);
      const color = PHRASE_COLORS[trailHead.layer % PHRASE_COLORS.length];
      context.fillStyle = color;
      context.globalAlpha = headLife * 0.1;
      context.beginPath(); context.arc(trailHead.x, trailHead.y, 28 + headLife * 8, 0, TAU); context.fill();
      context.globalAlpha = headLife * 0.34;
      context.beginPath(); context.arc(trailHead.x, trailHead.y, 10 + headLife * 4, 0, TAU); context.fill();
      context.globalAlpha = headLife * 0.92;
      context.beginPath(); context.arc(trailHead.x, trailHead.y, 2.8 + headLife * 1.8, 0, TAU); context.fill();
    }

    // 划线波源只保留短暂的圆形源环；向外传播完全交给下方 36×64 绕墙场。
    // 不再把每段轨迹沿法线复制成平行长线，避免涟漪画面被直线光束切碎。
    for (const wave of conductor.waves) {
      const age = now - wave.at;
      if (age < 0) continue;
      const segmentLength = Math.hypot(wave.x - wave.fromX, wave.y - wave.fromY);
      context.strokeStyle = wave.color;
      const ringLifeSeconds = segmentLength > 2 ? 0.72 : Math.min(3.4, conductor.config.waveLife * 0.48);
      if (age > ringLifeSeconds) continue;
      const life = waveLifeGain(age, ringLifeSeconds);
      context.globalAlpha = life * wave.amplitude * (segmentLength > 2 ? WAVE_VISUALS.segmentRingAlpha : WAVE_VISUALS.pointRingAlpha);
      context.lineWidth = 2.2 + life * 3.2;
      context.beginPath();
      context.arc(wave.x, wave.y, Math.max(1, age * conductor.config.waveSpeed), 0, TAU);
      context.stroke();
    }

    // 36×64 场写入一张常驻微型纹理，再以一次平滑 drawImage 放大。
    // 这取代每帧数千条 Canvas path；高能局部极值才补成少量清晰微光点。
    // wakeComponents 通常已按固定 60 Hz 采过同一张场；显示复用 16.7 ms 内的最近样本。
    // 若调用顺序被改动或页面恢复后样本已陈旧，则只在这里补采一次，避免静默绘制旧场。
    const field = conductor.fieldForDisplay(now);
    if (ensureWaveTexture(conductor)) {
      const pixels = waveTextureImage.data;
      for (let index = 0; index < field.length; index += 1) {
        const signed = field[index];
        const energy = Math.abs(signed);
        const pixel = index * 4;
        const positive = signed >= 0;
        pixels[pixel] = positive ? 216 : 145;
        pixels[pixel + 1] = positive ? 239 : 191;
        pixels[pixel + 2] = positive ? 232 : 232;
        pixels[pixel + 3] = waveTextureAlpha(energy);
      }
      waveTextureDraw.putImageData(waveTextureImage, 0, 0);
      context.globalCompositeOperation = "screen";
      context.globalAlpha = WAVE_VISUALS.textureLayerAlpha;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "medium";
      context.drawImage(waveTextureSurface, FRAME.x, FRAME.y, FRAME.width, FRAME.height);
      context.globalCompositeOperation = "source-over";
    }
    if (denseDetailsMode !== "details") drawWaveResponseReeds(context, conductor, field);
    const buckets = conductor.prepareWaveAccents(field);
    const spacing = Math.min(FRAME.width / conductor.config.waveCols, FRAME.height / conductor.config.waveRows);
    context.fillStyle = COLORS.halo;
    for (let bucket = 0; bucket < buckets.length; bucket += 1) {
      if (!buckets[bucket].length) continue;
      const amount = (bucket + 1) / buckets.length;
      context.globalAlpha = WAVE_VISUALS.accentBaseAlpha + amount * WAVE_VISUALS.accentEnergyAlpha;
      context.beginPath();
      const radius = 0.65 + spacing * (0.01 + amount * 0.03);
      for (let sample = 0; sample < buckets[bucket].length; sample += 1) {
        const index = buckets[bucket][sample];
        context.moveTo(conductor.waveX[index] + radius, conductor.waveY[index]);
        context.arc(conductor.waveX[index], conductor.waveY[index], radius, 0, TAU);
      }
      context.fill();
    }
    // 波到达的同一接触点只产生一次柔和冲击环；随后机关自行完成完整周期，不追着振幅闪烁。
    drawWaveComponentImpacts(context, activationManager, conductor.components, now);
    context.restore();

    if (hintLabel && hintUntil > 0) {
      const remaining = hintUntil - now;
      hintLabel.style.opacity = String(clamp(remaining / 1.2));
      if (remaining <= 0) { hintUntil = 0; hintLabel.hidden = true; }
    }
  }

  function hitTestCanvasPoint(x, y) {
    if (x < FRAME.x || x >= FRAME.x + FRAME.width || y < FRAME.y || y >= FRAME.y + FRAME.height) return null;
    const col = Math.floor((x - FRAME.x) / CELL_W);
    const row = Math.floor((y - FRAME.y) / CELL_H);
    const id = row * COLS + col;
    return world.components[id] || null;
  }

  const seed = querySeed();
  const performance = queryPerformance();
  const denseDetailsMode = queryDenseDetails();
  const rippleConfig = resolveRippleConfig(window.location.search, window.KINETIC_MAZE_CONFIG?.ripple);
  const melodyConfig = resolveMelodyConfig(window.location.search, window.KINETIC_MAZE_CONFIG?.melody);
  const motifSettings = resolveMotifSettings(window.location.search, window.KINETIC_MAZE_CONFIG?.melody);
  const world = buildWorld(seed, motifSettings, melodyConfig.motifCount);
  const denseGridWorld = denseDetailsMode === "details-plus-reeds"
    ? world
    : Object.freeze({ ...world, responseField: null });
  const audio = new AudioEngine(querySoundIntent(), {
    gestureVoiceLimit: melodyConfig.voiceLimit,
    motifVoiceLimit: melodyConfig.motifVoiceLimit,
    mechanismVoiceLimit: melodyConfig.mechanismVoiceLimit,
    frictionVoiceLimit: melodyConfig.frictionVoiceLimit,
  });
  const litRange = Object.freeze({ min: rippleConfig.litMin, max: rippleConfig.litMax });
  let manager = null;
  let growth = null;
  let ripple = null;
  let melody = null;
  let interaction = null;
  const requestedMode = performance.isExport ? "growth" : queryMode();
  const isBeacon = requestedMode === "beacon";
  const isMelody = requestedMode === "melody";
  let mode = requestedMode === "ripple" || isBeacon || isMelody ? "idle" : requestedMode;
  let logicalTime = 0;
  let previousTimestamp = null;
  let lastEventTime = 0;
  // melody / ripple 的 Start 是真正的交互门；旧 growth / interactive 模式仍按原约定自动运行。
  let playing = mode !== "idle";
  let frameRequest = null;
  const trail = [];
  const seedMarks = [];
  let pointerTracking = null;
  let hoverTracking = null;
  let hoverGestureSequence = 0;
  const HOVER_GAP_SECONDS = 0.22;
  const HOVER_WAVE_INTERVAL = 0.1;
  let pointerCanvasRect = null;
  let hintUntil = 0;
  let lastRenderAt = -Infinity;
  let lastMelodyOverlayAt = -Infinity;
  let nextMelodyOverlayAt = 0;
  let lastStatusAt = -Infinity;
  let renderDirty = true;
  let gesture = null;
  let melodyStroke = null;
  let gestureSequence = 0;
  let clusterPulseUntil = 0;
  let reachedMarks = [];
  let reachedSeen = 0;
  let hintText = null;

  function updateModeControl() {
    canvas.classList.toggle("is-interactive", mode === "interactive" || mode === "ripple" || mode === "melody");
  }

  function updateSoundControl() {
    const state = audio.diagnostics();
    if (statusLabel && !state.enabled && state.intentOn && state.contextState === "suspended" && mode !== "idle") statusLabel.textContent = "点一下画面开启声音";
  }

  function installGrowthRuntime() {
    manager = new ActivationManager(world.components);
    growth = new PopulationConductor(seed, world.components, manager, { exportMode: performance.isExport });
    ripple = null;
    melody = null;
    interaction = null;
    mode = "growth";
    logicalTime = 0;
    lastEventTime = 0;
    previousTimestamp = null;
    growth.advanceTo(0);
    updateModeControl();
  }

  function installInteractionRuntime() {
    manager = new ActivationManager(world.components);
    growth = null;
    ripple = null;
    melody = null;
    interaction = new InteractionController(manager, world.components, 6);
    mode = "interactive";
    logicalTime = 0;
    lastEventTime = 0;
    previousTimestamp = null;
    updateModeControl();
  }

  function installRippleRuntime() {
    manager = new ActivationManager(world.components);
    growth = null;
    melody = null;
    interaction = null;
    ripple = isBeacon ? new BeaconConductor(seed, world.components, manager, rippleConfig) : new RippleConductor(seed, world.components, manager, rippleConfig);
    mode = "ripple";
    logicalTime = 0;
    lastEventTime = 0;
    previousTimestamp = null;
    trail.length = 0;
    seedMarks.length = 0;
    reachedMarks = [];
    reachedSeen = 0;
    gesture = null;
    ripple.fireEmber(0);
    hintUntil = isBeacon ? 12 : rippleConfig.hintSeconds;
    if (isBeacon) setHint("把光引到灯塔 · 只能从亮着的地方划出去", 12);
    else if (hintLabel) hintLabel.textContent = "划过画面，点亮一批机关";
    updateModeControl();
  }

  function installMelodyRuntime() {
    manager = new ActivationManager(world.components);
    growth = null;
    ripple = null;
    interaction = null;
    melody = new MelodyConductor(seed, world.components, melodyConfig, world.wallGraph, world.responseField, motifSettings);
    mode = "melody";
    logicalTime = 0;
    lastEventTime = 0;
    previousTimestamp = null;
    lastRenderAt = -Infinity;
    lastMelodyOverlayAt = -Infinity;
    nextMelodyOverlayAt = 0;
    trail.length = 0;
    seedMarks.length = 0;
    pointerTracking = null;
    hoverTracking = null;
    melodyStroke = null;
    hintUntil = 7;
    if (hintLabel) hintLabel.textContent = "鼠标移动即可生波；按住划一笔，会按你的节奏循环并慢慢淡去";
    updateModeControl();
  }

  function scheduleMelodyDistancePrewarm(conductor) {
    if (!conductor || typeof document.createElement !== "function") return;
    const run = (deadline = null) => {
      if (melody !== conductor || mode !== "melody") return;
      const available = typeof deadline?.timeRemaining === "function" ? deadline.timeRemaining() : 0;
      const batch = available >= 4 ? 3 : available >= 2 ? 2 : 1;
      const result = conductor.prewarmComponentSources(batch);
      if (result.complete) return;
      if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 500 });
      else if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(run, 50);
    };
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 350 });
    else if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(run, 120);
  }

  function installIdleRuntime() {
    manager = new ActivationManager(world.components);
    growth = null;
    ripple = null;
    melody = null;
    interaction = null;
    mode = "idle";
    logicalTime = 0;
    lastEventTime = 0;
    previousTimestamp = null;
    playing = false;
    updateModeControl();
  }

  function frame(timestamp) {
    frameRequest = null;
    if (!playing || mode === "idle") return;
    if (previousTimestamp === null) previousTimestamp = timestamp;
    const delta = Math.min(0.1, Math.max(0, (timestamp - previousTimestamp) / 1000));
    previousTimestamp = timestamp;
    logicalTime += delta;
    let events = [];
    let finished = [];
    if (mode === "growth") {
      const advanced = advanceGrowthInterval(manager, growth, lastEventTime, logicalTime);
      events = advanced.events;
      finished = advanced.finished;
    } else if (mode === "ripple") {
      const advanced = advanceRippleInterval(manager, ripple, lastEventTime, logicalTime);
      events = advanced.events;
      finished = advanced.finished;
    } else if (mode === "melody") {
      // replay 先补进波数组，但不能按当前帧提前 prune；60 Hz 历史波前采完后再删过期波。
      const phraseEvents = melody.eventsBetween(lastEventTime, logicalTime, false);
      const componentEvents = manager.eventsBetween(lastEventTime, logicalTime);
      finished = manager.update(logicalTime);
      const started = melody.wakeComponents(manager, logicalTime);
      melody.prune(logicalTime);
      const newlyStartedEvents = manager.eventsForActivationsBetween(melody.startedActivations, lastEventTime, logicalTime);
      const newlyStartedMotifEvents = melody.motifEventsForPerformancesBetween(
        melody.startedMotifPerformances, lastEventTime, logicalTime,
      );
      if (started > 0) renderDirty = true;
      if (melody.startedMotifPerformances.length) {
        const performances = melody.startedMotifPerformances;
        const latest = performances.at(-1);
        const latestComponent = world.components[latest.componentId];
        if (performances.length === 1) {
          setHint(`${TYPE_LABELS[latestComponent.type]}奏响自己的短句 · ${latest.title}`, 4.5);
        } else {
          const titles = [...new Set(performances.map((performance) => performance.title))];
          const titleSummary = titles.slice(0, 2).join(" / ") + (titles.length > 2 ? " …" : "");
          setHint(`${performances.length} 个能力组件各自奏响 · ${titleSummary}`, 4.5);
        }
      }
      phraseEvents.push(...componentEvents, ...newlyStartedEvents, ...newlyStartedMotifEvents);
      events = phraseEvents.sort((left, right) => left.at - right.at || left.componentId - right.componentId);
    } else {
      events = manager.eventsBetween(lastEventTime, logicalTime);
      finished = manager.update(logicalTime);
    }
    audio.play(events, logicalTime, manager.litCountAt(logicalTime));
    lastEventTime = logicalTime;
    if (isBeacon && ripple) {
      while (reachedSeen < ripple.reached.length) {
        const entry = ripple.reached[reachedSeen++];
        const component = world.components[entry.componentId];
        reachedMarks.push({ x: component.centerX, y: component.centerY, t: entry.at });
        setHint(`接到了 · 今晚第 ${entry.lantern} 盏`, 3);
        renderDirty = true;
      }
    }
    if (mode === "interactive") interaction.handleFinished(finished);
    const snapshot = manager.snapshot(logicalTime);
    audio.syncFriction(snapshot.active, world.components, logicalTime, snapshot.litCount);
    // 重绘限频：默认 30 fps。逻辑/声音每个 rAF 都推进，只是画面隔帧刷新，机关运动周期长（2–7 s），肉眼无差别。
    const renderInterval = 1 / rippleConfig.renderFps;
    const renderIntervalElapsed = logicalTime - lastRenderAt >= renderInterval - 1e-4;
    // melody 的机关层严格封顶 30 fps；新机关启动只标记下一次 30 Hz 世界帧，
    // 跟手轨迹与 36×64 波纹理仍在独立 60 Hz overlay 上即时更新。
    const worldRendered = mode === "melody"
      ? renderIntervalElapsed
      : mode === "ripple"
        ? renderDirty || renderIntervalElapsed
        : true;
    if (worldRendered) {
      render(world, manager, logicalTime, interaction);
      if (mode === "ripple") drawRippleOverlay(logicalTime);
      lastRenderAt = logicalTime;
      renderDirty = false;
    }
    if (mode === "melody") {
      const overlayDue = logicalTime + 1 / 240 >= nextMelodyOverlayAt - 1e-9;
      if (worldSurface) {
        if (overlayDue) {
          presentWorld();
          drawMelodyOverlay(displayDraw, melody, manager, logicalTime, false);
          lastMelodyOverlayAt = logicalTime;
          do { nextMelodyOverlayAt += 1 / 60; } while (nextMelodyOverlayAt <= logicalTime + 1e-9);
        }
      } else if (worldRendered) drawMelodyOverlay(displayDraw, melody, manager, logicalTime, false);
    } else if (worldRendered) presentWorld();
    const melodyAnimating = mode === "melody" ? melody.isAnimating(logicalTime) || snapshot.litCount > 0 : false;
    if (logicalTime - lastStatusAt >= 0.25 - 1e-4 || mode === "melody" && !melodyAnimating) {
      if (mode === "growth") {
        statusLabel.textContent = `${Math.floor(logicalTime)}s · ${snapshot.litCount}/${MAX_LIT} 已亮 · 全部正在演奏`;
      } else if (mode === "ripple") {
        const rippleSnapshot = ripple.snapshot(logicalTime);
        statusLabel.textContent = isBeacon
          ? `${Math.floor(logicalTime)}s · ${snapshot.litCount} 已亮 · 目标 ${Math.round(rippleSnapshot.target)} · 灯塔 ${rippleSnapshot.beaconId ?? "—"} (${rippleSnapshot.beaconHops} 跳) · 气 ${rippleSnapshot.breath.toFixed(1)} · 第 ${rippleSnapshot.lanterns} 盏`
          : `${Math.floor(logicalTime)}s · ${snapshot.litCount} 已亮 · 目标 ${Math.round(rippleSnapshot.target)} · 区间 ${litRange.min}–${litRange.max}`;
      } else if (mode === "interactive") {
        const interactionSnapshot = interaction.snapshot(logicalTime);
        statusLabel.textContent = `${interactionSnapshot.active.length} 正在完整演奏 · ${interactionSnapshot.queue.length} 排队`;
      } else if (mode === "melody") {
        const melodySnapshot = melody.snapshot(logicalTime);
        statusLabel.textContent = `${melodySnapshot.activePhraseCount} 个乐句 · ${melodySnapshot.activeWaveCount}/${melodyConfig.maxWaves} 道波 · ${snapshot.litCount} 个机关在演奏`;
      }
      lastStatusAt = logicalTime;
    }
    if (mode === "melody" && !melodyStroke && !pointerTracking && !melodyAnimating && trail.length === 0 && logicalTime >= hintUntil) {
      previousTimestamp = null;
      return;
    }
    frameRequest = requestAnimationFrame(frame);
  }

  function setHint(text, seconds = 4) {
    hintText = text;
    hintUntil = logicalTime + seconds;
    if (hintLabel) { hintLabel.textContent = text; hintLabel.hidden = false; hintLabel.style.opacity = "1"; }
  }

  function drawBeaconOverlay(now) {
    const snapshot = ripple.snapshot(now);
    draw.save();
    draw.lineCap = "round";
    // 灯塔：暗暗脉动的双环
    if (snapshot.beaconId !== null) {
      const beacon = world.components[snapshot.beaconId];
      const pulse = 0.5 + 0.5 * Math.sin((now - (snapshot.beaconChosenAt || 0)) * TAU / 2.4);
      const radius = Math.min(CELL_W, CELL_H) * 0.34;
      draw.strokeStyle = COLORS.halo;
      draw.globalAlpha = 0.22 + pulse * 0.3;
      draw.lineWidth = 2.5;
      draw.beginPath(); draw.arc(beacon.centerX, beacon.centerY, radius + pulse * 6, 0, TAU); draw.stroke();
      draw.globalAlpha = 0.1 + pulse * 0.12;
      draw.lineWidth = 10;
      draw.beginPath(); draw.arc(beacon.centerX, beacon.centerY, radius + 10 + pulse * 8, 0, TAU); draw.stroke();
      draw.globalAlpha = 0.55 + pulse * 0.35;
      draw.fillStyle = COLORS.halo;
      draw.beginPath(); draw.arc(beacon.centerX, beacon.centerY, 4, 0, TAU); draw.fill();
    }
    // 接到灯塔：扩散环
    reachedMarks = reachedMarks.filter((mark) => now - mark.t < 1.6);
    for (const mark of reachedMarks) {
      const age = clamp((now - mark.t) / 1.6);
      const eased = smoothstep(age);
      draw.strokeStyle = COLORS.halo;
      draw.globalAlpha = (1 - eased) * 0.8;
      draw.lineWidth = lerp(6, 1.5, eased);
      draw.beginPath(); draw.arc(mark.x, mark.y, lerp(12, Math.min(CELL_W, CELL_H) * 1.6, eased), 0, TAU); draw.stroke();
    }
    // 无效划动反馈：亮着的光团脉动一下，提示"从这里划"
    if (now < clusterPulseUntil) {
      const amount = clamp((clusterPulseUntil - now) / 1.2);
      draw.strokeStyle = COLORS.halo;
      draw.globalAlpha = amount * 0.5;
      draw.lineWidth = 2;
      for (const activeId of manager.active.keys()) {
        const component = world.components[activeId];
        draw.beginPath(); draw.arc(component.centerX, component.centerY, Math.min(CELL_W, CELL_H) * (0.3 + (1 - amount) * 0.2), 0, TAU); draw.stroke();
      }
    }
    // 顶部：一口气（左）与 今晚第 N 盏（右）
    draw.globalAlpha = 1;
    draw.textBaseline = "middle";
    const y = FRAME.y - 56;
    for (let index = 0; index < snapshot.breathMax; index += 1) {
      const fill = clamp(snapshot.breath - index);
      const x = FRAME.x + 18 + index * 34;
      draw.strokeStyle = COLORS.halo;
      draw.globalAlpha = 0.35;
      draw.lineWidth = 2;
      draw.beginPath(); draw.arc(x, y, 9, 0, TAU); draw.stroke();
      if (fill > 0) {
        draw.fillStyle = COLORS.halo;
        draw.globalAlpha = 0.3 + fill * 0.6;
        draw.beginPath(); draw.arc(x, y, 3 + fill * 4.5, 0, TAU); draw.fill();
      }
    }
    draw.fillStyle = COLORS.halo;
    draw.globalAlpha = 0.7;
    draw.textAlign = "right";
    draw.font = "600 26px ui-rounded, system-ui, sans-serif";
    draw.fillText(snapshot.lanterns > 0 ? `今晚第 ${snapshot.lanterns} 盏` : "把光引到灯塔", FRAME.x + FRAME.width - 12, y);
    draw.restore();
  }

  function drawRippleOverlay(now) {
    const trailSeconds = rippleConfig.trailSeconds;
    const seedMarkSeconds = rippleConfig.seedMarkSeconds;
    while (trail.length && now - trail[0].t > trailSeconds) trail.shift();
    while (seedMarks.length && now - seedMarks[0].t > seedMarkSeconds) seedMarks.shift();
    draw.save();
    draw.lineCap = "round";
    draw.lineJoin = "round";
    for (let index = 1; index < trail.length; index += 1) {
      const from = trail[index - 1];
      const to = trail[index];
      if (to.t - from.t > 0.25) continue;
      const age = clamp((now - to.t) / trailSeconds);
      const alpha = (1 - age) * (to.dim ? 0.22 : 0.55);
      if (alpha <= 0.01) continue;
      draw.strokeStyle = COLORS.halo;
      draw.beginPath();
      draw.moveTo(from.x, from.y);
      draw.lineTo(to.x, to.y);
      draw.globalAlpha = alpha * 0.28;
      draw.lineWidth = lerp(34, 8, age);
      draw.stroke();
      draw.globalAlpha = alpha;
      draw.lineWidth = lerp(12, 3, age);
      draw.stroke();
    }
    for (const mark of seedMarks) {
      const age = clamp((now - mark.t) / seedMarkSeconds);
      const eased = smoothstep(age);
      draw.strokeStyle = mark.color;
      draw.globalAlpha = (1 - eased) * 0.9;
      draw.lineWidth = lerp(4, 1.5, eased);
      draw.beginPath();
      draw.arc(mark.x, mark.y, lerp(10, Math.min(CELL_W, CELL_H) * 0.62, eased), 0, TAU);
      draw.stroke();
    }
    if (hintLabel && hintUntil > 0) {
      const remaining = hintUntil - now;
      hintLabel.style.opacity = String(clamp(remaining / 1.2));
      if (remaining <= 0) { hintUntil = 0; hintLabel.hidden = true; }
    }
    draw.restore();
    if (isBeacon) drawBeaconOverlay(now);
  }

  function canvasPointFromEvent(event) {
    const rect = pointerCanvasRect || canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * WIDTH / rect.width, y: (event.clientY - rect.top) * HEIGHT / rect.height };
  }

  /** 返回线段穿过格子的顺序和在线段中的比例；melody 用比例插值真实穿格时刻。 */
  function cellHitsAlongSegment(from, to, stepScale = rippleConfig.sweepStep) {
    const hits = [];
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / (Math.min(CELL_W, CELL_H) * stepScale)));
    let previous = null;
    for (let step = 0; step <= steps; step += 1) {
      const amount = step / steps;
      const component = hitTestCanvasPoint(lerp(from.x, to.x, amount), lerp(from.y, to.y, amount));
      if (!component || component.id === previous) continue;
      previous = component.id;
      hits.push({ id: component.id, amount });
    }
    return hits;
  }

  /** 沿指针轨迹采样命中的格子（按经过顺序去重），快速划过也不会漏格。 */
  function cellsAlongSegment(from, to) {
    return [...new Set(cellHitsAlongSegment(from, to).map((hit) => hit.id))];
  }

  function recordMelodySegment(conductor, stroke, from, to, onVisualHit = null) {
    const events = [];
    const elapsed = Math.max(1e-4, to.t - from.t);
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const speed = distance / elapsed;
    const waveSpacing = Math.min(FRAME.width / conductor.config.waveCols, FRAME.height / conductor.config.waveRows) * 0.55;
    // 合并 coalesced pointer move 或页面卡顿时，一个事件可能跨过整屏；仍保留首尾线源，
    // 但把同步 Dijkstra 冷启动限制在 12 个采样源内，避免单次 input handler 卡十几毫秒。
    const waveSteps = Math.min(11, conductor.config.maxWaves - 1, Math.max(1, Math.ceil(distance / waveSpacing)));
    for (let step = 0; step <= waveSteps; step += 1) {
      const amount = step / waveSteps;
      conductor.recordWavePoint(
        stroke,
        lerp(from.x, to.x, amount),
        lerp(from.y, to.y, amount),
        lerp(from.t, to.t, amount),
        { pressure: lerp(from.pressure ?? 0.5, to.pressure ?? 0.5, amount), speed },
      );
    }
    for (const hit of cellHitsAlongSegment(from, to, 0.22)) {
      const at = lerp(from.t, to.t, hit.amount);
      const previousVisualHitCount = stroke.visualHitCount;
      const event = conductor.recordHit(stroke, hit.id, at, { pressure: lerp(from.pressure ?? 0.5, to.pressure ?? 0.5, hit.amount), speed });
      if (stroke.visualHitCount > previousVisualHitCount && onVisualHit) onVisualHit(hit.id, at);
      if (event) events.push(event);
    }
    return events;
  }

  function pushMelodyTrail(point, at, gestureId, layer) {
    trail.push({ x: point.x, y: point.y, t: at, gestureId, layer });
    if (trail.length > 240) trail.shift();
  }

  function melodyTimeForEvent(event) {
    const timestamp = Number(event.timeStamp);
    if (!melodyStroke || !Number.isFinite(timestamp) || !Number.isFinite(melodyStroke.sourceTimestamp)) return logicalTime;
    return melodyStroke.startedAt + Math.max(0, (timestamp - melodyStroke.sourceTimestamp) / 1000);
  }

  function melodySweep(point, event, pointerId = event.pointerId, playImmediately = true) {
    if (!melodyStroke) return [];
    const at = Math.max(pointerTracking?.last?.t ?? melodyStroke.startedAt, melodyTimeForEvent(event));
    const sample = { ...point, t: at, pressure: Number(event.pressure) || 0.5 };
    const from = pointerTracking?.last ?? sample;
    pushMelodyTrail(point, at, melodyStroke.id, melodyStroke.layer);
    // 笔迹只记录旋律并播种波；详细机关统一等波前到达后启动，保证视觉因果一致。
    const liveEvents = recordMelodySegment(melody, melodyStroke, from, sample);
    if (playImmediately && liveEvents.length) audio.playGestureBatch(liveEvents);
    pointerTracking = { last: sample, pointerId };
    if (frameRequest === null && playing) {
      previousTimestamp = null;
      frameRequest = requestAnimationFrame(frame);
    }
    return liveEvents;
  }

  function melodyHover(point, event, emitWave = true) {
    const sourceTimestamp = Number(event.timeStamp);
    const validTimestamp = Number.isFinite(sourceTimestamp) ? sourceTimestamp : 0;
    const gap = hoverTracking && validTimestamp && hoverTracking.sourceTimestamp
      ? (validTimestamp - hoverTracking.sourceTimestamp) / 1000
      : Infinity;
    if (!hoverTracking || gap > HOVER_GAP_SECONDS) {
      const id = 1000000 + ++hoverGestureSequence;
      const layer = (id - 1) % PHRASE_COLORS.length;
      hoverTracking = {
        id,
        layer,
        sourceTimestamp: validTimestamp,
        last: null,
        waveLast: null,
        lastWaveSourceTimestamp: -Infinity,
        waveGesture: {
          id,
          layer,
          wavePoints: [],
          lastWaveSourceIndex: null,
          lastWaveX: null,
          lastWaveY: null,
        },
      };
    }
    const projectedAt = previousTimestamp !== null && validTimestamp
      ? logicalTime + clamp((validTimestamp - previousTimestamp) / 1000, 0, 0.06)
      : logicalTime;
    const at = Math.max(hoverTracking.last?.t ?? logicalTime, projectedAt);
    const sample = { ...point, t: at, pressure: 0.38 };
    if (!hoverTracking.last || Math.hypot(point.x - hoverTracking.last.x, point.y - hoverTracking.last.y) >= 1.2) {
      pushMelodyTrail(point, at, hoverTracking.id, hoverTracking.layer);
      hoverTracking.last = sample;
    }
    if (!hoverTracking.waveLast) hoverTracking.waveLast = sample;
    if (emitWave) {
      const from = hoverTracking.waveLast;
      const distance = Math.hypot(sample.x - from.x, sample.y - from.y);
      const waveSpacing = Math.min(FRAME.width / melody.config.waveCols, FRAME.height / melody.config.waveRows);
      const sourceGap = validTimestamp && Number.isFinite(hoverTracking.lastWaveSourceTimestamp)
        ? (validTimestamp - hoverTracking.lastWaveSourceTimestamp) / 1000
        : Infinity;
      if (distance >= waveSpacing * 0.42 && sourceGap >= HOVER_WAVE_INTERVAL) {
        const elapsed = Math.max(1e-4, sample.t - from.t);
        const gesture = hoverTracking.waveGesture;
        if (gesture.lastWaveSourceIndex === null) {
          gesture.lastWaveSourceIndex = melody.waveIndexAt(from.x, from.y);
          gesture.lastWaveX = from.x;
          gesture.lastWaveY = from.y;
        }
        const wave = melody.recordWavePoint(gesture, sample.x, sample.y, sample.t, {
          pressure: sample.pressure,
          speed: distance / elapsed,
        });
        if (wave) {
          // hover 不回放成乐句；这里只保留有界传播场，波源历史不需要在 gesture 上累积。
          gesture.wavePoints.length = 0;
          hoverTracking.waveLast = sample;
          hoverTracking.lastWaveSourceTimestamp = validTimestamp;
        }
      }
    }
    hoverTracking.sourceTimestamp = validTimestamp;
    if (frameRequest === null && playing) {
      previousTimestamp = null;
      frameRequest = requestAnimationFrame(frame);
    }
  }

  function sweep(point, event) {
    const from = pointerTracking?.last ?? point;
    const ids = cellsAlongSegment(from, point);
    trail.push({ x: point.x, y: point.y, t: logicalTime, dim: isBeacon && gesture ? !gesture.seeds?.length : false });
    if (trail.length > 240) trail.shift();
    pointerTracking = { last: point, pointerId: event.pointerId };
    let started;
    if (isBeacon) {
      if (!gesture) gesture = { id: ++gestureSequence, startedAt: logicalTime };
      const result = ripple.stroke(ids, logicalTime, gesture);
      started = result.planted;
      if (result.rejected === "notFromLight" && !gesture.warned) {
        gesture.warned = true;
        clusterPulseUntil = logicalTime + 1.2;
        setHint("从亮着的地方划出去", 3);
      } else if (result.rejected === "noBreath" && !gesture.warned) {
        gesture.warned = true;
        setHint("先等一口气回来", 3);
      }
      renderDirty = true;
      if (!started.length) return;
    } else {
      const fresh = ids.filter((id) => !manager.active.has(id));
      if (!fresh.length) return;
      started = ripple.seedMany(fresh, logicalTime);
      renderDirty = true;
    }
    for (const activation of started) {
      const component = world.components[activation.componentId];
      seedMarks.push({ x: component.centerX, y: component.centerY, t: logicalTime, color: TYPE_COLORS[component.type] });
    }
    if (seedMarks.length > 96) seedMarks.splice(0, seedMarks.length - 96);
  }

  function pointerIsSweeping(event) {
    if (event.pointerType === "mouse") return isBeacon || mode === "melody" ? event.buttons > 0 : true;
    return event.buttons > 0 || event.pressure > 0 || event.type === "pointerdown";
  }

  async function startExperience() {
    const installing = mode === "idle";
    const retryingSound = !installing && audio.intentOn && !audio.enabled;
    if (!installing && !retryingSound) return audio.enabled;
    // 在任何 DOM / runtime 工作之前同步触发 resume，保住 iOS 与 WebView 的用户手势授权。
    const enablePromise = audio.intentOn ? audio.ensureEnabled() : Promise.resolve(false);
    if (installing) {
      playing = true;
      if (isMelody) {
        installMelodyRuntime();
        scheduleMelodyDistancePrewarm(melody);
      } else installRippleRuntime();
      renderDirty = true;
      if (frameRequest === null && playing) frameRequest = requestAnimationFrame(frame);
    }
    let enabled = false;
    try {
      enabled = await enablePromise;
    } catch (error) {
      console.error(error);
    }
    if (audio.intentOn && !enabled) {
      if (chrome) chrome.hidden = false;
      if (startControl) startControl.textContent = "▶ 再试一次";
      if (chromeHint) chromeHint.textContent = "声音还没开启 · 再点一次重试";
      updateSoundControl();
      return false;
    }
    if (chrome) chrome.hidden = true;
    if (hintLabel) { hintLabel.hidden = false; hintLabel.style.opacity = "1"; }
    updateSoundControl();
    lastEventTime = logicalTime;
    return enabled || !audio.intentOn;
  }

  if (startControl) startControl.addEventListener("click", () => { startExperience(); });

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (mode === "idle") return;
    pointerCanvasRect = canvas.getBoundingClientRect();
    if (!audio.enabled && audio.intentOn) {
      audio.ensureEnabled().then(() => { updateSoundControl(); lastEventTime = logicalTime; }).catch((error) => console.error(error));
    }
    if (mode === "ripple") {
      pointerTracking = null;
      gesture = isBeacon ? { id: ++gestureSequence, startedAt: logicalTime } : null;
      sweep(canvasPointFromEvent(event), event);
      return;
    }
    if (mode === "melody") {
      if (melodyStroke && melodyStroke.pointerId !== event.pointerId) return;
      pointerTracking = null;
      hoverTracking = null;
      const timestamp = Number.isFinite(Number(event.timeStamp)) ? Number(event.timeStamp) : 0;
      melodyStroke = melody.beginGesture(logicalTime, timestamp, event.pointerId);
      if (typeof canvas.setPointerCapture === "function") {
        try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* Unsupported pointer capture in older WebViews. */ }
      }
      melodySweep(canvasPointFromEvent(event), event);
      return;
    }
    if (mode !== "interactive") return;
    const point = canvasPointFromEvent(event);
    const component = hitTestCanvasPoint(point.x, point.y);
    if (!component) return;
    const result = interaction.request(component.id, logicalTime);
    if (result.status === "alreadyPlaying") statusLabel.textContent = "这个机关正在完成本轮，结束后可再次点击";
    else if (result.status === "queued") statusLabel.textContent = `${TYPE_LABELS[component.type]} 已排在第 ${result.queuePosition} 位`;
    else statusLabel.textContent = `${TYPE_LABELS[component.type]} 开始完整演奏`;
  });

  canvas.addEventListener("pointermove", (event) => {
    if (mode === "melody" && event.pointerType === "mouse" && event.buttons === 0 && !melodyStroke) {
      pointerCanvasRect ||= canvas.getBoundingClientRect();
      const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
      const hoverSamples = samples.length ? samples : [event];
      for (let index = 0; index < hoverSamples.length; index += 1) {
        const sample = hoverSamples[index];
        // 光迹保留全部 coalesced 采样，但每个外层 PointerEvent 最多生成一张冷距离场。
        melodyHover(canvasPointFromEvent(sample), sample, index === hoverSamples.length - 1);
      }
      return;
    }
    const activeMelodyPointer = mode === "melody" && melodyStroke?.pointerId === event.pointerId;
    if ((mode !== "ripple" && mode !== "melody") || (!activeMelodyPointer && !pointerIsSweeping(event))) return;
    event.preventDefault();
    if (pointerTracking && pointerTracking.pointerId !== event.pointerId) return;
    const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const liveGestureBatch = [];
    for (const sample of samples.length ? samples : [event]) {
      if (mode === "melody") liveGestureBatch.push(...melodySweep(canvasPointFromEvent(sample), sample, event.pointerId, false));
      else sweep(canvasPointFromEvent(sample), event);
    }
    if (liveGestureBatch.length) audio.playGestureBatch(liveGestureBatch);
  });

  const endSweep = (event) => {
    if (mode === "melody") {
      if (!melodyStroke || melodyStroke.pointerId !== event.pointerId) {
        if (event.type === "pointerleave") {
          hoverTracking = null;
          pointerCanvasRect = null;
        }
        return;
      }
      if (event.type !== "pointerleave") melodySweep(canvasPointFromEvent(event), event, event.pointerId);
      const endedAt = Math.max(pointerTracking?.last?.t ?? logicalTime, melodyTimeForEvent(event));
      melody.finishGesture(melodyStroke, endedAt);
      melodyStroke = null;
      pointerTracking = null;
      pointerCanvasRect = null;
      if (typeof canvas.releasePointerCapture === "function") {
        try { canvas.releasePointerCapture(event.pointerId); } catch (_) { /* Capture may already be released. */ }
      }
      return;
    }
    if (pointerTracking && pointerTracking.pointerId === event.pointerId) pointerTracking = null;
    if (event.pointerType === "mouse") pointerTracking = null;
    if (event.type !== "pointerleave" || event.pointerType === "mouse") gesture = null;
    pointerCanvasRect = null;
  };
  canvas.addEventListener("pointerup", endSweep);
  canvas.addEventListener("pointercancel", endSweep);
  canvas.addEventListener("pointerleave", endSweep);
  if (typeof window.addEventListener === "function") {
    const invalidatePointerGeometry = () => {
      pointerCanvasRect = null;
      hoverTracking = null;
    };
    window.addEventListener("resize", invalidatePointerGeometry, { passive: true });
    // The website embeds this canvas above an information panel, so the page can scroll while
    // desktop hover input remains active. getBoundingClientRect() is viewport-relative: keeping
    // the cached rect across a scroll would offset every subsequent trail and wave by that scroll.
    // Capture also covers a future nested scrolling host without forcing layout on every move.
    window.addEventListener("scroll", invalidatePointerGeometry, { passive: true, capture: true });
  }

  function previewOneShot(componentId, stepSeconds = 1 / 60) {
    const preview = new ActivationManager(world.components);
    const activation = preview.start(componentId, 0, "oneShot");
    if (!activation) return null;
    const samples = [];
    const events = [];
    let previous = 0;
    for (let time = 0; time <= activation.completeAt + stepSeconds; time += stepSeconds) {
      const state = preview.stateFor(world.components[componentId], time);
      samples.push({ time: Number(time.toFixed(6)), phase: state.phase, value: Number(state.pose.value.toFixed(6)) });
      events.push(...preview.eventsBetween(previous, time));
      preview.update(time);
      previous = time;
    }
    return {
      activation,
      samples,
      events,
      finalState: preview.stateFor(world.components[componentId], activation.completeAt + stepSeconds).phase,
      completedCount: preview.completed.length,
    };
  }

  function auditDarkFreeze() {
    const audit = new ActivationManager(world.components);
    const times = [0, 0.1, 1, 3, 10];
    return {
      componentCount: world.components.length,
      allFrozen: world.components.every((component) => {
        const signatures = times.map((time) => JSON.stringify(audit.stateFor(component, time).pose));
        return new Set(signatures).size === 1 && audit.stateFor(component, 10).phase === "darkFrozen";
      }),
      eventCount: audit.eventsBetween(0, 10).length,
      activeCount: audit.snapshot(10).active.length,
    };
  }

  function auditTickLoads(events) {
    const loads = new Map();
    for (const event of events) {
      const tick = Math.floor(event.at / TICK_SECONDS + 1e-8);
      const addition = eventLoad(event);
      const load = loads.get(tick) || { total: 0, pitched: 0, impact: 0 };
      load.total += addition.total;
      load.pitched += addition.pitched;
      load.impact += addition.impact;
      loads.set(tick, load);
    }
    const values = [...loads.values()];
    return {
      tickCount: values.length,
      maxTotal: Math.max(0, ...values.map((load) => load.total)),
      maxPitched: Math.max(0, ...values.map((load) => load.pitched)),
      maxImpact: Math.max(0, ...values.map((load) => load.impact)),
      averageTotal: values.length ? values.reduce((sum, load) => sum + load.total, 0) / values.length : 0,
    };
  }

  function previewGrowth(previewSeed = seed, seconds = 122, stepSeconds = 1 / 60) {
    const previewWorld = buildWorld(previewSeed);
    const previewManager = new ActivationManager(previewWorld.components);
    const previewConductor = new PopulationConductor(previewSeed, previewWorld.components, previewManager);
    previewConductor.advanceTo(0);
    const events = [];
    const target = Math.max(0, seconds);
    const step = Math.max(1 / 240, stepSeconds);
    let previous = 0;
    for (let time = 0; time <= target + 1e-9; time += step) {
      const now = Math.min(target, time);
      events.push(...advanceGrowthInterval(previewManager, previewConductor, previous, now).events);
      previous = now;
      if (now >= target) break;
    }
    const normalizedEvents = events.map((event) => ({
      at: Number(event.at.toFixed(6)),
      componentId: event.componentId,
      activationId: event.activationId,
      type: event.type,
      kind: event.kind,
      layer: event.layer,
      pitch: event.pitch,
    }));
    return {
      seed: previewSeed,
      seconds: target,
      plan: previewConductor.planSnapshot(),
      snapshot: previewManager.snapshot(target),
      events: normalizedEvents,
      activations: previewManager.allActivations.map((activation) => ({
        id: activation.id,
        componentId: activation.componentId,
        cycleIndex: activation.cycleIndex,
        cycleCount: activation.cycleCount,
        startedAt: Number(activation.startedAt.toFixed(6)),
        completeAt: Number(activation.completeAt.toFixed(6)),
      })),
      tickLoads: auditTickLoads(normalizedEvents),
      targetCount: previewConductor.targetCount,
      replacementCount: previewConductor.replacementCount,
    };
  }

  function previewPerformance(previewSeed = seed, seconds = 180, stepSeconds = 1 / 60) {
    const previewWorld = buildWorld(previewSeed);
    const previewManager = new ActivationManager(previewWorld.components);
    const previewConductor = new PopulationConductor(previewSeed, previewWorld.components, previewManager, { exportMode: true });
    previewConductor.advanceTo(0);
    const target = clamp(seconds, 0, 180);
    const step = Math.max(1 / 240, stepSeconds);
    const events = [];
    const litTimeline = [];
    let previous = 0;
    let nextSampleAt = 0;
    for (let guard = 0; guard < 100000 && previous <= target + 1e-9; guard += 1) {
      const now = previous === 0 && nextSampleAt === 0 ? 0 : Math.min(target, previous + step, nextSampleAt);
      events.push(...advanceGrowthInterval(previewManager, previewConductor, previous, now).events);
      if (Math.abs(now - nextSampleAt) < 1e-8 && nextSampleAt <= target + 1e-9) {
        litTimeline.push({ at: Number(nextSampleAt.toFixed(2)), count: previewManager.snapshot(nextSampleAt).litCount });
        nextSampleAt += 0.25;
      }
      previous = now;
      if (now >= target) break;
    }
    const normalizedEvents = events.map((event) => ({
      at: Number(event.at.toFixed(6)),
      componentId: event.componentId,
      activationId: event.activationId,
      type: event.type,
      kind: event.kind,
      layer: event.layer,
      pitch: event.pitch,
      accent: event.accent,
      gainScale: event.gainScale,
      sourceU: event.sourceU,
      isImpact: Boolean(event.isImpact),
    }));
    const activations = previewManager.allActivations.map((activation) => ({
      id: activation.id,
      componentId: activation.componentId,
      type: previewWorld.components[activation.componentId].type,
      material: previewWorld.components[activation.componentId].variant.material || null,
      sourceU: (previewWorld.components[activation.componentId].centerX - FRAME.x) / FRAME.width,
      cycleIndex: activation.cycleIndex,
      cycleCount: activation.cycleCount,
      basePeriod: activation.basePeriod,
      startedAt: Number(activation.startedAt.toFixed(6)),
      completeAt: Number(activation.completeAt.toFixed(6)),
    }));
    return {
      seed: previewSeed,
      seconds: target,
      plan: previewConductor.planSnapshot(),
      snapshot: previewManager.snapshot(target),
      components: previewWorld.components.map((component) => ({
        id: component.id,
        type: component.type,
        pitch: component.pitch,
        material: component.variant.material || null,
        sourceU: (component.centerX - FRAME.x) / FRAME.width,
        basePeriod: basePeriod(component),
      })),
      events: normalizedEvents,
      activations,
      retirements: previewConductor.retirements.map((retirement) => ({ ...retirement })),
      litTimeline,
      tickLoads: auditTickLoads(normalizedEvents),
      targetCount: previewConductor.targetCount,
      replacementCount: previewConductor.replacementCount,
    };
  }

  function auditPerformance(previewSeed = seed, stepSeconds = 1 / 60) {
    const preview = previewPerformance(previewSeed, 180, stepSeconds);
    const countAt = (time) => preview.litTimeline.find((sample) => Math.abs(sample.at - time) < 1e-9)?.count ?? null;
    const finale = preview.litTimeline.filter((sample) => sample.at >= 168 && sample.at <= 178);
    const afterPrep = preview.activations.filter((activation) => activation.startedAt >= 140 - 1e-9);
    const retireBuckets = new Set(preview.retirements.map((retirement) => Math.floor((retirement.at - 168) * 2)));
    return {
      milestoneCounts: [0, 4, 9, 16, 25, 36, 49, 63, 78, 94, 108, 118, 128].map((at) => ({ at, count: countAt(at) })),
      peakBeforeFinale: countAt(167.75),
      finaleStartCount: countAt(168),
      finaleEndCount: countAt(178),
      finalCount: countAt(180),
      finaleMonotonic: finale.every((sample, index) => index === 0 || sample.count <= finale[index - 1].count),
      retirementCount: preview.retirements.length,
      retirementBucketCount: retireBuckets.size,
      retirementRange: preview.retirements.length ? [Math.min(...preview.retirements.map((item) => item.at)), Math.max(...preview.retirements.map((item) => item.at))] : [],
      allRetireOnCompleteCycle: preview.retirements.every((retirement) => {
        const activation = preview.activations.find((item) => item.id === retirement.activationId);
        return activation && Math.abs((activation.completeAt - activation.startedAt) / activation.basePeriod - Math.round((activation.completeAt - activation.startedAt) / activation.basePeriod)) < 1e-5;
      }),
      allAfterPrepSingleCycle: afterPrep.every((activation) => activation.cycleCount === 1),
      noActivationPastRetireEnd: preview.activations.every((activation) => activation.startedAt >= 178 - 1e-9 || activation.completeAt <= 178 + 1e-6),
      lastEventAt: Math.max(0, ...preview.events.map((event) => event.at)),
      activationCount: preview.activations.length,
      eventCount: preview.events.length,
      plan: preview.plan,
      retirements: preview.retirements,
    };
  }

  function auditGrowth(previewSeed = seed) {
    const preview = previewGrowth(previewSeed, 122, 1 / 60);
    const milestones = [0, 2, 5, 9, 14, 20, 27, 35, 44, 54, 65, 77, 90];
    const milestoneCounts = milestones.map((at) => ({
      at,
      count: preview.plan.filter((entry) => entry.at <= at + 1e-9).length,
    }));
    const finalIds = new Set(preview.snapshot.litComponentIds);
    const coverage = new Map([...finalIds].map((componentId) => [componentId, 0]));
    preview.events.filter((event) => event.at >= 90 && event.at <= 122).forEach((event) => {
      if (coverage.has(event.componentId)) coverage.set(event.componentId, coverage.get(event.componentId) + 1);
    });
    const pendulumCrossings = buildWorld(previewSeed).components.filter((component) => component.type === "pendulum").map((component) => ({
      componentId: component.id,
      physicalCrossingsPerCycle: 2,
      soundTriggersPerCycle: eventBlueprints(component).filter((event) => event.kind === "pendulum-center").length,
      firstTwoCycleOffsets: eventBlueprints(component, 2).map((event) => Number(event.offset.toFixed(6))),
    }));
    return {
      milestoneCounts,
      finalLitCount: preview.snapshot.litCount,
      selectedComponentCount: preview.plan.length,
      selectedTypeCounts: preview.plan.reduce((counts, entry) => {
        counts[entry.type] = (counts[entry.type] || 0) + 1;
        return counts;
      }, {}),
      allOneTwentyEightSoundInFinalWindow: [...coverage.values()].every((count) => count > 0),
      missingSoundComponentIds: [...coverage].filter(([, count]) => count === 0).map(([componentId]) => componentId),
      missingSoundFirstStarts: [...coverage].filter(([, count]) => count === 0).map(([componentId]) => {
        const last = preview.activations.filter((activation) => activation.componentId === componentId).at(-1);
        return { componentId, startedAt: last?.startedAt ?? null, completeAt: last?.completeAt ?? null };
      }),
      latestDebutStartedAt: Math.max(...preview.activations.filter((activation) => activation.cycleIndex === 0).map((activation) => activation.startedAt)),
      minimumEventsPerLitComponent: Math.min(...coverage.values()),
      maximumEventsPerLitComponent: Math.max(...coverage.values()),
      tickLoads: preview.tickLoads,
      pendulumCrossings,
      allPendulumCrossingsSound: pendulumCrossings.every((item) => item.physicalCrossingsPerCycle === item.soundTriggersPerCycle && item.firstTwoCycleOffsets.length === 4),
      thirdPendulumCrossingAlwaysSound: pendulumCrossings.every((item) => item.firstTwoCycleOffsets.length >= 3),
      cycleCounts: [...new Set(preview.activations.map((activation) => activation.cycleCount))].sort(),
      targetCount: preview.targetCount,
      replacementCount: preview.replacementCount,
    };
  }

  function pointOnEdge(point, edge) {
    if (!edge) return false;
    if (edge.orientation === "horizontal") return Math.abs(point.y - edge.y1) < 1e-6 && point.x >= edge.x1 - 1e-6 && point.x <= edge.x2 + 1e-6;
    return Math.abs(point.x - edge.x1) < 1e-6 && point.y >= edge.y1 - 1e-6 && point.y <= edge.y2 + 1e-6;
  }

  function auditGeometry(previewSeed = seed) {
    const auditWorld = buildWorld(previewSeed);
    const graph = auditWorld.wallGraph;
    const gliders = auditWorld.components.filter((component) => component.type === "glider");
    const mallets = auditWorld.components.filter((component) => component.type === "mallet");
    const ribbons = auditWorld.components.filter((component) => component.type === "ribbon");
    const pendulums = auditWorld.components.filter((component) => component.type === "pendulum");
    return {
      componentCount: auditWorld.components.length,
      allGliderEdgesReal: gliders.every((component) => component.variant.route.edgeKeys.every((key) => graph.edgeKeys.has(key))),
      allGliderRoutesContinuous: gliders.every((component) => component.variant.route.points.every((point, index, points) => index === 0 || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > 1e-7)),
      multiEdgeGliderRatio: gliders.filter((component) => component.variant.route.edgeKeys.length >= 2).length / gliders.length,
      gliderRouteLengths: gliders.map((component) => component.variant.route.edgeKeys.length),
      allMalletAnchorsOnWalls: mallets.every((component) => component.variant.anchors.every((anchor) => pointOnEdge(anchor, graph.edgeMap.get(anchor.edgeKey)))),
      allRibbonStartsOnWalls: ribbons.every((component) => pointOnEdge(component.variant.curve.start, graph.edgeMap.get(component.variant.curve.start.edgeKey))),
      allPendulumAnchorsOnWalls: pendulums.every((component) => pointOnEdge(component.variant.anchor, graph.edgeMap.get(component.variant.anchor.edgeKey))),
    };
  }

  function auditClosedCycles() {
    const results = [];
    for (const component of world.components) {
      for (let cycleCount = 1; cycleCount <= 4; cycleCount += 1) {
        const movementDuration = basePeriod(component) * cycleCount;
        const activation = { movementDuration };
        const start = restPose(component);
        const end = activePose(component, movementDuration, activation);
        results.push({ componentId: component.id, cycleCount, closed: JSON.stringify(start) === JSON.stringify(end) });
      }
    }
    return { sampleCount: results.length, allClosed: results.every((result) => result.closed), failures: results.filter((result) => !result.closed) };
  }

  function auditAutoplayPolicy() {
    const decide = (intentOn, contextState) => ({ intentOn, contextState, enabled: intentOn && contextState === "running", needsPointer: intentOn && contextState === "suspended" });
    return {
      running: decide(true, "running"),
      suspended: decide(true, "suspended"),
      unavailable: decide(true, "unavailable"),
      explicitOff: decide(false, "running"),
    };
  }

  function auditAudioSmoke() {
    const glider = world.components.find((component) => component.type === "glider");
    if (!glider || !audio.initialize() || audio.context.state !== "running") return { available: false };
    audio.setEnabled(true);
    const smokeManager = new ActivationManager(world.components);
    const activation = smokeManager.start(glider.id, 0, "oneShot", 0, { cycleCount: 1 });
    const before = audio.diagnostics();
    audio.syncFriction([activation], world.components, activation.basePeriod * 0.25, 1);
    audio.play(smokeManager.eventsBetween(0, activation.completeAt), activation.completeAt, 1);
    audio.syncFriction([], world.components, activation.completeAt, 0);
    const after = audio.diagnostics();
    return {
      available: true,
      frictionStarts: after.gliderFrictionStarts - before.gliderFrictionStarts,
      contactEvents: after.gliderContactEvents - before.gliderContactEvents,
      scheduledEvents: after.scheduledEventCount - before.scheduledEventCount,
      activeFrictionVoices: after.activeFrictionVoices,
    };
  }

  function previewInteraction(componentIds, stepSeconds = 1 / 60) {
    const previewManager = new ActivationManager(world.components);
    const controller = new InteractionController(previewManager, world.components, 6);
    const requests = componentIds.map((componentId) => controller.request(componentId, 0));
    const duplicate = controller.request(componentIds[0], 0.01);
    const events = [];
    let previous = 0;
    let maxActive = 0;
    for (let time = 0; time <= 120 + 1e-9; time += stepSeconds) {
      events.push(...previewManager.eventsBetween(previous, time));
      const finished = previewManager.update(time);
      controller.handleFinished(finished);
      maxActive = Math.max(maxActive, controller.activeOneShots().length);
      previous = time;
      if (controller.isIdle() && previewManager.completed.length === new Set(componentIds).size) break;
    }
    return {
      requests,
      duplicate,
      snapshot: controller.snapshot(previous),
      completed: previewManager.completed.map((activation) => ({
        componentId: activation.componentId,
        cycleCount: activation.cycleCount,
        startedAt: Number(activation.startedAt.toFixed(6)),
        completeAt: Number(activation.completeAt.toFixed(6)),
        completedAt: Number(activation.completedAt.toFixed(6)),
      })),
      startedOrder: controller.startedOrder.map((entry) => ({
        componentId: entry.componentId,
        sequence: entry.sequence,
        startedAt: Number(entry.startedAt.toFixed(6)),
      })),
      eventCounts: events.reduce((counts, event) => {
        counts[event.componentId] = (counts[event.componentId] || 0) + 1;
        return counts;
      }, {}),
      maxActive,
    };
  }

  function auditInteraction() {
    const ids = world.components.slice(0, 10).map((component) => component.id);
    const preview = previewInteraction(ids);
    const expectedEventCounts = Object.fromEntries(preview.completed.map((activation) => [activation.componentId, eventBlueprints(world.components[activation.componentId], activation.cycleCount).length]));

    const drainWorld = buildWorld(`${seed}:drain`);
    const drainManager = new ActivationManager(drainWorld.components);
    const drainGrowth = new PopulationConductor(`${seed}:drain`, drainWorld.components, drainManager);
    drainGrowth.advanceTo(0);
    let previous = 0;
    for (let time = 0; time <= 20 + 1e-9; time += 1 / 60) {
      advanceGrowthInterval(drainManager, drainGrowth, previous, time);
      previous = time;
    }
    const inFlightBeforeDrain = [...drainManager.active.values()]
      .filter((activation) => activation.mode === "persistent" && activation.startedAt <= 20 && activation.completeAt > 20)
      .map((activation) => ({ id: activation.id, componentId: activation.componentId, completeAt: activation.completeAt }));
    const activationCountBeforeDrain = drainManager.allActivations.length;
    drainGrowth.stopReplacing();
    const retainedIds = drainManager.drainPersistent(20);
    const drainUntil = Math.max(20, ...inFlightBeforeDrain.map((activation) => activation.completeAt)) + 0.1;
    for (let time = 20; time <= drainUntil + 1e-9; time += 1 / 60) drainManager.update(time);
    const completedById = new Map(drainManager.completed.map((activation) => [activation.id, activation]));
    return {
      ids,
      initialStartedCount: preview.requests.filter((request) => request.status === "started").length,
      initialQueuedCount: preview.requests.filter((request) => request.status === "queued").length,
      duplicateStatus: preview.duplicate.status,
      completedCount: preview.completed.length,
      uniqueCompletedCount: new Set(preview.completed.map((item) => item.componentId)).size,
      fifoStartedOrder: preview.startedOrder.map((entry) => entry.componentId),
      allCompletedAtContractBoundary: preview.completed.every((item) => item.completeAt === item.completedAt),
      allEventSetsComplete: ids.every((componentId) => preview.eventCounts[componentId] === expectedEventCounts[componentId]),
      maxActive: preview.maxActive,
      finalQueueCount: preview.snapshot.queue.length,
      drain: {
        inFlightCount: inFlightBeforeDrain.length,
        retainedCount: retainedIds.length,
        activationCountUnchanged: drainManager.allActivations.length === activationCountBeforeDrain,
        allInFlightCompletedAtOriginalBoundary: inFlightBeforeDrain.every((item) => completedById.get(item.id)?.completedAt === item.completeAt),
        finalActiveCount: drainManager.active.size,
        finalLitCount: drainManager.snapshot(drainUntil).litCount,
      },
    };
  }

  function previewRipple(previewSeed = seed, seconds = 240, stepSeconds = 1 / 60, options = {}) {
    const previewWorld = buildWorld(previewSeed);
    const previewManager = new ActivationManager(previewWorld.components);
    const conductor = new RippleConductor(previewSeed, previewWorld.components, previewManager, { ...rippleConfig, ...(options.config || {}), ...(options.min !== undefined ? { litMin: options.min } : {}), ...(options.max !== undefined ? { litMax: options.max } : {}) });
    conductor.fireEmber(0);
    const sweeps = [...(options.sweeps || [])].sort((left, right) => left.at - right.at);
    const events = [];
    const litCurve = [];
    const targetCurve = [];
    let sweepIndex = 0;
    let previous = 0;
    let nextSample = 0;
    let maxLit = 0;
    const advance = (to) => {
      const advanced = advanceRippleInterval(previewManager, conductor, previous, to);
      for (const event of advanced.events) events.push({ at: Number(event.at.toFixed(6)), componentId: event.componentId, kind: event.kind, activationId: event.activationId });
      previous = to;
    };
    for (let time = 0; time <= seconds + 1e-9; time += stepSeconds) {
      while (sweepIndex < sweeps.length && sweeps[sweepIndex].at <= time + 1e-9) {
        const sweep = sweeps[sweepIndex++];
        advance(sweep.at);
        conductor.seedMany(sweep.componentIds, sweep.at);
      }
      advance(time);
      const lit = previewManager.snapshot(time).litCount;
      maxLit = Math.max(maxLit, lit);
      if (time >= nextSample - 1e-9) {
        litCurve.push({ at: Number(time.toFixed(3)), lit });
        targetCurve.push({ at: Number(time.toFixed(3)), target: Number(conductor.target(time).toFixed(3)) });
        nextSample += 1;
      }
    }
    return {
      seed: previewSeed,
      range: { ...conductor.range },
      events,
      activations: previewManager.allActivations.map((activation) => ({ id: activation.id, componentId: activation.componentId, startedAt: Number(activation.startedAt.toFixed(6)), completeAt: Number(activation.completeAt.toFixed(6)), cycleCount: activation.cycleCount })),
      log: conductor.log.map((entry) => ({ ...entry })),
      litCurve,
      targetCurve,
      maxLit,
      finalLit: previewManager.snapshot(seconds).litCount,
      stats: conductor.snapshot(seconds),
    };
  }

  function auditRipple(previewSeed = seed, seconds = 240) {
    const preview60 = previewRipple(previewSeed, seconds, 1 / 60);
    const preview30 = previewRipple(previewSeed, seconds, 1 / 30);
    const litAt = (at) => preview60.litCurve.find((sample) => Math.abs(sample.at - at) < 1e-6)?.lit ?? null;
    const sweepIds = [40, 41, 42, 43, 44, 53, 62, 71];
    const swept = previewRipple(previewSeed, 40, 1 / 60, { sweeps: [{ at: 12, componentIds: sweepIds }] });
    const sweptLitAt12 = swept.activations.filter((activation) => Math.abs(activation.startedAt - 12) < 1e-9).map((activation) => activation.componentId);
    const sweepLog = swept.log.filter((entry) => entry.source === "seed");
    const spawnLog = preview60.log.filter((entry) => entry.source === "spark");
    const componentsById = buildWorld(previewSeed).components;
    const activeAt = (log, at) => new Set(preview60.activations.filter((activation) => activation.startedAt < at - 1e-9 && activation.completeAt > at + 1e-9).map((activation) => activation.componentId));
    const allSpawnsAdjacent = spawnLog.every((entry) => {
      const parents = activeAt(preview60.log, entry.at);
      const cell = componentsById[entry.componentId].cell;
      return [...parents].some((parentId) => Math.max(Math.abs(componentsById[parentId].cell.row - cell.row), Math.abs(componentsById[parentId].cell.col - cell.col)) <= 2);
    });
    return {
      seed: previewSeed,
      range: preview60.range,
      deterministicAcrossFrameRates: JSON.stringify(preview60.events) === JSON.stringify(preview30.events) && JSON.stringify(preview60.activations) === JSON.stringify(preview30.activations),
      startsWithOne: preview60.litCurve[0]?.lit === 1 && preview60.log[0]?.source === "ember",
      emberCount: preview60.log.filter((entry) => entry.source === "ember").length,
      relayCount: preview60.log.filter((entry) => entry.source === "relay").length,
      litAt10: litAt(10),
      litAt30: litAt(30),
      litAt60: litAt(60),
      litAt120: litAt(120),
      litAt240: litAt(seconds),
      maxLit: preview60.maxLit,
      minLitAfterRamp: Math.min(...preview60.litCurve.filter((sample) => sample.at >= 90).map((sample) => sample.lit)),
      neverEmpty: preview60.litCurve.every((sample) => sample.lit >= 1),
      allCycleCountsBounded: preview60.activations.every((activation) => activation.cycleCount >= 1 && activation.cycleCount <= 3),
      allSpawnsAdjacent,
      spawnCount: spawnLog.length,
      sweepSeededAll: sweepIds.every((id) => sweptLitAt12.includes(id)) && sweepLog.length === sweepIds.length,
      sweepBoosted: swept.targetCurve.find((sample) => Math.abs(sample.at - 12) < 1e-6)?.target > preview60.targetCurve.find((sample) => Math.abs(sample.at - 12) < 1e-6)?.target,
    };
  }

  function previewMelody(strokes = [], seconds = 12, stepSeconds = 1 / 60, options = {}) {
    const conductor = new MelodyConductor(`${seed}:melody-preview`, world.components, { ...melodyConfig, ...(options.config || {}) }, world.wallGraph, world.responseField, motifSettings);
    const normalizedStrokes = strokes.map((stroke, strokeIndex) => {
      const samples = (stroke.samples || []).map((sample) => ({
        x: Number(sample.x), y: Number(sample.y), at: Math.max(0, Number(sample.at) || 0), pressure: Number(sample.pressure) || 0.5,
      })).sort((left, right) => left.at - right.at);
      return { strokeIndex, samples, endedAt: Math.max(samples.at(-1)?.at || 0, Number(stroke.endedAt) || 0) };
    }).filter((stroke) => stroke.samples.length);
    const actions = [];
    for (const stroke of normalizedStrokes) {
      actions.push({ at: stroke.samples[0].at, priority: 0, kind: "begin", stroke });
      stroke.samples.forEach((sample, sampleIndex) => actions.push({ at: sample.at, priority: 1, kind: "sample", stroke, sample, sampleIndex }));
      actions.push({ at: stroke.endedAt, priority: 2, kind: "end", stroke });
    }
    actions.sort((left, right) => left.at - right.at || left.priority - right.priority || left.stroke.strokeIndex - right.stroke.strokeIndex);
    const gestures = new Map();
    const lastSamples = new Map();
    const events = [];
    const phrases = [];
    let actionIndex = 0;
    let cursor = 0;
    let nextStepAt = 0;
    let maxWaveCount = 0;
    const target = Math.max(seconds, ...normalizedStrokes.map((stroke) => stroke.endedAt), 0);
    for (let guard = 0; guard < 200000 && cursor <= target + 1e-9; guard += 1) {
      const nextActionAt = actions[actionIndex]?.at ?? Infinity;
      const boundary = Math.min(target, nextActionAt, nextStepAt);
      if (boundary > cursor + 1e-9) {
        events.push(...conductor.eventsBetween(cursor, boundary));
        cursor = boundary;
      }
      while (actionIndex < actions.length && actions[actionIndex].at <= cursor + 1e-9) {
        const action = actions[actionIndex++];
        const key = action.stroke.strokeIndex;
        if (action.kind === "begin") {
          gestures.set(key, conductor.beginGesture(action.at, action.at * 1000, key + 1));
        } else if (action.kind === "sample") {
          const gestureState = gestures.get(key);
          if (!gestureState) continue;
          const point = { x: action.sample.x, y: action.sample.y, t: action.sample.at, pressure: action.sample.pressure };
          const from = lastSamples.get(key) || point;
          events.push(...recordMelodySegment(conductor, gestureState, from, point));
          lastSamples.set(key, point);
        } else {
          const phrase = conductor.finishGesture(gestures.get(key), action.at);
          if (phrase) phrases.push({
            ...phrase,
            notes: phrase.notes.map((note) => ({ ...note })),
            wavePoints: phrase.wavePoints.map((wavePoint) => ({ ...wavePoint })),
          });
          gestures.delete(key);
          lastSamples.delete(key);
        }
        maxWaveCount = Math.max(maxWaveCount, conductor.waves.length);
      }
      if (nextStepAt <= cursor + 1e-9) nextStepAt += Math.max(1 / 240, stepSeconds);
      if (cursor >= target - 1e-9) break;
      if (boundary === Infinity) break;
    }
    events.push(...conductor.eventsBetween(cursor, target));
    const normalizedEvents = events.sort((left, right) => left.at - right.at || left.phraseId - right.phraseId || left.repeat - right.repeat).map((event) => ({
      at: Number(event.at.toFixed(6)), componentId: event.componentId, phraseId: event.phraseId, layer: event.phraseLayer,
      repeat: event.repeat, pitch: event.pitch, gainScale: Number(event.gainScale.toFixed(6)),
    }));
    return {
      config: { ...conductor.config },
      events: normalizedEvents,
      liveEvents: normalizedEvents.filter((event) => event.repeat === 0),
      replayEvents: normalizedEvents.filter((event) => event.repeat > 0),
      phrases: phrases.map((phrase) => ({
        id: phrase.id, layer: phrase.layer, noteCount: phrase.notes.length, period: Number(phrase.period.toFixed(6)),
        wavePointCount: phrase.wavePoints.length,
        replayAt: Number(phrase.replayAt.toFixed(6)), repeatCount: phrase.repeatCount, endsAt: Number(phrase.endsAt.toFixed(6)),
        notes: phrase.notes.map((note) => ({ componentId: note.componentId, offset: Number(note.offset.toFixed(6)), accent: Number(note.accent.toFixed(6)) })),
      })),
      maxWaveCount: Math.max(maxWaveCount, conductor.peakWaveCount),
      waveSources: conductor.waveSourceLog.map((wave) => ({
        sourceIndex: wave.sourceIndex,
        fromSourceIndex: wave.fromSourceIndex,
        x: Number(wave.x.toFixed(4)),
        y: Number(wave.y.toFixed(4)),
        fromX: Number(wave.fromX.toFixed(4)),
        fromY: Number(wave.fromY.toFixed(4)),
        at: Number(wave.at.toFixed(6)),
        repeat: wave.repeat,
        phraseId: wave.phraseId,
      })),
      wavePointCount: conductor.waveX.length,
      final: conductor.snapshot(target),
    };
  }

  function auditMelody() {
    const y = FRAME.y + CELL_H * 5.5;
    const strokeA = { endedAt: 0.62, samples: [
      { x: FRAME.x + CELL_W * 0.5, y, at: 0 },
      { x: FRAME.x + CELL_W * 2.5, y, at: 0.09 },
      { x: FRAME.x + CELL_W * 4.5, y, at: 0.31 },
      { x: FRAME.x + CELL_W * 6.5, y, at: 0.56 },
    ] };
    const strokeB = { endedAt: 1.22, samples: [
      { x: FRAME.x + CELL_W * 2.5, y: y + CELL_H * 2, at: 0.72 },
      { x: FRAME.x + CELL_W * 6.5, y: y + CELL_H * 2, at: 1.16 },
    ] };
    const preview30 = previewMelody([strokeA, strokeB], 12, 1 / 30);
    const preview60 = previewMelody([strokeA, strokeB], 12, 1 / 60);
    const repeats = [...new Set(preview60.replayEvents.map((event) => event.repeat))];
    const gains = repeats.map((repeat) => Math.max(...preview60.replayEvents.filter((event) => event.repeat === repeat).map((event) => event.gainScale)));
    const field = new MelodyConductor(`${seed}:wall-audit`, world.components, melodyConfig, world.wallGraph, world.responseField, motifSettings);
    let wallPair = null;
    let openPair = null;
    for (let index = 0; index < field.waveX.length && (!wallPair || !openPair); index += 1) {
      const row = Math.floor(index / field.config.waveCols);
      const col = index % field.config.waveCols;
      for (const next of [col + 1 < field.config.waveCols ? index + 1 : -1, row + 1 < field.config.waveRows ? index + field.config.waveCols : -1]) {
        if (next < 0 || field.waveComponentId[index] === field.waveComponentId[next]) continue;
        if (field.edgeResistance(index, next) > 1 && !wallPair) wallPair = [index, next];
        if (field.edgeResistance(index, next) === 1 && !openPair) openPair = [index, next];
      }
    }
    const pairRatio = (pair) => {
      if (!pair) return null;
      const [from, to] = pair;
      const direct = Math.hypot(field.waveX[to] - field.waveX[from], field.waveY[to] - field.waveY[from]);
      return field.distancesFrom(from)[to] / direct;
    };
    const wallEdgePenalty = wallPair ? (() => {
      const [from, to] = wallPair;
      const direct = Math.hypot(field.waveX[to] - field.waveX[from], field.waveY[to] - field.waveY[from]);
      return direct * (field.edgeResistance(from, to) - 1);
    })() : null;
    let diffractionPair = null;
    let diffractionDirectDistance = null;
    let diffractionShortestDistance = null;
    let diffractionCrossingCost = null;
    diffractionSearch:
    for (let index = 0; index < field.waveX.length; index += 1) {
      const row = Math.floor(index / field.config.waveCols);
      const col = index % field.config.waveCols;
      for (const next of [col + 1 < field.config.waveCols ? index + 1 : -1, row + 1 < field.config.waveRows ? index + field.config.waveCols : -1]) {
        if (next < 0 || field.edgeResistance(index, next) <= 1) continue;
        const direct = Math.hypot(field.waveX[next] - field.waveX[index], field.waveY[next] - field.waveY[index]);
        const crossing = direct + field.config.wallPenalty;
        const shortest = field.distancesFrom(index)[next];
        // 如果比任意一次穿墙的最小代价还低，这条最短路必然从墙端或缺口绕行，且没有使用 penalized edge。
        if (shortest > direct * 1.05 && shortest < crossing - 0.5) {
          diffractionPair = [index, next];
          diffractionDirectDistance = direct;
          diffractionShortestDistance = shortest;
          diffractionCrossingCost = crossing;
          break diffractionSearch;
        }
      }
    }
    let maximumEdgeAsymmetry = 0;
    for (let index = 0; index < field.waveX.length; index += 1) {
      const row = Math.floor(index / field.config.waveCols);
      const col = index % field.config.waveCols;
      for (let dRow = -1; dRow <= 1; dRow += 1) {
        for (let dCol = -1; dCol <= 1; dCol += 1) {
          if (dRow === 0 && dCol === 0) continue;
          const nextRow = row + dRow;
          const nextCol = col + dCol;
          if (nextRow < 0 || nextRow >= field.config.waveRows || nextCol < 0 || nextCol >= field.config.waveCols) continue;
          const next = nextRow * field.config.waveCols + nextCol;
          maximumEdgeAsymmetry = Math.max(maximumEdgeAsymmetry, Math.abs(field.edgeResistance(index, next) - field.edgeResistance(next, index)));
        }
      }
    }
    const equivalence = new MelodyConductor(`${seed}:field-equivalence`, world.components, melodyConfig, world.wallGraph, world.responseField, motifSettings);
    for (const [componentId, at, amplitude] of [[18, 0, 1], [70, 0.17, 0.72], [116, 0.43, 0.54]]) {
      const component = world.components[componentId];
      equivalence.addWave({ x: component.centerX, y: component.centerY, componentId, phraseId: componentId, layer: componentId % 3, gainScale: amplitude }, at, amplitude);
    }
    let maximumFieldError = 0;
    for (const now of [0.12, 0.51, 1.27, 2.1]) {
      const sampled = equivalence.sampleField(now);
      for (let index = 0; index < sampled.length; index += 1) {
        maximumFieldError = Math.max(maximumFieldError, Math.abs(sampled[index] - equivalence.amplitudeAt(equivalence.waveX[index], equivalence.waveY[index], now)));
      }
    }
    const flatAccentField = new Float32Array(field.waveX.length);
    flatAccentField.fill(0.92);
    const flatAccents = field.prepareWaveAccents(flatAccentField).at(-1);
    const accentRows = new Set();
    const accentCols = new Set();
    const accentQuadrants = new Set();
    for (const pointIndex of flatAccents) {
      const row = Math.floor(pointIndex / field.config.waveCols);
      const col = pointIndex % field.config.waveCols;
      accentRows.add(row);
      accentCols.add(col);
      accentQuadrants.add(`${row < field.config.waveRows / 2 ? 0 : 1}:${col < field.config.waveCols / 2 ? 0 : 1}`);
    }
    return {
      deterministicAcrossFrameRates: JSON.stringify(preview30.events) === JSON.stringify(preview60.events),
      phraseCount: preview60.phrases.length,
      orderedLiveTimes: preview60.liveEvents.every((event, index, values) => index === 0 || event.at >= values[index - 1].at),
      preservesNonUniformTiming: new Set(preview60.phrases[0]?.notes.map((note) => note.offset) || []).size > 2,
      repeatNumbers: repeats,
      gainsStrictlyFade: gains.every((gain, index) => index === 0 || gain < gains[index - 1] - 1e-9),
      maxWaveCount: preview60.maxWaveCount,
      waveCap: preview60.config.maxWaves,
      wavePointCount: preview60.wavePointCount,
      wallCrossingRatio: pairRatio(wallPair),
      openStepRatio: pairRatio(openPair),
      wallEdgePenalty,
      configuredWallPenalty: field.config.wallPenalty,
      diffractionPair,
      diffractionDirectDistance,
      diffractionShortestDistance,
      diffractionCrossingCost,
      diffractionSavings: diffractionPair ? diffractionCrossingCost - diffractionShortestDistance : null,
      diffractionRatio: diffractionPair ? diffractionShortestDistance / diffractionDirectDistance : null,
      maximumEdgeAsymmetry,
      maximumFieldError,
      flatAccentCount: flatAccents.length,
      flatAccentRowCoverage: accentRows.size,
      flatAccentColumnCoverage: accentCols.size,
      flatAccentQuadrantCoverage: accentQuadrants.size,
    };
  }

  function inspectWaveGraph(sourceIndex = 0) {
    const conductor = new MelodyConductor(`${seed}:graph-inspection`, world.components, melodyConfig, world.wallGraph, world.responseField, motifSettings);
    const source = clamp(Math.round(Number(sourceIndex) || 0), 0, conductor.waveX.length - 1);
    return {
      cols: conductor.config.waveCols,
      rows: conductor.config.waveRows,
      source,
      x: Float32Array.from(conductor.waveX),
      y: Float32Array.from(conductor.waveY),
      neighbors: Int16Array.from(conductor.waveNeighborIndices),
      costs: Float32Array.from(conductor.waveNeighborCosts),
      productionDistances: Float32Array.from(conductor.distancesFrom(source)),
    };
  }

  function auditLineSourceField() {
    const fromIndex = 0;
    const toIndex = melodyConfig.waveCols * melodyConfig.waveRows - 1;
    const makeConductor = (suffix) => new MelodyConductor(`${seed}:line-field:${suffix}`, world.components, melodyConfig, world.wallGraph, world.responseField, motifSettings);
    const point = makeConductor("point");
    const line = makeConductor("line");
    const waveRequest = {
      sourceIndex: toIndex,
      x: line.waveX[toIndex],
      y: line.waveY[toIndex],
      phraseId: 1,
      layer: 0,
      gainScale: 1,
    };
    point.addWave({ ...waveRequest, fromX: point.waveX[toIndex], fromY: point.waveY[toIndex] }, 0, 1);
    line.addWave({ ...waveRequest, fromX: line.waveX[fromIndex], fromY: line.waveY[fromIndex] }, 0, 1);
    const pointField = point.sampleField(0);
    const lineField = line.sampleField(0);
    const segmentSources = line.segmentSourceIndices(fromIndex, toIndex);
    const midpointIndex = segmentSources[Math.floor(segmentSources.length / 2)];
    const pointAmplitude = point.amplitudeAt(point.waveX[fromIndex], point.waveY[fromIndex], 0);
    const lineAmplitude = line.amplitudeAt(line.waveX[fromIndex], line.waveY[fromIndex], 0);
    const pointMidpointAmplitude = point.amplitudeAt(point.waveX[midpointIndex], point.waveY[midpointIndex], 0);
    const lineMidpointAmplitude = line.amplitudeAt(line.waveX[midpointIndex], line.waveY[midpointIndex], 0);
    const referenceDistances = new Float32Array(line.waveX.length);
    referenceDistances.fill(Infinity);
    for (const sourceIndex of segmentSources) {
      const pointDistances = line.distancesFrom(sourceIndex);
      for (let index = 0; index < referenceDistances.length; index += 1) {
        if (pointDistances[index] < referenceDistances[index]) referenceDistances[index] = pointDistances[index];
      }
    }
    let maximumMultiSourceDistanceError = 0;
    const productionDistances = line.waves[0].distances;
    for (let index = 0; index < referenceDistances.length; index += 1) {
      maximumMultiSourceDistanceError = Math.max(maximumMultiSourceDistanceError, Math.abs(referenceDistances[index] - productionDistances[index]));
    }
    return {
      fromIndex,
      toIndex,
      midpointIndex,
      segmentSeedCount: segmentSources.length,
      pointEnergyAtFrom: pointField[fromIndex],
      lineEnergyAtFrom: lineField[fromIndex],
      pointEnergyAtMidpoint: pointField[midpointIndex],
      lineEnergyAtMidpoint: lineField[midpointIndex],
      pointAmplitudeAtFrom: pointAmplitude,
      lineAmplitudeAtFrom: lineAmplitude,
      pointAmplitudeAtMidpoint: pointMidpointAmplitude,
      lineAmplitudeAtMidpoint: lineMidpointAmplitude,
      pointFieldMatchesAmplitude: Math.abs(pointField[fromIndex] - pointAmplitude) < 1e-7,
      lineFieldMatchesAmplitude: Math.abs(lineField[fromIndex] - lineAmplitude) < 1e-7,
      midpointFieldMatchesAmplitude: Math.abs(lineField[midpointIndex] - lineMidpointAmplitude) < 1e-7,
      maximumMultiSourceDistanceError,
    };
  }

  function previewWaveAccents(request = {}) {
    const waves = Array.isArray(request) ? request : request.waves || [];
    const at = Array.isArray(request) ? 1 : request.at ?? 1;
    const config = !Array.isArray(request) && request.config && typeof request.config === "object" ? request.config : {};
    const conductor = new MelodyConductor(`${seed}:accent-preview`, world.components, { ...melodyConfig, ...config }, world.wallGraph, world.responseField, motifSettings);
    for (let index = 0; index < waves.length; index += 1) {
      const request = waves[index] || {};
      const componentId = clamp(Math.round(Number(request.componentId) || 0), 0, world.components.length - 1);
      const component = world.components[componentId];
      conductor.addWave({
        x: component.centerX,
        y: component.centerY,
        componentId,
        phraseId: index + 1,
        layer: index % PHRASE_COLORS.length,
        gainScale: Number(request.amplitude) || 1,
      }, Number(request.at) || 0, Number(request.amplitude) || 1);
    }
    const field = Float32Array.from(conductor.sampleField(Number(at) || 0));
    const selected = conductor.prepareWaveAccents(field).map((bucket) => [...bucket]);
    return {
      cols: conductor.config.waveCols,
      rows: conductor.config.waveRows,
      field,
      selected,
      quotas: [...WAVE_ACCENT_QUOTAS],
    };
  }

  function auditMelodyAudioCap(eventCount = 100) {
    const engine = new AudioEngine(true, { gestureVoiceLimit: melodyConfig.voiceLimit, motifVoiceLimit: melodyConfig.motifVoiceLimit, mechanismVoiceLimit: melodyConfig.mechanismVoiceLimit, frictionVoiceLimit: melodyConfig.frictionVoiceLimit });
    if (!engine.initialize() || engine.context.state !== "running") return { available: false };
    engine.setEnabled(true);
    const component = world.components[0];
    const events = Array.from({ length: eventCount }, (_, index) => gestureNoteEvent(component, index * 0.00001, 1, 0, 1, 1, 0));
    engine.play(events, 0, 1);
    const mechanismComponent = world.components.find((item) => item.type === "mallet");
    const mechanismEvents = Array.from({ length: eventCount }, (_, index) => ({
      at: index * 0.00001, activationId: index + 1, activationMode: "melodyWave", componentId: mechanismComponent.id, type: mechanismComponent.type,
      kind: "felt-mallet", pitch: mechanismComponent.pitch, accent: 1, gainScale: 1, sourceU: (mechanismComponent.centerX - FRAME.x) / FRAME.width,
    }));
    engine.play(mechanismEvents, 0, 1);
    // 使用真实短句而不是 100 个伪造单音：13 句同时请求时，逻辑层与音频层都只准入完整的 12 句。
    const stressWorld = buildWorld(`${seed}:motif-performance-cap`, motifSettings, 16);
    const stressComponents = stressWorld.components.filter((item) => item.motifAbility?.enabled).slice(0, melodyConfig.motifVoiceLimit + 1);
    const sourceConductor = new MelodyConductor(
      `${seed}:motif-performance-source`, stressWorld.components,
      { ...melodyConfig, motifCount: 16, motifVoiceLimit: 16 }, stressWorld.wallGraph, stressWorld.responseField, motifSettings,
    );
    const sourcePerformances = stressComponents
      .map((item) => sourceConductor.startMotifAbility(item, 1, {}))
      .filter(Boolean);
    const motifEvents = sourcePerformances.flatMap((performance) => performance.events)
      .sort((left, right) => left.at - right.at || left.componentId - right.componentId);
    const admissionConductor = new MelodyConductor(
      `${seed}:motif-performance-admission`, stressWorld.components,
      { ...melodyConfig, motifCount: 16, motifVoiceLimit: melodyConfig.motifVoiceLimit }, stressWorld.wallGraph, stressWorld.responseField, motifSettings,
    );
    const admittedPerformances = stressComponents
      .map((item) => admissionConductor.startMotifAbility(item, 1, {}))
      .filter(Boolean);
    engine.play(motifEvents, 1, 1);
    const diagnostics = engine.diagnostics();
    engine.setEnabled(false);
    const afterDisable = engine.diagnostics();
    const legacyEngine = new AudioEngine(true, { gestureVoiceLimit: melodyConfig.voiceLimit, motifVoiceLimit: melodyConfig.motifVoiceLimit, mechanismVoiceLimit: melodyConfig.mechanismVoiceLimit, frictionVoiceLimit: melodyConfig.frictionVoiceLimit });
    legacyEngine.initialize();
    legacyEngine.setEnabled(true);
    legacyEngine.play(mechanismEvents.map(({ activationMode: _activationMode, ...event }) => event), 0, 1);
    const legacyDiagnostics = legacyEngine.diagnostics();
    legacyEngine.setEnabled(false);
    return {
      available: true,
      ...diagnostics,
      trackedSourcesAfterDisable: afterDisable.trackedOneShotSources,
      gestureVoicesAfterDisable: afterDisable.activeGestureVoices,
      motifVoicesAfterDisable: afterDisable.activeMotifVoices,
      mechanismVoicesAfterDisable: afterDisable.activeMechanismVoices,
      realMotifPerformanceRequestCount: sourcePerformances.length,
      conductorAcceptedMotifPerformanceCount: admittedPerformances.length,
      conductorRejectedMotifPerformanceCount: admissionConductor.motifPerformanceRejectCount,
      legacyMechanismVoicesDropped: legacyDiagnostics.mechanismVoicesDropped,
      legacyScheduledEventCount: legacyDiagnostics.scheduledEventCount,
    };
  }

  function auditMelodyPerformance(sourceCount = 16) {
    const clock = () => globalThis.performance?.now?.() ?? Date.now();
    let startedAt = clock();
    const conductor = new MelodyConductor(`${seed}:performance`, world.components, melodyConfig, world.wallGraph, world.responseField, motifSettings);
    const constructorMs = clock() - startedAt;
    const ids = Array.from({ length: clamp(Math.round(sourceCount), 1, world.components.length) }, (_, index) => Math.floor(index * world.components.length / Math.max(1, sourceCount)));
    startedAt = clock();
    for (const id of ids) conductor.distancesFrom(conductor.componentWaveIndex[id]);
    const coldDistanceMs = clock() - startedAt;
    startedAt = clock();
    for (const id of ids) conductor.distancesFrom(conductor.componentWaveIndex[id]);
    const cachedDistanceMs = clock() - startedAt;
    for (let index = 0; index < melodyConfig.maxWaves; index += 1) {
      const component = world.components[Math.floor(index * world.components.length / melodyConfig.maxWaves)];
      const from = world.components[(component.id + 47 + index) % world.components.length];
      conductor.addWave({
        x: component.centerX, y: component.centerY, componentId: component.id,
        fromX: from.centerX, fromY: from.centerY,
        phraseId: index + 1, layer: index % 3, gainScale: 1,
      }, index * 0.015, 1);
    }
    startedAt = clock();
    conductor.sampleField(0.8);
    const fullFieldMs = clock() - startedAt;
    startedAt = clock();
    conductor.sampleComponentEnergy(0.8);
    const componentScanMs = clock() - startedAt;
    startedAt = clock();
    const accentCount = conductor.prepareWaveAccents(conductor.waveField).reduce((sum, bucket) => sum + bucket.length, 0);
    const accentSelectionMs = clock() - startedAt;
    const retainedDistanceFields = new Set(conductor.distanceCache.values());
    for (const wave of conductor.waves) {
      retainedDistanceFields.add(wave.distances);
      retainedDistanceFields.add(wave.fromDistances);
    }
    const distanceCacheBytes = [...conductor.distanceCache.values()].reduce((sum, distances) => sum + distances.byteLength, 0);
    const retainedDistanceBytes = [...retainedDistanceFields].reduce((sum, distances) => sum + distances.byteLength, 0);
    return {
      pointCount: conductor.waveX.length,
      sourceCount: ids.length,
      constructorMs: Number(constructorMs.toFixed(3)),
      coldDistanceMs: Number(coldDistanceMs.toFixed(3)),
      coldDistancePerSourceMs: Number((coldDistanceMs / ids.length).toFixed(3)),
      cachedDistanceMs: Number(cachedDistanceMs.toFixed(3)),
      fullFieldMs: Number(fullFieldMs.toFixed(3)),
      componentScanMs: Number(componentScanMs.toFixed(3)),
      accentSelectionMs: Number(accentSelectionMs.toFixed(3)),
      accentCount,
      distanceCacheEntries: conductor.distanceCache.size,
      distanceCacheBytes,
      dynamicDistanceEntries: conductor.dynamicDistanceKeys.size,
      retainedDistanceFieldCount: retainedDistanceFields.size,
      retainedDistanceBytes,
      lineWaveCount: conductor.waves.filter((wave) => wave.sourceIndex !== wave.fromSourceIndex).length,
      allLineFieldsAliased: conductor.waves.every((wave) => wave.distances === wave.fromDistances),
    };
  }

  function auditMelodyComponentResponse(stepSeconds = 1 / 60, configOverrides = {}) {
    const auditManager = new ActivationManager(world.components);
    const conductor = new MelodyConductor(`${seed}:component-response`, world.components, { ...melodyConfig, ...configOverrides }, world.wallGraph, world.responseField, motifSettings);
    const source = world.components[Math.floor(world.components.length / 2)];
    // 0.45 是无压力慢划的典型真实振幅，不能再用理想化的 1.0 掩盖远端衰减。
    conductor.addWave({ x: source.centerX, y: source.centerY, phraseId: 1, layer: 0, gainScale: 0.45 }, 0, 0.45);
    let previous = -1e-6;
    let maxActive = 0;
    let activeFrameCount = 0;
    let darkWhileScheduled = 0;
    const eventCounts = new Map();
    for (let now = 0; now <= 18 + 1e-9; now += Math.max(1 / 240, stepSeconds)) {
      for (const event of auditManager.eventsBetween(previous, now)) eventCounts.set(event.activationId, (eventCounts.get(event.activationId) || 0) + 1);
      auditManager.update(now);
      conductor.wakeComponents(auditManager, now);
      for (const event of auditManager.eventsForActivationsBetween(conductor.startedActivations, previous, now)) eventCounts.set(event.activationId, (eventCounts.get(event.activationId) || 0) + 1);
      for (const activation of auditManager.active.values()) {
        if (now + 1e-9 < activation.startedAt || now >= activation.completeAt - 1e-9) continue;
        activeFrameCount += 1;
        if (auditManager.stateFor(world.components[activation.componentId], now).phase === "darkFrozen") darkWhileScheduled += 1;
      }
      maxActive = Math.max(maxActive, auditManager.active.size);
      previous = now;
    }
    auditManager.update(24);
    const countsByComponent = new Map();
    for (const activation of auditManager.allActivations) countsByComponent.set(activation.componentId, (countsByComponent.get(activation.componentId) || 0) + 1);
    const sourceActivation = auditManager.allActivations.find((activation) => activation.componentId === source.id);
    const farEdge = world.components[source.cell.row * COLS + (COLS - 1)];
    const farEdgeDistance = conductor.distancesFrom(conductor.componentWaveIndex[source.id])[conductor.componentWaveIndex[farEdge.id]];
    const farEdgeArrivalAt = farEdgeDistance / conductor.config.waveSpeed;
    const farEdgeEnergyAtArrival = conductor.activationEnergyAt(conductor.componentWaveIndex[farEdge.id], farEdgeArrivalAt);
    const farEdgeRepeatPeaks = Array.from({ length: conductor.config.repeatCount + 1 }, (_, repeat) => Math.tanh(
      0.45 * Math.pow(conductor.config.waveRepeatFade, repeat) * waveLifeGain(farEdgeArrivalAt, conductor.config.waveLife),
    ));
    conductor.prune(24);
    const regularCycleManager = new ActivationManager(world.components);
    // 单周期是产品默认；这里仍用两个周期验证姿态函数本身严格可重复、不会追随波场闪烁。
    const regularActivation = regularCycleManager.start(source.id, 0, "melodyWave", 0, { cycleCount: 2, gainScale: conductor.config.componentGain });
    const repeatedPoseA = regularCycleManager.stateFor(source, regularActivation.basePeriod * 0.25).pose;
    const repeatedPoseB = regularCycleManager.stateFor(source, regularActivation.basePeriod * 1.25).pose;
    const poseSignature = (pose) => JSON.stringify(pose, (_key, value) => typeof value === "number" ? Number(value.toFixed(6)) : value);
    const finiteRounded = (value, digits) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
    const activationSequence = auditManager.allActivations.map((activation) => ({
      componentId: activation.componentId,
      triggeredAt: Number((activation.melodyTriggeredAt ?? activation.startedAt).toFixed(6)),
      startedAt: Number(activation.startedAt.toFixed(6)),
      completeAt: Number(activation.completeAt.toFixed(6)),
      basePeriod: Number(activation.basePeriod.toFixed(6)),
      originalBasePeriod: Number(basePeriod(world.components[activation.componentId]).toFixed(6)),
      cycleCount: activation.cycleCount,
      mode: activation.mode,
      triggerWaveId: activation.melodyTriggerWaveId,
      triggerEnergy: finiteRounded(activation.melodyTriggerEnergy, 6),
      contactIndex: activation.melodyContactIndex,
      contactX: finiteRounded(activation.melodyContactX, 3),
      contactY: finiteRounded(activation.melodyContactY, 3),
    }));
    const triggeredFarEdge = activationSequence.filter((activation) => activation.componentId % COLS === COLS - 1);
    return {
      sourceTriggered: Boolean(sourceActivation),
      sourceComponentId: source.id,
      farEdgeComponentId: farEdge.id,
      farEdgeDistance: Number(farEdgeDistance.toFixed(6)),
      farEdgeArrivalAt: Number(farEdgeArrivalAt.toFixed(6)),
      farEdgeEnergyAtArrival: Number(farEdgeEnergyAtArrival.toFixed(6)),
      farEdgeRepeatPeaks: farEdgeRepeatPeaks.map((energy) => Number(energy.toFixed(6))),
      activationCount: auditManager.allActivations.length,
      triggerCount: conductor.componentTriggerCount,
      skippedWaveEdgeCount: conductor.componentSkippedWaveEdgeCount,
      maxActive,
      componentLimit: conductor.config.componentLimit,
      contactSampleCount: conductor.componentContactWaveIndex.length,
      triggeredFarEdgeCount: triggeredFarEdge.length,
      activationSequence,
      maxActivationSeconds: Math.max(0, ...auditManager.allActivations.map((activation) => activation.completeAt - activation.startedAt)),
      allStartOnThresholdEdge: auditManager.allActivations.every((activation) => Math.abs((activation.melodyTriggeredAt ?? activation.startedAt) - activation.startedAt) < 1e-9
        && activation.melodyTriggerEnergy >= conductor.config.componentThreshold - 1e-6),
      allHavePhysicalWaveIdentity: auditManager.allActivations.every((activation) => Number.isInteger(activation.melodyTriggerWaveId)),
      allUseCompleteCycles: auditManager.allActivations.every((activation) => activation.cycleCount === conductor.config.componentCycles
        && Math.abs(activation.completeAt - activation.startedAt - activation.basePeriod * conductor.config.componentCycles) < 1e-6),
      noComponentRetriggeredByOneWave: [...countsByComponent.values()].every((count) => count === 1),
      noDarkFramesInsideActivation: activeFrameCount > 0 && darkWhileScheduled === 0,
      repeatsSamePoseEachCycle: poseSignature(repeatedPoseA) === poseSignature(repeatedPoseB),
      allActivationEventsPlayed: auditManager.allActivations.every((activation) => eventCounts.get(activation.id) === activation.events.length),
      finalActiveCount: auditManager.active.size,
      finalCompletedCount: auditManager.completed.length,
      finalLatchedComponentCount: conductor.componentWasAbove.reduce((sum, value) => sum + value, 0),
      finalWaveCount: conductor.waves.length,
      finalAnimating: conductor.isAnimating(24),
    };
  }

  function motifDefinitionSnapshot(definition) {
    return {
      id: definition.id,
      title: definition.title,
      composer: definition.composer,
      family: definition.family,
      collection: definition.collection,
      transposePolicy: definition.transposePolicy,
      rootPitch: definition.rootPitch,
      beatSeconds: definition.beatSeconds,
      leadInBeats: Number(definition.leadInBeats) || 0,
      noteCount: definition.notes.length,
      notes: definition.notes.map((note) => ({ semitones: note.semitones, beats: note.beats, accent: note.accent })),
    };
  }

  function auditMotifAbilities() {
    const assigned = world.components.filter((component) => component.motifAbility);
    const playable = assigned.filter((component) => component.motifAbility.enabled);
    const ordinary = world.components.filter((component) => !component.motifAbility);
    let minimumGridSeparation = Infinity;
    for (let left = 0; left < assigned.length; left += 1) {
      for (let right = left + 1; right < assigned.length; right += 1) {
        minimumGridSeparation = Math.min(minimumGridSeparation, Math.max(
          Math.abs(assigned[left].cell.row - assigned[right].cell.row),
          Math.abs(assigned[left].cell.col - assigned[right].cell.col),
        ));
      }
    }
    if (assigned.length < 2) minimumGridSeparation = null;

    const conductor = new MelodyConductor(`${seed}:motif-audit`, world.components, melodyConfig, world.wallGraph, world.responseField, motifSettings);
    const first = playable[0] || null;
    const firstActivation = {};
    const firstPerformance = first ? conductor.startMotifAbility(first, 1, firstActivation) : null;
    const blockedDuringCooldown = first ? conductor.startMotifAbility(first, 1.01, {}) === null : true;
    const replayAfterCooldown = first
      ? conductor.startMotifAbility(first, 1 + melodyConfig.motifCooldown + 0.01, {})
      : null;
    const catchupEvents = firstPerformance
      ? conductor.motifEventsForPerformancesBetween([firstPerformance], 0.95, firstPerformance.events[0].at + 0.01)
      : [];

    const offSettings = resolveMotifSettings("?motifs=off", window.KINETIC_MAZE_CONFIG?.melody);
    const offConductor = new MelodyConductor(`${seed}:motif-off-audit`, world.components, melodyConfig, world.wallGraph, world.responseField, offSettings);
    const globallyOffSuppresses = !first || offConductor.startMotifAbility(first, 1, {}) === null;

    let perAbilityOffSuppresses = true;
    if (first) {
      const disabledSettings = resolveMotifSettings("", { motifAbilities: { [first.motifAbility.id]: false } });
      const disabledWorld = buildWorld(seed, disabledSettings, melodyConfig.motifCount);
      const disabledComponent = disabledWorld.components.find((component) => component.motifAbility?.id === first.motifAbility.id);
      const disabledConductor = new MelodyConductor(`${seed}:motif-disabled-audit`, disabledWorld.components, melodyConfig, disabledWorld.wallGraph, disabledWorld.responseField, disabledSettings);
      perAbilityOffSuppresses = Boolean(disabledComponent)
        && disabledComponent.motifAbility.enabled === false
        && disabledConductor.startMotifAbility(disabledComponent, 1, {}) === null;
    }

    const customSettings = resolveMotifSettings("", {
      customMotifs: [{ id: "audit-custom", title: "审核短句", beatSeconds: 0.22, notes: [[0, 0.5], [3, 0.5], [7, 1]] }],
    });
    const customWorld = buildWorld(`${seed}:custom-motif-audit`, customSettings, 1);
    const customAbility = customWorld.components.find((component) => component.motifAbility)?.motifAbility || null;
    const fixedCustomSettings = resolveMotifSettings("", {
      customMotifs: [{
        id: "audit-fixed", title: "固定调审核", composer: "Audit", transposePolicy: "fixed", rootPitch: 64,
        beatSeconds: 0.22, notes: [[0, 0.5], [3, 0.5], [7, 1]],
      }],
    });
    const fixedCustomWorld = buildWorld(`${seed}:fixed-custom-motif-audit`, fixedCustomSettings, 1);
    const fixedCustomComponent = fixedCustomWorld.components.find((component) => component.motifAbility?.id === "audit-fixed") || null;
    const fixedCustomConductor = new MelodyConductor(
      `${seed}:fixed-custom-performance`, fixedCustomWorld.components, melodyConfig,
      fixedCustomWorld.wallGraph, fixedCustomWorld.responseField, fixedCustomSettings,
    );
    const fixedCustomPerformance = fixedCustomComponent
      ? fixedCustomConductor.startMotifAbility(fixedCustomComponent, 1, {})
      : null;
    const familyCounts = assigned.reduce((counts, component) => {
      const family = component.motifAbility.family;
      counts[family] = (counts[family] || 0) + 1;
      return counts;
    }, {});
    const namedComposerCounts = assigned.reduce((counts, component) => {
      if (component.motifAbility.family === "original-jazz" || component.motifAbility.family === "custom") return counts;
      const composer = component.motifAbility.composer;
      counts[composer] = (counts[composer] || 0) + 1;
      return counts;
    }, {});
    const namedDefinitions = motifSettings.library.filter((definition) => definition.family !== "original-jazz" && definition.family !== "custom");
    // 用真实的 startComponent 路径锁定所有权语义：能力属于少数组件，不属于整笔轨迹。
    const ownershipConductor = new MelodyConductor(
      `${seed}:motif-ownership`, world.components, melodyConfig,
      world.wallGraph, world.responseField, motifSettings,
    );
    const ownershipManager = new ActivationManager(world.components);
    const abilityTriggers = playable.slice(0, 2).map((component, index) => {
      const performanceCountBefore = ownershipConductor.startedMotifPerformances.length;
      const activation = ownershipConductor.startComponent(ownershipManager, component.id, 2 + index * 0.01, "wavefront");
      const performance = ownershipConductor.startedMotifPerformances.at(-1) || null;
      return {
        componentId: component.id,
        abilityId: component.motifAbility.id,
        activationStarted: Boolean(activation),
        performanceCountDelta: ownershipConductor.startedMotifPerformances.length - performanceCountBefore,
        performedComponentId: performance?.componentId ?? null,
        performedMotifId: performance?.motifId ?? null,
      };
    });
    const ordinaryComponent = ordinary[0] || null;
    const ordinaryPerformanceCountBefore = ownershipConductor.startedMotifPerformances.length;
    const ordinaryActivation = ordinaryComponent
      ? ownershipConductor.startComponent(ownershipManager, ordinaryComponent.id, 2.03, "wavefront")
      : null;
    const ordinaryPerformanceCountDelta = ownershipConductor.startedMotifPerformances.length - ordinaryPerformanceCountBefore;
    return {
      enabled: motifSettings.enabled,
      assignedCount: assigned.length,
      ordinaryCount: ordinary.length,
      playableCount: playable.length,
      requestedCount: melodyConfig.motifCount,
      uniqueComponentCount: new Set(assigned.map((component) => component.id)).size,
      uniqueAbilityCount: new Set(assigned.map((component) => component.motifAbility.id)).size,
      minimumGridSeparation,
      familyCounts,
      librarySize: motifSettings.library.length,
      namedDefinitionCount: namedDefinitions.length,
      namedComposerCounts,
      maximumNamedPerComposer: Math.max(0, ...Object.values(namedComposerCounts)),
      ownership: {
        abilityTriggers,
        everyAbilityPlayedItsOwner: abilityTriggers.every((trigger) => trigger.activationStarted
          && trigger.performanceCountDelta === 1
          && trigger.performedComponentId === trigger.componentId
          && trigger.performedMotifId === trigger.abilityId),
        ordinaryComponentId: ordinaryComponent?.id ?? null,
        ordinaryActivationStarted: Boolean(ordinaryActivation),
        ordinaryPerformanceCountDelta,
      },
      allNamedFixedPitch: namedDefinitions.every((definition) => definition.transposePolicy === "fixed"
        && Number.isFinite(definition.rootPitch)
        && definition.notes.every((note) => definition.rootPitch + note.semitones >= 40 && definition.rootPitch + note.semitones <= 88)),
      abilities: assigned.map((component) => ({ componentId: component.id, ...component.motifAbility })),
      firstPerformance: firstPerformance ? {
        motifId: firstPerformance.motifId,
        eventCount: firstPerformance.events.length,
        events: firstPerformance.events.map((event) => ({
          at: Number(event.at.toFixed(4)), pitch: event.pitch, duration: event.duration,
          motifId: event.motifId, motifFamily: event.motifFamily, motifUnlocked: event.motifUnlocked,
        })),
      } : null,
      blockedDuringCooldown,
      replayAfterCooldown: Boolean(replayAfterCooldown),
      catchupEventCount: catchupEvents.length,
      globallyOffSuppresses,
      perAbilityOffSuppresses,
      customAbility,
      fixedCustomPitches: fixedCustomPerformance?.events.map((event) => event.pitch) || [],
    };
  }

  function inspectMotifAssignment(previewSeed = seed, requestedCount = melodyConfig.motifCount) {
    const previewWorld = buildWorld(String(previewSeed), motifSettings, requestedCount);
    const assigned = previewWorld.components.filter((component) => component.motifAbility);
    let minimumGridSeparation = Infinity;
    for (let left = 0; left < assigned.length; left += 1) {
      for (let right = left + 1; right < assigned.length; right += 1) {
        minimumGridSeparation = Math.min(minimumGridSeparation, Math.max(
          Math.abs(assigned[left].cell.row - assigned[right].cell.row),
          Math.abs(assigned[left].cell.col - assigned[right].cell.col),
        ));
      }
    }
    if (assigned.length < 2) minimumGridSeparation = null;
    return {
      assignedCount: assigned.length,
      minimumGridSeparation,
      abilities: assigned.map((component) => ({
        componentId: component.id,
        row: component.cell.row,
        column: component.cell.col,
        id: component.motifAbility.id,
        composer: component.motifAbility.composer,
        family: component.motifAbility.family,
      })),
    };
  }

  function auditMelodyHistoricalOccupancy() {
    const edgeAt = 2;
    const wakeStep = 1 / 60;
    const wavePredicate = (activation) => activation.mode === "melodyWave" && activation.melodySource !== "stroke";
    const cappedManager = new ActivationManager(world.components);
    const cappedConductor = new MelodyConductor(`${seed}:historical-cap`, world.components, melodyConfig, world.wallGraph, world.responseField, motifSettings);
    for (let componentId = 0; componentId < melodyConfig.componentLimit; componentId += 1) {
      const activation = cappedManager.start(componentId, edgeAt - 0.4, "melodyWave", 0, { cycleCount: 1 });
      activation.melodySource = "wavefront";
      // 刻意让插入顺序与完成顺序相反，覆盖 completed 尾部回扫依赖的排序契约。
      activation.completeAt = edgeAt + wakeStep * (0.12 + (melodyConfig.componentLimit - componentId) * 0.035);
      activation.movementDuration = activation.completeAt - activation.startedAt;
      activation.gestureDuration = activation.movementDuration;
    }
    cappedManager.update(edgeAt + wakeStep);
    const completedSorted = cappedManager.completed.every((activation, index, values) => index === 0
      || values[index - 1].completeAt <= activation.completeAt + 1e-9);
    const historicalWaveCount = cappedManager.activeCountAt(edgeAt, wavePredicate);
    const overCapStart = cappedConductor.startComponent(cappedManager, melodyConfig.componentLimit, edgeAt, "wavefront");

    const replayPath = (outerUpdateAt) => {
      const manager = new ActivationManager(world.components);
      const conductor = new MelodyConductor(`${seed}:historical-overlap:${outerUpdateAt}`, world.components, melodyConfig, world.wallGraph, world.responseField, motifSettings);
      const old = manager.start(0, edgeAt - 0.4, "melodyWave", 0, { cycleCount: 1 });
      old.melodySource = "wavefront";
      old.completeAt = edgeAt + wakeStep * 0.5;
      old.movementDuration = old.completeAt - old.startedAt;
      old.gestureDuration = old.movementDuration;
      manager.update(outerUpdateAt);
      const second = conductor.startComponent(manager, 0, edgeAt, "wavefront");
      manager.update(edgeAt + wakeStep);
      const third = conductor.startComponent(manager, 0, edgeAt + wakeStep, "wavefront");
      return {
        secondStarted: Boolean(second),
        thirdStarted: Boolean(third),
        activationCount: manager.allActivations.length,
        noOverlap: manager.allActivations.every((activation, index, values) => index === 0
          || values[index - 1].componentId !== activation.componentId
          || values[index - 1].completeAt <= activation.startedAt + 1e-9),
      };
    };
    const lowFrameRate = replayPath(edgeAt + wakeStep);
    const highFrameRate = replayPath(edgeAt);

    const latchManager = new ActivationManager(world.components);
    const latchConductor = new MelodyConductor(`${seed}:historical-latch`, world.components, melodyConfig, world.wallGraph, world.responseField, motifSettings);
    const target = world.components[0];
    const occupied = latchManager.start(target.id, edgeAt - 0.4, "melodyWave", 0, { cycleCount: 1 });
    occupied.melodySource = "wavefront";
    occupied.completeAt = edgeAt + wakeStep * 0.5;
    occupied.movementDuration = occupied.completeAt - occupied.startedAt;
    occupied.gestureDuration = occupied.movementDuration;
    latchConductor.addWave({ x: target.centerX, y: target.centerY, phraseId: 1, layer: 0, gainScale: 1 }, edgeAt, 1);
    latchManager.update(edgeAt + wakeStep);
    latchConductor.wakeComponentsAt(latchManager, edgeAt);
    const latchedWhileOccupied = latchConductor.componentWasAbove[target.id] === 1
      && latchManager.activationCounts.get(target.id) === 1;
    const releaseAt = edgeAt + melodyConfig.waveLife + 0.2;
    latchManager.update(releaseAt);
    latchConductor.wakeComponentsAt(latchManager, releaseAt);
    const releasedAfterLowField = latchConductor.componentWasAbove[target.id] === 0;
    const restartAt = releaseAt + 0.1;
    latchConductor.addWave({ x: target.centerX, y: target.centerY, phraseId: 2, layer: 1, gainScale: 1 }, restartAt, 1);
    latchConductor.wakeComponentsAt(latchManager, restartAt);
    const restartedAfterRelease = (latchManager.activationCounts.get(target.id) || 0) === 2;

    // 槽位满时消费这次阈值上升沿：波仍在时释放槽位也不能延迟补亮；场落下后新波才可再次触发。
    const deferredManager = new ActivationManager(world.components);
    const deferredConductor = new MelodyConductor(`${seed}:historical-deferred`, world.components, melodyConfig, world.wallGraph, world.responseField, motifSettings);
    for (let componentId = 0; componentId < melodyConfig.componentLimit; componentId += 1) {
      const active = deferredManager.start(componentId, edgeAt - 0.2, "melodyWave", 0, { cycleCount: 1 });
      active.melodySource = "wavefront";
      active.completeAt = edgeAt + wakeStep * 0.5;
      active.movementDuration = active.completeAt - active.startedAt;
      active.gestureDuration = active.movementDuration;
    }
    const deferredTarget = world.components[melodyConfig.componentLimit];
    const deferredContact = componentWaveContactPoints(deferredTarget)[0];
    deferredConductor.addWave({
      x: deferredContact.x,
      y: deferredContact.y,
      phraseId: 3,
      layer: 2,
      gainScale: 1,
    }, edgeAt, 1);
    const blockedWhileFull = deferredConductor.wakeComponentsAt(deferredManager, edgeAt) === 0;
    const skippedCandidateLatched = deferredConductor.componentWasAbove[deferredTarget.id] === 1
      && !deferredManager.activationCounts.has(deferredTarget.id);
    deferredManager.update(edgeAt + wakeStep);
    deferredConductor.wakeComponentsAt(deferredManager, edgeAt + wakeStep);
    const skippedCandidateNotRetried = !deferredManager.activationCounts.has(deferredTarget.id);
    const deferredReleaseAt = edgeAt + melodyConfig.waveLife + 0.2;
    deferredManager.update(deferredReleaseAt);
    deferredConductor.wakeComponentsAt(deferredManager, deferredReleaseAt);
    const skippedCandidateReleased = deferredConductor.componentWasAbove[deferredTarget.id] === 0;
    const deferredRestartAt = deferredReleaseAt + 0.1;
    deferredConductor.addWave({ x: deferredContact.x, y: deferredContact.y, phraseId: 4, layer: 3, gainScale: 1 }, deferredRestartAt, 1);
    deferredConductor.wakeComponentsAt(deferredManager, deferredRestartAt);
    const skippedCandidateRestartsAfterRelease = (deferredManager.activationCounts.get(deferredTarget.id) || 0) === 1;

    // 当前帧已经越过 waveLife 时，仍必须先补算稍早的固定 60 Hz 样本，再 prune；否则寿命末端的合成波峰会凭空丢失。
    const pruneManager = new ActivationManager(world.components);
    const pruneConductor = new MelodyConductor(`${seed}:historical-prune-boundary`, world.components, melodyConfig, world.wallGraph, world.responseField, motifSettings);
    const historicalSampleAt = pruneConductor.config.waveLife - 0.02;
    const currentFrameAt = pruneConductor.config.waveLife + 0.04;
    const boundaryDistances = new Float32Array(pruneConductor.waveX.length);
    boundaryDistances.fill(historicalSampleAt * pruneConductor.config.waveSpeed);
    for (let index = 0; index < 8; index += 1) {
      const wave = pruneConductor.addWave({ x: world.components[0].centerX, y: world.components[0].centerY, phraseId: 90 + index, layer: index % PHRASE_COLORS.length }, 0, 1.2);
      wave.distances = boundaryDistances;
      wave.fromDistances = boundaryDistances;
    }
    pruneConductor.nextWakeSampleAt = historicalSampleAt;
    pruneConductor.eventsBetween(historicalSampleAt - 0.01, currentFrameAt, false);
    const retainedUntilHistoricalWake = pruneConductor.waves.length + pruneConductor.pendingWaves.length === 8;
    const historicalBoundaryStarted = pruneConductor.wakeComponents(pruneManager, currentFrameAt) > 0;
    pruneConductor.prune(currentFrameAt);
    const prunedAfterHistoricalWake = pruneConductor.waves.length === 0;

    // 一个低帧率帧里批量到达 > maxWaves 个源时，必须先让早波参加它所属的历史 60 Hz 样本，
    // 再由稍后的源按事件时间执行容量淘汰；10/30/60 fps 应得到同一启动序列。
    const capRacePath = (outerStep) => {
      const manager = new ActivationManager(world.components);
      const conductor = new MelodyConductor(`${seed}:historical-wave-cap:${outerStep}`, world.components, melodyConfig, world.wallGraph, world.responseField, motifSettings);
      const target = world.components[0];
      const contactOffset = target.id * COMPONENT_WAVE_CONTACTS;
      const strongDistances = new Float32Array(conductor.waveX.length);
      strongDistances.fill(Infinity);
      for (let contact = 0; contact < COMPONENT_WAVE_CONTACTS; contact += 1) {
        strongDistances[conductor.componentContactWaveIndex[contactOffset + contact]] = 0;
      }
      const inertDistances = new Float32Array(conductor.waveX.length);
      inertDistances.fill(Infinity);
      const emissions = [{ at: 0.001, amplitude: 1.2, distances: strongDistances }];
      for (let index = 0; index < conductor.config.maxWaves; index += 1) {
        emissions.push({ at: 0.02 + index * 0.0015, amplitude: 1.2, distances: inertDistances });
      }
      let emissionIndex = 0;
      let peakActiveWaves = 0;
      for (let now = outerStep; now <= 0.14 + 1e-9; now += outerStep) {
        while (emissionIndex < emissions.length && emissions[emissionIndex].at <= now + 1e-9) {
          const emission = emissions[emissionIndex++];
          const wave = conductor.addWave({
            x: target.centerX, y: target.centerY, phraseId: 100 + emissionIndex, layer: emissionIndex % PHRASE_COLORS.length,
          }, emission.at, emission.amplitude);
          wave.distances = emission.distances;
          wave.fromDistances = emission.distances;
        }
        manager.update(now);
        conductor.wakeComponents(manager, now);
        peakActiveWaves = Math.max(peakActiveWaves, conductor.waves.length);
        conductor.prune(now);
      }
      return {
        sequence: conductor.startedActivations.length === 0 && manager.allActivations.length === 0 ? [] : manager.allActivations.map((activation) => ({
          componentId: activation.componentId,
          at: Number((activation.melodyTriggeredAt ?? activation.startedAt).toFixed(6)),
          waveId: activation.melodyTriggerWaveId,
        })),
        targetStarted: manager.allActivations.some((activation) => activation.componentId === target.id),
        peakActiveWaves,
      };
    };
    const capRace60 = capRacePath(1 / 60);
    const capRace30 = capRacePath(1 / 30);
    const capRace10 = capRacePath(0.1);
    const capRaceFrameRateInvariant = JSON.stringify(capRace60.sequence) === JSON.stringify(capRace30.sequence)
      && JSON.stringify(capRace60.sequence) === JSON.stringify(capRace10.sequence);
    const capRaceStayedBounded = [capRace60, capRace30, capRace10].every((entry) => entry.peakActiveWaves <= melodyConfig.maxWaves);

    // 已消费的强波仍主导可见峰时，弱波不能借它的后续波瓣取得新身份并让同一机关再闪一次。
    const borrowConfig = { ...melodyConfig, waveSpeed: 120, waveWidth: 140, componentPeriodScale: 0.25 };
    const borrowTarget = world.components.reduce((best, component) => basePeriod(component) < basePeriod(best) ? component : best, world.components[0]);
    const runIdentityBorrow = (withStrong, withWeak) => {
      const manager = new ActivationManager(world.components);
      const conductor = new MelodyConductor(`${seed}:identity-borrow:${withStrong}:${withWeak}`, world.components, borrowConfig, world.wallGraph, world.responseField, motifSettings);
      const contact = componentWaveContactPoints(borrowTarget)[1];
      const deterministicDistances = new Float32Array(conductor.waveX.length);
      deterministicDistances.fill(Infinity);
      const contactOffset = borrowTarget.id * COMPONENT_WAVE_CONTACTS;
      for (let contactIndex = 0; contactIndex < COMPONENT_WAVE_CONTACTS; contactIndex += 1) {
        deterministicDistances[conductor.componentContactWaveIndex[contactOffset + contactIndex]] = 0;
      }
      const waves = [];
      if (withStrong) waves.push(conductor.addWave({ x: contact.x, y: contact.y, phraseId: 201, layer: 0 }, 0, 1.2));
      if (withWeak) waves.push(conductor.addWave({ x: contact.x, y: contact.y, phraseId: 202, layer: 1 }, 0, 0.12));
      for (const wave of waves) {
        wave.distances = deterministicDistances;
        wave.fromDistances = deterministicDistances;
      }
      for (let now = 0; now <= 2 + 1e-9; now += 1 / 60) {
        manager.update(now);
        conductor.wakeComponents(manager, now);
        conductor.prune(now);
      }
      return { manager, conductor, waves };
    };
    const weakBorrow = runIdentityBorrow(false, true);
    const combinedBorrow = runIdentityBorrow(true, true);
    const combinedTargetActivations = combinedBorrow.manager.allActivations.filter((activation) => activation.componentId === borrowTarget.id);
    const borrowReleaseAt = combinedBorrow.conductor.config.waveLife + 0.2;
    combinedBorrow.manager.update(borrowReleaseAt);
    combinedBorrow.conductor.wakeComponentsAt(combinedBorrow.manager, borrowReleaseAt);
    combinedBorrow.conductor.prune(borrowReleaseAt);
    const borrowRestartAt = borrowReleaseAt + 0.1;
    const borrowContact = componentWaveContactPoints(borrowTarget)[1];
    const genuinelyNewWave = combinedBorrow.conductor.addWave({ x: borrowContact.x, y: borrowContact.y, phraseId: 203, layer: 2 }, borrowRestartAt, 1.2);
    combinedBorrow.conductor.wakeComponentsAt(combinedBorrow.manager, borrowRestartAt);
    const targetActivationsAfterNewWave = combinedBorrow.manager.allActivations.filter((activation) => activation.componentId === borrowTarget.id);
    return {
      historicalWaveCount,
      componentLimit: melodyConfig.componentLimit,
      completedSorted,
      capRejectsHistoricalOverfill: overCapStart === null,
      lowFrameRate,
      highFrameRate,
      secondWaveDecisionMatches: lowFrameRate.secondStarted === highFrameRate.secondStarted,
      thirdWaveCanRestart: lowFrameRate.thirdStarted && highFrameRate.thirdStarted,
      latchedWhileOccupied,
      releasedAfterLowField,
      restartedAfterRelease,
      skippedCandidateLatched: blockedWhileFull && skippedCandidateLatched,
      skippedCandidateNotRetried,
      skippedCandidateReleased,
      skippedCandidateRestartsAfterRelease,
      historicalPruneBoundaryPreserved: retainedUntilHistoricalWake && historicalBoundaryStarted && prunedAfterHistoricalWake,
      capRace60,
      capRace30,
      capRace10,
      capRaceFrameRateInvariant,
      capRaceStayedBounded,
      capRaceTargetPreserved: capRace60.targetStarted && capRace30.targetStarted && capRace10.targetStarted,
      weakWaveCannotBorrow: weakBorrow.manager.allActivations.filter((activation) => activation.componentId === borrowTarget.id).length === 0,
      consumedDominantCannotFallback: combinedTargetActivations.length === 1
        && combinedTargetActivations[0].melodyTriggerWaveId === combinedBorrow.waves[0].id,
      genuinelyNewWaveRestarts: targetActivationsAfterNewWave.length === 2
        && targetActivationsAfterNewWave[1].melodyTriggerWaveId === genuinelyNewWave.id,
    };
  }

  function auditDenseDetailRendering() {
    return {
      activeMode: denseDetailsMode,
      baseline: { detailDrawCount: world.components.length, responseReedCount: world.responseField.count },
      dense: { detailDrawCount: world.components.length * 4, responseReedCount: 0 },
      densePlus: { detailDrawCount: world.components.length * 4, responseReedCount: world.responseField.count },
      semanticComponentCount: world.components.length,
      hitTargetCount: world.components.length,
      wavePointCount: melodyConfig.waveCols * melodyConfig.waveRows,
      componentLimit: melodyConfig.componentLimit,
      mechanismVoiceLimit: melodyConfig.mechanismVoiceLimit,
      renderOnly: true,
    };
  }

  function auditResponseReedPolicy() {
    const conductor = new MelodyConductor(
      `${seed}:response-reed-policy`, world.components, melodyConfig,
      world.wallGraph, world.responseField, motifSettings,
    );
    const field = new Float64Array(conductor.config.waveCols * conductor.config.waveRows);
    const sampleWaveIndex = conductor.responseWaveIndex[Math.floor(conductor.responseField.count / 2)];
    const countBuckets = (values) => ({
      positive: values.slice(0, 5).reduce((sum, bucket) => sum + bucket.length, 0),
      negative: values.slice(5).reduce((sum, bucket) => sum + bucket.length, 0),
    });
    const prepareWithoutMutation = () => {
      const before = field.slice();
      const counts = countBuckets(conductor.prepareResponseReeds(field));
      const unchanged = field.every((value, index) => value === before[index]);
      return { ...counts, unchanged };
    };

    field.fill(RESPONSE_REED_VISIBLE_FLOOR - 0.001);
    const below = prepareWithoutMutation();
    field.fill(0);
    field[sampleWaveIndex] = RESPONSE_REED_VISIBLE_FLOOR;
    const positive = prepareWithoutMutation();
    field[sampleWaveIndex] = -RESPONSE_REED_VISIBLE_FLOOR;
    const negative = prepareWithoutMutation();
    return {
      visibleCrestFloor: RESPONSE_REED_VISIBLE_FLOOR,
      componentThreshold: conductor.config.componentThreshold,
      below,
      positive,
      negative,
      fieldUnchanged: below.unchanged && positive.unchanged && negative.unchanged,
    };
  }

  function auditWaveVisuals() {
    const field = new Float64Array([0, 0.02, 0.13, 0.5, 1]);
    const before = field.slice();
    const alphaSamples = Array.from(field, (energy) => ({ energy, alpha: waveTextureAlpha(energy) }));
    return {
      settings: { ...WAVE_VISUALS },
      alphaSamples,
      monotonic: alphaSamples.every((sample, index) => index === 0 || sample.alpha >= alphaSamples[index - 1].alpha),
      peakLayerAlpha: Number(((waveTextureAlpha(1) / 255) * WAVE_VISUALS.textureLayerAlpha).toFixed(6)),
      fieldUnchanged: field.every((value, index) => value === before[index]),
      physicalConfigIndependent: !Object.keys(WAVE_VISUALS).some((key) => key in MELODY_DEFAULTS),
    };
  }

  function melodyVisualState() {
    const last = trail.at(-1);
    return {
      trailPointCount: trail.length,
      hoverActive: Boolean(hoverTracking),
      hoverGestureId: hoverTracking?.id ?? null,
      lastTrailPoint: last ? { x: last.x, y: last.y, t: last.t, gestureId: last.gestureId, layer: last.layer } : null,
      waveTextureReady: Boolean(waveTextureImage?.data),
    };
  }

  function createLiveCaptureStream(fps = 30) {
    if (typeof canvas.captureStream !== "function") throw new Error("This browser does not support canvas.captureStream().");
    const frameRate = clamp(Number(fps) || 30, 1, 60);
    const stream = canvas.captureStream(frameRate);
    const audioStream = audio.getCaptureStream();
    if (!audioStream || typeof audioStream.getAudioTracks !== "function") {
      for (const track of stream.getTracks()) track.stop();
      throw new Error("The live WebAudio capture stream is unavailable.");
    }
    for (const track of audioStream.getAudioTracks()) stream.addTrack(track);
    return stream;
  }

  window.__KINETIC_V4_DEBUG__ = Object.freeze({
    version: "4.8-live-capture-r17",
    getSnapshot: () => ({ mode, ...manager.snapshot(logicalTime), interaction: interaction?.snapshot(logicalTime) || null, ripple: ripple?.snapshot(logicalTime) || null, melody: melody?.snapshot(logicalTime) || null, visual: melodyVisualState() }),
    getAudioState: () => audio.diagnostics(),
    createLiveCaptureStream,
    getComponents: () => world.components.map((component) => ({ id: component.id, type: component.type, basePeriod: basePeriod(component), tailDuration: tailDuration(component), eventCountPerCycle: eventBlueprints(component).length, motifAbility: component.motifAbility ? { ...component.motifAbility } : null, geometry: component.type === "glider" ? { edgeKeys: [...component.variant.route.edgeKeys] } : null })),
    getFrame: () => ({ ...FRAME, cellWidth: CELL_W, cellHeight: CELL_H }),
    getWaveVisuals: () => ({ ...WAVE_VISUALS }),
    getResponseField: () => ({ cols: world.responseField.cols, rows: world.responseField.rows, count: world.responseField.count }),
    getDenseDetailsExperiment: () => ({
      mode: denseDetailsMode,
      renderedDetailCount: denseDetailsMode === "off" ? world.components.length : world.components.length * 4,
      semanticComponentCount: world.components.length,
      hitTargetCount: world.components.length,
      responseReedCount: denseDetailsMode === "details" ? 0 : world.responseField.count,
      renderOnly: denseDetailsMode !== "off",
    }),
    getGrowthPlan: () => growth?.planSnapshot() || previewGrowth(seed, 0).plan,
    getLitRange: () => ({ ...litRange }),
    getRippleConfig: () => ({ ...rippleConfig }),
    getRippleDefaults: () => ({ ...RIPPLE_DEFAULTS }),
    resolveRippleConfig: (search, hostConfig) => ({ ...resolveRippleConfig(search, hostConfig) }),
    getMelodyConfig: () => ({ ...melodyConfig }),
    getMelodyDefaults: () => ({ ...MELODY_DEFAULTS }),
    resolveMelodyConfig: (search, hostConfig) => ({ ...resolveMelodyConfig(search, hostConfig) }),
    getMotifSettings: () => ({ enabled: motifSettings.enabled, disabledIds: [...motifSettings.disabledIds] }),
    getMotifLibrary: () => motifSettings.library.map(motifDefinitionSnapshot),
    resolveMotifSettings: (search, hostConfig) => {
      const resolved = resolveMotifSettings(search, hostConfig);
      return { enabled: resolved.enabled, disabledIds: [...resolved.disabledIds], library: resolved.library.map(motifDefinitionSnapshot) };
    },
    hitTestPoint: (x, y) => hitTestCanvasPoint(x, y)?.id ?? null,
    start: () => startExperience(),
    step: (seconds = 1 / 60) => {
      if (frameRequest !== null) { cancelAnimationFrame(frameRequest); frameRequest = null; }
      const base = previousTimestamp ?? 0;
      previousTimestamp = base;
      renderDirty = true;
      frame(base + Math.max(0, seconds) * 1000);
      return logicalTime;
    },
    sweepCells: (componentIds) => (mode === "ripple" ? (isBeacon ? ripple.stroke(componentIds, logicalTime, { id: ++gestureSequence, startedAt: logicalTime }).planted.length : ripple.seedMany(componentIds, logicalTime).length) : 0),
    isBeacon: () => isBeacon,
    isMelody: () => isMelody,
    auditDarkFreeze,
    auditGrowth,
    auditGeometry,
    auditClosedCycles,
    auditAutoplayPolicy,
    auditAudioSmoke,
    auditInteraction,
    auditPerformance,
    auditRipple,
    auditMelody,
    auditMelodyAudioCap,
    auditMelodyPerformance,
    auditMelodyComponentResponse,
    auditMotifAbilities,
    inspectMotifAssignment,
    auditMelodyHistoricalOccupancy,
    auditDenseDetailRendering,
    auditResponseReedPolicy,
    auditWaveVisuals,
    inspectWaveGraph,
    auditLineSourceField,
    previewWaveAccents,
    AudioEngine,
    previewGrowth,
    previewPerformance,
    previewInteraction,
    previewOneShot,
    previewRipple,
    previewMelody,
  });

  seedLabel.textContent = `Seed — ${seed}`;
  if (chromeHint) {
    if (isBeacon) chromeHint.textContent = "从亮着的地方把光引到下一座灯塔";
    else if (requestedMode === "ripple") chromeHint.textContent = "划过画面，机关会亮起并彼此唤醒";
    else chromeHint.textContent = "点击开始后 · 移动鼠标生波 · 触屏按住划线";
  }
  if (mode === "interactive") installInteractionRuntime();
  else if (mode === "growth") installGrowthRuntime();
  else installIdleRuntime();
  const metaBar = document.querySelector("#meta-bar");
  if (metaBar) metaBar.hidden = (requestedMode === "ripple" || isBeacon || isMelody) && new URLSearchParams(window.location.search).get("debug") === null;
  if (chrome) chrome.hidden = mode !== "idle";
  if (mode === "growth" && !performance.isExport && statusLabel) statusLabel.textContent = "自动生长（旧版演示）";
  render(world, manager, 0, interaction);
  presentWorld();
  frameRequest = mode === "idle" ? null : requestAnimationFrame(frame);

  // 页面隐藏 / 离开：静音并挂起音频（防止切后台后摩擦声残留），回来时恢复。rAF 由浏览器自动暂停/恢复。
  if (typeof document.addEventListener === "function") {
    const onHidden = () => { previousTimestamp = null; audio.sleep().catch(() => {}); };
    const onVisible = () => {
      previousTimestamp = null;
      lastEventTime = logicalTime;
      renderDirty = true;
      audio.wake().then(() => updateSoundControl()).catch(() => {});
      if (frameRequest === null && playing && mode !== "idle") frameRequest = requestAnimationFrame(frame);
    };
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") onHidden(); else onVisible(); });
    if (typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", onHidden);
      window.addEventListener("pageshow", onVisible);
      window.addEventListener("beforeunload", () => { audio.close().catch(() => {}); });
    }
  }
  if (mode !== "idle") {
    audio.attemptAutoplay().then((enabled) => {
      updateSoundControl();
      lastEventTime = logicalTime;
      if (!enabled && audio.intentOn && audio.diagnostics().contextState === "suspended") statusLabel.textContent = "点一下画面开启声音";
    }).catch((error) => {
      console.error(error);
      updateSoundControl();
    });
  }
})();
