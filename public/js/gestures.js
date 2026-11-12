/**
 * Hand gesture classification: MediaPipe GestureRecognizer output -> meme id.
 *
 * Pure functions, no DOM: runs in the browser and in Node (see tests/).
 *
 * HYBRID of two signals per hand:
 *  1. `canned`: GestureRecognizer's own top-1 gesture (Thumb_Up, Thumb_Down,
 *     Pointing_Up, Victory, Closed_Fist, Open_Palm, ILoveYou, None). It is very
 *     good at thumbs up / down and fist, but it does not know shaka, rock,
 *     peace-with-fingers-together or heart, and it calls many shakas Thumb_Up.
 *  2. Landmark rules (below). They vet every canned answer (e.g. Thumb_Up with
 *     the pinky out is a shaka, Thumb_Up with the thumb not on top is nothing),
 *     detect the gestures the model doesn't know, and are the whole answer when
 *     `canned` is missing or "None".
 *
 * Measured on real HaGRID hands (GestureRecognizer landmarks + canned, tune
 * split, 827 crops; numbers in the comments below are from that set unless
 * stated). "Tilted" numbers are REAL rotations: the photo is rotated and the
 * GestureRecognizer is run again, so its own label changes too (a tilted thumb
 * is often "None" for the model, which sends it to the rules). "Video" numbers:
 * 30-frame VIDEO-mode sequences of a tune photo with +-6 deg / shift / scale
 * jitter per frame, through the app's stabilizer timings. The evaluation scripts
 * and data are kept outside the project: re-run them before changing a threshold.
 *
 * Features
 * - EXTENSION RATIO per finger (3D world landmarks, metres):
 *       |wrist -> fingertip| / length of the bone chain wrist->MCP->PIP->DIP->tip
 *   ~1.0 straight, ~0.4 curled. Independent of distance, resolution and hand side.
 * - THUMB: `thumbFree` = gap between the thumb tip and the nearest finger
 *   landmark (palm lengths): a tucked thumb touches the fingers, an "out" thumb
 *   doesn't. `thumbTop` / `thumbBottom` = how far the thumb tip is above / below
 *   EVERY other landmark (world y = image vertical): that is "thumb up / down"
 *   without demanding a perfectly vertical thumb, and it doesn't care whether
 *   the palm or the back of the hand faces the camera. `thumbTopTilted` /
 *   `thumbBottomTilted` = the same, measured along the best direction within
 *   +-THUMB_CONE degrees of straight up / down, so a thumb held at an angle
 *   still counts (a 45 deg thumb is barely above the fist's top knuckle).
 * - Handedness is never used, so the mirrored webcam and either hand give the
 *   same result.
 *
 * MediaPipe hand landmark indices:
 *   0 wrist | thumb 1-4 | index 5-8 | middle 9-12 | ring 13-16 | pinky 17-20
 */

