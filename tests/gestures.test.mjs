// Run: npm test   (node --test, no dependencies)
//
// Real-data tests of the hand classifier, with exactly what main.js feeds it:
// GestureRecognizer landmarks + world landmarks + its top-1 canned gesture.
//
// 1. fixtures/video_landmarks.json: video.mp4 (demo of the original Python app),
//    webcam window, every 2nd frame through GestureRecognizer in VIDEO mode.
//    Each sample is labelled with the meme the ORIGINAL app was showing (labels
//    lag the hand by a few frames). The video has point, shaka and a two-hand
//    "triangle" (steeple), which is the steeple meme again (its cat picture is in public/memes).
// 2. fixtures/hagrid_hands.json: a handful of real HaGRID hands (CC BY-SA 4.0,
//    numbers only): thumbs up, thumbs down, fists, shakas that the model calls
//    Thumb_Up, and resting hands that the model calls Thumb_Up. Plus TILTED
//    thumbs up / down and fists (groups *_tilted): the photo was rotated 30-45
//    degrees and run through GestureRecognizer again, so the model's own label
//    is the one a tilted hand really gets (often "None").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isFlex, isHandAtChin, isHandsOnEars, isShush, handOnHead, classifyFrame, GestureStabilizer } from "../public/js/gestures.js";

/** Meme ids main.js shows for hands (public/js/config.js). Anything else shows nothing. */
const SHOWN = new Set(["point", "shaka", "thumbs_up", "thumbs_down", "rock", "heart", "steeple"]);
/** The video's labels as meme ids. */
const MEME_OF = { triangle: "steeple" };

const toPts = (arr) => arr.map(([x, y, z]) => ({ x, y, z }));
const toHands = (list) => list.map((h) => ({ landmarks: toPts(h.landmarks), worldLandmarks: toPts(h.world), canned: h.canned }));
const noCanned = (hands) => hands.map((h) => ({ ...h, canned: undefined }));

/** Mirror a hand horizontally, exactly like flipping the webcam image. */
const mirror = (h) => ({
  ...h,
  landmarks: h.landmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })),
  worldLandmarks: h.worldLandmarks.map((p) => ({ x: -p.x, y: p.y, z: p.z })),
});

// ---------------------------------------------------------------- video.mp4 ----
const video = JSON.parse(readFileSync(new URL("./fixtures/video_landmarks.json", import.meta.url)));
const W = video.imageWidth;
const H = video.imageHeight;
const samples = video.samples.map((s) => ({ ...s, hands: toHands(s.hands) }));
const predict = (hands) => classifyFrame(hands, W, H).gesture ?? "idle";

function recall(label, hands = (s) => s.hands) {
  const rel = samples.filter((s) => s.label === label && s.hands.length);
  const hit = rel.filter((s) => predict(hands(s)) === label).length;
  return { hit, n: rel.length, rate: hit / rel.length };
}

