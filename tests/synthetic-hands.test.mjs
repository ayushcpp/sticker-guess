// Gesture rules checked on synthetic hands from a simple kinematic model.
// (gestures.test.mjs covers real hands: video.mp4 and HaGRID; these cover every
// rule and the canned-gesture vetting, including gestures not in those fixtures.)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFrame, handFeatures, isHeart } from "../public/js/gestures.js";

const FINGER_MCP = { index: [-0.03, -0.085], middle: [-0.008, -0.09], ring: [0.013, -0.085], pinky: [0.032, -0.075] };
const FINGER_SEGS = { index: [0.04, 0.025, 0.02], middle: [0.045, 0.028, 0.02], ring: [0.042, 0.026, 0.02], pinky: [0.032, 0.02, 0.018] };
const THUMB = {
  tucked: [[-0.022, -0.025, 0], [-0.035, -0.05, -0.01], [-0.02, -0.07, -0.025], [0.0, -0.075, -0.03]],
  out: [[-0.02, -0.02, 0], [-0.055, -0.035, 0], [-0.09, -0.045, 0], [-0.12, -0.05, 0]],
};

/**
 * World-space hand (metres; x right, y down, z towards camera negative),
 * fingers pointing up, palm facing the camera.
 * @param {{index,middle,ring,pinky: boolean, thumb: "out"|"tucked"}} pose
 */
function makeHand(pose) {
  const pts = new Array(21);
  pts[0] = [0, 0, 0];
  THUMB[pose.thumb].forEach((p, i) => (pts[1 + i] = p));
  const base = { index: 5, middle: 9, ring: 13, pinky: 17 };
  for (const [name, b] of Object.entries(base)) {
    const [mx, my] = FINGER_MCP[name];
    let cur = [mx, my, 0];
    pts[b] = cur;
    FINGER_SEGS[name].forEach((len, k) => {
      const ang = pose[name] ? 0 : ((k + 1) * 80 * Math.PI) / 180; // curl: 80° per joint towards the palm
      cur = [cur[0], cur[1] - len * Math.cos(ang), cur[2] - len * Math.sin(ang)];
      pts[b + 1 + k] = cur;
    });
  }
  return pts;
}

/** Rotate in the image plane (degrees, clockwise on screen) and optionally mirror. */
const transform = (pts, deg = 0, mirror = false) => {
  const a = (deg * Math.PI) / 180;
  return pts.map(([x, y, z]) => {
    const mx = mirror ? -x : x;
    return [mx * Math.cos(a) - y * Math.sin(a), mx * Math.sin(a) + y * Math.cos(a), z];
  });
};

/** World points -> MediaPipe-like hand {landmarks (normalised image), worldLandmarks}. */
function toHand(world, cx = 0.5, cy = 0.6, k = 3, canned) {
  return {
    worldLandmarks: world.map(([x, y, z]) => ({ x, y, z })),
    landmarks: world.map(([x, y, z]) => ({ x: cx + x * k, y: cy + y * k, z: z * k })),
    ...(canned ? { canned: { name: canned, score: 0.7 } } : {}),
  };
}

const P = (fingers, thumb = "tucked") => ({ index: false, middle: false, ring: false, pinky: false, ...fingers, thumb });
const classify = (...hands) => classifyFrame(hands, 1, 1).gesture;
const withCanned = (world, name) => toHand(world, 0.5, 0.6, 3, name);

const FIST = P({});
const FIST_THUMB_OUT = P({}, "out"); // thumb sticks out sideways (-x)
const SHAKA = P({ pinky: true }, "out");