export const THRESHOLDS = {
  /** Extension ratio at/above which a finger is "up" (straight). Raised index in point/peace/rock:
   *  p10 >= 0.93; relaxed resting hands: median 0.80. */
  extended: 0.85,
  /** Extension ratio at/below which a finger is "down" (curled): point's middle/ring, fist. */
  curled: 0.75,

  // ---- rock ----
  /** Rock: middle and ring at/below this extension... A half-curled rock sign reads 0.72-0.79
   *  (e2e, test-split person in VIDEO mode: middle 0.75-0.76, so `curled` 0.75 flickered on/off
   *  and the meme dropped out after ~1 s). */
  rockFold: 0.8,
  /** ...AND index + pinky at least this much straighter than middle + ring
   *  (min(index, pinky) - max(middle, ring)). Without it, 0.80 turned the resting "four" / "stop"
   *  second hands of 2 whole frames into rock: their margins are 0.06-0.09; rock signs 0.13+.
   *  Tune: same result for 0.12-0.18 (rock 42/46, no other hand). Test: rock 26/32 -> 30/32, but this
   *  limit was added after seeing a test-split failure, so that number is optimistic. Clean held-out
   *  check (fresh HaGRIDv2 "rock" sample, never used for tuning): 34/37 detected hands -> rock, 1 shaka. */
  rockMargin: 0.15,

  // ---- thumbs up / down ----
  /** Thumb "out" of the fist: thumb tip this far (palm lengths) from every finger landmark.
   *  fist max 0.39, like min 0.58, dislike 0.45+. Same result for 0.40-0.45. */
  thumbFree: 0.42,
  /** With canned Thumb_Up/Down: thumb tip above (below) every other landmark by this much
   *  (straight up / down only). like min 0.53, fist max 0.31 (and fists are Closed_Fist anyway).
   *  Allowing a tilt here too turned a resting hand the model calls Thumb_Up into thumbs up and
   *  gained only 1 of 168 tilted like video sequences, so the canned path stays vertical. */
  cannedThumbTop: 0.1,
  /**
   * Rules only (canned missing / "None" = what a TILTED thumb usually gets from the model): thumb tip
   * past every other landmark by this much, along the best direction within +-THUMB_CONE of up / down.
   * The old straight-up-only test (0.4) let most tilted thumbs through to nothing: real rotations,
   * tune 256 px, like +45 deg 15/41, -45 deg 28/41; dislike +45 deg 20/42, -45 deg 27/45. With the
   * 30 deg cone: like 41/41 and 39/41, dislike 39/42 and 45/45 (0 deg unchanged). Video, tune, tilts
   * +-25/+-40 deg: meme shown like 146 -> 161 of 168 sequences, dislike 146 -> 180 of 188; fist (230)
   * and resting-hand (235) sequences still never show a meme. 0.3 gives the same video result.
   * Held-out test split (other people), real rotations: like +45 deg 16/35 -> 31/35, dislike +45 deg
   * 9/31 -> 23/31, dislike +30 deg 17/29 -> 28/29, with no new wrong meme anywhere on the test split.
   */
  ruleThumbTop: 0.4,
  /** Index/middle/ring must be below this extension (folded) for thumbs, with canned Thumb_Up/Down.
   *  like index max 0.77. */
  thumbFold: 0.85,
  /**
   * Same, rules only. 0.72, not 0.8: the tilt cone lets more shapes through, and 0.72-0.8 is where the
   * non-thumbs live: single hands of the "hand_heart2" heart (fingers 0.68-0.79, thumb down: 24 tune
   * hands would be thumbs down), sideways finger guns (HaGRIDv2 three_gun 0.74-0.80) and shakas whose
   * pinky the landmarks miss. Tune stills, all sets: wrong memes 55 -> 47 vs. 0.8. Cost: loose-fist
   * thumbs with fingers at 0.72-0.80 (1 upright like photo, 12 of ~670 tilted variants; video:
   * 1 of 168 like and 1 of 188 dislike sequences).
   */
  ruleThumbFold: 0.72,
  /**
   * Thumbs up also needs the pinky clearly IN: pinky reach below this (see shakaReach). A pinky
   * between this and shakaReach is neither shaka nor thumbs up (null), so a borderline shaka can't
   * flip to the thumbs-up meme. like (incl. tilted, tune) p99 1.03; removes 4 call -> thumbs-up
   * stills (tune), loses 1 like variant (reach 1.08-1.10).
   */
  thumbPinkyReach: 1.07,

  // ---- pinky out (shaka, and the Thumb_Up -> shaka fix) ----
  /** Pinky tip reaches this much further from the wrist than the ring/middle tips.
   *  like max 1.04; most shakas 1.25-2.0. */
  shakaReach: 1.1,
  /** ...or the pinky is this straight on its own. like max 0.82. Flat 0.91-0.94. */
  pinkyStraight: 0.91,
  /** Shaka needs at least this pinky extension. Flat 0.65-0.70. */
  shakaPinky: 0.7,

  // ---- peace / point ----
  /** Peace: thumb across the palm, not out to the side (signed, palm lengths).
   *  peace max -0.10, two_up max -0.08, three2 (thumb+index+middle) min 0.11. Flat -0.05..0.05. */
  peaceThumbMax: 0.0,
  /** Peace: ring and pinky below this extension. */
  peaceOther: 0.8,
  /** Point (rules): thumb tip within this of the fingers, so an "L" / finger-gun isn't a point.
   *  'one' max 0.27, L-shaped hands (HaGRIDv2 take_picture/thumb_index2) mostly 0.65+. Flat 0.35-0.45. */
  pointThumbMax: 0.4,
  /** Point: index direction within this many degrees of straight up (90 = at the camera / sideways). */
  pointMaxTilt: 100,
  /** Rules ignore hands whose wrist->knuckles points down more than this (2D degrees from up),
   *  except for thumbs down. */
  maxHandDown: 110,

  // ---- two-hand heart ----
  /** Thumb tips of both hands this close (palm lengths). hearts p90 <= 0.31; the reference
   *  video's steeple/triangle 0.61-0.76; timeout min 0.66. */
  heartThumbGap: 0.7,
  /** Index fingers (PIP/DIP/tip) of both hands this close. hearts p90 <= 0.27. */
  heartIndexGap: 0.8,
  /** Wrists at least this far apart. hearts min 2.2; prayer hands (holy) max 1.1. */
  heartWristGap: 1.8,
  /** Index fingers curled over (PIP + DIP bend, degrees, mean of both hands).
   *  hand_heart p10 66, hand_heart2 p10 90; video triangle p90 41. Flat 40-50. */
  heartBend: 45,
};