describe("reference video (GestureRecognizer landmarks + canned)", () => {
  for (const [label, min] of [
    ["point", 0.85],
    ["shaka", 0.8],
  ]) {
    it(`recognises ${label} (recall >= ${min})`, () => {
      const r = recall(label);
      assert.ok(r.n > 10, `need fixtures for ${label}`);
      assert.ok(r.rate >= min, `${label}: ${r.hit}/${r.n} = ${r.rate.toFixed(2)}`);
    });
    it(`recognises ${label} without the canned gesture too (rules-only fallback)`, () => {
      const r = recall(label, (s) => noCanned(s.hands));
      assert.ok(r.rate >= min, `${label}: ${r.hit}/${r.n} = ${r.rate.toFixed(2)}`);
    });
  }

  it("the two-hand triangle is the steeple, and never another meme", () => {
    const tri = samples.filter((s) => s.label === "triangle" && s.hands.length);
    assert.ok(tri.length > 10);
    let hit = 0;
    for (const s of tri) {
      for (const hands of [s.hands, noCanned(s.hands)]) {
        const g = predict(hands);
        assert.ok(!SHOWN.has(g) || g === "steeple", `t=${s.t}s triangle -> ${g}`);
        if (g === "steeple") hit++;
      }
    }
    // labels lag the hands by a few frames, so the first / last samples of each triangle are mid-move
    assert.ok(hit / (tri.length * 2) >= 0.7, `steeple in ${hit} of ${tri.length * 2}`);
  });

  it("steeple never shows outside the triangle", () => {
    const bad = samples.filter((s) => s.label !== "triangle" && s.label !== "idle" && predict(s.hands) === "steeple");
    assert.deepEqual(bad.map((s) => `${s.t}s ${s.label}`), []);
  });

  it("never shows the wrong meme during point / shaka", () => {
    const wrong = samples.filter((s) => {
      if (s.label !== "point" && s.label !== "shaka") return false;
      const p = predict(s.hands);
      return SHOWN.has(p) && p !== s.label;
    });
    assert.deepEqual(wrong.map((s) => `${s.t}s ${s.label}->${predict(s.hands)}`), []);
  });

  it("is mirror-invariant: flipping the image gives identical predictions", () => {
    for (const s of samples) {
      if (!s.hands.length) continue;
      assert.equal(predict(s.hands.map(mirror)), predict(s.hands), `frame t=${s.t}s`);
    }
  });

  it("is scale-invariant: hand closer/farther (scaled world coords) gives identical predictions", () => {
    const scale = (h, k) => ({ ...h, worldLandmarks: h.worldLandmarks.map((p) => ({ x: p.x * k, y: p.y * k, z: p.z * k })) });
    for (const s of samples) {
      if (!s.hands.length) continue;
      assert.equal(predict(s.hands.map((h) => scale(h, 1.7))), predict(s.hands), `frame t=${s.t}s`);
    }
  });

  it("stabilised timeline shows the original app's memes in order, with no extra events", () => {
    const stab = new GestureStabilizer(150, 400, 150);
    const shown = [];
    for (const s of samples) {
      const g = stab.update(classifyFrame(s.hands, W, H).gesture, s.t * 1000);
      const meme = SHOWN.has(g) ? g : null;
      if (meme && meme !== shown.at(-1)?.g) shown.push({ g: meme });
      if (!meme && shown.at(-1)?.g) shown.push({ g: null });
    }
    const seq = shown.filter((e) => e.g).map((e) => e.g);
    // truth: consecutive meme labels of the original app (its triangle = our steeple)
    const truthSeq = [];
    let prev = "idle";
    for (const s of samples) {
      const m = MEME_OF[s.label] ?? s.label;
      if (s.label !== prev && SHOWN.has(m)) truthSeq.push(m);
      prev = s.label;
    }
    assert.deepEqual(seq, truthSeq);
  });
});

// ---------------------------------------------------------------- HaGRID ----
const hagrid = JSON.parse(readFileSync(new URL("./fixtures/hagrid_hands.json", import.meta.url)));
const rows = hagrid.rows.map((r) => ({ ...r, hands: toHands(r.hands) }));
const group = (name) => rows.filter((r) => r.group === name);
const run = (r, hands = r.hands) => classifyFrame(hands, r.w, r.h).gesture;

