// Landing page: the NO box slides just far enough to stay out of reach; messages; the form helpers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NO_TAPS_TO_GO,
  NO_TEASE,
  squeezeStep,
  HUMAN_INTRO,
  humanIntroSteps,
  AVOID_PAD,
  answersPayload,
  CAPTCHA_PASS,
  captchaScore,
  DEFAULT_COURSE,
  shuffled,
  checkAnswer,
  QUIZ,
  quizSummary,
  cleanDob,
  cleanName,
  DEFAULT_NAME,
  MSG_ROOM,
  phoneSpot,
  PEEK,
  cleanPhone,
  DODGE_SLACK,
  distToRect,
  dodgeSpot,
  KEEP_AWAY,
  NO_KEEP,
  NO_SLACK,
  noMessage,
  sendDetails,
  sharePayload,
} from "../public/js/intro.js";

/** deterministic pseudo-random numbers */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const W = 70; // No button size
const H = 38;
const rectAt = (x, y) => ({ left: x, top: y, right: x + W, bottom: y + H });
const onScreen = (r, vw, vh) => r.left >= 16 - 1e-9 && r.top >= 16 - 1e-9 && r.right <= vw - 16 + 1e-9 && r.bottom <= vh - 16 + 1e-9;
const hits = (a, b) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);

describe("No button dodge", () => {
  it("distToRect is 0 inside and Euclidean outside", () => {
    const r = { left: 10, top: 10, right: 30, bottom: 20 };
    assert.equal(distToRect(15, 15, r), 0);
    assert.equal(distToRect(0, 15, r), 10);
    assert.equal(distToRect(33, 24, r), 5);
  });

  it("stays put while the pointer is far away", () => {
    const rect = rectAt(600, 400);
    assert.deepEqual(dodgeSpot({ pointer: { x: 100, y: 100 }, rect, vw: 1366, vh: 768 }), { x: 600, y: 400 });
  });

  it("moves only as far as needed, straight away from the pointer", () => {
    const rect = rectAt(600, 400);
    const pointer = { x: 560, y: 419 }; // 40 px to the left of No, level with it
    const spot = dodgeSpot({ pointer, rect, vw: 1366, vh: 768 });
    const moved = Math.hypot(spot.x - 600, spot.y - 400);
    const needed = KEEP_AWAY + DODGE_SLACK - 40;
    assert.ok(spot.x > 600, "moves right, away from the pointer");
    assert.ok(Math.abs(spot.y - 400) < 1, "doesn't wander up or down");
    assert.ok(moved >= needed - 0.5 && moved <= needed + 4, `moved ${moved.toFixed(1)} px, needed ${needed}`);
  });

  for (const [vw, vh] of [[1366, 768], [1920, 1080], [390, 844], [320, 568]]) {
    it(`a pointer chasing it never gets within reach and No stays on screen, off Yes (${vw}x${vh})`, () => {
      const rand = rng(vw * 7 + vh);
      const yes = { left: vw / 2 - 150, top: vh / 2 - 30, right: vw / 2 - 20, bottom: vh / 2 + 30 };
      let rect = rectAt(vw / 2, vh / 2 - H / 2); // next to Yes, like the real layout
      let longest = 0;
      let pointer = { x: vw / 2 - 40, y: vh / 2 };
      for (let i = 0; i < 2000; i++) {
        // the pointer heads for the button with some jitter, sometimes jumping elsewhere
        const cx = (rect.left + rect.right) / 2;
        const cy = (rect.top + rect.bottom) / 2;
        pointer =
          rand() < 0.05
            ? { x: rand() * vw, y: rand() * vh }
            : { x: pointer.x + (cx - pointer.x) * 0.3 + (rand() - 0.5) * 30, y: pointer.y + (cy - pointer.y) * 0.3 + (rand() - 0.5) * 30 };
        if (distToRect(pointer.x, pointer.y, rect) >= KEEP_AWAY) continue;
        const spot = dodgeSpot({ pointer, rect, vw, vh, avoid: [yes] });
        const next = rectAt(spot.x, spot.y);
        assert.ok(onScreen(next, vw, vh), "on screen");
        assert.ok(!hits(next, yes), "not on Yes");
        assert.ok(distToRect(pointer.x, pointer.y, next) >= KEEP_AWAY, `reachable from ${JSON.stringify(pointer)}`);
        longest = Math.max(longest, Math.hypot(spot.x - rect.left, spot.y - rect.top));
        rect = next;
      }
      assert.ok(longest > 0, "it did have to move");
    });
  }

  it("typical dodges are short slides, not jumps across the screen", () => {
    const vw = 1366;
    const vh = 768;
    const rand = rng(42);
    const moves = [];
    for (let i = 0; i < 500; i++) {
      const rect = rectAt(300 + rand() * 700, 200 + rand() * 350); // open space, away from the edges
      const ang = rand() * Math.PI * 2;
      const d = rand() * KEEP_AWAY;
      const cx = (rect.left + rect.right) / 2;
      const cy = (rect.top + rect.bottom) / 2;
      // a pointer `d` px outside the button's edge, from a random side
      const pointer = { x: cx + Math.cos(ang) * (W / 2 + d), y: cy + Math.sin(ang) * (H / 2 + d) };
      const spot = dodgeSpot({ pointer, rect, vw, vh });
      moves.push(Math.hypot(spot.x - rect.left, spot.y - rect.top));
    }
    const max = Math.max(...moves);
    // At most ~10% over the minimum (a diagonal escape from a corner of the button is a bit longer).
    assert.ok(max <= (KEEP_AWAY + DODGE_SLACK) * 1.15, `longest slide ${max.toFixed(0)} px`);
  });
});