/** Tilt (degrees either side of straight up / down) the rules-only thumbs test accepts, scanned in 5 deg steps.
 *  Tune, tilted video sequences (meme shown): 0 deg -> like 145/168, dislike 146/188; 15 -> 158, 175;
 *  20 -> 161, 179; 30 -> 161, 180; 45 -> 161, 180 but 2 more wrong memes on the tune stills. */
export const THUMB_CONE = 30;

export const FINGERS = {
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

// ---------- small vector helpers (points are {x, y, z}) ----------

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
/** Angle between two vectors, degrees. */
const angle = (u, v) => (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (Math.sqrt(dot(u, u) * dot(v, v)) || 1e-12)))) * 180) / Math.PI;
const UP = { x: 0, y: -1, z: 0 }; // image y grows downwards

/** Normalised image landmarks -> pixel space (z uses the x scale, as MediaPipe documents). */
function toPixels(landmarks, width, height) {
  return landmarks.map((p) => ({ x: p.x * width, y: p.y * height, z: (p.z ?? 0) * width }));
}

/** 2D tilt in degrees of from -> to, measured from straight up: 0 up, 90 sideways, 180 down. */
function tiltFromUp(from, to) {
  return (Math.atan2(Math.abs(to.x - from.x), from.y - to.y) * 180) / Math.PI;
}

// ---------- per-hand features ----------

/**
 * How far the thumb tip sticks out past every other landmark (wrist + fingers), along the best
 * image-plane direction within +-THUMB_CONE deg of straight up (vy = -1) or down (vy = 1); palm lengths.
 * At 0 deg this is exactly thumbTop / thumbBottom.
 */
function thumbMargin(w, palm, vy) {
  let best = -Infinity;
  for (let deg = -THUMB_CONE; deg <= THUMB_CONE; deg += 5) {
    const r = (deg * Math.PI) / 180;
    const dx = Math.sin(r);
    const dy = vy * Math.cos(r);
    let m = Infinity;
    for (let j = 0; j <= 20; j++) {
      if (j >= 1 && j <= 4) continue; // the thumb itself
      m = Math.min(m, (w[4].x - w[j].x) * dx + (w[4].y - w[j].y) * dy);
    }
    best = Math.max(best, m / palm);
  }
  return best;
}

