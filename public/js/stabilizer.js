/**
 * Debouncing of per-frame predictions: the meme should appear quickly, switch
 * quickly, and never blink when tracking drops a few frames or the classifier
 * wavers for a frame or two.
 * Pure logic, no DOM: runs in the browser and in Node (tests/stabilizer.test.mjs).
 *
 * Time-based (ms), so it behaves the same at 8 FPS or 60 FPS, plus a minimum
 * frame count so a slow device can't confirm on one or two lucky frames.
 */

const DEFAULTS = {
  /** A meme stays on screen at least this long (it can still be REPLACED at any time). */
  minShowMs: 0,
  /**
   * A new gesture must be in at least this share of the frames while it is held.
   * Simulated 30 fps idle stream with 1-2 frame misdetections in ~21% of frames
   * (enterMs 120): 2/3 -> 7.1 false memes/min, 0.7 -> 3.6/min (the old stabiliser:
   * 14/min at enterMs 150, 7.4/min at 300). A gesture the classifier catches in
   * only 60% of frames still shows (median 233 ms).
   */
  enterShare: 0.7,
  /** ...and in at least this many frames (8 fps: 3 frames = 250 ms; 30 fps: enterMs dominates). */
  minFrames: 3,
  /** A shown gesture seen in fewer than this share of the frames of the last 2 x exitMs is stale. */
  keepShare: 0.2,
};

/**
 * One channel (e.g. hands). update(raw, now) takes the raw per-frame gesture id
 * (or null) and returns the gesture to show (or null).
 *
 * - ENTER / SWITCH to gesture B (B is in the newest frame and differs from what
 *   is shown) when all of:
 *     B has been held for enterMs: its run (observations with dropouts no longer
 *       than gapMs, or a single missed frame, in between) started >= enterMs ago;
 *     B was seen in >= minFrames frames of that hold, and in >= enterShare of them;
 *     B is seen more often than the shown gesture during the hold.
 *   Switching is NOT delayed by the shown meme: a confirmed new gesture replaces it.
 * - EXIT (back to null) when the shown gesture has been gone for exitMs
 *   (missed in at least 2 frames, so one dropped frame at low FPS never hides it),
 *   or when, over the 2 x exitMs since it appeared, it only shows up
 *   sporadically (< keepShare of the frames), and the meme has been up for minShowMs.
 *   While another gesture is on its way in (seen in this frame, run younger than
 *   2 x enterMs) the old meme waits for it, so A -> B never blinks through "nothing".
 */
export class GestureStabilizer {
  /**
   * @param {number} enterMs a new gesture must be held this long before it shows
   * @param {number} exitMs  "no gesture" must last this long before going idle
   * @param {number} gapMs   dropouts shorter than this don't reset a pending
   *                         gesture (e.g. the 2nd hand of a heart vanishing for a
   *                         frame); the lost frames just count as frames without
   *                         it. A single dropped frame is always tolerated, so
   *                         slow devices (low FPS) still work.
   * @param {{minShowMs?: number, enterShare?: number, minFrames?: number, keepShare?: number}} [opts]
   */
  constructor(enterMs = 150, exitMs = 400, gapMs = 150, opts = {}) {
    this.enterMs = enterMs;
    this.exitMs = exitMs;
    this.gapMs = gapMs;
    Object.assign(this, DEFAULTS, opts);
    this.reset();
  }

  reset() {
    this.history = []; // recent frames, oldest first: {t, g}
    this.current = null;
    this.shownAt = -Infinity;
    this.seenAt = -Infinity; // last frame that showed the current gesture
  }

  /** Feed a raw prediction (gesture id or null) at time `now` (ms). Returns the stable gesture. */
  update(raw, now) {
    raw = raw ?? null;
    const h = this.history;
    if (h.length && now < h[h.length - 1].t) h.length = 0; // clock went backwards: start over
    h.push({ t: now, g: raw });
    // Keep what the rules can look at (and always the last few frames).
    const keep = Math.max(this.enterMs + this.gapMs, 2 * this.exitMs) + 100;
    while (h.length > 6 && now - h[0].t > keep) h.shift();

    const cur = this.current;
    if (raw === cur) {
      this.seenAt = now;
      return cur;
    }
    if (raw !== null && this.#confirmed(raw, now)) {
      this.current = raw;
      this.shownAt = now;
      this.seenAt = now;
    } else if (cur !== null && now - this.shownAt >= this.minShowMs && this.#stale(cur, now) && !this.#arriving(raw, now)) {
      this.current = null;
    }
    return this.current;
  }

  /**
   * Stops showing the current gesture right away. It keeps its history, but a
   * gesture that comes back has to be confirmed again (enterMs) like a new one.
   */
  release() {
    this.current = null;
  }

