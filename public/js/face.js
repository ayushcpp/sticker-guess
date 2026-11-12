/**
 * Face-based triggers from MediaPipe FaceLandmarker output:
 *  - CLOSE-UP: the face is much wider in the frame than this person's usual size (they leaned in).
 *  - EXPRESSIONS: from the 52 ARKit-style blendshape scores (0..1).
 *
 * Pure functions + two small stateful classes; no DOM, so it's unit-testable (tests/face.test.mjs).
 *
 * Thresholds were tuned on the TUNE split of a labelled face set run through this app's
 * face_landmarker.task (posed selfies, posed studio portraits and in-the-wild AffectNet photos),
 * plus 5.8 min of two people talking to camera (public-domain weekly addresses) replayed through
 * the face channel the way main.js wires it (face model on every other frame, at 30 / 15 / 8 fps).
 * Numbers quoted below come from those runs:
 *   "talking"  = the talking clips (2 calm speakers, 9,800 frames with a face)
 *   "neutral"  = 193 tune neutral faces (posed + in the wild)
 *   "VIDEO"    = the same photos re-run in VIDEO mode at webcam scale (~220 px face), as the app
 *                sees them. Brow / eye / jaw scores come out weaker there than on single photos.
 */

/* ------------------------------------------------------------------ expressions -- */

