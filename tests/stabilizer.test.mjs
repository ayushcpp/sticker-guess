// Run: node --test tests/stabilizer.test.mjs
// The debouncers that keep the meme quick but steady (public/js/stabilizer.js),
// tested with the app's own timings (config.js STABILIZER) on simulated
// camera streams at 30 fps (a normal laptop) and 8 fps (a slow one).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STABILIZER } from "../public/js/config.js";
import { GestureStabilizer, PriorityStabilizer } from "../public/js/stabilizer.js";

const { enterMs, exitMs, gapMs, minShowMs } = STABILIZER;
const app = () => new GestureStabilizer(enterMs, exitMs, gapMs, { minShowMs });

/** deterministic pseudo-random numbers */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * Feeds [label, durationMs] segments frame by frame at `fps`.
 * A label can be a function (frameIndex) => label, for noisy streams.
 * Returns every frame's {t, raw, shown}.
 */
function feed(update, segments, fps = 30, t0 = 0) {
  const step = 1000 / fps;
  const out = [];
  let t = t0;
  let n = 0;
  for (const [g, ms] of segments) {
    const end = t + ms;
    for (; t < end - 1e-9; t += step, n++) {
      const raw = typeof g === "function" ? g(n) : g;
      out.push({ t, raw, shown: update(raw, t) });
    }
  }
  return { out, t, last: out.at(-1)?.shown };
}
const run = (s, segments, fps, t0) => feed((g, t) => s.update(g, t), segments, fps, t0);
/** Number of times the shown output changes. */
const changes = (out) => out.filter((o, i) => i && o.shown !== out[i - 1].shown).length;
/** ms from `from` until the output first equals `g` (Infinity if never). */
const latency = (out, g, from) => (out.find((o) => o.t >= from && o.shown === g)?.t ?? Infinity) - from;

describe("app timings (config.js STABILIZER)", () => {
  it("are fast enough to feel instant and keep the documented meaning", () => {
    assert.ok(enterMs <= 150, `enterMs ${enterMs}`);
    assert.ok(exitMs >= 400 && exitMs <= 700, `exitMs ${exitMs}`);
    assert.ok(minShowMs <= 1000, `minShowMs ${minShowMs}`);
  });
});

describe("appearing fast", () => {
  it("30 fps: a steady gesture shows within enterMs + 1 frame (<= 160 ms of frames)", () => {
    const s = app();
    const r = run(s, [[null, 1000], ["thumbs_up", 1000]]);
    const lat = latency(r.out, "thumbs_up", 1000);
    assert.ok(lat >= enterMs - 1 && lat <= enterMs + 1000 / 30, `latency ${lat.toFixed(0)} ms`);
    assert.ok(lat <= 160, `latency ${lat.toFixed(0)} ms`);
  });

  it("8 fps: shows on the 3rd frame (250 ms); 5 fps: on the 3rd frame (400 ms)", () => {
    for (const [fps, max] of [[8, 251], [5, 401]]) {
      const s = app();
      const r = run(s, [[null, 1000], ["thumbs_down", 2000]], fps);
      const lat = latency(r.out, "thumbs_down", 1000);
      assert.ok(lat <= max, `${fps} fps: latency ${lat.toFixed(0)} ms`);
      assert.equal(changes(r.out), 1, `${fps} fps: one clean appearance`);
    }
  });

  it("a weak classifier that catches the gesture in only 2 of 3 frames still shows it, steadily", () => {
    const s = app();
    const r = run(s, [[null, 500], [(n) => (n % 3 ? "thumbs_up" : null), 3000]]);
    assert.ok(latency(r.out, "thumbs_up", 500) <= 250);
    assert.equal(changes(r.out), 1, "no blinking while held");
  });

  it("a face expression held briefly (a 600 ms scream) still shows", () => {
    const s = app();
    const r = run(s, [[null, 500], ["scream", 600], [null, 2000]]);
    assert.ok(latency(r.out, "scream", 500) <= enterMs + 34);
    assert.equal(r.last, null);
  });
});

