import { CAMERA, GAME, MEDIAPIPE, MEME_DIR, MEME_EXTENSIONS, MEMES, SHARE, STABILIZER } from "./config.js";
import { MemeHunt, targetScore } from "./game.js";
import { classifyFrame, handOnHead, isFlex, isHandAtChin, isHandsOnEars, isShush } from "./gestures.js";
import { PriorityStabilizer } from "./stabilizer.js";
import { initCaptcha, initLanding, playHumanIntro, revealCaptcha } from "./intro.js";
import { runBoot } from "./boot.js";
import { initFeedback } from "./feedback.js";
import { playCracks } from "./cracks.js";
import {
  blendshapeMap,
  CloseupDetector,
  ExpressionTracker,
  expressionSignals,
  faceWidth,
  headPose,
  HeadPoseTracker,
} from "./face.js";

// ---------------------------------------------------------------- DOM ----
const $ = (id) => document.getElementById(id);
const els = {
  stage: $("stage"),
  video: $("video"),
  hands: $("hands"),
  gate: $("gate"),
  gateMsg: $("gate-msg"),
  startBtn: $("start-btn"),
  cameraSelect: $("camera-select"),
  meme: $("meme"),
  memeImg: $("meme-img"),
  loading: $("loading"),
  target: $("target"),
  targetImg: $("target-img"),
  targetStage: $("target-stage"),
  targetPct: $("target-pct"),
  targetFill: $("target-fill"),
  targetHint: $("target-hint"),
  win: $("win"),
  stickers: $("stickers"),
  stickerList: $("sticker-list"),
  stickersCount: $("stickers-count"),
  againBtn: $("again-btn"),
  note: $("note"),
  intro: $("intro"),
  details: $("details"),
  reasoning: $("reasoning"),
  captcha: $("captcha"),
  app: $("app"),
  boot: $("boot"),
  cracks: $("cracks"),
  play: document.querySelector(".play"),
};

const MEME_BY_ID = new Map(MEMES.map((m) => [m.id, m]));
/** A trigger is live if it is in config.js and at least one of its images exists (unknown until loaded). */
const enabled = (id) => id != null && MEME_BY_ID.has(id) && state.pools.get(id)?.length !== 0;
const anyOfKind = (kind) => MEMES.some((m) => m.kind === kind);
const NEED_FACE = anyOfKind("face") || anyOfKind("closeup") || anyOfKind("head");

const state = {
  paused: false, // the siren page (captcha) is over the game: no detection, the game's clocks stop
  pausedAt: 0,
  warmAt: 0, // while paused: when the hand model last got a frame
  booting: false, // the loading screen is up: detection runs, the game hasn't started
  vision: null,
  fileset: null,
  hand: null, // GestureRecognizer (hand landmarks + MediaPipe's canned gestures)
  face: null, // FaceLandmarker (optional)
  backend: null, // "GPU" | "CPU"
  stream: null,
  running: false,
  pools: new Map(), // meme id -> [{src, fit, img}]
  lastPick: new Map(), // meme id -> index last shown
  stabilizer: new PriorityStabilizer(STABILIZER.enterMs, STABILIZER.exitMs, STABILIZER.gapMs, {
    minShowMs: STABILIZER.minShowMs,
  }),
  gpuTimes: [], // ms per frame while on GPU (to detect a too-slow GPU path)
  cpuFails: 0, // consecutive inference failures on CPU
  closeup: new CloseupDetector(),
  head: new HeadPoseTracker(), // head turned (side-eye) / tilted down
  expressions: new ExpressionTracker(), // classifyExpression + "mouth held wide open = scream"
  shown: undefined, // meme id on screen, or null for none
  lastVideoTime: -1,
  lastTs: 0,
  frameToken: 0,
  lastFace: null, // {width, signals, pose} | null — the face model's latest result
  faceBox: null, // {left, right, top, brow, chin, t}: where the face last was (for "hand on head")
  lastFaceTs: -Infinity, // when the face model last ran
  faceRanLast: false, // whether it ran on the previous frame
  prevFrameTs: 0, // timestamp of the previous processed frame
  frameGapMs: 0, // average time between processed frames (camera rate, or our own speed if slower)
  handMs: 0, // average hand-model time per frame
  faceMs: 0, // average face-model time per run
  ar: "", // aspect ratio last applied to the stage
  perf: { since: 0, frames: 0, ms: 0, faceRuns: 0 }, // console-only timing summary
  playerName: "Priyanshii", // from the landing page's name box
  game: null, // MemeHunt, created on the first frame with the models ready
  gameView: {}, // what the target card shows now (to touch the DOM only on changes)
  stickerView: null, // what the sticker panel shows now
  levels: [], // [{id, file}]: one level per sticker (see buildLevels)
};

const abs = (path) => new URL(path, document.baseURI).href;

// ------------------------------------------------------------- memes ----
function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const memeUrl = (file) => MEME_DIR + file.split("/").map(encodeURIComponent).join("/");

/**
 * Removes a green-screen background (sets green pixels transparent, softens
 * the edges, removes green spill) and crops to the remaining subject.
 */
async function chromaKey(img) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const data = x.getImageData(0, 0, W, H);
  const p = data.data;
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0, n = 0; i < p.length; i += 4, n++) {
    const r = p[i];
    const g = p[i + 1];
    const b = p[i + 2];
    const spill = g - Math.max(r, b); // how much greener than the other channels
    let a = 255;
    if (spill > 70 && g > 90) a = 0;
    else if (spill > 25 && g > 60) a = Math.round(255 * (1 - (spill - 25) / 45));
    if (a < 255) {
      p[i + 3] = a;
      p[i + 1] = Math.max(r, b); // de-spill the semi-transparent edge
    }
    if (a > 60) {
      const px = n % W;
      const py = (n / W) | 0;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  x.putImageData(data, 0, 0);
  if (maxX < 0) return img.src; // nothing left — keep the original

  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.06);
  const sx = Math.max(0, minX - pad);
  const sy = Math.max(0, minY - pad);
  const sw = Math.min(W, maxX + pad + 1) - sx;
  const sh = Math.min(H, maxY + pad + 1) - sy;
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  out.getContext("2d").drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await new Promise((res) => out.toBlob(res, "image/png"));
  return blob ? URL.createObjectURL(blob) : out.toDataURL("image/png");
}

