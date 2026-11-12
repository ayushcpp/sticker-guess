/**
 * The surprise in the middle of the game (the user asked 2026-11-07): the screen suddenly cracks like glass,
 * flashes red, and the siren page (the captcha) takes over.
 *
 * crackPaths() is the geometry (pure, tested): crack lines running out from an impact point, side branches,
 * and the spider-web rings around the impact. playCracks() draws them as SVG, each line "growing" (its dash
 * offset animated, Web Animations), with a shake on every impact.
 */

/** Seeded random numbers (so a test can check one exact crack pattern). */
export function seeded(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/**
 * Crack lines from the impact (cx, cy) on a w x h screen. Returns [{d, delay, dur, width}] (SVG path data, when
 * it starts and how long it takes to grow, in ms; stroke width in px). Everything stays on the screen.
 */
export function crackPaths(w, h, cx, cy, rand = Math.random, { t0 = 0, scale = 1 } = {}) {
  const out = [];
  const inside = (x, y) => x >= 0 && y >= 0 && x <= w && y <= h;
  const pt = ([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`;
  const path = (pts) => "M" + pts.map(pt).join("L");
  const speed = 2.2; // px per ms: a crack runs across a laptop screen in about half a second
  const reach = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * scale;

  const rays = 9 + Math.floor(rand() * 4);
  const rayPts = [];
  for (let i = 0; i < rays; i++) {
    const base = (i / rays) * Math.PI * 2 + (rand() - 0.5) * ((Math.PI * 2) / rays) * 0.7;
    const len = reach * (0.45 + rand() * 0.65);
    const pts = [[cx, cy]];
    let x = cx;
    let y = cy;
    let r = 0;
    while (r < len) {
      const step = 14 + rand() * 40;
      const ang = base + (rand() - 0.5) * 0.45;
      const nx = x + Math.cos(ang) * step;
      const ny = y + Math.sin(ang) * step;
      if (!inside(nx, ny)) {
        // run to the edge and stop there
        const k = Math.min(...[nx < 0 ? x / (x - nx) : 1, ny < 0 ? y / (y - ny) : 1, nx > w ? (w - x) / (nx - x) : 1, ny > h ? (h - y) / (ny - y) : 1]);
        pts.push([x + (nx - x) * k, y + (ny - y) * k]);
        break;
      }
      x = nx;
      y = ny;
      r += step;
      pts.push([x, y]);
    }
    rayPts.push({ base, pts });
    const length = pts.reduce((sum, p, j) => (j ? sum + Math.hypot(p[0] - pts[j - 1][0], p[1] - pts[j - 1][1]) : 0), 0);
    out.push({ d: path(pts), delay: t0 + rand() * 40, dur: Math.max(120, length / speed), width: 2.2 * scale + rand() });

    // side branches, starting when the main crack gets there
    let along = 0;
    for (let j = 1; j < pts.length - 1; j++) {
      along += Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
      if (along < 40 * scale || rand() > 0.22) continue;
      const side = rand() < 0.5 ? -1 : 1;
      const bLen = (30 + rand() * 130) * scale;
      const bp = [pts[j]];
      let bx = pts[j][0];
      let by = pts[j][1];
      let ang = base + side * (0.4 + rand() * 0.6);
      for (let r2 = 0; r2 < bLen; ) {
        const step = 10 + rand() * 25;
        ang += (rand() - 0.5) * 0.4;
        const nx = bx + Math.cos(ang) * step;
        const ny = by + Math.sin(ang) * step;
        if (!inside(nx, ny)) break;
        bx = nx;
        by = ny;
        r2 += step;
        bp.push([bx, by]);
      }
      if (bp.length > 1) out.push({ d: path(bp), delay: t0 + along / speed, dur: Math.max(80, bLen / speed), width: 1.2 * scale + rand() * 0.6 });
    }
  }

  // spider-web rings around the impact: short segments between neighbouring cracks
  for (const ringR of [(26 + rand() * 18) * scale, (70 + rand() * 50) * scale, (150 + rand() * 80) * scale]) {
    for (let i = 0; i < rays; i++) {
      if (rand() < 0.3) continue;
      const a = pointAt(rayPts[i].pts, ringR);
      const b = pointAt(rayPts[(i + 1) % rays].pts, ringR * (0.85 + rand() * 0.3));
      if (!a || !b) continue;
      // sags a little toward the impact, like real glass
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      const sag = 0.82 + rand() * 0.12;
      const m = [cx + (mx - cx) * sag, cy + (my - cy) * sag];
      out.push({ d: path([a, m, b]), delay: t0 + ringR / speed, dur: 90 + rand() * 60, width: 1 * scale + rand() * 0.5 });
    }
  }
  return out;
}

/** The point `r` px along a polyline (null if it is shorter). */
function pointAt(pts, r) {
  let left = r;
  for (let j = 1; j < pts.length; j++) {
    const seg = Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
    if (left <= seg) {
      const k = left / seg;
      return [pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * k, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * k];
    }
    left -= seg;
  }
  return null;
}

const SVG = "http://www.w3.org/2000/svg";

/** The whole crack scene, in ms from the start. */
export const CRACK_TIMES = { second: 650, flash: 1250, takeOver: 1900, end: 2500 };

/**
 * Plays the cracks on `el` (#cracks, full-screen). `shake(el)` is called on every impact (to shake the game).
 * `onTakeOver()` is called when the siren page should appear (the cracks then fade out over it). Resolves when
 * done. Reduced motion: the cracks just appear, no shaking or flashing.
 */
export function playCracks(el, { shake = () => {}, onTakeOver = () => {}, reduced = false, rand = Math.random } = {}) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("class", "cracks-svg");
  const t = CRACK_TIMES;
  const hits = [
    { x: w * (0.3 + rand() * 0.4), y: h * (0.3 + rand() * 0.35), t0: 0, scale: 1 },
    { x: w * (rand() < 0.5 ? 0.12 + rand() * 0.2 : 0.68 + rand() * 0.2), y: h * (0.2 + rand() * 0.6), t0: t.second, scale: 0.7 },
  ];
  const anims = [];
  for (const hit of hits) {
    // the bright crushed spot where it was hit
    const spot = document.createElementNS(SVG, "circle");
    spot.setAttribute("cx", hit.x);
    spot.setAttribute("cy", hit.y);
    spot.setAttribute("r", 16 * hit.scale);
    spot.setAttribute("class", "crack-spot");
    svg.append(spot);
    if (!reduced) {
      anims.push(spot.animate([{ opacity: 0, transform: "scale(0.2)" }, { opacity: 1, transform: "scale(1)" }], {
        delay: hit.t0, duration: 160, easing: "ease-out", fill: "both",
      }));
    }
    for (const c of crackPaths(w, h, hit.x, hit.y, rand, { t0: hit.t0, scale: hit.scale })) {
      for (const cls of ["crack-shade", "crack-line"]) {
        const p = document.createElementNS(SVG, "path");
        p.setAttribute("d", c.d);
        p.setAttribute("pathLength", "1");
        p.setAttribute("class", cls);
        p.style.strokeWidth = String(cls === "crack-shade" ? c.width + 1.6 : c.width);
        svg.append(p);
        if (!reduced) {
          anims.push(p.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], {
            delay: c.delay, duration: c.dur, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)", fill: "both",
          }));
        }
      }
    }
  }
  el.replaceChildren(svg);
  el.classList.toggle("reduced", reduced);
  el.hidden = false;
  if (!reduced) {
    for (const hit of hits) setTimeout(() => shake(hit.scale), hit.t0);
    anims.push(el.animate([
      { backgroundColor: "rgb(255 0 30 / 0)" },
      { backgroundColor: "rgb(255 0 30 / 0.5)", offset: 0.25 },
      { backgroundColor: "rgb(255 0 30 / 0.15)", offset: 0.5 },
      { backgroundColor: "rgb(255 0 30 / 0.55)", offset: 0.75 },
      { backgroundColor: "rgb(255 0 30 / 0.3)" },
    ], { delay: t.flash, duration: t.takeOver - t.flash, easing: "ease-in-out", fill: "forwards" }));
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      onTakeOver();
      const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: t.end - t.takeOver, easing: "ease-in", fill: "forwards" });
      setTimeout(() => {
        for (const a of anims) a.cancel();
        fade.cancel();
        el.hidden = true;
        el.replaceChildren();
        resolve();
      }, t.end - t.takeOver + 30);
    }, reduced ? 700 : t.takeOver);
  });
}