/**
 * @param {{landmarks: Array<{x,y,z}>, worldLandmarks?: Array<{x,y,z}>}} hand  one detected hand
 * @param {number} width  source video width in px
 * @param {number} height source video height in px
 */
export function handFeatures(hand, width = 1, height = 1) {
  const px = toPixels(hand.landmarks, width, height);
  // Prefer metric 3D world landmarks; fall back to pixel-space landmarks.
  const w = hand.worldLandmarks?.length === 21 ? hand.worldLandmarks : px;
  const palm = dist(w[0], w[9]) || 1e-6; // wrist -> middle-finger knuckle

  const ext = {};
  for (const [name, [mcp, pip, dip, tip]] of Object.entries(FINGERS)) {
    const chain = dist(w[0], w[mcp]) + dist(w[mcp], w[pip]) + dist(w[pip], w[dip]) + dist(w[dip], w[tip]);
    ext[name] = dist(w[0], w[tip]) / (chain || 1e-6);
  }

  // Thumb tip vs. the rest of the hand (wrist + all finger landmarks).
  let top = Infinity;
  let bottom = -Infinity;
  let free = Infinity;
  for (let j = 0; j <= 20; j++) {
    if (j >= 1 && j <= 4) continue; // the thumb itself
    top = Math.min(top, w[j].y);
    bottom = Math.max(bottom, w[j].y);
    if (j >= 5) free = Math.min(free, dist(w[4], w[j]));
  }
  // Signed sideways offset of the thumb tip from the index knuckle, along the knuckle line
  // (pinky -> index): > 0 sticks out past the index side, < 0 lies across the palm.
  const across = sub(w[5], w[17]);
  const thumbSide = dot(sub(w[4], w[5]), across) / ((Math.sqrt(dot(across, across)) || 1e-6) * palm);

  return {
    ext,
    thumbFree: free / palm,
    thumbTop: (top - w[4].y) / palm,
    thumbBottom: (w[4].y - bottom) / palm,
    thumbTopTilted: thumbMargin(w, palm, -1),
    thumbBottomTilted: thumbMargin(w, palm, 1),
    thumbSide,
    /** pinky tip distance from the wrist relative to the ring / middle tips (> 1: pinky sticks out) */
    pinkyReach: dist(w[20], w[0]) / (Math.max(dist(w[16], w[0]), dist(w[12], w[0])) || 1e-6),
    /** index finger direction, 3D degrees from straight up (0 up, 90 horizontal / at the camera) */
    indexTilt: angle(sub(w[8], w[5]), UP),
    /** how much the index finger curls at PIP + DIP, degrees (0 straight) */
    indexBend: angle(sub(w[6], w[5]), sub(w[7], w[6])) + angle(sub(w[7], w[6]), sub(w[8], w[7])),
    handTilt: tiltFromUp(px[0], px[9]),
    px,
    palmPx: dist(px[0], px[9]) || 1e-6,
  };
}

// ---------- hand shapes ----------

const up = (f, n, t) => f.ext[n] >= t.extended;
const down = (f, n, t) => f.ext[n] <= t.curled;
const notUp = (f, names, t) => names.every((n) => !up(f, n, t));
const pinkyOut = (f, t) => f.pinkyReach >= t.shakaReach || f.ext.pinky >= t.pinkyStraight;

/** 🤘 index + pinky up, middle + ring folded (thumb either way, so 🤟 counts too). */
const isRock = (f, t) =>
  up(f, "index", t) &&
  up(f, "pinky", t) &&
  Math.max(f.ext.middle, f.ext.ring) <= t.rockFold &&
  Math.min(f.ext.index, f.ext.pinky) - Math.max(f.ext.middle, f.ext.ring) >= t.rockMargin;

/** 🤙 thumb out (not pointing down) + pinky out, other fingers not straight. */
const isShaka = (f, t) =>
  f.thumbFree >= t.thumbFree &&
  f.thumbBottom < 0 &&
  f.ext.pinky >= t.shakaPinky &&
  pinkyOut(f, t) &&
  notUp(f, ["index", "middle", "ring"], t);

