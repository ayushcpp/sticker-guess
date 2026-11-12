/**
 * Landing pages ("Sticker Guess"), the user's design (2026-11-07):
 *   PAGE 1  animated title + the cat + "YES — Continue to Game" / "NO" (NO -> 😝 + the bleh sticker, stays).
 *   PAGE 2  name (empty = "Priyanshii"), phone, date of birth, course, year, then the share YES / NO
 *           checkbox options side by side, and "Continue →".
 *   PAGE 3  "Reasoning Comprehension": silly questions (2+2, 123456789 backwards...) + open ones (an
 *           animal, a color), then "Continue to Game →".
 *  - Share YES sends the details (Web3Forms -> the owner's email), and only that box does: nothing is
 *    sent without a valid phone + date of birth. The page-3 answers go out (a second email) when
 *    leaving page 3, and only if share YES is ticked. Continue works without sharing.
 *  - Share NO can't be caught: when the cursor comes near (or a finger / Enter tries it) it waddles
 *    away (slow, bouncy, wobbling), and a message above it goes "Catch me!" -> "Try again!" ->
 *    "Keep trying!" -> "U can't win!" (then round again). The message stays up; it only changes.
 *
 * The geometry and form helpers are pure functions so they can be unit-tested in Node.
 */

/** The pointer may not get closer than this (px) to the No button's edge… */
export const KEEP_AWAY = 70;
/** …and when it does, No slides back to KEEP_AWAY + DODGE_SLACK, so it doesn't twitch on every pixel. */
export const DODGE_SLACK = 50;

/** Shortest distance from point (px, py) to a rectangle {left, top, right, bottom}. 0 if inside. */
export function distToRect(px, py, r) {
  const dx = Math.max(r.left - px, 0, px - r.right);
  const dy = Math.max(r.top - py, 0, py - r.bottom);
  return Math.hypot(dx, dy);
}

function overlaps(a, b) {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

/** Area shared by two rects (0 if they only touch or are apart). */
function overlapArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where the No button should slide to: the SHORTEST move that puts it at least
 * `keep + slack` px from the pointer, staying on screen, not stopping on anything
 * in `avoid` (the Yes button), and never sliding through or towards the pointer.
 * Moving straight away from the pointer is preferred over sideways moves.
 *
 * @param {{x:number,y:number}} pointer
 * @param {{left,top,right,bottom}} rect  where No is now (or is heading)
 * @returns {{x:number, y:number, jump?:true}} new top-left corner; jump = boxed in, so it goes to the
 *   NEAREST free spot that is far enough instead (don't glide there: the way across may pass the pointer)
 */
export function dodgeSpot({ pointer, rect, vw, vh, avoid = [], margin = 16, marginTop = margin, keep = KEEP_AWAY, slack = DODGE_SLACK }) {
  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;
  const want = keep + slack;
  const maxX = Math.max(margin, vw - margin - w);
  const maxY = Math.max(marginTop, vh - margin - h);
  // Start from an on-screen position (the window may have shrunk).
  const x0 = Math.min(Math.max(margin, rect.left), maxX);
  const y0 = Math.min(Math.max(marginTop, rect.top), maxY);
  const start = { left: x0, top: y0, right: x0 + w, bottom: y0 + h };
  const dNow = distToRect(pointer.x, pointer.y, start);
  if (dNow >= want) return { x: x0, y: y0 };
  // A spot is blocked by an avoid rect only if it overlaps it MORE than the start does: if NO already
  // touches a neighbour's padding (a tight layout), moving away from it must still be allowed.
  const startOverlap = avoid.map((a) => overlapArea(start, a));
  const blocked = (r) => avoid.some((a, i) => (startOverlap[i] > 0 ? overlapArea(r, a) > startOverlap[i] + 1e-6 : overlaps(r, a)));

  let ax = x0 + w / 2 - pointer.x;
  let ay = y0 + h / 2 - pointer.y;
  if (Math.hypot(ax, ay) < 1) ay = -1; // pointer exactly on the centre: hop up
  const away = Math.atan2(ay, ax);
  const reach = Math.hypot(vw, vh);
  const step = 3;

  // 0°, +10°, -10°, +20°, … around "straight away from the pointer", plus straight left / right / up /
  // down: in a tight column (YES above, Continue below) only a level sideways slide gets out.
  const offsets = [];
  for (let k = 0; k < 36; k++) offsets.push((k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 18));
  for (const axis of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) offsets.push(Math.atan2(Math.sin(axis - away), Math.cos(axis - away)));

  let best = null;
  for (const off of offsets) {
    const th = away + off;
    const dx = Math.cos(th);
    const dy = Math.sin(th);
    const cost = 1 + (1 - Math.cos(off)); // 1 = straight away … 3 = straight at the pointer
    for (let s = step; s <= reach; s += step) {
      const x = x0 + dx * s;
      const y = y0 + dy * s;
      if (x < margin || y < marginTop || x > maxX || y > maxY) break; // off screen this way
      const r = { left: x, top: y, right: x + w, bottom: y + h };
      // It may pass OVER YES / the inputs on its way (it's on top, so a click there still hits NO), but
      // it never stops on them.
      if (blocked(r)) continue;
      const d = distToRect(pointer.x, pointer.y, r);
      if (d < Math.min(dNow, keep) * 0.8) break; // this path passes too close to the pointer
      if (d >= want) {
        if (!best || s * cost < best.score) best = { x, y, score: s * cost };
        break;
      }
    }
  }
  if (best) return { x: best.x, y: best.y };
  return { ...nearestFreeSpot({ vw, vh, w, h, x0, y0, pointer, avoid, margin, marginTop, want }), jump: true }; // boxed in: rare
}

/**
 * Fallback when No is boxed in: of the on-screen spots (a 24 x 24 grid) that are far enough from the
 * pointer and clear of `avoid`, the one closest to where No is (no corner-to-corner trips); if there is
 * none, the spot farthest from the pointer.
 */
function nearestFreeSpot({ vw, vh, w, h, x0, y0, pointer, avoid, margin, marginTop = margin, want }) {
  const maxX = Math.max(margin, vw - margin - w);
  const maxY = Math.max(marginTop, vh - margin - h);
  const N = 24;
  let near = null;
  let far = { x: margin, y: marginTop, d: -1 };
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const x = margin + ((maxX - margin) * i) / N;
      const y = marginTop + ((maxY - marginTop) * j) / N;
      const r = { left: x, top: y, right: x + w, bottom: y + h };
      if (avoid.some((a) => overlaps(r, a))) continue;
      const d = distToRect(pointer.x, pointer.y, r);
      if (d > far.d) far = { x, y, d };
      if (d < want) continue;
      const move = Math.hypot(x - x0, y - y0);
      if (!near || move < near.move) near = { x, y, move };
    }
  }
  return near ? { x: near.x, y: near.y } : { x: far.x, y: far.y };
}

