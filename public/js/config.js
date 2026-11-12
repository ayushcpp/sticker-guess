/**
 * ============================================================================
 *  MEME MAP — the one file you edit to change which meme shows when.
 * ============================================================================
 *
 * Each trigger has a list of `images` (files inside public/memes/). When the
 * trigger fires, one of its images is picked at random (never the same one
 * twice in a row when there are several).
 *
 * An image can be a plain filename, or an object with options:
 *   { file: "x.jpeg", chromaKey: true }  remove a green-screen background
 *   { file: "x.jpeg", fit: "cover" }     fill the meme box (crop) instead of fitting inside it
 *   { file: "x.jpeg", rotate: 180 }      show the image turned (90 / 180 / 270 degrees)
 *
 * If `images` is empty, the app looks for public/memes/<id>.png/.jpg/.jpeg/.webp/.gif.
 *
 * Priority when several things happen at once:
 *   hand gesture  >  close-up (lean in)  >  head turn / tilt  >  face expression
 * When nothing is detected, no meme is shown.
 *
 * `kind` tells the app what detects it: "hand", "face", "head" or "closeup".
 * To disable a trigger, delete its entry.
 */
export const MEMES = [
  // ---- hand gestures (single hand) -------------------------------------------
  {
    id: "point", kind: "hand", emoji: "☝️", label: "Point", hint: "Only the index finger up",
    // nerd.jpg: the user finds it hard to tell apart, so it is the very last level ("late")
    images: ["🤣🫵.jpeg", "index up glasses.png", { file: "nerd.jpg", late: true }],
  },
  {
    id: "shaka", kind: "hand", emoji: "🤙", label: "Shaka", hint: "Thumb + pinky out",
    images: ["Screenshot_2026_1107_140435.png", "Screenshot_2026_1107_140555.png"],
  },
  {
    id: "thumbs_up", kind: "hand", emoji: "👍", label: "Thumbs up", hint: "Fist, thumb pointing up",
    images: ["👍.jpeg", "thumb.jpg"],
  },
  {
    id: "thumbs_down", kind: "hand", emoji: "👎", label: "Thumbs down", hint: "Fist, thumb pointing down",
    images: ["hamster meme.jpeg", "thumbs down.jpg"],
  },
  {
    id: "rock", kind: "hand", emoji: "🤘", label: "Devil horns", hint: "Index + pinky up",
    images: ["Screenshot_2026_1107_140448.png"],
  },

  {
    id: "head", kind: "hand", needsFace: true, emoji: "🙆", label: "Hand on head", hint: "Put your hand on your head",
    images: ["Head.png"],
  },


  {
    id: "shush", kind: "hand", needsFace: true, emoji: "🤫", label: "Shush", hint: "One finger on your lips: shhh",
    images: ["Instagram.jpeg"],
  },
  {
    id: "hmm", kind: "hand", needsFace: true, emoji: "🤔", label: "Hmm", hint: "Rest your chin on your hand, thinking",
    images: ["Hmm_.jpeg"],
  },

  // ---- hand gestures (both hands) -----------------------------------------------
  {
    id: "flex", kind: "hand", emoji: "💪", label: "Flex", hint: "Show both biceps: two fists up, arms out",
    images: ["⏮️ Secret to the Perfect Buff Drawings Look 💋⏯️.jpeg"],
  },
  {
    id: "steeple", kind: "hand", emoji: "🙏", label: "Steeple", hint: "Touch your fingertips together in a triangle",
    images: ["steeple fingers.png"],
  },
  {
    id: "heart", kind: "hand", emoji: "🫶", label: "Heart hands", hint: "Both hands make a heart",
    images: ["almarts27 hamster sticker (2).jpeg"],
  },

  // ---- lean in -------------------------------------------------------------------
  {
    id: "closeup", kind: "closeup", emoji: "🔍", label: "Too close!", hint: "Lean in towards the screen",
    images: [{ file: "special.jpeg", fit: "cover" }],
  },

  // ---- head turn / tilt (face model; images from github.com/catherpiee/hammyhamster) --
  {
    id: "side_eye", kind: "head", emoji: "👀", label: "Side-eye", hint: "Turn your head to the side",
    images: ["sideyee.jpg"],
  },

  // ---- face expressions ----------------------------------------------------------
  {
    id: "scream", kind: "face", emoji: "😱", label: "Scream", hint: "Grab both ears and open your mouth wide",
    images: ["1119989001100151540.jpeg"],
  },
  {
    id: "laugh", kind: "face", emoji: "😂", label: "Laugh", hint: "Big smile, mouth open",
    images: ["Hampter.jpeg"],
  },
  {
    id: "smile", kind: "face", emoji: "😊", label: "Smile", hint: "Smile with your mouth closed",
    images: ["hamster smiling.jpeg", "smiling eyes.png"],
  },
];