export const EXPRESSION_THRESHOLDS = {
  // --- SCREAM: mouth clearly wide open (the screaming-hamster meme) ------------------------
  /** jawOpen this high is a scream on its own. Talking peaked at 0.64 (one speaker, < 300 ms). */
  screamJaw: 0.65,
  /** A lower jawOpen counts as a scream when a second "scream" cue is present... */
  cueJaw: 0.45,
  /** ...lower lip pulled down (teeth showing below) without the upper lip lifting (that's a grin). */
  lowerLip: 0.25,
  /** Wide eyes / raised outer brows (surprise) are enough from this jawOpen up. Talking: 99th pct
   *  jawOpen 0.36 / 0.50, while outer brows stayed <= 0.09 and eyeWide <= 0.07. Some people's
   *  resting outer brows read up to ~0.5, hence a fairly high jaw for this path. */
  eyesJaw: 0.4,
  browsUp: 0.5, // browOuterUp (L/R mean); posed surprise median 0.68
  eyesWide: 0.12, // eyeWide (L/R mean); neutral max 0.13 (wild) / 0.05 (posed)
  /** In VIDEO mode brow / eye scores are much weaker (one posed surprise: browOuterUp 0.74 /
   *  eyeWide 0.17 as a photo, 0.49 / 0.04 in VIDEO mode), so with the mouth this far open weaker
   *  cues are enough. They use the STRONGER side (max of L/R): in VIDEO mode one side often reads
   *  much lower (e.g. eyeWide 0.04 / 0.13 on one fear photo). Talking at jawOpen >= 0.4 (315
   *  frames): browOuterUp max 0.16 on either side, eyeWide max 0.02; tune split: max instead of mean
   *  changes no result. Inner brows are NOT used (one speaker held them up to 0.6 while talking). */
  videoEyesJaw: 0.5,
  videoBrowsUp: 0.25,
  videoEyesWide: 0.1,
  /** A very low lower lip alone (e.g. jawOpen 0.29 + lowerLip 0.87 on an obvious scream photo). */
  lipJaw: 0.25,
  lipOnly: 0.6,
  /** mouthUpperUp at/above this = upper teeth showing = a grin, not a scream
   *  (toothy smiles mostly 0.4-0.9; screams mostly <= 0.35). */
  grinUpperLip: 0.4,
  /** HELD wide mouth (ExpressionTracker only): jawOpen >= heldJaw for heldMs is a scream. In VIDEO
   *  mode a wide-open mouth reads jawOpen 0.57 median (p25 0.47), and only ~30% reach screamJaw, so
   *  without this most "AAAH" faces with calm brows showed nothing. Talking opens that far only
   *  briefly: longest run at >= 0.45 was 267 ms; the replay at 30 / 15 / 8 fps first shows a false
   *  scream at heldMs 200, none from 250 up. Dips below it up to heldDipMs (one face result at 15-30 fps) are
   *  bridged. Tune: 4 of the 6 wide-open photos that showed nothing become scream (jawOpen
   *  0.47-0.58); no meme on any of the 193 neutral faces (jawOpen max 0.21). */
  heldJaw: 0.45,
  heldMs: 400,
  heldDipMs: 150,

  // --- LAUGH / SMILE -------------------------------------------------------------------------
  /** Mouth open enough to call a smile a laugh. Talking median jawOpen is 0.12-0.15. */
  laughJaw: 0.2,
  /** mouthSmile for laugh and smile. Neutral faces (tune split): max 0.52 posed (1 of 133), 0.45
   *  wild; posed happy median 0.67-0.77. A wide-open mouth also lifts the corners (0.46-0.76 on
   *  screaming photos), so with a wide-open mouth the smile must beat jawOpen by `laughMargin`... */
  laughSmile: 0.5,
  laughMargin: 0.15,
  /** ...or by `screamLaughMargin` when the mouth has the scream shape: lower lip pulled down
   *  (>= lowerLip) with the upper teeth covered (mouthUpperUp < noTeethUpperLip). Laughs lift the
   *  upper lip; a hands-on-cheeks scream (an6753: jaw 0.50, smile 0.70, lowerLip 0.43, upperLip
   *  0.13) read as laugh. Tune: no happy face has that mouth shape with a wide-open mouth. */
  screamLaughMargin: 0.3,
  noTeethUpperLip: 0.2,
  smile: 0.5,

  // --- KISS (duck lips / pout) ------------------------------------------------------------------
  /** mouthPucker: duck lips in the reference video 0.90-0.99 (median 0.93); resting full lips
   *  reach 0.87-0.90 (2 of 193 neutral faces), and talking reaches 1.0 on "oo"/"w" sounds. */
  kissPucker: 0.9,
  /** A pout keeps the jaw shut: duck lips jawOpen <= 0.002 (all 27 frames); talking "oo"/"w" with
   *  pucker >= 0.9 had jawOpen >= 0.059 (81 frames). At 0.1 the camera-rate replay showed a false
   *  kiss at 15 and 8 fps (obama2016 109 s: pucker 0.93-0.98 at jawOpen 0.08-0.10). */
  kissMaxJaw: 0.05,
  kissMaxFunnel: 0.15, // duck lips <= 0.05

  // --- SAD -------------------------------------------------------------------------------------
  /** Mouth corners down. Neutral max 0.13; a scowl while talking 0.15-0.31 for ~0.3 s;
   *  crying / clearly turned-down mouths 0.3-0.56. Ordinary sad faces barely move mouthFrown
   *  (VIDEO, own-neutral -> sad: median +0.00), so sad only fires on a clear frown. */
  sadFrown: 0.2,
  /** Or "puppy brows" (inner brows up clearly more than the outer ones) WITH a slight frown.
   *  Puppy brows alone are not used: one speaker raised them while talking (114 frames, up to
   *  1.1 s) and some neutral faces rest at 0.6-0.9. */
  sadFrownWithBrows: 0.08,
  sadBrows: 0.45,
  sadBrowGap: 0.2,

  /** Brows pulled down (no meme; reported so it isn't confused with sad/scream). Unreliable:
   *  talking median browDown was 0.44 / 0.62. */
  angry: 0.6,
};

/**
 * How much easier the thresholds of an expression get while its meme is showing (see
 * classifyExpression). Only for the open-mouth memes: a face at rest closes the jaw (neutral
 * jawOpen max 0.21), so it always leaves these relaxed bands and the meme ends. Smile / kiss / sad
 * have no margin: 7 of 323 VIDEO-mode neutral faces REST inside such a band (smile 0.45-0.50,
 * pucker 0.86-0.90, frown 0.17), which kept those memes on for good after one real expression; the
 * stabiliser's exit delay already stops them blinking. Scream: e2e CPU path, a surprised face read
 * browOuterUp 0.44-0.50 against the 0.5 cue and the meme vanished after 0.8 s without it.
 */
export const HOLD_MARGIN = {
  scream: { screamJaw: 0.05, cueJaw: 0.05, eyesJaw: 0.05, browsUp: 0.1, eyesWide: 0.02, lowerLip: 0.05,
    videoEyesJaw: 0.05, videoBrowsUp: 0.05, videoEyesWide: 0.02, heldJaw: 0.05 },
  laugh: { laughJaw: 0.05, laughSmile: 0.05 },
};