const inflate = (r, by) => ({ left: r.left - by, top: r.top - by, right: r.right + by, bottom: r.bottom + by });

/* ------------------------------------------------------------------ messages -- */
export const NO_MESSAGES = ["Catch me!", "Try again!", "Keep trying!", "U can't win!"];
/** A new try (after this long without running) gets the next message... */
export const NEW_ATTEMPT_MS = 900;
/** ...and during one long chase the message moves on after this long. */
export const MESSAGE_MS = 1600;
/** The message for the n-th try (0-based), going round. */
export const noMessage = (n) => NO_MESSAGES[((n % NO_MESSAGES.length) + NO_MESSAGES.length) % NO_MESSAGES.length];

/* ------------------------------------------------------------------- running -- */
/**
 * NO waddles (a slow, bouncy 0.7 s glide), so it has to start early and go far to stay out of reach:
 * it runs when the cursor is NO_KEEP px away, to NO_KEEP + NO_SLACK px, away from where the cursor
 * will be LOOKAHEAD_MS from now.
 */
export const NO_KEEP = 120;
export const NO_SLACK = 80;
export const LOOKAHEAD_MS = 250;
/** Padding kept around the inputs and the other boxes. Less than the 10 px gap between YES and NO. */
export const AVOID_PAD = 6;
/** Room kept above NO for its message. */
export const MSG_ROOM = 56;
/** Narrower than this (phones), there is no free space to run to: NO sidesteps along its own row to the
 *  edge of the screen and peeks in from there (PEEK = how much of it stays visible), side to side. */
export const NARROW = 600;

/**
 * Phones (the user, 2026-11-07: the running NO "is not moving well" on mobile): NO stays put instead. Each tap
 * makes it smaller and YES bigger, with a line under them; on the third tap NO is gone and only YES is left.
 */
export const NO_TEASE = ["Don't do it!", "HAHA U can't!"];
export const NO_TAPS_TO_GO = 3;
/** What the n-th tap on NO does on a phone: {level (1-3), text, gone}. */
export function squeezeStep(taps) {
  const level = Math.min(Math.max(taps, 1), NO_TAPS_TO_GO);
  return { level, text: NO_TEASE[Math.min(level, NO_TEASE.length) - 1], gone: level >= NO_TAPS_TO_GO };
}
export const PEEK = 0.45;

/**
 * Phone sidestep, in its own row: from its slot it slides out to peek in from the RIGHT screen edge (PEEK of it
 * visible), and from there it hops back into its slot. Never to the left: YES is on the left of the row and
 * NO would cover it. `home` = its slot (the placeholder), `w` = its width, `peeking` = out at the edge now.
 */
export function phoneSpot(home, w, vw, peeking, peek = PEEK) {
  return peeking ? { x: home.left, y: home.top } : { x: vw - w * peek, y: home.top };
}


/**
 * Where a moving cursor will be `ahead` ms from now (velocity from the previous sample; samples more
 * than 100 ms apart are ignored, and the look-ahead is capped at 400 px).
 */
export function projectPointer(prev, cur, ahead = LOOKAHEAD_MS) {
  if (!prev || !(cur.t > prev.t) || cur.t - prev.t > 100) return { x: cur.x, y: cur.y };
  const k = ahead / (cur.t - prev.t);
  const dx = (cur.x - prev.x) * k;
  const dy = (cur.y - prev.y) * k;
  const len = Math.hypot(dx, dy);
  const s = len > 400 ? 400 / len : 1;
  return { x: cur.x + dx * s, y: cur.y + dy * s };
}

/* ---------------------------------------------------------------------- form -- */
export const DEFAULT_NAME = "Priyanshii";

/** The name as typed, tidied (spaces collapsed, max 60 characters); empty -> DEFAULT_NAME. */
export function cleanName(raw, fallback = DEFAULT_NAME) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return s || fallback;
}

/** A phone number as typed -> "+919876543210" / "9876543210", or null if it isn't one (7-15 digits). */
export function cleanPhone(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\+?[\d\s\-().]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return (s.startsWith("+") ? "+" : "") + digits;
}

/** A date input's value ("YYYY-MM-DD") -> the same string if it's a real date between 1900 and today, else null. */
export function cleanDob(raw, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null; // e.g. 31 Feb
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  if (y < 1900 || date.getTime() > t) return null;
  return m[0];
}

/* --------------------------------------------------------------- quick questions -- */
/**
 * Page 3, "Reasoning Comprehension" (school-test style: the answer under each question). `options` =
 * multiple choice; no options = typed. `a` = the right answer (scored); without `a` it isn't scored.
 * `own` = the index of a "Write your own answer" option, which opens a text box. The user's wording:
 * 2+2 with 4 / 22 / I don't know; Q3 is 0+0 with the joke options; Q7 / Q8 the animal and the color.
 */
