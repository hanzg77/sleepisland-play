#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(ROOT, "kinetic-maze-v4.js");
const FFMPEG = "/usr/local/bin/ffmpeg";
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const EXPORT_DURATION = 180;
const TAU = Math.PI * 2;
const COLORS = ["#e2b85f", "#70b28d", "#69acd0", "#df7d60", "#ad8bd0"];

function parseArguments(values) {
  const result = { duration: EXPORT_DURATION, seed: "v4-three-minute", output: path.join(ROOT, "exports", "kinetic-maze-v4-3min.mp4") };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--duration") result.duration = Number(values[++index]);
    else if (value === "--seed") result.seed = values[++index];
    else if (value === "--output") result.output = path.resolve(values[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!(result.duration > 0 && result.duration <= EXPORT_DURATION)) throw new Error("--duration must be in (0, 180].");
  return result;
}

function number(value) {
  return Number(value.toFixed(3));
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

class SvgContext {
  constructor() {
    this.stack = [];
    this.resetStyle();
    this.beginFrame();
  }

  resetStyle() {
    this.fillStyle = "#000000";
    this.strokeStyle = "#000000";
    this.globalAlpha = 1;
    this.lineWidth = 1;
    this.shadowColor = "transparent";
    this.shadowBlur = 0;
    this.font = "10px sans-serif";
    this.textAlign = "start";
    this.textBaseline = "alphabetic";
  }

  beginFrame() {
    this.operations = [];
    this.path = [];
  }

  save() {
    this.stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha, lineWidth: this.lineWidth, shadowColor: this.shadowColor, shadowBlur: this.shadowBlur, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline });
  }

  restore() {
    const state = this.stack.pop();
    if (state) Object.assign(this, state);
  }

  beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push(`M ${number(x)} ${number(y)}`); }
  lineTo(x, y) { this.path.push(`L ${number(x)} ${number(y)}`); }

  arc(x, y, radius, start, end, anticlockwise = false) {
    const span = anticlockwise ? start - end : end - start;
    const absoluteSpan = Math.abs(span);
    const startX = x + Math.cos(start) * radius;
    const startY = y + Math.sin(start) * radius;
    if (absoluteSpan >= TAU - 1e-6) {
      this.path.push(`M ${number(x + radius)} ${number(y)} A ${number(radius)} ${number(radius)} 0 1 0 ${number(x - radius)} ${number(y)} A ${number(radius)} ${number(radius)} 0 1 0 ${number(x + radius)} ${number(y)} Z`);
      return;
    }
    const endX = x + Math.cos(end) * radius;
    const endY = y + Math.sin(end) * radius;
    if (this.path.length === 0) this.path.push(`M ${number(startX)} ${number(startY)}`);
    else this.path.push(`L ${number(startX)} ${number(startY)}`);
    this.path.push(`A ${number(radius)} ${number(radius)} 0 ${absoluteSpan > Math.PI ? 1 : 0} ${anticlockwise ? 0 : 1} ${number(endX)} ${number(endY)}`);
  }

  filterAttribute() {
    if (!(this.shadowBlur > 0) || !COLORS.includes(this.shadowColor)) return "";
    return ` filter="url(#glow-${COLORS.indexOf(this.shadowColor)})"`;
  }

  fill() {
    if (!this.path.length) return;
    this.operations.push(`<path d="${this.path.join(" ")}" fill="${escapeXml(this.fillStyle)}" opacity="${number(this.globalAlpha)}"${this.filterAttribute()}/>`);
  }

  stroke() {
    if (!this.path.length) return;
    this.operations.push(`<path d="${this.path.join(" ")}" fill="none" stroke="${escapeXml(this.strokeStyle)}" stroke-width="${number(this.lineWidth)}" stroke-linecap="round" stroke-linejoin="round" opacity="${number(this.globalAlpha)}"${this.filterAttribute()}/>`);
  }

  fillRect(x, y, width, height) {
    this.operations.push(`<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" fill="${escapeXml(this.fillStyle)}" opacity="${number(this.globalAlpha)}"${this.filterAttribute()}/>`);
  }

  strokeRect(x, y, width, height) {
    this.operations.push(`<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" fill="none" stroke="${escapeXml(this.strokeStyle)}" stroke-width="${number(this.lineWidth)}" opacity="${number(this.globalAlpha)}"/>`);
  }

  fillText(value, x, y) {
    this.operations.push(`<text x="${number(x)}" y="${number(y)}" fill="${escapeXml(this.fillStyle)}" opacity="${number(this.globalAlpha)}" text-anchor="middle">${escapeXml(value)}</text>`);
  }

  toSvg() {
    const filters = COLORS.map((color, index) => `<filter id="glow-${index}" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="5.5" result="blur"/><feFlood flood-color="${color}" flood-opacity="0.65"/><feComposite in2="blur" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><defs>${filters}</defs>${this.operations.join("")}</svg>`;
  }
}