/** Resolves one image spec from config into {src, fit, transform}, or null if the file is missing. */
async function loadEntry(spec) {
  const s = typeof spec === "string" ? { file: spec } : spec;
  const img = await loadImage(memeUrl(s.file));
  if (!img) {
    console.warn(`Meme image not found: ${MEME_DIR}${s.file}`);
    return null;
  }
  let src = img.src;
  if (s.chromaKey) {
    try {
      src = await chromaKey(img);
    } catch (err) {
      console.warn(`Green-screen removal failed for ${s.file}:`, err);
    }
  }
  const turn = [90, 180, 270].includes(s.rotate) ? s.rotate : 0;
  // Decode now and keep the image referenced, so swapping memes never waits on a decode.
  const ready = src === img.src ? img : await loadImage(src);
  await ready?.decode?.().catch(() => {});
  return { file: s.file, src, fit: s.fit === "cover" ? "cover" : "contain", transform: turn ? `rotate(${turn}deg)` : "", img: ready };
}

async function loadPool(meme) {
  let entries = [];
  if (meme.images?.length) {
    entries = (await Promise.all(meme.images.map(loadEntry))).filter(Boolean);
  } else {
    for (const ext of MEME_EXTENSIONS) {
      const e = await loadEntry(`${meme.id}.${ext}`).catch(() => null);
      if (e) {
        entries.push(e);
        break;
      }
    }
  }
  state.pools.set(meme.id, entries);
}

async function loadMemes() {
  await Promise.all(MEMES.map(loadPool));
  // Re-render whatever is showing now that the images are known.
  const current = state.shown;
  state.shown = undefined;
  showMeme(current ?? null);
}

/** Picks an image for a trigger: random, but not the same one twice in a row. */
function pickEntry(id) {
  const pool = state.pools.get(id);
  if (!pool?.length) return null;
  if (pool.length === 1) return pool[0];
  const last = state.lastPick.get(id);
  let i = Math.floor(Math.random() * (pool.length - 1));
  if (i >= last) i++;
  state.lastPick.set(id, i);
  return pool[i];
}

// ------------------------------------------------------------- meme ----
/**
 * Shows the meme for a trigger id, or nothing (null / unknown id).
 * The meme box only exists on screen while something is detected: it pops in
 * when a trigger starts, swaps when the trigger changes, and fades out after.
 * All the "don't flicker" timing lives in the stabiliser (stabilizer.js), so
 * this renders every decision immediately — a new meme is never held back.
 */
function showMeme(id) {
  const key = enabled(id) ? id : null;
  if (key === state.shown) return;
  state.shown = key;
  // The meme being hunted pops up with the same picture as the card (scream has two).
  const entry = !key ? null : key === state.game?.target ? (levelEntry(state.game.index) ?? pickEntry(key)) : pickEntry(key);
  const box = els.meme;

  if (entry) {
    // Already on screen: swap the picture in place (no fade from transparent, which read as a blink).
    const swap = !box.hidden && !box.classList.contains("out");
    els.memeImg.src = entry.src;
    els.memeImg.alt = `${MEME_BY_ID.get(key).label} meme`;
    els.memeImg.style.objectFit = entry.fit;
    els.memeImg.style.transform = entry.transform;
    box.hidden = false;
    box.classList.remove("out");
    box.classList.toggle("swap", swap);
    box.style.animation = "none"; // restart the animation
    void box.offsetWidth;
    box.style.animation = "";
  } else if (!box.hidden) {
    box.classList.remove("swap");
    box.classList.add("out");
    // No fade-out to wait for (prefers-reduced-motion): hide right away.
    if (getComputedStyle(box).animationName === "none") hideMemeBox();
  }
}

function hideMemeBox() {
  if (!els.meme.classList.contains("out")) return;
  els.meme.hidden = true;
  els.meme.classList.remove("out");
  els.memeImg.removeAttribute("src");
}

// After the fade-out finishes, take the box off the screen entirely.
els.meme.addEventListener("animationend", hideMemeBox);

/** "Loading…" under the camera while the tracking models are still loading. */
function setLoading(on) {
  els.loading.hidden = !on;
}

// ------------------------------------------------------- hand skeleton ----
// The 21 hand landmarks joined finger by finger, drawn over the camera. The
// canvas sits exactly on the video (same box, same mirroring), so a landmark's
// normalised x / y maps straight onto it.
const HAND_LINKS = [
  [0, 1], [1, 2], [2, 3], [3, 4], // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // index
  [5, 9], [9, 10], [10, 11], [11, 12], // middle
  [9, 13], [13, 14], [14, 15], [15, 16], // ring
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17], // pinky + palm edge
];

function drawHands(hands) {
  const c = els.hands;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr);
  const h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const g = c.getContext("2d");
  g.clearRect(0, 0, w, h);
  if (!hands.length || !w || !h) return;
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const { landmarks: lm } of hands) {
    g.strokeStyle = "#22c55e"; // green lines (the user's choice)
    g.lineWidth = 3 * dpr;
    g.beginPath();
    for (const [a, b] of HAND_LINKS) {
      g.moveTo(lm[a].x * w, lm[a].y * h);
      g.lineTo(lm[b].x * w, lm[b].y * h);
    }
    g.stroke();
    g.fillStyle = "#bbf7d0";
    g.strokeStyle = "#15803d";
    g.lineWidth = 1.2 * dpr;
    for (const p of lm) {
      g.beginPath();
      g.arc(p.x * w, p.y * h, 3.2 * dpr, 0, 2 * Math.PI);
      g.fill();
      g.stroke();
    }
  }
}