/** Blendshape categories -> {name: score}. Accepts MediaPipe's Classifications or a plain object. */
export function blendshapeMap(blendshapes) {
  if (!blendshapes) return {};
  const cats = blendshapes.categories ?? blendshapes;
  if (!Array.isArray(cats)) return { ...cats };
  const out = {};
  for (const c of cats) out[c.categoryName] = c.score;
  return out;
}

/** Width of the face (landmark bounding box) as a fraction of frame width. */
export function faceWidth(landmarks) {
  let min = Infinity;
  let max = -Infinity;
  for (const p of landmarks) {
    if (p.x < min) min = p.x;
    if (p.x > max) max = p.x;
  }
  return max > min ? max - min : 0;
}

/** Named expression signals (left/right averaged, plus the stronger side of brows / eyes). */
export function expressionSignals(bs) {
  const get = (k) => bs[k] ?? 0;
  const avg = (k) => (get(k + "Left") + get(k + "Right")) / 2;
  const max = (k) => Math.max(get(k + "Left"), get(k + "Right"));
  return {
    jaw: get("jawOpen"),
    smile: avg("mouthSmile"),
    frown: avg("mouthFrown"),
    pucker: get("mouthPucker"),
    funnel: get("mouthFunnel"),
    lowerLip: avg("mouthLowerDown"),
    upperLip: avg("mouthUpperUp"),
    browInnerUp: get("browInnerUp"),
    browOuterUp: avg("browOuterUp"),
    browOuterUpMax: max("browOuterUp"),
    browDown: avg("browDown"),
    eyeWide: avg("eyeWide"),
    eyeWideMax: max("eyeWide"),
  };
}

/**
 * Expression id (scream | laugh | smile | kiss | sad | angry) or null, from one frame.
 * Open-mouth expressions are decided first; a mouth that is open but not clearly a laugh or a
 * scream (talking) returns null rather than falling through to smile / kiss / sad.
 * (ExpressionTracker adds the one rule that needs time: a wide mouth HELD open is a scream.)
 */
export function classifyExpression(s, t = EXPRESSION_THRESHOLDS, prev = null) {
  // Hysteresis: `prev` = the expression whose meme is showing (main.js passes the stabiliser's
  // confirmed face meme, never a single raw frame). It is kept while its signals stay close to the
  // threshold, so a signal sitting on a threshold doesn't make the meme come and go.
  const margin = HOLD_MARGIN[prev];
  if (margin) {
    const relaxed = { ...t };
    for (const [k, d] of Object.entries(margin)) relaxed[k] = t[k] - d;
    if (classifyExpression(s, relaxed) === prev) return prev;
  }
  const surprisedEyes = s.browOuterUp >= t.browsUp || s.eyeWide >= t.eyesWide;
  const videoCue = (s.browOuterUpMax ?? s.browOuterUp) >= t.videoBrowsUp || (s.eyeWideMax ?? s.eyeWide) >= t.videoEyesWide;
  const grin = s.upperLip >= t.grinUpperLip;
  const lowerLipDown = s.lowerLip >= t.lowerLip && !grin;
  const wideOpen =
    s.jaw >= t.screamJaw ||
    (s.jaw >= t.cueJaw && lowerLipDown) ||
    (s.jaw >= t.eyesJaw && surprisedEyes) ||
    (s.jaw >= t.videoEyesJaw && videoCue) ||
    (s.jaw >= t.lipJaw && s.lowerLip >= t.lipOnly && !grin);

  if (s.jaw >= t.laughJaw && s.smile >= t.laughSmile) {
    const screamShape = s.lowerLip >= t.lowerLip && s.upperLip < t.noTeethUpperLip;
    if (!wideOpen || s.smile >= s.jaw + (screamShape ? t.screamLaughMargin : t.laughMargin)) return "laugh";
  }
  if (wideOpen) return "scream";
  if (s.jaw >= t.laughJaw) return null; // open, but neither a clear laugh nor a scream: talking

  if (s.smile >= t.smile) return "smile";
  if (s.pucker >= t.kissPucker && s.jaw < t.kissMaxJaw && s.funnel < t.kissMaxFunnel && s.smile < 0.2) {
    return "kiss";
  }
  const puppyBrows = s.browInnerUp >= t.sadBrows && s.browInnerUp - s.browOuterUp >= t.sadBrowGap;
  if (s.smile < 0.1 && (s.frown >= t.sadFrown || (s.frown >= t.sadFrownWithBrows && puppyBrows))) return "sad";
  if (s.browDown >= t.angry && s.smile < 0.2) return "angry";
  return null;
}