describe("real HaGRID hands", () => {
  for (const [name, want] of [
    ["like", "thumbs_up"],
    ["dislike", "thumbs_down"],
  ]) {
    it(`${name} -> ${want} (with the canned gesture, and rules-only)`, () => {
      const rs = group(name);
      assert.ok(rs.length >= 6);
      for (const r of rs) {
        assert.equal(run(r), want, `canned ${r.hands[0].canned?.name}`);
        assert.equal(run(r, noCanned(r.hands)), want, "rules only");
        assert.equal(run(r, r.hands.map(mirror)), want, "mirrored");
      }
    });
  }

  it("a fist never shows a meme (never thumbs up / down), with or without the canned gesture", () => {
    const rs = group("fist");
    assert.ok(rs.length >= 6);
    for (const r of rs) {
      for (const hands of [r.hands, noCanned(r.hands), r.hands.map(mirror)]) {
        const g = run(r, hands);
        assert.ok(!SHOWN.has(g), `fist -> ${g}`);
      }
    }
  });

  it("a shaka that GestureRecognizer calls Thumb_Up is a shaka, not a thumbs up", () => {
    const rs = group("call_canned_thumb_up");
    assert.ok(rs.length >= 4);
    for (const r of rs) {
      assert.equal(r.hands[0].canned.name, "Thumb_Up");
      assert.equal(run(r), "shaka");
    }
  });

  it("a resting hand that GestureRecognizer calls Thumb_Up shows nothing", () => {
    const rs = group("no_gesture_canned_thumb_up");
    assert.ok(rs.length >= 3);
    for (const r of rs) {
      assert.equal(r.hands[0].canned.name, "Thumb_Up");
      assert.ok(!SHOWN.has(run(r)), `no_gesture -> ${run(r)}`);
    }
  });

  // Tilted thumbs: the user's "thumbs up shows nothing" case. Before the tilt-tolerant thumb test
  // these rows gave 7/12 and 8/12 (the model says "None" and the old straight-up-only rule missed them).
  for (const [name, want, min] of [
    ["like_tilted", "thumbs_up", 12],
    ["dislike_tilted", "thumbs_down", 10],
  ]) {
    it(`${name}: a thumb tilted 30-45 deg still gives ${want} (>= ${min}/12), never another meme`, () => {
      const rs = group(name);
      assert.equal(rs.length, 12);
      for (const variant of ["canned", "rules only", "mirrored"]) {
        const outs = rs.map((r) =>
          run(r, variant === "canned" ? r.hands : variant === "rules only" ? noCanned(r.hands) : r.hands.map(mirror)),
        );
        const hits = outs.filter((g) => g === want).length;
        assert.ok(hits >= min, `${variant}: ${hits}/12 ${JSON.stringify(outs)}`);
        const wrong = outs.filter((g) => SHOWN.has(g) && g !== want);
        assert.deepEqual(wrong, [], variant);
      }
    });
  }

  it("a tilted fist never shows a meme", () => {
    const rs = group("fist_tilted");
    assert.ok(rs.length >= 6);
    for (const r of rs) {
      for (const hands of [r.hands, noCanned(r.hands), r.hands.map(mirror)]) {
        const g = run(r, hands);
        assert.ok(!SHOWN.has(g), `fist at ${r.angle} deg -> ${g}`);
      }
    }
  });

  it("two thumbs down (or up) side by side, thumb tips touching, is never the heart", () => {
    // Each real hand placed in a 960x540 frame next to its mirror image, thumb tips 0-80 px apart.
    // Only hands the model labels Thumb_Up / Thumb_Down (see sameThumbs in gestures.js): two 45-deg
    // thumbs down with no model label can still read as heart at a 0-20 px gap (known, rare).
    const FW = 960;
    const FH = 540;
    const labelled = rows.filter((x) => (x.label === "dislike" || x.label === "like") && /^Thumb_/.test(x.hands[0].canned?.name ?? ""));
    assert.ok(labelled.length >= 16);
    for (const r of labelled) {
      const h = r.hands[0];
      const s = 220 / r.w;
      const place = (ox, flip) =>
        h.landmarks.map((p) => ({ x: (ox + (flip ? 1 - p.x : p.x) * r.w * s) / FW, y: (150 + p.y * r.h * s) / FH, z: p.z }));
      const one = classifyFrame([{ ...h, landmarks: place(200, false) }], FW, FH).gesture;
      for (const gap of [0, 20, 40, 80]) {
        const A = place(200, false);
        let B = place(0, true);
        const dir = Math.sign(A[4].x - A[0].x) || 1;
        const dx = (A[4].x * FW + dir * gap - B[4].x * FW) / FW;
        B = B.map((p) => ({ ...p, x: p.x + dx }));
        const world = h.worldLandmarks.map((p) => ({ x: -p.x, y: p.y, z: p.z }));
        const g = classifyFrame([{ ...h, landmarks: A }, { ...h, landmarks: B, worldLandmarks: world }], FW, FH).gesture;
        assert.notEqual(g, "heart", `${r.group} pair at ${gap} px`);
        if (one === r.expect) assert.equal(g, r.expect, `${r.group} pair at ${gap} px`);
      }
    }
  });

  it("a canned Thumb_Up/Thumb_Down is not trusted on its own: a fist labelled Thumb_Up stays a fist", () => {
    for (const r of group("fist")) {
      for (const name of ["Thumb_Up", "Thumb_Down"]) {
        const hands = r.hands.map((h) => ({ ...h, canned: { name, score: 0.7 } }));
        const g = run(r, hands);
        assert.ok(g !== "thumbs_up" && g !== "thumbs_down", `fist + canned ${name} -> ${g}`);
      }
    }
  });
});