export const QUIZ = [
  { q: "2 + 2 = ?", options: ["4", "22", "I don't know"], a: "4" },
  { q: "1 + 1 = ?", options: ["2", "11", "I don't know"], a: "2" },
  { q: "0 + 0 = ?", options: ["I don't know", "I don't know", "I still don't know", "All of these", "Write your own answer"], own: 4 },
  { q: "Write 123456789 backwards", a: "987654321" },
  { q: "3 × 3 = ?", options: ["9", "33", "6", "I don't know"], a: "9" },
  { q: "What comes after 7?", options: ["8", "9", "I don't know"], a: "8" },
  { q: "Think of an animal and write it down" },
  { q: "Think of a color and write it down" },
];
export const DEFAULT_COURSE = "BCA AI DS";
const scored = (item) => item.a != null;

/** An answer as typed, compared loosely: spaces / commas / dots BETWEEN digits are ignored ("9 8 7…",
 *  "987,654,321" count), but a sign is not ("-4" is not 4; review). */
export function checkAnswer(typed, expected) {
  const norm = (v) => String(v ?? "").toLowerCase().trim().replace(/(?<=\d)[\s,._-]+(?=\d)/g, "");
  return norm(typed) !== "" && norm(typed) === norm(expected);
}

/** [{q, a | open}] + typed answers -> {lines, score, total}; open questions are listed but not scored. */
export function quizSummary(answers, quiz = QUIZ) {
  const lines = quiz.map((item, i) => {
    const typed = String(answers[i] ?? "").trim().slice(0, 40);
    const mark = !scored(item) ? "" : checkAnswer(typed, item.a) ? " ✓" : " ✗";
    return `${item.q.replace(" = ?", "")} -> ${typed || "(blank)"}${mark}`;
  });
  const score = quiz.filter((item, i) => scored(item) && checkAnswer(answers[i], item.a)).length;
  return { lines, score, total: quiz.filter(scored).length };
}

/* ---------------------------------------------------------------------- sending -- */
/** Email 1, sent by share YES on page 2: the details. Web3Forms emails these fields to the key's owner. */
export function sharePayload({ name, phone, dob, course = "", year = "", accessKey }) {
  return {
    access_key: accessKey,
    subject: `Sticker Guess: details shared by ${name}`,
    from_name: "Sticker Guess",
    name,
    phone,
    date_of_birth: dob,
    course: course || "(blank)",
    year: year || "(blank)",
  };
}

/** Email 2, sent when leaving page 3, only if share YES was confirmed on page 2: the reasoning answers. */
export function answersPayload({ name, answers = [], accessKey }) {
  const quiz = quizSummary(answers);
  return {
    access_key: accessKey,
    subject: `Sticker Guess: reasoning answers from ${name}`,
    from_name: "Sticker Guess",
    name,
    score: `${quiz.score} / ${quiz.total} right`,
    answers: quiz.lines.join(" | "),
  };
}

/** Sends the details (email 1). Resolves true only when Web3Forms confirms. */
export function sendDetails(details, share, fetchImpl = globalThis.fetch) {
  return post(share, (accessKey) => sharePayload({ ...details, accessKey }), fetchImpl);
}

/** Sends the reasoning answers (email 2). Resolves true only when Web3Forms confirms. */
export function sendAnswers({ name, answers }, share, fetchImpl = globalThis.fetch) {
  return post(share, (accessKey) => answersPayload({ name, answers, accessKey }), fetchImpl);
}

