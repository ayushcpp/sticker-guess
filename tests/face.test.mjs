// Face triggers. Real-data checks use tests/fixtures/face_landmarks.json: FaceLandmarker output
// for video.mp4 (one person at a normal distance: neutral, smiling and duck lips; never
// screaming, sad or leaning in). Rows are 0.1 s apart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  blendshapeMap,
  classifyExpression,
  CLOSEUP,
  CloseupDetector,
  EXPRESSION_THRESHOLDS,
  ExpressionTracker,
  expressionSignals,
  faceWidth,
  HEAD_POSE,
  headPose,
  HeadPoseTracker,
} from "../public/js/face.js";
import { STABILIZER } from "../public/js/config.js";
import { PriorityStabilizer } from "../public/js/stabilizer.js";

const rows = JSON.parse(readFileSync(new URL("./fixtures/face_landmarks.json", import.meta.url))).filter(
  (r) => r.faceW != null,
);
const classify = (r) => classifyExpression(expressionSignals(r));
const MEMES = ["scream", "laugh", "smile", "sad", "kiss"];

describe("expressions on real data from video.mp4", () => {
  it("has enough samples", () => assert.ok(rows.length > 100));

  it("never shows scream / laugh / sad (this person never makes those faces)", () => {
    const bad = rows.map((r) => [r.t, classify(r)]).filter(([, e]) => ["scream", "laugh", "sad"].includes(e));
    assert.deepEqual(bad, []);
  });

  it("detects the big smiles as smile", () => {
    const smiling = rows.filter((r) => expressionSignals(r).smile >= 0.6);
    assert.ok(smiling.length > 10);
    for (const r of smiling) assert.equal(classify(r), "smile", `t=${r.t}`);
  });

  it("detects duck lips as kiss", () => {
    const duck = rows.filter((r) => r.mouthPucker >= 0.9);
    assert.ok(duck.length > 20);
    for (const r of duck) assert.equal(classify(r), "kiss", `t=${r.t}`);
  });

  it("shows nothing on the plain frames (no smile, no pout)", () => {
    const plain = rows.filter((r) => expressionSignals(r).smile < 0.3 && r.mouthPucker < 0.6);
    assert.ok(plain.length > 50);
    for (const r of plain) assert.ok(!MEMES.includes(classify(r)), `t=${r.t}: ${classify(r)}`);
  });
});