/**
 * classifyExpression plus the one rule that needs time: a mouth HELD wide open (jawOpen >= heldJaw
 * for heldMs) is a scream even without brow / eye / lip cues. Talking opens the jaw that far only
 * briefly (see heldJaw). One per camera; call update() on every frame.
 *   const expr = tracker.update(signalsOrNull, nowMs, stabilizer.face.current);
 */
export class ExpressionTracker {
  constructor(thresholds = EXPRESSION_THRESHOLDS) {
    this.t = thresholds;
    this.reset();
  }

  reset() {
    this.openSince = null; // start of the current wide-mouth run
    this.dipSince = null; // first frame of the current dip (jaw below the threshold, or no face)
  }

  /**
   * @param {object|null} signals expressionSignals() of the latest face result, or null (no face)
   * @param {number} nowMs frame timestamp
   * @param {string|null} [shown] the face meme showing now (hysteresis, as in classifyExpression)
   */
  update(signals, nowMs, shown = null) {
    const t = this.t;
    const e = signals ? classifyExpression(signals, t, shown) : null;
    const keep = shown === "scream"; // a scream meme already up stays while the mouth stays open
    if (!signals || signals.jaw < t.heldJaw - (keep ? HOLD_MARGIN.scream.heldJaw : 0)) {
      this.dipSince ??= nowMs;
      return e;
    }
    // Only time spent BELOW the threshold breaks the run, not a slow frame rate (e2e under load:
    // frames up to 370 ms apart, all with jawOpen 0.57).
    const dip = this.dipSince == null ? 0 : nowMs - this.dipSince;
    if (this.openSince == null || dip > t.heldDipMs || nowMs < this.openSince) this.openSince = nowMs;
    this.dipSince = null;
    if (e !== null) return e; // only fills a "nothing": a smiling open mouth stays a laugh
    return keep || nowMs - this.openSince >= t.heldMs ? "scream" : null;
  }
}

/* --------------------------------------------------------------------- close-up -- */

export const CLOSEUP = {
  /** Close-up = face this much wider than the person's normal size (moderately close, not
   *  nose-to-screen); it ends below `exitRatio` (hysteresis, no flicker at the boundary). */
  enterRatio: 1.4,
  exitRatio: 1.25,
  /** Absolute limits on the enter threshold: someone sitting far back (small face) must still
   *  come reasonably close (>= 1/4 of the frame width), and the threshold never exceeds 0.7. */
  minEnter: 0.25,
  maxEnter: 0.7,
  /** Baseline = median face width over the last `windowMs`, sampled on a `sampleMs` grid, taken
   *  only while NOT in a close-up, so leaning in never drags the baseline up. */
  sampleMs: 100,
  windowMs: 30000,
  /** No close-up at all until this many samples (2 s) give the person's normal size: a fixed
   *  starting guess (0.34) fired "Too close!" at every start for phone users (15 of 19 phone
   *  selfies have face width >= 0.34, median 0.49). */
  minSamples: 20,
  /** A close-up held this long is the person's new normal distance (chair pulled in, or the
   *  tracker moved to a closer person): its last `relearnMs` become the baseline and it ends.
   *  Without this a 1.5x move kept "Too close!" on - and every face meme hidden - for good. */
  maxActiveMs: 6000,
  relearnMs: 2000,
  /** Face size jumping by this factor between two consecutive face results <= jumpMs apart is
   *  another face: with two people in view the tracker hopped to the closer one (0.20 -> 0.30 within
   *  ~0.1 s, 6 of 6 probes). A real lean-in grows the face gradually (1.5x in 150 ms is <= 1.2x per
   *  result at 30 fps, still a close-up). The baseline is then learned again for the new face. At
   *  low frame rates results are > jumpMs apart, and maxActiveMs ends such a close-up instead. */
  jumpRatio: 1.4,
  jumpMs: 150,
};