export async function post(share, makePayload, fetchImpl = globalThis.fetch) {
  if (!share?.accessKey) {
    console.warn("[sticker-guess] SHARE.accessKey is empty in public/js/config.js, so nothing was sent.");
    return false;
  }
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl && setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetchImpl(share.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(makePayload(share.accessKey)),
      keepalive: true, // finishes even if the page moves on to the game right away
      signal: ctrl?.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) console.warn("[sticker-guess] Web3Forms said:", res.status, json.message);
    return res.ok && json.success !== false;
  } catch (err) {
    console.warn("[sticker-guess] sending the details failed:", err);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------- pages -- */
/**
 * Wires up page 1 (title + "YES — Continue to Game" / "NO"), page 2 (the details form + share YES / NO)
 * and page 3 ("Reasoning Comprehension"). `els`: page 1 {playYes, playNo, playNoText, bleh}; page 2 {root
 * (the page-2 section, position: relative, at the page's top-left: NO's and the message's coordinates are
 * relative to it), layer, form, name, phone, dob, course, year, shareYes, shareNo, msg, status,
 * continueBtn}; page 3 {quizForm, quiz (the <ol> the questions go into), playBtn}.
 * Calls onNext() (1 -> 2), onDetailsDone() (2 -> 3) and onContinue(name) (3 -> the game), once each.
 */
export function initLanding({ els, share, onNext, onDetailsDone, onContinue }) {
  const { root, layer, form, name, phone, dob, course, year, shareYes, shareNo, msg, tease, status, continueBtn } = els;
  const { playYes, playNo, playNoText, bleh, quiz, quizForm, playBtn } = els;
  let target = null; // where share-NO is heading, in PAGE coordinates (null until it first runs)
  let placeholder = null;
  let peeking = false; // phones: out at the right edge (else in its slot)
  let attempts = 0;
  let lastRun = -Infinity;
  let msgShownAt = -Infinity;
  let sending = false;
  let sentKey = null;
  let leaving = false;
  let next = false;
  let toQuiz = false;

  const today = new Date();
  dob.max = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  for (const f of [form, quizForm]) f?.addEventListener("submit", (e) => e.preventDefault()); // Enter never submits anything

  // ---- page 3 questions: the question, then its answer under it (options or a box)
  const quizAnswers = QUIZ.map((item, i) => {
    const li = document.createElement("li");
    li.className = "q";
    quiz.append(li);
    const text = document.createElement("p");
    text.className = "q-text";
    text.id = `q-${i}`;
    text.textContent = item.q;
    if (scored(item)) {
      const tick = document.createElement("span");
      tick.className = "quiz-tick";
      tick.setAttribute("aria-hidden", "true");
      tick.textContent = "✓";
      text.append(" ", tick);
    }
    li.append(text);
    let own = null;
    const box = (label) => {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "q-input";
      input.autocomplete = "off";
      input.maxLength = 40;
      input.setAttribute("aria-labelledby", label);
      return input;
    };
    if (item.options) {
      const group = document.createElement("div");
      group.className = "q-options";
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-labelledby", text.id);
      item.options.forEach((opt, k) => {
        const label = document.createElement("label");
        label.className = "opt";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = `q-${i}`;
        radio.value = String(k);
        const span = document.createElement("span");
        span.textContent = opt;
        label.append(radio, span);
        group.append(label);
      });
      li.append(group);
      if (item.own != null) {
        own = box(text.id);
        own.hidden = true;
        li.append(own);
      }
      group.addEventListener("change", () => {
        const k = Number(group.querySelector("input:checked")?.value);
        if (own) {
          own.hidden = k !== item.own;
          if (!own.hidden) own.focus();
        }
        if (scored(item)) li.classList.toggle("right", item.options[k] === item.a);
      });
      return () => {
        const k = group.querySelector("input:checked")?.value;
        if (k == null) return "";
        return Number(k) === item.own ? own.value.trim() : item.options[Number(k)];
      };
    }
    const input = box(text.id);
    if (scored(item)) {
      input.inputMode = "numeric";
      input.addEventListener("input", () => li.classList.toggle("right", checkAnswer(input.value, item.a)));
    }
    li.append(input);
    return () => input.value.trim();
  });

  // ---- share-NO runs away
  const view = () => ({ vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight });
  // "page" coordinates = relative to root (which starts at the page's top-left)
  const origin = () => {
    const r = root.getBoundingClientRect();
    return { x: r.left, y: r.top };
  };
  const toView = (t) => {
    const o = origin();
    return { left: t.left + o.x, top: t.top + o.y, right: t.right + o.x, bottom: t.bottom + o.y };
  };
  const toPage = (v) => {
    const o = origin();
    return { left: v.left - o.x, top: v.top - o.y, right: v.right - o.x, bottom: v.bottom - o.y };
  };
  const others = [name, phone, dob, course, year, shareYes, continueBtn];
  const avoidRects = () => others.map((el) => inflate(el.getBoundingClientRect(), AVOID_PAD));

  function run(pointer, touch = false) {
    if (leaving) return;
    const drawn = shareNo.getBoundingClientRect();
    if (!target) {
      // First run: a dashed placeholder keeps the form from jumping, then NO is positioned on the page
      // (absolute, so it scrolls with the page) exactly where it was, same size.
      placeholder = document.createElement("div");
      placeholder.className = "choice-placeholder";
      placeholder.style.height = `${drawn.height}px`;
      // Same width too: in the side-by-side row an empty slot let YES stretch under the finger that had
      // just pressed NO, and the browser then delivered that tap's click to YES (e2e, phone).
      placeholder.style.width = `${drawn.width}px`;
      shareNo.before(placeholder);
      // Phones: NO stays in its own row, so open a gap above that row for the message (it would cover YES).
      if (touch || view().vw < NARROW) placeholder.style.marginTop = "40px";
      const slot = placeholder.getBoundingClientRect();
      target = toPage({ left: slot.left, top: slot.top, right: slot.left + drawn.width, bottom: slot.top + drawn.height });
      shareNo.style.width = `${drawn.width}px`;
      shareNo.style.left = `${target.left}px`;
      shareNo.style.top = `${target.top}px`;
      shareNo.classList.add("fleeing");
      layer.append(shareNo); // into the clipping layer, same spot on screen
      void shareNo.offsetWidth; // apply the start position before animating
    }
    const from = toView(target);
    const p = pointer ?? { x: (from.left + from.right) / 2, y: (from.top + from.bottom) / 2 };
    const { vw, vh } = view();
    const spot =
      touch || vw < NARROW
        ? phoneSpot(placeholder.getBoundingClientRect(), from.right - from.left, vw, peeking) // phones: no room to run
        : dodgeSpot({ pointer: p, rect: from, vw, vh, avoid: avoidRects(), marginTop: MSG_ROOM, keep: NO_KEEP, slack: NO_SLACK });
    if (touch || vw < NARROW) peeking = !peeking;
    const moved = spot.x !== from.left || spot.y !== from.top;
    if (moved) {
      shareNo.classList.remove("waddle", "poof");
      if (spot.jump) shareNo.classList.add("hop"); // boxed in: it pops up over there, no glide across
      const w = target.right - target.left;
      const h = target.bottom - target.top;
      target = toPage({ left: spot.x, top: spot.y, right: spot.x + w, bottom: spot.y + h });
      shareNo.style.left = `${target.left}px`;
      shareNo.style.top = `${target.top}px`;
      void shareNo.offsetWidth; // apply, then restart the animation
      shareNo.classList.remove("hop");
      shareNo.classList.add(spot.jump ? "poof" : "waddle");
    }
    const t = performance.now();
    if (t - lastRun > NEW_ATTEMPT_MS || t - msgShownAt > MESSAGE_MS) {
      msg.textContent = noMessage(attempts++);
      msgShownAt = t;
      msg.classList.remove("pop");
      void msg.offsetWidth;
      msg.classList.add("show", "pop"); // stays up from now on; only the text changes
    }
    placeMessage();
    lastRun = t;
  }

  function placeMessage() {
    if (!target) return;
    const { vw } = view();
    const ox = origin().x;
    const cx = (target.left + target.right) / 2 + ox; // on screen
    msg.style.left = `${Math.min(Math.max(cx, 80), vw - 80) - ox}px`; // stays on screen when NO peeks
    msg.style.top = `${target.top - 10}px`;
  }

  const nearestOther = (q) => Math.min(...others.map((el) => distToRect(q.x, q.y, el.getBoundingClientRect())));

  // ---- phones: NO shrinks, YES grows, then NO is gone (no running around: it didn't work well on a phone)
  const phoneMode = () => !target && (matchMedia("(pointer: coarse)").matches || view().vw < NARROW);
  const row = shareNo.parentElement;
  let noTaps = 0;
  function squeeze() {
    if (noTaps >= NO_TAPS_TO_GO) return;
    const step = squeezeStep(++noTaps);
    row.dataset.squeeze = String(step.level);
    shareYes.classList.remove("boing");
    void shareYes.offsetWidth; // restart its little bounce
    shareYes.classList.add("boing");
    if (tease) {
      tease.textContent = step.text;
      tease.hidden = false;
      tease.classList.remove("pop");
      void tease.offsetWidth;
      tease.classList.add("pop"); // stays up from now on; only the text changes
    }
    if (step.gone) {
      if (document.activeElement === shareNo) shareYes.focus({ preventScroll: true });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        shareNo.hidden = true;
        row.classList.add("yes-only");
      };
      shareNo.classList.add("gone");
      shareNo.addEventListener("animationend", finish, { once: true });
      setTimeout(finish, 600); // no animation (reduced motion): still gone
    }
  }

  let prev = null;
  root.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse" || phoneMode()) return; // fingers have no hover: they get caught on press below
      const cur = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      const ahead = projectPointer(prev, cur);
      prev = cur;
      const drawn = shareNo.getBoundingClientRect(); // where it is mid-waddle
      const heading = target ? toView(target) : drawn;
      const dist = (q) => Math.min(distToRect(q.x, q.y, drawn), distToRect(q.x, q.y, heading));
      const dNow = dist(cur);
      const dAhead = dist(ahead);
      if (Math.min(dNow, dAhead) >= NO_KEEP) return;
      // On YES (10 px above it) or another box, or headed for one rather than for NO: leave it alone.
      const oNow = nearestOther(cur);
      if (oNow === 0 || (oNow < dNow && nearestOther(ahead) <= dAhead)) return;
      run(dAhead < dNow ? ahead : { x: cur.x, y: cur.y });
    },
    { passive: true },
  );
  // A finger (or a mouse that got there anyway) pressing it: it runs instead.
  shareNo.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (phoneMode()) return; // phones: the tap's click below makes it smaller
    run({ x: e.clientX, y: e.clientY }, e.pointerType !== "mouse");
  });
  // Nothing ever selects it: a click (mouse, finger, Enter / Space) just makes it run again.
  shareNo.addEventListener("click", (e) => {
    e.preventDefault();
    if (phoneMode()) {
      squeeze(); // on the click (after the finger is up), so nothing moves under a tap still in progress
      return;
    }
    if (performance.now() - lastRun > 250) run(e.detail === 0 ? null : { x: e.clientX, y: e.clientY });
  });

  window.addEventListener("resize", () => {
    if (!target || !placeholder) return;
    // After a resize / rotation (or a phone toolbar showing / hiding): keep NO where it is on the PAGE, only
    // pulled back inside the page's width. If that now covers a field or a button, it goes back to its slot.
    const { vw } = view();
    const v = toView(target);
    const w = v.right - v.left;
    const h = v.bottom - v.top;
    const x = vw < NARROW
      ? Math.min(Math.max(-w * (1 - PEEK), v.left), vw - w * PEEK) // phones: at most peeking from an edge
      : Math.min(Math.max(16, v.left), Math.max(16, vw - w - 16));
    let next = { left: x, top: v.top, right: x + w, bottom: v.top + h };
    const hits = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    if (avoidRects().some((r) => hits(next, r))) {
      const slot = placeholder.getBoundingClientRect();
      next = { left: slot.left, top: slot.top, right: slot.left + w, bottom: slot.top + h };
      peeking = false;
    }
    target = toPage(next);
    shareNo.style.left = `${target.left}px`;
    shareNo.style.top = `${target.top}px`;
    placeMessage();
  });

  // ---- share-YES: the only thing that sends anything
  const details = () => ({
    name: cleanName(name.value),
    phone: cleanPhone(phone.value),
    dob: cleanDob(dob.value, today),
    course: course.value.replace(/\s+/g, " ").trim().slice(0, 60) || DEFAULT_COURSE, // nothing typed: "BCA AI DS"
    year: year.value,
  });
  const keyOf = (d) => JSON.stringify(d);
  const tickYes = (on) => {
    shareYes.classList.toggle("chosen", on);
    shareYes.setAttribute("aria-pressed", String(on));
  };
  /** Shared, and the boxes still hold exactly what was sent. */
  const shared = () => sentKey !== null && keyOf(details()) === sentKey;
  let sendPromise = null;
  for (const input of [name, phone, dob, course, year]) {
    const changed = () => {
      input.removeAttribute("aria-invalid");
      // YES is ticked exactly while the boxes hold what was sent (edited away: unticked; edited back: ticked).
      if (sentKey) tickYes(keyOf(details()) === sentKey);
    };
    input.addEventListener("input", changed);
    input.addEventListener("change", changed);
  }

  // YES only counts a press that STARTED on YES (or a keyboard press): a tap that began on NO, which then
  // ran away, must never turn into a YES click, whatever slides under the finger.
  let yesPressed = false;
  shareYes.addEventListener("pointerdown", () => (yesPressed = true));
  document.addEventListener("pointerdown", (e) => { if (!shareYes.contains(e.target)) yesPressed = false; }, true);

  shareYes.addEventListener("click", async (e) => {
    const fromKeyboard = e.detail === 0;
    if (!fromKeyboard && !yesPressed) return;
    yesPressed = false;
    const d = details();
    for (const [input, ok] of [[phone, d.phone], [dob, d.dob]]) {
      if (ok) input.removeAttribute("aria-invalid");
      else input.setAttribute("aria-invalid", "true");
    }
    if (!d.phone || !d.dob) {
      (d.phone ? dob : phone).focus();
      return;
    }
    const key = keyOf(d);
    if (sending) return;
    if (key === sentKey) {
      tickYes(true); // already sent exactly this: just show it
      return;
    }
    if (!share?.accessKey) {
      console.warn("[sticker-guess] SHARE.accessKey is empty in public/js/config.js, so nothing was sent.");
      status.textContent = "Sharing isn't set up yet.";
      status.hidden = false;
      return;
    }
    sending = true;
    status.hidden = true;
    shareYes.classList.add("sending");
    shareYes.setAttribute("aria-pressed", "true");
    sendPromise = sendDetails(d, share);
    const ok = await sendPromise;
    sending = false;
    shareYes.classList.remove("sending");
    if (ok) {
      sentKey = key;
      // ticked only if the boxes still hold what was sent (they may have been edited while sending)
      const same = keyOf(details()) === key;
      shareYes.classList.toggle("chosen", same);
      shareYes.setAttribute("aria-pressed", String(same));
    } else {
      shareYes.classList.remove("chosen");
      shareYes.setAttribute("aria-pressed", "false");
      status.textContent = "Couldn't send. Check your connection and press YES again.";
      status.hidden = false;
    }
  });

  // ---- page 2 -> page 3 (sharing is not needed for this)
  continueBtn.addEventListener("click", () => {
    if (toQuiz) return;
    toQuiz = true;
    leaving = true; // share NO stops running
    msg.classList.remove("show");
    onDetailsDone();
  });

  // ---- page 3 -> the game. The answers go out only if the details were shared on page 2 (and still hold
  // what was sent). If that send is still on its way, the answers wait for it (the game starts meanwhile).
  playBtn.addEventListener("click", () => {
    if (!toQuiz || playBtn.dataset.done) return;
    playBtn.dataset.done = "1";
    const who = cleanName(name.value);
    const answers = quizAnswers.map((get) => get());
    onContinue(who);
    if (!share?.accessKey) return;
    Promise.resolve(sendPromise)
      .catch(() => {})
      .then(() => {
        if (shared()) sendAnswers({ name: who, answers }, share); // keepalive: survives the page change
      });
  });

  // ---- page 1: YES goes on to the details; NO turns into 😝 + the sticker and stays (YES is the only way on)
  playYes.addEventListener("click", () => {
    if (next) return;
    next = true;
    onNext();
  });
  playNo.addEventListener("click", () => {
    if (playNo.classList.contains("bleh")) {
      // clicked again: the sticker pops once more
      bleh.style.animation = "none";
      void bleh.offsetWidth;
      bleh.style.animation = "";
      return;
    }
    playNoText.textContent = "😝";
    bleh.hidden = false;
    playNo.classList.add("bleh");
    playNo.setAttribute("aria-label", "No: bleh!");
  });
}

