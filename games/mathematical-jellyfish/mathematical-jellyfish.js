(() => {
  "use strict";

  const stage = document.getElementById("mathematical-jellyfish-stage");
  const canvas = document.getElementById("mathematical-jellyfish");
  const formulaButton = document.getElementById("formula-toggle");
  const formulaPanel = document.getElementById("formula-panel");
  if (!stage || !canvas || stage.dataset.initialized === "true") return;
  stage.dataset.initialized = "true";

  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TAU = Math.PI * 2;
  const LOOP_SECONDS = 30;
  const FRAME_INTERVAL = 1000 / 30;
  const LIGHT_INTERVAL = 1000 / 10;
  const POINT_COUNT = 5600;
  const SMALL_POINT_COUNT = 3200;
  const GROUP_COUNT = 16;

  const backgroundCanvas = document.createElement("canvas");
  const backgroundCtx = backgroundCanvas.getContext("2d", { alpha: false });
  const lightCanvas = document.createElement("canvas");
  const lightCtx = lightCanvas.getContext("2d");
  const jellyCanvas = document.createElement("canvas");
  const jellyCtx = jellyCanvas.getContext("2d");

  const fract = value => value - Math.floor(value);
  const hash = value => fract(Math.sin(value * 127.1 + 311.7) * 43758.5453123);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  const pointK = new Float32Array(POINT_COUNT);
  const pointE = new Float32Array(POINT_COUNT);
  const pointBaseD = new Float32Array(POINT_COUNT);
  const pointGroup = new Uint8Array(POINT_COUNT);
  const groupPhase = new Float32Array(GROUP_COUNT);
  const groupStrength = new Uint8Array(GROUP_COUNT);
  const groupHomeX = new Float32Array(GROUP_COUNT);
  const groupHomeY = new Float32Array(GROUP_COUNT);
  const groupDriftPhaseX = new Float32Array(GROUP_COUNT);
  const groupDriftPhaseY = new Float32Array(GROUP_COUNT);
  const groupSwayPhase = new Float32Array(GROUP_COUNT);
  const groupPulseOffset = new Float32Array(GROUP_COUNT);
  const groupMorphTime = new Float32Array(GROUP_COUNT);
  const groupAnchorX = new Float32Array(GROUP_COUNT);
  const groupAnchorY = new Float32Array(GROUP_COUNT);
  const groupSwaySin = new Float32Array(GROUP_COUNT);
  const groupSwayCos = new Float32Array(GROUP_COUNT);

  for (let group = 0; group < GROUP_COUNT; group += 1) {
    const phase = group * 13;
    groupPhase[group] = phase;
    groupStrength[group] = group === 0 || group === 7
      ? 0
      : Math.round(44 + hash(group * 5.7 + 2.1) * 24);
    groupHomeX[group] = 0.5 + Math.sin(phase) * 0.335;
    groupHomeY[group] = 0.5 + Math.sin(phase * 4) * 0.345;
    groupDriftPhaseX[group] = hash(group * 7.3 + 1.7) * TAU;
    groupDriftPhaseY[group] = hash(group * 11.1 + 5.4) * TAU;
    groupSwayPhase[group] = hash(group * 9.4 + 4.3) * TAU;
  }

  // Core point construction adapted from @yuruyurau's Processing sketch.
  // k = 9 cos(5i) sin(i), e = 9 cos(3i) cos(2i)
  for (let index = 0; index < POINT_COUNT; index += 1) {
    const i = index + 1;
    const k = 9 * Math.cos(i * 5) * Math.sin(i);
    const e = 9 * Math.cos(i * 3) * Math.cos(i * 2);
    pointK[index] = k;
    pointE[index] = e;
    pointBaseD[index] = Math.hypot(k, e) ** 3 / 1999 + 1.5;
    pointGroup[index] = i % GROUP_COUNT;
  }

  const particles = Array.from({ length: 46 }, (_, index) => ({
    x: hash(index * 3.7 + 1.2),
    y: hash(index * 8.9 + 3.5),
    radius: 0.45 + hash(index * 2.3 + 7.1) * 1.05,
    phaseX: hash(index * 9.2 + 0.7) * TAU,
    phaseY: hash(index * 6.4 + 1.9) * TAU,
    cycleX: 1 + (index % 3 === 0 ? 1 : 0),
    cycleY: 1 + (index % 5 === 0 ? 1 : 0),
    alpha: 0.06 + hash(index * 1.8 + 5.1) * 0.17,
  }));

  let width = 360;
  let height = 640;
  let jellyImage = null;
  let jellyPixels = null;
  let elapsed = 0;
  let lastTick = 0;
  let accumulator = FRAME_INTERVAL;
  let lastLightUpdate = -Infinity;
  let animationFrame = 0;
  let isIntersecting = true;
  let isRunning = false;
  let manuallyPaused = false;

  function renderBackground() {
    backgroundCanvas.width = width;
    backgroundCanvas.height = height;

    const water = backgroundCtx.createLinearGradient(0, 0, 0, height);
    water.addColorStop(0, "#0b7894");
    water.addColorStop(0.36, "#075d7d");
    water.addColorStop(0.72, "#06425f");
    water.addColorStop(1, "#032a47");
    backgroundCtx.fillStyle = water;
    backgroundCtx.fillRect(0, 0, width, height);

    const surface = backgroundCtx.createRadialGradient(
      width * 0.48, -height * 0.03, 0,
      width * 0.48, -height * 0.03, height * 0.60,
    );
    surface.addColorStop(0, "rgba(151, 241, 250, 0.30)");
    surface.addColorStop(0.42, "rgba(64, 189, 211, 0.10)");
    surface.addColorStop(1, "rgba(1, 40, 70, 0)");
    backgroundCtx.fillStyle = surface;
    backgroundCtx.fillRect(0, 0, width, height);

    const vignette = backgroundCtx.createRadialGradient(
      width * 0.5, height * 0.42, width * 0.18,
      width * 0.5, height * 0.52, height * 0.72,
    );
    vignette.addColorStop(0, "rgba(0, 19, 38, 0)");
    vignette.addColorStop(0.75, "rgba(0, 20, 40, 0.05)");
    vignette.addColorStop(1, "rgba(0, 17, 35, 0.28)");
    backgroundCtx.fillStyle = vignette;
    backgroundCtx.fillRect(0, 0, width, height);
  }

  function renderLight(loopAngle) {
    const scale = 0.5;
    lightCanvas.width = Math.max(1, Math.round(width * scale));
    lightCanvas.height = Math.max(1, Math.round(height * scale));
    lightCtx.setTransform(scale, 0, 0, scale, 0, 0);
    lightCtx.clearRect(0, 0, width, height);
    lightCtx.globalCompositeOperation = "screen";
    lightCtx.lineCap = "round";
    lightCtx.filter = `blur(${Math.max(5, width * 0.018)}px)`;

    const rayStarts = [0.14, 0.47, 0.82];
    const rayWidths = [0.115, 0.072, 0.132];
    for (let ray = 0; ray < rayStarts.length; ray += 1) {
      const seed = ray * 1.73 + 0.4;
      const startX = width * rayStarts[ray] + Math.sin(loopAngle + seed) * width * 0.028;
      const endX = startX + Math.sin(loopAngle * 2 + seed * 2.1) * width * 0.12;
      const shimmer = 0.78 + Math.sin(loopAngle * 3 + seed) * 0.13;
      const rayGradient = lightCtx.createLinearGradient(0, 0, 0, height * 0.82);
      rayGradient.addColorStop(0, `rgba(205, 253, 255, ${0.145 * shimmer})`);
      rayGradient.addColorStop(0.38, `rgba(116, 225, 238, ${0.078 * shimmer})`);
      rayGradient.addColorStop(1, "rgba(61, 178, 206, 0)");
      lightCtx.strokeStyle = rayGradient;
      lightCtx.lineWidth = width * rayWidths[ray];
      lightCtx.beginPath();
      lightCtx.moveTo(startX, -height * 0.05);
      lightCtx.bezierCurveTo(
        startX + Math.sin(loopAngle + seed) * width * 0.08,
        height * 0.24,
        endX - Math.cos(loopAngle * 2 + seed) * width * 0.07,
        height * 0.50,
        endX,
        height * 0.82,
      );
      lightCtx.stroke();
    }

    lightCtx.filter = "blur(0.65px)";
    lightCtx.lineWidth = 0.75;
    for (let band = 0; band < 5; band += 1) {
      const baseY = height * (0.030 + band * 0.025);
      lightCtx.strokeStyle = `rgba(215, 253, 255, ${0.085 - band * 0.011})`;
      lightCtx.beginPath();
      for (let x = -12; x <= width + 12; x += 5) {
        const y = baseY
          + Math.sin(x * (0.022 + band * 0.0017) + loopAngle * 2 + band * 1.3) * (2 + band * 0.55)
          + Math.sin(x * 0.051 - loopAngle + band) * 1.35;
        if (x === -12) lightCtx.moveTo(x, y);
        else lightCtx.lineTo(x, y);
      }
      lightCtx.stroke();
    }

    lightCtx.filter = "none";
    lightCtx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function depositPixel(x, y, strength) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    jellyPixels[offset] = 221;
    jellyPixels[offset + 1] = 250;
    jellyPixels[offset + 2] = 255;
    const oldAlpha = jellyPixels[offset + 3];
    jellyPixels[offset + 3] = oldAlpha + (((255 - oldAlpha) * strength) >> 8);
  }

  function renderHeroJelly(loopAngle) {
    const centerX = width * 0.52
      + Math.sin(loopAngle + 1.4) * width * 0.022
      + Math.sin(loopAngle * 2 + 0.2) * width * 0.008;
    const centerY = height * 0.52
      + Math.sin(loopAngle * 2 + 0.7) * height * 0.012
      + Math.sin(loopAngle + 2.6) * height * 0.006;
    const pulse = Math.sin(loopAngle * 2 + 0.35);
    const bellWidth = width * 0.305 * (1 - pulse * 0.045);
    const bellHeight = height * 0.180 * (1 + pulse * 0.055);
    const sway = Math.sin(loopAngle + 2.1) * 0.035 + Math.sin(loopAngle * 3) * 0.009;
    const swaySin = Math.sin(sway);
    const swayCos = Math.cos(sway);
    const emit = (localX, localY, strength, neighbor = 6) => {
      const x = Math.round(centerX + localX * swayCos - localY * swaySin);
      const y = Math.round(centerY + localX * swaySin + localY * swayCos);
      depositPixel(x, y, strength);
      depositPixel(x - 1, y, neighbor);
      depositPixel(x + 1, y, neighbor);
      depositPixel(x, y - 1, neighbor);
      depositPixel(x, y + 1, neighbor);
    };

    const bellLayers = 10;
    const bellSamples = 170;
    for (let layer = 0; layer < bellLayers; layer += 1) {
      const depth = layer / (bellLayers - 1);
      for (let sample = 0; sample < bellSamples; sample += 1) {
        const u = sample / (bellSamples - 1) * Math.PI;
        const edgeNoise = Math.sin(u * 9 + layer * 1.7 + loopAngle * 3) * (0.8 + depth * 0.6);
        const localX = Math.cos(u) * bellWidth * (1 - depth * 0.075) + edgeNoise;
        const localY = -Math.sin(u) * bellHeight * (1 - depth * 0.12)
          + depth * height * 0.014
          + Math.sin(u * 5 - loopAngle * 2 + layer) * 0.7;
        emit(localX, localY, 33 + Math.round((1 - depth) * 11), 6);
      }
    }

    const mistCount = 640;
    for (let point = 0; point < mistCount; point += 1) {
      const u = hash(point * 5.31 + 0.7) * Math.PI;
      const radius = Math.sqrt(hash(point * 8.17 + 3.6)) * 0.91;
      const localX = Math.cos(u) * bellWidth * radius
        + Math.sin(loopAngle * 2 + point) * width * 0.0015;
      const localY = -Math.sin(u) * bellHeight * radius
        + Math.sin(loopAngle * 3 + point * 1.9) * height * 0.0012;
      emit(localX, localY, 18, 2);
    }

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
          + Math.sin(v * Math.PI * 2 + rib * 0.8 + loopAngle * 2) * width * 0.003 * Math.sin(Math.PI * v);
        const localY = -bellHeight * 0.91 * (1 - curvedV) + targetY * curvedV;
        emit(localX, localY, 31, 5);
      }
    }

    const rimSamples = 330;
    for (let sample = 0; sample < rimSamples; sample += 1) {
      const v = sample / (rimSamples - 1);
      const localX = (v * 2 - 1) * bellWidth * 0.97;
      const localY = height * 0.010
        + Math.cos((v - 0.5) * Math.PI) * height * 0.013
        + Math.sin(v * Math.PI * 8 + loopAngle * 2) * height * 0.0025;
      emit(localX, localY, 55, 9);
    }

    const tentacleBases = [-0.78, -0.52, -0.27, 0, 0.27, 0.52, 0.78];
    const tentacleSamples = 150;
    for (let strand = 0; strand < tentacleBases.length; strand += 1) {
      const base = tentacleBases[strand];
      const length = height * (0.255 + hash(strand * 4.7 + 3.1) * 0.105);
      const phase = hash(strand * 7.9 + 1.3) * TAU;
      const frequency = 2.4 + hash(strand * 2.6 + 5.8) * 1.9;
      for (let sample = 0; sample < tentacleSamples; sample += 1) {
        const v = sample / (tentacleSamples - 1);
        const curl = Math.sin(v * Math.PI * frequency + phase + loopAngle * (1 + strand % 3))
          * width * (0.010 + v * 0.032);
        const secondaryCurl = Math.sin(v * Math.PI * 2 + phase * 1.7 - loopAngle * 2)
          * width * 0.010 * v;
        const localX = base * bellWidth * (1 - v * 0.20) + curl + secondaryCurl;
        const localY = height * 0.019 + v * length
          + Math.sin(v * Math.PI * 3 + phase + loopAngle * 2) * height * 0.005;
        emit(localX, localY, 49 - Math.round(v * 12), 8);
      }
    }
  }

  function renderJellies(loopAngle) {
    const travelX = width * 0.335;
    const travelY = height * 0.345;
    const localScale = width / 400 * 1.02;

    for (let group = 0; group < GROUP_COUNT; group += 1) {
      const firstCycle = 1 + (group % 5 === 0 ? 1 : 0);
      const secondCycle = 2 + (group % 4 === 0 ? 1 : 0);
      const verticalCycle = 1 + (group % 6 === 0 ? 1 : 0);
      const morphCycles = 2 + (group % 3);
      const phaseX = groupDriftPhaseX[group];
      const phaseY = groupDriftPhaseY[group];
      const driftX = Math.sin(loopAngle * firstCycle + phaseX) * 0.032
        + Math.sin(loopAngle * secondCycle + phaseY) * 0.012;
      const driftY = Math.sin(loopAngle * verticalCycle + phaseY) * 0.018
        + Math.sin(loopAngle * 3 + phaseX) * 0.009;
      const sway = Math.sin(loopAngle * (1 + (group % 7 === 0 ? 1 : 0)) + groupSwayPhase[group]) * 0.085;
      const morphTime = loopAngle * 2 * morphCycles;

      groupMorphTime[group] = morphTime;
      groupPulseOffset[group] = Math.sin(morphTime / 2 + groupPhase[group]) ** 3 / 3;
      groupAnchorX[group] = clamp((groupHomeX[group] + driftX) * width, width * 0.10, width * 0.90);
      groupAnchorY[group] = clamp((groupHomeY[group] + driftY) * height, height * 0.10, height * 0.90);
      groupSwaySin[group] = Math.sin(sway);
      groupSwayCos[group] = Math.cos(sway);
    }

    const count = width < 360 ? 3400 : SMALL_POINT_COUNT;
    for (let index = 0; index < count; index += 1) {
      const group = pointGroup[index];
      const m = groupPhase[group];
      const d = pointBaseD[index] - groupPulseOffset[group];
      const c = d / 16 + m;
      const p = d ** Math.sin(d * d - groupMorphTime[group] + m);
      const localX = travelX * (Math.sin(c) - Math.sin(m)) + pointK[index] * p * localScale;
      const localY = travelY * (Math.sin(c * 4) - Math.sin(m * 4)) + pointE[index] * p * localScale;
      const x = Math.round(groupAnchorX[group] + localX * groupSwayCos[group] - localY * groupSwaySin[group]);
      const y = Math.round(groupAnchorY[group] + localX * groupSwaySin[group] + localY * groupSwayCos[group]);
      const strength = groupStrength[group];

      depositPixel(x, y, strength);
      depositPixel(x - 1, y, strength >> 3);
      depositPixel(x + 1, y, strength >> 3);
      depositPixel(x, y - 1, strength >> 3);
      depositPixel(x, y + 1, strength >> 3);
    }

    jellyCtx.putImageData(jellyImage, 0, 0);
  }

  function renderParticles(loopAngle) {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    for (const particle of particles) {
      const x = particle.x + Math.sin(loopAngle * particle.cycleX + particle.phaseX) * 0.014;
      const y = particle.y + Math.sin(loopAngle * particle.cycleY + particle.phaseY) * 0.021;
      ctx.fillStyle = `rgba(198, 247, 255, ${particle.alpha})`;
      ctx.beginPath();
      ctx.arc(x * width, y * height, particle.radius, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function renderScene(seconds, now = performance.now()) {
    const normalized = ((seconds % LOOP_SECONDS) + LOOP_SECONDS) % LOOP_SECONDS;
    const loopAngle = TAU * normalized / LOOP_SECONDS;
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(backgroundCanvas, 0, 0);

    if (now - lastLightUpdate >= LIGHT_INTERVAL || lastLightUpdate === -Infinity) {
      renderLight(loopAngle);
      lastLightUpdate = now;
    }
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.92;
    ctx.drawImage(lightCanvas, 0, 0, width, height);
    ctx.restore();

    renderParticles(loopAngle);
    jellyPixels.fill(0);
    renderHeroJelly(loopAngle);
    renderJellies(loopAngle);
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.98;
    ctx.drawImage(jellyCanvas, 0, 0);
    ctx.restore();
  }

  function resize() {
    const bounds = stage.getBoundingClientRect();
    const nextWidth = clamp(Math.round(bounds.width), 280, 540);
    const nextHeight = Math.round(nextWidth * 16 / 9);
    if (nextWidth === width && nextHeight === height && jellyImage) return;

    width = nextWidth;
    height = nextHeight;
    canvas.width = width;
    canvas.height = height;
    jellyCanvas.width = width;
    jellyCanvas.height = height;
    jellyImage = jellyCtx.createImageData(width, height);
    jellyPixels = jellyImage.data;
    renderBackground();
    lastLightUpdate = -Infinity;
    renderScene(reducedMotion ? 7.4 : elapsed);
  }

  function frame(now) {
    if (!isRunning) return;
    if (!lastTick) lastTick = now;
    const delta = Math.min(100, now - lastTick);
    lastTick = now;
    accumulator += delta;
    if (accumulator >= FRAME_INTERVAL) {
      elapsed += accumulator / 1000;
      accumulator %= FRAME_INTERVAL;
      renderScene(elapsed, now);
    }
    animationFrame = requestAnimationFrame(frame);
  }

  function syncAnimation() {
    const shouldRun = !reducedMotion && !manuallyPaused && isIntersecting && !document.hidden;
    if (shouldRun === isRunning) return;
    isRunning = shouldRun;
    lastTick = 0;
    if (isRunning) animationFrame = requestAnimationFrame(frame);
    else cancelAnimationFrame(animationFrame);
  }

  formulaButton?.addEventListener("click", () => {
    const expanded = formulaButton.getAttribute("aria-expanded") === "true";
    formulaButton.setAttribute("aria-expanded", String(!expanded));
    if (formulaPanel) formulaPanel.hidden = expanded;
  });

  new ResizeObserver(resize).observe(stage);
  new IntersectionObserver(entries => {
    isIntersecting = entries[0]?.isIntersecting ?? false;
    syncAnimation();
  }, { threshold: 0.01 }).observe(stage);
  document.addEventListener("visibilitychange", syncAnimation);
  window.addEventListener("pagehide", () => {
    manuallyPaused = true;
    syncAnimation();
  });

  window.__MATHEMATICAL_JELLYFISH__ = Object.freeze({
    version: "1.0.0",
    loopSeconds: LOOP_SECONDS,
    pointCount: 4548 + SMALL_POINT_COUNT,
    formulaSourcePointCount: POINT_COUNT,
    renderAt(seconds) {
      renderScene(Number(seconds) || 0);
    },
    pause() {
      manuallyPaused = true;
      syncAnimation();
    },
    resume() {
      manuallyPaused = false;
      syncAnimation();
    },
    state() {
      return { elapsed, width, height, running: isRunning, intersecting: isIntersecting };
    },
  });

  resize();
  syncAnimation();
})();
