/**
 * After the last level (the user asked 2026-11-07): two cute boxes, "Play Again" and "Comment". Comment opens a
 * paper note: rate the game (1-5 stars) and write a comment; at the bottom "Send" (emails it to the owner through
 * Web3Forms, like the shared details) and "Suggest a comment" (fills in a ready-made one). Nothing is sent
 * unless Send is pressed.
 */
import { post } from "./intro.js";

/** The first one is the user's own; the rest are mine (the user: "u can add some too"). */
export const COMMENT_SUGGESTIONS = [
  "WOW so much amazing 🤩",
  "The hamster stickers are SO cute 🐹💗",
  "Best game I've played today 😂",
  "My face hurts from making all these faces 😄",
  "10/10, would make faces at my webcam again ✨",
  "Certified human ✅ (the captcha said so)",
  "Who made this? Genius 🧠",
  "Please add more levels!! 🙏",
];

/**
 * What "Suggest a comment" does to the text box: an empty box (or one holding a suggestion) gets the next
 * suggestion; the player's own words are kept and a suggestion is added after them.
 */
export function suggestInto(text, list = COMMENT_SUGGESTIONS) {
  const t = text.trim();
  if (!t) return list[0];
  const i = list.indexOf(t);
  if (i >= 0) return list[(i + 1) % list.length];
  const extra = list.find((s) => !t.includes(s)) ?? list[0];
  return `${t} ${extra}`;
}

/** The email the owner gets. */
export function commentPayload({ name, rating, comment, accessKey }) {
  return {
    access_key: accessKey,
    subject: `Sticker Guess: ${rating ? `${rating}★ ` : ""}comment from ${name}`,
    from_name: "Sticker Guess",
    name,
    rating: rating ? `${rating} / 5` : "(not rated)",
    comment: comment.trim() || "(no comment)",
  };
}

/** Sends a comment. Resolves true only when Web3Forms confirms. */
export function sendComment({ name, rating, comment }, share, fetchImpl = globalThis.fetch) {
  return post(share, (accessKey) => commentPayload({ name, rating, comment, accessKey }), fetchImpl);
}

/**
 * Wires the win screen. `els`: {win, commentBtn, note, close, text, stars (fieldset), status, send, suggest}.
 * `getName()` gives the player's name.
 */
export function initFeedback({ els, share, getName, fetchImpl }) {
  const { win, commentBtn, note, close, text, stars, status, send, suggest } = els;
  let rating = 0;
  let sending = false;

  const say = (msg, kind = "") => {
    status.textContent = msg;
    status.className = "note-status" + (kind ? " " + kind : "");
  };
  const paintStars = () => {
    for (const label of stars.querySelectorAll("label")) {
      label.classList.toggle("on", +label.querySelector("input").value <= rating);
    }
  };
  const open = () => {
    win.classList.add("writing");
    note.hidden = false;
    say("");
    // a mouse: straight into the text; a touch screen: no keyboard popping up over the paper
    const first = matchMedia("(pointer: fine)").matches ? text : note.querySelector(".note-title");
    requestAnimationFrame(() => first.focus({ preventScroll: true }));
  };
  const shut = () => {
    note.hidden = true;
    win.classList.remove("writing");
    commentBtn.focus({ preventScroll: true });
  };

  commentBtn.addEventListener("click", open);
  close.addEventListener("click", shut);
  note.addEventListener("keydown", (e) => {
    if (e.key === "Escape") shut();
  });
  stars.addEventListener("change", (e) => {
    rating = +e.target.value || 0;
    paintStars();
    say("");
  });
  suggest.addEventListener("click", () => {
    text.value = suggestInto(text.value);
    say("");
  });
  note.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending) return;
    if (!rating && !text.value.trim()) {
      say("Pick some stars or write something first.", "warn");
      return;
    }
    sending = true;
    send.disabled = true;
    say("Sending…");
    const ok = await sendComment({ name: getName(), rating, comment: text.value }, share, fetchImpl);
    sending = false;
    send.disabled = false;
    if (!ok) {
      say("Couldn't send. Try again?", "warn");
      return;
    }
    say("Sent! Thank you 💗", "ok");
    text.value = "";
    rating = 0;
    for (const input of stars.querySelectorAll("input")) input.checked = false;
    paintStars();
    setTimeout(() => {
      if (!note.hidden) shut();
    }, 1400);
  });
}