/* ----------------------------------------------------------------------- captcha -- */
/** Page 4 ("Only humans can answer this"): drag 5 pictures onto the same pictures; this many right passes. */
export const CAPTCHA_PASS = 2;

/** How many pictures sit on their own twin. `placed`: {slotId: stickerId}. */
export function captchaScore(placed) {
  return Object.entries(placed).filter(([slot, sticker]) => slot === sticker).length;
}

/** A shuffled copy (Fisher-Yates); `rand` returns [0, 1). */
export function shuffled(arr, rand = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Wires up the captcha. `items`: [{id, label, src}] (5 memes). `els`: {stickers (<ul>), slots (<ol>),
 * status, verify, refresh}. Left: 5 pictures. Right: the same 5 pictures, in another order. A picture from the
 * left is dropped straight onto a picture on the right (the user: "put the left side images to right where they
 * get matched"); it then sits on that picture's corner. Drag (mouse or finger), or tap / Enter a picture and
 * then one on the right. Calls onPass() once, after CAPTCHA_PASS or more are right.
 */
export function initCaptcha({ els, items, onPass }) {
  const { stickers, slots, status, verify, refresh } = els;
  const byId = new Map(items.map((it) => [it.id, it]));
  let placed = {}; // slotId -> stickerId
  let selected = null;
  let done = false;

  const say = (text, kind = "") => {
    status.textContent = text;
    status.className = "captcha-status" + (kind ? " " + kind : "");
  };
  const thumb = (it, alt = "") => {
    const img = document.createElement("img");
    img.src = it.src;
    img.alt = alt;
    img.draggable = false;
    return img;
  };

  function render() {
    const used = new Set(Object.values(placed));
    for (const li of stickers.children) {
      const id = li.dataset.id;
      li.classList.toggle("used", used.has(id));
      li.querySelector("button").classList.toggle("selected", selected === id);
    }
    for (const li of slots.children) {
      const row = li.querySelector(".captcha-slot");
      const on = li.querySelector(".captcha-placed");
      const id = placed[li.dataset.id];
      on.replaceChildren(...(id ? [thumb(byId.get(id))] : []));
      on.hidden = !id;
      row.classList.toggle("filled", !!id);
      const here = id ? `${byId.get(id).label} is on it (press to take it back)` : "nothing on it yet";
      row.setAttribute("aria-label", `${li.dataset.label}: ${here}`);
    }
  }

  function place(stickerId, slotId) {
    for (const [s2, st] of Object.entries(placed)) if (st === stickerId) delete placed[s2]; // moved from another slot
    placed[slotId] = stickerId; // a sticker already there goes back to the pile
    selected = null;
    say("");
    render();
  }

  let retry = null;
  function build() {
    clearTimeout(retry);
    placed = {};
    selected = null;
    stickers.replaceChildren(
      ...shuffled(items).map((it) => {
        const li = document.createElement("li");
        li.dataset.id = it.id;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "captcha-sticker";
        btn.setAttribute("aria-label", `${it.label}: pick it, then choose the same picture on the right`);
        btn.append(thumb(it));
        li.append(btn);
        dragBehaviour(btn, it.id);
        return li;
      }),
    );
    slots.replaceChildren(
      ...shuffled(items).map((it) => {
        const li = document.createElement("li");
        li.dataset.id = it.id;
        li.dataset.label = it.label;
        // the picture itself is the drop target; a dropped picture sits on its corner
        const row = document.createElement("button");
        row.type = "button";
        row.className = "captcha-slot";
        const on = document.createElement("span");
        on.className = "captcha-placed";
        on.hidden = true;
        row.append(thumb(it), on);
        row.addEventListener("click", () => {
          if (done) return;
          if (selected) place(selected, it.id);
          else if (placed[it.id]) {
            delete placed[it.id]; // take it back
            render();
          }
        });
        li.append(row);
        return li;
      }),
    );
    say("");
    render();
  }

  const pick = (id) => {
    selected = selected === id ? null : id;
    render();
  };

  /**
   * Drag with a mouse or a finger; a press released without moving is a tap (= pick it). The tap is read
   * from the pointer events themselves: right after a finger-drag the browser sometimes sends no click for
   * the next tap (e2e, phone), so a click is only used for the keyboard (Enter / Space).
   */
  function dragBehaviour(btn, id) {
    btn.addEventListener("click", (e) => {
      if (done || e.detail !== 0) return; // pointer taps are handled on pointerup below
      pick(id);
      if (selected) slots.querySelector(".captcha-slot")?.focus();
    });
    btn.addEventListener("pointerdown", (e) => {
      if (done || e.button > 0) return;
      const start = { x: e.clientX, y: e.clientY };
      let ghost = null;
      btn.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!ghost && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        if (!ghost) {
          const r = btn.getBoundingClientRect();
          ghost = btn.querySelector("img").cloneNode();
          ghost.className = "captcha-ghost";
          ghost.style.width = `${r.width}px`;
          ghost.style.height = `${r.height}px`;
          document.body.append(ghost);
          btn.classList.add("lifting");
        }
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".captcha-slot");
        for (const d of slots.querySelectorAll(".captcha-slot")) d.classList.toggle("over", d === over);
      };
      const up = (ev) => {
        btn.removeEventListener("pointermove", move);
        btn.removeEventListener("pointerup", up);
        btn.removeEventListener("pointercancel", up);
        btn.classList.remove("lifting");
        for (const d of slots.querySelectorAll(".captcha-slot")) d.classList.remove("over");
        if (!ghost) {
          if (ev.type === "pointerup" && !done) pick(id); // a tap
          return;
        }
        ghost.remove();
        const row = ev.type === "pointerup" && document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".captcha-slot");
        if (row) place(id, row.closest("li").dataset.id);
      };
      btn.addEventListener("pointermove", move);
      btn.addEventListener("pointerup", up);
      btn.addEventListener("pointercancel", up);
    });
  }

  verify.addEventListener("click", () => {
    if (done) return;
    if (Object.keys(placed).length < items.length) {
      say(`Place all ${items.length} pictures first.`, "warn");
      return;
    }
    if (captchaScore(placed) >= CAPTCHA_PASS) {
      done = true;
      say("✓ Verified", "ok");
      verify.disabled = true;
      setTimeout(onPass, 900);
    } else {
      say("Please try again.", "warn");
      retry = setTimeout(() => {
        if (!done) build();
      }, 900);
    }
  });
  refresh.addEventListener("click", () => {
    if (!done) build();
  });

  build();
}