describe("share NO on the landing page (real layout: wide box, 10 px under YES)", () => {
  // The form column as rendered at 1366x768 (it scrolls a little; these are the on-screen rects).
  const BW = 407;
  const BH = 56;
  const layout = (vw) => {
    const x0 = vw - 214 - BW;
    const pad = (r) => ({ left: r.left - AVOID_PAD, top: r.top - AVOID_PAD, right: r.right + AVOID_PAD, bottom: r.bottom + AVOID_PAD });
    const avoid = [
      { left: x0, top: 92, right: x0 + BW, bottom: 140 }, // name
      { left: x0, top: 226, right: x0 + BW, bottom: 274 }, // phone
      { left: x0, top: 315, right: x0 + BW, bottom: 363 }, // date of birth
      { left: x0, top: 428, right: x0 + BW, bottom: 484 }, // share YES
      { left: x0, top: 572, right: x0 + 254, bottom: 628 }, // YES — Continue to Game
      { left: x0 + 264, top: 572, right: x0 + BW, bottom: 628 }, // play NO
    ].map(pad);
    return { avoid, home: { left: x0, top: 494, right: x0 + BW, bottom: 494 + BH } };
  };
  const opts = { keep: NO_KEEP, slack: NO_SLACK, marginTop: MSG_ROOM };

  it("its first escape is a glide, not a pop, from either side", () => {
    const vw = 1366;
    const vh = 768;
    const { avoid, home } = layout(vw);
    const cy = (home.top + home.bottom) / 2;
    for (const pointer of [{ x: home.left - 60, y: cy }, { x: home.right + 60, y: cy }]) {
      const spot = dodgeSpot({ pointer, rect: home, vw, vh, avoid, ...opts });
      assert.ok(!spot.jump, `popped for pointer ${JSON.stringify(pointer)}`);
      const next = { left: spot.x, top: spot.y, right: spot.x + BW, bottom: spot.y + BH };
      assert.ok(distToRect(pointer.x, pointer.y, next) >= NO_KEEP + NO_SLACK - 1);
    }
  });

  for (const [vw, vh] of [[1366, 768], [1280, 720], [1920, 1080]]) {
    it(`a chasing cursor never gets within reach; it stays clear of everything, with room for its message (${vw}x${vh})`, () => {
      const rand = rng(vw + vh * 3);
      const { avoid, home } = layout(vw);
      let rect = home;
      let pointer = { x: rect.left - 30, y: rect.top + 28 };
      let n = 0;
      let jumps = 0;
      for (let i = 0; i < 3000; i++) {
        const cx = (rect.left + rect.right) / 2;
        const cy = (rect.top + rect.bottom) / 2;
        pointer =
          rand() < 0.03
            ? { x: rand() * vw, y: rand() * vh }
            : { x: pointer.x + (cx - pointer.x) * 0.3 + (rand() - 0.5) * 40, y: pointer.y + (cy - pointer.y) * 0.3 + (rand() - 0.5) * 40 };
        if (distToRect(pointer.x, pointer.y, rect) >= NO_KEEP) continue;
        const spot = dodgeSpot({ pointer, rect, vw, vh, avoid, ...opts });
        const next = { left: spot.x, top: spot.y, right: spot.x + BW, bottom: spot.y + BH };
        assert.ok(next.left >= 16 - 1e-9 && next.right <= vw - 16 + 1e-9 && next.bottom <= vh - 16 + 1e-9, "on screen");
        assert.ok(next.top >= MSG_ROOM - 1e-9, "room for the message above it");
        assert.ok(distToRect(pointer.x, pointer.y, next) >= NO_KEEP, `reachable from ${JSON.stringify(pointer)}`);
        assert.ok(!avoid.some((r, k) => hits(next, r) && !(k === 3 && rect === home)), "covers an input or another box");
        n++;
        if (spot.jump) jumps++;
        rect = next;
      }
      assert.ok(n > 100, "it was chased");
      assert.ok(jumps / n < 0.15, `${jumps} of ${n} escapes were pops`);
    });
  }
});

