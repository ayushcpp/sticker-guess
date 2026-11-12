// Meme hunt: accuracy per target (targetScore) and the stage machine (MemeHunt).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GAME } from "../public/js/config.js";
import { EXPRESSION_THRESHOLDS as T, HEAD_POSE } from "../public/js/face.js";
import { GAME_DEFAULTS, MemeHunt, PASS, targetScore } from "../public/js/game.js";
import { MEMES } from "../public/js/config.js";

const face = (over = {}) => ({ jaw: 0.02, smile: 0.05, lowerLip: 0, upperLip: 0, ...over });

describe("targetScore: 60% is exactly where the detector recognises the target", () => {
  it("hand: 0 unless the gesture is detected, then 60% + the model's own confidence", () => {
    assert.equal(targetScore("thumbs_up", { gesture: "peace", canned: [{ name: "Victory", score: 0.9 }] }), 0);
    assert.equal(targetScore("thumbs_up", { gesture: null }), 0);
    const s = targetScore("thumbs_up", { gesture: "thumbs_up", canned: [{ name: "Thumb_Up", score: 0.75 }] });
    assert.ok(Math.abs(s - (PASS + 0.04 + 0.36 * 0.75)) < 1e-9, String(s));
    // rule-only gestures (no model label) count as fully confident
    assert.equal(targetScore("shaka", { gesture: "shaka", canned: [{ name: "Thumb_Up", score: 0.8 }] }), 1);
    assert.equal(targetScore("heart", { gesture: "heart", canned: [undefined, undefined] }), 1);
  });

  it("smile: partial credit below the threshold, never 60% unless detected", () => {
    const half = targetScore("smile", { signals: face({ smile: T.smile / 2 }), expression: null });
    assert.ok(Math.abs(half - PASS / 2) < 1e-9);
    // a big open-mouth smile is a laugh, not the closed-mouth smile meme: stays below the pass mark
    const open = targetScore("smile", { signals: face({ smile: 0.9, jaw: 0.4 }), expression: "laugh" });
    assert.ok(open < PASS && open > 0.55, String(open));
    assert.ok(targetScore("smile", { signals: face({ smile: T.smile }), expression: "smile" }) >= PASS);
    assert.equal(targetScore("smile", { signals: face({ smile: 0.95 }), expression: "smile" }) > 0.95, true);
    assert.equal(targetScore("smile", { signals: null, expression: null }), 0);
  });

  it("laugh needs both the smile and the open mouth", () => {
    const smileOnly = targetScore("laugh", { signals: face({ smile: 0.8, jaw: 0.05 }), expression: "smile" });
    assert.ok(smileOnly < PASS * 0.3, String(smileOnly));
    assert.ok(targetScore("laugh", { signals: face({ smile: 0.7, jaw: 0.35 }), expression: "laugh" }) >= PASS);
  });

  it("scream follows how far the mouth is open", () => {
    const a = targetScore("scream", { signals: face({ jaw: 0.2 }), expression: null });
    const b = targetScore("scream", { signals: face({ jaw: 0.4 }), expression: null });
    assert.ok(a < b && b < PASS);
    assert.ok(targetScore("scream", { signals: face({ jaw: 0.7 }), expression: "scream" }) >= PASS);
  });

  it("head: degrees from the usual pose against the enter angle", () => {
    const nearly = targetScore("side_eye", { head: { active: null, side: HEAD_POSE.sideEnter * 0.9, down: 0 } });
    assert.ok(Math.abs(nearly - PASS * 0.9) < 1e-9);
    assert.ok(targetScore("look_down", { head: { active: "look_down", side: 0, down: HEAD_POSE.downEnter + 5 } }) > PASS);
    // tilting down doesn't score side-eye
    assert.equal(targetScore("side_eye", { head: { active: "look_down", side: 0, down: 30 } }), 0);
    assert.equal(targetScore("look_down", { head: null }), 0);
  });

  it("close-up: nothing until leaning in, nothing while the usual face size is being learned", () => {
    assert.equal(targetScore("closeup", { closeup: { active: false, width: 0.25, enter: 0.35 } }), 0);
    const leaning = targetScore("closeup", { closeup: { active: false, width: 0.3, enter: 0.35 } });
    assert.ok(leaning > 0 && leaning < PASS);
    assert.ok(targetScore("closeup", { closeup: { active: true, width: 0.36, enter: 0.35 } }) >= PASS);
    assert.equal(targetScore("closeup", { closeup: { active: false, width: 0.5, enter: undefined } }), 0);
  });

  it("every configured meme has a scorer and a place in the order", () => {
    for (const m of MEMES) {
      assert.ok(GAME.order.includes(m.id), `${m.id} missing from GAME.order`);
      assert.ok(m.hint, `${m.id} has no hint`);
    }
  });
});

