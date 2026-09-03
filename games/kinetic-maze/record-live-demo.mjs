#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);

function parseArguments(argv) {
  const options = {
    duration: 15,
    fps: 30,
    seed: "v4-growth-preview",
    output: path.join(SCRIPT_DIR, "exports", "kinetic-maze-live-15s.mp4"),
    preview: path.join(tmpdir(), "kinetic-maze-live-15s-preview.png"),
    chrome: DEFAULT_CHROME,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--duration") { options.duration = Number(value); index += 1; }
    else if (key === "--fps") { options.fps = Number(value); index += 1; }
    else if (key === "--seed") { options.seed = String(value || ""); index += 1; }
    else if (key === "--output") { options.output = path.resolve(String(value)); index += 1; }
    else if (key === "--preview") { options.preview = path.resolve(String(value)); index += 1; }
    else if (key === "--chrome") { options.chrome = path.resolve(String(value)); index += 1; }
    else if (key === "--help" || key === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!Number.isFinite(options.duration) || options.duration < 10 || options.duration > 120) {
    throw new Error("--duration must be between 10 and 120 seconds.");
  }
  if (!Number.isFinite(options.fps) || options.fps < 24 || options.fps > 60) {
    throw new Error("--fps must be between 24 and 60.");
  }
  options.duration = Number(options.duration.toFixed(3));
  options.fps = Math.round(options.fps);
  options.seed = options.seed.trim().slice(0, 64) || "v4-growth-preview";
  return options;
}

function printHelp() {
  process.stdout.write(`Usage:
  node games/kinetic-maze/record-live-demo.mjs [options]

Options:
  --duration <seconds>  Real-time capture duration, 10-120 (default: 15)
  --fps <rate>          Canvas capture rate, 24-60 (default: 30)
  --seed <text>         Deterministic maze seed
  --output <file.mp4>   Final H.264/AAC portrait video
  --preview <file.png>  Mid-performance browser screenshot
  --chrome <binary>     Chrome executable
`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function easeInOut(value) {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function sampleCurve(count, curve) {
  return Array.from({ length: count }, (_, index) => curve(index / Math.max(1, count - 1)));
}

function cinematicTrajectory() {
  return [
    {
      name: "comet-s",
      introMs: 500,
      durationMs: 1400,
      points: sampleCurve(7, (raw) => {
        const t = easeInOut(raw);
        return {
          u: 0.1 + 0.8 * t,
          v: 0.79 - 0.59 * t + Math.sin(t * Math.PI * 3) * 0.075,
        };
      }),
    },
    {
      name: "central-eight",
      introMs: 450,
      durationMs: 1800,
      points: sampleCurve(9, (t) => ({
        u: 0.5 + Math.sin(t * Math.PI * 2) * 0.34,
        v: 0.48 + Math.sin(t * Math.PI * 4) * 0.19,
      })),
    },
    {
      name: "opening-spiral",
      introMs: 500,
      durationMs: 1500,
      points: sampleCurve(9, (t) => {
        const angle = -Math.PI * 0.5 + t * Math.PI * 4.5;
        const radius = 0.055 + 0.29 * easeInOut(t);
        return {
          u: 0.51 + Math.cos(angle) * radius,
          v: 0.52 + Math.sin(angle) * radius * 0.78,
        };
      }),
    },
  ];
}

function normalizedPoint(point, bounds) {
  return {
    x: bounds.x + clamp(point.u, 0.04, 0.96) * bounds.width,
    y: bounds.y + clamp(point.v, 0.06, 0.94) * bounds.height,
  };
}

async function startStaticServer(capturePath) {
  let resolveCapture;
  let rejectCapture;
  let captureReceived = false;
  const capturePromise = new Promise((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
      if (request.method === "POST" && requestUrl.pathname === "/__kinetic_capture__") {
        if (captureReceived) {
          response.writeHead(409).end("capture already received");
          return;
        }
        captureReceived = true;
        await pipeline(request, createWriteStream(capturePath));
        const info = await stat(capturePath);
        response.writeHead(204, { "Cache-Control": "no-store" }).end();
        resolveCapture(info.size);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end("method not allowed");
        return;
      }
      const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
      let filePath = path.resolve(REPO_ROOT, relative || "index.html");
      if (filePath !== REPO_ROOT && !filePath.startsWith(`${REPO_ROOT}${path.sep}`)) {
        response.writeHead(403).end("forbidden");
        return;
      }
      const fileInfo = await stat(filePath);
      if (fileInfo.isDirectory()) filePath = path.join(filePath, "index.html");
      response.writeHead(200, {
        "Content-Type": MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(filePath).pipe(response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(error?.code === "ENOENT" ? 404 : 500);
      response.end(error?.code === "ENOENT" ? "not found" : "server error");
      if (request.method === "POST") rejectCapture(error);
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    port: server.address().port,
    capturePromise,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      for (const socket of sockets) socket.destroy();
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    }),
  };
}

function waitForDevTools(chrome, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Chrome DevTools did not start.\n${stderr}`)), timeoutMs);
    const onData = (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      chrome.stderr.off("data", onData);
      resolve(match[1]);
    };
    chrome.stderr.on("data", onData);
    chrome.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools became ready (${code}).\n${stderr}`));
    });
  });
}