/* ------------------------------------------------- captcha lead-in + entrance -- */
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)"; // quick start, long soft landing
const EASE_IN = "cubic-bezier(0.55, 0, 0.75, 0.25)"; // soft start, then away
const IN = [
  { opacity: 0, filter: "blur(12px)", transform: "translateY(22px) scale(0.92)" },
  { opacity: 1, filter: "blur(0px)", transform: "none" },
];
const OUT = [
  { opacity: 1, filter: "blur(0px)", transform: "none" },
  { opacity: 0, filter: "blur(10px)", transform: "translateY(-26px) scale(0.96)" },
];
/** Leaving while keeping a tilt of `deg` (no snap to straight as the exit starts; review 2026-11-07). */
const outTilted = (deg) => [
  { opacity: 1, filter: "blur(0px)", transform: `rotate(${deg}deg)` },
  { opacity: 0, filter: "blur(10px)", transform: `translateY(-26px) scale(0.96) rotate(${deg}deg)` },
];
const OKAY_TILT = -5;
/** A sticker popping in with a springy overshoot, landing tilted by `deg`. */
const pop = (deg) => [
  { opacity: 0, transform: `scale(0.3) rotate(${deg * 4}deg)` },
  { opacity: 1, transform: `scale(1.12) rotate(${-deg}deg)`, offset: 0.55 },
  { opacity: 1, transform: `scale(0.97) rotate(${deg}deg)`, offset: 0.8 },
  { opacity: 1, transform: `scale(1) rotate(${deg}deg)` },
];
/** The OKAY stamp: comes down from big, slams, settles tilted. */
const STAMP = [
  { opacity: 0, transform: "scale(2.3) rotate(-14deg)", filter: "blur(6px)" },
  { opacity: 1, transform: `scale(0.94) rotate(${OKAY_TILT}deg)`, filter: "blur(0px)", offset: 0.65 },
  { opacity: 1, transform: `scale(1) rotate(${OKAY_TILT}deg)`, filter: "blur(0px)" },
];
/** Shaking the head: no, no, no. */
const SHAKE = [
  { transform: "none" },
  { transform: "translateX(-6px) rotate(-7deg)", offset: 0.2 },
  { transform: "translateX(6px) rotate(7deg)", offset: 0.45 },
  { transform: "translateX(-4px) rotate(-4deg)", offset: 0.7 },
  { transform: "none" },
];