// ------------------------------------------------------------ models ----
// GestureRecognizer = the hand landmark model + MediaPipe's trained gesture
// classifier (default "canned" options). gestures.js combines its labels with
// landmark rules for the gestures it doesn't know (shaka, rock, heart).
const handOptions = (delegate) => ({
  baseOptions: { modelAssetPath: abs(MEDIAPIPE.gestureModel), delegate },
  runningMode: "VIDEO",
  // Heart hands needs both. Cost: while only one hand is visible MediaPipe keeps
  // running its palm detector to find the 2nd one (e2e: +9 ms/frame on GPU,
  // +30 ms on CPU, vs numHands 1).
  numHands: 2,
  // Finding a NEW hand stays at 0.5: at 0.3 the palm detector found a hand in video frames with no
  // hand visible (2 of 129 frames) and a second copy of one hand (1). Keeping a hand it already
  // tracks is looser (0.4), so the second hand isn't dropped while it moves.
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.4,
  minTrackingConfidence: 0.4,
});
const faceOptions = (delegate) => ({
  baseOptions: { modelAssetPath: abs(MEDIAPIPE.faceModel), delegate },
  runningMode: "VIDEO",
  numFaces: 1,
  outputFaceBlendshapes: true,
  outputFacialTransformationMatrixes: true, // head turn / tilt
  minFaceDetectionConfidence: 0.5,
  minFacePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
});

async function createModels(delegate) {
  const { GestureRecognizer, FaceLandmarker } = state.vision;
  const hand = await GestureRecognizer.createFromOptions(state.fileset, handOptions(delegate));
  let face = null;
  if (NEED_FACE) {
    try {
      face = await FaceLandmarker.createFromOptions(state.fileset, faceOptions(delegate));
    } catch (err) {
      if (delegate === "GPU") {
        hand.close();
        throw err; // retry everything on CPU
      }
      console.warn("Face model unavailable — face triggers disabled:", err);
    }
  }
  if (!warmUp(hand, face) && delegate === "GPU") {
    hand.close();
    face?.close();
    throw new Error("GPU warm-up inference failed"); // retry everything on CPU
  }
  state.hand = hand;
  state.face = face;
  state.backend = delegate;
  state.gpuTimes = [];
  state.handMs = 0; // new backend: measure the model times afresh
  state.faceMs = 0;
  console.info(`[meme-cam] models ready: ${delegate} (gesture recognizer${face ? " + face" : ""})`);
}

/**
 * The first inference compiles shaders / sets up buffers (~0.5–2 s on a GPU).
 * Do it now, on a blank frame, while the start page is still up, instead of on
 * the user's first camera frames. Returns false if inference doesn't work.
 */
function warmUp(hand, face) {
  try {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 240;
    c.getContext("2d").fillRect(0, 0, c.width, c.height);
    const ts = nextTimestamp();
    hand.recognizeForVideo(c, ts);
    face?.detectForVideo(c, ts);
    return true;
  } catch (err) {
    console.warn("Model warm-up inference failed:", err);
    return false;
  }
}

/** detectForVideo / recognizeForVideo need strictly increasing timestamps. */
function nextTimestamp() {
  let ts = performance.now();
  if (ts <= state.lastTs) ts = state.lastTs + 1;
  state.lastTs = ts;
  return ts;
}

/**
 * Runs the hand model on one frame. Returns the HAND CONTRACT of gestures.js:
 * [{landmarks, worldLandmarks, handedness, canned: {name, score} | undefined}]
 */
function detectHands(video, ts) {
  const r = state.hand.recognizeForVideo(video, ts);
  const handedness = r.handedness ?? r.handednesses;
  return r.landmarks.map((landmarks, i) => {
    const top = r.gestures?.[i]?.[0];
    return {
      landmarks,
      worldLandmarks: r.worldLandmarks?.[i],
      handedness: handedness?.[i]?.[0]?.categoryName,
      canned: top ? { name: top.categoryName, score: top.score } : undefined,
    };
  });
}

/**
 * MediaPipe needs WebGL even on its CPU path (frames are uploaded as textures).
 * Also detect software-only WebGL (no real GPU driver, VMs, remote desktop,
 * "hardware acceleration" switched off): there the GPU path is ~10x slower
 * than the CPU (WebAssembly) path, so go straight to CPU.
 */
function probeWebGL() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return { ok: false, software: false, renderer: "" };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    const software = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft warp/i.test(renderer);
    return { ok: true, software, renderer };
  } catch {
    return { ok: false, software: false, renderer: "" };
  }
}

async function loadModels() {
  const gl = probeWebGL();
  if (!gl.ok) {
    throw Object.assign(new Error("WebGL unavailable"), { name: "NoWebGL" });
  }
  state.vision = await import(abs(MEDIAPIPE.bundle));
  state.fileset = await state.vision.FilesetResolver.forVisionTasks(abs(MEDIAPIPE.wasmDir));
  if (gl.software) {
    console.info(`Software WebGL (${gl.renderer}) — using the faster CPU path.`);
    await createModels("CPU");
    return;
  }
  try {
    await createModels("GPU");
  } catch (err) {
    console.warn("GPU delegate unavailable, falling back to CPU:", err);
    await createModels("CPU");
  }
}

const MODEL_ERROR = (err) =>
  err?.name === "NoWebGL"
    ? "This browser has WebGL (graphics acceleration) turned off, which hand tracking needs. Turn on “Use hardware acceleration” in the browser settings, or try Chrome / Edge / Firefox."
    : "Couldn't load the tracking models. Check your connection and reload the page.";

let modelPromise = null;
/** Loads the models once; if loading failed, the next call retries. */
function ensureModels() {
  modelPromise ??= loadModels().catch((err) => {
    modelPromise = null;
    throw err;
  });
  return modelPromise;
}

