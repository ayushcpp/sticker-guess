// Evaluates gestures.js on the real hand landmarks extracted from video.mp4
// (tests/fixtures/video_landmarks.json: GestureRecognizer landmarks + canned gesture).
// Ground truth = the meme the ORIGINAL Python app was showing in that frame
// (so labels lag the hand by a few frames around transitions).
//
// Usage: node scripts/analyze-fixtures.mjs [--frames] [--no-canned]
//   --frames     list every frame where the prediction differs from the label
//   --no-canned  ignore the canned gesture (rules-only fallback)
import { readFileSync } from "node:fs";
import { classifyFrame, GestureStabilizer, isHeart } from "../public/js/gestures.js";

const NO_CANNED = process.argv.includes("--no-canned");
const data = JSON.parse(readFileSync(new URL("../tests/fixtures/video_landmarks.json", import.meta.url)));
const W = data.imageWidth;
const H = data.imageHeight;
const toPts = (arr) => arr.map(([x, y, z]) => ({ x, y, z }));
const samples = data.samples.map((s) => ({
  ...s,
  hands: s.hands.map((h) => ({ landmarks: toPts(h.landmarks), worldLandmarks: toPts(h.world), canned: NO_CANNED ? undefined : h.canned })),
}));

// ---- feature distributions per ground-truth label ----
const stats = {};
const push = (label, key, v) => ((stats[label] ??= {})[key] ??= []).push(+v.toFixed(2));
for (const s of samples) {
  const { hands: feats } = classifyFrame(s.hands, W, H);
  for (const f of feats) {
    for (const [k, v] of Object.entries(f.ext)) push(s.label, k, v);
    for (const k of ["thumbFree", "thumbTop", "thumbBottom", "thumbTopTilted", "thumbBottomTilted", "thumbSide", "pinkyReach", "indexTilt", "indexBend"]) push(s.label, k, f[k]);
  }
  if (feats.length === 2) {
    const h = isHeart(feats[0], feats[1]);
    for (const k of ["thumbGap", "indexGap", "wristGap", "bend"]) push(s.label, `heart.${k}`, h[k]);
  }
}
const q = (arr, p) => [...arr].sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor(p * arr.length))];
for (const [label, keys] of Object.entries(stats)) {
  console.log(`\n== ${label}`);
  for (const [k, v] of Object.entries(keys)) {
    console.log(`  ${k.padEnd(15)} n=${String(v.length).padStart(3)}  min=${q(v, 0)}  p10=${q(v, 0.1)}  med=${q(v, 0.5)}  p90=${q(v, 0.9)}  max=${q(v, 1)}`);
  }
}

// ---- raw per-frame accuracy (frames with at least one hand) ----
const confusion = {};
let ok = 0;
let n = 0;
for (const s of samples) {
  if (!s.hands.length) continue;
  const r = classifyFrame(s.hands, W, H);
  const pred = r.gesture ?? "idle";
  (confusion[s.label] ??= {})[pred] = (confusion[s.label][pred] ?? 0) + 1;
  n++;
  if (pred === s.label) ok++;
  else if (process.argv.includes("--frames")) {
    const canned = s.hands.map((h) => h.canned?.name ?? "-").join(",");
    console.log(`t=${s.t}s truth=${s.label} pred=${pred} canned=${canned}`, JSON.stringify(r.hands.map((f) => f.ext)));
  }
}
console.log(`\nconfusion (truth -> predicted)${NO_CANNED ? ", rules only" : ""}:`);
for (const [k, v] of Object.entries(confusion)) console.log(`  ${k.padEnd(9)} ${JSON.stringify(v)}`);
console.log(`raw frame accuracy (hands visible): ${ok}/${n} = ${((100 * ok) / n).toFixed(1)}%  (the triangle is not a meme any more)`);

// ---- stabilised timeline vs. the original app (all frames, incl. no-hand) ----
const stab = new GestureStabilizer(150, 400, 150);
const timeline = [];
for (const s of samples) {
  const out = stab.update(classifyFrame(s.hands, W, H).gesture, s.t * 1000) ?? "idle";
  const last = timeline.at(-1);
  if (!last || last.g !== out) timeline.push({ t: s.t, g: out });
}
console.log("our stabilised timeline:", timeline.map((e) => `${e.t}s ${e.g}`).join(" → "));
const truthTl = [];
for (const s of samples) if (!truthTl.length || truthTl.at(-1).g !== s.label) truthTl.push({ t: s.t, g: s.label });
console.log("original app timeline:  ", truthTl.map((e) => `${e.t}s ${e.g}`).join(" → "));
