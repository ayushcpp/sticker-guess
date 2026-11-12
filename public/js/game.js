/**
 * Meme hunt: the target meme is shown in a corner, the player makes the face / action that triggers
 * it, and at >= 60% "accuracy" held for a moment the next meme comes up.
 *
 * Accuracy is not a picture comparison (a hamster drawing can't be matched to a human face). It is
 * how strongly the app's own detectors see the target action, scaled so that 60% is exactly where
 * the detector recognises it (the same detection that pops the meme up in the meme box):
 *   not detected:  0..59%  = how close the signal is to the detector's threshold
 *   detected:     60..100% = how far past the threshold it is
 *
 * Pure functions + one small state machine; no DOM, so it's unit-testable (tests/game.test.mjs).
 */
import { EXPRESSION_THRESHOLDS, HEAD_POSE } from "./face.js";

export const PASS = 0.6;

/** GestureRecognizer's own label for the hand memes it knows (its score is used as strength). */
const CANNED = { point: "Pointing_Up", peace: "Victory", thumbs_up: "Thumb_Up", thumbs_down: "Thumb_Down" };

const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);
/** Not detected: partial credit up to just under the pass mark. */
const near = (progress) => PASS * Math.min(clamp01(progress), 0.98);
/** Detected: 64% (always clearly past the mark, even right at the detector's threshold) up to 100%. */
const past = (strength) => PASS + 0.04 + (1 - PASS - 0.04) * clamp01(strength);

/**
 * Accuracy 0..1 for one target in the current frame.
 * @param {string} target meme id
 * @param {object} d this frame's detections (all optional):
 *   gesture   hand gesture id from classifyFrame (raw, this frame)
 *   canned    [{name, score}] GestureRecognizer's label per hand
 *   signals   expressionSignals() of the latest face result, or null
 *   expression  ExpressionTracker result (raw, this frame)
 *   head      {active, side, down} from HeadPoseTracker (side / down: degrees from the usual pose)
 *   closeup   {active, width, enter} face width, and the close-up threshold (null while learning)
 */
export function targetScore(target, d, t = EXPRESSION_THRESHOLDS, hp = HEAD_POSE) {
  const s = d.signals;
  switch (target) {
    case "point":
    case "peace":
    case "thumbs_up":
    case "thumbs_down":
    case "shaka":
    case "rock":
    case "head":
    case "steeple":
    case "shush":
    case "hmm":
    case "flex":
    case "heart": {
      if (d.gesture !== target) return 0;
      const label = CANNED[target];
      if (!label) return 1; // rule-only gestures (shaka, rock, heart): no model score to use
      const scores = (d.canned ?? []).filter((c) => c && c.name === label).map((c) => c.score);
      return past(scores.length ? Math.max(...scores) : 1);
    }
    case "smile":
      if (!s) return 0;
      if (d.expression === "smile") return past((s.smile - t.smile) / 0.4);
      return near(s.smile / t.smile);
    case "laugh":
      if (!s) return 0;
      if (d.expression === "laugh") return past(Math.min((s.smile - t.laughSmile) / 0.4, (s.jaw - t.laughJaw) / 0.4));
      return near(Math.min(s.smile / t.laughSmile, s.jaw / t.laughJaw));
    case "scream":
      if (d.gesture === "scream") return past(1); // both hands on the ears + mouth open
      if (!s) return 0;
      if (d.expression === "scream") return past((s.jaw - t.heldJaw) / 0.4);
      return near(s.jaw / t.heldJaw);
    case "side_eye":
      if (!d.head) return 0;
      if (d.head.active === "side_eye") return past((d.head.side - hp.sideEnter) / 20);
      return near(d.head.side / hp.sideEnter);
    case "look_down":
      if (!d.head) return 0;
      if (d.head.active === "look_down") return past((d.head.down - hp.downEnter) / 20);
      return near(d.head.down / hp.downEnter);
    case "closeup": {
      const c = d.closeup;
      if (!c?.enter || !c.width) return 0;
      if (c.active) return past((c.width - c.enter) / (c.enter * 0.3));
      // Normal distance is width/enter = 1/1.4 = 0.71; partial credit starts once you lean in past 0.75.
      return near((c.width / c.enter - 0.75) / 0.25);
    }
    default:
      return d.gesture === target || d.expression === target ? 1 : 0; // a trigger added later
  }
}