let switchingToCpu = false;
async function switchToCpu(err) {
  if (switchingToCpu) return;
  switchingToCpu = true;
  console.warn("GPU inference failed, switching to CPU:", err);
  const old = [state.hand, state.face];
  state.hand = null;
  state.face = null;
  state.lastFace = null;
  for (const m of old) {
    try {
      m?.close();
    } catch {
      /* ignore */
    }
  }
  try {
    await createModels("CPU");
    switchingToCpu = false;
    // The face model may not come back on the CPU path: then the face memes can't be found any more.
    if (!state.face && state.game) {
      // same split as MemeHunt.retain: levels already found stay, the rest keep hand actions only
      const g = state.game;
      const before = g.index + (g.phase === "found" ? 1 : 0);
      state.levels = [...state.levels.slice(0, before), ...state.levels.slice(before).filter((l) => canDetect(l.id))];
      g.retain(canDetect);
      buildStickers(state.levels); // fewer levels now
    }
  } catch (e) {
    // Let "Try again" do a full reload of the models.
    modelPromise = null;
    switchingToCpu = false;
    stopCamera();
    showError("Couldn't start tracking on this device.", e);
  }
}

// ------------------------------------------------------------ camera ----
function describeCameraError(err) {
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera permission was blocked. Click the camera icon in the address bar, allow access, then press Try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera found. Plug in a webcam (or pick another one) and try again.";
    case "NotReadableError":
    case "AbortError":
      return "Your camera is busy — close other apps using it (Zoom, Meet, Teams, OBS…) and try again.";
    case "InsecureContext":
      return "The camera only works over HTTPS (or on localhost). Open the deployed https:// link instead.";
    default:
      return `Couldn't start the camera (${err?.name || "unknown error"}).`;
  }
}

function showError(message, err) {
  if (err) console.error(err);
  els.target.hidden = true; // nothing over the error message and its Try again button
  els.win.hidden = true;
  els.gate.hidden = false;
  els.gate.classList.add("error");
  els.gateMsg.textContent = message;
  els.startBtn.hidden = false;
  els.startBtn.disabled = false;
}

function stopStream() {
  const s = state.stream;
  state.stream = null;
  s?.getTracks().forEach((t) => t.stop());
}

async function populateCameras() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    const activeId = state.stream?.getVideoTracks()[0]?.getSettings().deviceId;
    els.cameraSelect.replaceChildren(
      ...devices.map((d, i) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `Camera ${i + 1}`;
        opt.selected = d.deviceId === activeId;
        return opt;
      }),
    );
    els.cameraSelect.hidden = devices.length < 2; // only shown when there is a choice to make
  } catch {
    els.cameraSelect.hidden = true;
  }
}

function resetDetection() {
  state.stabilizer.reset();
  state.closeup = new CloseupDetector();
  state.head = new HeadPoseTracker();
  state.expressions = new ExpressionTracker();
  state.lastFace = null;
  state.faceBox = null;
  state.lastFaceTs = -Infinity;
  state.prevFrameTs = 0; // the camera (and its frame rate) may have changed
  state.frameGapMs = 0;
  state.cpuFails = 0;
  state.lastVideoTime = -1;
  drawHands([]);
}

async function startCamera(deviceId) {
  els.startBtn.disabled = true;
  els.startBtn.hidden = true;
  els.gate.hidden = false;
  els.gate.classList.remove("error");
  els.gateMsg.textContent = "Opening the camera… (allow access if your browser asks)";
  state.running = false;
  const gen = ++state.frameToken; // any later start supersedes this call
  stopStream();
  let stream = null;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error("insecure context"), { name: "InsecureContext" });
    }
    const video = deviceId ? { ...CAMERA, deviceId: { exact: deviceId } } : { ...CAMERA, facingMode: "user" };
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    if (gen !== state.frameToken) {
      stream.getTracks().forEach((t) => t.stop()); // superseded while the camera was opening
      return;
    }
    state.stream = stream;
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (state.stream !== stream) return; // we replaced it ourselves
      stopCamera();
      showError("The camera was disconnected. Plug it back in and press Try again.");
    });
    els.video.srcObject = stream;
    await els.video.play();
    if (gen !== state.frameToken) return;
  } catch (err) {
    if (gen !== state.frameToken) {
      if (stream && stream !== state.stream) stream.getTracks().forEach((t) => t.stop());
      return;
    }
    stopStream();
    showError(describeCameraError(err), err);
    return;
  }

  populateCameras();
  els.gate.hidden = true;
  resetDetection();
  showMeme(null);
  state.running = true;
  scheduleNext(gen);

  if (!state.hand) {
    setLoading(true);
    try {
      await ensureModels();
    } catch (err) {
      if (gen !== state.frameToken) return;
      stopCamera();
      showError(MODEL_ERROR(err), err);
    } finally {
      setLoading(false);
    }
  }
}

/** Stops the camera after an error (the gate then offers "Try again"). */
function stopCamera() {
  state.running = false;
  els.target.hidden = true;
  els.win.hidden = true;
  state.frameToken++;
  stopStream();
  els.video.pause();
  els.video.srcObject = null;
  els.video.removeAttribute("src");
  resetDetection();
  showMeme(null);
}

/** Sizes the camera box to the camera's real aspect ratio (16:9, 4:3, portrait phones…). */
function fitStage() {
  const { videoWidth: w, videoHeight: h } = els.video;
  const ar = `${w} / ${h}`;
  if (w && h && ar !== state.ar) {
    state.ar = ar;
    els.app.style.setProperty("--ar", ar);
  }
}

// -------------------------------------------------------------- loop ----
const hasRVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;

function scheduleNext(token) {
  if (!state.running || token !== state.frameToken) return;
  const run = () => tick(token);
  if (hasRVFC) els.video.requestVideoFrameCallback(run);
  else requestAnimationFrame(run);
}

function tick(token) {
  if (!state.running || token !== state.frameToken) return;
  try {
    processFrame();
  } catch (err) {
    console.error(err);
  }
  scheduleNext(token);
}