/**
 * The lead-in timeline in ms from the start, the user's wording (2026-11-07): "Wait Wait Wait… What if U are
 * not a human?", that leaves, then "What if… NO NO NO! Let's check… OKAY", that leaves, then the captcha.
 * Every step is timed from one start on the document timeline, so nothing drifts.
 */
export const HUMAN_INTRO = {
  waits: [400, 1050, 1700], // each "Wait", slowly
  words: 2500, // "What if U are not a human?", word by word
  wordStep: 130,
  swipe: 3500, // the highlighter under "not a human?"
  out1: 5300, // scene 1 leaves
  whatIf: 6200,
  nos: [6700, 7150, 7600],
  shake: 8450,
  lets: 8900,
  okay: 9500,
  out2: 10900, // scene 2 leaves
  outStep: 60,
};

/** Every animation of the lead-in, as [element, delay, keyframes, duration, easing]. Pure (tested). */
export function humanIntroSteps(root, t = HUMAN_INTRO) {
  const q = (sel) => [...root.querySelectorAll(sel)];
  const steps = [];
  const waits = q(".hi-wait");
  const words = q(".hi-word");
  const swipe = root.querySelector(".hi-swipe");
  waits.forEach((el, i) => steps.push([el, t.waits[i], IN, 1000, EASE_OUT]));
  words.forEach((el, i) => steps.push([el, t.words + i * t.wordStep, IN, 1000, EASE_OUT]));
  if (swipe) steps.push([swipe, t.swipe, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], 800, "cubic-bezier(0.65, 0, 0.35, 1)"]);
  // scene 1 leaves in reading order; the highlighter goes with "not"
  [...waits, ...words].forEach((el, i) => {
    steps.push([el, t.out1 + i * 45, OUT, 700, EASE_IN]);
    if (el === words[4] && swipe) steps.push([swipe, t.out1 + i * 45, [{ opacity: 1 }, { opacity: 0 }], 600, EASE_IN]);
  });

  const whatIf = root.querySelector(".hi-whatif");
  const nos = q(".hi-no");
  const lets = root.querySelector(".hi-lets");
  const okay = root.querySelector(".hi-okay");
  const tilt = [-5, 4, -3];
  if (whatIf) steps.push([whatIf, t.whatIf, IN, 900, EASE_OUT]);
  nos.forEach((el, i) => {
    steps.push([el, t.nos[i], pop(tilt[i % 3]), 850, "cubic-bezier(0.2, 0.7, 0.3, 1)"]);
    const pic = el.querySelector(".hi-pic");
    if (pic) steps.push([pic, t.shake + i * 40, SHAKE, 750, "ease-in-out"]);
  });
  if (lets) steps.push([lets, t.lets, IN, 900, EASE_OUT]);
  if (okay) steps.push([okay, t.okay, STAMP, 700, "cubic-bezier(0.5, 0, 0.2, 1)"]);
  const leaving = [[whatIf, 0], ...nos.map((el, i) => [el, tilt[i % 3]]), [lets, 0], [okay, OKAY_TILT]].filter(([el]) => el);
  leaving.forEach(([el, deg], i) => steps.push([el, t.out2 + i * t.outStep, deg ? outTilted(deg) : OUT, 750, EASE_IN]));
  return steps;
}