/** ☝️ / 🫵 index up or at the camera, others curled, thumb tucked. */
const isPoint = (f, t) =>
  up(f, "index", t) &&
  down(f, "middle", t) &&
  down(f, "ring", t) &&
  !up(f, "pinky", t) &&
  f.indexTilt <= t.pointMaxTilt &&
  f.thumbFree < t.pointThumbMax;

/** ✌️ index + middle up (apart or together), ring + pinky folded, thumb not out. */
const isPeace = (f, t) =>
  up(f, "index", t) && up(f, "middle", t) && f.ext.ring < t.peaceOther && f.ext.pinky < t.peaceOther && f.thumbSide < t.peaceThumbMax;

/**
 * 👍 / 👎 fist with the thumb out and on top (dir "up") / at the bottom (dir "down").
 * `tilted`: measure "on top" along the best direction within +-THUMB_CONE (rules path).
 * Thumbs up also needs the pinky in: GestureRecognizer calls 26/47 shakas Thumb_Up.
 */
function isThumb(f, dir, fold, margin, t, tilted = false) {
  if (!["index", "middle", "ring"].every((n) => f.ext[n] < fold)) return false;
  if (f.thumbFree < t.thumbFree) return false;
  if (dir === "up") {
    const top = tilted ? f.thumbTopTilted : f.thumbTop;
    return top >= margin && !pinkyOut(f, t) && f.pinkyReach < t.thumbPinkyReach;
  }
  return (tilted ? f.thumbBottomTilted : f.thumbBottom) >= margin;
}

/** Landmark rules only. Returns a gesture id or null. */
export function classifyRules(f, t = THRESHOLDS) {
  if (isRock(f, t)) return "rock";
  if (isShaka(f, t)) return "shaka";
  if (isThumb(f, "up", t.ruleThumbFold, t.ruleThumbTop, t, true)) return "thumbs_up";
  if (isThumb(f, "down", t.ruleThumbFold, t.ruleThumbTop, t, true)) return "thumbs_down";
  if (f.handTilt > t.maxHandDown) return null; // hanging hand
  if (isPoint(f, t)) return "point";
  if (isPeace(f, t)) return "peace";
  const four = ["index", "middle", "ring", "pinky"];
  if (four.every((n) => down(f, n, t))) return "fist";
  if (four.every((n) => up(f, n, t))) return "open_palm";
  return null;
}

/**
 * One hand: GestureRecognizer's canned gesture, vetted by the landmarks.
 * @param {object} f      handFeatures()
 * @param {{name: string, score: number}|undefined} canned  top-1 canned gesture (undefined = rules only)
 */
export function classifySingle(f, canned, t = THRESHOLDS) {
  switch (canned?.name) {
    case "Thumb_Up":
      // The model's known shaka -> Thumb_Up confusion. A pinky that is half out (thumbPinkyReach) is
      // neither, so a borderline shaka shows nothing for a frame instead of flipping to thumbs up.
      if (isShaka(f, t)) return "shaka";
      return isThumb(f, "up", t.thumbFold, t.cannedThumbTop, t) ? "thumbs_up" : null;
    case "Thumb_Down":
      return isThumb(f, "down", t.thumbFold, t.cannedThumbTop, t) ? "thumbs_down" : null;
    case "Pointing_Up":
      if (isRock(f, t)) return "rock";
      return up(f, "index", t) && notUp(f, ["middle", "pinky"], t) ? "point" : null;
    case "Victory":
      // three2 (thumb + index + middle) is sometimes Victory (6/80): the thumb test rejects it.
      return isPeace(f, t) ? "peace" : null;
    case "ILoveYou":
      return isRock(f, t) ? "rock" : null;
    case "Closed_Fist":
      return "fist"; // 43/46 fists; never a thumbs up/down
    case "Open_Palm":
      return "open_palm";
    default: // "None" (rock, shaka, fingers-together peace...) or no canned result
      return classifyRules(f, t);
  }
}