describe("hand on head (Head.png)", () => {
  // face: x 0.40-0.60, forehead y 0.30, eyebrows y 0.38, chin y 0.62 (on a 1280x720 frame)
  const face = { left: 0.4, right: 0.6, top: 0.3, brow: 0.38, chin: 0.62 };
  const hand = (cx, cy) => ({ landmarks: Array.from({ length: 21 }, (_, i) => ({ x: cx + ((i % 5) - 2) * 0.01, y: cy + (Math.floor(i / 5) - 2) * 0.012, z: 0 })) });
  it("a hand on top of / at the side of the head", () => {
    assert.equal(handOnHead([hand(0.5, 0.2)], face, 1280, 720), true); // on top
    assert.equal(handOnHead([hand(0.62, 0.32)], face, 1280, 720), true); // at the side, at forehead height
  });
  it("not hands on the cheeks or cupping the face (palm below the brows), even with fingertips at the temples", () => {
    const cheek = (cx) => ({ landmarks: Array.from({ length: 21 }, (_, i) => {
      // palm at cheek height (y 0.50), fingers reaching up to the temples (y 0.30)
      const finger = i >= 5 && i % 4 === 0;
      return { x: cx + ((i % 5) - 2) * 0.008, y: finger ? 0.3 : 0.5 + (Math.floor(i / 5) - 2) * 0.01, z: 0 };
    }) });
    assert.equal(handOnHead([cheek(0.41), cheek(0.59)], face, 1280, 720), false);
  });

  it("not a hand at the chest, beside the shoulders or far above", () => {
    assert.equal(handOnHead([hand(0.5, 0.8)], face, 1280, 720), false);
    assert.equal(handOnHead([hand(0.85, 0.3)], face, 1280, 720), false);
    assert.equal(handOnHead([hand(0.5, 0.0)], { ...face, top: 0.55, brow: 0.6, chin: 0.85 }, 1280, 720), false);
    assert.equal(handOnHead([], face, 1280, 720), false);
    assert.equal(handOnHead([hand(0.5, 0.2)], null, 1280, 720), false);
  });
});