describe("switching fast", () => {
  for (const fps of [30, 8]) {
    it(`${fps} fps: A -> B replaces the meme as soon as B is confirmed (no minimum-show wait)`, () => {
      const s = app();
      let r = run(s, [["thumbs_up", 300]], fps); // A only just appeared
      assert.equal(r.last, "thumbs_up");
      const from = r.t;
      r = run(s, [["thumbs_down", 1500]], fps, r.t);
      const lat = latency(r.out, "thumbs_down", from);
      assert.ok(lat <= (fps === 30 ? enterMs + 34 : 251), `switch latency ${lat.toFixed(0)} ms`);
      assert.equal(changes(r.out), 1, "straight from A to B, never through 'nothing'");
    });

    it(`${fps} fps: A -> (hand moving, 200 ms unrecognised) -> B never blanks the box`, () => {
      const s = app();
      let r = run(s, [["peace", 1000]], fps);
      r = run(s, [[null, 200], ["rock", 1500]], fps, r.t);
      assert.deepEqual([...new Set(r.out.map((o) => o.shown))], ["peace", "rock"]);
      const from = r.out.find((o) => o.raw === "rock").t;
      assert.ok(latency(r.out, "rock", from) <= (fps === 30 ? enterMs + 34 : 251));
    });
  }

  it("in a 2:1 mix of two labels the majority wins, and the output changes once", () => {
    const s = app();
    const r = run(s, [[(n) => (n % 3 === 0 ? "peace" : "point"), 2000]]);
    assert.equal(r.last, "point");
    assert.ok(changes(r.out) <= 1, `changed ${changes(r.out)} times`);
  });
});

describe("no flicker", () => {
  for (const fps of [30, 8]) {
    it(`${fps} fps: one or two frames of a wrong label never change the shown meme`, () => {
      const s = app();
      let r = run(s, [["point", 1000]], fps);
      const f = 1000 / fps;
      for (const [g, k] of [["peace", 1], ["peace", 2], ["thumbs_up", 1], ["rock", 2], [null, 1], [null, 2]]) {
        r = run(s, [[g, k * f], ["point", 600]], fps, r.t);
        assert.deepEqual([...new Set(r.out.map((o) => o.shown))], ["point"], `${k} frame(s) of ${g}`);
      }
    });

    it(`${fps} fps: tracking dropouts shorter than exitMs never hide the meme`, () => {
      const s = app();
      let r = run(s, [["thumbs_up", 1000]], fps);
      for (const ms of [100, 200, 300, exitMs - 1000 / fps - 1]) {
        r = run(s, [[null, ms], ["thumbs_up", 500]], fps, r.t);
        assert.deepEqual([...new Set(r.out.map((o) => o.shown))], ["thumbs_up"], `${ms} ms dropout`);
      }
    });

    it(`${fps} fps: a gesture with 25% dropped frames and 10% wrong labels shows once, steadily`, () => {
      const rand = rng(fps);
      const noisy = () => {
        const x = rand();
        return x < 0.25 ? null : x < 0.35 ? "peace" : "shaka";
      };
      const s = app();
      const r = run(s, [[null, 1000], [noisy, 4000], [null, 1500]], fps);
      assert.deepEqual(
        r.out.filter((o, i) => i && o.shown !== r.out[i - 1].shown).map((o) => o.shown),
        ["shaka", null],
      );
    });
  }

  it("random one- and two-frame misdetections while idle never show a meme", () => {
    const rand = rng(7);
    const ids = ["point", "peace", "thumbs_up", "rock", "shaka"];
    let burst = 0;
    let label = null;
    const noise = () => {
      if (burst > 0) {
        burst--;
        return label;
      }
      if (rand() < 0.15) {
        label = ids[Math.floor(rand() * ids.length)];
        burst = rand() < 0.5 ? 0 : 1; // 1 or 2 frames
        return label;
      }
      return null;
    };
    for (const fps of [30, 8]) {
      const s = app();
      const r = run(s, [[noise, 20000]], fps);
      assert.deepEqual([...new Set(r.out.map((o) => o.shown))], [null], `${fps} fps`);
    }
  });

  it("a meme stays up at least minShowMs, even for a gesture that vanished right after it showed", () => {
    const s = app();
    const r = run(s, [["rock", enterMs + 40], [null, 2000]]);
    const on = r.out.find((o) => o.shown === "rock").t;
    const off = r.out.find((o) => o.t > on && o.shown === null).t;
    assert.ok(off - on >= minShowMs, `shown for ${(off - on).toFixed(0)} ms`);
  });
});