function processFrame() {
  const v = els.video;
  if (v.readyState < 2 || !v.videoWidth) return;
  if (v.currentTime === state.lastVideoTime) return; // same frame as last time
  state.lastVideoTime = v.currentTime;
  fitStage();
  if (!state.hand) return;
  if (state.paused) {
    // The siren page is up: no game. The hand model still gets one frame a second, because on the CPU path a
    // long idle made the first frame after "Verified" block the page for seconds (review 2026-11-07).
    const now = performance.now();
    if (now - state.warmAt >= 1000) {
      state.warmAt = now;
      try {
        detectHands(v, nextTimestamp());
      } catch {
        /* only keeping it warm */
      }
    }
    return;
  }

  const ts = nextTimestamp();
  if (state.prevFrameTs && ts - state.prevFrameTs < 1000) state.frameGapMs = ema(state.frameGapMs, ts - state.prevFrameTs);
  state.prevFrameTs = ts;
  let hands;
  let faceResult = null;
  const t0 = performance.now();
  try {
    hands = detectHands(v, ts);
    drawHands(hands);
    const t1 = performance.now();
    state.handMs = ema(state.handMs, t1 - t0);
    // Hands run on every frame. The face model runs at most every faceEveryMs,
    // and normally on every other frame: expressions change slower than hands.
    // Measured (e2e harness, Radeon 610M laptop, 960x540): the face model on
    // every frame costs ~16 ms/frame on the GPU path (39 vs 23 ms without it),
    // on every other frame ~6 ms; on the CPU path every frame took the loop from
    // 68 to 78 ms/frame. So at a 30 fps camera it runs at 15 Hz.
    // When the frames come slowly enough that hands + face take <= 60% of the
    // time between frames (a dim room or slow webcam at 8-15 fps on the GPU
    // path), it also runs on consecutive frames: that costs no frames, and on a
    // fake 8 fps camera (GPU path) it cut the face meme latency from 426 to
    // 287 ms (median, 8 / 7 scream+smile memes; CPU path: 334 vs 341 ms, no
    // change). It does not rescue a borderline scream. The 40% left over keeps
    // the loop from falling behind the camera. At 30 fps faceEveryMs still means
    // every other frame, and a busy loop (e.g. the CPU path with a 30 fps
    // camera, 6.5-7 face runs/s at 13-14 frames/s) never qualifies.
    const spare = state.faceMs > 0 && state.handMs + state.faceMs <= 0.6 * state.frameGapMs;
    if (state.face && (spare || !state.faceRanLast) && ts - state.lastFaceTs >= MEDIAPIPE.faceEveryMs) {
      faceResult = state.face.detectForVideo(v, ts);
      state.faceMs = ema(state.faceMs, performance.now() - t1);
      state.lastFaceTs = ts;
      state.perf.faceRuns++;
    }
    state.faceRanLast = faceResult !== null;
    state.cpuFails = 0;
  } catch (err) {
    if (state.backend === "GPU") {
      switchToCpu(err);
    } else if (++state.cpuFails >= 10) {
      stopCamera();
      showError("Hand tracking keeps failing in this browser. Try updating it, or use Chrome / Edge / Firefox.", err);
    }
    return;
  }
  const ms = performance.now() - t0;
  logPerf(ms, ts);
  // Safety net: if the GPU path turns out to be very slow, the CPU path is faster.
  if (state.backend === "GPU" && state.gpuTimes.length < 20) {
    state.gpuTimes.push(ms);
    if (state.gpuTimes.length === 20) {
      const sorted = state.gpuTimes.slice(5).sort((a, b) => a - b); // skip warm-up frames
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median > 150) switchToCpu(new Error(`GPU inference too slow (${Math.round(median)} ms/frame)`));
    }
  }

  // ---- hands
  const frame = classifyFrame(hands, v.videoWidth, v.videoHeight);
  let gesture = frame.gesture;
  // Poses that depend on WHERE the hands are. A real gesture wins, except that a point at the mouth is a
  // shush. Face-relative ones use where the face was up to 4 s ago: hands near the face can stop the
  // face model finding it (it couldn't on Head.png even at 4x size), and the head barely moves meanwhile.
  if (hands.length) {
    const W = v.videoWidth;
    const H = v.videoHeight;
    const face = state.faceBox && ts - state.faceBox.t < 4000 ? state.faceBox : null;
    const free = !enabled(gesture);
    if ((free || gesture === "point") && enabled("shush") && isShush(frame.hands, face, W, H)) gesture = "shush";
    else if (free && enabled("flex") && isFlex(frame.hands)) gesture = "flex";
    // grab both ears + open the mouth = scream, straight away (an open mouth alone also screams, held ~0.4 s)
    else if (free && enabled("scream") && (state.lastFace?.signals?.jaw ?? 0) >= 0.3 && isHandsOnEars(frame.hands, face, W, H)) gesture = "scream";
    else if (free && enabled("hmm") && isHandAtChin(frame.hands, face, W, H)) gesture = "hmm";
    else if (free && face && handOnHead(hands, face, W, H)) gesture = "head";
  }
  const handTrigger = enabled(gesture) ? gesture : null;

  // ---- face (reuse the latest result on frames where the model didn't run)
  if (faceResult) {
    const lm = faceResult.faceLandmarks?.[0];
    if (lm) {
      let left = 1, right = 0;
      for (const p of lm) {
        if (p.x < left) left = p.x;
        if (p.x > right) right = p.x;
      }
      state.faceBox = {
        left, right, top: lm[10].y, brow: (lm[105].y + lm[334].y) / 2, chin: lm[152].y,
        mouth: { x: (lm[13].x + lm[14].x) / 2, y: (lm[13].y + lm[14].y) / 2 }, chinPt: { x: lm[152].x, y: lm[152].y },
        earL: { x: lm[234].x, y: lm[234].y }, earR: { x: lm[454].x, y: lm[454].y }, t: ts,
      };
    }
    state.lastFace = lm
      ? {
          width: faceWidth(lm),
          signals: expressionSignals(blendshapeMap(faceResult.faceBlendshapes?.[0])),
          pose: headPose(faceResult.facialTransformationMatrixes?.[0]),
        }
      : null;
  } else if (!state.face) state.lastFace = null;
  const face = state.lastFace;
  const isClose = state.closeup.update(face ? face.width : null, ts);
  state.head.hold = MEME_BY_ID.get(state.game?.target)?.kind === "head"; // see HeadPoseTracker.hold
  const headMove = state.head.update(face ? face.pose : null, ts);
  // The face meme currently confirmed by the stabiliser is passed in: face.js keeps that expression
  // while its signals stay near the threshold (hysteresis), so a borderline face doesn't blink the
  // meme. Only a CONFIRMED meme is held: holding any single-frame result turned a face with
  // mouthFrown ~0.18 (one frame at 0.21) into a steady "sad" in the e2e test.
  // ExpressionTracker also turns a mouth HELD wide open (~0.4 s) into a scream; called every frame.
  const expression = state.expressions.update(face ? face.signals : null, ts, state.stabilizer.face.current);

  // ---- priority: hand gesture > close-up > head turn / tilt > expression > nothing
  // (hand and face channels are debounced separately, then combined)
  let faceTrigger = null;
  if (isClose && enabled("closeup")) faceTrigger = "closeup";
  else if (enabled(headMove)) faceTrigger = headMove;
  else if (enabled(expression)) faceTrigger = expression;

  // hands.length: a hand still in view (even unrecognised) keeps its meme; once no hand is seen the
  // face meme can take over without waiting for the hand meme's exit time (stabilizer.js).
  const memeId = state.stabilizer.update(handTrigger, faceTrigger, ts, hands.length > 0);
  // Under the loading screen detection warms up, but the game doesn't start (no early hint, no level passed
  // unseen) and no meme pops up (review 2026-11-07).
  if (state.booting) return;

  // ---- game: how well this frame matches the meme to find
  state.game ??= newGame();
  const target = state.game.target;
  const score = target
    ? targetScore(target, {
        gesture,
        canned: hands.map((h) => h.canned),
        signals: face ? face.signals : null,
        expression,
        head: state.head.offset ? { active: headMove, ...state.head.offset } : null,
        closeup: { active: isClose, width: face ? face.width : 0, enter: state.closeup.thresholds()?.enter },
      })
    : 0;
  const snap = state.game.update(score, ts);
  renderGame(snap);
  showMeme(snap.phase === "won" ? null : memeId); // nothing pops up over the win card
}