describe("expression rules (synthetic)", () => {
  const s = (o) => ({
    jaw: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, lowerLip: 0, upperLip: 0,
    browInnerUp: 0, browOuterUp: 0, browDown: 0, eyeWide: 0, ...o,
  });

  it("scream: mouth wide open", () => {
    assert.equal(classifyExpression(s({ jaw: 0.8 })), "scream");
    // The bug users hit: a wide-open mouth also lifts the corners; that used to become "laugh".
    assert.equal(classifyExpression(s({ jaw: 0.7, smile: 0.6 })), "scream");
    assert.equal(classifyExpression(s({ jaw: 0.74, smile: 0.64, lowerLip: 0.63 })), "scream");
  });

  it("scream: open mouth + surprise eyes/brows, or a lowered lower lip", () => {
    assert.equal(classifyExpression(s({ jaw: 0.45, browOuterUp: 0.7 })), "scream"); // "oh!" with raised brows
    assert.equal(classifyExpression(s({ jaw: 0.42, eyeWide: 0.2 })), "scream");
    assert.equal(classifyExpression(s({ jaw: 0.5, lowerLip: 0.4 })), "scream");
    assert.equal(classifyExpression(s({ jaw: 0.29, lowerLip: 0.87, eyeWide: 0.44 })), "scream");
  });

  it("scream: the weaker brow / eye scores of VIDEO mode at webcam scale", () => {
    // e2e "surprised" face in the browser (VIDEO mode, ~210 px face): median signals of 37 frames.
    assert.equal(classifyExpression(s({ jaw: 0.58, browOuterUp: 0.48, browInnerUp: 0.29, eyeWide: 0.04, pucker: 0.25 })), "scream");
    assert.equal(classifyExpression(s({ jaw: 0.52, eyeWide: 0.11 })), "scream");
    // talking at the same jaw opening: brows / eyes stay at rest; raised INNER brows alone don't count
    assert.equal(classifyExpression(s({ jaw: 0.55, browOuterUp: 0.01, browDown: 0.7 })), null);
    assert.equal(classifyExpression(s({ jaw: 0.55, browInnerUp: 0.6 })), null);
    assert.equal(classifyExpression(s({ jaw: 0.45, browOuterUp: 0.3 })), null); // talking-range jaw
  });

  it("scream: VIDEO-mode brow / eye cues count on the stronger side", () => {
    // VIDEO mode often reads one side much lower (one face: eyeWide 0.04 / 0.13 -> mean 0.085)
    const asym = s({ jaw: 0.56, eyeWide: 0.085, eyeWideMax: 0.13 });
    assert.equal(classifyExpression(asym), "scream");
    assert.equal(classifyExpression({ ...asym, eyeWideMax: 0.085 }), null);
    // talking at jawOpen >= 0.4: outer brows <= 0.16 on either side
    assert.equal(classifyExpression(s({ jaw: 0.55, browOuterUp: 0.09, browOuterUpMax: 0.16 })), null);
  });

  it("scream beats laugh when the mouth has the scream shape (lower lip down, upper teeth covered)", () => {
    // hands-on-cheeks scream photo (VIDEO mode): it used to show the LAUGH meme
    assert.equal(classifyExpression(s({ jaw: 0.5, smile: 0.7, lowerLip: 0.43, upperLip: 0.13 })), "scream");
    // a laugh shows the upper teeth, and a much bigger smile still wins
    assert.equal(classifyExpression(s({ jaw: 0.5, smile: 0.7, lowerLip: 0.43, upperLip: 0.5 })), "laugh");
    assert.equal(classifyExpression(s({ jaw: 0.5, smile: 0.85, lowerLip: 0.43, upperLip: 0.13 })), "laugh");
  });

  it("talking-range mouth opening alone shows nothing (in one frame; HELD open it's a scream, see ExpressionTracker)", () => {
    for (const jaw of [0.15, 0.25, 0.35, 0.5, 0.6]) assert.equal(classifyExpression(s({ jaw })), null, `jaw ${jaw}`);
    // "oo" sounds: pursed lips with the jaw open are not a kiss
    assert.equal(classifyExpression(s({ jaw: 0.26, pucker: 1 })), null);
    // inner brows raised while talking are not sad
    assert.equal(classifyExpression(s({ jaw: 0.1, browInnerUp: 0.8 })), null);
  });

  it("laugh: smile with the mouth open; a smile has to dominate a wide-open mouth", () => {
    assert.equal(classifyExpression(s({ jaw: 0.3, smile: 0.95 })), "laugh");
    assert.equal(classifyExpression(s({ jaw: 0.6, smile: 0.9 })), "laugh");
    assert.equal(classifyExpression(s({ jaw: 0.41, smile: 0.77, lowerLip: 0.77, upperLip: 0.5 })), "laugh");
  });

  it("smile: closed mouth, including a toothy grin (lips apart, jaw closed)", () => {
    assert.equal(classifyExpression(s({ smile: 0.7 })), "smile");
    assert.equal(classifyExpression(s({ smile: 0.9, jaw: 0.05, lowerLip: 0.6, upperLip: 0.8 })), "smile");
    assert.equal(classifyExpression(s({ smile: 0.4 })), null); // faint smile
  });

  it("kiss: strong pout with the mouth closed; resting full lips are not a kiss", () => {
    assert.equal(classifyExpression(s({ pucker: 0.95 })), "kiss");
    assert.equal(classifyExpression(s({ pucker: 0.87 })), null); // max on a resting face
    assert.equal(classifyExpression(s({ pucker: 0.95, funnel: 0.3 })), null);
    // talking "oo"/"w": lips pursed but the jaw a little open (duck lips: jawOpen <= 0.002)
    assert.equal(classifyExpression(s({ pucker: 0.98, jaw: 0.09 })), null);
    assert.equal(classifyExpression(s({ pucker: 0.99, jaw: 0.059 })), null);
    assert.equal(classifyExpression(s({ pucker: 0.95, jaw: 0.01 })), "kiss");
  });

  it("sad: mouth corners down, or puppy brows with a slight frown", () => {
    assert.equal(classifyExpression(s({ frown: 0.35 })), "sad");
    assert.equal(classifyExpression(s({ frown: 0.1, browInnerUp: 0.7, browOuterUp: 0.3 })), "sad");
    assert.equal(classifyExpression(s({ frown: 0.1 })), null);
    assert.equal(classifyExpression(s({ browInnerUp: 0.7 })), null); // brows alone (talking, resting faces)
    assert.equal(classifyExpression(s({ frown: 0.1, browInnerUp: 0.8, browOuterUp: 0.8 })), null); // raised brows
  });

  it("angry has no meme and never becomes sad/scream", () => {
    assert.equal(classifyExpression(s({ browDown: 0.8 })), "angry");
    assert.equal(classifyExpression(s({ browDown: 0.8, smile: 0.6 })), "smile");
  });

  it("neutral -> null", () => assert.equal(classifyExpression(s({})), null));

  it("hysteresis: a borderline scream / laugh is kept once it is showing, but never started", () => {
    // e2e CPU path: browOuterUp 0.44-0.50 around the 0.5 cue, jaw 0.36-0.45
    const border = s({ jaw: 0.44, browOuterUp: 0.47 });
    assert.equal(classifyExpression(border), null);
    assert.equal(classifyExpression(border, undefined, null), null);
    assert.equal(classifyExpression(border, undefined, "scream"), "scream");
    assert.equal(classifyExpression(border, undefined, "smile"), null); // only the previous expression is eased
    // clearly gone -> released
    assert.equal(classifyExpression(s({ jaw: 0.2, browOuterUp: 0.1 }), undefined, "scream"), null);
    // a stronger expression still takes over (laugh is decided before smile)
    assert.equal(classifyExpression(s({ jaw: 0.4, smile: 0.9 }), undefined, "smile"), "laugh");
    // and laugh doesn't drop back to smile while the mouth is still a little open
    assert.equal(classifyExpression(s({ jaw: 0.17, smile: 0.66 }), undefined, "laugh"), "laugh");
    assert.equal(classifyExpression(s({ jaw: 0.17, smile: 0.66 })), "smile");
  });

  it("hysteresis never holds smile / kiss / sad: resting faces sit just under those thresholds", () => {
    // VIDEO-mode neutral faces rest at smile 0.45-0.50, pucker 0.86-0.90, frown 0.17
    assert.equal(classifyExpression(s({ smile: 0.47 }), undefined, "smile"), null);
    assert.equal(classifyExpression(s({ pucker: 0.88 }), undefined, "kiss"), null);
    assert.equal(classifyExpression(s({ frown: 0.17 }), undefined, "sad"), null);
  });

  it("reads MediaPipe's Classifications shape", () => {
    const bs = { categories: [{ categoryName: "jawOpen", score: 0.9 }, { categoryName: "mouthSmileLeft", score: 0.1 }] };
    assert.equal(blendshapeMap(bs).jawOpen, 0.9);
    assert.equal(expressionSignals(blendshapeMap(bs)).jaw, 0.9);
    assert.equal(classifyExpression(expressionSignals(blendshapeMap(bs))), "scream");
    assert.deepEqual(blendshapeMap(undefined), {});
  });
});

