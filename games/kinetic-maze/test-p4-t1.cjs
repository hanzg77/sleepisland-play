"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const runtimePath = path.join(__dirname, "kinetic-maze-v4.js");
const runtimeSource = fs.readFileSync(runtimePath, "utf8");
assert.doesNotMatch(
  runtimeSource,
  /lineBandLifeSeconds|\bnormalX\s*=|\bnormalY\s*=/,
  "gesture propagation must not regress to copied normal-direction parallel line bands",
);

class MockElement {
  constructor() { this.textContent = ""; this.listeners = new Map(); this.attributes = new Map(); this.classList = { toggle() {} }; this.style = {}; this.hidden = false; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
}

function mockContext(callCounts = null) {
  return new Proxy({ globalAlpha: 1 }, {
    get(target, property) {
      if (property in target) return target[property];
      return () => {
        if (callCounts && typeof property === "string") callCounts[property] = (callCounts[property] || 0) + 1;
      };
    },
    set(target, property, value) { target[property] = value; return true; },
  });
}

class MockCanvas extends MockElement {
  constructor(callCounts = null) { super(); this.width = 1080; this.height = 1920; this.context = mockContext(callCounts); }
  getContext() { return this.context; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1080, height: 1920 }; }
  captureStream(fps = 30) {
    const videoTrack = { kind: "video", stop() {} };
    const tracks = [videoTrack];
    return {
      fps,
      addTrack(track) { tracks.push(track); },
      getTracks() { return [...tracks]; },
      getVideoTracks() { return tracks.filter((track) => track.kind === "video"); },
      getAudioTracks() { return tracks.filter((track) => track.kind === "audio"); },
    };
  }
}

function audioParam(initial = 0) {
  const automation = [];
  return {
    value: initial, automation,
    setValueAtTime(value, at = 0) { this.value = value; automation.push({ type: "set", value, at }); },
    exponentialRampToValueAtTime(value, at = 0) { this.value = value; automation.push({ type: "exponential", value, at }); },
    cancelScheduledValues(at = 0) { automation.push({ type: "cancel", at }); },
    cancelAndHoldAtTime(at = 0) { automation.push({ type: "hold", at }); },
    setTargetAtTime(value, at = 0, timeConstant = 0) { this.value = value; automation.push({ type: "target", value, at, timeConstant }); },
  };
}

function audioNode() {
  return {
    gain: audioParam(1), frequency: audioParam(440), Q: audioParam(1), playbackRate: audioParam(1), pan: audioParam(0),
    connect() { return this; }, start() {}, stop() {},
  };
}

class MockAudioContext {
  static instances = [];
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.destination = audioNode();
    this.oscillatorStarts = [];
    this.compressorNodes = [];
    this.gainNodes = [];
    this.waveShaperNodes = [];
    MockAudioContext.instances.push(this);
  }
  createBiquadFilter() { return audioNode(); }
  createDynamicsCompressor() {
    const node = { ...audioNode(), threshold: audioParam(), knee: audioParam(), ratio: audioParam(), attack: audioParam(), release: audioParam() };
    this.compressorNodes.push(node);
    return node;
  }
  createGain() { const node = audioNode(); this.gainNodes.push(node); return node; }
  createWaveShaper() { const node = { ...audioNode(), curve: null, oversample: "none" }; this.waveShaperNodes.push(node); return node; }
  createMediaStreamDestination() {
    const node = audioNode();
    node.stream = { getAudioTracks() { return [{ kind: "audio", stop() {} }]; } };
    return node;
  }
  createStereoPanner() { return audioNode(); }
  createOscillator() {
    const node = audioNode();
    node.start = (when = 0) => { this.oscillatorStarts.push(when); };
    return node;
  }
  createBufferSource() { return audioNode(); }
  createBuffer(_channels, length) { const values = new Float32Array(length); return { getChannelData() { return values; } }; }
  resume() { this.state = "running"; return Promise.resolve(); }
  suspend() { this.state = "suspended"; return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
}

const canvas = new MockCanvas();
const elements = new Map([
  ["#kinetic-maze-v4", canvas],
  ["#seed-label", new MockElement()],
  ["#status-label", new MockElement()],
  ["#start-control", new MockElement()],
  ["#chrome", new MockElement()],
  ["#hint-label", new MockElement()],
  ["#meta-bar", new MockElement()],
]);

global.HTMLCanvasElement = MockCanvas;
global.document = { querySelector(selector) { return elements.get(selector) || null; } };
global.window = { location: { search: "?seed=v4-growth-preview&mode=growth" }, AudioContext: MockAudioContext };
let scheduledFrame = null;
global.requestAnimationFrame = (callback) => { scheduledFrame = callback; return 1; };
global.cancelAnimationFrame = () => {};

require(runtimePath);
const debug = global.window.__KINETIC_V4_DEBUG__;
assert.ok(debug);
assert.equal(debug.version, "4.8-live-capture-r16");
const liveCaptureStream = debug.createLiveCaptureStream(30);
assert.equal(liveCaptureStream.fps, 30);
assert.equal(liveCaptureStream.getVideoTracks().length, 1);
assert.equal(liveCaptureStream.getAudioTracks().length, 1);
const designFrame = debug.getFrame();
assert.deepEqual(designFrame, {
  x: 36, y: 160, width: 1008, height: 1640,
  cellWidth: 112, cellHeight: 102.5,
}, "the phone-first mechanism frame must use 93.3% of the canvas width while preserving the vertical rhythm");
assert.deepEqual(debug.getWaveVisuals(), {
  texturePixelAlpha: 160,
  textureGamma: 0.9,
  textureLayerAlpha: 0.8,
  segmentRingAlpha: 0.16,
  pointRingAlpha: 0.35,
  accentBaseAlpha: 0.09,
  accentEnergyAlpha: 0.31,
}, "ripple rendering must stay lighter without changing the physical wave configuration");
const waveVisualAudit = debug.auditWaveVisuals();
assert.deepEqual(waveVisualAudit.alphaSamples, [
  { energy: 0, alpha: 0 },
  { energy: 0.02, alpha: 0 },
  { energy: 0.13, alpha: 22 },
  { energy: 0.5, alpha: 84 },
  { energy: 1, alpha: 160 },
], "the lighter texture curve must preserve faint fronts while preventing the field from becoming a white sheet");
assert.equal(waveVisualAudit.monotonic, true);
assert.equal(waveVisualAudit.peakLayerAlpha, 0.501961);
assert.equal(waveVisualAudit.fieldUnchanged, true, "visual alpha mapping must not mutate the physical wave field");
assert.equal(waveVisualAudit.physicalConfigIndependent, true, "visual tuning must remain disjoint from propagation and trigger defaults");

const components = debug.getComponents();
assert.equal(components.length, 144);
assert.equal(typeof debug.getResponseField, "function", "debug API must expose the lightweight response-field dimensions");
const responseField = debug.getResponseField();
assert.equal(responseField.cols, 18);
assert.equal(responseField.rows, 32);
assert.equal(responseField.count, 18 * 32, "the lightweight response field must contain exactly 576 reeds");
const denseDetailAudit = debug.auditDenseDetailRendering();
assert.equal(denseDetailAudit.baseline.detailDrawCount, 144);
assert.equal(denseDetailAudit.dense.detailDrawCount, 576, "the 18x32 render experiment must execute four real detail draws per semantic mechanism");
assert.equal(denseDetailAudit.semanticComponentCount, 144, "the render-only A/B must not multiply hit, state, or audio entities");
assert.equal(denseDetailAudit.hitTargetCount, 144);
assert.equal(denseDetailAudit.dense.responseReedCount, 0, "the fair dense-details arm replaces lightweight reeds");
const responseReedAudit = debug.auditResponseReedPolicy();
assert.ok(responseReedAudit.visibleCrestFloor <= responseReedAudit.componentThreshold, "response reeds should announce the crest no later than the mechanism trigger");
assert.deepEqual(responseReedAudit.below, { positive: 0, negative: 0, unchanged: true }, "sub-crest energy belongs to the continuous texture, not 576 extra line segments");
assert.ok(responseReedAudit.positive.positive > 0 && responseReedAudit.positive.negative === 0, "a positive threshold crest must enter only positive reed buckets");
assert.ok(responseReedAudit.negative.negative > 0 && responseReedAudit.negative.positive === 0, "a negative threshold crest must enter only negative reed buckets");
assert.equal(responseReedAudit.fieldUnchanged, true, "render preparation must not modify the physical field or trigger state");
assert.deepEqual(components.reduce((counts, component) => {
  counts[component.type] = (counts[component.type] || 0) + 1;
  return counts;
}, {}), { pendulum: 30, glider: 28, rotor: 28, mallet: 30, ribbon: 28 });

const dark = debug.auditDarkFreeze();
assert.deepEqual(dark, { componentCount: 144, allFrozen: true, eventCount: 0, activeCount: 0 });

const closed = debug.auditClosedCycles();
assert.equal(closed.sampleCount, 144 * 4);
assert.equal(closed.allClosed, true, "every integer cycle count must return to the exact dark pose");

const geometry = debug.auditGeometry();
assert.equal(geometry.componentCount, 144);
assert.equal(geometry.allGliderEdgesReal, true);
assert.equal(geometry.allGliderRoutesContinuous, true);
assert.ok(geometry.multiEdgeGliderRatio >= 0.3, "at least 30% of gliders must turn across multiple present walls");
assert.ok(geometry.gliderRouteLengths.every((length) => length >= 1 && length <= 3));
assert.equal(geometry.allMalletAnchorsOnWalls, true);
assert.equal(geometry.allRibbonStartsOnWalls, true);
assert.equal(geometry.allPendulumAnchorsOnWalls, true);

for (const component of components) {
  const preview = debug.previewOneShot(component.id, 1 / 60);
  assert.equal(preview.activation.completeAt, component.basePeriod * preview.activation.cycleCount);
  assert.ok(preview.activation.cycleCount >= 1 && preview.activation.cycleCount <= 4);
  assert.equal(preview.events.length, component.eventCountPerCycle * preview.activation.cycleCount, `${component.id} must emit every event in every bright cycle`);
  assert.ok(preview.events.length >= 1, `${component.id} must produce sound events`);
  assert.ok(Math.max(...preview.samples.map((sample) => sample.value)) - Math.min(...preview.samples.map((sample) => sample.value)) > 0.18, `${component.id} must visibly move`);
  assert.equal(preview.finalState, "darkFrozen", `${component.id} must freeze only on a complete cycle boundary`);
  assert.equal(preview.completedCount, 1);
  assert.ok(preview.samples.some((sample) => sample.phase === "active" || sample.phase === "settle"));
}

const pendulum = components.find((component) => component.type === "pendulum");
const pendulumPreview = debug.previewOneShot(pendulum.id);
const pendulumSounds = pendulumPreview.events.filter((event) => event.kind === "pendulum-center");
assert.ok(pendulumSounds.length >= 4, "pendulum one-shots use at least two physical cycles");
assert.ok(pendulumSounds[2], "the third center crossing must always have a sound event");

const initialSnapshot = debug.getSnapshot();
assert.equal(initialSnapshot.active.length, 1, "growth should begin with one real activation");
assert.equal(initialSnapshot.litCount, 1);