describe("share NO on phones: out to the right edge and back into its slot, never over YES", () => {
  it("alternates slot -> right edge (PEEK visible) -> slot, staying in its row", () => {
    const vw = 390;
    const w = 112;
    const home = { left: 245, top: 635, right: 245 + w, bottom: 691 };
    let peeking = false;
    const xs = [];
    for (let i = 0; i < 4; i++) {
      const s = phoneSpot(home, w, vw, peeking);
      peeking = !peeking;
      assert.equal(s.y, home.top);
      assert.ok(s.x >= home.left, "never further left than its slot (YES is on the left)");
      xs.push(Math.round(s.x));
    }
    const peekX = Math.round(vw - w * PEEK);
    assert.deepEqual(xs, [peekX, 245, peekX, 245]);
  });
});

describe("share NO messages", () => {
  it("Catch me! -> Try again! -> Keep trying! -> U can't win! -> round again", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(noMessage), [
      "Catch me!", "Try again!", "Keep trying!", "U can't win!", "Catch me!", "Try again!",
    ]);
  });
});

describe("Additional Details", () => {
  it("name: tidied; empty -> Priyanshii", () => {
    assert.equal(DEFAULT_NAME, "Priyanshii");
    assert.equal(cleanName(""), "Priyanshii");
    assert.equal(cleanName("   "), "Priyanshii");
    assert.equal(cleanName(null), "Priyanshii");
    assert.equal(cleanName("  Riya   Sharma "), "Riya Sharma");
    assert.equal(cleanName("x".repeat(80)).length, 60);
  });

  it("phone numbers: digits with the usual separators, 7-15 digits", () => {
    assert.equal(cleanPhone("98765 43210"), "9876543210");
    assert.equal(cleanPhone(" +91 98765-43210 "), "+919876543210");
    assert.equal(cleanPhone("(0135) 264-3421"), "01352643421");
    for (const bad of ["", "   ", "12345", "call me", "98765abc10", "+1234567890123456", null, undefined]) {
      assert.equal(cleanPhone(bad), null, String(bad));
    }
  });

  it("date of birth: a real date between 1900 and today", () => {
    const today = new Date(2026, 10, 7); // 7 Nov 2026
    assert.equal(cleanDob("2005-03-14", today), "2005-03-14");
    assert.equal(cleanDob("2026-11-07", today), "2026-11-07");
    for (const bad of ["", "2026-11-08", "1899-12-31", "2005-02-30", "14/03/2005", "2005-3-14", null]) {
      assert.equal(cleanDob(bad, today), null, String(bad));
    }
  });

  it("email 1 (share YES, page 2): name, phone, date of birth, course and year, nothing else", () => {
    const pl = sharePayload({ name: "Riya", phone: "9876543210", dob: "2005-03-14", course: "B.Tech CSE", year: "1st year", accessKey: "k" });
    assert.deepEqual(Object.keys(pl).sort(), ["access_key", "course", "date_of_birth", "from_name", "name", "phone", "subject", "year"]);
    assert.equal(pl.course, "B.Tech CSE");
    assert.equal(sharePayload({ name: "Riya", phone: "1", dob: "2", accessKey: "k" }).year, "(blank)");
  });

  it("email 2 (leaving page 3): the answers with the score; 0 + 0 and the open questions listed, not scored", () => {
    const answers = ["4", "11", "All of these", "9 8 7 6 5 4 3 2 1", "9", "8", "cat", "  blue "];
    const pl = answersPayload({ name: "Riya", answers, accessKey: "k" });
    assert.deepEqual(Object.keys(pl).sort(), ["access_key", "answers", "from_name", "name", "score", "subject"]);
    assert.equal(pl.score, "4 / 5 right"); // 1 + 1 = 11 is wrong
    assert.match(pl.answers, /1 \+ 1 -> 11 ✗/);
    assert.match(pl.answers, /0 \+ 0 -> All of these \|/); // no mark: not scored
    assert.match(pl.answers, /Think of an animal and write it down -> cat \|/);
    assert.match(pl.answers, /Think of a color and write it down -> blue$/);
  });

  it("page 3 questions: the user's wording and options", () => {
    const byQ = Object.fromEntries(QUIZ.map((x) => [x.q, x]));
    assert.deepEqual(byQ["2 + 2 = ?"].options, ["4", "22", "I don't know"]);
    assert.equal(QUIZ[2].q, "0 + 0 = ?");
    assert.deepEqual(QUIZ[2].options, ["I don't know", "I don't know", "I still don't know", "All of these", "Write your own answer"]);
    assert.equal(QUIZ[2].options[QUIZ[2].own], "Write your own answer");
    assert.equal(QUIZ[2].a, undefined, "0 + 0 is a joke: not scored");
    assert.equal(QUIZ[6].q, "Think of an animal and write it down");
    assert.equal(QUIZ[7].q, "Think of a color and write it down");
    for (const x of QUIZ) if (x.options && x.a != null) assert.ok(x.options.includes(x.a), x.q);
  });

  it("answers compared loosely for the typed one, a sign still counts", () => {
    assert.equal(checkAnswer(" 4 ", "4"), true);
    assert.equal(checkAnswer("9 8 7 6 5 4 3 2 1", "987654321"), true);
    assert.equal(checkAnswer("987,654,321", "987654321"), true);
    assert.equal(checkAnswer("123456789", "987654321"), false);
    assert.equal(checkAnswer("", "4"), false);
    assert.equal(checkAnswer("-4", "4"), false);
    assert.equal(checkAnswer("4-", "4"), false);
    const all = quizSummary(QUIZ.map((x) => x.a ?? "anything"));
    assert.equal(all.score, all.total);
    assert.equal(all.total, 5);
  });

  it("course: nothing typed means BCA AI DS", () => assert.equal(DEFAULT_COURSE, "BCA AI DS"));

  it("sendDetails: POSTs JSON to the endpoint; true only when Web3Forms confirms", async () => {
    const calls = [];
    const ok = (body) => async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => body };
    };
    const share = { endpoint: "https://api.web3forms.com/submit", accessKey: "abc" };
    assert.equal(await sendDetails({ name: "Riya", phone: "9876543210", dob: "2005-03-14" }, share, ok({ success: true })), true);
    assert.equal(calls[0].url, share.endpoint);
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init.body), sharePayload({ name: "Riya", phone: "9876543210", dob: "2005-03-14", accessKey: "abc" }));
    assert.equal(await sendDetails({ phone: "1", dob: "2" }, share, ok({ success: false, message: "bad key" })), false);
    const down = async () => {
      throw new TypeError("Failed to fetch");
    };
    assert.equal(await sendDetails({ phone: "1", dob: "2" }, share, down), false);
  });

  it("sendDetails: no access key -> nothing is sent", async () => {
    let called = false;
    const spy = async () => {
      called = true;
      return { ok: true, json: async () => ({ success: true }) };
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await sendDetails({ name: "Riya", phone: "9876543210", dob: "2005-03-14" }, { endpoint: "x", accessKey: "" }, spy), false);
    } finally {
      console.warn = warn;
    }
    assert.equal(called, false);
  });
});