describe("CloseupDetector", () => {
  const STEP = 33; // ms per frame (30 fps)
  /** Feed width(i) for `ms` milliseconds starting at t0; returns [lastT, results]. */
  const feed = (d, t0, ms, width) => {
    const out = [];
    let t = t0;
    for (let i = 0; t < t0 + ms; i++, t += STEP) out.push(d.update(typeof width === "function" ? width(i) : width, t));
    return [t, out];
  };
  /** A person moving: width goes from a to b over `ms` (nobody jumps 1.4x between two frames). */
  const move = (d, t0, ms, a, b) => feed(d, t0, ms, (i) => a + ((b - a) * i * STEP) / ms);
  const normal = (i) => rows[i % rows.length].faceW; // the reference person at normal distance

  it("faceWidth is the x-extent of the landmarks", () => {
    assert.equal(faceWidth([{ x: 0.3 }, { x: 0.55 }, { x: 0.4 }]).toFixed(2), "0.25");
  });

  it("no close-up until it has learned the person's normal size (2 s), even when starting close", () => {
    // phones / close laptops: 15 of 19 phone selfies have face width >= 0.34 (median 0.49)
    const d = new CloseupDetector();
    const [t, out] = feed(d, 0, 1900, 0.45);
    assert.ok(out.every((x) => x === false));
    assert.equal(d.baseline, null);
    assert.equal(d.thresholds(), null);
    const [, out2] = feed(d, t, 3000, 0.45);
    assert.ok(out2.every((x) => x === false));
    assert.ok(Math.abs(d.baseline - 0.45) < 1e-9);
  });

  it("samples on a 100 ms grid: 30 fps frames give 10 samples/s, so the warm-up takes ~2 s", () => {
    const d = new CloseupDetector();
    feed(d, 0, 1900, 0.24);
    assert.equal(d.baseline, null);
    feed(d, 1914, 200, 0.24);
    assert.ok(Math.abs(d.baseline - 0.24) < 1e-9);
  });

  it("never fires at normal sitting distance on the reference video, and learns its face size", () => {
    const d = new CloseupDetector();
    let fired = 0;
    for (let rep = 0; rep < 4; rep++) {
      for (const r of rows) if (d.update(r.faceW, rep * 13000 + r.t * 1000)) fired++;
    }
    assert.equal(fired, 0);
    assert.ok(d.baseline > 0.23 && d.baseline < 0.25, `baseline ${d.baseline}`);
    const { enter, exit } = d.thresholds();
    assert.ok(Math.abs(enter - d.baseline * CLOSEUP.enterRatio) < 1e-9);
    assert.ok(exit < enter && exit > d.baseline);
  });

  it("fires on a sustained lean-in (~1.5x) and turns off after leaning back", () => {
    const d = new CloseupDetector();
    let [t] = feed(d, 0, 10000, normal);
    let out;
    [t, out] = move(d, t, 400, 0.24, 0.36);
    [t, out] = feed(d, t, 3000, (i) => normal(i) * 1.5);
    assert.equal(out.at(-1), true);
    assert.ok(out.filter(Boolean).length > out.length * 0.9);
    [t] = move(d, t, 400, 0.36, 0.24);
    [t, out] = feed(d, t, 1000, normal);
    assert.equal(out.at(-1), false);
  });

  it("a quick lean-in (1.5x in 150 ms) is a close-up, not a switch to another person", () => {
    const d = new CloseupDetector();
    let [t] = feed(d, 0, 5000, 0.24);
    [t] = move(d, t, 150, 0.24, 0.36);
    const [, out] = feed(d, t, 1000, 0.36);
    assert.equal(out.at(-1), true);
  });

  it("a moderate move (1.3x) is not a close-up", () => {
    const d = new CloseupDetector();
    let [t] = feed(d, 0, 10000, normal);
    [t] = move(d, t, 400, 0.24, 0.31);
    const [, out] = feed(d, t, 3000, (i) => normal(i) * 1.3);
    assert.equal(out.filter(Boolean).length, 0);
  });

  it("a brief lean-in does not move the baseline", () => {
    const d = new CloseupDetector();
    let [t] = feed(d, 0, 10000, normal);
    const before = d.baseline;
    [t] = move(d, t, 300, 0.24, 0.38);
    [t] = feed(d, t, 1500, (i) => normal(i) * 1.6);
    [t] = move(d, t, 300, 0.38, 0.24);
    [t] = feed(d, t, 2000, normal);
    assert.ok(Math.abs(d.baseline - before) / before < 0.02, `${before} -> ${d.baseline}`);
  });

  it("a lasting new distance stops being a close-up after maxActiveMs and becomes the baseline", () => {
    // was: 10 s at 0.20 then 60 s at 0.30 -> "Too close!" (and no face meme) for all 60 s
    const d = new CloseupDetector();
    let [t] = feed(d, 0, 10000, 0.2);
    [t] = move(d, t, 1000, 0.2, 0.3);
    const [t2, out] = feed(d, t, 20000, 0.3);
    const on = out.filter(Boolean).length * STEP;
    assert.ok(on > 4000 && on <= CLOSEUP.maxActiveMs + 1000, `close-up for ${on} ms`);
    assert.ok(out.slice(-300).every((x) => x === false)); // the last 10 s
    assert.ok(Math.abs(d.baseline - 0.3) < 0.01, `baseline ${d.baseline}`);
    // and leaning in from the new distance works again
    let [t3] = move(d, t2, 400, 0.3, 0.45);
    const [, out3] = feed(d, t3, 1000, 0.45);
    assert.equal(out3.at(-1), true);
  });

  it("the tracker hopping to a closer person (1.5x between two face results) is not a close-up", () => {
    // Python VIDEO mode, numFaces 1, 6/6 pairs: A (0.20) tracked; A hidden 0.3 s -> tracker on B (0.30)
    const d = new CloseupDetector();
    let [t] = feed(d, 0, 5000, (i) => 0.203 * (1 + 0.02 * Math.sin(i))); // landmarks jitter every result
    assert.equal(d.update(null, t), false); // one result without a face
    const [, out] = feed(d, t + 33, 30000, (i) => 0.303 * (1 + 0.02 * Math.sin(i)));
    assert.equal(out.filter(Boolean).length, 0);
    assert.ok(Math.abs(d.baseline - 0.303) < 0.01, `baseline ${d.baseline}`);
  });

  it("adapts to the person: someone sitting far back must still come reasonably close", () => {
    const d = new CloseupDetector();
    let [t] = feed(d, 0, 5000, 0.12);
    assert.ok(Math.abs(d.baseline - 0.12) < 1e-9);
    assert.equal(d.thresholds().enter, CLOSEUP.minEnter); // 1.4 x 0.12 = 0.17 is below the floor
    let out;
    [t] = move(d, t, 500, 0.12, 0.2);
    [t, out] = feed(d, t, 1000, 0.2);
    assert.equal(out.at(-1), false);
    [t] = move(d, t, 300, 0.2, 0.26);
    [t, out] = feed(d, t, 1000, 0.26);
    assert.equal(out.at(-1), true);
  });

  it("no face -> off; the baseline survives; reset() forgets it", () => {
    const d = new CloseupDetector();
    let [t] = feed(d, 0, 5000, 0.24);
    [t] = move(d, t, 400, 0.24, 0.4);
    [t] = feed(d, t, 500, 0.4);
    assert.equal(d.active, true);
    assert.equal(d.update(null, t), false);
    assert.ok(Math.abs(d.baseline - 0.24) < 1e-9);
    d.reset();
    assert.equal(d.baseline, null);
    assert.equal(d.update(0.4, t + 33), false); // warming up again
  });

  it("works without timestamps (each call is one sample)", () => {
    const d = new CloseupDetector();
    for (let i = 0; i < 30; i++) d.update(0.2);
    assert.ok(Math.abs(d.baseline - 0.2) < 1e-9);
    d.update(0.24);
    d.update(0.27);
    assert.equal(d.update(0.29), true);
  });
});