const growthAudit = debug.auditGrowth("v4-growth-preview");
assert.deepEqual(growthAudit.milestoneCounts, [
  { at: 0, count: 1 }, { at: 2, count: 2 }, { at: 5, count: 4 },
  { at: 9, count: 8 }, { at: 14, count: 16 }, { at: 20, count: 24 },
  { at: 27, count: 36 }, { at: 35, count: 48 }, { at: 44, count: 64 },
  { at: 54, count: 80 }, { at: 65, count: 96 }, { at: 77, count: 112 },
  { at: 90, count: 128 },
]);
assert.equal(growthAudit.finalLitCount, 128);
assert.equal(growthAudit.targetCount, 128);
assert.equal(growthAudit.selectedComponentCount, 128);
assert.ok(Object.values(growthAudit.selectedTypeCounts).every((count) => count >= 25 && count <= 27), "the 128-player ensemble should keep all five types balanced");
assert.equal(growthAudit.allOneTwentyEightSoundInFinalWindow, true, "all 128 lit components must sound in the peak window");
assert.ok(growthAudit.minimumEventsPerLitComponent >= 1);
assert.ok(growthAudit.tickLoads.maxTotal > 0);
assert.equal(growthAudit.allPendulumCrossingsSound, true);
assert.equal(growthAudit.thirdPendulumCrossingAlwaysSound, true);
assert.ok(growthAudit.cycleCounts.length >= 3, "bright durations must vary across integer cycle counts");

const growth30 = debug.previewGrowth("v4-growth-preview", 122, 1 / 30);
const growth60 = debug.previewGrowth("v4-growth-preview", 122, 1 / 60);
assert.deepEqual(growth30.plan, growth60.plan, "growth plan must not depend on rendering cadence");
assert.deepEqual(growth30.events, growth60.events, "physical sound event sequence must match at 30fps and 60fps");
assert.deepEqual(growth30.activations, growth60.activations, "cycle scheduling must match at 30fps and 60fps");
assert.deepEqual(growth30.tickLoads, growth60.tickLoads);

for (const seed of ["growth-bold-a", "growth-bold-b", "growth-bold-c"]) {
  const seeded = debug.auditGrowth(seed);
  assert.equal(seeded.finalLitCount, 128, `${seed} must reach 128 lit components`);
  assert.equal(seeded.allOneTwentyEightSoundInFinalWindow, true, `${seed} must let every lit component sound in the peak window`);
  assert.equal(seeded.missingSoundComponentIds.length, 0);
  assert.equal(seeded.allPendulumCrossingsSound, true, `${seed} must sound every pendulum center crossing`);
  assert.equal(seeded.thirdPendulumCrossingAlwaysSound, true, `${seed} must include the third pendulum crossing`);
}

const performance30 = debug.auditPerformance("v4-three-minute", 1 / 30);
const performance60 = debug.auditPerformance("v4-three-minute", 1 / 60);
assert.deepEqual(performance30.milestoneCounts, [
  { at: 0, count: 1 }, { at: 4, count: 2 }, { at: 9, count: 4 },
  { at: 16, count: 8 }, { at: 25, count: 16 }, { at: 36, count: 24 },
  { at: 49, count: 36 }, { at: 63, count: 48 }, { at: 78, count: 64 },
  { at: 94, count: 80 }, { at: 108, count: 96 }, { at: 118, count: 112 },
  { at: 128, count: 128 },
]);
assert.equal(performance30.peakBeforeFinale, 128);
assert.equal(performance30.finaleStartCount, 128);
assert.equal(performance30.finaleEndCount, 0);
assert.equal(performance30.finalCount, 0);
assert.equal(performance30.finaleMonotonic, true);
assert.equal(performance30.retirementCount, 128);
assert.ok(performance30.retirementBucketCount >= 8, "retirements should breathe across at least eight half-second buckets");
assert.ok(performance30.retirementRange[0] >= 168 - 1e-6);
assert.ok(performance30.retirementRange[1] <= 178 + 1e-6);
assert.equal(performance30.allRetireOnCompleteCycle, true);
assert.equal(performance30.allAfterPrepSingleCycle, true);
assert.equal(performance30.noActivationPastRetireEnd, true);
assert.ok(performance30.lastEventAt < 178);
assert.deepEqual(performance30.milestoneCounts, performance60.milestoneCounts);
assert.deepEqual(performance30.retirements, performance60.retirements, "finale boundaries must not depend on 30fps or 60fps stepping");
assert.equal(performance30.eventCount, performance60.eventCount);
for (const performanceSeed of ["v4-performance-a", "v4-performance-b", "v4-performance-c"]) {
  const seededPerformance = debug.auditPerformance(performanceSeed, 1 / 60);
  assert.equal(seededPerformance.peakBeforeFinale, 128, `${performanceSeed} must hold the full ensemble before release`);
  assert.equal(seededPerformance.finaleMonotonic, true, `${performanceSeed} release must be monotonic`);
  assert.equal(seededPerformance.retirementCount, 128, `${performanceSeed} must retire all 128 complete-cycle voices`);
  assert.equal(seededPerformance.finaleEndCount, 0, `${performanceSeed} must be fully dark by 178s`);
  assert.equal(seededPerformance.finalCount, 0, `${performanceSeed} must remain dark at 180s`);
  assert.equal(seededPerformance.allAfterPrepSingleCycle, true);
  assert.equal(seededPerformance.noActivationPastRetireEnd, true);
}

assert.equal(debug.hitTestPoint(designFrame.x + 1, designFrame.y + 1), 0);
assert.equal(debug.hitTestPoint(designFrame.x + designFrame.width - 1, designFrame.y + designFrame.height - 1), 143);
assert.equal(debug.hitTestPoint(20, 20), null);

assert.deepEqual(debug.auditAutoplayPolicy(), {
  running: { intentOn: true, contextState: "running", enabled: true, needsPointer: false },
  suspended: { intentOn: true, contextState: "suspended", enabled: false, needsPointer: true },
  unavailable: { intentOn: true, contextState: "unavailable", enabled: false, needsPointer: false },
  explicitOff: { intentOn: false, contextState: "running", enabled: false, needsPointer: false },
});
assert.equal(debug.getAudioState().intentOn, true, "refresh defaults to sound intent on");
assert.equal(debug.getAudioState().contextState, "running");
const audioSmoke = debug.auditAudioSmoke();
assert.equal(audioSmoke.available, true);
assert.equal(audioSmoke.frictionStarts, 1, "a lit glider must create a bounded friction voice");
assert.ok(audioSmoke.contactEvents >= 2, "a complete glider cycle must create endpoint/corner contacts");
assert.ok(audioSmoke.scheduledEvents >= audioSmoke.contactEvents);
assert.equal(audioSmoke.activeFrictionVoices, 0, "glider friction must stop when the activation goes dark");