// ---------- two hands ----------

/**
 * 🫶 heart: thumb tips meet at the bottom, index fingers meet at the top and
 * curl over (that curl is what separates it from a straight-fingered steeple /
 * triangle), wrists apart.
 */
export function isHeart(a, b, t = THRESHOLDS) {
  const palm = (a.palmPx + b.palmPx) / 2;
  const thumbGap = dist(a.px[4], b.px[4]) / palm;
  let indexGap = Infinity;
  for (const i of [6, 7, 8]) for (const j of [6, 7, 8]) indexGap = Math.min(indexGap, dist(a.px[i], b.px[j]));
  indexGap /= palm;
  const wristGap = dist(a.px[0], b.px[0]) / palm;
  const thumbsBelow = (a.px[4].y + b.px[4].y) / 2 > (a.px[8].y + b.px[8].y) / 2;
  const bend = (a.indexBend + b.indexBend) / 2;
  return {
    ok:
      thumbGap < t.heartThumbGap &&
      indexGap < t.heartIndexGap &&
      wristGap > t.heartWristGap &&
      thumbsBelow &&
      bend >= t.heartBend,
    thumbGap,
    indexGap,
    wristGap,
    bend,
  };
}

/**
 * Two thumbs down (or up) held side by side, thumb tips touching, also passes the heart geometry
 * (thumbs below, curled index fingers close, wrists apart): mirrored HaGRID dislike pairs gave
 * heart 7/8 at a 20 px gap. So when both hands are the same thumbs gesture and the model says
 * Thumb_Up / Thumb_Down for at least one, it is not a heart. Real hearts (HaGRIDv2 hand_heart +
 * hand_heart2 frames): 109/114 heart with or without this check.
 */
function sameThumbs(feats, hands) {
  const g = feats[0].gesture;
  return (
    (g === "thumbs_up" || g === "thumbs_down") &&
    feats[1].gesture === g &&
    hands.some((h) => h.canned?.name === "Thumb_Up" || h.canned?.name === "Thumb_Down")
  );
}

/** Plain hand states: never preferred over a real gesture of the other hand. */
// "peace" has no meme any more: like a fist, it must not hide a real gesture on the other hand.
const NEUTRAL = new Set(["fist", "open_palm", "peace"]);

/**
 * Classify one video frame.
 * @param {Array<{landmarks, worldLandmarks?, handedness?, canned?: {name, score}}>} hands
 *        one entry per detected hand (see main.js); `canned` = GestureRecognizer's top-1 gesture
 * @returns {{gesture: string|null, hands: object[]}} hands = per-hand features (+ .gesture)
 */
export function classifyFrame(hands, width = 1, height = 1, t = THRESHOLDS) {
  const feats = hands.map((h) => handFeatures(h, width, height));
  feats.forEach((f, i) => (f.gesture = classifySingle(f, hands[i].canned, t)));
  if (feats.length >= 2 && !sameThumbs(feats, hands) && isHeart(feats[0], feats[1], t).ok) {
    return { gesture: "heart", hands: feats };
  }
  if (feats.length >= 2 && isSteeple(feats[0], feats[1])) return { gesture: "steeple", hands: feats };
  // Two hands with different gestures: take the bigger (closer) hand, so the
  // answer doesn't depend on MediaPipe's hand order.
  const ranked = [...feats].sort((a, b) => b.palmPx - a.palmPx);
  const pick = ranked.find((f) => f.gesture && !NEUTRAL.has(f.gesture)) ?? ranked.find((f) => f.gesture);
  return { gesture: pick?.gesture ?? null, hands: feats };
}

// The debouncers moved to stabilizer.js; re-exported so older imports keep working.
export { GestureStabilizer, PriorityStabilizer } from "./stabilizer.js";