describe("face channel as main.js wires it (classifier + stabiliser, hysteresis on the shown meme)", () => {
  const s = (o) => ({
    jaw: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, lowerLip: 0, upperLip: 0,
    browInnerUp: 0, browOuterUp: 0, browDown: 0, eyeWide: 0, ...o,
  });
  /**
   * 30 fps; the face model runs on every other frame and its signals are reused in between.
   * `tracker` = use an ExpressionTracker (held-mouth scream) instead of plain classifyExpression.
   */
  const run = (faceRuns, { tracker = false, step = 33 } = {}) => {
    const st = new PriorityStabilizer(STABILIZER.enterMs, STABILIZER.exitMs, STABILIZER.gapMs, { minShowMs: STABILIZER.minShowMs });
    const tr = tracker ? new ExpressionTracker() : null;
    const out = [];
    for (let i = 0; i < faceRuns.length * 2; i++) {
      const sig = faceRuns[i >> 1];
      const e = tr ? tr.update(sig, i * step, st.face.current) : classifyExpression(sig, undefined, st.face.current);
      out.push(st.update(null, MEMES.includes(e) ? e : null, i * step));
    }
    return out;
  };
  const times = (n, sig) => Array.from({ length: n }, () => sig);

  it("a frown hovering just under the threshold (one run at 0.21) never shows sad", () => {
    // e2e: a face with mouthFrown 0.06-0.21 (median 0.18) became a steady "sad" when single raw
    // frames were held; holding only the CONFIRMED meme fixes that.
    const runs = Array.from({ length: 40 }, (_, i) => s({ frown: i === 3 ? 0.21 : 0.18 }));
    assert.ok(!run(runs).includes("sad"));
  });

  it("a confirmed scream with borderline cues stays up without blinking", () => {
    // first runs clearly above the cue, then browOuterUp 0.44-0.50 around the 0.5 cue (e2e, CPU path)
    const runs = [
      ...times(4, s({ jaw: 0.45, browOuterUp: 0.53 })),
      ...Array.from({ length: 40 }, (_, i) => s({ jaw: 0.44, browOuterUp: [0.44, 0.47, 0.49, 0.5][i % 4] })),
    ];
    for (const tracker of [false, true]) {
      const out = run(runs, { tracker });
      const first = out.indexOf("scream");
      assert.ok(first >= 0 && first * 33 <= 250, `shown after ${first * 33} ms`);
      assert.ok(out.slice(first).every((x) => x === "scream"));
    }
  });

  it("after a smile / kiss / sad, a resting face just under the threshold ends the meme", () => {
    // 7 of 323 VIDEO-mode neutral faces rest in such a band; the old hold kept the meme on for good
    for (const [expr, rest] of [
      [s({ smile: 0.75 }), s({ smile: 0.47 })],
      [s({ pucker: 0.96 }), s({ pucker: 0.87 })],
      [s({ frown: 0.3 }), s({ frown: 0.17 })],
    ]) {
      for (const tracker of [false, true]) {
        const out = run([...times(15, expr), ...times(150, rest)], { tracker }); // 1 s, then 10 s at rest
        assert.ok(MEMES.includes(out[25]), `${JSON.stringify(expr)} shown`);
        assert.equal(out.at(-1), null);
      }
    }
  });

  it("tracker: a mouth HELD wide open is a scream, with calm brows (VIDEO mode, jawOpen 0.47-0.58)", () => {
    // tune photos that showed nothing before (an AAAH with neutral brows): jaw 0.53, eyeWide 0.08
    const aaah = s({ jaw: 0.53, eyeWide: 0.08, eyeWideMax: 0.08, browOuterUp: 0.02 });
    assert.equal(classifyExpression(aaah), null);
    const out = run(times(30, aaah), { tracker: true }); // 2 s
    const first = out.indexOf("scream");
    assert.ok(first * 33 >= EXPRESSION_THRESHOLDS.heldMs && first * 33 <= EXPRESSION_THRESHOLDS.heldMs + 250, `after ${first * 33} ms`);
    assert.ok(out.slice(first).every((x) => x === "scream"));
    // the plain classifier alone shows nothing for it
    assert.ok(!run(times(30, aaah)).includes("scream"));
  });

  it("tracker: talking-length jaw openings (<= 267 ms at >= 0.45) never show scream", () => {
    // talking: longest run at jawOpen >= 0.45 was 267 ms; 4 face runs = 264 ms open, then 200 ms closed
    const burst = [...times(4, s({ jaw: 0.55 })), ...times(3, s({ jaw: 0.2 }))];
    const out = run(Array.from({ length: 10 }, () => burst).flat(), { tracker: true });
    assert.ok(!out.includes("scream"));
    // one dip of a single face run inside a held scream is bridged
    const dip = [...times(4, s({ jaw: 0.55 })), s({ jaw: 0.3 }), ...times(10, s({ jaw: 0.55 }))];
    assert.ok(run(dip, { tracker: true }).includes("scream"));
  });

  it("tracker: a slow frame rate alone doesn't break the hold, a long closed-mouth dip does", () => {
    // e2e under heavy load: frames up to 370 ms apart, every face result at jawOpen 0.57
    const tr = new ExpressionTracker();
    const open = s({ jaw: 0.57 });
    let e;
    for (const t of [0, 370, 700]) e = tr.update(open, t);
    assert.equal(e, "scream");
    const tr2 = new ExpressionTracker();
    tr2.update(open, 0);
    tr2.update(open, 200);
    tr2.update(s({ jaw: 0.2 }), 250); // closed from 250 ms...
    assert.equal(tr2.update(open, 450), null); // ...to 450 ms: longer than heldDipMs, the hold restarts
    assert.equal(tr2.update(open, 800), null);
    assert.equal(tr2.update(open, 850), "scream");
  });

  it("tracker: a held open-mouth laugh stays a laugh", () => {
    const out = run(times(45, s({ jaw: 0.55, smile: 0.75, upperLip: 0.5 })), { tracker: true });
    assert.ok(out.includes("laugh") && !out.includes("scream"));
  });

  it("tracker: no face -> null; the scream comes back after the mouth is held open again", () => {
    const tr = new ExpressionTracker();
    assert.equal(tr.update(null, 0), null);
    let e;
    for (let t = 0; t <= 600; t += 33) e = tr.update(s({ jaw: 0.5 }), t);
    assert.equal(e, "scream");
    assert.equal(tr.update(s({ jaw: 0.1 }), 633), null);
    assert.equal(tr.update(s({ jaw: 0.5 }), 1000), null); // a new run has to be held again
  });
});

