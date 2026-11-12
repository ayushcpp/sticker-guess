// The screen cracking in the middle of the game: the crack geometry.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CRACK_TIMES, crackPaths, seeded } from "../public/js/cracks.js";

const coords = (d) => d.slice(1).split("L").map((p) => p.split(" ").map(Number));

describe("cracks", () => {
  for (const [w, h, cx, cy] of [[1366, 768, 600, 380], [390, 844, 200, 300], [1920, 1080, 1700, 200]]) {
    it(`stay on a ${w}x${h} screen and run out from the impact`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const paths = crackPaths(w, h, cx, cy, seeded(seed));
        assert.ok(paths.length >= 15, `seed ${seed}: only ${paths.length} lines`);
        const rays = paths.filter((p) => p.d.startsWith(`M${cx.toFixed(1)} ${cy.toFixed(1)}`));
        assert.ok(rays.length >= 9, `seed ${seed}: ${rays.length} cracks from the impact`);
        for (const p of paths) {
          for (const [x, y] of coords(p.d)) {
            assert.ok(x >= -0.05 && x <= w + 0.05 && y >= -0.05 && y <= h + 0.05, `seed ${seed}: ${x},${y} off screen`);
          }
          assert.ok(p.delay >= 0 && p.dur > 0 && p.width > 0);
        }
      }
    });
  }

  it("the same seed gives the same cracks (a test can check one exact pattern)", () => {
    assert.deepEqual(crackPaths(800, 600, 400, 300, seeded(7)), crackPaths(800, 600, 400, 300, seeded(7)));
  });

  it("the second impact starts later, and the siren page takes over after both", () => {
    const later = crackPaths(800, 600, 400, 300, seeded(2), { t0: CRACK_TIMES.second });
    assert.ok(later.every((p) => p.delay >= CRACK_TIMES.second));
    assert.ok(CRACK_TIMES.second < CRACK_TIMES.flash && CRACK_TIMES.flash < CRACK_TIMES.takeOver && CRACK_TIMES.takeOver < CRACK_TIMES.end);
  });
});