/* ------------------------------------------------------------- hand on head -- */
/**
 * A hand on the head (Head.png): the PALM CENTRE over the head: from about a face-height above the
 * forehead down to the eyebrows, no further sideways than one face-width from the face's centre.
 * Fingertips don't count, and nothing below the brows does: hands on the cheeks (the 😱 pose) or
 * cupping the face reach the temples with their fingers, and read as a hand on the head 33 / 36 times
 * in a synthetic check when they did (review, 2026-11-07); their palm centres sit below the brows.
 * @param hands  [{landmarks}] (normalised to the frame)
 * @param face   {left, right, top, brow, chin} of the face, normalised (top = forehead, brow = eyebrows)
 * @param w, h   frame size in px (so that x and y distances are comparable)
 */
export function handOnHead(hands, face, w = 1, h = 1) {
  if (!face || !hands?.length) return false;
  const fw = (face.right - face.left) * w;
  const fh = (face.chin - face.top) * h;
  if (!(fw > 0) || !(fh > 0)) return false;
  const cx = ((face.left + face.right) / 2) * w;
  const top = face.top * h - fh * 0.9;
  const bottom = face.brow * h;
  const inZone = (p) => p.y * h >= top && p.y * h <= bottom && Math.abs(p.x * w - cx) <= fw;
  for (const hand of hands) {
    const lm = hand.landmarks;
    if (!lm?.[20]) continue;
    const palm = [0, 5, 9, 13, 17].map((i) => lm[i]);
    const pc = { x: palm.reduce((a, p) => a + p.x, 0) / 5, y: palm.reduce((a, p) => a + p.y, 0) / 5 };
    if (inZone(pc)) return true;
  }
  return false;
}

/* ---------------------------------------------------------------------- steeple -- */
/** Steeple / triangle (video.mp4, 23 labelled samples): index tips p50 0.43 palm lengths apart (middle
 *  tips 0.28), wrists 2.87-3.40 apart, fingertips above the wrists in all 23, never a heart. BOTH the
 *  index and the middle fingers must be straight and touch: two index fingers (👉👈) or two rock signs
 *  tip to tip are not a steeple (review). Same 21 / 23 on the video as with the index tips alone. */
export const STEEPLE = { tips: 0.7, wrists: 2.0, ext: 0.85, middleExt: 0.8 };

/** Steeple / triangle: index AND middle fingertips of both hands touching, wrists apart, fingers up and straight. */
export function isSteeple(a, b, t = STEEPLE) {
  const palm = (a.palmPx + b.palmPx) / 2;
  const tips = Math.max(dist(a.px[8], b.px[8]), dist(a.px[12], b.px[12])) / palm;
  const wrists = dist(a.px[0], b.px[0]) / palm;
  const up = (a.px[8].y + b.px[8].y) / 2 < (a.px[0].y + b.px[0].y) / 2;
  const straight = (a.ext.index + b.ext.index) / 2 >= t.ext && (a.ext.middle + b.ext.middle) / 2 >= t.middleExt;
  return tips <= t.tips && wrists >= t.wrists && up && straight;
}

/* ------------------------------------------------- shush / hand at chin / flex -- */
// Tuned on real photos from Openverse (2026-11-07), with no false fires on 78 other photos and video
// frames (the other two poses, faces without hands, video.mp4 idle / point / shaka / steeple):
//   shush 5/8 (all 5 where the hand and face were found), chin 7/10 (all 7), flex 4/7 (two fists found).
// Measured: shush index tip 0.33-0.57 face widths from the mouth, index straight (0.89-0.98), middle
// bent (<= 0.71); chin palm centre -0.20..0.26 face heights from the chin, <= 0.77 face widths
// sideways, a fingertip <= 0.55 face widths from the chin; flex two upright fists 2.2-5.2 face widths
// apart at about the same height.
export const POSES = {
  shushIndex: 0.85,
  shushMiddle: 0.75,
  shushMouth: 0.6,
  chinAbove: -0.25,
  chinBelow: 0.3,
  chinSide: 0.8,
  chinTip: 0.6,
  flexCurl: 0.75,
  flexApart: 3.5,
  flexLevel: 1.5,
};