describe("single-hand gestures, rules only (no canned gesture)", () => {
  const cases = [
    ["point", P({ index: true })],
    ["peace", P({ index: true, middle: true })],
    ["shaka", SHAKA],
    ["rock", P({ index: true, pinky: true })],
    ["rock", P({ index: true, pinky: true }, "out")], // 🤟 counts as rock
    ["open_palm", P({ index: true, middle: true, ring: true, pinky: true }, "out")],
    ["fist", FIST],
  ];
  for (const [want, pose] of cases) {
    it(`${want} (${JSON.stringify(pose)})`, () => {
      assert.equal(classify(toHand(makeHand(pose))), want);
      assert.equal(classify(toHand(transform(makeHand(pose), 0, true))), want, "mirrored");
    });
  }

  it("thumbs up: fist with the thumb pointing up, also tilted (up to 45°) and mirrored", () => {
    // the thumb sticks out sideways (-x); rotating the hand 90° clockwise points it up.
    // 45° / 135° = thumb tilted 45° either way: the old straight-up-only rule missed most real ones.
    for (const deg of [45, 60, 90, 120, 135]) {
      assert.equal(classify(toHand(transform(makeHand(FIST_THUMB_OUT), deg))), "thumbs_up", `${deg}°`);
      assert.equal(classify(toHand(transform(makeHand(FIST_THUMB_OUT), -deg, true))), "thumbs_up", `mirrored ${deg}°`);
    }
  });

  it("thumbs down: fist with the thumb pointing down, also tilted (up to 45°) and mirrored", () => {
    for (const deg of [-45, -60, -90, -120, -135]) {
      assert.equal(classify(toHand(transform(makeHand(FIST_THUMB_OUT), deg))), "thumbs_down", `${deg}°`);
      assert.equal(classify(toHand(transform(makeHand(FIST_THUMB_OUT), -deg, true))), "thumbs_down", `mirrored ${deg}°`);
    }
  });

  it("thumb sideways is neither thumbs up nor thumbs down", () => {
    const g = classify(toHand(makeHand(FIST_THUMB_OUT)));
    assert.ok(g !== "thumbs_up" && g !== "thumbs_down", g);
  });

  it("a fist with the thumb tucked is never thumbs up / down, however it is turned", () => {
    for (let deg = -180; deg < 180; deg += 30) {
      const g = classify(toHand(transform(makeHand(FIST), deg)));
      assert.ok(g !== "thumbs_up" && g !== "thumbs_down", `${deg}° -> ${g}`);
    }
  });

  it("a shaka held upright (thumb on top) is still a shaka, not a thumbs up", () => {
    assert.equal(classify(toHand(transform(makeHand(SHAKA), 90))), "shaka");
  });

  it("peace needs the thumb tucked: thumb + index + middle is not peace", () => {
    assert.equal(classify(toHand(makeHand(P({ index: true, middle: true }, "out")))), null);
  });

  it("point needs the thumb tucked (an 'L' / finger gun is not a point) and must not point down", () => {
    assert.equal(classify(toHand(makeHand(P({ index: true }, "out")))), null);
    assert.equal(classify(toHand(transform(makeHand(P({ index: true })), 180))), null);
  });

  it("point at the camera / sideways still counts", () => {
    assert.equal(classify(toHand(transform(makeHand(P({ index: true })), 80))), "point");
  });

  it("is scale-invariant (hand near/far from camera)", () => {
    const pose = P({ index: true, middle: true });
    assert.equal(classify(toHand(makeHand(pose), 0.5, 0.6, 1.2)), "peace");
    assert.equal(classify(toHand(makeHand(pose), 0.5, 0.6, 5)), "peace");
  });

  it("works from image landmarks alone when world landmarks are missing", () => {
    const h = toHand(transform(makeHand(FIST_THUMB_OUT), 90));
    assert.equal(classify({ landmarks: h.landmarks }), "thumbs_up");
  });

  it("tilted thumb margin: equals the straight-up one for an upright thumb, and stays high when tilted", () => {
    const upright = handFeatures(toHand(transform(makeHand(FIST_THUMB_OUT), 90)), 1, 1);
    assert.ok(Math.abs(upright.thumbTopTilted - upright.thumbTop) < 0.05, JSON.stringify(upright));
    const tilted = handFeatures(toHand(transform(makeHand(FIST_THUMB_OUT), 45)), 1, 1);
    assert.ok(tilted.thumbTopTilted > tilted.thumbTop + 0.3, JSON.stringify(tilted));
    assert.ok(tilted.thumbBottomTilted < 0, JSON.stringify(tilted));
  });

  it("thumb features match the pose", () => {
    const up = handFeatures(toHand(transform(makeHand(FIST_THUMB_OUT), 90)));
    assert.ok(up.thumbFree > 0.8 && up.thumbTop > 0.8 && up.thumbBottom < 0, JSON.stringify(up));
    const tucked = handFeatures(toHand(makeHand(FIST)));
    assert.ok(tucked.thumbFree < 0.3, JSON.stringify(tucked));
  });
});

describe("canned GestureRecognizer gesture, vetted by the landmarks", () => {
  const thumbUp = transform(makeHand(FIST_THUMB_OUT), 90);
  const thumbDown = transform(makeHand(FIST_THUMB_OUT), -90);

  it("Thumb_Up / Thumb_Down on a real thumbs up / down are accepted", () => {
    assert.equal(classify(withCanned(thumbUp, "Thumb_Up")), "thumbs_up");
    assert.equal(classify(withCanned(thumbDown, "Thumb_Down")), "thumbs_down");
  });

  it("Thumb_Up on a shaka (the model's known confusion) gives shaka", () => {
    assert.equal(classify(withCanned(makeHand(SHAKA), "Thumb_Up")), "shaka");
    assert.equal(classify(withCanned(transform(makeHand(SHAKA), 90), "Thumb_Up")), "shaka");
  });

  it("Thumb_Up / Thumb_Down on a tucked-thumb fist is rejected", () => {
    for (const name of ["Thumb_Up", "Thumb_Down"]) {
      const g = classify(withCanned(makeHand(FIST), name));
      assert.ok(g !== "thumbs_up" && g !== "thumbs_down", `${name} -> ${g}`);
    }
  });

  it("Thumb_Up with the thumb pointing down (or Thumb_Down pointing up) is rejected", () => {
    assert.notEqual(classify(withCanned(thumbDown, "Thumb_Up")), "thumbs_up");
    assert.notEqual(classify(withCanned(thumbUp, "Thumb_Down")), "thumbs_down");
  });

  it("Closed_Fist always wins over the thumb rules (a fist never becomes a thumbs up)", () => {
    assert.equal(classify(withCanned(thumbUp, "Closed_Fist")), "fist");
  });

  it("Victory on thumb + index + middle (three) is rejected; on a real peace it is accepted", () => {
    assert.equal(classify(withCanned(makeHand(P({ index: true, middle: true }, "out")), "Victory")), null);
    assert.equal(classify(withCanned(makeHand(P({ index: true, middle: true })), "Victory")), "peace");
  });

  it("Pointing_Up with the pinky up too is rock", () => {
    assert.equal(classify(withCanned(makeHand(P({ index: true, pinky: true })), "Pointing_Up")), "rock");
  });

  it("canned 'None' falls back to the rules (the model doesn't know shaka / rock)", () => {
    assert.equal(classify(withCanned(makeHand(SHAKA), "None")), "shaka");
    assert.equal(classify(withCanned(makeHand(P({ index: true, pinky: true })), "None")), "rock");
  });
});