class RasterContext {
  constructor(width = 540, height = 960) {
    this.width = width;
    this.height = height;
    this.scaleX = width / WIDTH;
    this.scaleY = height / HEIGHT;
    this.pixels = new Uint8Array(width * height * 3);
    this.colorCache = new Map();
    this.stack = [];
    this.resetStyle();
    this.beginFrame();
  }

  resetStyle() {
    this.fillStyle = "#000000"; this.strokeStyle = "#000000"; this.globalAlpha = 1; this.lineWidth = 1;
    this.shadowColor = "transparent"; this.shadowBlur = 0; this.font = "10px sans-serif"; this.textAlign = "start"; this.textBaseline = "alphabetic";
  }

  beginFrame() { this.path = []; }
  save() { this.stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha, lineWidth: this.lineWidth, shadowColor: this.shadowColor, shadowBlur: this.shadowBlur, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline }); }
  restore() { const state = this.stack.pop(); if (state) Object.assign(this, state); }
  beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push({ kind: "move", x: x * this.scaleX, y: y * this.scaleY }); }
  lineTo(x, y) { this.path.push({ kind: "line", x: x * this.scaleX, y: y * this.scaleY }); }
  arc(x, y, radius, start, end, anticlockwise = false) { this.path.push({ kind: "arc", x: x * this.scaleX, y: y * this.scaleY, radius: radius * this.scaleX, start, end, anticlockwise }); }

  color(value) {
    if (this.colorCache.has(value)) return this.colorCache.get(value);
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    const color = match ? [parseInt(match[1].slice(0, 2), 16), parseInt(match[1].slice(2, 4), 16), parseInt(match[1].slice(4, 6), 16)] : [255, 255, 255];
    this.colorCache.set(value, color);
    return color;
  }

  pixel(x, y, color, alpha) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height || alpha <= 0) return;
    const index = (y * this.width + x) * 3;
    const inverse = 1 - Math.min(1, alpha);
    this.pixels[index] = Math.round(this.pixels[index] * inverse + color[0] * alpha);
    this.pixels[index + 1] = Math.round(this.pixels[index + 1] * inverse + color[1] * alpha);
    this.pixels[index + 2] = Math.round(this.pixels[index + 2] * inverse + color[2] * alpha);
  }

  disc(cx, cy, radius, color, alpha) {
    const minimumX = Math.max(0, Math.floor(cx - radius - 1)); const maximumX = Math.min(this.width - 1, Math.ceil(cx + radius + 1));
    const minimumY = Math.max(0, Math.floor(cy - radius - 1)); const maximumY = Math.min(this.height - 1, Math.ceil(cy + radius + 1));
    for (let y = minimumY; y <= maximumY; y += 1) for (let x = minimumX; x <= maximumX; x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const coverage = Math.max(0, Math.min(1, radius + 0.7 - distance));
      if (coverage > 0) this.pixel(x, y, color, alpha * coverage);
    }
  }

  ring(cx, cy, radius, width, color, alpha) {
    const half = width / 2;
    const minimumX = Math.max(0, Math.floor(cx - radius - half - 1)); const maximumX = Math.min(this.width - 1, Math.ceil(cx + radius + half + 1));
    const minimumY = Math.max(0, Math.floor(cy - radius - half - 1)); const maximumY = Math.min(this.height - 1, Math.ceil(cy + radius + half + 1));
    for (let y = minimumY; y <= maximumY; y += 1) for (let x = minimumX; x <= maximumX; x += 1) {
      const distance = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius);
      const coverage = Math.max(0, Math.min(1, half + 0.7 - distance));
      if (coverage > 0) this.pixel(x, y, color, alpha * coverage);
    }
  }

  segment(x1, y1, x2, y2, width, color, alpha) {
    const radius = width / 2;
    const minimumX = Math.max(0, Math.floor(Math.min(x1, x2) - radius - 1)); const maximumX = Math.min(this.width - 1, Math.ceil(Math.max(x1, x2) + radius + 1));
    const minimumY = Math.max(0, Math.floor(Math.min(y1, y2) - radius - 1)); const maximumY = Math.min(this.height - 1, Math.ceil(Math.max(y1, y2) + radius + 1));
    const dx = x2 - x1; const dy = y2 - y1; const denominator = dx * dx + dy * dy;
    for (let y = minimumY; y <= maximumY; y += 1) for (let x = minimumX; x <= maximumX; x += 1) {
      const amount = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((x + 0.5 - x1) * dx + (y + 0.5 - y1) * dy) / denominator));
      const distance = Math.hypot(x + 0.5 - (x1 + amount * dx), y + 0.5 - (y1 + amount * dy));
      const coverage = Math.max(0, Math.min(1, radius + 0.7 - distance));
      if (coverage > 0) this.pixel(x, y, color, alpha * coverage);
    }
  }

  shadow(kind, data) {
    if (!(this.shadowBlur > 0) || !COLORS.includes(this.shadowColor)) return;
    const color = this.color(this.shadowColor); const alpha = this.globalAlpha * 0.16;
    if (kind === "disc") this.disc(data.x, data.y, data.radius + 4, color, alpha);
    else if (kind === "ring") this.ring(data.x, data.y, data.radius, data.width + 8, color, alpha);
    else if (kind === "segment") this.segment(data.x1, data.y1, data.x2, data.y2, data.width + 8, color, alpha);
    else if (kind === "rect") this.rectangle(data.x - 3, data.y - 3, data.width + 6, data.height + 6, color, alpha);
  }

  rectangle(x, y, width, height, color, alpha) {
    const minimumX = Math.max(0, Math.floor(x)); const maximumX = Math.min(this.width, Math.ceil(x + width));
    const minimumY = Math.max(0, Math.floor(y)); const maximumY = Math.min(this.height, Math.ceil(y + height));
    for (let py = minimumY; py < maximumY; py += 1) for (let px = minimumX; px < maximumX; px += 1) this.pixel(px, py, color, alpha);
  }

  stroke() {
    const color = this.color(this.strokeStyle); const width = this.lineWidth * this.scaleX; let prior = null;
    for (const command of this.path) {
      if (command.kind === "move") prior = command;
      else if (command.kind === "line") {
        if (prior) { this.shadow("segment", { x1: prior.x, y1: prior.y, x2: command.x, y2: command.y, width }); this.segment(prior.x, prior.y, command.x, command.y, width, color, this.globalAlpha); }
        prior = command;
      } else if (command.kind === "arc") {
        const span = Math.abs(command.end - command.start);
        if (span >= TAU - 1e-5) { this.shadow("ring", { ...command, width }); this.ring(command.x, command.y, command.radius, width, color, this.globalAlpha); }
      }
    }
  }

  fill() {
    const color = this.color(this.fillStyle);
    for (const command of this.path) if (command.kind === "arc" && Math.abs(command.end - command.start) >= TAU - 1e-5) {
      this.shadow("disc", command); this.disc(command.x, command.y, command.radius, color, this.globalAlpha);
    }
  }

  fillRect(x, y, width, height) {
    const data = { x: x * this.scaleX, y: y * this.scaleY, width: width * this.scaleX, height: height * this.scaleY };
    this.shadow("rect", data); this.rectangle(data.x, data.y, data.width, data.height, this.color(this.fillStyle), this.globalAlpha);
  }

  strokeRect(x, y, width, height) {
    const sx = x * this.scaleX; const sy = y * this.scaleY; const sw = width * this.scaleX; const sh = height * this.scaleY; const line = this.lineWidth * this.scaleX; const color = this.color(this.strokeStyle);
    this.segment(sx, sy, sx + sw, sy, line, color, this.globalAlpha); this.segment(sx + sw, sy, sx + sw, sy + sh, line, color, this.globalAlpha);
    this.segment(sx + sw, sy + sh, sx, sy + sh, line, color, this.globalAlpha); this.segment(sx, sy + sh, sx, sy, line, color, this.globalAlpha);
  }

  fillText() {}

  toRawRgb() { return Buffer.from(this.pixels); }
}