const palmCentre = (f) => ({ x: [0, 5, 9, 13, 17].reduce((a, k) => a + f.px[k].x, 0) / 5, y: [0, 5, 9, 13, 17].reduce((a, k) => a + f.px[k].y, 0) / 5 });

/**
 * Shush: one index finger up (the others bent) with its tip at the mouth.
 * @param feats  classifyFrame(...).hands
 * @param face   {left, right, mouth: {x, y}} normalised to the frame
 */
export function isShush(feats, face, w = 1, h = 1, t = POSES) {
  if (!face?.mouth) return false;
  const fw = (face.right - face.left) * w;
  const mouth = { x: face.mouth.x * w, y: face.mouth.y * h };
  return feats.some((f) => f.ext.index >= t.shushIndex && f.ext.middle <= t.shushMiddle && f.px[8].y < f.px[5].y &&
    dist(f.px[8], mouth) <= t.shushMouth * fw);
}

/**
 * Hand at the chin (thinking, "hmm"): a palm centre just above / at / below the chin, near the middle of
 * the face, with a fingertip close to the chin. face: {left, right, top, chin, chinPt: {x, y}}.
 */
export function isHandAtChin(feats, face, w = 1, h = 1, t = POSES) {
  if (!face?.chinPt) return false;
  const fw = (face.right - face.left) * w;
  const fh = (face.chin - face.top) * h;
  const cx = ((face.left + face.right) / 2) * w;
  const chin = { x: face.chinPt.x * w, y: face.chinPt.y * h };
  return feats.some((f) => {
    const pc = palmCentre(f);
    const dy = (pc.y - chin.y) / fh;
    const tip = Math.min(...[8, 12, 16, 20].map((k) => dist(f.px[k], chin)));
    return dy >= t.chinAbove && dy <= t.chinBelow && Math.abs(pc.x - cx) <= t.chinSide * fw && tip <= t.chinTip * fw;
  });
}

/** Flex (both biceps): two upright fists far apart, at about the same height. Needs no face. */
export function isFlex(feats, t = POSES) {
  const fists = feats.filter((f) => f.px[9].y < f.px[0].y && ["index", "middle", "ring", "pinky"].every((n) => f.ext[n] <= t.flexCurl));
  if (fists.length < 2) return false;
  const [a, b] = fists;
  const palm = (a.palmPx + b.palmPx) / 2;
  const pa = palmCentre(a);
  const pb = palmCentre(b);
  return Math.abs(pa.x - pb.x) >= t.flexApart * palm && Math.abs(pa.y - pb.y) <= t.flexLevel * palm;
}

/**
 * Both hands on the ears (with the mouth open, checked by the caller: the scream meme). Each palm centre
 * within POSES.earDist face widths of an ear point, one hand per ear. Real photos (Openverse): the hand
 * model sees both hands in only 1 of 4 "hands over ears + screaming" photos (hands pressed flat over the
 * ears are hard for it), with no false fires on 113 other photos and frames; one hand alone misfired.
 * face: {left, right, earL: {x, y}, earR: {x, y}} normalised.
 */
export function isHandsOnEars(feats, face, w = 1, h = 1, maxDist = 0.6) {
  if (!face?.earL || !face?.earR || feats.length < 2) return false;
  const fw = (face.right - face.left) * w;
  const ears = [{ x: face.earL.x * w, y: face.earL.y * h }, { x: face.earR.x * w, y: face.earR.y * h }];
  const sides = new Set();
  for (const f of feats) {
    const pc = palmCentre(f);
    const d = ears.map((e) => dist(pc, e) / fw);
    const i = d[0] <= d[1] ? 0 : 1;
    if (d[i] <= maxDist) sides.add(i);
  }
  return sides.size === 2;
}
