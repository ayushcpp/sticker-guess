/**
 * The loading screen between the captcha and the game (the user asked 2026-11-07: "create the loading screen
 * in style so that system can load webcam or anything they need"). It stays until the camera is on and the
 * trackers are loaded, or until an error is shown in the camera box (then it gets out of the way so the error
 * and its Try again button can be seen).
 */
export const BOOT = {
  cells: 12, // blocks in the progress bar
  minMs: 5000, // shown at least this long (the user: "at least 5 sec"); the bar fills over this time
  readyMs: 450, // "Ready!" with a full bar before it leaves
  creepMs: 3000, // while waiting, the bar creeps on (never looks stuck), slower and slower
  leaveMs: 550,
};

/** How full the bar is, 0..1: two milestones (camera on, trackers loaded), creeping in between. */
export function bootProgress({ camera, models, sinceMs }, o = BOOT) {
  if (camera && models) return 1;
  const reached = 0.08 + (camera ? 0.46 : 0) + (models ? 0.46 : 0);
  // creeps at most 0.38: never reaches the next milestone (0.46 away) on its own
  return reached + 0.38 * (1 - Math.exp(-Math.max(0, sinceMs) / o.creepMs));
}

/**
 * How full the bar LOOKS: the real progress, but never faster than the minimum time (so even when everything is
 * ready at once, the bar fills smoothly over BOOT.minMs instead of jumping to full and waiting).
 */
export function bootShown(real, elapsedMs, o = BOOT) {
  return Math.min(real, Math.max(0, elapsedMs) / o.minMs);
}

/** The line under the bar, following the bar (`shown`) but never ahead of what is really done. */
export function bootStep({ camera, models, waitingMs, shown = 1 }) {
  if (!camera || shown < 0.45) {
    return !camera && waitingMs > 1500 ? "Opening the camera… allow it if your browser asks" : "Opening the camera…";
  }
  if (!models || shown < 1) return "Loading hand & face tracking…";
  return "Ready!";
}

/**
 * Shows the loading screen `el` while `work` (the camera starting) runs. `status()` returns
 * {camera, models, failed}. Resolves once the screen has left.
 */
export function runBoot(el, { work, status, reduced = false, o = BOOT }) {
  const cells = [...el.querySelectorAll(".boot-bar span")];
  const stepEl = el.querySelector(".boot-step");
  el.hidden = false;
  el.classList.remove("leaving");
  const t0 = performance.now();
  let finished = false;
  Promise.resolve(work).finally(() => (finished = true));
  let lastKey = "";
  let since = t0;
  let lastStep = null;
  return new Promise((resolve) => {
    const leave = () => {
      const done = () => {
        el.hidden = true;
        el.classList.remove("leaving");
        resolve();
      };
      if (reduced) return done();
      el.classList.add("leaving");
      setTimeout(done, o.leaveMs);
    };
    const tick = () => {
      const now = performance.now();
      const s = status();
      const key = `${!!s.camera}${!!s.models}`;
      if (key !== lastKey) {
        lastKey = key;
        since = now; // a milestone: the creep starts again from here
      }
      const real = s.failed ? 1 : bootProgress({ camera: s.camera, models: s.models, sinceMs: now - since }, o);
      const p = bootShown(real, now - t0, o);
      const n = Math.floor(p * cells.length + 1e-9);
      cells.forEach((c, i) => c.classList.toggle("on", i < n));
      const step = s.failed ? "" : bootStep({ camera: s.camera, models: s.models, waitingMs: now - t0, shown: p });
      if (step !== lastStep) stepEl.textContent = lastStep = step;
      if (finished && (s.failed || now - t0 >= o.minMs)) {
        // done (or failed: the camera box shows why): leave, after a moment of "Ready!" when it worked
        setTimeout(leave, s.failed || !(s.camera && s.models) ? 0 : o.readyMs);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