class MockElement {
  constructor() { this.textContent = ""; this.listeners = new Map(); this.attributes = new Map(); this.classList = { toggle() {} }; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
}

class MockCanvas extends MockElement {
  constructor(context) { super(); this.width = WIDTH; this.height = HEIGHT; this.context = context; }
  getContext() { return this.context; }
  getBoundingClientRect() { return { left: 0, top: 0, width: WIDTH, height: HEIGHT }; }
}

function createRuntime(seed) {
  const raster = new RasterContext();
  const canvas = new MockCanvas(raster);
  const elements = new Map([
    ["#kinetic-maze-v4", canvas], ["#seed-label", new MockElement()], ["#status-label", new MockElement()],
    ["#start-control", new MockElement()], ["#chrome", new MockElement()], ["#hint-label", new MockElement()], ["#meta-bar", new MockElement()],
  ]);
  let scheduledFrame = null;
  const sandbox = {
    console,
    URLSearchParams,
    HTMLCanvasElement: MockCanvas,
    document: { querySelector(selector) { return elements.get(selector) || null; } },
    window: { location: { search: `?seed=${encodeURIComponent(seed)}&sound=off&performance=export&duration=180` } },
    requestAnimationFrame(callback) { scheduledFrame = callback; return 1; },
    cancelAnimationFrame() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
  return {
    raster,
    debug: sandbox.window.__KINETIC_V4_DEBUG__,
    initialFrame: raster.toRawRgb(),
    step(timestamp) {
      if (typeof scheduledFrame !== "function") throw new Error("V4 runtime did not schedule a frame.");
      const callback = scheduledFrame;
      scheduledFrame = null;
      raster.beginFrame();
      callback(timestamp);
      return raster.toRawRgb();
    },
  };
}

async function writeFrame(stream, frame) {
  if (!stream.write(frame)) await once(stream, "drain");
}

async function renderVideo(runtime, duration, output) {
  const frameCount = Math.round(duration * FPS);
  const process = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "warning", "-y", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "540x960", "-framerate", String(FPS), "-i", "pipe:0",
    "-vf", `scale=${WIDTH}:${HEIGHT}:flags=lanczos`, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart", output,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  await writeFrame(process.stdin, runtime.initialFrame);
  runtime.step(0);
  for (let frame = 1; frame < frameCount; frame += 1) {
    await writeFrame(process.stdin, runtime.step((frame / FPS) * 1000));
    if (frame % 300 === 0) console.log(`[video] ${frame}/${frameCount} frames (${Math.round(frame / FPS)}s)`);
  }
  process.stdin.end();
  const [code] = await once(process, "exit");
  if (code !== 0) throw new Error(`Video encoder exited with ${code}.`);
}

function xorshift(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return ((state >>> 0) / 2147483648) - 1;
  };
}

function hash(value) {
  let result = 2166136261;
  for (const character of String(value)) { result ^= character.charCodeAt(0); result = Math.imul(result, 16777619); }
  return result >>> 0;
}

function panGains(sourceU) {
  const pan = Math.max(-0.72, Math.min(0.72, (sourceU - 0.5) * 1.35));
  const angle = (pan + 1) * Math.PI / 4;
  return [Math.cos(angle), Math.sin(angle)];
}

function renderAudio(performance, duration, output) {
  const synthesisRate = 24000;
  const outputRate = 48000;
  const sampleCount = Math.ceil(duration * synthesisRate);
  const left = new Float32Array(sampleCount);
  const right = new Float32Array(sampleCount);
  const countAt = (time) => performance.litTimeline[Math.min(performance.litTimeline.length - 1, Math.max(0, Math.floor(time * 4)))]?.count || 1;

  function addTone(event, at, gain, attack, decay, harmonic = 0.08) {
    const start = Math.max(0, Math.floor(at * synthesisRate));
    const length = Math.min(sampleCount - start, Math.ceil((attack + decay) * synthesisRate));
    const frequency = 440 * 2 ** ((event.pitch - 69) / 12);
    const density = Math.min(1, Math.sqrt(16 / Math.max(16, countAt(at))));
    const amplitude = gain * event.gainScale * event.accent * density;
    const [panLeft, panRight] = panGains(event.sourceU);
    for (let index = 0; index < length; index += 1) {
      const time = index / synthesisRate;
      const envelope = time < attack ? time / Math.max(attack, 1 / synthesisRate) : Math.exp(-6 * (time - attack) / decay);
      const phase = TAU * frequency * time;
      const sample = (Math.sin(phase) + harmonic * Math.sin(phase * 2.003)) * envelope * amplitude;
      left[start + index] += sample * panLeft;
      right[start + index] += sample * panRight;
    }
  }

  function addNoise(event, at, gain, decay, color = 0.18) {
    const start = Math.max(0, Math.floor(at * synthesisRate));
    const length = Math.min(sampleCount - start, Math.ceil(decay * synthesisRate));
    const density = Math.min(1, Math.sqrt(16 / Math.max(16, countAt(at))));
    const amplitude = gain * event.gainScale * event.accent * density;
    const [panLeft, panRight] = panGains(event.sourceU);
    const random = xorshift(hash(`${event.activationId}:${event.componentId}:${event.at}:${event.kind}`));
    let low = 0;
    for (let index = 0; index < length; index += 1) {
      const time = index / synthesisRate;
      low += (random() - low) * color;
      const attack = 0.005;
      const envelope = time < attack
        ? time / attack
        : Math.exp(-7 * (time - attack) / Math.max(attack, decay - attack));
      const sample = low * envelope * amplitude;
      left[start + index] += sample * panLeft;
      right[start + index] += sample * panRight;
    }
  }

  for (const event of performance.events) {
    if (event.at >= duration) continue;
    if (event.kind === "felt-mallet") {
      addNoise(event, event.at, 0.12, 0.14, 0.3);
      addTone(event, event.at + 0.008, 0.05, 0.008, 0.22, 0.04);
    } else if (event.kind === "rotor-tine") addTone(event, event.at, 0.07, 0.006, 0.7, 0.09);
    else if (event.kind === "pendulum-center") {
      addNoise(event, event.at, 0.065, 0.1, 0.36);
      addTone(event, event.at + 0.004, 0.06, 0.01, 0.78, 0.12);
    } else if (event.kind.startsWith("glider-")) addNoise(event, event.at, 0.14, 0.18, event.kind.endsWith("metal") ? 0.52 : 0.2);
    else if (event.kind === "ribbon-tap") addTone(event, event.at, 0.045, 0.012, 0.38, 0.05);
    else addNoise(event, event.at, 0.045, 0.18, 0.24);
  }

  for (const activation of performance.activations) {
    if (activation.type !== "glider" || activation.startedAt >= duration) continue;
    const start = Math.max(0, Math.floor(activation.startedAt * synthesisRate));
    const end = Math.min(sampleCount, Math.ceil(Math.min(duration, activation.completeAt) * synthesisRate));
    const random = xorshift(hash(`friction:${activation.id}:${activation.componentId}`));
    const [panLeft, panRight] = panGains(activation.sourceU);
    const materialGain = activation.material === "metal" || activation.material === "ceramic" ? 0.006 : 0.008;
    let low = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 2) {
      const local = sampleIndex / synthesisRate - activation.startedAt;
      const speed = Math.abs(Math.sin((local / activation.basePeriod) * TAU)) ** 1.35;
      low += (random() - low) * (activation.material === "metal" ? 0.45 : 0.13);
      const value = low * speed * materialGain;
      left[sampleIndex] += value * panLeft; right[sampleIndex] += value * panRight;
      if (sampleIndex + 1 < end) { left[sampleIndex + 1] += value * panLeft; right[sampleIndex + 1] += value * panRight; }
    }
  }