const median = (vals) => {
  const v = [...vals].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};

/**
 * Close-up detector that calibrates itself to the person in front of the camera.
 * update(width, nowMs) -> true while the face is close; width null = no face (-> false).
 * Reference video: face width 0.228-0.248 at normal sitting distance -> baseline ~0.24,
 * enter at ~0.335, exit below ~0.30.
 */
export class CloseupDetector {
  constructor(options = {}) {
    this.opt = { ...CLOSEUP, ...options };
    this.reset();
  }

  reset() {
    this.samples = []; // {t, w} at normal distance, oldest first
    this.recent = []; // {t, w} during the current close-up
    this.gridT = -Infinity; // time of the last sample slot
    this.clock = -Infinity; // last timestamp seen
    this.active = false;
    this.activeSince = null;
    this.baseline = null; // learned normal face width, or null while warming up
    this.lastW = null; // last distinct width (a new face result) and its time
    this.lastWT = -Infinity;
  }

  /** Current {enter, exit} thresholds (fraction of frame width), or null while warming up. */
  thresholds() {
    const o = this.opt;
    if (this.baseline == null) return null;
    const enter = Math.min(o.maxEnter, Math.max(o.minEnter, this.baseline * o.enterRatio));
    return { enter, exit: (enter * o.exitRatio) / o.enterRatio };
  }

  /**
   * @param {number|null} width face width as a fraction of frame width, or null when no face
   * @param {number} [nowMs] frame timestamp; without one, every call counts as a new sample
   */
  update(width, nowMs) {
    const o = this.opt;
    const t = Number.isFinite(nowMs) ? nowMs : this.clock + o.sampleMs;
    if (t < this.clock) this.#restartTimers(); // clock went backwards (baseline kept)
    this.clock = t;
    if (width == null || !(width > 0)) {
      this.active = false; // the learned baseline is kept
      return false;
    }
    if (this.#otherFace(width, t)) this.#forget();
    if (this.baseline == null) {
      this.#sample(this.samples, width, t);
      return false;
    }
    const { enter, exit } = this.thresholds();
    if (!this.active && width >= enter) {
      this.active = true;
      this.activeSince = t;
      this.recent = [];
    } else if (this.active && width < exit) this.active = false;

    if (!this.active) {
      this.#sample(this.samples, width, t);
    } else {
      this.#sample(this.recent, width, t);
      if (t - this.activeSince >= o.maxActiveMs) {
        // Still close after maxActiveMs: that's the normal distance now.
        this.samples = this.recent.filter((s) => t - s.t <= o.relearnMs);
        if (!this.samples.length) this.samples = [{ t, w: width }];
        this.baseline = median(this.samples.map((s) => s.w));
        this.active = false;
      }
    }
    return this.active;
  }

  /** Did the face size jump like a switch to another person? (Reused results repeat the width.) */
  #otherFace(width, t) {
    if (width === this.lastW) return false;
    const prev = this.lastW;
    const dt = t - this.lastWT;
    this.lastW = width;
    this.lastWT = t;
    return prev != null && dt <= this.opt.jumpMs && Math.max(width / prev, prev / width) >= this.opt.jumpRatio;
  }

  #forget() {
    this.samples = [];
    this.recent = [];
    this.baseline = null;
    this.active = false;
  }

  #restartTimers() {
    this.samples = []; // refilled from now on; the baseline stays meanwhile
    this.recent = [];
    this.gridT = -Infinity;
    this.lastW = null;
    this.lastWT = -Infinity;
    this.active = false;
  }

  /** Add a sample to `arr` if a sampleMs slot has passed (a fixed grid, so 30 fps gives 10/s). */
  #sample(arr, width, t) {
    const o = this.opt;
    const next = this.gridT + o.sampleMs;
    if (t < next) return;
    this.gridT = t - next < o.sampleMs ? next : t; // stay on the grid unless we fell behind
    arr.push({ t, w: width });
    while (arr.length && t - arr[0].t > o.windowMs) arr.shift();
    if (arr === this.samples && arr.length >= o.minSamples) this.baseline = median(arr.map((s) => s.w));
  }
}