const safetyEngine = new debug.AudioEngine(true, { gestureVoiceLimit: 16, motifVoiceLimit: 12, mechanismVoiceLimit: 24, frictionVoiceLimit: 12 });
assert.equal(safetyEngine.initialize(), true);
assert.equal(safetyEngine.setEnabled(true), true);
const safetyContext = safetyEngine.context;
const safetyDiagnostics = safetyEngine.diagnostics();
assert.equal(safetyContext.compressorNodes.length, 2, "the musical compressor must feed a separate final peak limiter");
assert.equal(safetyDiagnostics.outputLimiterReady, true);
assert.equal(safetyDiagnostics.outputSoftLimiterReady, true);
assert.deepEqual(safetyDiagnostics.outputSafety, {
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
const finalLimiter = safetyContext.compressorNodes[1];
assert.equal(finalLimiter.threshold.value, -4.5);
assert.equal(finalLimiter.knee.value, 0);
assert.equal(finalLimiter.ratio.value, 20);
assert.equal(finalLimiter.attack.value, 0.002);
assert.equal(finalLimiter.release.value, 0.08);
assert.equal(safetyContext.waveShaperNodes.length, 1);
const softLimiter = safetyContext.waveShaperNodes[0];
assert.equal(softLimiter.oversample, "4x");
assert.equal(softLimiter.curve.length, 2049);
assert.ok(Math.abs(softLimiter.curve[0] + 0.92) < 1e-6);
assert.equal(softLimiter.curve[1024], 0);
assert.ok(Math.abs(softLimiter.curve.at(-1) - 0.92) < 1e-6);
assert.ok(softLimiter.curve.every((value, index, values) => index === 0 || value >= values[index - 1]), "soft limiter curve must remain monotonic instead of folding peaks into harsh distortion");
const frictionSamples = safetyEngine.frictionBuffer.getChannelData(0);
assert.ok(Math.abs(frictionSamples[0]) < 0.001 && Math.abs(frictionSamples.at(-1)) < 0.001, "looping friction noise must cross its buffer seam near zero");
assert.ok(frictionSamples.some((value, index) => index > 512 && index < frictionSamples.length - 512 && Math.abs(value) > 0.05), "seam taper must not erase the useful body of the friction texture");

const safetyComponent = debug.getComponents().find((component) => component.type === "glider");
safetyEngine.play([{
  at: 0, activationId: "noise-safety", activationMode: "melodyWave",
  componentId: safetyComponent.id, type: safetyComponent.type, kind: "glider-contact-metal",
  pitch: 60, accent: 1, gainScale: 1, sourceU: 0.5,
}], 0, 1);
const noiseGainAutomation = safetyContext.gainNodes.at(-1).gain.automation;
assert.deepEqual(noiseGainAutomation.slice(0, 3).map((entry) => entry.type), ["set", "exponential", "exponential"]);
assert.equal(noiseGainAutomation[0].value, 0.0001, "random-buffer percussion must begin effectively silent instead of hard-starting at full gain");
assert.ok(Math.abs((noiseGainAutomation[1].at - noiseGainAutomation[0].at) - 0.005) < 1e-9, "noise transients need a 5ms de-click attack");
assert.equal(safetyEngine.diagnostics().lastNoiseAttackSeconds, 0.005);

safetyEngine.play([
  { at: 1, activationId: "motif-retrigger", kind: "motif-note", componentId: 1, type: "rotor", pitch: 60, accent: 1, gainScale: 1, sourceU: 0.5, motifFamily: "public-domain", motifNoteIndex: 0, motifNoteCount: 2, motifPerformanceEndsAt: 1.4, duration: 0.1 },
  { at: 1.05, activationId: "motif-retrigger", kind: "motif-note", componentId: 1, type: "rotor", pitch: 64, accent: 1, gainScale: 1, sourceU: 0.5, motifFamily: "public-domain", motifNoteIndex: 1, motifNoteCount: 2, motifPerformanceEndsAt: 1.4, duration: 0.1 },
], 1, 1);
const motifGainAutomation = safetyContext.gainNodes.at(-1).gain.automation;
const motifHold = motifGainAutomation.find((entry) => entry.type === "hold");
const motifReleaseTarget = motifGainAutomation.find((entry) => entry.type === "target");
const motifRestart = motifGainAutomation.find((entry) => entry.type === "set" && motifReleaseTarget && entry.at > motifReleaseTarget.at);
assert.ok(motifHold && motifReleaseTarget && motifRestart, "overlapping motif notes must hold and release the old envelope before retriggering");
assert.ok(Math.abs((motifRestart.at - motifReleaseTarget.at) - 0.006) < 1e-9, "motif retrigger must reserve a 6ms de-click release");

safetyEngine.play([0, 0.04, 0.1].map((offset, index) => ({
  at: 2 + offset, activationId: `catchup-${index}`, activationMode: "melodyWave",
  componentId: safetyComponent.id, type: safetyComponent.type, kind: "glider-contact-wood",
  pitch: 60, accent: 1, gainScale: 1, sourceU: 0.5,
})), 2.1, 3);
assert.deepEqual(
  safetyEngine.diagnostics().lastCatchupScheduleOffsets,
  [0, 0.028, 0.07],
  "a 100ms late batch must retain relative timing in a short window instead of collapsing every onset to the same 2ms point",
);
safetyEngine.setEnabled(false);

const interactionAudit = debug.auditInteraction();
assert.equal(interactionAudit.initialStartedCount, 6);
assert.equal(interactionAudit.initialQueuedCount, 4);
assert.equal(interactionAudit.duplicateStatus, "alreadyPlaying");
assert.equal(interactionAudit.completedCount, 10);
assert.equal(interactionAudit.uniqueCompletedCount, 10);
assert.deepEqual(interactionAudit.fifoStartedOrder, interactionAudit.ids, "queued clicks must start in original FIFO order");
assert.equal(interactionAudit.allCompletedAtContractBoundary, true, "one-shots must complete at their original immutable boundary");
assert.equal(interactionAudit.allEventSetsComplete, true, "every clicked component must emit its full physical event set");
assert.equal(interactionAudit.maxActive, 6);
assert.equal(interactionAudit.finalQueueCount, 0);
assert.ok(interactionAudit.drain.inFlightCount > 0);
assert.equal(interactionAudit.drain.retainedCount, interactionAudit.drain.inFlightCount);
assert.equal(interactionAudit.drain.activationCountUnchanged, true, "draining to interaction must not create replacement persistent cycles");
assert.equal(interactionAudit.drain.allInFlightCompletedAtOriginalBoundary, true, "mode switch must preserve every in-flight completion boundary");
assert.equal(interactionAudit.drain.finalActiveCount, 0);
assert.equal(interactionAudit.drain.finalLitCount, 0);

const clickIds = components.slice(0, 10).map((component) => component.id);
const interaction30 = debug.previewInteraction(clickIds, 1 / 30);
const interaction60 = debug.previewInteraction(clickIds, 1 / 60);
assert.deepEqual(interaction30.startedOrder, interaction60.startedOrder, "FIFO start boundaries must not depend on 30fps or 60fps rendering");
assert.deepEqual(interaction30.completed, interaction60.completed, "immutable completion boundaries must match across frame rates");
assert.deepEqual(interaction30.eventCounts, interaction60.eventCounts, "complete click sound sets must match across frame rates");

// Ripple mode: self-sustaining, stage-free population that starts from one ember and follows a wandering target.
assert.deepEqual(debug.getLitRange(), { min: 8, max: 80 });
for (const rippleSeed of ["v4-growth-preview", "ripple-a", "ripple-b"]) {
  const ripple = debug.auditRipple(rippleSeed, 240);
  assert.equal(ripple.deterministicAcrossFrameRates, true, `${rippleSeed} ripple events/activations must match at 30fps and 60fps`);
  assert.equal(ripple.startsWithOne, true, `${rippleSeed} must start from a single ember`);
  assert.equal(ripple.neverEmpty, true, `${rippleSeed} must never go fully dark once started`);
  assert.ok(ripple.litAt10 <= 8, `${rippleSeed} must grow slowly at first (lit at 10s = ${ripple.litAt10})`);
  assert.ok(ripple.litAt120 >= ripple.range.min, `${rippleSeed} must reach the lit band (lit at 120s = ${ripple.litAt120})`);
  assert.ok(ripple.maxLit <= ripple.range.max, `${rippleSeed} idle ripple must stay within the lit band (max ${ripple.maxLit})`);
  assert.equal(ripple.allCycleCountsBounded, true);
  assert.equal(ripple.allSpawnsAdjacent, true, `${rippleSeed} spread must only reach cells near a lit component`);
  assert.ok(ripple.spawnCount > 30, `${rippleSeed} must propagate through sparks`);
  assert.equal(ripple.sweepSeededAll, true, `${rippleSeed} sweeping cells must light every swept dark cell at once`);
  assert.equal(ripple.sweepBoosted, true, `${rippleSeed} a sweep must lift the population target`);
}
const rippleFluctuation = debug.previewRipple("v4-growth-preview", 420, 1 / 30);
const bandSamples = rippleFluctuation.litCurve.filter((sample) => sample.at >= 120).map((sample) => sample.lit);
assert.ok(Math.max(...bandSamples) - Math.min(...bandSamples) >= 16, `lit population must fluctuate widely (range ${Math.min(...bandSamples)}–${Math.max(...bandSamples)})`);

// Ripple tunables: defaults ← host config object ← URL parameters, with range normalization.
const defaults = debug.getRippleDefaults();
assert.deepEqual(debug.getRippleConfig(), debug.resolveRippleConfig("", null), "runtime config must equal resolved defaults when nothing overrides");
assert.equal(defaults.litMin, 8);
assert.equal(defaults.litMax, 80);
const hostResolved = debug.resolveRippleConfig("", { litMin: 6, litMax: 60, rampSeconds: 45, wanderPeriods: [30, 50, 70], sparkCap: "0.4" });
assert.equal(hostResolved.litMin, 6);
assert.equal(hostResolved.litMax, 60);
assert.equal(hostResolved.rampSeconds, 45);
assert.deepEqual(hostResolved.wanderPeriods, [30, 50, 70]);
assert.equal(hostResolved.sparkCap, 0.4);
const urlResolved = debug.resolveRippleConfig("?lit=12-40&ramp=30&rampCurve=1&boost=2&boostDecay=8&sparkCap=0.8&cycles=2-4&wander=20,40,80&hint=3", { litMin: 6, litMax: 60 });
assert.equal(urlResolved.litMin, 12, "URL must override host config");
assert.equal(urlResolved.litMax, 40);
assert.equal(urlResolved.rampSeconds, 30);
assert.equal(urlResolved.rampCurve, 1);
assert.equal(urlResolved.boostPerSeed, 2);
assert.equal(urlResolved.boostDecay, 8);
assert.equal(urlResolved.sparkCap, 0.8);
assert.equal(urlResolved.cyclesMin, 2);
assert.equal(urlResolved.cyclesMax, 4);
assert.deepEqual(urlResolved.wanderPeriods, [20, 40, 80]);
assert.equal(urlResolved.hintSeconds, 3);
const clamped = debug.resolveRippleConfig("?lit=200-3&sparkCap=9&cycles=5-1");
assert.equal(clamped.litMin, 143, "litMin clamps to grid size - 1");
assert.equal(clamped.litMax, 144, "litMax stays above litMin");
assert.equal(clamped.sparkCap, 1);
assert.equal(clamped.cyclesMin, 5);
assert.equal(clamped.cyclesMax, 5, "cyclesMax is raised to cyclesMin when inverted");
assert.deepEqual(debug.resolveRippleConfig("?lit=abc&wander=1,2"), debug.resolveRippleConfig(""), "malformed URL values are ignored");
const fastRipple = debug.previewRipple("v4-growth-preview", 60, 1 / 30, { config: { rampSeconds: 20, litMin: 20, litMax: 40 } });
const slowRipple = debug.previewRipple("v4-growth-preview", 60, 1 / 30);
assert.ok(fastRipple.stats.target > slowRipple.stats.target, "a shorter ramp must lift the target sooner");
assert.ok(fastRipple.finalLit > slowRipple.finalLit, "config overrides must change the simulated population");
assert.ok(fastRipple.maxLit <= 40);

// Melody mode: gesture timing becomes the score; replay is bounded, layered, fading, and frame-rate independent.
const melodyDefaults = debug.getMelodyDefaults();
assert.equal(melodyDefaults.waveCols, 36);
assert.equal(melodyDefaults.waveRows, 64);
assert.equal(melodyDefaults.waveSpeed, 230);
assert.equal(melodyDefaults.waveLife, 9);
assert.equal(melodyDefaults.waveWidth, 60);
assert.equal(melodyDefaults.wallPenalty, 140);
assert.equal(melodyDefaults.componentThreshold, 0.13);
assert.equal(melodyDefaults.waveRepeatFade, 1);
assert.equal(melodyDefaults.maxWaves, 48);
assert.equal(melodyDefaults.voiceLimit, 16);
assert.equal(melodyDefaults.mechanismVoiceLimit, 24);
assert.equal(melodyDefaults.componentCycles, 1);
assert.equal(melodyDefaults.componentPeriodScale, 0.3);
assert.equal(melodyDefaults.componentLimit, 24);
assert.equal(melodyDefaults.strokeComponentLimit, 12);
assert.equal(melodyDefaults.motifCount, 12);
assert.equal(melodyDefaults.motifGain, 0.82);
assert.equal(melodyDefaults.motifCooldown, 10);
assert.equal(melodyDefaults.motifVoiceLimit, 12);
const melodyResolved = debug.resolveMelodyConfig("?waveGrid=24x40&phraseLoops=4&phraseFade=.6&wavePhraseFade=.84&phraseLayers=2&voiceCap=12&mechanismCap=21&waveCap=20&componentCap=14&strokeCap=9&componentCycles=3&componentGain=.4&waveWall=140", { waveCols: 12, waveRows: 20 });
assert.equal(melodyResolved.waveCols, 24);
assert.equal(melodyResolved.waveRows, 40);
assert.equal(melodyResolved.repeatCount, 4);
assert.equal(melodyResolved.repeatFade, 0.6);
assert.equal(melodyResolved.waveRepeatFade, 0.84);
assert.equal(melodyResolved.maxPhrases, 2);
assert.equal(melodyResolved.voiceLimit, 12);
assert.equal(melodyResolved.mechanismVoiceLimit, 21);
assert.equal(melodyResolved.maxWaves, 20);
assert.equal(melodyResolved.componentLimit, 14);
assert.equal(melodyResolved.strokeComponentLimit, 9);
assert.equal(melodyResolved.componentCycles, 3);
assert.equal(melodyResolved.componentGain, 0.4);
assert.equal(melodyResolved.wallPenalty, 140);
assert.ok(debug.resolveMelodyConfig("?waveGrid=36x64").waveCols * debug.resolveMelodyConfig("?waveGrid=36x64").waveRows <= 2304);

const melodyAudit = debug.auditMelody();
assert.equal(melodyAudit.deterministicAcrossFrameRates, true, "melody note/replay boundaries must not depend on 30fps or 60fps stepping");
assert.equal(melodyAudit.phraseCount, 2, "two strokes must remain two independent voices");
assert.equal(melodyAudit.orderedLiveTimes, true);
assert.equal(melodyAudit.preservesNonUniformTiming, true, "gesture timing must not collapse into one logical timestamp");
assert.deepEqual(melodyAudit.repeatNumbers, [1, 2, 3]);
assert.equal(melodyAudit.gainsStrictlyFade, true);
assert.ok(melodyAudit.maxWaveCount <= melodyAudit.waveCap);
assert.equal(melodyAudit.wavePointCount, 36 * 64, "the dense wave field remains independent from the 144 detailed mechanisms");
assert.ok(Math.abs(melodyAudit.openStepRatio - 1) < 1e-5, `an open neighboring step should keep its direct distance (ratio ${melodyAudit.openStepRatio})`);
assert.ok(melodyAudit.maximumEdgeAsymmetry < 1e-7, "wall and sealed-corner propagation must be bidirectionally symmetric");
assert.ok(melodyAudit.maximumFieldError < 1e-6, "wave-major sampling must remain numerically equivalent to point sampling");
const lineFieldAudit = debug.auditLineSourceField();
assert.ok(Math.abs(lineFieldAudit.pointEnergyAtFrom) < 1e-7, "a distant point source must not energize the other endpoint at age zero");
assert.ok(lineFieldAudit.lineEnergyAtFrom > melodyDefaults.componentThreshold, "a line source must energize its from endpoint immediately");
assert.ok(lineFieldAudit.segmentSeedCount > 12, "the field audit must cover a segment much longer than one pointer sampling gap");
assert.ok(Math.abs(lineFieldAudit.pointEnergyAtMidpoint) < 1e-7, "a distant endpoint circle must not masquerade as a continuous line source");
assert.ok(lineFieldAudit.lineEnergyAtMidpoint > melodyDefaults.componentThreshold, "the rasterized line midpoint must be energized at the segment timestamp");
assert.equal(lineFieldAudit.pointFieldMatchesAmplitude, true);
assert.equal(lineFieldAudit.lineFieldMatchesAmplitude, true, "sampleField and amplitudeAt must both use the line endpoint distance");
assert.equal(lineFieldAudit.midpointFieldMatchesAmplitude, true);
assert.ok(lineFieldAudit.maximumMultiSourceDistanceError < 5e-4, "multi-source Dijkstra must equal the independent minimum of every rasterized point-source field");

function graphEdge(graph, from, to) {
  const start = from * 8;
  for (let slot = start; slot < start + 8; slot += 1) {
    if (graph.neighbors[slot] === to) return { slot, cost: graph.costs[slot] };
  }
  return null;
}

function referenceWaveDijkstra(graph) {
  const count = graph.cols * graph.rows;
  const distances = new Float64Array(count);
  distances.fill(Infinity);
  distances[graph.source] = 0;
  const parents = new Int32Array(count);
  parents.fill(-1);
  const visited = new Uint8Array(count);
  for (let iteration = 0; iteration < count; iteration += 1) {
    let current = -1;
    let currentDistance = Infinity;
    for (let index = 0; index < count; index += 1) {
      if (!visited[index] && distances[index] < currentDistance) {
        current = index;
        currentDistance = distances[index];
      }
    }
    if (current < 0) break;
    visited[current] = 1;
    const start = current * 8;
    for (let slot = start; slot < start + 8; slot += 1) {
      const next = graph.neighbors[slot];
      if (next < 0 || visited[next]) continue;
      const candidate = currentDistance + graph.costs[slot];
      if (candidate >= distances[next] - 1e-9) continue;
      distances[next] = candidate;
      parents[next] = current;
    }
  }
  return { distances, parents };
}

function reconstructReferencePath(parents, source, target) {
  const path = [];
  let current = target;
  for (let guard = 0; guard <= parents.length && current >= 0; guard += 1) {
    path.push(current);
    if (current === source) return path.reverse();
    current = parents[current];
  }
  return [];
}

const waveGraph = debug.inspectWaveGraph(47);
const referenceWave = referenceWaveDijkstra(waveGraph);
const blockedDirect = graphEdge(waveGraph, 47, 48);
const blockedDirectDistance = Math.hypot(waveGraph.x[48] - waveGraph.x[47], waveGraph.y[48] - waveGraph.y[47]);
const horizontalWaveStep = designFrame.width / 36;
const verticalWaveStep = designFrame.height / 64;
assert.ok(blockedDirect);
assert.ok(Math.abs(blockedDirectDistance - horizontalWaveStep) < 1e-6);
assert.ok(Math.abs(blockedDirect.cost - (horizontalWaveStep + melodyDefaults.wallPenalty)) < 1e-4, "the production adjacency must add the configured wall penalty");
assert.ok(Math.abs(referenceWave.distances[48] - (verticalWaveStep * 5 + Math.hypot(horizontalWaveStep, verticalWaveStep))) < 1e-4);
assert.ok(Math.abs(waveGraph.productionDistances[48] - referenceWave.distances[48]) < 1e-4, "production Dijkstra must match an independent implementation");
let maximumGraphDistanceError = 0;
for (let index = 0; index < waveGraph.productionDistances.length; index += 1) {
  maximumGraphDistanceError = Math.max(maximumGraphDistanceError, Math.abs(waveGraph.productionDistances[index] - referenceWave.distances[index]));
}
assert.ok(maximumGraphDistanceError < 5e-4, `all dense-field distances must match the independent graph solver (${maximumGraphDistanceError})`);
const diffractionPath = reconstructReferencePath(referenceWave.parents, 47, 48);
assert.deepEqual(diffractionPath, [47, 83, 119, 155, 120, 84, 48]);
for (let index = 1; index < diffractionPath.length; index += 1) {
  const from = diffractionPath[index - 1];
  const to = diffractionPath[index];
  const edge = graphEdge(waveGraph, from, to);
  const geometric = Math.hypot(waveGraph.x[to] - waveGraph.x[from], waveGraph.y[to] - waveGraph.y[from]);
  assert.ok(edge && Math.abs(edge.cost - geometric) < 1e-4, "the verified bend must travel only through open edges");
}
assert.ok(referenceWave.distances[48] > blockedDirectDistance * 1.05, "the path must visibly detour around the wall end");
assert.ok(referenceWave.distances[48] < blockedDirect.cost - 0.5, "the open detour must beat crossing the penalized wall edge");

assert.equal(melodyAudit.flatAccentCount, 72, "the strongest wave bucket must obey its fixed draw quota");
assert.ok(melodyAudit.flatAccentRowCoverage >= 36, `stable wave accents must cover the 2D field rows (${melodyAudit.flatAccentRowCoverage}/64)`);
assert.ok(melodyAudit.flatAccentColumnCoverage >= 24, `stable wave accents must cover the 2D field columns (${melodyAudit.flatAccentColumnCoverage}/36)`);
assert.equal(melodyAudit.flatAccentQuadrantCoverage, 4, "stable wave accents must not collapse into a row-major stripe");

const accentAmplitudes = [1, 0.92, 0.84, 0.78, 0.72, 0.66];
const realisticAccent = debug.previewWaveAccents({
  at: 1,
  config: { waveSpeed: 430, waveLife: 2.6, waveWidth: 54 },
  waves: Array.from({ length: 24 }, (_, index) => ({
    componentId: (index * 5 + 11) % 144,
    amplitude: accentAmplitudes[index % accentAmplitudes.length],
    at: (index % 8) * 0.04 + Math.floor(index / 8) * 0.13,
  })),
});
const referenceAccentCandidates = Array.from({ length: realisticAccent.quotas.length }, () => []);
for (let index = 0; index < realisticAccent.field.length; index += 1) {
  const energy = Math.abs(realisticAccent.field[index]);
  if (energy < 0.2) continue;
  const row = Math.floor(index / realisticAccent.cols);
  const col = index - row * realisticAccent.cols;
  const neighbors = [];
  if (col > 0) neighbors.push(Math.abs(realisticAccent.field[index - 1]));
  if (col + 1 < realisticAccent.cols) neighbors.push(Math.abs(realisticAccent.field[index + 1]));
  if (row > 0) neighbors.push(Math.abs(realisticAccent.field[index - realisticAccent.cols]));
  if (row + 1 < realisticAccent.rows) neighbors.push(Math.abs(realisticAccent.field[index + realisticAccent.cols]));
  if (neighbors.some((neighbor) => neighbor > energy + 1e-6)) continue;
  const bucket = Math.max(0, Math.min(realisticAccent.quotas.length - 1, Math.floor((energy - 0.2) / 0.8 * realisticAccent.quotas.length)));
  referenceAccentCandidates[bucket].push(index);
}
assert.deepEqual(referenceAccentCandidates.map((bucket) => bucket.length), [3, 69, 103, 19, 6]);
assert.deepEqual(realisticAccent.selected.map((bucket) => bucket.length), [3, 24, 36, 19, 6]);
assert.deepEqual(realisticAccent.quotas, [12, 24, 36, 48, 72]);
const selectedAccentIds = new Set();
for (let bucket = 0; bucket < realisticAccent.selected.length; bucket += 1) {
  const candidateIds = new Set(referenceAccentCandidates[bucket]);
  for (const pointIndex of realisticAccent.selected[bucket]) {
    assert.ok(candidateIds.has(pointIndex), `bucket ${bucket} may select only a real local maximum`);
    assert.equal(selectedAccentIds.has(pointIndex), false, "one accent point may belong to only one energy bucket");
    selectedAccentIds.add(pointIndex);
  }
  assert.equal(realisticAccent.selected[bucket].length, Math.min(referenceAccentCandidates[bucket].length, realisticAccent.quotas[bucket]));
}
for (const bucket of [1, 2]) assert.ok(referenceAccentCandidates[bucket].length > realisticAccent.quotas[bucket], `real wave bucket ${bucket} must exercise quota truncation`);
assert.deepEqual(realisticAccent.selected.map((bucket) => bucket.slice(0, 3)), [
  [918, 460, 1851],
  [561, 811, 1615],
  [1925, 1273, 223],
  [1847, 1959, 911],
  [1488, 754, 717],
]);

const melodyComponentAudit = debug.auditMelodyComponentResponse();
const melodyComponentAudit30 = debug.auditMelodyComponentResponse(1 / 30);
const melodyComponentAudit10 = debug.auditMelodyComponentResponse(1 / 10);
assert.equal(melodyComponentAudit.sourceTriggered, true, "a wavefront must wake its source mechanism");
assert.ok(melodyComponentAudit.activationCount > 1, "the wavefront must wake mechanisms outward over time");
assert.ok(melodyComponentAudit.maxActive > 0 && melodyComponentAudit.maxActive <= melodyComponentAudit.componentLimit, "the stress wave must never exceed the detailed mechanism cap");
assert.deepEqual(melodyComponentAudit30.activationSequence, melodyComponentAudit.activationSequence, "fixed 60Hz wavefront sampling must select and start the same mechanisms at 30fps and 60fps");
assert.deepEqual(melodyComponentAudit10.activationSequence, melodyComponentAudit.activationSequence, "0.1s catch-up frames must preserve the same wave-trigger sequence");
assert.ok(melodyComponentAudit.activationSequence.length > 0);
const farthestTriggeredColumn = Math.max(...melodyComponentAudit.activationSequence.map((activation) => activation.componentId % 9));
assert.ok(farthestTriggeredColumn >= 8, `a realistic 0.45-amplitude wave must reach the far grid edge (column ${farthestTriggeredColumn}, path ${melodyComponentAudit.farEdgeDistance}, arrival ${melodyComponentAudit.farEdgeArrivalAt}s, peak ${melodyComponentAudit.farEdgeEnergyAtArrival})`);
assert.ok(melodyComponentAudit.triggeredFarEdgeCount >= 3, `the real activation log must contain a visible far-edge cascade, not only one lucky cell (${melodyComponentAudit.triggeredFarEdgeCount})`);
assert.ok(melodyComponentAudit.farEdgeEnergyAtArrival >= melodyDefaults.componentThreshold, "the live far-edge diagnostic must be sampled before the wave is pruned");
assert.ok(melodyComponentAudit.farEdgeRepeatPeaks.every((peak) => peak >= melodyDefaults.componentThreshold), `all three replay circles must retain a triggerable far-edge peak (${melodyComponentAudit.farEdgeRepeatPeaks.join(", ")})`);
assert.equal(melodyComponentAudit.contactSampleCount, 144 * 3, "each detailed mechanism must expose three geometry-aware wave contacts");
assert.equal(melodyComponentAudit.allStartOnThresholdEdge, true, "a mechanism must start on the same visible-field threshold edge that woke it");
assert.equal(melodyComponentAudit.allHavePhysicalWaveIdentity, true, "every activation must retain the physical wave that consumed its threshold edge");
assert.ok(melodyComponentAudit.maxActivationSeconds <= 6.8 * 0.3 + 1e-6, "one shortened closed cycle must not linger several seconds behind the crest");
for (const activation of melodyComponentAudit.activationSequence) {
  assert.equal(activation.mode, "melodyWave", "detailed melody mechanisms must be owned by the arriving wavefront");
  assert.equal(activation.cycleCount, 1);
  assert.ok(activation.triggerEnergy >= melodyDefaults.componentThreshold - 1e-6, "the impact halo and mechanism must share the visible trigger energy");
  assert.ok(Number.isFinite(activation.contactX) && Number.isFinite(activation.contactY), "each activation must retain its visible contact point");
  assert.ok(Math.abs(activation.basePeriod - activation.originalBasePeriod * 0.3) < 1e-5, "melody mechanisms must use the configured shortened period");
  assert.ok(Math.abs(activation.completeAt - activation.startedAt - activation.basePeriod) < 2e-6, "the shortened mechanism must still end after exactly one complete cycle");
}
assert.equal(melodyComponentAudit.allUseCompleteCycles, true, "every wave-triggered mechanism must own complete regular cycles");
assert.equal(melodyComponentAudit.noComponentRetriggeredByOneWave, true, "one passing wave must not flicker-trigger the same mechanism repeatedly");
assert.equal(melodyComponentAudit.noDarkFramesInsideActivation, true, "a mechanism must never flash dark before its scheduled completion");
assert.equal(melodyComponentAudit.repeatsSamePoseEachCycle, true, "mechanism motion must repeat regularly instead of following instantaneous field amplitude");
assert.equal(melodyComponentAudit.allActivationEventsPlayed, true, "complete movement cycles must retain their matching sound events");
assert.equal(melodyComponentAudit.finalActiveCount, 0);
assert.equal(melodyComponentAudit.finalCompletedCount, melodyComponentAudit.activationCount);
assert.equal(melodyComponentAudit.finalLatchedComponentCount, 0);
assert.equal(melodyComponentAudit.finalWaveCount, 0);
assert.equal(melodyComponentAudit.finalAnimating, false);

const slowWaveIdentityAudit = debug.auditMelodyComponentResponse(1 / 60, { waveSpeed: 120, componentPeriodScale: 0.25 });
assert.equal(slowWaveIdentityAudit.sourceTriggered, true, "the supported slow-wave audit must exercise a real source activation");
assert.ok(slowWaveIdentityAudit.activationCount > 0, "the supported slow-wave identity assertions must not pass on an empty activation set");
assert.equal(slowWaveIdentityAudit.noComponentRetriggeredByOneWave, true, "signed-field dark nodes and multiple contacts must not let one slow physical wave restart the same mechanism");
assert.equal(slowWaveIdentityAudit.allHavePhysicalWaveIdentity, true);

const historicalOccupancy = debug.auditMelodyHistoricalOccupancy();
assert.equal(historicalOccupancy.historicalWaveCount, historicalOccupancy.componentLimit);
assert.equal(historicalOccupancy.completedSorted, true, "completed history must stay sorted for bounded sample-time lookback");
assert.equal(historicalOccupancy.capRejectsHistoricalOverfill, true, "low-fps catch-up must honor the cap at the historical wave time");
assert.equal(historicalOccupancy.secondWaveDecisionMatches, true, "30fps and 60fps must make the same occupied-component decision");
assert.equal(historicalOccupancy.lowFrameRate.secondStarted, false);
assert.equal(historicalOccupancy.highFrameRate.secondStarted, false);
assert.equal(historicalOccupancy.lowFrameRate.noOverlap, true);
assert.equal(historicalOccupancy.highFrameRate.noOverlap, true);
assert.equal(historicalOccupancy.thirdWaveCanRestart, true);
assert.equal(historicalOccupancy.latchedWhileOccupied, true);
assert.equal(historicalOccupancy.releasedAfterLowField, true);
assert.equal(historicalOccupancy.restartedAfterRelease, true, "a rejected threshold edge must be able to trigger again after the field releases");
assert.equal(historicalOccupancy.skippedCandidateLatched, true, "a full 24-slot wavefront must consume the rejected target's threshold edge");
assert.equal(historicalOccupancy.skippedCandidateNotRetried, true, "a rejected target must not light late after the crest has passed");
assert.equal(historicalOccupancy.skippedCandidateReleased, true, "the target latch must release after the visible field falls");
assert.equal(historicalOccupancy.skippedCandidateRestartsAfterRelease, true, "a genuinely new visible wave may wake the target later");
assert.equal(historicalOccupancy.historicalPruneBoundaryPreserved, true, "historical 60Hz wave samples must run before current-frame wave pruning");
assert.equal(historicalOccupancy.capRaceTargetPreserved, true, "an early wave must reach its historical 60Hz sample before a >maxWaves catch-up batch evicts it");
assert.equal(historicalOccupancy.capRaceFrameRateInvariant, true, "a >maxWaves catch-up batch must produce the same activation sequence at 10/30/60fps");
assert.equal(historicalOccupancy.capRaceStayedBounded, true, "chronological pending-wave promotion must preserve the 48 active-wave cap");
assert.equal(historicalOccupancy.weakWaveCannotBorrow, true, "a below-threshold weak wave must not start the target by itself");
assert.equal(historicalOccupancy.consumedDominantCannotFallback, true, "a weak wave must not borrow an already-consumed dominant wave's later lobe to restart a component");
assert.equal(historicalOccupancy.genuinelyNewWaveRestarts, true, "after the visible field releases, a genuinely new strong wave must receive a new physical identity and restart the component");

const motifAudit = debug.auditMotifAbilities();
const motifLibrary = debug.getMotifLibrary();
const motifById = new Map(motifLibrary.map((motif) => [motif.id, motif]));
assert.equal(motifAudit.assignedCount, melodyDefaults.motifCount);
assert.equal(motifAudit.ordinaryCount, components.length - melodyDefaults.motifCount, "most components must remain ordinary mechanisms without a named melody ability");
assert.equal(motifAudit.uniqueComponentCount, motifAudit.assignedCount);
assert.equal(motifAudit.uniqueAbilityCount, motifAudit.assignedCount);
assert.equal(motifAudit.ownership.abilityTriggers.length, 2);
assert.equal(motifAudit.ownership.everyAbilityPlayedItsOwner, true, "each special component must play only the short phrase bound to that component");
assert.equal(motifAudit.ownership.ordinaryActivationStarted, true, "an ordinary component must still run its normal mechanism cycle");
assert.equal(motifAudit.ownership.ordinaryPerformanceCountDelta, 0, "an ordinary component must never acquire a motif from the current stroke or another component");
assert.ok(motifAudit.minimumGridSeparation >= 3, "hidden melody abilities should be spatially scattered");
assert.equal(motifAudit.librarySize, 22, "the built-in ability pool must be a real cross-composer collection");
assert.equal(motifAudit.namedDefinitionCount, 18);
assert.equal(motifAudit.familyCounts["original-jazz"], 3, "a default board should reserve one quarter of its abilities for original jazz");
assert.equal(motifAudit.assignedCount - motifAudit.familyCounts["original-jazz"], 9, "a default board should expose nine named public-domain melodies");
assert.equal(motifAudit.maximumNamedPerComposer, 1, "the first selection pass must not cluster several works by one composer");
assert.equal(motifAudit.allNamedFixedPitch, true, "named melodies must stay in a fixed recognizable key and range");
assert.equal(motifAudit.firstPerformance.eventCount, motifById.get(motifAudit.firstPerformance.motifId).noteCount);
assert.deepEqual(
  motifAudit.firstPerformance.events.map((event) => event.pitch),
  motifById.get(motifAudit.firstPerformance.motifId).notes.map((note) => motifById.get(motifAudit.firstPerformance.motifId).rootPitch + note.semitones),
  "the runtime must play a named melody from its fixed root instead of the random component pitch",
);
assert.ok(motifAudit.firstPerformance.events.every((event, index, events) => index === 0 || event.at > events[index - 1].at));
assert.ok(motifAudit.firstPerformance.events.every((event) => event.motifFamily && event.motifUnlocked === true));
assert.ok(motifAudit.catchupEventCount > 0, "a motif unlocked during a catch-up frame must not lose its first note");
assert.equal(motifAudit.blockedDuringCooldown, true);
assert.equal(motifAudit.replayAfterCooldown, true);
assert.equal(motifAudit.globallyOffSuppresses, true);
assert.equal(motifAudit.perAbilityOffSuppresses, true);
assert.equal(motifAudit.customAbility.id, "audit-custom");
assert.equal(motifAudit.customAbility.family, "custom");
assert.equal(motifAudit.customAbility.transposePolicy, "component", "legacy custom motifs must retain component transposition by default");
assert.deepEqual(motifAudit.fixedCustomPitches, [64, 67, 71], "a fixed custom motif must honor its declared MIDI root without interval clamping");
for (const rootPitch of [36, 100]) {
  const rejectedId = `fixed-out-of-range-${rootPitch}`;
  const resolved = debug.resolveMotifSettings("", { customMotifs: [{
    id: rejectedId, transposePolicy: "fixed", rootPitch, notes: [[0, 1], [3, 1], [7, 1]],
  }] });
  assert.equal(
    resolved.library.some((motif) => motif.id === rejectedId),
    false,
    `a fixed custom motif with root ${rootPitch} must be rejected instead of silently transposed into range`,
  );
}
const coveredMotifComponents = new Set();
const coveredMotifColumns = new Set();
const coveredMotifIds = new Set();
for (let sample = 0; sample < 96; sample += 1) {
  const previewSeed = `motif-position-${sample}`;
  const assignment = debug.inspectMotifAssignment(previewSeed, melodyDefaults.motifCount);
  assert.equal(assignment.assignedCount, melodyDefaults.motifCount, `${previewSeed} must receive every default ability`);
  assert.ok(assignment.minimumGridSeparation >= 3, `${previewSeed} must retain Chebyshev separation >=3`);
  for (const ability of assignment.abilities) {
    coveredMotifComponents.add(ability.componentId);
    coveredMotifColumns.add(ability.column);
    coveredMotifIds.add(ability.id);
  }

  const maximumAssignment = debug.inspectMotifAssignment(`${previewSeed}:maximum`, 16);
  assert.equal(maximumAssignment.assignedCount, 16, `${previewSeed} must place all 16 requested abilities`);
  assert.ok(maximumAssignment.minimumGridSeparation >= 3, `${previewSeed} must keep all 16 abilities at Chebyshev separation >=3`);
}
assert.equal(coveredMotifComponents.size, 16 * 9, "seeded ability placement must be able to cover every component on the board");
assert.deepEqual([...coveredMotifColumns].sort((left, right) => left - right), [0, 1, 2, 3, 4, 5, 6, 7, 8], "seeded ability placement must cover every board column");
assert.equal(coveredMotifIds.size, motifLibrary.length, "cross-seed default boards must draw from the whole built-in motif pool");
const goldenMotifPitches = {
  "fate-four": [67, 67, 67, 63],
  "ode-opening": [66, 66, 67, 69, 69, 67, 66, 64],
  "fur-elise-turn": [76, 75, 76, 75, 76, 71, 74, 72, 69],
  "twinkle-opening": [60, 60, 67, 67, 69, 69, 67],
  "maple-leaf-rag": [56, 63, 56, 60, 63, 55, 63, 55, 58, 63],
  "entertainer-jump": [62, 63, 64, 72, 64, 72, 64, 72],
  "eine-kleine-fanfare": [55, 62, 67, 71, 74],
  "rondo-alla-turca": [59, 57, 56, 57, 60, 62, 60, 59, 60, 64],
  "minuet-in-g": [62, 55, 57, 59, 60, 62, 55, 55],
  "vivaldi-spring": [64, 68, 68, 68, 66, 64, 71, 71, 69, 68, 68, 68],
  "morning-mood": [71, 68, 66, 64, 66, 68, 71, 68, 71, 73, 68],
  "mountain-king": [59, 61, 62, 64, 66, 62, 66, 71, 69, 66, 62, 66],
  "new-world-largo": [65, 68, 68, 65, 63, 61, 63, 65, 68, 65, 63],
  "brahms-lullaby": [67, 67, 70, 67, 67, 70, 67, 70, 75, 74, 72, 72],
  "carmen-habanera": [62, 61, 60, 60, 60, 59, 58, 57, 57, 56, 55, 53],
  "chopin-funeral": [58, 58, 58, 58, 61, 60, 60, 58, 58, 58, 58],
  "swan-lake-theme": [66, 59, 61, 62, 64, 66, 62, 66, 62, 66, 59, 62],
  "frere-jacques": [60, 62, 64, 60, 60, 62, 64, 60, 64, 65, 67],
};
assert.equal(Object.keys(goldenMotifPitches).length, motifAudit.namedDefinitionCount, "every named melody needs an explicit golden pitch contour");
for (const [motifId, pitches] of Object.entries(goldenMotifPitches)) {
  const definition = motifById.get(motifId);
  assert.ok(definition, `${motifId} must exist in the built-in collection`);
  assert.equal(definition.transposePolicy, "fixed");
  assert.deepEqual(definition.notes.map((note) => definition.rootPitch + note.semitones), pitches, `${motifId} must preserve its reviewed pitch contour`);
}
assert.equal(debug.resolveMotifSettings("?motifs=off").enabled, false);

const rowY = designFrame.y + (6 + 0.5) * designFrame.cellHeight;
const timedStroke = [{ endedAt: 0.7, samples: [
  { x: designFrame.x + 0.5 * designFrame.cellWidth, y: rowY, at: 0 },
  { x: designFrame.x + 2.5 * designFrame.cellWidth, y: rowY, at: 0.08 },
  { x: designFrame.x + 4.5 * designFrame.cellWidth, y: rowY, at: 0.29 },
  { x: designFrame.x + 7.5 * designFrame.cellWidth, y: rowY, at: 0.61 },
] }];
const melodyPreview30 = debug.previewMelody(timedStroke, 12, 1 / 30);
const melodyPreview60 = debug.previewMelody(timedStroke, 12, 1 / 60);
assert.deepEqual(melodyPreview30.events, melodyPreview60.events);
assert.ok(melodyPreview60.phrases[0].notes.length >= 4);
assert.ok(melodyPreview60.phrases[0].notes.every((note, index, notes) => index === 0 || note.offset > notes[index - 1].offset));
for (const repeat of [1, 2, 3]) {
  const replay = melodyPreview60.replayEvents.filter((event) => event.repeat === repeat);
  assert.deepEqual(replay.map((event) => event.componentId), melodyPreview60.liveEvents.map((event) => event.componentId), `repeat ${repeat} must preserve the drawn order`);
}

// Four dense-field cells fit inside one detailed mechanism cell: the score stays one note while the drawn wave stays spatially continuous.
const sameMechanismStroke = [{ endedAt: 0.2, samples: [
  { x: designFrame.x + 0.5 * (designFrame.width / 36), y: 600, at: 0 },
  { x: designFrame.x + 1.5 * (designFrame.width / 36), y: 600, at: 0.05 },
  { x: designFrame.x + 2.5 * (designFrame.width / 36), y: 600, at: 0.1 },
  { x: designFrame.x + 3.5 * (designFrame.width / 36), y: 600, at: 0.15 },
] }];
const sameMechanismPreview = debug.previewMelody(sameMechanismStroke, 0.2, 1 / 60);
assert.ok(Array.isArray(sameMechanismPreview.waveSources), "melody preview must expose its actual emitted wave-source sequence");
const liveSameMechanismWaves = sameMechanismPreview.waveSources.filter((wave) => wave.repeat === 0);
assert.equal(sameMechanismPreview.phrases[0].noteCount, 1, "crossing dense wave cells must not invent extra 9x16 mechanism notes");
assert.equal(sameMechanismPreview.liveEvents.length, 1);
assert.equal(liveSameMechanismWaves.length, 4, "one live wave source must be retained for each crossed 36x64 field cell");
assert.deepEqual(liveSameMechanismWaves.map((wave) => wave.sourceIndex), [612, 613, 614, 615]);
assert.ok(liveSameMechanismWaves.every((wave, index, waves) => index === 0 || wave.x > waves[index - 1].x));
assert.ok(liveSameMechanismWaves.every((wave, index, waves) => index === 0 || wave.at >= waves[index - 1].at));
assert.equal(liveSameMechanismWaves[0].fromX, liveSameMechanismWaves[0].x);
assert.equal(liveSameMechanismWaves[0].fromY, liveSameMechanismWaves[0].y);
for (let index = 1; index < liveSameMechanismWaves.length; index += 1) {
  assert.equal(liveSameMechanismWaves[index].fromX, liveSameMechanismWaves[index - 1].x, "each line wave must expose the preceding source as its visible origin");
  assert.equal(liveSameMechanismWaves[index].fromY, liveSameMechanismWaves[index - 1].y);
}
assert.ok(liveSameMechanismWaves.slice(1).every((wave) => Math.hypot(wave.x - wave.fromX, wave.y - wave.fromY) > 0));
assert.equal(sameMechanismPreview.maxWaveCount, 4);

const longSegmentPreview = debug.previewMelody([{ endedAt: 0.12, samples: [
  { x: designFrame.x, y: designFrame.y, at: 0 },
  { x: designFrame.x + designFrame.width, y: designFrame.y + designFrame.height, at: 0.1 },
] }], 0.14, 1 / 60);
const longSegmentLiveWaves = longSegmentPreview.waveSources.filter((wave) => wave.repeat === 0);
assert.ok(longSegmentLiveWaves.length <= 12, "one coalesced full-screen pointer segment must not synchronously create more than 12 distance fields");
assert.equal(longSegmentLiveWaves.at(-1).sourceIndex, 36 * 64 - 1, "the capped source set must retain the pointer endpoint");

const melodyAudioCap = debug.auditMelodyAudioCap(100);
assert.equal(melodyAudioCap.available, true);
assert.ok(melodyAudioCap.maxGestureVoicesObserved <= melodyAudioCap.gestureVoiceLimit);
assert.ok(melodyAudioCap.gestureVoicesDropped > 0, "a dense burst must be bounded instead of creating 100 audio voices");
assert.ok(melodyAudioCap.maxMechanismVoicesObserved <= melodyAudioCap.mechanismVoiceLimit);
assert.ok(melodyAudioCap.mechanismVoicesDropped > 0, "dense mechanism events must also be bounded on mobile Web Audio");
assert.ok(melodyAudioCap.maxMotifVoicesObserved <= melodyAudioCap.motifVoiceLimit);
assert.equal(melodyAudioCap.realMotifPerformanceRequestCount, melodyAudioCap.motifVoiceLimit + 1, "the cap audit must use real multi-note motif performances");
assert.equal(melodyAudioCap.conductorAcceptedMotifPerformanceCount, melodyAudioCap.motifVoiceLimit, "logical admission must accept only whole performances up to the hard cap");
assert.equal(melodyAudioCap.conductorRejectedMotifPerformanceCount, 1, "capacity exhaustion must reject one whole logical performance");
assert.equal(melodyAudioCap.motifVoicesAccepted, melodyAudioCap.motifVoiceLimit, "audio admission must allocate one persistent voice per accepted performance");
assert.equal(melodyAudioCap.motifVoicesDropped, 1, "audio fallback must reject the thirteenth performance as a whole");
assert.equal(melodyAudioCap.motifNotesAccepted, melodyAudioCap.motifAcceptedExpectedNotes, "every note of every accepted performance must be played");
assert.equal(melodyAudioCap.motifNotesDropped, melodyAudioCap.motifRejectedExpectedNotes, "only notes belonging to the wholly rejected performance may be dropped");
assert.equal(melodyAudioCap.trackedSourcesAfterDisable, 0, "muting must stop and release every scheduled one-shot source");
assert.equal(melodyAudioCap.gestureVoicesAfterDisable, 0);
assert.equal(melodyAudioCap.motifVoicesAfterDisable, 0);
assert.equal(melodyAudioCap.mechanismVoicesAfterDisable, 0);
assert.equal(melodyAudioCap.legacyMechanismVoicesDropped, 0, "the melody safety cap must not silently change legacy mode playback");
assert.equal(melodyAudioCap.legacyScheduledEventCount, 100);
const timingEngine = new debug.AudioEngine(true, { gestureVoiceLimit: 16 });
assert.equal(timingEngine.initialize(), true);
assert.equal(timingEngine.setEnabled(true), true);
timingEngine.context.currentTime = 5;
const timingEvents = [0, 0.13, 0.29].map((offset, index) => ({
  at: 10 + offset, kind: "gesture-note", pitch: 60 + index, accent: 1, gainScale: 1,
  repeat: 0, phraseLayer: 0, componentId: index, sourceU: 0.5,
}));
timingEngine.playGestureBatch(timingEvents);
const scheduledGestureStarts = timingEngine.context.oscillatorStarts.slice(-3);
assert.equal(scheduledGestureStarts.length, 3);
assert.ok(Math.abs((scheduledGestureStarts[1] - scheduledGestureStarts[0]) - 0.13) < 1e-6);
assert.ok(Math.abs((scheduledGestureStarts[2] - scheduledGestureStarts[0]) - 0.29) < 1e-6, "live gesture audio must preserve the recorded non-uniform offsets instead of clamping them to 75ms");
timingEngine.setEnabled(false);
const melodyPerformance = debug.auditMelodyPerformance(16);
assert.equal(melodyPerformance.pointCount, 36 * 64);
assert.ok(melodyPerformance.distanceCacheEntries <= 16 + melodyDefaults.maxWaves, "distance cache must remain keyed by bounded component sources");
assert.ok(melodyPerformance.distanceCacheBytes <= (16 + melodyDefaults.maxWaves) * 36 * 64 * Float32Array.BYTES_PER_ELEMENT, "actual cached typed-array storage must remain bounded");
assert.ok(melodyPerformance.dynamicDistanceEntries <= melodyDefaults.maxWaves, "segment distance keys must obey the dynamic LRU cap");
assert.equal(melodyPerformance.lineWaveCount, melodyDefaults.maxWaves, "the performance audit must exercise real segment fields instead of only component point sources");
assert.equal(melodyPerformance.allLineFieldsAliased, true, "the compatibility fromDistances field must alias the one multi-source segment field");
assert.ok(melodyPerformance.retainedDistanceFieldCount <= melodyPerformance.distanceCacheEntries + melodyDefaults.maxWaves, "active line waves may retain only one bounded multi-source field per segment");
assert.equal(melodyPerformance.retainedDistanceBytes, melodyPerformance.retainedDistanceFieldCount * 36 * 64 * Float32Array.BYTES_PER_ELEMENT);
assert.ok(Number.isFinite(melodyPerformance.componentScanMs) && melodyPerformance.componentScanMs >= 0, "the physical-wave identity scan must be included in the bounded performance audit");
assert.ok(melodyPerformance.accentCount <= 12 + 24 + 36 + 48 + 72);
if (process.env.KINETIC_BENCH === "1") {
  console.log(`KINETIC_BENCH ${JSON.stringify(melodyPerformance)}`);
  console.log(`KINETIC_WAVE_AUDIT ${JSON.stringify({
    wallCrossingRatio: melodyAudit.wallCrossingRatio,
    diffractionRatio: melodyAudit.diffractionRatio,
    diffractionSavings: melodyAudit.diffractionSavings,
    accentRows: melodyAudit.flatAccentRowCoverage,
    accentColumns: melodyAudit.flatAccentColumnCoverage,
    accentQuadrants: melodyAudit.flatAccentQuadrantCoverage,
  })}`);
}

// Fresh-load the real default runtime and verify coalesced PointerEvent timestamps are wired through, not replaced by the outer event timestamp.
const melodyCanvas = new MockCanvas();
const melodyElements = new Map([
  ["#kinetic-maze-v4", melodyCanvas],
  ["#seed-label", new MockElement()],
  ["#status-label", new MockElement()],
  ["#start-control", new MockElement()],
  ["#chrome", new MockElement()],
  ["#hint-label", new MockElement()],
  ["#meta-bar", new MockElement()],
]);
global.document = { querySelector(selector) { return melodyElements.get(selector) || null; } };
global.window = { location: { search: "?seed=melody-pointer-wiring" }, AudioContext: MockAudioContext };
let melodyScheduledFrame = null;
global.requestAnimationFrame = (callback) => { melodyScheduledFrame = callback; return 2; };
delete require.cache[require.resolve(path.join(__dirname, "kinetic-maze-v4.js"))];
require(path.join(__dirname, "kinetic-maze-v4.js"));
const melodyRuntime = global.window.__KINETIC_V4_DEBUG__;
melodyRuntime.start();
assert.equal(melodyRuntime.getSnapshot().mode, "melody", "melody is the default interactive direction");
const hoverMove = melodyCanvas.listeners.get("pointermove");
hoverMove({
  pointerId: 3, pointerType: "mouse", buttons: 0, pressure: 0, clientX: 180, clientY: 420, timeStamp: 100,
  getCoalescedEvents: () => [
    { clientX: 180, clientY: 420, timeStamp: 100 },
    { clientX: 260, clientY: 470, timeStamp: 125 },
  ],
});
const firstHover = melodyRuntime.getSnapshot();
assert.equal(firstHover.visual.hoverActive, true, "mouse hover must create immediate visual feedback after Start without pressing");
assert.ok(firstHover.visual.trailPointCount >= 2);
assert.equal(firstHover.melody.activePhraseCount, 0, "hover waves must not secretly become a looping phrase");
assert.ok(firstHover.melody.activeWaveCount > 0, "post-Start mouse/trackpad movement must launch a real line ripple");
assert.equal(firstHover.litCount, 0, "hover movement may seed a wave but detailed mechanisms still wait for the fixed wavefront step");
assert.equal(melodyRuntime.getAudioState().scheduledEventCount, 0, "hover itself must not synthesize direct gesture notes");
const hoverWavesBeforeStorm = firstHover.melody.activeWaveCount;
hoverMove({
  pointerId: 3, pointerType: "mouse", buttons: 0, pressure: 0, clientX: 656, clientY: 540, timeStamp: 249,
  getCoalescedEvents: () => Array.from({ length: 100 }, (_, index) => ({
    clientX: 260 + index * 4,
    clientY: 470 + index * 0.7,
    timeStamp: 150 + index,
  })),
});
const hoverWavesAfterStorm = melodyRuntime.getSnapshot().melody.activeWaveCount;
assert.ok(hoverWavesAfterStorm > hoverWavesBeforeStorm);
assert.ok(hoverWavesAfterStorm - hoverWavesBeforeStorm <= 1, "one coalesced hover PointerEvent may allocate at most one cold segment field");
let hoverWaveSnapshot = firstHover;
for (let step = 0; step < 90 && hoverWaveSnapshot.litCount === 0; step += 1) {
  melodyRuntime.step(1 / 60);
  hoverWaveSnapshot = melodyRuntime.getSnapshot();
}
assert.ok(hoverWaveSnapshot.litCount > 0, "the post-Start hover ripple must causally wake detailed mechanisms");
const firstHoverGesture = firstHover.visual.hoverGestureId;
hoverMove({
  pointerId: 3, pointerType: "mouse", buttons: 0, pressure: 0, clientX: 360, clientY: 520, timeStamp: 500,
  getCoalescedEvents: () => [],
});
assert.notEqual(melodyRuntime.getSnapshot().visual.hoverGestureId, firstHoverGesture, "a hover pause over 200ms must begin a new unconnected light trail");
melodyCanvas.listeners.get("pointerleave")({ type: "pointerleave", pointerId: 3, pointerType: "mouse", buttons: 0 });
assert.equal(melodyRuntime.getSnapshot().visual.hoverActive, false);
for (let index = 0; index < 13; index += 1) melodyRuntime.step(0.1);
assert.equal(melodyRuntime.getSnapshot().visual.trailPointCount, 0, "hover trail must fully fade and release its storage");
for (let index = 0; index < 200; index += 1) {
  const snapshot = melodyRuntime.getSnapshot();
  if (snapshot.melody.activeWaveCount === 0 && snapshot.litCount === 0) break;
  melodyRuntime.step(0.1);
}
assert.equal(melodyRuntime.getSnapshot().melody.activeWaveCount, 0);
assert.equal(melodyRuntime.getSnapshot().litCount, 0, "the non-looping hover ripple must eventually release every mechanism");
const pointerEvent = (overrides) => ({
  pointerId: 7, pointerType: "touch", buttons: 1, pressure: 0.5, clientX: 180, clientY: 620, timeStamp: 0,
  preventDefault() {}, ...overrides,
});
const zeroPressureBefore = melodyRuntime.getSnapshot();
melodyCanvas.listeners.get("pointerdown")(pointerEvent({ pointerId: 6, clientX: 130, clientY: 820, buttons: 0, pressure: 0, timeStamp: 600 }));
const zeroPressureDown = melodyRuntime.getSnapshot();
melodyCanvas.listeners.get("pointermove")(pointerEvent({ pointerId: 6, clientX: 500, clientY: 820, buttons: 0, pressure: 0, timeStamp: 700 }));
const zeroPressureMove = melodyRuntime.getSnapshot();
assert.ok(zeroPressureDown.melody.liveEventCount > zeroPressureBefore.melody.liveEventCount, "pointerdown must begin the touch phrase even when pressure is unavailable");
assert.ok(zeroPressureMove.melody.liveEventCount > zeroPressureDown.melody.liveEventCount, "an active touch stroke must keep recording moves when buttons and pressure are both zero");
assert.ok(zeroPressureMove.visual.trailPointCount > zeroPressureDown.visual.trailPointCount);
assert.equal(zeroPressureMove.visual.lastTrailPoint.x, 500);
assert.equal(zeroPressureDown.litCount, 0, "pointerdown may seed a wave but must not directly light a detailed mechanism");
assert.equal(zeroPressureMove.litCount, 0, "drawing the line must leave detailed mechanisms dark until the wavefront is stepped");
assert.equal(zeroPressureMove.melody.componentTriggerCount, zeroPressureBefore.melody.componentTriggerCount, "drawing itself must not directly add component triggers before the next wavefront step");
melodyCanvas.listeners.get("pointerup")(pointerEvent({ pointerId: 6, clientX: 500, clientY: 820, buttons: 0, pressure: 0, timeStamp: 720 }));
let causalWaveSnapshot = melodyRuntime.getSnapshot();
let causalWaveSteps = 0;
while (causalWaveSnapshot.litCount === 0 && causalWaveSteps < 24) {
  melodyRuntime.step(1 / 60);
  causalWaveSteps += 1;
  causalWaveSnapshot = melodyRuntime.getSnapshot();
}
assert.ok(causalWaveSteps > 0, "the wave-triggered detailed layer must require at least one fixed simulation step");
assert.ok(causalWaveSnapshot.litCount > 0, "the propagated wave must eventually wake detailed mechanisms");
assert.ok(causalWaveSnapshot.melody.componentTriggerCount > 0);
assert.ok(causalWaveSnapshot.active.every((activation) => activation.mode === "melodyWave"));
assert.ok(causalWaveSnapshot.active.every((activation) => Number.isFinite(activation.melodyContactX)
  && Number.isFinite(activation.melodyContactY)
  && Number.isInteger(activation.melodyTriggerWaveId)
  && activation.melodyTriggerEnergy >= melodyDefaults.componentThreshold - 1e-6), "real pointer waves must retain the visible-field contact used by the impact halo");
melodyCanvas.listeners.get("pointerdown")(pointerEvent({ clientX: 130, timeStamp: 100 }));
const coalescedBatchCountBefore = melodyRuntime.getAudioState().gestureBatchPlayCount;
melodyCanvas.listeners.get("pointermove")(pointerEvent({
  clientX: 800,
  timeStamp: 9000,
  getCoalescedEvents: () => [
    pointerEvent({ clientX: 280, timeStamp: 180 }),
    pointerEvent({ clientX: 500, timeStamp: 310 }),
    pointerEvent({ clientX: 800, timeStamp: 470 }),
  ],
}));
const coalescedAudioState = melodyRuntime.getAudioState();
assert.equal(coalescedAudioState.gestureBatchPlayCount, coalescedBatchCountBefore + 1, "all samples from one coalesced PointerEvent must be scheduled as one audio batch");
assert.ok(coalescedAudioState.lastGestureBatchOffsets.length >= 3);
assert.ok(coalescedAudioState.lastGestureBatchOffsets.at(-1) > 0.2, "the live batch must retain timing across its separate coalesced segments");
assert.ok(coalescedAudioState.lastGestureBatchOffsets.every((offset, index, values) => index === 0 || offset >= values[index - 1]));
melodyCanvas.listeners.get("pointerup")(pointerEvent({ clientX: 850, buttons: 0, pressure: 0, timeStamp: 520 }));
const wiredPhrase = melodyRuntime.getSnapshot().melody.activePhrases.at(-1);
assert.ok(wiredPhrase.noteCount >= 4);
assert.ok(wiredPhrase.period < 2, `coalesced sample timestamps should define the phrase period, not outer 9s timestamp (period ${wiredPhrase.period})`);
assert.equal(typeof melodyScheduledFrame, "function");

assert.equal(typeof scheduledFrame, "function");

class ControlledLifecycleAudioContext extends MockAudioContext {
  static instances = [];
  constructor() {
    super();
    this.suspendCalls = 0;
    this.resumeCalls = 0;
    this.closeCalls = 0;
    this.finishSuspend = null;
    ControlledLifecycleAudioContext.instances.push(this);
  }
  suspend() {
    this.suspendCalls += 1;
    return new Promise((resolve) => {
      this.finishSuspend = () => {
        this.state = "suspended";
        this.finishSuspend = null;
        resolve();
      };
    });
  }
  resume() {
    this.resumeCalls += 1;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closeCalls += 1;
    this.state = "closed";
    return Promise.resolve();
  }
}

function loadFreshMelodyRuntime(search, AudioContextClass, canvasCallCounts = null) {
  const runtimeCanvas = new MockCanvas(canvasCallCounts);
  const runtimeElements = new Map([
    ["#kinetic-maze-v4", runtimeCanvas],
    ["#seed-label", new MockElement()],
    ["#status-label", new MockElement()],
    ["#start-control", new MockElement()],
    ["#chrome", new MockElement()],
    ["#hint-label", new MockElement()],
    ["#meta-bar", new MockElement()],
  ]);
  global.document = { querySelector(selector) { return runtimeElements.get(selector) || null; } };
  global.window = { location: { search }, AudioContext: AudioContextClass };
  let scheduled = null;
  global.requestAnimationFrame = (callback) => { scheduled = callback; return 3; };
  delete require.cache[require.resolve(path.join(__dirname, "kinetic-maze-v4.js"))];
  require(path.join(__dirname, "kinetic-maze-v4.js"));
  return { runtime: global.window.__KINETIC_V4_DEBUG__, canvas: runtimeCanvas, elements: runtimeElements, scheduledFrame: () => scheduled };
}

(async () => {
  const startGatePage = loadFreshMelodyRuntime("?seed=start-gate&sound=off", MockAudioContext);
  const gatedHoverEvent = {
    pointerId: 31, pointerType: "mouse", buttons: 0, pressure: 0, clientX: 420, clientY: 560, timeStamp: 130,
    getCoalescedEvents: () => [
      { clientX: 180, clientY: 410, timeStamp: 100 },
      { clientX: 420, clientY: 560, timeStamp: 130 },
    ],
  };
  startGatePage.canvas.listeners.get("pointermove")(gatedHoverEvent);
  startGatePage.canvas.listeners.get("pointerdown")({
    pointerId: 32, pointerType: "touch", buttons: 1, pressure: 0.5,
    clientX: 240, clientY: 520, timeStamp: 140, preventDefault() {},
  });
  const beforeStartSnapshot = startGatePage.runtime.getSnapshot();
  assert.equal(beforeStartSnapshot.mode, "idle", "mouse and touch input must not bypass the Start gate");
  assert.equal(beforeStartSnapshot.visual.trailPointCount, 0);
  assert.equal(beforeStartSnapshot.visual.hoverActive, false);
  assert.equal(beforeStartSnapshot.melody, null);
  assert.equal(beforeStartSnapshot.litCount, 0);
  assert.equal(startGatePage.runtime.getAudioState().initialized, false);
  await startGatePage.runtime.start();
  startGatePage.canvas.listeners.get("pointermove")(gatedHoverEvent);
  const afterStartSnapshot = startGatePage.runtime.getSnapshot();
  assert.equal(afterStartSnapshot.mode, "melody");
  assert.ok(afterStartSnapshot.visual.trailPointCount >= 2);
  assert.ok(afterStartSnapshot.melody.activeWaveCount > 0);
  assert.equal(startGatePage.runtime.getAudioState().initialized, false, "sound=off must still avoid allocating AudioContext after Start");

  const baselineCanvasCalls = {};
  const denseCanvasCalls = {};
  const densePlusCanvasCalls = {};
  const baselinePage = loadFreshMelodyRuntime("?seed=dense-render-branch&sound=off", MockAudioContext, baselineCanvasCalls);
  const densePage = loadFreshMelodyRuntime("?seed=dense-render-branch&sound=off&denseDetails=1", MockAudioContext, denseCanvasCalls);
  const densePlusPage = loadFreshMelodyRuntime("?seed=dense-render-branch&sound=off&denseDetails=plus", MockAudioContext, densePlusCanvasCalls);
  const baselineExperiment = baselinePage.runtime.getDenseDetailsExperiment();
  const denseExperiment = densePage.runtime.getDenseDetailsExperiment();
  const densePlusExperiment = densePlusPage.runtime.getDenseDetailsExperiment();
  assert.equal(baselineExperiment.mode, "off");
  assert.equal(denseExperiment.mode, "details");
  assert.equal(densePlusExperiment.mode, "details-plus-reeds");
  assert.equal(baselineExperiment.renderedDetailCount, 144);
  assert.equal(denseExperiment.renderedDetailCount, 576);
  assert.equal(densePlusExperiment.renderedDetailCount, 576);
  assert.equal(denseExperiment.semanticComponentCount, 144, "dense rendering must not multiply hit, state, or audio entities");
  assert.equal(densePlusExperiment.semanticComponentCount, 144);
  assert.ok(
    (denseCanvasCalls.save || 0) > (baselineCanvasCalls.save || 0) * 3.5,
    `denseDetails=1 must execute the real four-quadrant drawing branch (${denseCanvasCalls.save || 0} vs ${baselineCanvasCalls.save || 0} save calls)`,
  );
  assert.ok(
    (densePlusCanvasCalls.lineTo || 0) > (denseCanvasCalls.lineTo || 0),
    "denseDetails=plus must actually add the response-reed stress arm instead of only reporting it in diagnostics",
  );

  global.window.AudioContext = MockAudioContext;
  const pendingReplayEngine = new melodyRuntime.AudioEngine(true, { gestureVoiceLimit: 8 });
  assert.equal(pendingReplayEngine.initialize(), true);
  pendingReplayEngine.context.state = "suspended";
  const pendingEvents = [0, 0.13, 0.29].map((offset, index) => ({
    at: 20 + offset, kind: "gesture-note", pitch: 62 + index, accent: 1, gainScale: 1,
    repeat: 0, phraseLayer: 0, componentId: index, sourceU: 0.5,
  }));
  assert.equal(pendingReplayEngine.playGestureBatch(pendingEvents), false);
  assert.equal(pendingReplayEngine.diagnostics().pendingGestureEvents, 3, "gesture notes must wait while audio permission is suspended");
  assert.equal(pendingReplayEngine.context.oscillatorStarts.length, 0);
  pendingReplayEngine.context.state = "running";
  assert.equal(pendingReplayEngine.setEnabled(true), true);
  const replayStarts = pendingReplayEngine.context.oscillatorStarts.slice(-3);
  assert.equal(pendingReplayEngine.diagnostics().pendingGestureEvents, 0, "enabling audio must drain the pending gesture queue");
  assert.equal(replayStarts.length, 3);
  assert.ok(Math.abs((replayStarts[1] - replayStarts[0]) - 0.13) < 1e-6);
  assert.ok(Math.abs((replayStarts[2] - replayStarts[0]) - 0.29) < 1e-6, "unlock replay must preserve the drawn rhythm");
  await pendingReplayEngine.close();

  global.window.AudioContext = MockAudioContext;
  const sleepCleanupEngine = new melodyRuntime.AudioEngine(true);
  assert.equal(sleepCleanupEngine.initialize(), true);
  assert.equal(sleepCleanupEngine.setEnabled(true), true);
  sleepCleanupEngine.playGestureBatch([pendingEvents[0]]);
  sleepCleanupEngine.play([
    { ...pendingEvents[1], kind: "motif-note", duration: 0.4, motifFamily: "original-jazz" },
    { ...pendingEvents[2], kind: "ribbon-tap", activationMode: "melodyWave" },
  ], 20, 1);
  const beforeSleepCleanup = sleepCleanupEngine.diagnostics();
  assert.ok(beforeSleepCleanup.trackedOneShotSources >= 3);
  assert.ok(beforeSleepCleanup.activeGestureVoices > 0);
  assert.ok(beforeSleepCleanup.activeMotifVoices > 0);
  assert.ok(beforeSleepCleanup.activeMechanismVoices > 0);
  await sleepCleanupEngine.sleep();
  const afterSleepCleanup = sleepCleanupEngine.diagnostics();
  assert.equal(afterSleepCleanup.trackedOneShotSources, 0, "sleep must stop every scheduled one-shot source");
  assert.equal(afterSleepCleanup.activeGestureVoices, 0);
  assert.equal(afterSleepCleanup.activeMotifVoices, 0);
  assert.equal(afterSleepCleanup.activeMechanismVoices, 0);
  assert.equal(afterSleepCleanup.contextState, "suspended");
  await sleepCleanupEngine.close();

  global.window.AudioContext = ControlledLifecycleAudioContext;
  const lifecycleEngine = new melodyRuntime.AudioEngine(true);
  assert.equal(lifecycleEngine.initialize(), true);
  assert.equal(lifecycleEngine.setEnabled(true), true);
  const firstContext = lifecycleEngine.context;
  const pendingSleep = lifecycleEngine.sleep();
  for (let turn = 0; turn < 6 && firstContext.suspendCalls === 0; turn += 1) await Promise.resolve();
  assert.equal(firstContext.suspendCalls, 1, "the test must enter a genuinely pending suspend before wake is requested");
  const pendingWake = lifecycleEngine.wake();
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  assert.equal(firstContext.resumeCalls, 0, "wake must stay queued behind the unresolved suspend");
  assert.equal(
    lifecycleEngine.diagnostics().enabled,
    false,
    "the engine must remain disabled while the older suspend is unresolved",
  );
  firstContext.finishSuspend();
  await Promise.all([pendingSleep, pendingWake]);
  assert.equal(firstContext.resumeCalls, 1);
  assert.equal(firstContext.state, "running");
  assert.equal(lifecycleEngine.diagnostics().enabled, true, "the latest visible-state request must win an in-flight suspend race");

  const secondSleep = lifecycleEngine.sleep();
  for (let turn = 0; turn < 6 && firstContext.suspendCalls < 2; turn += 1) await Promise.resolve();
  assert.equal(firstContext.suspendCalls, 2, "the lifecycle queue must accept a later sleep after resolving the race");
  firstContext.finishSuspend();
  await secondSleep;
  assert.equal(firstContext.state, "suspended");
  assert.equal(lifecycleEngine.diagnostics().enabled, false);
  assert.equal(await lifecycleEngine.wake(), true);
  assert.equal(firstContext.resumeCalls, 2);
  assert.equal(firstContext.state, "running");

  await lifecycleEngine.close();
  assert.equal(firstContext.closeCalls, 1);
  assert.equal(lifecycleEngine.diagnostics().initialized, false);
  assert.equal(lifecycleEngine.diagnostics().contextState, "unavailable");
  assert.equal(lifecycleEngine.initialize(), true, "a closed engine must be able to create a fresh AudioContext");
  assert.notEqual(lifecycleEngine.context, firstContext);
  assert.equal(await lifecycleEngine.ensureEnabled(), true);
  assert.equal(lifecycleEngine.context.state, "running");
  await lifecycleEngine.close();

  let insideTrustedClick = false;
  class StrictGestureAudioContext extends MockAudioContext {
    static instances = [];
    constructor() {
      super();
      this.state = "suspended";
      this.resumeCalls = 0;
      this.blockedResumeCalls = 0;
      StrictGestureAudioContext.instances.push(this);
    }
    resume() {
      this.resumeCalls += 1;
      if (!insideTrustedClick) {
        this.blockedResumeCalls += 1;
        return Promise.reject(new Error("AudioContext.resume() escaped the synchronous click handler"));
      }
      this.state = "running";
      return Promise.resolve();
    }
  }

  const strictPage = loadFreshMelodyRuntime("?seed=strict-start-audio", StrictGestureAudioContext);
  strictPage.canvas.listeners.get("pointermove")({
    pointerId: 40, pointerType: "mouse", buttons: 0, pressure: 0,
    clientX: 360, clientY: 480, timeStamp: 80, getCoalescedEvents: () => [],
  });
  strictPage.canvas.listeners.get("pointerdown")({
    pointerId: 41, pointerType: "touch", buttons: 1, pressure: 0.5,
    clientX: 360, clientY: 480, timeStamp: 90, preventDefault() {},
  });
  strictPage.canvas.listeners.get("pointerup")({
    type: "pointerup", pointerId: 41, pointerType: "touch", buttons: 0, pressure: 0,
    clientX: 360, clientY: 480, timeStamp: 100,
  });
  const strictBeforeStart = strictPage.runtime.getSnapshot();
  assert.equal(strictBeforeStart.mode, "idle");
  assert.equal(strictBeforeStart.melody, null);
  assert.equal(strictBeforeStart.visual.trailPointCount, 0);
  assert.equal(StrictGestureAudioContext.instances.length, 0, "default-sound pointer input must not allocate AudioContext before Start");
  assert.equal(strictPage.runtime.getAudioState().scheduledEventCount, 0, "pre-Start pointer input must not queue audio for later playback");
  insideTrustedClick = true;
  strictPage.elements.get("#start-control").listeners.get("click")({ type: "click", isTrusted: true });
  insideTrustedClick = false;
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  const strictContext = StrictGestureAudioContext.instances[0];
  assert.ok(strictContext, "Start must initialize audio while handling the trusted click");
  assert.equal(strictContext.resumeCalls, 1);
  assert.equal(strictContext.blockedResumeCalls, 0, "resume must be invoked synchronously before the trusted click handler returns");
  assert.equal(strictPage.runtime.getSnapshot().mode, "melody");
  assert.equal(strictPage.runtime.getAudioState().contextState, "running");
  assert.equal(strictPage.runtime.getAudioState().enabled, true, "Start must leave a permitted AudioContext enabled");

  class SoundOffAudioContext extends MockAudioContext {
    static constructorCalls = 0;
    constructor() {
      super();
      SoundOffAudioContext.constructorCalls += 1;
    }
  }
  const soundOffPage = loadFreshMelodyRuntime("?seed=sound-off-start&sound=off", SoundOffAudioContext);
  await soundOffPage.runtime.start();
  soundOffPage.canvas.listeners.get("pointerdown")({
    pointerId: 11, pointerType: "touch", buttons: 1, pressure: 0.5,
    clientX: 130, clientY: 620, timeStamp: 100, preventDefault() {},
  });
  const soundOffSnapshot = soundOffPage.runtime.getSnapshot();
  const soundOffAudio = soundOffPage.runtime.getAudioState();
  assert.equal(soundOffSnapshot.mode, "melody", "sound=off must not prevent the visual experience from starting");
  assert.ok(soundOffSnapshot.visual.trailPointCount >= 1, "sound=off must retain immediate gesture visuals");
  assert.equal(SoundOffAudioContext.constructorCalls, 0, "sound=off must not allocate an AudioContext");
  assert.equal(soundOffAudio.intentOn, false);
  assert.equal(soundOffAudio.initialized, false);
  assert.equal(soundOffAudio.contextState, "unavailable");
  assert.equal(soundOffAudio.enabled, false);

  console.log("P4.8 PASS: causal line ripples, dense response, motif abilities, bounded louder audio, stable mechanisms, and legacy modes are verified");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