  /** Is gesture g (in this frame) a fresh run that may be confirmed in a moment? */
  #arriving(g, now) {
    if (g === null) return false;
    const h = this.history;
    let first = h.length - 1;
    for (let i = first - 1; i >= 0; i--) {
      if (h[i].g !== g) continue;
      if (h[first].t - h[i].t > this.gapMs && first - i > 2) break;
      first = i;
    }
    return now - h[first].t < 2 * this.enterMs;
  }

  /** Is the shown gesture gone (exitMs) or only sporadic? */
  #stale(g, now) {
    const h = this.history;
    let i = h.length - 1;
    while (i >= 0 && h[i].g !== g) i--;
    const missed = h.length - 1 - i; // frames since it was last seen
    const goneSince = h[i + 1].t; // first frame without it
    if (missed >= 2 && now - goneSince >= this.exitMs) return true;
    // Sporadic: judged only on frames after the meme appeared (2 x exitMs of them).
    if (now - this.shownAt < 2 * this.exitMs) return false;
    const from = this.#windowStart(now - 2 * this.exitMs);
    return this.#count(g, from) < this.keepShare * (h.length - from);
  }

  /**
   * Has gesture g (in the newest frame) been held long and clearly enough to show?
   * Walks back over g's run (consecutive observations at most gapMs, or one
   * frame, apart) and accepts the first hold — ending now, starting at one of
   * g's observations — that is >= enterMs long with >= minFrames observations,
   * g in >= enterShare of its frames, and g seen more often than the shown
   * gesture. Frames lost in a dropout only count as frames without g.
   */
  #confirmed(g, now) {
    const h = this.history;
    const newest = h.length - 1;
    let first = newest;
    let seen = 0;
    let rival = 0; // frames of the shown gesture inside the hold
    for (let i = newest; i >= 0; i--) {
      if (h[i].g !== g) {
        if (h[i].g !== null && h[i].g === this.current) rival++;
        continue;
      }
      if (h[first].t - h[i].t > this.gapMs && first - i > 2) break; // run broken
      if (now - h[i].t > this.enterMs + this.gapMs && seen >= this.minFrames) break; // only recent holds count
      first = i;
      seen++;
      if (now - h[i].t >= this.enterMs && seen >= this.minFrames && seen >= this.enterShare * (newest - i + 1) - 1e-9 && seen > rival) {
        return true;
      }
    }
    return false;
  }

  /** Index of the first frame with t >= since, but at least 3 frames back. */
  #windowStart(since) {
    const h = this.history;
    let i = h.length;
    while (i > 0 && h[i - 1].t >= since) i--;
    return Math.max(0, Math.min(i, h.length - 3));
  }

  #count(g, from) {
    let n = 0;
    for (let i = from; i < this.history.length; i++) if (this.history[i].g === g) n++;
    return n;
  }
}

/**
 * Two independently debounced channels — hands and face — combined AFTER
 * debouncing with priority hand > face. (Mixing them before debouncing would
 * let a smile fill every hand-tracking dropout and block hand gestures.)
 * When the hand has left the picture, a face meme that is live replaces the
 * hand meme after gapMs instead of waiting out the hand meme's exitMs.
 */
export class PriorityStabilizer {
  /** Same parameters as GestureStabilizer, used for both channels. */
  constructor(enterMs = 150, exitMs = 400, gapMs = 150, opts = {}) {
    this.hand = new GestureStabilizer(enterMs, exitMs, gapMs, opts);
    this.face = new GestureStabilizer(enterMs, exitMs, gapMs, opts);
    this.reset();
  }

  /**
   * @param handRaw  hand gesture id of this frame, or null
   * @param faceRaw  face trigger id of this frame, or null
   * @param now      ms
   * @param handInView whether any hand was detected in this frame (recognised
   *                 or not); defaults to handRaw !== null
   * @returns the trigger to show (hand gesture if any, else face trigger, else null)
   */
  update(handRaw, faceRaw, now, handInView = handRaw != null) {
    let h = this.hand.update(handRaw, now);
    const f = this.face.update(faceRaw, now);
    if (handInView) this.handGoneSince = null;
    else this.handGoneSince ??= now;
    // The face trigger is really there now (not a face meme on its way out).
    const faceLive = f !== null && now - this.face.seenAt <= this.face.gapMs;
    // Hand -> face hand-over. A hand meme normally stays exitMs (500 ms) after
    // its gesture ends, so "thumbs up, drop the hand, scream" showed the scream
    // ~0.5 s late (e2e: 559 ms GPU / 659 ms CPU from a thumbs-up photo to a
    // smile photo). Once NO hand at all has been seen for gapMs (counted from
    // the first frame without one, so a single lost frame never does it), a
    // confirmed face trigger that is live takes over right away. A hand still
    // in view but unrecognised (blurred, tilted, mid-change) keeps its meme the
    // full exitMs, so a held gesture plus a smile never flips hand <-> face meme.
    // e2e, hand photo -> face photo, median: 579 -> 297 ms on GPU, 638 -> 502 ms
    // on CPU (there confirming the new face, at ~6 face runs/s, is what's left).
    if (h !== null && faceLive && this.handGoneSince !== null && now - this.handGoneSince >= this.hand.gapMs) {
      this.hand.release(); // to come back, the gesture must be confirmed again
      h = null;
    }
    let out = h ?? f;
    // Falling back from a hand meme to the face meme: only if that face trigger
    // is really there (seen within gapMs). A face meme that is on its way out
    // must not flash up for a moment (e2e: a smile meme blinked for 34-69 ms
    // when a peace sign ended).
    if (h === null && f !== null && this.current !== f && !faceLive) out = null;
    this.current = out;
    return out;
  }

  reset() {
    this.hand.reset();
    this.face.reset();
    this.current = null;
    this.handGoneSince = null; // first frame of the current "no hand in view" stretch
  }
}