describe("shush / hand at chin / flex (thresholds from real photos; see POSES in gestures.js)", () => {
  const W = 1280;
  const H = 720;
  // face 205 px wide, forehead y 180, chin y 432; mouth (640, 382), chin point (640, 432)
  const face = { left: 0.42, right: 0.58, top: 0.25, brow: 0.32, chin: 0.6, mouth: { x: 0.5, y: 0.53 }, chinPt: { x: 0.5, y: 0.6 } };
  /** hand features with the palm centred at (cx, cy) px; fingers: which are straight; up: knuckles above the wrist */
  const hand = (cx, cy, fingers = [], { s = 70, up = true, tip = null } = {}) => {
    const dir = up ? -1 : 1;
    const px = Array.from({ length: 21 }, () => ({ x: cx, y: cy }));
    px[0] = { x: cx, y: cy - dir * 0.8 * s };
    [5, 9, 13, 17].forEach((k, i) => (px[k] = { x: cx + (i - 1.5) * 0.3 * s, y: cy + dir * 0.2 * s }));
    [8, 12, 16, 20].forEach((k, i) => (px[k] = { x: cx + (i - 1.5) * 0.3 * s, y: cy + dir * 0.4 * s }));
    if (fingers.includes("index")) px[8] = tip ?? { x: px[5].x, y: cy + dir * 1.2 * s };
    const ext = { index: 0.5, middle: 0.5, ring: 0.5, pinky: 0.5 };
    for (const f of fingers) ext[f] = 0.95;
    return { px, ext, palmPx: s };
  };

  it("shush: index finger up with its tip on the lips", () => {
    assert.equal(isShush([hand(620, 470, ["index"], { tip: { x: 640, y: 385 } })], face, W, H), true);
  });
  it("not a shush: a point beside the face, an open hand at the mouth, no face", () => {
    assert.equal(isShush([hand(800, 300, ["index"], { tip: { x: 800, y: 170 } })], face, W, H), false);
    assert.equal(isShush([hand(620, 470, ["index", "middle", "ring", "pinky"], { tip: { x: 640, y: 385 } })], face, W, H), false);
    assert.equal(isShush([hand(620, 470, ["index"], { tip: { x: 640, y: 385 } })], null, W, H), false);
  });
  it("hand at the chin; not at the chest or beside the head", () => {
    assert.equal(isHandAtChin([hand(650, 450)], face, W, H), true);
    assert.equal(isHandAtChin([hand(650, 650)], face, W, H), false);
    assert.equal(isHandAtChin([hand(900, 300)], face, W, H), false);
  });
  it("flex: two upright fists far apart at the same height", () => {
    assert.equal(isFlex([hand(300, 250), hand(980, 260)]), true);
  });
  it("not a flex: fists close together (boxing guard), hanging fists, one fist, open hands", () => {
    assert.equal(isFlex([hand(560, 400), hand(720, 400)]), false);
    assert.equal(isFlex([hand(300, 600, [], { up: false }), hand(980, 600, [], { up: false })]), false);
    assert.equal(isFlex([hand(300, 250)]), false);
    const all = ["index", "middle", "ring", "pinky"];
    assert.equal(isFlex([hand(300, 250, all), hand(980, 260, all)]), false);
  });
});

describe("both hands on the ears (scream, with the mouth open)", () => {
  const W = 1280;
  const H = 720;
  const face = { left: 0.42, right: 0.58, earL: { x: 0.42, y: 0.45 }, earR: { x: 0.58, y: 0.45 } };
  const fist = (cx, cy, s = 60) => {
    const px = Array.from({ length: 21 }, () => ({ x: cx, y: cy }));
    px[0] = { x: cx, y: cy + 0.8 * s };
    [5, 9, 13, 17].forEach((k, i) => (px[k] = { x: cx + (i - 1.5) * 0.3 * s, y: cy - 0.2 * s }));
    return { px, ext: { index: 0.5, middle: 0.5, ring: 0.5, pinky: 0.5 }, palmPx: s };
  };
  it("one hand at each ear", () => {
    assert.equal(isHandsOnEars([fist(0.41 * W, 0.45 * H), fist(0.59 * W, 0.45 * H)], face, W, H), true);
  });
  it("not one ear only, both hands at the same ear, hands far away, or no face", () => {
    assert.equal(isHandsOnEars([fist(0.41 * W, 0.45 * H)], face, W, H), false);
    assert.equal(isHandsOnEars([fist(0.41 * W, 0.45 * H), fist(0.40 * W, 0.5 * H)], face, W, H), false);
    assert.equal(isHandsOnEars([fist(0.1 * W, 0.45 * H), fist(0.9 * W, 0.45 * H)], face, W, H), false);
    assert.equal(isHandsOnEars([fist(0.41 * W, 0.45 * H), fist(0.59 * W, 0.45 * H)], null, W, H), false);
  });
});
