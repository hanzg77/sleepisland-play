#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const FFMPEG = "/usr/local/bin/ffmpeg";
const WIDTH = 540;
const HEIGHT = 960;
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const FPS = 30;
const POINT_COUNT = 5600;
const SMALL_POINT_COUNT = 3200;
const GROUP_COUNT = 16;
const TAU = Math.PI * 2;

function parseArguments(values) {
  const options = {
    duration: 30,
    audio: "",
    audioStart: 60,
    output: path.resolve("games/mathematical-jellyfish/exports/mathematical-jellyfish-xhs-30s.mp4"),
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--duration") options.duration = Number(values[++index]);
    else if (value === "--audio") options.audio = path.resolve(values[++index]);
    else if (value === "--audio-start") options.audioStart = Number(values[++index]);
    else if (value === "--output") options.output = path.resolve(values[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }

  if (!(options.duration > 0 && options.duration <= 180)) throw new Error("--duration must be in (0, 180].");
  if (!(options.audioStart >= 0)) throw new Error("--audio-start must be non-negative.");
  if (!options.audio || !fs.existsSync(options.audio)) throw new Error("--audio must point to an existing audio file.");
  return options;
}

const fract = value => value - Math.floor(value);
const hash = value => fract(Math.sin(value * 127.1 + 311.7) * 43758.5453123);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function mixColor(first, second, amount) {
  return [
    Math.round(first[0] + (second[0] - first[0]) * amount),
    Math.round(first[1] + (second[1] - first[1]) * amount),
    Math.round(first[2] + (second[2] - first[2]) * amount),
  ];
}

function gradientColor(position) {
  const stops = [
    [0, [11, 120, 148]],
    [0.36, [7, 93, 125]],
    [0.72, [6, 66, 95]],
    [1, [3, 42, 71]],
  ];
  for (let index = 1; index < stops.length; index += 1) {
    if (position <= stops[index][0]) {
      const prior = stops[index - 1];
      const next = stops[index];
      return mixColor(prior[1], next[1], (position - prior[0]) / (next[0] - prior[0]));
    }
  }
  return stops.at(-1)[1];
}

class JellyfishRenderer {
  constructor() {
    this.pixels = new Uint8Array(WIDTH * HEIGHT * 3);
    this.background = new Uint8Array(this.pixels.length);
    this.pointK = new Float32Array(POINT_COUNT);
    this.pointE = new Float32Array(POINT_COUNT);
    this.pointBaseD = new Float32Array(POINT_COUNT);
    this.pointGroup = new Uint8Array(POINT_COUNT);
    this.groupPhase = new Float32Array(GROUP_COUNT);
    this.groupStrength = new Uint8Array(GROUP_COUNT);
    this.groupHomeX = new Float32Array(GROUP_COUNT);
    this.groupHomeY = new Float32Array(GROUP_COUNT);
    this.groupDriftPhaseX = new Float32Array(GROUP_COUNT);
    this.groupDriftPhaseY = new Float32Array(GROUP_COUNT);
    this.groupSwayPhase = new Float32Array(GROUP_COUNT);
    this.groupPulseOffset = new Float32Array(GROUP_COUNT);
    this.groupMorphTime = new Float32Array(GROUP_COUNT);
    this.groupAnchorX = new Float32Array(GROUP_COUNT);
    this.groupAnchorY = new Float32Array(GROUP_COUNT);
    this.groupSwaySin = new Float32Array(GROUP_COUNT);
    this.groupSwayCos = new Float32Array(GROUP_COUNT);
    this.particles = [];
    this.prepareFormula();
    this.prepareBackground();
  }

  prepareFormula() {
    for (let group = 0; group < GROUP_COUNT; group += 1) {
      const phase = group * 13;
      this.groupPhase[group] = phase;
      this.groupStrength[group] = group === 0 || group === 7
        ? 0
        : Math.round(44 + hash(group * 5.7 + 2.1) * 24);
      this.groupHomeX[group] = 0.5 + Math.sin(phase) * 0.335;
      this.groupHomeY[group] = 0.5 + Math.sin(phase * 4) * 0.345;
      this.groupDriftPhaseX[group] = hash(group * 7.3 + 1.7) * TAU;
      this.groupDriftPhaseY[group] = hash(group * 11.1 + 5.4) * TAU;
      this.groupSwayPhase[group] = hash(group * 9.4 + 4.3) * TAU;
    }

    for (let index = 0; index < POINT_COUNT; index += 1) {
      const i = index + 1;
      const k = 9 * Math.cos(i * 5) * Math.sin(i);
      const e = 9 * Math.cos(i * 3) * Math.cos(i * 2);
      this.pointK[index] = k;
      this.pointE[index] = e;
      this.pointBaseD[index] = Math.hypot(k, e) ** 3 / 1999 + 1.5;
      this.pointGroup[index] = i % GROUP_COUNT;
    }

    for (let index = 0; index < 46; index += 1) {
      this.particles.push({
        x: hash(index * 3.7 + 1.2),
        y: hash(index * 8.9 + 3.5),
        radius: 0.45 + hash(index * 2.3 + 7.1) * 1.05,
        phaseX: hash(index * 9.2 + 0.7) * TAU,
        phaseY: hash(index * 6.4 + 1.9) * TAU,
        cycleX: 1 + (index % 3 === 0 ? 1 : 0),
        cycleY: 1 + (index % 5 === 0 ? 1 : 0),
        alpha: 0.06 + hash(index * 1.8 + 5.1) * 0.17,
      });
    }
  }

  prepareBackground() {
    for (let y = 0; y < HEIGHT; y += 1) {
      const rowColor = gradientColor(y / (HEIGHT - 1));
      for (let x = 0; x < WIDTH; x += 1) {
        const surfaceDistance = Math.hypot((x - WIDTH * 0.48) / (HEIGHT * 0.60), (y + HEIGHT * 0.03) / (HEIGHT * 0.60));
        const surface = Math.max(0, 1 - surfaceDistance) ** 2 * 0.29;
        const edgeX = Math.abs(x / WIDTH - 0.5) * 2;
        const edgeY = Math.abs(y / HEIGHT - 0.45) / 0.55;
        const vignette = clamp((Math.max(edgeX * 0.78, edgeY * 0.58) - 0.44) * 0.31, 0, 0.25);
        const offset = (y * WIDTH + x) * 3;
        this.background[offset] = Math.round((rowColor[0] * (1 - surface) + 151 * surface) * (1 - vignette));
        this.background[offset + 1] = Math.round((rowColor[1] * (1 - surface) + 241 * surface) * (1 - vignette));
        this.background[offset + 2] = Math.round((rowColor[2] * (1 - surface) + 250 * surface) * (1 - vignette));
      }
    }
  }

  blendPixel(x, y, red, green, blue, alpha) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT || alpha <= 0) return;
    const offset = (py * WIDTH + px) * 3;
    const amount = clamp(alpha, 0, 1);
    this.pixels[offset] = Math.round(this.pixels[offset] + (red - this.pixels[offset]) * amount);
    this.pixels[offset + 1] = Math.round(this.pixels[offset + 1] + (green - this.pixels[offset + 1]) * amount);
    this.pixels[offset + 2] = Math.round(this.pixels[offset + 2] + (blue - this.pixels[offset + 2]) * amount);
  }

  screenPixel(x, y, red, green, blue, alpha) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT || alpha <= 0) return;
    const offset = (py * WIDTH + px) * 3;
    const amount = clamp(alpha, 0, 1);
    this.pixels[offset] = Math.round(255 - (255 - this.pixels[offset]) * (1 - amount * red / 255));
    this.pixels[offset + 1] = Math.round(255 - (255 - this.pixels[offset + 1]) * (1 - amount * green / 255));
    this.pixels[offset + 2] = Math.round(255 - (255 - this.pixels[offset + 2]) * (1 - amount * blue / 255));
  }

  renderLight(loopAngle) {
    const rayStarts = [0.14, 0.47, 0.82];
    const rayWidths = [0.115, 0.072, 0.132];
    for (let ray = 0; ray < rayStarts.length; ray += 1) {
      const seed = ray * 1.73 + 0.4;
      const startX = WIDTH * (rayStarts[ray] + Math.sin(loopAngle + seed) * 0.028);
      const endX = startX + Math.sin(loopAngle * 2 + seed * 2.1) * WIDTH * 0.12;
      const shimmer = 0.78 + Math.sin(loopAngle * 3 + seed) * 0.13;
      for (let y = 0; y < HEIGHT * 0.82; y += 2) {
        const v = y / (HEIGHT * 0.82);
        const eased = v * v * (3 - 2 * v);
        const curve = Math.sin(loopAngle + seed + v * 1.7) * WIDTH * 0.025 * Math.sin(Math.PI * v);
        const center = startX + (endX - startX) * eased + curve;
        const sigma = WIDTH * rayWidths[ray] * (0.42 + v * 0.52);
        const fade = (1 - v) ** 1.15 * 0.055 * shimmer;
        const minimum = Math.max(0, Math.floor(center - sigma * 2.4));
        const maximum = Math.min(WIDTH - 1, Math.ceil(center + sigma * 2.4));
        for (let x = minimum; x <= maximum; x += 2) {
          const distance = (x - center) / sigma;
          const alpha = Math.exp(-distance * distance * 0.5) * fade;
          this.screenPixel(x, y, 205, 253, 255, alpha);
          this.screenPixel(x + 1, y, 205, 253, 255, alpha);
          this.screenPixel(x, y + 1, 205, 253, 255, alpha);
          this.screenPixel(x + 1, y + 1, 205, 253, 255, alpha);
        }
      }
    }

    for (let band = 0; band < 5; band += 1) {
      const baseY = HEIGHT * (0.030 + band * 0.025);
      for (let x = 0; x < WIDTH; x += 2) {
        const y = baseY
          + Math.sin(x * (0.022 + band * 0.0017) + loopAngle * 2 + band * 1.3) * (2 + band * 0.55)
          + Math.sin(x * 0.051 - loopAngle + band) * 1.35;
        const alpha = 0.07 - band * 0.008;
        this.screenPixel(x, y, 215, 253, 255, alpha);
        this.screenPixel(x + 1, y, 215, 253, 255, alpha * 0.7);
      }
    }
  }

  renderParticles(loopAngle) {
    for (const particle of this.particles) {
      const x = (particle.x + Math.sin(loopAngle * particle.cycleX + particle.phaseX) * 0.014) * WIDTH;
      const y = (particle.y + Math.sin(loopAngle * particle.cycleY + particle.phaseY) * 0.021) * HEIGHT;
      const radius = particle.radius;
      const minimumX = Math.floor(x - radius - 1);
      const maximumX = Math.ceil(x + radius + 1);
      const minimumY = Math.floor(y - radius - 1);
      const maximumY = Math.ceil(y + radius + 1);
      for (let py = minimumY; py <= maximumY; py += 1) {
        for (let px = minimumX; px <= maximumX; px += 1) {
          const distance = Math.hypot(px + 0.5 - x, py + 0.5 - y);
          const coverage = clamp(radius + 0.65 - distance, 0, 1);
          this.screenPixel(px, py, 198, 247, 255, particle.alpha * coverage);
        }
      }
    }
  }

  depositJellyPoint(x, y, strength) {
    this.blendPixel(x, y, 221, 250, 255, strength / 255);
  }

  renderHeroJelly(loopAngle) {
    const centerX = WIDTH * 0.52
      + Math.sin(loopAngle + 1.4) * WIDTH * 0.022
      + Math.sin(loopAngle * 2 + 0.2) * WIDTH * 0.008;
    const centerY = HEIGHT * 0.52
      + Math.sin(loopAngle * 2 + 0.7) * HEIGHT * 0.012
      + Math.sin(loopAngle + 2.6) * HEIGHT * 0.006;
    const pulse = Math.sin(loopAngle * 2 + 0.35);
    const bellWidth = WIDTH * 0.305 * (1 - pulse * 0.045);
    const bellHeight = HEIGHT * 0.180 * (1 + pulse * 0.055);
    const sway = Math.sin(loopAngle + 2.1) * 0.035 + Math.sin(loopAngle * 3) * 0.009;
    const swaySin = Math.sin(sway);
    const swayCos = Math.cos(sway);
    const emit = (localX, localY, strength, neighbor = 6) => {
      const x = Math.round(centerX + localX * swayCos - localY * swaySin);
      const y = Math.round(centerY + localX * swaySin + localY * swayCos);
      this.depositJellyPoint(x, y, strength);
      this.depositJellyPoint(x - 1, y, neighbor);
      this.depositJellyPoint(x + 1, y, neighbor);
      this.depositJellyPoint(x, y - 1, neighbor);
      this.depositJellyPoint(x, y + 1, neighbor);
    };

    // Nested cosine arches turn a mathematical surface into a translucent bell.
    const bellLayers = 10;
    const bellSamples = 170;
    for (let layer = 0; layer < bellLayers; layer += 1) {
      const depth = layer / (bellLayers - 1);
      for (let sample = 0; sample < bellSamples; sample += 1) {
        const u = sample / (bellSamples - 1) * Math.PI;
        const edgeNoise = Math.sin(u * 9 + layer * 1.7 + loopAngle * 3) * (0.8 + depth * 0.6);
        const localX = Math.cos(u) * bellWidth * (1 - depth * 0.075) + edgeNoise;
        const localY = -Math.sin(u) * bellHeight * (1 - depth * 0.12)
          + depth * HEIGHT * 0.014
          + Math.sin(u * 5 - loopAngle * 2 + layer) * 0.7;
        emit(localX, localY, 33 + Math.round((1 - depth) * 11), 6);
      }
    }

    // A sparse deterministic mist gives the transparent bell volume without a solid mesh.
    const mistCount = 640;
    for (let point = 0; point < mistCount; point += 1) {
      const u = hash(point * 5.31 + 0.7) * Math.PI;
      const radius = Math.sqrt(hash(point * 8.17 + 3.6)) * 0.91;
      const localX = Math.cos(u) * bellWidth * radius
        + Math.sin(loopAngle * 2 + point) * WIDTH * 0.0015;
      const localY = -Math.sin(u) * bellHeight * radius
        + Math.sin(loopAngle * 3 + point * 1.9) * HEIGHT * 0.0012;
      emit(localX, localY, 18, 2);
    }

    // Nine formula-defined ribs fan out from the crown to the bell edge.
    const ribCount = 9;
    const ribSamples = 92;
    for (let rib = 0; rib < ribCount; rib += 1) {
      const u = (rib + 1) / (ribCount + 1) * Math.PI;
      const targetX = Math.cos(u) * bellWidth * 0.96;
      const targetY = -Math.sin(u) * bellHeight * 0.96;
      for (let sample = 0; sample < ribSamples; sample += 1) {
        const v = sample / (ribSamples - 1);
        const curvedV = v * v * (3 - 2 * v);
        const localX = targetX * curvedV
          + Math.sin(v * Math.PI * 2 + rib * 0.8 + loopAngle * 2) * WIDTH * 0.003 * Math.sin(Math.PI * v);
        const localY = -bellHeight * 0.91 * (1 - curvedV) + targetY * curvedV;
        emit(localX, localY, 31, 5);
      }
    }

    // A softly scalloped rim closes the bell without creating a solid body.
    const rimSamples = 330;
    for (let sample = 0; sample < rimSamples; sample += 1) {
      const v = sample / (rimSamples - 1);
      const localX = (v * 2 - 1) * bellWidth * 0.97;
      const localY = HEIGHT * 0.010
        + Math.cos((v - 0.5) * Math.PI) * HEIGHT * 0.013
        + Math.sin(v * Math.PI * 8 + loopAngle * 2) * HEIGHT * 0.0025;
      emit(localX, localY, 55, 9);
    }

    // Seven tentacles have different lengths, curl frequencies, and phases.
    const tentacleBases = [-0.78, -0.52, -0.27, 0, 0.27, 0.52, 0.78];
    const tentacleSamples = 150;
    for (let strand = 0; strand < tentacleBases.length; strand += 1) {
      const base = tentacleBases[strand];
      const length = HEIGHT * (0.255 + hash(strand * 4.7 + 3.1) * 0.105);
      const phase = hash(strand * 7.9 + 1.3) * TAU;
      const frequency = 2.4 + hash(strand * 2.6 + 5.8) * 1.9;
      for (let sample = 0; sample < tentacleSamples; sample += 1) {
        const v = sample / (tentacleSamples - 1);
        const curl = Math.sin(v * Math.PI * frequency + phase + loopAngle * (1 + strand % 3))
          * WIDTH * (0.010 + v * 0.032);
        const secondaryCurl = Math.sin(v * Math.PI * 2 + phase * 1.7 - loopAngle * 2)
          * WIDTH * 0.010 * v;
        const localX = base * bellWidth * (1 - v * 0.20) + curl + secondaryCurl;
        const localY = HEIGHT * 0.019 + v * length
          + Math.sin(v * Math.PI * 3 + phase + loopAngle * 2) * HEIGHT * 0.005;
        emit(localX, localY, 49 - Math.round(v * 12), 8);
      }
    }
  }

  renderJellies(loopAngle) {
    const travelX = WIDTH * 0.335;
    const travelY = HEIGHT * 0.345;
    const localScale = WIDTH / 400 * 1.02;

    for (let group = 0; group < GROUP_COUNT; group += 1) {
      const firstCycle = 1 + (group % 5 === 0 ? 1 : 0);
      const secondCycle = 2 + (group % 4 === 0 ? 1 : 0);
      const verticalCycle = 1 + (group % 6 === 0 ? 1 : 0);
      const morphCycles = 2 + (group % 3);
      const phaseX = this.groupDriftPhaseX[group];
      const phaseY = this.groupDriftPhaseY[group];
      const driftX = Math.sin(loopAngle * firstCycle + phaseX) * 0.032
        + Math.sin(loopAngle * secondCycle + phaseY) * 0.012;
      const driftY = Math.sin(loopAngle * verticalCycle + phaseY) * 0.018
        + Math.sin(loopAngle * 3 + phaseX) * 0.009;
      const sway = Math.sin(loopAngle * (1 + (group % 7 === 0 ? 1 : 0)) + this.groupSwayPhase[group]) * 0.085;
      const morphTime = loopAngle * 2 * morphCycles;

      this.groupMorphTime[group] = morphTime;
      this.groupPulseOffset[group] = Math.sin(morphTime / 2 + this.groupPhase[group]) ** 3 / 3;
      this.groupAnchorX[group] = clamp((this.groupHomeX[group] + driftX) * WIDTH, WIDTH * 0.10, WIDTH * 0.90);
      this.groupAnchorY[group] = clamp((this.groupHomeY[group] + driftY) * HEIGHT, HEIGHT * 0.10, HEIGHT * 0.90);
      this.groupSwaySin[group] = Math.sin(sway);
      this.groupSwayCos[group] = Math.cos(sway);
    }

    for (let index = 0; index < SMALL_POINT_COUNT; index += 1) {
      const group = this.pointGroup[index];
      const m = this.groupPhase[group];
      const d = this.pointBaseD[index] - this.groupPulseOffset[group];
      const c = d / 16 + m;
      const p = d ** Math.sin(d * d - this.groupMorphTime[group] + m);
      const localX = travelX * (Math.sin(c) - Math.sin(m)) + this.pointK[index] * p * localScale;
      const localY = travelY * (Math.sin(c * 4) - Math.sin(m * 4)) + this.pointE[index] * p * localScale;
      const x = Math.round(this.groupAnchorX[group] + localX * this.groupSwayCos[group] - localY * this.groupSwaySin[group]);
      const y = Math.round(this.groupAnchorY[group] + localX * this.groupSwaySin[group] + localY * this.groupSwayCos[group]);
      const strength = this.groupStrength[group];
      this.depositJellyPoint(x, y, strength);
      this.depositJellyPoint(x - 1, y, strength >> 3);
      this.depositJellyPoint(x + 1, y, strength >> 3);
      this.depositJellyPoint(x, y - 1, strength >> 3);
      this.depositJellyPoint(x, y + 1, strength >> 3);
    }
  }

  render(progress) {
    this.pixels.set(this.background);
    const loopAngle = TAU * progress;
    this.renderLight(loopAngle);
    this.renderParticles(loopAngle);
    this.renderHeroJelly(loopAngle);
    this.renderJellies(loopAngle);
    return Buffer.from(this.pixels);
  }
}