// -------------------------------------------------------------- game ----
/** The memes to find, in GAME.order (then any others). Face memes only if the face model loaded. */
/** How many levels after an action's first picture its next picture comes. */
const PICTURE_SPREAD = 4;

/**
 * Every sticker is a level: {id (the action), file (its picture)}, easy to hard: by the action's place
 * in GAME.order, an action's k-th picture PICTURE_SPREAD * k places later, pictures marked
 * { late: true } at the very end; then no action twice in a row. Only actions detectable now.
 */
function buildLevels() {
  const ids = [...new Set([...GAME.order, ...MEMES.map((m) => m.id)])].filter((id) => enabled(id) && canDetect(id));
  const all = [];
  ids.forEach((id, rank) =>
    MEME_BY_ID.get(id).images.forEach((im, k) => {
      const file = typeof im === "string" ? im : im.file;
      all.push({ id, file, key: rank + PICTURE_SPREAD * k + (im.late ? 1000 : 0) });
    }),
  );
  all.sort((a, b) => a.key - b.key); // stable: ties keep GAME.order
  // the same action twice in a row: swap the second one with the next level of another action
  for (let i = 1; i < all.length; i++) {
    if (all[i].id !== all[i - 1].id) continue;
    const j = all.findIndex((l, k) => k > i && l.id !== all[i].id);
    if (j > 0) [all[i], all[j]] = [all[j], all[i]];
  }
  return all.map(({ id, file }) => ({ id, file }));
}

/** Whether this meme can be detected now: face memes (and hand memes that use the face, like a hand
 *  on the head) need the face model. */
function canDetect(id) {
  const m = MEME_BY_ID.get(id);
  return !!m && ((m.kind === "hand" && !m.needsFace) || !!state.face);
}

/** The loaded picture of level i (falls back to the action's first picture if that one failed to load). */
function levelEntry(i) {
  const l = state.levels[i];
  if (!l) return null;
  const pool = state.pools.get(l.id);
  return pool?.find((e) => e.file === l.file) ?? pool?.[0] ?? null;
}

function newGame() {
  state.levels = buildLevels();
  buildStickers(state.levels);
  return new MemeHunt(state.levels.map((l) => l.id), { holdMs: GAME.holdMs, hintAfterMs: GAME.hintAfterMs, foundMs: GAME.foundMs });
}

/** The sticker panel: one card per level, built once per game. */
function buildStickers(levels) {
  els.stickerList.replaceChildren(
    ...levels.map(({ id }, i) => {
      const li = document.createElement("li");
      li.className = "sticker-card locked";
      li.dataset.id = id;
      li.innerHTML = `<div class="sticker-thumb"><img alt="" /></div><span class="sticker-level">Level ${i + 1}</span>`;
      return li;
    }),
  );
  state.stickerView = { done: -1, current: -1, total: levels.length };
}

/**
 * Locked / current / unlocked from the game's progress: levels before the current one are unlocked,
 * and the current one unlocks the moment it is found. Touches the DOM only when that changes.
 */
