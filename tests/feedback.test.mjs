// After the last level: the comment paper (suggestions, rating, the email the owner gets).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMENT_SUGGESTIONS, commentPayload, sendComment, suggestInto } from "../public/js/feedback.js";

describe("comment paper", () => {
  it("the user's own suggestion comes first", () => {
    assert.match(COMMENT_SUGGESTIONS[0], /^WOW so much amazing/);
    assert.ok(COMMENT_SUGGESTIONS.length >= 5);
  });

  it("Suggest fills an empty box, then goes round the suggestions", () => {
    let t = suggestInto("");
    assert.equal(t, COMMENT_SUGGESTIONS[0]);
    t = suggestInto(t);
    assert.equal(t, COMMENT_SUGGESTIONS[1]);
    let last = COMMENT_SUGGESTIONS.at(-1);
    assert.equal(suggestInto(last), COMMENT_SUGGESTIONS[0]);
  });

  it("Suggest never throws away what the player wrote", () => {
    const t = suggestInto("loved it");
    assert.ok(t.startsWith("loved it "), t);
    assert.ok(COMMENT_SUGGESTIONS.some((s) => t.endsWith(s)));
  });

  it("the owner's email: name, stars, comment", () => {
    const p = commentPayload({ name: "Riya", rating: 4, comment: "  so cute  ", accessKey: "K" });
    assert.equal(p.access_key, "K");
    assert.equal(p.name, "Riya");
    assert.equal(p.rating, "4 / 5");
    assert.equal(p.comment, "so cute");
    assert.match(p.subject, /4★ comment from Riya/);
    const bare = commentPayload({ name: "Riya", rating: 0, comment: "", accessKey: "K" });
    assert.equal(bare.rating, "(not rated)");
    assert.equal(bare.comment, "(no comment)");
  });

  it("sends only with an access key, and reports Web3Forms' answer", async () => {
    let calls = 0;
    const fetchOk = async (url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body).rating, "5 / 5");
      return { ok: true, json: async () => ({ success: true }) };
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await sendComment({ name: "A", rating: 5, comment: "x" }, { endpoint: "e", accessKey: "" }, fetchOk), false);
      assert.equal(calls, 0);
      assert.equal(await sendComment({ name: "A", rating: 5, comment: "x" }, { endpoint: "e", accessKey: "K" }, fetchOk), true);
      assert.equal(calls, 1);
      const fetchNo = async () => ({ ok: true, json: async () => ({ success: false, message: "bad key" }) });
      assert.equal(await sendComment({ name: "A", rating: 5, comment: "x" }, { endpoint: "e", accessKey: "K" }, fetchNo), false);
    } finally {
      console.warn = warn;
    }
  });
});