/**
 * Meme hunt (game.js): the target meme is shown in a corner; make it at >= 60% accuracy for 0.4 s
 * to get the next one. Every picture is a level. `order` = the actions from EASY to HARD (the user:
 * "easy ones first"); an action's 2nd / 3rd picture comes a few levels after its first, and pictures
 * marked { late: true } come last. A hint line (the meme's `hint`) appears after hintAfterMs.
 */
export const GAME = {
  order: [
    "thumbs_up", "point", "smile", "thumbs_down", "shaka", "laugh", "rock", "side_eye", "closeup",
    "heart", "steeple", "shush", "hmm", "head", "flex", "scream",
  ],
  holdMs: 400,
  hintAfterMs: 8000,
  foundMs: 1200,
  // The surprise (the user, 2026-11-07): this long into the game, the screen cracks and the siren page with the
  // captcha takes over; after "Verified" the game carries on where it was.
  crackAfterMs: 7000,
};

/**
 * Landing page: where the phone number + date of birth go when YES is pressed (and only then).
 * Web3Forms (https://web3forms.com) emails them to you: create a free access key there with your
 * email address and paste it below. Empty = nothing can be sent (YES then says it couldn't send).
 */
export const SHARE = {
  endpoint: "https://api.web3forms.com/submit",
  accessKey: "70cdd5bb-cf34-487e-909e-c6e19311435a",
};

export const MEME_DIR = "memes/";
export const MEME_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];

/** Bundled locally (public/vendor, public/models) so the app doesn't depend on any CDN. */
export const MEDIAPIPE = {
  bundle: "vendor/mediapipe/vision_bundle.mjs",
  wasmDir: "vendor/mediapipe/wasm",
  /** MediaPipe GestureRecognizer: hand landmarks + trained gestures (thumbs up/down, victory, pointing…). */
  gestureModel: "models/gesture_recognizer.task",
  faceModel: "models/face_landmarker.task",
  /**
   * Run the face model at most every this many ms, and on two frames in a row
   * only when the loop has time to spare (slow camera; see main.js); hands run
   * on every frame. 30 fps camera -> face at 15 Hz; 8 fps camera on the GPU path -> 8 Hz.
   */
  faceEveryMs: 50,
};

/**
 * Camera request: 1280x720 (HD), what most webcams deliver natively, for a sharp picture. The models
 * scale every frame down to their own input size, so resolution barely matters for detection speed
 * (e2e: 640x480 vs 960x540 within ~1 ms/frame on both GPU and CPU paths). A camera that can't do
 * 720p gives its best instead ("ideal", not "exact").
 */
export const CAMERA = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

/**
 * Timings (ms) that make the meme quick but steady (see stabilizer.js):
 *   enterMs   a gesture / face must be held this long (in at least 70% of the
 *             frames, and 3 frames minimum) before its meme appears. A new
 *             gesture also REPLACES a meme that is up after enterMs.
 *             120 ms = 5 frames at 30 fps; 3 frames (250 ms) at 8 fps.
 *             e2e harness, camera frame -> meme on screen, median: 180 ms at
 *             30 fps on GPU, 295 ms at 8 fps (the old 300/700/250/1200 timings:
 *             387 ms and 421 ms, and >= 1.2 s to switch memes).
 *   exitMs    it must be gone this long before the meme disappears, so a few
 *             lost frames or a brief wrong label never blink the box.
 *   gapMs     tracking dropouts shorter than this don't restart a gesture that
 *             is being held (one dropped frame is always tolerated).
 *   minShowMs once a meme appears it stays at least this long (it can still be
 *             replaced by another meme right away; only hiding waits).
 */
export const STABILIZER = { enterMs: 120, exitMs: 500, gapMs: 200, minShowMs: 700 };