function renderStickers(g) {
  const sv = state.stickerView;
  if (!sv) return;
  const done = g.phase === "won" ? g.total : g.index + (g.phase === "found" ? 1 : 0); // levels unlocked
  const current = g.phase === "play" ? g.index : -1;
  if (done === sv.done && current === sv.current) return;
  const cards = els.stickerList.children;
  for (let i = 0; i < cards.length; i++) {
    const li = cards[i];
    const unlocked = i < done;
    const label = MEME_BY_ID.get(li.dataset.id)?.label ?? "";
    if (unlocked && li.classList.contains("locked")) {
      li.classList.add("just"); // pop as it unlocks
      setTimeout(() => li.classList.remove("just"), 600);
    }
    li.classList.toggle("locked", !unlocked);
    li.classList.toggle("unlocked", unlocked);
    li.classList.toggle("current", i === current);
    li.setAttribute("aria-label", `Level ${i + 1}: ${unlocked ? `${label}, unlocked` : "locked"}`);
    const img = li.querySelector("img");
    if (!img.getAttribute("src")) {
      const entry = levelEntry(i); // the images may still be loading
      if (entry) {
        img.src = entry.src;
        img.style.transform = entry.transform;
      }
    }
  }
  if (current >= 0 && current !== sv.current) scrollIntoList(cards[current]);
  els.stickersCount.textContent = `${done} / ${sv.total}`;
  sv.done = done;
  sv.current = current;
}

/** Brings a card into view inside the sticker list only. scrollIntoView also scrolled the PAGE (review). */
function scrollIntoList(card) {
  if (!card) return;
  const list = els.stickerList;
  const lr = list.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  const dx = cr.left < lr.left ? cr.left - lr.left : cr.right > lr.right ? cr.right - lr.right : 0;
  const dy = cr.top < lr.top ? cr.top - lr.top : cr.bottom > lr.bottom ? cr.bottom - lr.bottom : 0;
  if (dx || dy) list.scrollBy({ left: dx, top: dy });
}

function renderGame(g) {
  els.stickers.hidden = false;
  renderStickers(g);
  const v = state.gameView;
  if (g.phase === "won") {
    els.target.hidden = true;
    if (els.win.hidden) els.win.hidden = false; // the two cute boxes (no message line: the user found it lame)
    v.target = null;
    return;
  }
  els.win.hidden = true;
  els.target.hidden = false;
  if (v.level !== g.index || v.target !== g.target) {
    v.level = g.index;
    v.target = g.target;
    v.img = false;
    v.pct = null;
    els.targetHint.textContent = MEME_BY_ID.get(g.target)?.hint ?? "";
  }
  const stage = `${g.index + 1} / ${g.total}`;
  if (v.stage !== stage) {
    v.stage = stage;
    els.targetStage.textContent = stage;
  }
  if (!v.img) {
    const entry = levelEntry(g.index); // the images may still be loading
    if (entry) {
      els.targetImg.src = entry.src;
      els.targetImg.alt = `Meme to find: ${MEME_BY_ID.get(g.target).label}`;
      els.targetImg.style.objectFit = entry.fit;
      els.targetImg.style.transform = entry.transform;
      v.img = true;
    }
  }
  const found = g.phase === "found";
  const pct = found ? "found" : Math.round(g.score * 100);
  if (v.pct !== pct) {
    v.pct = pct;
    els.targetPct.textContent = found ? "Found! ✓" : `${pct}%`;
    els.targetFill.style.transform = `scaleX(${Math.min(1, g.score)})`;
  }
  els.target.classList.toggle("ok", g.passing);
  els.target.classList.toggle("found", found);
  if (v.hint !== g.hint) {
    v.hint = g.hint;
    els.targetHint.hidden = !g.hint;
  }
}

/** Running average with a memory of ~10 samples (the first sample starts it). */
function ema(avg, x) {
  return avg ? 0.9 * avg + 0.1 * x : x;
}

/** Console-only (verbose level) timing summary every 10 s; nothing on screen. */
function logPerf(ms, now) {
  const p = state.perf;
  if (!p.frames) p.since = now;
  p.frames++;
  p.ms += ms;
  if (now - p.since >= 10000) {
    const secs = (now - p.since) / 1000;
    console.debug(
      `[meme-cam] perf ${state.backend}: ${(p.frames / secs).toFixed(1)} frames/s, ` +
        `detect ${(p.ms / p.frames).toFixed(1)} ms/frame, face model ${(p.faceRuns / secs).toFixed(1)}/s`,
    );
    state.perf = { since: now, frames: 0, ms: 0, faceRuns: 0 };
  }
}

// -------------------------------------------------------------- wire ----
els.startBtn.addEventListener("click", () => startCamera(els.cameraSelect.value || undefined));
els.againBtn.addEventListener("click", () => {
  state.game?.restart();
  state.gameView = {};
  if (state.stickerView) state.stickerView = { done: -1, current: -1, total: state.stickerView.total };
  els.note.hidden = true;
  els.win.classList.remove("writing");
  els.win.hidden = true;
});
initFeedback({
  els: {
    win: els.win,
    commentBtn: $("comment-btn"),
    note: els.note,
    close: $("note-close"),
    text: $("note-text"),
    stars: $("note-stars"),
    status: $("note-status"),
    send: $("note-send"),
    suggest: $("note-suggest"),
  },
  share: SHARE,
  getName: () => state.playerName,
});
els.cameraSelect.addEventListener("change", () => {
  if (state.running) startCamera(els.cameraSelect.value);
});
els.video.addEventListener("loadedmetadata", fitStage);
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  if (state.running) populateCameras();
});

// ------------------------------------------------------------- start ----
// Landing page first; the models & memes load in the background meanwhile.
/**
 * Focus for a new page: its first box with a mouse / keyboard, but its heading on touch screens, where
 * focusing a box pops the on-screen keyboard over half the form (review: Android).
 */
function focusFirst(headingId, boxSelector) {
  requestAnimationFrame(() => {
    const box = boxSelector.startsWith("#") ? document.querySelector(boxSelector) : $(boxSelector);
    const el = matchMedia("(pointer: fine)").matches && box ? box : $(headingId);
    el?.focus({ preventScroll: true });
  });
}