describe("MemeHunt", () => {
  // Feeds `score` every 33 ms for `ms`; returns the snapshots.
  const feed = (g, score, ms, clock) => {
    const out = [];
    for (const end = clock.t + ms; clock.t < end; clock.t += 33) out.push(g.update(score, clock.t));
    return out;
  };

  it("passes after holding >= 60% for holdMs, shows found, then moves to the next meme", () => {
    const g = new MemeHunt(["a", "b"]);
    const c = { t: 1000 };
    assert.equal(feed(g, 0.3, 1000, c).at(-1).phase, "play");
    const snaps = feed(g, 0.9, 1000, c);
    const foundAt = snaps.findIndex((s) => s.phase === "found");
    assert.ok(foundAt > 0, "never found");
    const ms = foundAt * 33;
    assert.ok(ms >= GAME_DEFAULTS.holdMs && ms <= GAME_DEFAULTS.holdMs + 250, `found after ${ms} ms`);
    const after = feed(g, 0, GAME_DEFAULTS.foundMs + 100, c).at(-1);
    assert.equal(after.phase, "play");
    assert.equal(after.target, "b");
    assert.equal(after.index, 1);
    assert.ok(after.score < 0.05, "score restarts for the new meme");
  });

  it("the new meme starts at 0%: the frame that ends 'found' was scored for the old meme", () => {
    const g = new MemeHunt(["a", "b"]);
    const c = { t: 0 };
    feed(g, 1, 700, c);
    const snaps = feed(g, 0.95, GAME_DEFAULTS.foundMs + 100, c); // still scored for "a"
    const first = snaps.find((s) => s.target === "b");
    assert.equal(first.score, 0);
  });

  it("a pose detected right at the detector's threshold still passes (review: it stalled at 59.99%)", () => {
    // scream through the lower-lip path: jaw below heldJaw, so no "how far past" strength at all
    const raw = targetScore("scream", { signals: face({ jaw: 0.29, lowerLip: 0.87 }), expression: "scream" });
    assert.ok(raw > PASS, String(raw));
    for (const fps of [30, 15, 8]) {
      const g = new MemeHunt(["scream"]);
      const c = { t: 0 };
      const step = 1000 / fps;
      for (const end = c.t + 1000; c.t < end; c.t += step) g.update(0.4, c.t);
      let found = null;
      for (const end = c.t + 3000; c.t < end && !found; c.t += step) if (g.update(raw, c.t).phase === "found") found = c.t;
      assert.ok(found != null && found - 1000 <= GAME_DEFAULTS.holdMs + 2 * step, `${fps} fps: ${found}`);
    }
  });

  it("a missed frame or two doesn't restart the hold", () => {
    const g = new MemeHunt(["a"]);
    const c = { t: 0 };
    const pattern = [1, 1, 0, 1, 0, 0, 1, 1, 1, 0]; // 30 fps, gaps of up to 2 frames
    let found = null;
    for (let i = 0; i < 60 && !found; i++, c.t += 33) if (g.update(pattern[i % 10], c.t).phase === "found") found = c.t;
    assert.ok(found != null && found <= GAME_DEFAULTS.holdMs + 100, String(found));
  });

  it("retain() drops the memes that can't be found any more, keeping progress", () => {
    const g = new MemeHunt(["a", "smile", "b", "laugh"]);
    const c = { t: 0 };
    feed(g, 1, 700, c);
    feed(g, 0, GAME_DEFAULTS.foundMs + 100, c); // a found, now on smile
    g.retain((id) => id === "a" || id === "b");
    const s = g.update(0, c.t);
    assert.deepEqual([s.target, s.index, s.total], ["b", 1, 2]);
    g.retain(() => false); // nothing left to find
    assert.equal(g.update(0, c.t + 33).phase, "won");
  });

  it("a flicker above 60% doesn't pass", () => {
    const g = new MemeHunt(["a"]);
    const c = { t: 0 };
    for (let i = 0; i < 40; i++) {
      feed(g, 1, 100, c); // 0.1 s detected
      feed(g, 0, 300, c); // 0.3 s not
    }
    assert.equal(g.phase, "play");
  });

  it("the hint appears after hintAfterMs on one meme, and resets on the next", () => {
    const g = new MemeHunt(["a", "b"]);
    const c = { t: 0 };
    assert.equal(feed(g, 0, GAME_DEFAULTS.hintAfterMs - 100, c).at(-1).hint, false);
    assert.equal(feed(g, 0, 200, c).at(-1).hint, true);
    feed(g, 1, 700, c);
    const next = feed(g, 0, GAME_DEFAULTS.foundMs + 100, c).at(-1);
    assert.equal(next.target, "b");
    assert.equal(next.hint, false);
  });

  it("wins after the last meme, and restart() starts over", () => {
    const g = new MemeHunt(["a", "b"]);
    const c = { t: 0 };
    for (let i = 0; i < 2; i++) {
      feed(g, 1, 700, c);
      feed(g, 0, GAME_DEFAULTS.foundMs + 100, c);
    }
    const s = g.update(1, c.t);
    assert.equal(s.phase, "won");
    assert.equal(s.target, null);
    assert.equal(s.total, 2);
    g.restart();
    assert.equal(g.update(0, c.t + 33).target, "a");
  });

  it("pausedFor(): a pause (the captcha) doesn't bring the hint early or finish a hold", () => {
    const g = new MemeHunt(["a", "b"]);
    const c = { t: 0 };
    feed(g, 0, 5000, c); // 5 s on the stage, no hint yet
    feed(g, 1, 200, c); // half a hold
    const pause = 60000;
    g.pausedFor(pause);
    c.t += pause;
    const s = g.update(1, c.t);
    assert.equal(s.hint, false, "the hint is still 3 s away");
    assert.equal(s.phase, "play", "the hold starts again after the pause");
    const later = feed(g, 1, GAME_DEFAULTS.holdMs + 100, c).at(-1);
    assert.equal(later.phase, "found");
  });

  it("no memes -> won straight away (nothing to find)", () => {
    assert.equal(new MemeHunt([]).update(0, 0).phase, "won");
  });
});