describe("going away", () => {
  for (const fps of [30, 8]) {
    it(`${fps} fps: hides after exitMs of no gesture (not before, and not much later)`, () => {
      const s = app();
      let r = run(s, [["shaka", 1500]], fps);
      const from = r.t;
      r = run(s, [[null, 2000]], fps, r.t);
      const lat = latency(r.out, null, from);
      assert.ok(lat >= exitMs - 1000 / fps && lat <= exitMs + 1000 / fps + 1, `hid after ${lat.toFixed(0)} ms`);
      assert.equal(changes(r.out), 1);
    });
  }

  it("a shown gesture that only reappears now and then (1 frame in 9) is dropped", () => {
    const s = app();
    let r = run(s, [["point", 1000]]);
    r = run(s, [[(n) => (n % 9 === 0 ? "point" : null), 3000]], 30, r.t);
    assert.equal(r.last, null);
  });

  it("copes with a clock that jumps backwards (camera restarted)", () => {
    const s = app();
    run(s, [["peace", 1000]], 30, 50000);
    const r = run(s, [[null, 100], ["rock", 600]], 30, 0);
    assert.equal(r.last, "rock");
  });
});

describe("GestureStabilizer(enterMs, exitMs, gapMs) parameter meaning (150, 400, 150)", () => {
  it("waits enterMs before showing a new gesture", () => {
    const s = new GestureStabilizer(150, 400, 150);
    assert.equal(run(s, [["point", 140]]).last, null);
    assert.equal(run(s, [["point", 60]], 30, 140).last, "point");
  });

  it("waits exitMs of no-gesture before going back to idle", () => {
    const s = new GestureStabilizer(150, 400, 150);
    let r = run(s, [["shaka", 300]]);
    assert.equal(r.last, "shaka");
    r = run(s, [[null, 380]], 30, r.t);
    assert.equal(r.last, "shaka");
    r = run(s, [[null, 60]], 30, r.t);
    assert.equal(r.last, null);
  });

  it("dropouts up to gapMs keep a pending gesture's progress; longer ones restart it", () => {
    // 100 ms lost mid-way: the dropped frames only count as frames without the
    // gesture (it must be in 70% of the frames), so it shows ~300 ms after it started...
    let s = new GestureStabilizer(150, 400, 150);
    assert.equal(run(s, [["heart", 70], [null, 100], ["heart", 140]]).last, "heart");
    s = new GestureStabilizer(150, 400, 150);
    let r = run(s, [["heart", 100], [null, 250]]);
    r = run(s, [["heart", 120]], 30, r.t);
    assert.equal(r.last, null, "old progress must not carry over");
    r = run(s, [["heart", 60]], 30, r.t);
    assert.equal(r.last, "heart");
  });
});