initLanding({
  els: {
    // page 1
    playYes: $("play-yes"),
    playNo: $("play-no"),
    playNoText: $("play-no-text"),
    bleh: $("bleh"),
    // page 2
    root: $("details"),
    layer: $("no-layer"),
    form: $("details-form"),
    name: $("name"),
    phone: $("phone"),
    dob: $("dob"),
    course: $("course"),
    year: $("year"),
    shareYes: $("share-yes"),
    shareNo: $("share-no"),
    msg: $("no-msg"),
    tease: $("no-tease"),
    status: $("share-status"),
    continueBtn: $("continue-btn"),
    // page 3
    quizForm: $("reasoning-form"),
    quiz: $("quiz"),
    playBtn: $("play-btn"),
  },
  share: SHARE,
  onNext: () => {
    // page 1 -> page 2 (the details form)
    els.intro.hidden = true;
    els.details.hidden = false;
    window.scrollTo(0, 0);
    focusFirst("details-title", "name");
  },
  onDetailsDone: () => {
    // page 2 -> page 3 (reasoning)
    els.details.hidden = true;
    els.reasoning.hidden = false;
    window.scrollTo(0, 0);
    focusFirst("reasoning-title", "#quiz input");
  },
  onContinue: (name) => {
    // page 3 -> the loading screen (camera + trackers) -> the game. A few seconds in, the screen cracks and the
    // siren page (the captcha) takes over; after "Verified" the game carries on (the user's order, 2026-11-07).
    state.playerName = name;
    els.reasoning.hidden = true;
    els.app.hidden = false;
    window.scrollTo(0, 0);
    startCaptcha(); // built now (hidden), so its pictures are loaded by the time it shows
    state.booting = true;
    runBoot(els.boot, {
      work: startCamera(),
      status: () => ({
        camera: state.running,
        models: !!state.hand,
        failed: !els.gate.hidden && els.gate.classList.contains("error"),
      }),
      reduced: reducedMotion(),
    }).then(() => {
      state.booting = false;
      scheduleCracks();
    });
  },
});

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Once per visit: GAME.crackAfterMs of game on screen, then the glass breaks. */
let cracked = false;
function scheduleCracks() {
  const STEP = 250;
  let played = 0; // only time with the game really on screen counts (not a camera error, not the win screen,
  // not a hidden tab): after an error + "Try again" it cracked at once (review 2026-11-07)
  let last = performance.now();
  const check = () => {
    if (cracked) return;
    const now = performance.now();
    const live = state.running && state.hand && !state.paused && els.win.hidden && els.gate.hidden && document.visibilityState === "visible";
    if (live) played += Math.min(now - last, 1000); // real time (timers run late on a busy machine), capped
    last = now;
    if (live && played >= GAME.crackAfterMs) {
      interruptGame();
      return;
    }
    setTimeout(check, STEP);
  };
  setTimeout(check, STEP);
}

/** A shake of the camera + panel on each impact (k = how hard). */
function shakeGame(k = 1) {
  if (!els.play?.animate) return;
  const d = (px) => `${(px * k).toFixed(1)}px`;
  els.play.animate(
    [
      { translate: "0 0" },
      { translate: `${d(-9)} ${d(3)}` },
      { translate: `${d(8)} ${d(-4)}` },
      { translate: `${d(-6)} ${d(2)}` },
      { translate: `${d(4)} ${d(-1)}` },
      { translate: "0 0" },
    ],
    { duration: 420, easing: "cubic-bezier(0.36, 0.07, 0.19, 0.97)" },
  );
}

/** The glass breaks, it flashes red, and the siren page with the captcha takes over the (paused) game. */
function interruptGame() {
  cracked = true;
  state.paused = true;
  state.pausedAt = performance.now();
  showMeme(null);
  els.app.inert = true; // keyboard focus stays on the siren page, not the game behind it
  const reduced = reducedMotion();
  playCracks(els.cracks, { reduced, shake: shakeGame, onTakeOver: () => showSirenPage(reduced) });
}

function showSirenPage(reduced) {
  const intro = $("human-intro");
  const page = $("captcha-page");
  intro.hidden = false;
  page.hidden = true;
  els.captcha.setAttribute("role", "dialog");
  els.captcha.setAttribute("aria-modal", "true");
  els.captcha.hidden = false;
  els.captcha.scrollTop = 0;
  intro.focus({ preventScroll: true });
  // the lead-in ("Wait Wait Wait…", "NO NO NO… OKAY"), then the captcha comes in
  playHumanIntro(intro, { reduced }).then(() => {
    intro.hidden = true;
    page.hidden = false;
    revealCaptcha(page, { reduced });
    focusFirst("captcha-title", "#captcha-stickers button");
  });
}

/** "Verified": the siren page goes and the game carries on where it was. */
function resumeGame() {
  els.captcha.hidden = true;
  els.app.inert = false;
  // the meme / held mouth from before the crack must not count after the pause (review 2026-11-07)
  state.stabilizer.reset();
  state.expressions = new ExpressionTracker();
  state.game?.pausedFor(performance.now() - state.pausedAt);
  state.paused = false;
}

/** The pictures in the captcha: 5 easy memes, by their first picture (matched to the same picture). */
const CAPTCHA_MEMES = ["thumbs_up", "point", "shaka", "heart", "laugh"];
let captchaStarted = false;
function startCaptcha() {
  if (captchaStarted) return;
  captchaStarted = true;
  const items = CAPTCHA_MEMES.map((id) => MEME_BY_ID.get(id))
    .filter(Boolean)
    .map((m) => ({ id: m.id, label: m.label, src: memeUrl(typeof m.images[0] === "string" ? m.images[0] : m.images[0].file) }));
  initCaptcha({
    els: {
      stickers: $("captcha-stickers"),
      slots: $("captcha-slots"),
      status: $("captcha-status"),
      verify: $("captcha-verify"),
      refresh: $("captcha-refresh"),
    },
    items,
    onPass: resumeGame, // back to the game
  });
}
showMeme(null);
loadMemes();
ensureModels().catch((err) => console.error("Models failed to load:", err));