describe("captcha (page 4): match the columns", () => {
  it("counts the stickers on their own gesture; 2 of 5 passes", () => {
    assert.equal(CAPTCHA_PASS, 2);
    assert.equal(captchaScore({ a: "a", b: "b", c: "d", d: "c", e: "e" }), 3);
    assert.equal(captchaScore({ a: "b", b: "a" }), 0);
    assert.equal(captchaScore({}), 0);
  });
  it("shuffled: same items, input untouched", () => {
    const items = ["a", "b", "c", "d", "e"];
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const out = shuffled(items, rand);
    assert.deepEqual([...out].sort(), items);
    assert.deepEqual(items, ["a", "b", "c", "d", "e"]);
  });
});

describe("captcha lead-in (the user's wording, 2026-11-07)", () => {
  // A tiny stand-in for #human-intro: elements are tagged with their class.
  const el = (cls, kids = {}) => ({ cls, querySelector: (s) => kids[s] ?? null });
  const nos = [0, 1, 2].map(() => el("hi-no", { ".hi-pic": el("hi-pic") }));
  const parts = {
    ".hi-wait": [0, 1, 2].map(() => el("hi-wait")),
    ".hi-word": [0, 1, 2, 3, 4, 5, 6].map(() => el("hi-word")),
    ".hi-swipe": [el("hi-swipe")],
    ".hi-whatif": [el("hi-whatif")],
    ".hi-no": nos,
    ".hi-lets": [el("hi-lets")],
    ".hi-okay": [el("hi-okay")],
  };
  const root = { querySelectorAll: (s) => parts[s] ?? [], querySelector: (s) => parts[s]?.[0] ?? null };
  const steps = humanIntroSteps(root);
  const byEl = new Map();
  for (const [e, delay, frames, dur] of steps) {
    if (!byEl.has(e)) byEl.set(e, []);
    byEl.get(e).push({ start: delay, end: delay + dur, from: frames[0], to: frames.at(-1) });
  }
  const sceneOne = [...parts[".hi-wait"], ...parts[".hi-word"]];
  const sceneTwo = [...parts[".hi-whatif"], ...nos, ...parts[".hi-lets"], ...parts[".hi-okay"]];

  it("every text comes in, then leaves (ends invisible)", () => {
    for (const e of [...sceneOne, ...sceneTwo]) {
      const s = byEl.get(e);
      assert.ok(s?.length >= 2, e.cls);
      assert.equal(s[0].from.opacity, 0, `${e.cls} starts hidden`);
      assert.equal(s.at(-1).to.opacity, 0, `${e.cls} leaves`);
    }
  });

  it("in order: Wait Wait Wait -> the question -> it leaves -> What if… NO NO NO -> Let's check… OKAY -> it leaves", () => {
    const t = HUMAN_INTRO;
    assert.ok(t.waits[0] < t.waits[1] && t.waits[1] < t.waits[2] && t.waits[2] < t.words);
    const lastIn1 = Math.max(...sceneOne.map((e) => byEl.get(e)[0].end));
    const firstOut1 = Math.min(...sceneOne.map((e) => byEl.get(e).at(-1).start));
    assert.ok(lastIn1 < firstOut1, "the first scene is fully in before it leaves");
    const firstIn2 = Math.min(...sceneTwo.map((e) => byEl.get(e)[0].start));
    assert.ok(firstIn2 > firstOut1, "the second scene starts after the first one starts leaving");
    assert.ok(t.whatIf < t.nos[0] && t.nos[2] < t.lets && t.lets < t.okay && t.okay < t.out2);
    const lastIn2 = Math.max(...sceneTwo.map((e) => byEl.get(e)[0].end));
    const firstOut2 = Math.min(...sceneTwo.map((e) => byEl.get(e).at(-1).start));
    assert.ok(lastIn2 < firstOut2, "OKAY has landed before the second scene leaves");
  });

  it("pictures leave from the tilt they landed on (no snap to straight; review)", () => {
    for (const e of [...nos, ...parts[".hi-okay"]]) {
      const s = byEl.get(e);
      assert.equal(s.at(-1).from.transform, s[0].to.transform.replace(/scale\(1\) /, ""), e.cls);
    }
  });

  it("the whole lead-in takes under 13 s (slow, but not forever)", () => {
    const end = Math.max(...steps.map(([, d, , dur]) => d + dur));
    assert.ok(end > 9000 && end < 13000, String(end));
  });

  it("the page says what the user asked for", async () => {
    const { readFile } = await import("node:fs/promises");
    const html = (await readFile(new URL("../public/index.html", import.meta.url), "utf8")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const text of ["Wait Wait Wait…", "What if U are not a human?", "What if…", "NO NO NO!", "Let's check…", "OKAY", "Let's check if U are human or not", "Match the columns", "Drag each picture to the same one on the right"]) {
      assert.ok(html.includes(text), text);
    }
  });
});

describe("share NO on phones: smaller each tap, then gone (the user, 2026-11-07)", () => {
  it("1st tap: 'Don't do it!', 2nd: 'HAHA U can't!', 3rd: NO is gone", () => {
    assert.deepEqual(NO_TEASE, ["Don't do it!", "HAHA U can't!"]);
    assert.equal(NO_TAPS_TO_GO, 3);
    assert.deepEqual(squeezeStep(1), { level: 1, text: "Don't do it!", gone: false });
    assert.deepEqual(squeezeStep(2), { level: 2, text: "HAHA U can't!", gone: false });
    assert.deepEqual(squeezeStep(3), { level: 3, text: "HAHA U can't!", gone: true });
    assert.equal(squeezeStep(7).gone, true);
  });
});