/* ------------------------------------------------------------------- head pose -- */
// A 4x4 pose matrix (column-major, as MediaPipe packs it) for a head turned by yawDeg and tilted
// down by downDeg: only the face's forward direction (3rd column) matters to headPose.
function poseMatrix(yawDeg, downDeg, rowMajor = false) {
  const r = Math.PI / 180;
  const f = [Math.sin(yawDeg * r) * Math.cos(downDeg * r), -Math.sin(downDeg * r), Math.cos(yawDeg * r) * Math.cos(downDeg * r)];
  const m = [[1, 0, f[0], 4], [0, 1, f[1], 5], [0, 0, f[2], -45], [0, 0, 0, 1]];
  const data = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) data.push(rowMajor ? m[i][j] : m[j][i]);
  return { rows: 4, columns: 4, data };
}

describe("headPose", () => {
  it("reads yaw and downward tilt, whichever way the matrix is packed", () => {
    for (const rowMajor of [false, true]) {
      const p = headPose(poseMatrix(-30, 20, rowMajor));
      assert.ok(Math.abs(p.yaw + 30) < 0.01 && Math.abs(p.down - 20) < 0.01, JSON.stringify(p));
    }
  });

  it("a real photo of a man looking down at his saxophone reads ~22 deg down", () => {
    // FaceLandmarker output for a Wikimedia Commons photo; looking-down photos gave +15..+42 deg.
    const data = [0.99, -0.132, -0.047, 0, 0.14, 0.915, 0.378, 0, -0.007, -0.38, 0.925, 0, 5.324, 5.614, -46.947, 1];
    const p = headPose({ rows: 4, columns: 4, data });
    assert.ok(Math.abs(p.down - 22.4) < 0.3 && Math.abs(p.yaw) < 1, JSON.stringify(p));
  });

  it("no matrix -> null", () => {
    assert.equal(headPose(undefined), null);
    assert.equal(headPose({ data: [] }), null);
  });
});