export const GAME_DEFAULTS = {
  holdMs: 400, // accuracy must stay >= 60% this long (one lucky frame doesn't count)
  gapMs: 200, // ...but a dip shorter than this (a missed frame or two) doesn't restart the hold
  smoothMs: 150, // the shown accuracy is smoothed over ~this long (no jitter)
  hintAfterMs: 8000, // the hint line appears after this long on one meme
  foundMs: 1200, // "found" is shown this long before the next meme
};

/**
 * Stages through `ids` in order. update(score, nowMs) once per frame returns a snapshot:
 *   {phase: "play" | "found" | "won", index, total, target, score, hint}
 */
export class MemeHunt {
  constructor(ids, options = {}) {
    this.ids = [...ids];
    this.opt = { ...GAME_DEFAULTS, ...options };
    this.restart();
  }

  restart() {
    this.index = 0;
    this.phase = this.ids.length ? "play" : "won";
    this.stageStart = null; // set on the first update of a stage
    this.score = 0;
    this.lastT = null;
    this.aboveSince = null;
    this.lastAbove = null;
    this.foundAt = null;
  }

  get target() {
    return this.ids[this.index] ?? null;
  }

  update(raw, nowMs) {
    const o = this.opt;
    if (this.phase === "found" && nowMs - this.foundAt >= o.foundMs) {
      this.#next(nowMs);
      return this.snapshot(nowMs); // this frame's score was measured for the previous meme
    }
    if (this.phase === "play") {
      this.stageStart ??= nowMs;
      const dt = this.lastT == null ? Infinity : Math.max(0, nowMs - this.lastT);
      const a = dt === Infinity ? 1 : 1 - Math.exp(-dt / o.smoothMs);
      this.score += (clamp01(raw) - this.score) * a;
      this.lastT = nowMs;
      // Passing is decided on the frame scores (the smoothed score is only what is shown): smoothing
      // approaches a steady 64% from below and would leave a borderline pose sitting under the mark.
      if (raw >= PASS) {
        this.aboveSince ??= nowMs;
        this.lastAbove = nowMs;
        if (nowMs - this.aboveSince >= o.holdMs) {
          this.phase = "found";
          this.foundAt = nowMs;
        }
      } else if (this.aboveSince != null && nowMs - this.lastAbove > o.gapMs) this.aboveSince = null;
    }
    return this.snapshot(nowMs);
  }

  snapshot(nowMs) {
    return {
      phase: this.phase,
      index: this.index,
      total: this.ids.length,
      target: this.phase === "won" ? null : this.target,
      score: this.phase === "found" ? Math.max(this.score, PASS) : this.score,
      passing: this.phase === "found" || this.aboveSince != null,
      hint: this.phase === "play" && this.stageStart != null && nowMs - this.stageStart >= this.opt.hintAfterMs,
    };
  }

  /**
   * After a pause of `ms` (the captcha interrupting the game): the stage's clocks move on by that much, so the
   * hint doesn't show up at once and a hold that was going on doesn't count the pause.
   */
  pausedFor(ms) {
    if (!(ms > 0)) return;
    if (this.stageStart != null) this.stageStart += ms;
    if (this.foundAt != null) this.foundAt += ms;
    this.aboveSince = null;
    this.lastAbove = null;
    this.lastT = null;
  }

  /** Drops the memes not found yet that fail `keep` (e.g. face memes once the face model is gone). */
  retain(keep) {
    const before = this.ids.slice(0, this.index + (this.phase === "found" ? 1 : 0));
    const rest = this.ids.slice(before.length).filter(keep);
    if (rest[0] !== this.ids[before.length]) {
      this.aboveSince = null;
      this.score = 0;
      this.lastT = null;
      this.stageStart = null;
    }
    this.ids = [...before, ...rest];
    if (this.phase === "play" && this.index >= this.ids.length) this.phase = "won";
  }

  #next(nowMs) {
    this.index++;
    this.score = 0;
    this.lastT = null;
    this.aboveSince = null;
    this.lastAbove = null;
    this.foundAt = null;
    this.stageStart = nowMs;
    this.phase = this.index >= this.ids.length ? "won" : "play";
  }
}