/**
 * Plays the lead-in on `root` (#human-intro). Resolves when the last text has left. With reduced motion the
 * same rhythm is kept, but things only fade (nothing moves, blurs or shakes).
 */
export function playHumanIntro(root, { reduced = false } = {}) {
  if (typeof root.animate !== "function") return Promise.resolve();
  const seen = new Set();
  const anims = humanIntroSteps(root).map(([el, delay, frames, duration, easing]) => {
    // Only an element's FIRST animation fills backwards (holds its start while waiting). A later one that did
    // would win over the first (later animations are on top) and show the element before its time.
    let fill = seen.has(el) ? "forwards" : "both";
    seen.add(el);
    if (reduced) {
      const first = frames[0].opacity;
      const last = frames.at(-1).opacity;
      if (first == null && last == null) {
        frames = [frames.at(-1), frames.at(-1)]; // a move only: jump to its end, at its own time
        fill = "forwards"; // (filling backwards would show it from the start: the highlighter alone on a blank page)
      }
      else frames = [{ opacity: first ?? 1 }, { opacity: last ?? 1 }];
      duration = Math.min(duration, 500);
      easing = "ease";
    }
    return el.animate(frames, { delay, duration, easing, fill });
  });
  const end = Math.max(...anims.map((a) => a.effect.getComputedTiming().endTime));
  // wait for the whole timeline (not each promise: a cancelled one must not stall the page)
  return new Promise((resolve) => setTimeout(resolve, end + 120)).then(() => {
    for (const a of anims) a.cancel();
  });
}

/** The captcha coming in after the lead-in: heading, then the box, then its rows one by one. */
export function revealCaptcha(page, { reduced = false } = {}) {
  if (typeof page.animate !== "function") return;
  const go = (el, delay, frames, duration) => {
    if (!el) return;
    if (reduced) frames = [{ opacity: 0 }, { opacity: 1 }];
    const a = el.animate(frames, { delay, duration, easing: EASE_OUT, fill: "backwards" });
    a.finished.then(() => a.cancel(), () => {});
  };
  go(page.querySelector(".captcha-heading"), 0, IN, 900);
  go(page.querySelector(".captcha"), 180, [
    { opacity: 0, transform: "translateY(36px) scale(0.97)" },
    { opacity: 1, transform: "none" },
  ], 900);
  const rows = [...page.querySelectorAll(".captcha-stickers li, .captcha-slots li")];
  rows.forEach((el, i) => go(el, 420 + (i % 5) * 70, [
    { opacity: 0, transform: "translateY(10px)" },
    { opacity: 1, transform: "none" },
  ], 600));
}
