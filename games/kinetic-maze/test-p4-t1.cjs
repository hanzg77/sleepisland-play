"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

class MockElement {
  constructor() { this.textContent = ""; this.listeners = new Map(); this.attributes = new Map(); this.classList = { toggle() {} }; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
}

function mockContext() {
  return new Proxy({ globalAlpha: 1 }, { get(target, property) { return property in target ? target[property] : () => {}; }, set(target, property, value) { target[property] = value; return true; } });
}

class MockCanvas extends MockElement {
  constructor() { super(); this.width = 1080; this.height = 1920; this.context = mockContext(); }
  getContext() { return this.context; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1080, height: 1920 }; }
}

function audioParam(initial = 0) {
  return {
    value: initial,
    setValueAtTime(value) { this.value = value; },
    exponentialRampToValueAtTime(value) { this.value = value; },
    cancelScheduledValues() {},
    setTargetAtTime(value) { this.value = value; },
  };
}

function audioNode() {
  return {
    gain: audioParam(1), frequency: audioParam(440), Q: audioParam(1), playbackRate: audioParam(1), pan: audioParam(0),
    connect() { return this; }, start() {}, stop() {},
  };
}

class MockAudioContext {
  constructor() { this.state = "running"; this.currentTime = 0; this.sampleRate = 48000; this.destination = audioNode(); }
  createBiquadFilter() { return audioNode(); }
  createDynamicsCompressor() { return { ...audioNode(), threshold: audioParam(), knee: audioParam(), ratio: audioParam(), attack: audioParam(), release: audioParam() }; }
  createGain() { return audioNode(); }
  createStereoPanner() { return audioNode(); }
  createOscillator() { return audioNode(); }
  createBufferSource() { return audioNode(); }
  createBuffer(_channels, length) { const values = new Float32Array(length); return { getChannelData() { return values; } }; }
  resume() { this.state = "running"; return Promise.resolve(); }
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

require(path.join(__dirname, "kinetic-maze-v4.js"));
const debug = global.window.__KINETIC_V4_DEBUG__;
assert.ok(debug);
assert.equal(debug.version, "4.3-ripple-t1");

const components = debug.getComponents();
assert.equal(components.length, 144);
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

assert.equal(debug.hitTestPoint(72 + 1, 160 + 1), 0);
assert.equal(debug.hitTestPoint(72 + 936 - 1, 160 + 1640 - 1), 143);
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

assert.equal(typeof scheduledFrame, "function");
console.log("P4.3 PASS: ripple mode plus preview behavior, deterministic 180s growth, complete-cycle retirement, and final silence are verified");