describe("HeadPoseTracker", () => {
  // Feeds {yaw, down} for ms at 30 fps; returns the last result and every distinct result seen.
  const run = (tr, pose, ms, clock) => {
    const seen = new Set();
    let last;
    for (const end = clock.t + ms; clock.t < end; clock.t += 33) seen.add((last = tr.update(pose, clock.t)));
    return { last, seen };
  };

  it("needs a learned usual pose first, then side-eye / look-down at the enter angles", () => {
    const tr = new HeadPoseTracker();
    const c = { t: 0 };
    assert.equal(run(tr, { yaw: 30, down: 30 }, 500, c).last, null); // nothing learned yet
    tr.reset();
    run(tr, { yaw: 3, down: 2 }, 1500, c);
    assert.equal(run(tr, { yaw: 3 + HEAD_POSE.sideEnter - 1, down: 2 }, 300, c).last, null);
    assert.equal(run(tr, { yaw: 3 + HEAD_POSE.sideEnter + 1, down: 2 }, 300, c).last, "side_eye");
    assert.equal(run(tr, { yaw: 3 - HEAD_POSE.sideEnter - 1, down: 2 }, 300, c).last, "side_eye"); // either side
    assert.equal(run(tr, { yaw: 3, down: 2 + HEAD_POSE.downEnter + 1 }, 300, c).last, "look_down");
    assert.equal(run(tr, { yaw: 3, down: 2 }, 300, c).last, null);
    assert.equal(run(tr, { yaw: 3, down: 2 - 40 }, 300, c).last, null); // looking up: nothing
  });

  it("holds the meme between the exit and enter angles (no flicker at the edge)", () => {
    const tr = new HeadPoseTracker();
    const c = { t: 0 };
    run(tr, { yaw: 0, down: 0 }, 1500, c);
    assert.equal(run(tr, { yaw: 0, down: HEAD_POSE.downEnter + 2 }, 200, c).last, "look_down");
    const mid = run(tr, { yaw: 0, down: (HEAD_POSE.downEnter + HEAD_POSE.downExit) / 2 }, 2000, c);
    assert.deepEqual([...mid.seen], ["look_down"]);
    assert.equal(run(tr, { yaw: 0, down: HEAD_POSE.downExit - 1 }, 100, c).last, null);
  });

  it("measures from the person's usual pose (webcam above the screen: level head reads 12 deg down)", () => {
    // video.mp4: this person at rest reads down 5.5..17.3 (median 12.1), yaw -0.8..13.3 (median 4.3).
    const tr = new HeadPoseTracker();
    const c = { t: 0 };
    run(tr, { yaw: 4, down: 12 }, 2000, c);
    assert.equal(run(tr, { yaw: 13, down: 17.3 }, 500, c).last, null); // the most extreme frames at rest
    assert.equal(run(tr, { yaw: 4, down: 12 + HEAD_POSE.downEnter + 1 }, 300, c).last, "look_down");
  });

  it("a head held turned from the start is not learned as straight (baseline capped)", () => {
    const tr = new HeadPoseTracker();
    const c = { t: 0 };
    run(tr, { yaw: 0, down: 40 }, 1500, c);
    assert.equal(run(tr, { yaw: 0, down: HEAD_POSE.maxBaseline + HEAD_POSE.downEnter + 1 }, 300, c).last, "look_down");
  });

  it("hold: a head held partly turned is not learned as straight (review: bar fell to 0%)", () => {
    const tr = new HeadPoseTracker();
    const c = { t: 0 };
    run(tr, { yaw: 0, down: 0 }, 4000, c);
    tr.hold = true; // the game is asking for side-eye
    run(tr, { yaw: 15, down: 0 }, 8000, c);
    assert.equal(tr.offset.side, 15); // still measured from straight
    assert.equal(run(tr, { yaw: HEAD_POSE.sideEnter + 1, down: 0 }, 300, c).last, "side_eye");
    // without hold the usual pose adapts (free play)
    const free = new HeadPoseTracker();
    const d = { t: 0 };
    run(free, { yaw: 0, down: 0 }, 4000, d);
    run(free, { yaw: 15, down: 0 }, 8000, d);
    assert.equal(free.offset.side, 0);
  });

  it("no face -> null", () => {
    const tr = new HeadPoseTracker();
    const c = { t: 0 };
    run(tr, { yaw: 0, down: 0 }, 1500, c);
    run(tr, { yaw: 40, down: 0 }, 300, c);
    assert.equal(tr.update(null, c.t), null);
  });
});

