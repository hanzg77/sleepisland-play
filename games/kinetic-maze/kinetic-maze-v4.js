(() => {
  "use strict";

  const WIDTH = 1080;
  const HEIGHT = 1920;
  const FRAME = Object.freeze({ x: 72, y: 160, width: 936, height: 1640 });
  const COLS = 9;
  const ROWS = 16;
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
  const hintLabel = document.querySelector("#hint-label");
  if (!(canvas instanceof HTMLCanvasElement) || !seedLabel || !statusLabel) {
    throw new Error("V4 page elements are missing.");
  }
  const draw = canvas.getContext("2d", { alpha: false });
  if (!draw) throw new Error("Canvas 2D is unavailable.");

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

  function hashString(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

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
    return mode === "interactive" || mode === "growth" ? mode : "ripple";
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
  });

  const RIPPLE_URL_KEYS = Object.freeze({
    lit: ["litMin", "litMax"], ramp: "rampSeconds", rampCurve: "rampCurve", wander: "wanderPeriods", wanderWeights: "wanderWeights", wanderDepth: "wanderDepth",
    boost: "boostPerSeed", boostDecay: "boostDecay", sparkAccent: "sparkAccent", sparkCap: "sparkCap", sparkGain: "sparkGain", sparkFloor: "sparkFloor",
    cycles: ["cyclesMin", "cyclesMax"], neighborOrthogonal: "neighborOrthogonal", neighborDiagonal: "neighborDiagonal", ring2Orthogonal: "ring2Orthogonal", ring2Diagonal: "ring2Diagonal",
    emberDelay: "emberDelay", trail: "trailSeconds", seedMark: "seedMarkSeconds", hint: "hintSeconds", sweepStep: "sweepStep",
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

  function buildWorld(seed) {
    const wallGraph = makeWallGraph(new SeededRandom(`${seed}:walls`));
    const random = new SeededRandom(`${seed}:components`);
    const types = makeTypeSequence(random);
    const components = types.map((type, id) => makeComponent(id, type, random, wallGraph));
    return { seed, components, wallGraph, segments: wallGraph.segments };
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
    const period = basePeriod(component);
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
      this.activationCounts = new Map();
      this.sequence = 0;
    }

    start(componentId, startedAt, mode = "oneShot", cycleIndex = 0, options = {}) {
      if (this.active.has(componentId)) return null;
      const component = this.components[componentId];
      if (!component) return null;
      const ordinal = this.activationCounts.get(componentId) || 0;
      const targetCount = options.targetCount || (mode === "oneShot" ? 1 : 0);
      const cycleCount = options.cycleCount || cycleCountFor(component, ordinal, targetCount, mode);
      const period = basePeriod(component);
      const movementDuration = period * cycleCount;
      const activation = {
        id: ++this.sequence,
        componentId,
        mode,
        cycleIndex: cycleIndex ?? ordinal,
        cycleCount,
        basePeriod: period,
        targetCount,
        startedAt,
        gestureDuration: movementDuration,
        movementDuration,
        tailDuration: 0,
        completeAt: startedAt + movementDuration,
        events: eventBlueprints(component, cycleCount),
      };
      this.activationCounts.set(componentId, ordinal + 1);
      this.active.set(componentId, activation);
      this.allActivations.push(activation);
      return activation;
    }

    update(now) {
      const finished = [];
      for (const [componentId, activation] of this.active) {
        if (now + 1e-9 < activation.completeAt) continue;
        this.active.delete(componentId);
        this.completed.push({ ...activation, completedAt: activation.completeAt });
        if (this.completed.length > 4096) this.completed.shift();
        finished.push(activation);
      }
      return finished.sort((left, right) => left.completeAt - right.completeAt || left.componentId - right.componentId);
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
      if (!activation || now < activation.startedAt || now >= activation.completeAt) return { phase: "darkFrozen", pose: restPose(component), activation: activation || null, progress: 0 };
      const localTime = clamp(now - activation.startedAt, 0, activation.movementDuration);
      const progress = localTime / activation.movementDuration;
      let phase = "active";
      if (progress < 0.04) phase = "anticipate";
      else if (progress >= 0.92) phase = "settle";
      return { phase, pose: activePose(component, localTime, activation), activation, progress };
    }

    eventsBetween(fromTime, toTime) {
      const events = [];
      for (const activation of this.active.values()) {
        const component = this.components[activation.componentId];
        for (const blueprint of activation.events) {
          const at = activation.startedAt + blueprint.offset;
          if (at > fromTime + 1e-9 && at <= toTime + 1e-9) {
            events.push({
              ...blueprint,
              at,
              activationId: activation.id,
              componentId: component.id,
              type: component.type,
              sourceU: (component.centerX - FRAME.x) / FRAME.width,
              layer: component.type === "mallet" ? "pulse" : component.type === "rotor" ? "harmony" : component.type === "pendulum" ? "material" : "flow",
              gainScale: component.type === "mallet" ? 0.72 : component.type === "rotor" ? 0.56 : component.type === "pendulum" ? 0.5 : component.type === "glider" ? 0.56 : 0.38,
            });
          }
        }
      }
      return events.sort((left, right) => left.at - right.at || left.componentId - right.componentId);
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
      return Math.min(nextSpark, nextCompletion, ember);
    }

    fireSparks(now) {
      const due = [];
      while (this.sparks.length && this.sparks[0].at <= now + 1e-9) due.push(this.sparks.shift());
      for (const spark of due) {
        if (this.manager.active.get(spark.componentId)?.id !== spark.activationId) continue;
        this.sparkCount += 1;
        const lit = this.manager.active.size;
        const target = this.target(now);
        const deficit = target - lit;
        const probability = clamp(deficit / Math.max(this.config.sparkFloor, target * this.config.sparkGain), 0, this.config.sparkCap);
        if (unitHash(this.seed, "spark", spark.activationId, spark.index) >= probability) continue;
        const parent = this.components[spark.componentId];
        let candidates = neighborCandidates(parent, this.components, this.manager.active, 1, this.config);
        if (!candidates.length) candidates = neighborCandidates(parent, this.components, this.manager.active, 2, this.config);
        if (!candidates.length) continue;
        const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
        let cursor = unitHash(this.seed, "pick", spark.activationId, spark.index) * total;
        let chosen = candidates.at(-1);
        for (const candidate of candidates) {
          cursor -= candidate.weight;
          if (cursor <= 0) { chosen = candidate; break; }
        }
        if (this.light(chosen.id, now, "spark")) this.spawnCount += 1;
      }
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
      events.push(...manager.eventsBetween(cursor, boundary));
      cursor = boundary;
      const boundaryFinished = manager.update(boundary);
      conductor.handleFinished(boundaryFinished, boundary);
      conductor.fireEmber(boundary);
      conductor.fireSparks(boundary);
      finished.push(...boundaryFinished);
    }
    events.push(...manager.eventsBetween(cursor, toTime));
    return { events, finished };
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
    constructor(intentOn = true) {
      this.context = null;
      this.master = null;
      this.intentOn = intentOn;
      this.enabled = false;
      this.scheduledEventCount = 0;
      this.gliderContactEvents = 0;
      this.gliderFrictionStarts = 0;
      this.frictionVoices = new Map();
      this.frictionBuffer = null;
    }

    initialize() {
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
      const master = context.createGain();
      highpass.type = "highpass";
      highpass.frequency.value = 72;
      lowpass.type = "lowpass";
      lowpass.frequency.value = 8800;
      compressor.threshold.value = -19;
      compressor.knee.value = 5;
      compressor.ratio.value = 2.4;
      compressor.attack.value = 0.012;
      compressor.release.value = 0.16;
      master.gain.value = 0.0001;
      highpass.connect(lowpass);
      lowpass.connect(compressor);
      compressor.connect(master);
      master.connect(context.destination);
      this.context = context;
      this.input = highpass;
      this.master = master;
      const length = Math.round(context.sampleRate * 0.72);
      this.frictionBuffer = context.createBuffer(1, length, context.sampleRate);
      const values = this.frictionBuffer.getChannelData(0);
      let state = hashString("v4-glider-friction");
      for (let index = 0; index < values.length; index += 1) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        values[index] = ((state >>> 0) / 2147483648 - 1) * 0.42;
      }
      return true;
    }

    async toggle() {
      if (this.enabled) {
        this.intentOn = false;
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
      this.master.gain.setTargetAtTime(this.enabled ? 0.9 : 0.0001, now, 0.025);
      if (!this.enabled) this.stopAllFriction();
      return this.enabled;
    }

    async ensureEnabled() {
      this.intentOn = true;
      if (!this.initialize()) return false;
      if (this.context.state !== "running") {
        try { await this.context.resume(); } catch (_) { return false; }
      }
      if (this.context.state !== "running") return false;
      return this.setEnabled(true);
    }

    async attemptAutoplay() {
      if (!this.intentOn || !this.initialize()) return false;
      if (this.context.state !== "running") {
        try { await this.context.resume(); } catch (_) { /* Browser gesture policy. */ }
      }
      return this.context.state === "running" ? this.setEnabled(true) : false;
    }

    panner(sourceU) {
      if (typeof this.context.createStereoPanner === "function") {
        const panner = this.context.createStereoPanner();
        panner.pan.value = clamp((sourceU - 0.5) * 1.35, -0.72, 0.72);
        return panner;
      }
      return this.context.createGain();
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
      oscillator.start(when);
      oscillator.stop(when + options.decay + 0.04);
    }

    noise(event, when, options) {
      const length = Math.round(this.context.sampleRate * options.decay);
      const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
      const values = buffer.getChannelData(0);
      let state = hashString(`${event.activationId}:${event.componentId}:${event.kind}`);
      for (let index = 0; index < values.length; index += 1) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        values[index] = ((state >>> 0) / 2147483648 - 1) * 0.58;
      }
      const source = this.context.createBufferSource();
      const filter = this.context.createBiquadFilter();
      const gain = this.context.createGain();
      const panner = this.panner(event.sourceU);
      source.buffer = buffer;
      filter.type = options.filterType || "bandpass";
      filter.frequency.value = options.frequency;
      filter.Q.value = options.q || 0.8;
      gain.gain.setValueAtTime(options.gain * event.accent * event.gainScale, when);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + options.decay);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(panner);
      panner.connect(this.input);
      source.start(when);
      source.stop(when + options.decay + 0.02);
    }

    startFriction(activation, component) {
      if (!this.enabled || !this.context || !this.frictionBuffer || this.frictionVoices.has(activation.id)) return;
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
      for (const activationId of [...this.frictionVoices.keys()]) this.stopFriction(activationId);
    }

    syncFriction(activeActivations, components, logicalNow, litCount) {
      if (!this.enabled || this.context?.state !== "running") { this.stopAllFriction(); return; }
      const desired = new Set();
      const densityScale = Math.min(1, Math.sqrt(18 / Math.max(18, litCount)));
      for (const activation of activeActivations) {
        const component = components[activation.componentId];
        if (component?.type !== "glider" || logicalNow < activation.startedAt || logicalNow >= activation.completeAt) continue;
        desired.add(activation.id);
        this.startFriction(activation, component);
        const voice = this.frictionVoices.get(activation.id);
        if (!voice) continue;
        const progress = ((logicalNow - activation.startedAt) % activation.basePeriod) / activation.basePeriod;
        const speed = Math.abs(Math.sin(progress * TAU));
        const materialScale = component.variant.material === "felt" ? 0.65 : component.variant.material === "metal" ? 1.08 : 0.88;
        voice.gain.gain.setTargetAtTime(0.0001 + speed * 0.012 * materialScale * densityScale, this.context.currentTime, 0.035);
      }
      for (const activationId of [...this.frictionVoices.keys()]) if (!desired.has(activationId)) this.stopFriction(activationId);
    }

    play(events, logicalNow, litCount = 1) {
      if (!this.enabled || this.context?.state !== "running") return;
      const base = this.context.currentTime;
      const densityScale = Math.min(1, Math.sqrt(16 / Math.max(16, litCount)));
      for (const event of events) {
        const mixedEvent = { ...event, gainScale: event.gainScale * densityScale };
        const when = base + clamp(event.at - logicalNow + 0.014, 0.005, 0.06);
        this.scheduledEventCount += 1;
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
        } else if (event.kind === "ribbon-tap") {
          this.tone(mixedEvent, when, { wave: "sine", gain: 0.034, attack: 0.012, decay: 0.34 });
        } else {
          this.noise(mixedEvent, when, { frequency: 1180, q: 0.7, gain: 0.026, decay: 0.16 });
        }
      }
    }

    diagnostics() {
      return { intentOn: this.intentOn, initialized: Boolean(this.context), contextState: this.context?.state || "unavailable", enabled: this.enabled, scheduledEventCount: this.scheduledEventCount, gliderContactEvents: this.gliderContactEvents, gliderFrictionStarts: this.gliderFrictionStarts, activeFrictionVoices: this.frictionVoices.size };
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

  function drawGrid(world) {
    draw.fillStyle = COLORS.background;
    draw.fillRect(0, 0, WIDTH, HEIGHT);
    draw.strokeStyle = COLORS.gridStrong;
    draw.lineWidth = 4;
    draw.strokeRect(FRAME.x, FRAME.y, FRAME.width, FRAME.height);
    draw.strokeStyle = COLORS.grid;
    draw.lineWidth = 3;
    draw.beginPath();
    for (const segment of world.segments) {
      draw.moveTo(segment.x1, segment.y1);
      draw.lineTo(segment.x2, segment.y2);
    }
    draw.stroke();
  }

  function styleFor(component, state) {
    const active = state.phase !== "darkFrozen";
    draw.strokeStyle = active ? TYPE_COLORS[component.type] : COLORS.dark;
    draw.fillStyle = active ? TYPE_COLORS[component.type] : COLORS.dark;
    draw.globalAlpha = active ? 0.82 + state.pose.energy * 0.18 : 0.32;
    draw.lineWidth = active ? 3.4 : 2.1;
    if (active) {
      draw.shadowColor = TYPE_COLORS[component.type];
      draw.shadowBlur = 8 + state.pose.energy * 15;
    }
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
    draw.beginPath(); draw.arc(anchor.x, anchor.y, 3.2, 0, TAU); draw.fill();
    draw.beginPath(); draw.arc(x, y, 9.5, 0, TAU); draw.fill();
  }

  function drawGlider(component, state) {
    const { size, route } = component.variant;
    const { x, y } = pointAlongRoute(route, state.pose.value);
    draw.fillRect(x - size / 2, y - size / 2, size, size);
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
    draw.beginPath(); draw.arc(x, y, 7.5, 0, TAU); draw.fill();
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
      draw.beginPath(); draw.arc(anchor.x, anchor.y, 2.8, 0, TAU); draw.fill();
      draw.beginPath(); draw.arc(headX, headY, 7.5, 0, TAU); draw.fill();
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
    draw.beginPath(); draw.arc(point.x, point.y, 7.5, 0, TAU); draw.fill();
  }

  function drawComponent(component, state) {
    draw.save();
    styleFor(component, state);
    if (component.type === "pendulum") drawPendulum(component, state);
    else if (component.type === "glider") drawGlider(component, state);
    else if (component.type === "rotor") drawRotor(component, state);
    else if (component.type === "mallet") drawMallet(component, state);
    else drawRibbon(component, state);
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
    drawGrid(world);
    for (const component of world.components) drawComponent(component, manager.stateFor(component, now));
    drawInteractionOverlay(interaction, now);
  }

  function hitTestCanvasPoint(x, y) {
    if (x < FRAME.x || x >= FRAME.x + FRAME.width || y < FRAME.y || y >= FRAME.y + FRAME.height) return null;
    const col = Math.floor((x - FRAME.x) / CELL_W);
    const row = Math.floor((y - FRAME.y) / CELL_H);
    const id = row * COLS + col;
    return world.components[id] || null;
  }

  const seed = querySeed();
  const world = buildWorld(seed);
  const audio = new AudioEngine(querySoundIntent());
  const performance = queryPerformance();
  const rippleConfig = resolveRippleConfig(window.location.search, window.KINETIC_MAZE_CONFIG?.ripple);
  const litRange = Object.freeze({ min: rippleConfig.litMin, max: rippleConfig.litMax });
  let manager = null;
  let growth = null;
  let ripple = null;
  let interaction = null;
  const requestedMode = performance.isExport ? "growth" : queryMode();
  let mode = requestedMode === "ripple" ? "idle" : requestedMode;
  let logicalTime = 0;
  let previousTimestamp = null;
  let lastEventTime = 0;
  let playing = true;
  let frameRequest = null;
  const trail = [];
  const seedMarks = [];
  let pointerTracking = null;
  let hintUntil = 0;

  function updateModeControl() {
    canvas.classList.toggle("is-interactive", mode === "interactive" || mode === "ripple");
  }

  function updateSoundControl() {
    const state = audio.diagnostics();
    if (statusLabel && !state.enabled && state.intentOn && state.contextState === "suspended" && mode !== "idle") statusLabel.textContent = "点一下画面开启声音";
  }

  function installGrowthRuntime() {
    manager = new ActivationManager(world.components);
    growth = new PopulationConductor(seed, world.components, manager, { exportMode: performance.isExport });
    ripple = null;
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
    interaction = null;
    ripple = new RippleConductor(seed, world.components, manager, rippleConfig);
    mode = "ripple";
    logicalTime = 0;
    lastEventTime = 0;
    previousTimestamp = null;
    trail.length = 0;
    seedMarks.length = 0;
    ripple.fireEmber(0);
    hintUntil = rippleConfig.hintSeconds;
    updateModeControl();
  }

  function installIdleRuntime() {
    manager = new ActivationManager(world.components);
    growth = null;
    ripple = null;
    interaction = null;
    mode = "idle";
    logicalTime = 0;
    lastEventTime = 0;
    previousTimestamp = null;
    updateModeControl();
  }

  function frame(timestamp) {
    if (!playing) return;
    if (mode === "idle") {
      frameRequest = requestAnimationFrame(frame);
      return;
    }
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
    } else {
      events = manager.eventsBetween(lastEventTime, logicalTime);
      finished = manager.update(logicalTime);
    }
    audio.play(events, logicalTime, manager.snapshot(logicalTime).litCount);
    lastEventTime = logicalTime;
    if (mode === "interactive") interaction.handleFinished(finished);
    const snapshot = manager.snapshot(logicalTime);
    audio.syncFriction(snapshot.active, world.components, logicalTime, snapshot.litCount);
    render(world, manager, logicalTime, interaction);
    if (mode === "ripple") drawRippleOverlay(logicalTime);
    if (mode === "growth") {
      statusLabel.textContent = `${Math.floor(logicalTime)}s · ${snapshot.litCount}/${MAX_LIT} 已亮 · 全部正在演奏`;
    } else if (mode === "ripple") {
      const rippleSnapshot = ripple.snapshot(logicalTime);
      statusLabel.textContent = `${Math.floor(logicalTime)}s · ${snapshot.litCount} 已亮 · 目标 ${Math.round(rippleSnapshot.target)} · 区间 ${litRange.min}–${litRange.max}`;
    } else if (mode === "interactive") {
      const interactionSnapshot = interaction.snapshot(logicalTime);
      statusLabel.textContent = `${interactionSnapshot.active.length} 正在完整演奏 · ${interactionSnapshot.queue.length} 排队`;
    }
    frameRequest = requestAnimationFrame(frame);
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
      const alpha = (1 - age) * 0.55;
      if (alpha <= 0.01) continue;
      draw.strokeStyle = COLORS.halo;
      draw.globalAlpha = alpha;
      draw.lineWidth = lerp(16, 3, age);
      draw.shadowColor = COLORS.halo;
      draw.shadowBlur = lerp(28, 6, age);
      draw.beginPath();
      draw.moveTo(from.x, from.y);
      draw.lineTo(to.x, to.y);
      draw.stroke();
    }
    draw.shadowBlur = 0;
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
  }

  function canvasPointFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * WIDTH / rect.width, y: (event.clientY - rect.top) * HEIGHT / rect.height };
  }

  /** 沿指针轨迹采样命中的格子（按经过顺序去重），快速划过也不会漏格。 */
  function cellsAlongSegment(from, to) {
    const ids = [];
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / (Math.min(CELL_W, CELL_H) * rippleConfig.sweepStep)));
    let previous = null;
    for (let step = 0; step <= steps; step += 1) {
      const amount = step / steps;
      const component = hitTestCanvasPoint(lerp(from.x, to.x, amount), lerp(from.y, to.y, amount));
      if (!component || component.id === previous) continue;
      previous = component.id;
      if (!ids.includes(component.id)) ids.push(component.id);
    }
    return ids;
  }

  function sweep(point, event) {
    const from = pointerTracking?.last ?? point;
    const ids = cellsAlongSegment(from, point);
    trail.push({ x: point.x, y: point.y, t: logicalTime });
    if (trail.length > 240) trail.shift();
    pointerTracking = { last: point, pointerId: event.pointerId };
    const fresh = ids.filter((id) => !manager.active.has(id));
    if (!fresh.length) return;
    const started = ripple.seedMany(fresh, logicalTime);
    for (const activation of started) {
      const component = world.components[activation.componentId];
      seedMarks.push({ x: component.centerX, y: component.centerY, t: logicalTime, color: TYPE_COLORS[component.type] });
    }
    if (seedMarks.length > 96) seedMarks.splice(0, seedMarks.length - 96);
  }

  function pointerIsSweeping(event) {
    if (event.pointerType === "mouse") return true;
    return event.buttons > 0 || event.pressure > 0 || event.type === "pointerdown";
  }

  async function startExperience() {
    if (mode !== "idle") return;
    installRippleRuntime();
    if (chrome) chrome.hidden = true;
    if (hintLabel) { hintLabel.hidden = false; hintLabel.style.opacity = "1"; }
    try {
      await audio.ensureEnabled();
    } catch (error) {
      console.error(error);
    }
    updateSoundControl();
    lastEventTime = logicalTime;
  }

  if (startControl) startControl.addEventListener("click", () => { startExperience(); });

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (mode === "idle") return;
    if (!audio.enabled && audio.intentOn) {
      audio.ensureEnabled().then(() => { updateSoundControl(); lastEventTime = logicalTime; }).catch((error) => console.error(error));
    }
    if (mode === "ripple") {
      pointerTracking = null;
      sweep(canvasPointFromEvent(event), event);
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
    if (mode !== "ripple" || !pointerIsSweeping(event)) return;
    event.preventDefault();
    if (pointerTracking && pointerTracking.pointerId !== event.pointerId) return;
    const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    for (const sample of samples.length ? samples : [event]) sweep(canvasPointFromEvent(sample), event);
  });

  const endSweep = (event) => {
    if (pointerTracking && pointerTracking.pointerId === event.pointerId) pointerTracking = null;
    if (event.pointerType === "mouse") pointerTracking = null;
  };
  canvas.addEventListener("pointerup", endSweep);
  canvas.addEventListener("pointercancel", endSweep);
  canvas.addEventListener("pointerleave", endSweep);

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

  window.__KINETIC_V4_DEBUG__ = Object.freeze({
    version: "4.3-ripple-t1",
    getSnapshot: () => ({ mode, ...manager.snapshot(logicalTime), interaction: interaction?.snapshot(logicalTime) || null, ripple: ripple?.snapshot(logicalTime) || null }),
    getAudioState: () => audio.diagnostics(),
    getComponents: () => world.components.map((component) => ({ id: component.id, type: component.type, basePeriod: basePeriod(component), tailDuration: tailDuration(component), eventCountPerCycle: eventBlueprints(component).length, geometry: component.type === "glider" ? { edgeKeys: [...component.variant.route.edgeKeys] } : null })),
    getGrowthPlan: () => growth?.planSnapshot() || previewGrowth(seed, 0).plan,
    getLitRange: () => ({ ...litRange }),
    getRippleConfig: () => ({ ...rippleConfig }),
    getRippleDefaults: () => ({ ...RIPPLE_DEFAULTS }),
    resolveRippleConfig: (search, hostConfig) => ({ ...resolveRippleConfig(search, hostConfig) }),
    hitTestPoint: (x, y) => hitTestCanvasPoint(x, y)?.id ?? null,
    start: () => startExperience(),
    step: (seconds = 1 / 60) => {
      if (frameRequest !== null) cancelAnimationFrame(frameRequest);
      const base = previousTimestamp ?? 0;
      previousTimestamp = base;
      frame(base + Math.max(0, seconds) * 1000);
      return logicalTime;
    },
    sweepCells: (componentIds) => (mode === "ripple" ? ripple.seedMany(componentIds, logicalTime).length : 0),
    auditDarkFreeze,
    auditGrowth,
    auditGeometry,
    auditClosedCycles,
    auditAutoplayPolicy,
    auditAudioSmoke,
    auditInteraction,
    auditPerformance,
    auditRipple,
    previewGrowth,
    previewPerformance,
    previewInteraction,
    previewOneShot,
    previewRipple,
  });

  seedLabel.textContent = `Seed — ${seed}`;
  if (mode === "interactive") installInteractionRuntime();
  else if (mode === "growth") installGrowthRuntime();
  else installIdleRuntime();
  const metaBar = document.querySelector("#meta-bar");
  if (metaBar) metaBar.hidden = requestedMode === "ripple" && new URLSearchParams(window.location.search).get("debug") === null;
  if (chrome) chrome.hidden = mode !== "idle";
  if (mode === "growth" && !performance.isExport && statusLabel) statusLabel.textContent = "自动生长（旧版演示）";
  render(world, manager, 0, interaction);
  frameRequest = requestAnimationFrame(frame);
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