describe("two hands (synthetic)", () => {
  const open = P({ index: true, middle: true, ring: true, pinky: true }, "tucked");

  it("steeple / triangle (straight fingers, tips touching) is not a heart, point, peace or rock", () => {
    const a = transform(makeHand(open), 45); // tilt right
    const b = transform(makeHand(open), -45, true); // mirrored, tilt left
    // translate b so its index tip lands next to a's index tip
    const dx = a[8][0] - b[8][0] + 0.004;
    const dy = a[8][1] - b[8][1];
    const bMoved = b.map(([x, y, z]) => [x + dx, y + dy, z]);
    const g = classify(toHand(a, 0.4), toHand(bMoved, 0.4));
    assert.ok(g !== "heart" && g !== "point" && g !== "peace" && g !== "rock", g);
  });

  it("two index fingers touching (👉👈) or two rock signs tip to tip are not a steeple (review)", () => {
    for (const fingers of [{ index: true }, { index: true, pinky: true }]) {
      const hand = P(fingers);
      const a = transform(makeHand(hand), 45);
      const b = transform(makeHand(hand), -45, true);
      const dx = a[8][0] - b[8][0] + 0.004;
      const dy = a[8][1] - b[8][1];
      const g = classify(toHand(a, 0.4), toHand(b.map(([x, y, z]) => [x + dx, y + dy, z]), 0.4));
      assert.notEqual(g, "steeple", JSON.stringify(fingers));
    }
  });

  it("two separate gestures: falls back to the single-hand gesture", () => {
    const a = toHand(makeHand(P({ index: true })), 0.25);
    const b = toHand(makeHand(FIST), 0.75);
    assert.equal(classify(a, b), "point");
    assert.equal(classify(b, a), "point", "hand order doesn't matter");
  });

  it("two different gestures: the bigger (closer) hand wins, whatever the hand order", () => {
    const near = toHand(makeHand(P({ index: true, pinky: true })), 0.3, 0.6, 4); // rock
    const far = toHand(makeHand(P({ index: true })), 0.75, 0.6, 2); // point
    assert.equal(classify(near, far), "rock");
    assert.equal(classify(far, near), "rock");
  });

  it("a peace sign (no meme any more) never hides the other hand's meme", () => {
    const near = toHand(makeHand(P({ index: true, middle: true })), 0.3, 0.6, 4);
    const far = toHand(makeHand(P({ index: true })), 0.75, 0.6, 2);
    assert.equal(classify(near, far), "point");
    assert.equal(classify(far, near), "point");
  });

  it("heart rule: thumbs meet below, index fingers meet above and curl over, wrists apart", () => {
    // Hand-built feature objects (only the fields isHeart reads).
    const mk = (side, bend = 80) => {
      const px = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
      px[0] = { x: 0.5 + side * 0.3, y: 0.7, z: 0 }; // wrists apart
      px[9] = { x: 0.5 + side * 0.25, y: 0.58, z: 0 }; // palm length ~0.13
      px[4] = { x: 0.5 + side * 0.02, y: 0.75, z: 0 }; // thumb tips meet low
      px[8] = { x: 0.5 + side * 0.03, y: 0.45, z: 0 }; // index tips meet high
      px[7] = { x: 0.5 + side * 0.06, y: 0.42, z: 0 };
      px[6] = { x: 0.5 + side * 0.1, y: 0.42, z: 0 };
      return { px, palmPx: 0.13, indexBend: bend };
    };
    assert.equal(isHeart(mk(-1), mk(1)).ok, true);
    assert.equal(isHeart(mk(-1, 20), mk(1, 20)).ok, false, "straight index fingers = steeple, not heart");
    const upside = [mk(-1), mk(1)].map((f) => ({ ...f, px: f.px.map((p) => ({ ...p, y: 1 - p.y })) }));
    assert.equal(isHeart(upside[0], upside[1]).ok, false, "thumbs must be below");
    const prayer = [mk(-1), mk(1)].map((f) => ({ ...f, px: f.px.map((p, i) => (i === 0 ? { ...p, x: 0.5 } : p)) }));
    assert.equal(isHeart(prayer[0], prayer[1]).ok, false, "wrists together = prayer hands");
  });
});