async function findPageTarget(debuggingPort, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === "page");
      if (target?.webSocketDebuggerUrl) return target;
    } catch (_) {
      // Chrome may still be creating its first target.
    }
    await sleep(80);
  }
  throw new Error("Chrome did not expose a page target.");
}

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Chrome DevTools connection closed."));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome DevTools.")), { once: true });
  });
  return new CdpSession(socket);
}

async function evaluate(cdp, expression, options = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: options.awaitPromise === true,
    returnByValue: true,
    userGesture: options.userGesture === true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Page evaluation failed.";
    throw new Error(details);
  }
  return result.result?.value;
}

async function waitForPage(cdp, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, predicate)) return;
    } catch (_) {
      // Navigation may briefly destroy the execution context.
    }
    await sleep(80);
  }
  throw new Error(`Timed out waiting for page condition: ${predicate}`);
}

async function dispatchTap(cdp, point) {
  const touch = { x: point.x, y: point.y, radiusX: 8, radiusY: 8, force: 0.86, id: 1 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch] });
  await sleep(70);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function dispatchStroke(cdp, points, durationMs, bounds) {
  const samples = points.map((point) => normalizedPoint(point, bounds));
  const interval = durationMs / Math.max(1, samples.length - 1);
  const touchPoint = (point) => ({ x: point.x, y: point.y, radiusX: 7, radiusY: 7, force: 0.82, id: 1 });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint(samples[0])] });
  const startedAt = performance.now();
  let pendingMoves = [];
  for (let index = 1; index < samples.length; index += 1) {
    const wait = startedAt + interval * index - performance.now();
    if (wait > 0) await sleep(wait);
    // CDP keeps command order. Waiting in small batches avoids adding one full
    // round trip to every sample while still surfacing an input error promptly.
    pendingMoves.push(cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [touchPoint(samples[index])] }));
    if (pendingMoves.length >= 8) {
      await Promise.all(pendingMoves);
      pendingMoves = [];
    }
  }
  if (pendingMoves.length) await Promise.all(pendingMoves);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}.\n${stderr}`));
    });
  });
}

async function transcodeCapture(input, output, duration, fps) {
  await mkdir(path.dirname(output), { recursive: true });
  await runProcess("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "warning",
    "-i", input,
    "-t", duration.toFixed(3),
    "-vf", `tpad=stop_mode=clone:stop_duration=${duration},fps=${fps},format=yuv420p`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-af", "volume=4.5dB,alimiter=limit=0.88:attack=5:release=80:level=false",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart",
    output,
  ]);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  await stat(options.chrome).catch(() => { throw new Error(`Chrome not found: ${options.chrome}`); });

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "kinetic-live-capture-"));
  const chromeProfile = path.join(temporaryDirectory, "chrome-profile");
  const rawCapture = path.join(temporaryDirectory, "capture.webm");
  const server = await startStaticServer(rawCapture);
  let chrome = null;
  let cdp = null;
  try {
    const pageUrl = new URL(`http://127.0.0.1:${server.port}/games/kinetic-maze/index.html`);
    pageUrl.searchParams.set("mode", "melody");
    pageUrl.searchParams.set("seed", options.seed);
    pageUrl.searchParams.set("motifs", "on");
    pageUrl.searchParams.set("motifCount", "4");
    pageUrl.searchParams.set("phraseLoops", "1");
    pageUrl.searchParams.set("wavePhraseFade", "0.68");
    pageUrl.searchParams.set("waveLife", "3.2");
    pageUrl.searchParams.set("waveCap", "20");
    pageUrl.searchParams.set("componentCap", "10");
    pageUrl.searchParams.set("componentThreshold", "0.18");
    pageUrl.searchParams.set("mechanismCap", "14");

    chrome = spawn(options.chrome, [
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      `--user-data-dir=${chromeProfile}`,
      "--window-size=1080,1920",
      "--force-device-scale-factor=1",
      "--hide-scrollbars",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });

    const browserWebSocket = await waitForDevTools(chrome);
    const debuggingPort = Number(new URL(browserWebSocket).port);
    const pageTarget = await findPageTarget(debuggingPort);
    cdp = await connectCdp(pageTarget.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1080,
      height: 1920,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 1080,
      screenHeight: 1920,
      screenOrientation: { type: "portraitPrimary", angle: 0 },
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await cdp.send("Page.navigate", { url: pageUrl.href });
    await waitForPage(cdp, `typeof window.__KINETIC_V4_DEBUG__ === "object" && document.readyState === "complete"`);
    const runtimeVersion = await evaluate(cdp, `window.__KINETIC_V4_DEBUG__.version`);
    if (runtimeVersion !== "4.8-live-capture-r16") throw new Error(`Unexpected runtime: ${runtimeVersion}`);
    const denseMode = await evaluate(cdp, `window.__KINETIC_V4_DEBUG__.getDenseDetailsExperiment().mode`);
    if (denseMode !== "off") throw new Error(`Live capture must use one full-size 9x16 board, not denseDetails=${denseMode}.`);
    process.stdout.write("[layout] one full-size 9x16 board\n");

    const startRect = await evaluate(cdp, `(() => { const r = document.querySelector("#start-control").getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; })()`);
    await dispatchTap(cdp, { x: startRect.x + startRect.width / 2, y: startRect.y + startRect.height / 2 });
    await waitForPage(cdp, `(() => { const a=window.__KINETIC_V4_DEBUG__.getAudioState(); return a.enabled && a.contextState === "running" && a.captureStreamReady; })()`);
    await sleep(260);

    const captureStatus = await evaluate(cdp, `(() => {
      const debug = window.__KINETIC_V4_DEBUG__;
      const stream = debug.createLiveCaptureStream(${options.fps});
      const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
      const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
      const recorder = new MediaRecorder(stream, mimeType ? {
        mimeType,
        videoBitsPerSecond: 12000000,
        audioBitsPerSecond: 192000,
      } : undefined);
      const state = { recorder, stream, chunks: [], mimeType: recorder.mimeType || mimeType };
      recorder.ondataavailable = (event) => { if (event.data && event.data.size) state.chunks.push(event.data); };
      window.__KINETIC_LIVE_CAPTURE__ = state;
      recorder.start(250);
      return { mimeType: state.mimeType, videoTracks: stream.getVideoTracks().length, audioTracks: stream.getAudioTracks().length };
    })()`, { userGesture: true });
    if (captureStatus.videoTracks !== 1 || captureStatus.audioTracks < 1) {
      throw new Error(`Capture stream is incomplete: ${JSON.stringify(captureStatus)}`);
    }
    process.stdout.write(`[capture] ${captureStatus.mimeType} · ${options.fps}fps · ${captureStatus.audioTracks} audio track\n`);

    const canvasBounds = await evaluate(cdp, `(() => { const r=document.querySelector("#kinetic-maze-v4").getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
    const startedAt = performance.now();
    for (const stroke of cinematicTrajectory()) {
      await sleep(stroke.introMs);
      process.stdout.write(`[stroke] ${stroke.name} · ${(stroke.durationMs / 1000).toFixed(1)}s\n`);
      await dispatchStroke(cdp, stroke.points, stroke.durationMs, canvasBounds);
      if (stroke.name === "central-eight") {
        const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        await mkdir(path.dirname(options.preview), { recursive: true });
        await writeFile(options.preview, Buffer.from(screenshot.data, "base64"));
      }
    }
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const remainingSeconds = Math.max(0.25, options.duration - elapsedSeconds);
    process.stdout.write(`[outro] waves and phrases replay for ${remainingSeconds.toFixed(2)}s\n`);
    await sleep(remainingSeconds * 1000);

    const stopResult = await evaluate(cdp, `new Promise((resolve, reject) => {
      const state = window.__KINETIC_LIVE_CAPTURE__;
      if (!state || state.recorder.state === "inactive") { reject(new Error("Recorder is not running.")); return; }
      state.recorder.onerror = (event) => reject(event.error || new Error("MediaRecorder failed."));
      state.recorder.onstop = async () => {
        try {
          const blob = new Blob(state.chunks, { type: state.mimeType || "video/webm" });
          const response = await fetch("/__kinetic_capture__", { method: "POST", body: blob });
          if (!response.ok) throw new Error("Capture upload failed: " + response.status);
          for (const track of state.stream.getTracks()) track.stop();
          resolve({ bytes: blob.size, mimeType: blob.type });
        } catch (error) { reject(error); }
      };
      state.recorder.stop();
    })`, { awaitPromise: true });
    const receivedBytes = await server.capturePromise;
    process.stdout.write(`[recorded] ${(receivedBytes / 1024 / 1024).toFixed(2)} MiB (${stopResult.mimeType})\n`);

    await transcodeCapture(rawCapture, options.output, options.duration, options.fps);
    const outputInfo = await stat(options.output);
    process.stdout.write(`[done] ${options.output} · ${(outputInfo.size / 1024 / 1024).toFixed(2)} MiB\n`);
    process.stdout.write(`[preview] ${options.preview}\n`);
  } finally {
    try { cdp?.close(); } catch (_) { /* Already closed. */ }
    if (chrome && chrome.exitCode === null) {
      chrome.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), sleep(1500)]);
      if (chrome.exitCode === null) chrome.kill("SIGKILL");
    }
    await server.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