async function writeFrame(stream, frame) {
  if (!stream.write(frame)) await once(stream, "drain");
}

async function renderVideo(options) {
  const frameCount = Math.round(options.duration * FPS);
  const fadeOutStart = Math.max(0, options.duration - 1);
  fs.mkdirSync(path.dirname(options.output), { recursive: true });

  const encoder = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${WIDTH}x${HEIGHT}`, "-framerate", String(FPS), "-i", "pipe:0",
    "-ss", String(options.audioStart), "-t", String(options.duration), "-i", options.audio,
    "-t", String(options.duration),
    "-vf", `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:flags=lanczos,format=yuv420p`,
    "-af", `afade=t=in:st=0:d=0.8,afade=t=out:st=${fadeOutStart}:d=1,alimiter=limit=0.794:attack=5:release=80:level=false`,
    "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-threads", "2", "-profile:v", "high", "-level:v", "4.1",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", "-shortest", options.output,
  ], { stdio: ["pipe", "inherit", "inherit"] });

  const renderer = new JellyfishRenderer();
  for (let frame = 0; frame < frameCount; frame += 1) {
    await writeFrame(encoder.stdin, renderer.render(frame / frameCount));
    if (frame % 150 === 0) console.log(`[render] ${frame}/${frameCount} frames`);
  }
  encoder.stdin.end();
  const [code] = await once(encoder, "exit");
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}.`);
  console.log(`[done] ${options.output}`);
}

renderVideo(parseArguments(process.argv.slice(2))).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