  if (duration >= 179) {
    const fadeStart = Math.floor(178.55 * synthesisRate);
    const silenceAt = Math.floor(178.8 * synthesisRate);
    for (let index = fadeStart; index < Math.min(silenceAt, sampleCount); index += 1) {
      const gain = 1 - (index - fadeStart) / Math.max(1, silenceAt - fadeStart);
      left[index] *= gain; right[index] *= gain;
    }
    left.fill(0, Math.min(silenceAt, sampleCount));
    right.fill(0, Math.min(silenceAt, sampleCount));
  }

  let peak = 0;
  for (let index = 0; index < sampleCount; index += 1) peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
  const normalization = peak > 0 ? Math.min(8, 0.72 / peak) : 1;
  const outputSamples = sampleCount * 2;
  const dataBytes = outputSamples * 2 * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + dataBytes, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(outputRate, 24); header.writeUInt32LE(outputRate * 4, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(dataBytes, 40);
  const descriptor = fs.openSync(output, "w");
  fs.writeSync(descriptor, header);
  const chunkFrames = 8192;
  for (let offset = 0; offset < sampleCount; offset += chunkFrames) {
    const frames = Math.min(chunkFrames, sampleCount - offset);
    const buffer = Buffer.allocUnsafe(frames * 8);
    for (let index = 0; index < frames; index += 1) {
      const sourceIndex = offset + index;
      const leftValue = Math.max(-1, Math.min(1, left[sourceIndex] * normalization));
      const rightValue = Math.max(-1, Math.min(1, right[sourceIndex] * normalization));
      const destination = index * 8;
      const leftPcm = Math.round(leftValue * 32767);
      const rightPcm = Math.round(rightValue * 32767);
      buffer.writeInt16LE(leftPcm, destination); buffer.writeInt16LE(rightPcm, destination + 2);
      buffer.writeInt16LE(leftPcm, destination + 4); buffer.writeInt16LE(rightPcm, destination + 6);
    }
    fs.writeSync(descriptor, buffer);
  }
  fs.closeSync(descriptor);
  console.log(`[audio] ${performance.events.length} events, ${performance.activations.filter((item) => item.type === "glider").length} friction intervals, pre-normalization peak=${peak.toFixed(4)}`);
}

function run(command, argumentsList) {
  const result = spawnSync(command, argumentsList, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}.`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  const basename = path.basename(options.output, path.extname(options.output));
  const temporaryVideo = path.join("/private/tmp", `${basename}-video-${process.pid}.mp4`);
  const temporaryAudio = path.join("/private/tmp", `${basename}-audio-${process.pid}.wav`);
  const runtime = createRuntime(options.seed);
  if (runtime.debug.version !== "4.8-live-capture-r17") throw new Error(`Unexpected V4 runtime ${runtime.debug.version}.`);
  const performance = runtime.debug.previewPerformance(options.seed, options.duration, 1 / 60);
  console.log(`[plan] seed=${options.seed} duration=${options.duration}s activations=${performance.activations.length} events=${performance.events.length}`);
  try {
    await renderVideo(runtime, options.duration, temporaryVideo);
    renderAudio(performance, options.duration, temporaryAudio);
    run(FFMPEG, ["-hide_banner", "-loglevel", "warning", "-y", "-i", temporaryVideo, "-i", temporaryAudio, "-t", String(options.duration), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-af", "loudnorm=I=-19.5:LRA=7:TP=-2.5:linear=true,alimiter=limit=0.72:attack=5:release=50:level=false", "-movflags", "+faststart", options.output]);
  } finally {
    for (const temporary of [temporaryVideo, temporaryAudio]) if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  console.log(`[done] ${options.output}`);
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