describe("PriorityStabilizer (hand > face, debounced separately)", () => {
  const FRAME = 1000 / 30;
  const prio = () => new PriorityStabilizer(enterMs, exitMs, gapMs, { minShowMs });

  it("a held smile does not block a two-hand gesture with dropouts", () => {
    const s = prio();
    let t = 0;
    let out;
    for (; t < 600; t += FRAME) out = s.update(null, "smile", t);
    assert.equal(out, "smile");
    // heart seen, but lost 1 frame in every 6 (2nd hand flickers)
    const seen = [];
    for (let i = 0; i < 30; i++, t += FRAME) seen.push(s.update(i % 6 === 5 ? null : "heart", "smile", t));
    assert.equal(seen.at(-1), "heart");
    assert.equal(seen.filter((g, i) => i && g !== seen[i - 1]).length, 1, "smile -> heart once");
  });

  it("hand gesture stays up through dropouts even while a face trigger is active", () => {
    const s = prio();
    let t = 0;
    for (; t < 400; t += FRAME) s.update("point", "kiss", t);
    const outs = [];
    for (let i = 0; i < 40; i++, t += FRAME) outs.push(s.update(i % 4 === 0 ? null : "point", "kiss", t));
    assert.deepEqual([...new Set(outs)], ["point"]);
  });

  it("falls back to the face trigger when the hand gesture ends, then to nothing", () => {
    const s = prio();
    let t = 0;
    let out;
    for (; t < 400; t += FRAME) out = s.update("shaka", "closeup", t);
    assert.equal(out, "shaka");
    for (; t < 1200; t += FRAME) out = s.update(null, "closeup", t);
    assert.equal(out, "closeup");
    for (; t < 2200; t += FRAME) out = s.update(null, null, t);
    assert.equal(out, null);
  });

  it("a face meme that is on its way out does not flash up when the hand meme ends", () => {
    const s = prio();
    let t = 0;
    const outs = [];
    // peace held while smiling; the smile stops 150 ms before the hand goes down
    for (; t < 1500; t += FRAME) outs.push(s.update("peace", "smile", t));
    for (; t < 1650; t += FRAME) outs.push(s.update("peace", null, t));
    for (; t < 3000; t += FRAME) outs.push(s.update(null, null, t));
    assert.deepEqual(outs.filter((g, i) => i && g !== outs[i - 1]), ["peace", null]);
  });

  it("when the hand meme ends and the face trigger is still there, its meme shows right away", () => {
    const s = prio();
    let t = 0;
    for (; t < 1500; t += FRAME) s.update("peace", "smile", t);
    const outs = [];
    for (; t < 3000; t += FRAME) outs.push(s.update(null, "smile", t));
    assert.deepEqual([...new Set(outs)], ["peace", "smile"], "straight from peace to smile");
  });

  for (const fps of [30, 8]) {
    const F = 1000 / fps;
    it(`${fps} fps: hand leaves the picture while a face trigger is held -> face meme after gapMs, not exitMs`, () => {
      const s = prio();
      let t = 0;
      for (; t < 1500; t += F) s.update("thumbs_up", "scream", t, true);
      assert.equal(s.current, "thumbs_up");
      const gone = t;
      let at = null;
      for (; t < 3000; t += F) if (s.update(null, "scream", t, false) === "scream" && at === null) at = t;
      const lat = at - gone;
      // 30 fps: gapMs; 8 fps: 3 frames (the 2nd lost frame is only 125 ms after the 1st)
      assert.ok(lat >= gapMs - 1 && lat <= Math.max(gapMs, 2 * F) + F + 1, `hand -> face in ${lat.toFixed(0)} ms`);
      assert.ok(lat < exitMs, "faster than waiting out the hand meme");
    });

    it(`${fps} fps: the same with a face that starts screaming only as the hand goes`, () => {
      const s = prio();
      let t = 0;
      for (; t < 1500; t += F) s.update("thumbs_up", null, t, true);
      const gone = t;
      const outs = [];
      for (; t < 3000; t += F) outs.push({ t, g: s.update(null, "scream", t, false) });
      const at = outs.find((o) => o.g === "scream").t - gone;
      assert.ok(at <= Math.max(gapMs, enterMs, 2 * F) + F + 1, `${at.toFixed(0)} ms`);
      assert.deepEqual([...new Set(outs.map((o) => o.g))], ["thumbs_up", "scream"], "never through nothing");
    });
  }

  it("a hand still in view but unrecognised keeps its meme (no hand <-> face flip-flop while smiling)", () => {
    const s = prio();
    let t = 0;
    for (; t < 1000; t += FRAME) s.update("thumbs_up", "smile", t, true);
    const outs = [];
    // the thumb tilts: recognised in bursts, gaps of up to 400 ms, hand always in view
    for (const [g, ms] of [[null, 300], ["thumbs_up", 200], [null, 400], ["thumbs_up", 300], [null, 250], ["thumbs_up", 300]]) {
      for (const end = t + ms; t < end; t += FRAME) outs.push(s.update(g, "smile", t, true));
    }
    assert.deepEqual([...new Set(outs)], ["thumbs_up"]);
    // ...and when it stays unrecognised, the smile meme follows after exitMs as before
    const from = t;
    let at = null;
    for (; t < from + 1500; t += FRAME) if (s.update(null, "smile", t, true) === "smile" && at === null) at = t;
    assert.ok(at - from >= exitMs - FRAME && at - from <= exitMs + 2 * FRAME, `${(at - from).toFixed(0)} ms`);
  });

  it("hand-tracking dropouts shorter than gapMs (no hand at all) never hand over to the face meme", () => {
    const rand = rng(11);
    const s = prio();
    let t = 0;
    for (; t < 1000; t += FRAME) s.update("peace", "smile", t, true);
    const outs = [];
    for (let k = 0; k < 40; k++) {
      const lost = 1 + Math.floor(rand() * 5); // 1-5 frames = up to 167 ms
      for (let i = 0; i < lost; i++, t += FRAME) outs.push(s.update(null, "smile", t, false));
      for (let i = 0; i < 6; i++, t += FRAME) outs.push(s.update("peace", "smile", t, true));
    }
    assert.deepEqual([...new Set(outs)], ["peace"]);
  });

  it("after the hand-over a returning hand gesture must be confirmed again (no one-frame flash back)", () => {
    const s = prio();
    let t = 0;
    for (; t < 1000; t += FRAME) s.update("rock", "smile", t, true);
    for (const end = t + gapMs + 2 * FRAME; t < end; t += FRAME) s.update(null, "smile", t, false);
    assert.equal(s.current, "smile");
    // one stray frame of the gesture does not bring the hand meme back
    const outs = [s.update("rock", "smile", t, true)];
    t += FRAME;
    for (const end = t + 300; t < end; t += FRAME) outs.push(s.update(null, "smile", t, true));
    assert.deepEqual([...new Set(outs)], ["smile"]);
    // held again: it replaces the face meme within enterMs
    const from = t;
    let at = null;
    for (; t < from + 600; t += FRAME) if (s.update("rock", "smile", t, true) === "rock" && at === null) at = t;
    assert.ok(at - from <= enterMs + FRAME, `${(at - from).toFixed(0)} ms`);
  });

  it("no hand-over to a face meme that is on its way out (the hand meme then leaves after exitMs)", () => {
    const s = prio();
    let t = 0;
    for (; t < 1500; t += FRAME) s.update("point", "kiss", t, true);
    const outs = [];
    for (const end = t + 2000; t < end; t += FRAME) outs.push(s.update(null, null, t, false));
    assert.deepEqual(outs.filter((g, i) => i && g !== outs[i - 1]), [null]);
    assert.equal(outs[0], "point");
  });

  it("a hand gesture replaces a face meme within enterMs", () => {
    const s = prio();
    let t = 0;
    for (; t < 800; t += FRAME) s.update(null, "scream", t);
    const from = t;
    let shownAt = null;
    for (; t < 1600; t += FRAME) if (s.update("thumbs_up", "scream", t) === "thumbs_up" && shownAt === null) shownAt = t;
    assert.ok(shownAt - from <= enterMs + FRAME, `${(shownAt - from).toFixed(0)} ms`);
  });
});
