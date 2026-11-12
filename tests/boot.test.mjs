// The loading screen between the captcha and the game: how full the bar is, and what it says.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOOT, bootProgress, bootShown, bootStep } from "../public/js/boot.js";

describe("loading screen", () => {
  it("full only when the camera is on AND the trackers are loaded", () => {
    assert.equal(bootProgress({ camera: true, models: true, sinceMs: 0 }), 1);
    assert.ok(bootProgress({ camera: true, models: false, sinceMs: 1e9 }) < 1);
    assert.ok(bootProgress({ camera: false, models: true, sinceMs: 1e9 }) < 1);
  });

  it("creeps while waiting (never looks stuck) but never reaches the next milestone by itself", () => {
    const at = (ms) => bootProgress({ camera: false, models: false, sinceMs: ms });
    assert.ok(at(0) < at(1000) && at(1000) < at(5000));
    const camOn = bootProgress({ camera: true, models: false, sinceMs: 0 });
    assert.ok(at(1e9) < camOn, `${at(1e9)} vs ${camOn}`);
    // and the last block only lights up when everything is ready
    const cells = (p) => Math.floor(p * BOOT.cells + 1e-9);
    assert.ok(cells(bootProgress({ camera: true, models: false, sinceMs: 1e9 })) < BOOT.cells);
    assert.equal(cells(1), BOOT.cells);
  });

  it("takes at least 5 s, filling smoothly even when everything is ready at once (the user: at least 5 sec)", () => {
    assert.ok(BOOT.minMs >= 5000);
    assert.equal(bootShown(1, 0), 0);
    assert.ok(Math.abs(bootShown(1, BOOT.minMs / 2) - 0.5) < 1e-9);
    assert.equal(bootShown(1, BOOT.minMs), 1);
    assert.equal(bootShown(0.3, BOOT.minMs), 0.3); // never ahead of the real progress
    // the line follows the bar: "Ready!" only once the bar is full
    assert.equal(bootStep({ camera: true, models: true, waitingMs: 1000, shown: 0.2 }), "Opening the camera…");
    assert.equal(bootStep({ camera: true, models: true, waitingMs: 3000, shown: 0.6 }), "Loading hand & face tracking…");
    assert.equal(bootStep({ camera: true, models: true, waitingMs: 5000, shown: 1 }), "Ready!");
  });

  it("says what it is waiting for", () => {
    assert.equal(bootStep({ camera: false, models: false, waitingMs: 200 }), "Opening the camera…");
    assert.match(bootStep({ camera: false, models: true, waitingMs: 4000 }), /allow it if your browser asks/);
    assert.equal(bootStep({ camera: true, models: false, waitingMs: 0 }), "Loading hand & face tracking…");
    assert.equal(bootStep({ camera: true, models: true, waitingMs: 0 }), "Ready!");
  });
});