/* ------------------------------------------------------------------- head pose -- */
/**
 * Head turn / tilt from FaceLandmarker's facial transformation matrix (needs
 * outputFacialTransformationMatrixes). Returns {yaw, down} in degrees, or null:
 *   yaw  = head turned left / right (only its size is used)
 *   down = head tilted down (positive) or up (negative)
 */
export function headPose(matrix) {
  const d = matrix?.data;
  if (!d || d.length < 16) return null;
  // The bottom row of the 4x4 pose matrix is 0 0 0 1 and the translation is tens of cm, so where the
  // translation sits tells the packing (MediaPipe packs column-major).
  const colMajor = Math.abs(d[3]) + Math.abs(d[7]) + Math.abs(d[11]) <= Math.abs(d[12]) + Math.abs(d[13]) + Math.abs(d[14]);
  const at = (r, c) => (colMajor ? d[c * 4 + r] : d[r * 4 + c]);
  // Where the face points (the canonical face's +z, out through the nose) in camera space (y up).
  const fx = at(0, 2);
  const fy = at(1, 2);
  const fz = at(2, 2);
  const deg = 180 / Math.PI;
  return { yaw: Math.atan2(fx, fz) * deg, down: Math.atan2(-fy, Math.hypot(fx, fz)) * deg };
}

/**
 * Angles are measured from the person's usual head pose (learned like the close-up baseline),
 * because the camera's position changes the reading: a laptop camera below the face sees a level
 * head as tilted up, a webcam on top of a monitor sees it as tilted down.
 */
export const HEAD_POSE = {
  sideEnter: 22, // |yaw| change (deg) that shows side-eye
  sideExit: 15,
  downEnter: 18, // downward tilt change (deg) that shows look-down
  downExit: 12,
  sampleMs: 100, // usual pose = median of samples taken every 100 ms over the last 4 s,
  windowMs: 4000, // only while no head meme is on
  minSamples: 8,
  maxBaseline: 20, // a head held turned / tilted from the start is never learned as "straight"
};

/** update(pose, nowMs) -> "side_eye" | "look_down" | null. pose = headPose() or null (no face). */
export class HeadPoseTracker {
  constructor(options = {}) {
    this.opt = { ...HEAD_POSE, ...options };
    this.reset();
  }

  reset() {
    this.samples = []; // {t, yaw, down}, oldest first
    this.lastSampleT = -Infinity;
    this.base = null; // {yaw, down} once learned
    this.active = null;
    this.offset = null; // {side, down}: degrees from the usual pose this frame (null: no face / not learned)
  }

  /**
   * While true (the game is asking for a head meme), only poses close to the usual one are learned:
   * otherwise a head held partly turned becomes the new "straight" within ~2 s and the progress
   * bar drops back to 0% while the player holds still. Off by default (the usual pose keeps adapting).
   */
  hold = false;

  update(pose, nowMs) {
    const o = this.opt;
    if (!pose) {
      this.active = null;
      this.offset = null;
      return null;
    }
    if (this.base) {
      const side = Math.abs(pose.yaw - this.base.yaw);
      const down = pose.down - this.base.down;
      this.offset = { side, down };
      // Keep the meme that is on while its angle stays past the (lower) exit angle.
      if (this.active === "look_down" && down >= o.downExit) return this.active;
      if (this.active === "side_eye" && side >= o.sideExit) return this.active;
      this.active = down >= o.downEnter ? "look_down" : side >= o.sideEnter ? "side_eye" : null;
    }
    const near = !this.offset || (this.offset.side < o.sideExit / 2 && Math.abs(this.offset.down) < o.downExit / 2);
    if (!this.active && (!this.hold || near)) this.#sample(pose, nowMs);
    return this.active;
  }

  #sample(pose, t) {
    const o = this.opt;
    if (t - this.lastSampleT < o.sampleMs) return;
    this.lastSampleT = t;
    this.samples.push({ t, yaw: pose.yaw, down: pose.down });
    while (this.samples.length && t - this.samples[0].t > o.windowMs) this.samples.shift();
    if (this.samples.length >= o.minSamples) {
      const clamp = (v) => Math.max(-o.maxBaseline, Math.min(o.maxBaseline, v));
      this.base = {
        yaw: clamp(median(this.samples.map((s) => s.yaw))),
        down: clamp(median(this.samples.map((s) => s.down))),
      };
    }
  }
}

