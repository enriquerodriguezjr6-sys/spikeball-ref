import { DEFAULTS, KINDS, BallTracker, NetJudge, rgbToHsv } from './tracker.js';
import { DemoScene } from './demo.js';
import { findRims, fitRimMedian } from './rimfit.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const PREFS = { sound: true, showLegal: true, showMask: false, target: 21, nameA: 'Team A', nameB: 'Team B' };
const S = Object.assign({}, DEFAULTS, PREFS, store.get('sr.settings', {}));
const rims = Object.assign({ camera: { cx: 0.5, cy: 0.62, rx: 0.24, ry: 0.07 }, file: { cx: 0.5, cy: 0.62, rx: 0.24, ry: 0.07 } }, store.get('sr.rims', {}));
const game = Object.assign({ A: 0, B: 0, serving: 'A', faults: 0, log: [] }, store.get('sr.game', {}));
const ui = { who: 'A', cat: 'Serve', mode: null };
const saveSettings = () => store.set('sr.settings', S);
const saveRims = () => store.set('sr.rims', { camera: rims.camera, file: rims.file });
const saveGame = () => store.set('sr.game', game);
const other = (t) => (t === 'A' ? 'B' : 'A');
const nameOf = (t) => (t === 'A' ? S.nameA : S.nameB) || 'Team ' + t;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const video = $('video'), demoCanvas = $('demo'), overlay = $('overlay'), stage = $('stage');
const octx = overlay.getContext('2d');
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
const maskCanvas = document.createElement('canvas');
const tracker = new BallTracker(S);
const judge = new NetJudge(S);
let demo = null;

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ---------- Scoreboard ---------- */

function award(team, delta = 1) {
  game[team] = Math.max(0, game[team] + delta);
  if (delta > 0) { game.serving = team; game.faults = 0; }
  saveGame();
  renderScore();
}

function renderScore() {
  $('scoreA').textContent = game.A;
  $('scoreB').textContent = game.B;
  $('nameAView').textContent = nameOf('A');
  $('nameBView').textContent = nameOf('B');
  $('teamA').classList.toggle('serving', game.serving === 'A');
  $('teamB').classList.toggle('serving', game.serving === 'B');
  $('pip1').classList.toggle('full', game.faults >= 1);
  $('pip2').classList.toggle('full', game.faults >= 2);
  const target = +S.target, hi = Math.max(game.A, game.B), lead = Math.abs(game.A - game.B);
  const leader = game.A > game.B ? 'A' : 'B';
  let s = `First to ${target}, win by 2`;
  if (hi >= target && lead >= 2) s = `<b>${esc(nameOf(leader))}</b> wins`;
  else if (hi >= target - 1 && lead >= 1) s = `Game point <b>${esc(nameOf(leader))}</b>`;
  $('gameStatus').innerHTML = s;
  $('bPointA').textContent = 'Point ' + nameOf('A');
  $('bPointB').textContent = 'Point ' + nameOf('B');
  $('logCount').textContent = game.log.length + (game.log.length === 1 ? ' call' : ' calls');
}

$('scoreA').onclick = () => award('A');
$('scoreB').onclick = () => award('B');
document.querySelectorAll('[data-minus]').forEach((b) => (b.onclick = () => award(b.dataset.minus, -1)));

/* ---------- Video sources ---------- */

let src = null;      // { kind: 'camera' | 'file' | 'demo', el }
let gen = 0;         // bumps on every source change so old frame loops stop
let stream = null;

function srcW() { return src.kind === 'demo' ? demoCanvas.width : video.videoWidth; }
function srcH() { return src.kind === 'demo' ? demoCanvas.height : video.videoHeight; }
function rim() { return rims[src.kind]; }

function showStartError(msg) {
  const el = $('startError');
  el.textContent = msg;
  el.hidden = false;
  $('start').hidden = false;
}

function stopSource() {
  gen++;
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  video.pause();
  video.srcObject = null;
  if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); video.load(); }
}

async function startCamera() {
  unlockAudio();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showStartError('The camera only works from an https:// link. Open the hosted link in Safari, not a file or http:// address.');
    return;
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
    });
    stopSource();
    stream = s;
    video.srcObject = s;
    await video.play();
    setSource('camera');
    if (!store.get('sr.rimSet', false)) { setMode('rim'); setTimeout(() => autoFit(), 700); }
  } catch (e) {
    showStartError(e && e.name === 'NotAllowedError'
      ? 'Camera access is blocked. On iPhone go to Settings › Safari › Camera, choose Allow, then tap Start camera again.'
      : 'The camera did not start: ' + (e && e.message ? e.message : e));
  }
}

async function startClip(file) {
  if (!file) return;
  unlockAudio();
  stopSource();
  video.src = URL.createObjectURL(file);
  video.loop = true;
  try { await video.play(); } catch {}
  setSource('file');
  setMode('rim');
  setTimeout(() => autoFit(), 700);
}

function startDemo() {
  unlockAudio();
  stopSource();
  if (!demo) demo = new DemoScene(demoCanvas);
  rims.demo = { ...demo.rimNorm };
  setSource('demo');
}

function setSource(kind) {
  src = { kind, el: kind === 'demo' ? demoCanvas : video };
  video.hidden = kind === 'demo';
  demoCanvas.hidden = kind !== 'demo';
  $('start').hidden = true;
  $('startError').hidden = true;
  judge.reset();
  tracker.reset();
  clearBuffer();
  trail.length = 0;
  document.querySelectorAll('[data-src]').forEach((b) => b.classList.toggle('on', b.dataset.src === kind));
  $('liveReplay').hidden = false;
  requestWake();
  runLoop(++gen);
}

$('btnCamera').onclick = startCamera;
$('btnDemo').onclick = startDemo;
$('clipInput').onchange = (e) => startClip(e.target.files[0]);
$('clipInput2').onchange = (e) => { closeSheets(); startClip(e.target.files[0]); };
document.querySelectorAll('[data-src]').forEach((b) => (b.onclick = () => {
  closeSheets();
  if (b.dataset.src === 'camera') startCamera(); else startDemo();
}));

/* ---------- Frame loop ---------- */

function runLoop(g) {
  if (g !== gen) return;
  if (src.kind === 'demo') {
    requestAnimationFrame((now) => {
      if (g !== gen) return;
      demo.paused = replay != null;
      demo.step(now);
      process(now, now);
      runLoop(g);
    });
  } else if (video.requestVideoFrameCallback) {
    video.requestVideoFrameCallback((now, meta) => {
      if (g !== gen) return;
      process(src.kind === 'file' ? meta.mediaTime * 1000 : now, now);
      runLoop(g);
    });
  } else {
    requestAnimationFrame((now) => {
      if (g !== gen) return;
      if (video.currentTime !== runLoop.lastCT) {
        runLoop.lastCT = video.currentTime;
        process(src.kind === 'file' ? video.currentTime * 1000 : now, now);
      }
      runLoop(g);
    });
  }
}

const trail = [];
let lastT = -1, view = null;
let fpsN = 0, fpsT0 = 0, fps = 0;
const PIXELS = 110000; // pixels checked per frame

// Only the part of the frame the ball can be in is checked: across and above the net.
// Cropping to it gives a sharper look at the ball for the same amount of work.
function roiRect(sw, sh, R) {
  const cx = R.cx * sw, cy = R.cy * sh, rx = R.rx * sw, ry = R.ry * sh;
  const x0 = Math.max(0, Math.round(cx - rx * 3.2)), x1 = Math.min(sw, Math.round(cx + rx * 3.2));
  const y1 = Math.min(sh, Math.round(cy + ry + rx * 0.6));
  return { x: x0, y: 0, w: Math.max(1, x1 - x0), h: Math.max(1, y1) };
}

// t: the clip's own clock (ms). wall: performance.now(), used for the replay buffer.
function process(t, wall) {
  if (replay) return;
  const sw = srcW(), sh = srcH();
  if (!sw || !sh) return;
  if (t < lastT) { judge.reset(); tracker.reset(); } // clip looped
  lastT = t;
  const R = rim();
  const roi = roiRect(sw, sh, R);
  const k = Math.min(1, Math.sqrt(PIXELS / (roi.w * roi.h)));
  const W = Math.max(1, Math.round(roi.w * k)), H = Math.max(1, Math.round(roi.h * k));
  if (work.width !== W || work.height !== H) { work.width = W; work.height = H; tracker.resize(W, H); judge.reset(); }
  view = { roi, sw, sh, W, H, k };
  wctx.drawImage(src.el, roi.x, roi.y, roi.w, roi.h, 0, 0, W, H);
  const img = wctx.getImageData(0, 0, W, H);
  const e = { cx: (R.cx * sw - roi.x) * k, cy: (R.cy * sh - roi.y) * k, rx: R.rx * sw * k, ry: R.ry * sh * k };
  const det = ui.mode ? null : tracker.update(img.data, t, e);
  const events = ui.mode ? [] : judge.update(det, t, e);
  const toNorm = (x, y) => ({ u: (roi.x + x / k) / sw, v: (roi.y + y / k) / sh });
  const norm = det ? { ...toNorm(det.x, det.y), rr: det.r / k / sw } : null;

  pushFrame(wall, norm);
  trail.push({ wall, norm });
  while (trail.length && wall - trail[0].wall > 350) trail.shift();

  fpsN++;
  if (wall - fpsT0 > 1000) { fps = Math.round((fpsN * 1000) / (wall - fpsT0)); fpsN = 0; fpsT0 = wall; }
  const live = $('liveStatus');
  live.textContent = ui.mode ? 'Paused while you set up' : `${det ? 'Ball found' : 'Looking for ball'} · ${fps} fps`;
  live.classList.toggle('ok', !!det && !ui.mode);

  if (S.showMask) paintMask(W, H);
  drawOverlay(norm);
  for (const ev of events) onEvent(ev, toNorm(ev.x, ev.y), wall - (t - ev.t));
}

/* ---------- Overlay ---------- */

const flashes = [];

function contentRect() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!src) return { x: 0, y: 0, w, h };
  const sc = Math.min(w / srcW(), h / srcH());
  const cw = srcW() * sc, ch = srcH() * sc;
  return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
}

function sizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return dpr;
}

function paintMask(W, H) {
  if (maskCanvas.width !== W || maskCanvas.height !== H) { maskCanvas.width = W; maskCanvas.height = H; }
  const mctx = maskCanvas.getContext('2d');
  const id = mctx.createImageData(W, H);
  const m = tracker.mask;
  for (let i = 0; i < m.length; i++) if (m[i]) { const o = i * 4; id.data[o] = 255; id.data[o + 1] = 40; id.data[o + 2] = 200; id.data[o + 3] = 230; }
  mctx.putImageData(id, 0, 0);
}

function drawRim(ctx, cr, R, opts = {}) {
  const cx = cr.x + R.cx * cr.w, cy = cr.y + R.cy * cr.h, rx = R.rx * cr.w, ry = R.ry * cr.h;
  if (opts.zones) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * S.rimMax, ry * S.rimMax, 0, 0, Math.PI * 2);
    ctx.ellipse(cx, cy, rx * S.rimMin, ry * S.rimMin, 0, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(255,90,79,.28)';
    ctx.fill('evenodd');
  }
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.setLineDash(opts.editing ? [8, 6] : []);
  ctx.lineWidth = opts.editing ? 3 : 1.5;
  ctx.strokeStyle = opts.editing ? '#f2d31b' : 'rgba(255,255,255,.55)';
  ctx.stroke();
  ctx.setLineDash([]);
  return { cx, cy, rx, ry };
}

function handles(cr, R) {
  const cx = cr.x + R.cx * cr.w, cy = cr.y + R.cy * cr.h;
  return {
    move: [cx, cy],
    width: [cx + R.rx * cr.w, cy],
    height: [cx, cy + R.ry * cr.h],
  };
}

function drawOverlay(norm) {
  const dpr = sizeCanvas(overlay);
  const ctx = octx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
  if (!src) return;
  const cr = contentRect();
  if (S.showMask && maskCanvas.width && view) {
    const { roi, sw, sh } = view;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(maskCanvas, cr.x + (roi.x / sw) * cr.w, cr.y + (roi.y / sh) * cr.h, (roi.w / sw) * cr.w, (roi.h / sh) * cr.h);
  }
  const R = rim();
  drawRim(ctx, cr, R, { editing: ui.mode === 'rim', zones: ui.mode === 'rim' });

  if (ui.mode === 'rim') {
    const h = handles(cr, R);
    for (const [k, [x, y]] of Object.entries(h)) {
      ctx.beginPath();
      ctx.arc(x, y, k === 'move' ? 16 : 13, 0, Math.PI * 2);
      ctx.fillStyle = k === 'move' ? 'rgba(242,211,27,.35)' : '#f2d31b';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#1d1a05';
      ctx.stroke();
    }
    ctx.font = '600 12px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = '#f2d31b';
    ctx.fillText('drag to move', h.move[0] - 36, h.move[1] - 22);
    ctx.fillText('width', h.width[0] + 16, h.width[1] + 4);
    ctx.fillText('depth', h.height[0] + 16, h.height[1] + 4);
    return;
  }

  // Ball trail
  ctx.lineCap = 'round';
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1].norm, b = trail[i].norm;
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(cr.x + a.u * cr.w, cr.y + a.v * cr.h);
    ctx.lineTo(cr.x + b.u * cr.w, cr.y + b.v * cr.h);
    ctx.strokeStyle = `rgba(242,211,27,${(i / trail.length) * 0.7})`;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  if (norm) {
    ctx.beginPath();
    ctx.arc(cr.x + norm.u * cr.w, cr.y + norm.v * cr.h, Math.max(8, norm.rr * cr.w * 1.6), 0, Math.PI * 2);
    ctx.strokeStyle = '#f2d31b';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Contact flashes
  const now = performance.now();
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i], age = (now - f.t0) / 900;
    if (age > 1) { flashes.splice(i, 1); continue; }
    const x = cr.x + f.u * cr.w, y = cr.y + f.v * cr.h;
    ctx.globalAlpha = 1 - age;
    ctx.beginPath();
    ctx.arc(x, y, 10 + age * 40, 0, Math.PI * 2);
    ctx.strokeStyle = f.color;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.font = '800 20px "Barlow Condensed", system-ui, sans-serif';
    ctx.fillStyle = f.color;
    ctx.fillText(f.label, x + 16, y - 16 - age * 10);
    ctx.globalAlpha = 1;
  }
}

/* ---------- Setup modes: drag the rim, tap the ball ---------- */

function setMode(mode) {
  ui.mode = mode;
  if (mode) { $('banner').hidden = true; bannerEntry = null; }
  overlay.classList.toggle('editing', !!mode);
  $('tools').hidden = !!mode;
  $('modeBar').hidden = !mode;
  $('modeHint').textContent = mode === 'rim'
    ? 'Tap Auto-fit, or drag the oval onto the rim and pull the dots to fit.'
    : 'Set the ball on the net so it is still, then tap it.';
  $('modeDone').textContent = mode === 'color' ? 'Cancel' : 'Done';
  $('modeAuto').hidden = mode !== 'rim';
  $('modeAuto').textContent = 'Auto-fit';
  $('liveReplay').hidden = !!mode || !src;
  rimGuesses = [];
  judge.reset();
  tracker.reset();
  if (src) drawOverlay(null);
}

$('modeDone').onclick = () => {
  if (ui.mode === 'rim' && src && src.kind !== 'demo') { saveRims(); store.set('sr.rimSet', true); toast('Rim saved'); }
  fitting = false;
  setMode(null);
};

let drag = null;
function toNorm(ev) {
  const r = overlay.getBoundingClientRect(), cr = contentRect();
  return { u: (ev.clientX - r.left - cr.x) / cr.w, v: (ev.clientY - r.top - cr.y) / cr.h, px: ev.clientX - r.left, py: ev.clientY - r.top };
}

overlay.addEventListener('pointerdown', (ev) => {
  if (!src || !ui.mode) return;
  const p = toNorm(ev);
  if (ui.mode === 'color') { sampleColor(p); return; }
  const R = rim(), h = handles(contentRect(), R);
  let best = null, bd = 44;
  for (const [k, [x, y]] of Object.entries(h)) {
    const d = Math.hypot(p.px - x, p.py - y);
    if (d < bd) { bd = d; best = k; }
  }
  if (!best) {
    // Tapping inside the oval also moves it
    const dx = (p.u - R.cx) / R.rx, dy = (p.v - R.cy) / R.ry;
    if (Math.hypot(dx, dy) < 1.2) best = 'move';
  }
  if (!best) return;
  drag = { k: best, start: p, R0: { ...R } };
  overlay.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});

overlay.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const p = toNorm(ev), R = rim(), R0 = drag.R0;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  if (drag.k === 'move') {
    R.cx = clamp(R0.cx + p.u - drag.start.u, 0, 1);
    R.cy = clamp(R0.cy + p.v - drag.start.v, 0, 1);
  } else if (drag.k === 'width') {
    R.rx = clamp(Math.abs(p.u - R.cx), 0.03, 0.6);
  } else {
    R.ry = clamp(Math.abs(p.v - R.cy), 0.01, 0.5);
  }
  drawOverlay(null);
});
overlay.addEventListener('pointerup', () => { drag = null; });
overlay.addEventListener('pointercancel', () => { drag = null; });

// Auto-fit: looks at five frames for the dark oval of the net and keeps the middle answer, so a
// ball or player crossing the net in one frame doesn't throw it off. Pressing again steps
// through other ovals it found, in case it picked a shadow.
const fitCanvas = document.createElement('canvas');
const fctx = fitCanvas.getContext('2d', { willReadFrequently: true });
let rimGuesses = [], guessIdx = 0, fitting = false;

function grabRims() {
  const sw = srcW(), sh = srcH();
  if (!sw || !sh) return [];
  const W = 320, H = Math.max(1, Math.round((320 * sh) / sw));
  fitCanvas.width = W; fitCanvas.height = H;
  fctx.drawImage(src.el, 0, 0, W, H);
  return findRims(fctx.getImageData(0, 0, W, H).data, W, H);
}

function applyRim(g) {
  const R = rim();
  R.cx = g.cx; R.cy = g.cy; R.rx = g.rx; R.ry = g.ry;
  drawOverlay(null);
}

async function autoFit() {
  if (!src || ui.mode !== 'rim' || fitting) return;
  if (rimGuesses.length > 1) {
    guessIdx = (guessIdx + 1) % rimGuesses.length;
    applyRim(rimGuesses[guessIdx]);
    $('modeHint').textContent = `Guess ${guessIdx + 1} of ${rimGuesses.length}. Tap Done when it sits on the rim.`;
    return;
  }
  fitting = true;
  $('modeHint').textContent = 'Looking for the rim…';
  const runs = [];
  for (let i = 0; i < 5; i++) {
    runs.push(grabRims());
    await new Promise((r) => setTimeout(r, 120));
  }
  fitting = false;
  if (ui.mode !== 'rim') return;
  const best = fitRimMedian(runs.map((r) => r[0] || null));
  const last = runs[runs.length - 1];
  rimGuesses = best
    ? [best, ...last.filter((c) => Math.abs(c.cx - best.cx) > best.rx * 0.25 || Math.abs(c.cy - best.cy) > best.rx * 0.15)]
    : last;
  guessIdx = 0;
  if (!rimGuesses.length) {
    $('modeHint').textContent = "Couldn't find the rim. Drag the oval onto it, or move the phone so the whole net shows.";
    $('modeAuto').textContent = 'Try again';
    return;
  }
  applyRim(rimGuesses[0]);
  $('modeHint').textContent = rimGuesses.length > 1
    ? 'Found it. If the oval is on the wrong thing, tap Next guess.'
    : 'Found the rim. Nudge the oval if needed, then tap Done.';
  $('modeAuto').textContent = rimGuesses.length > 1 ? 'Next guess' : 'Auto-fit';
}
$('modeAuto').onclick = () => autoFit();

const sampler = document.createElement('canvas');
sampler.width = sampler.height = 9;
const sctx = sampler.getContext('2d', { willReadFrequently: true });

function sampleColor(p) {
  if (p.u < 0 || p.v < 0 || p.u > 1 || p.v > 1) return;
  const sw = srcW(), sh = srcH();
  const size = Math.max(9, sw * 0.022); // a small patch, about the size of a ball on screen
  sctx.drawImage(src.el, p.u * sw - size / 2, p.v * sh - size / 2, size, size, 0, 0, 9, 9);
  const d = sctx.getImageData(0, 0, 9, 9).data;
  let sx = 0, sy = 0, ss = 0, sv = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const c = rgbToHsv(d[i], d[i + 1], d[i + 2]);
    if (c.s < 0.2 || c.v < 0.2) continue;
    sx += Math.cos((c.h * Math.PI) / 180); sy += Math.sin((c.h * Math.PI) / 180); ss += c.s; sv += c.v; n++;
  }
  if (!n) { toast('That spot is too gray. Tap right on the ball.'); return; }
  S.hue = Math.round(((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360);
  S.minSat = Math.min(0.6, Math.max(0.2, (ss / n) * 0.55));
  S.minVal = Math.min(0.6, Math.max(0.2, (sv / n) * 0.5));
  saveSettings();
  renderSettings();
  setMode(null);
  toast('Ball color saved');
}

/* ---------- Detected events ---------- */

let bannerEntry = null;

function onEvent(ev, pos, bufT) {
  const K = KINDS[ev.kind];
  const color = K.fault ? '#ff5a4f' : '#3ed08a';
  flashes.push({ u: pos.u, v: pos.v, color, label: K.short, t0: performance.now() });
  if (!K.fault) {
    if (S.showLegal) showChip(K.label);
    return;
  }
  const entry = {
    id: Date.now() + Math.random(), at: Date.now(), label: K.label, verdict: 'fault', auto: true,
    near: ev.near, score: `${game.A}–${game.B}`, result: 'Flagged', bufT, u: pos.u, v: pos.v,
  };
  game.log.push(entry);
  saveGame();
  renderScore();
  whistle();
  bannerEntry = entry;
  $('chip').hidden = true;
  $('bKind').textContent = K.label;
  $('bWhy').innerHTML = esc(K.why) + (ev.near ? ' <b>Close call. Check the replay.</b>' : '');
  $('banner').hidden = false;
}

function resolveBanner(result, team) {
  if (bannerEntry) {
    bannerEntry.result = result;
    if (team) award(team);
    saveGame();
  }
  $('banner').hidden = true;
  bannerEntry = null;
}
$('bPointA').onclick = () => resolveBanner('Point ' + nameOf('A'), 'A');
$('bPointB').onclick = () => resolveBanner('Point ' + nameOf('B'), 'B');
$('bIgnore').onclick = () => resolveBanner('Ignored');
$('bReplay').onclick = () => openReplay(bannerEntry ? bannerEntry.bufT : null, bannerEntry);
$('liveReplay').onclick = () => openReplay(null);

function showChip(text) {
  const c = $('chip');
  c.textContent = text + ' ✓';
  c.hidden = !$('banner').hidden;
  clearTimeout(showChip.t);
  showChip.t = setTimeout(() => (c.hidden = true), 1100);
}

let ac = null;
function unlockAudio() {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  } catch {}
}
function whistle() {
  if (!S.sound || !ac) return;
  const t = ac.currentTime;
  for (const [f, at] of [[2600, 0], [2900, 0.16]]) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f, t + at);
    g.gain.setValueAtTime(0.0001, t + at);
    g.gain.exponentialRampToValueAtTime(0.3, t + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.15);
    o.connect(g).connect(ac.destination);
    o.start(t + at);
    o.stop(t + at + 0.16);
  }
}

/* ---------- Replay buffer ---------- */

const CAP = 240;   // frames kept: 4 s at 60 fps, 8 s at 30
const RW = 400;    // replay frame width in pixels
const pool = [];
let head = 0, count = 0;

function clearBuffer() { head = 0; count = 0; }

function pushFrame(wall, norm) {
  const RH = Math.max(1, Math.round((RW * srcH()) / srcW()));
  let slot = pool[head];
  if (!slot) { const c = document.createElement('canvas'); slot = pool[head] = { c, x: c.getContext('2d') }; }
  if (slot.c.width !== RW || slot.c.height !== RH) { slot.c.width = RW; slot.c.height = RH; }
  slot.x.drawImage(src.el, 0, 0, RW, RH);
  slot.t = wall;
  slot.norm = norm;
  head = (head + 1) % CAP;
  count = Math.min(CAP, count + 1);
}

function bufferFrames() {
  const out = [];
  for (let i = count; i > 0; i--) out.push(pool[(head - i + CAP) % CAP]);
  return out;
}

let replay = null;
const rc = $('replayCanvas'), rctx = rc.getContext('2d');
const GOOD_CALLS = new Set(['Clean hit', 'Pocket']);

// focusT: the moment to center on (a flagged contact), or null for "the last few seconds".
// entry: the log entry being reviewed, if any; the call made here updates it.
function openReplay(focusT, entry = null) {
  const fr = bufferFrames();
  if (fr.length < 2) { toast('Nothing recorded yet'); return; }
  if (src.kind === 'file') video.pause();
  let start = 0, focus = null;
  if (focusT != null && focusT >= fr[0].t && focusT <= fr[fr.length - 1].t + 50) {
    focus = focusT;
    while (start < fr.length - 1 && fr[start + 1].t < focusT - 700) start++;
  } else {
    const from = fr[fr.length - 1].t - 3000;
    while (start < fr.length - 1 && fr[start + 1].t < from) start++;
  }
  replay = {
    fr, i: start, start, focus, cursor: fr[start].t, playing: true, speed: 0.25, lastNow: null,
    entry, what: entry && entry.auto ? entry.label : null,
    zoom: 1, zc: entry && entry.u != null ? { u: entry.u, v: entry.v } : null,
  };
  closeSheets();
  $('banner').hidden = true;
  $('sheet-replay').hidden = false;
  const span = fr[fr.length - 1].t - fr[0].t || 1;
  $('rScrub').max = fr.length - 1;
  $('rTicks').innerHTML = game.log
    .filter((e) => e.bufT != null && e.bufT >= fr[0].t && e.bufT <= fr[fr.length - 1].t)
    .map((e) => `<i style="left:${((e.bufT - fr[0].t) / span) * 100}%" title="${esc(e.label)}"></i>`).join('');
  $('camCall').hidden = !(entry && entry.auto);
  if (entry && entry.auto) {
    $('camKind').textContent = entry.label;
    $('camNear').textContent = entry.near ? 'Close call' : '';
  }
  $('rPointA').textContent = 'Point ' + nameOf('A');
  $('rPointB').textContent = 'Point ' + nameOf('B');
  renderWhat();
  setZoom(1);
  setReplaySpeed(0.25);
  requestAnimationFrame(replayTick);
}

function closeReplay() {
  if (!replay) return;
  replay = null;
  $('sheet-replay').hidden = true;
  judge.reset();
  tracker.reset();
  trail.length = 0;
  if (src && src.kind === 'file') video.play().catch(() => {});
}

function renderWhat() {
  document.querySelectorAll('[data-what]').forEach((b) => {
    const on = replay && replay.what === b.dataset.what;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });
}
$('whatRow').onclick = (e) => {
  const b = e.target.closest('[data-what]');
  if (!b || !replay) return;
  replay.what = replay.what === b.dataset.what ? null : b.dataset.what;
  renderWhat();
};

// The ref's ruling from the replay. Updates the flagged entry it came from, or logs a new one.
function replayCall(team) {
  const R = replay;
  if (!R) return;
  const result = team ? 'Point ' + nameOf(team) : 'Replay point';
  if (team) award(team);
  const f = R.fr[R.i];
  let entry = R.entry;
  if (entry) {
    if (R.what && R.what !== entry.label) entry.overturned = entry.label;
    if (R.what) entry.label = R.what;
    entry.verdict = GOOD_CALLS.has(entry.label) ? 'legal' : team ? 'fault' : 'replay';
    entry.result = result;
    entry.reviewed = true;
  } else {
    entry = {
      id: Date.now(), at: Date.now(), label: R.what || 'Reviewed play', auto: false, reviewed: true,
      verdict: R.what && GOOD_CALLS.has(R.what) ? 'legal' : team ? 'fault' : 'replay',
      score: `${game.A}–${game.B}`, result, bufT: R.focus != null ? R.focus : f.t,
      u: R.zc ? R.zc.u : f.norm ? f.norm.u : null, v: R.zc ? R.zc.v : f.norm ? f.norm.v : null,
    };
    game.log.push(entry);
  }
  if (entry === bannerEntry) bannerEntry = null;
  saveGame();
  renderScore();
  closeReplay();
  toast(R.what ? `${R.what}: ${result}` : result);
}
$('rPointA').onclick = () => replayCall('A');
$('rPointB').onclick = () => replayCall('B');
$('rRedo').onclick = () => replayCall(null);

function setZoom(z) {
  if (!replay) return;
  replay.zoom = z;
  document.querySelectorAll('[data-zoom]').forEach((b) => b.classList.toggle('on', +b.dataset.zoom === z));
}
document.querySelectorAll('[data-zoom]').forEach((b) => (b.onclick = () => setZoom(+b.dataset.zoom)));

// Where the zoomed view centers: a spot the ref tapped, else the flagged contact, else the ball, else the rim.
function zoomCenter(f) {
  const R = replay;
  if (R.zc) return R.zc;
  if (f.norm) return { u: f.norm.u, v: f.norm.v };
  const r = rim();
  return { u: r.cx, v: r.cy };
}

// Frame-to-screen mapping for the current zoom: screen = x + u * w, like contentRect().
function replayView(f) {
  const w = rc.clientWidth, h = rc.clientHeight;
  const sc = Math.min(w / f.c.width, h / f.c.height);
  const base = { w: f.c.width * sc, h: f.c.height * sc };
  base.x = (w - base.w) / 2; base.y = (h - base.h) / 2;
  const z = replay.zoom;
  if (z === 1) return { base, view: base };
  const c = zoomCenter(f);
  const u0 = Math.min(1 - 1 / z, Math.max(0, c.u - 0.5 / z));
  const v0 = Math.min(1 - 1 / z, Math.max(0, c.v - 0.5 / z));
  return { base, view: { x: base.x - u0 * z * base.w, y: base.y - v0 * z * base.h, w: base.w * z, h: base.h * z } };
}

rc.addEventListener('click', (ev) => {
  if (!replay) return;
  const f = replay.fr[replay.i];
  const { base, view } = replayView(f);
  const r = rc.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;
  if (x < base.x || y < base.y || x > base.x + base.w || y > base.y + base.h) return;
  replay.zc = { u: (x - view.x) / view.w, v: (y - view.y) / view.h };
  if (replay.zoom === 1) setZoom(2);
});

function replayTick(now) {
  const R = replay;
  if (!R) return;
  if (R.playing && R.lastNow != null) {
    R.cursor += (now - R.lastNow) * R.speed;
    while (R.i < R.fr.length - 1 && R.fr[R.i + 1].t <= R.cursor) R.i++;
    if (R.i === R.fr.length - 1 && R.cursor > R.fr[R.i].t + 250 * R.speed) { R.i = R.start; R.cursor = R.fr[R.start].t; }
  }
  R.lastNow = now;
  drawReplay();
  requestAnimationFrame(replayTick);
}

function drawReplay() {
  const R = replay;
  const dpr = sizeCanvas(rc);
  const w = rc.clientWidth, h = rc.clientHeight;
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rctx.fillStyle = '#000';
  rctx.fillRect(0, 0, w, h);
  const f = R.fr[R.i];
  const { base, view: cr } = replayView(f);
  rctx.save();
  rctx.beginPath();
  rctx.rect(base.x, base.y, base.w, base.h);
  rctx.clip();
  rctx.imageSmoothingEnabled = R.zoom < 4;
  rctx.drawImage(f.c, cr.x, cr.y, cr.w, cr.h);
  drawRim(rctx, cr, rim(), { zones: true });
  rctx.lineCap = 'round';
  for (let k = Math.max(1, R.i - 12); k <= R.i; k++) {
    const a = R.fr[k - 1].norm, b = R.fr[k].norm;
    if (!a || !b) continue;
    rctx.beginPath();
    rctx.moveTo(cr.x + a.u * cr.w, cr.y + a.v * cr.h);
    rctx.lineTo(cr.x + b.u * cr.w, cr.y + b.v * cr.h);
    rctx.strokeStyle = 'rgba(242,211,27,.75)';
    rctx.lineWidth = 2.5;
    rctx.stroke();
  }
  if (f.norm) {
    rctx.beginPath();
    rctx.arc(cr.x + f.norm.u * cr.w, cr.y + f.norm.v * cr.h, Math.max(8, f.norm.rr * cr.w * 1.6), 0, Math.PI * 2);
    rctx.strokeStyle = '#f2d31b';
    rctx.lineWidth = 2;
    rctx.stroke();
  }
  rctx.restore();
  if (R.focus != null && Math.abs(f.t - R.focus) < 40) {
    rctx.font = '800 26px "Barlow Condensed", system-ui, sans-serif';
    rctx.fillStyle = '#ff5a4f';
    rctx.fillText('CONTACT', base.x + 14, base.y + 34);
  }
  const t0 = R.focus != null ? R.focus : R.fr[R.fr.length - 1].t;
  const rel = (f.t - t0) / 1000;
  $('rTime').textContent = (rel > 0 ? '+' : '') + rel.toFixed(2) + ' s';
  $('rScrub').value = R.i;
  $('rPlay').textContent = R.playing ? 'Pause' : 'Play';
}

function setReplaySpeed(s) {
  if (!replay) return;
  replay.speed = s;
  $('rSpeedTag').textContent = (s === 1 ? '1' : s === 0.25 ? '¼' : s === 0.5 ? '½' : s) + '×';
  document.querySelectorAll('[data-rspeed]').forEach((b) => b.classList.toggle('on', +b.dataset.rspeed === s));
}
function stepReplay(n) {
  const R = replay;
  if (!R) return;
  R.playing = false;
  R.i = Math.max(0, Math.min(R.fr.length - 1, R.i + n));
  R.cursor = R.fr[R.i].t;
}
$('rPlay').onclick = () => { if (replay) { replay.playing = !replay.playing; replay.cursor = replay.fr[replay.i].t; } };
$('rBack').onclick = () => stepReplay(-1);
$('rFwd').onclick = () => stepReplay(1);
$('rScrub').oninput = (e) => { if (replay) { replay.playing = false; replay.i = +e.target.value; replay.cursor = replay.fr[replay.i].t; } };
document.querySelectorAll('[data-rspeed]').forEach((b) => (b.onclick = () => setReplaySpeed(+b.dataset.rspeed)));

/* ---------- Manual calls ---------- */

const RULES = {
  Serve: [
    { q: 'Serve hit the rim', v: 'fault', why: 'Any rim contact on a serve is a serve fault.' },
    { q: 'Serve missed the net', v: 'fault', why: 'Serve fault. Two in a row loses the point.' },
    { q: "Ball struck above the server's sternum", v: 'fault', why: "Contact must be at or below the server's sternum." },
    { q: "Serve went higher than the receiver's raised hand", v: 'fault', why: 'Too high a serve is a fault.' },
    { q: 'Server inside the 6 ft line or stepped over before contact', v: 'fault', why: 'Server stays back until the ball is struck.' },
    { q: 'Ball not released before the hit', v: 'fault', why: 'The ball has to leave the hand before it is struck.' },
    { q: 'Serve hit the pocket and bounced off normally', v: 'legal', why: 'A clean pocket bounce plays. Many casual games re-serve instead.' },
    { q: "Receiver wasn't ready", v: 'replay', why: 'Re-serve. No fault.' },
  ],
  Net: [
    { q: 'Hit the rim on a rally shot', v: 'fault', why: 'Rim contact ends the rally.' },
    { q: 'Ball rolled across the net', v: 'fault', why: 'It has to bounce off the net, not roll or slide.' },
    { q: 'Ball bounced on the net twice', v: 'fault', why: 'One bounce per hit.' },
    { q: 'Pocket shot that bounced cleanly', v: 'legal', why: 'Pockets play if the ball bounces rather than rolls.' },
    { q: 'Player knocked the set over or moved it', v: 'fault', why: 'Fault on whoever moved it.' },
  ],
  Touches: [
    { q: 'Team used 4 touches', v: 'fault', why: 'Three touches max, then it has to hit the net.' },
    { q: 'Same player touched it twice in a row', v: 'fault', why: 'Double touch. A teammate has to play it.' },
    { q: 'Ball caught, carried, or thrown', v: 'fault', why: 'It has to be a clean hit, not a hold.' },
    { q: 'Ball touched the ground', v: 'fault', why: 'Point to the other team.' },
  ],
  Contact: [
    { q: "Defender blocked a player's path to the ball", v: 'replay', why: 'Hindrance. Replay the point.' },
    { q: 'Defender stopped a clear winning play', v: 'fault', why: 'Called against the defender.' },
    { q: 'Collision with no clear blame', v: 'replay', why: 'Replay the point.' },
    { q: 'Defender moved before the serve was hit', v: 'fault', why: 'Receivers hold still until the serve.' },
  ],
};

function renderCalls() {
  $('whoA').textContent = nameOf('A');
  $('whoB').textContent = nameOf('B');
  $('whoA').classList.toggle('on', ui.who === 'A');
  $('whoB').classList.toggle('on', ui.who === 'B');
  $('cats').innerHTML = Object.keys(RULES).map((c) => `<button data-cat="${c}" class="${c === ui.cat ? 'on' : ''}">${c}</button>`).join('');
  $('calls').innerHTML = RULES[ui.cat].map((r, i) =>
    `<button class="call" data-call="${i}"><span class="q">${esc(r.q)}</span><span class="verdict v-${r.v}">${r.v}</span><span class="why">${esc(r.why)}</span></button>`).join('');
}
$('whoA').onclick = () => { ui.who = 'A'; renderCalls(); };
$('whoB').onclick = () => { ui.who = 'B'; renderCalls(); };
$('cats').onclick = (e) => { const b = e.target.closest('[data-cat]'); if (b) { ui.cat = b.dataset.cat; renderCalls(); } };
$('calls').onclick = (e) => {
  const b = e.target.closest('[data-call]');
  if (!b) return;
  const r = RULES[ui.cat][+b.dataset.call];
  const offender = ui.who, gainer = other(offender);
  let result;
  if (r.v === 'replay') result = 'Replay point';
  else if (r.v === 'legal') result = 'Play on';
  else if (ui.cat === 'Serve' && offender === game.serving) {
    if (game.faults === 0) { game.faults = 1; result = 'Serve fault 1 of 2'; }
    else { result = '2nd serve fault: point ' + nameOf(gainer); award(gainer); }
  } else { result = 'Point ' + nameOf(gainer); award(gainer); }
  const last = count ? pool[(head - 1 + CAP) % CAP].t : null;
  game.log.push({ id: Date.now(), at: Date.now(), label: r.q, verdict: r.v, auto: false, score: `${game.A}–${game.B}`, result, bufT: last });
  saveGame();
  renderScore();
  closeSheets();
  toast(result);
};

/* ---------- Log ---------- */

function renderLog() {
  const fr = count ? bufferFrames() : [];
  const inBuf = (t) => fr.length && t != null && t >= fr[0].t && t <= fr[fr.length - 1].t + 50;
  const rows = game.log.slice().reverse();
  $('logBody').innerHTML = rows.length ? rows.map((e) => `<tr>
      <td class="num">${new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</td>
      <td class="num">${esc(e.score)}</td>
      <td>${esc(e.label)}${e.auto ? '<span class="auto">camera</span>' : ''}${e.reviewed ? '<span class="auto">reviewed</span>' : ''}${e.overturned ? `<br><small style="color:var(--muted)">Camera said ${esc(e.overturned)}</small>` : ''}</td>
      <td><span class="verdict v-${e.verdict}">${esc(e.result)}</span></td>
      <td>${inBuf(e.bufT) ? `<button data-replay="${e.id}">Replay</button>` : ''}</td>
    </tr>`).join('')
    : '<tr><td colspan="5" style="color:var(--muted)">No calls yet. Faults the camera catches show up here, along with calls you make by hand.</td></tr>';
}
$('logBody').onclick = (e) => {
  const b = e.target.closest('[data-replay]');
  const entry = b && game.log.find((x) => String(x.id) === b.dataset.replay);
  if (entry) openReplay(entry.bufT, entry);
};
$('clearLog').onclick = () => { game.log = []; saveGame(); renderLog(); renderScore(); };
$('newGame').onclick = () => {
  Object.assign(game, { A: 0, B: 0, serving: 'A', faults: 0, log: [] });
  saveGame(); renderLog(); renderScore(); toast('New game');
};

/* ---------- Settings ---------- */

function renderSettings() {
  $('setNameA').value = S.nameA;
  $('setNameB').value = S.nameB;
  $('setTarget').value = String(S.target);
  $('setTol').value = S.hueTol;
  $('outTol').textContent = '±' + S.hueTol + '°';
  $('swatch').style.background = `hsl(${S.hue} 85% 55%)`;
  $('setRimMin').value = S.rimMin;
  $('outRimMin').textContent = (+S.rimMin).toFixed(2);
  $('setRimMax').value = S.rimMax;
  $('outRimMax').textContent = (+S.rimMax).toFixed(2);
  $('setRoll').value = S.rollMs;
  $('outRoll').textContent = S.rollMs + ' ms';
  $('setSound').checked = S.sound;
  $('setLegal').checked = S.showLegal;
  $('setMask').checked = S.showMask;
}
function bindSetting(id, key, parse, after) {
  $(id).addEventListener('input', (e) => {
    S[key] = parse(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
    if (key === 'rimMin') S.netMax = Math.min(S.netMax, S.rimMin - 0.05);
    saveSettings();
    renderSettings();
    if (after) after();
  });
}
const num = (v) => +v, same = (v) => v;
bindSetting('setNameA', 'nameA', same, renderScore);
bindSetting('setNameB', 'nameB', same, renderScore);
bindSetting('setTarget', 'target', num, renderScore);
bindSetting('setTol', 'hueTol', num);
bindSetting('setRimMin', 'rimMin', num);
bindSetting('setRimMax', 'rimMax', num);
bindSetting('setRoll', 'rollMs', num);
bindSetting('setSound', 'sound', same);
bindSetting('setLegal', 'showLegal', same);
bindSetting('setMask', 'showMask', same);
$('resetTuning').onclick = () => { Object.assign(S, DEFAULTS); saveSettings(); renderSettings(); toast('Tuning reset'); };

/* ---------- Sheets and toolbar ---------- */

function closeSheets() {
  document.querySelectorAll('.sheet:not(.full)').forEach((s) => (s.hidden = true));
}
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => {
  if (b.closest('#sheet-replay')) closeReplay(); else closeSheets();
}));
document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => {
  const k = b.dataset.open;
  closeSheets();
  if (k === 'rim' || k === 'color') {
    if (!src) { toast('Start the camera first'); return; }
    setMode(k);
  } else if (k === 'replay') {
    if (!src) { toast('Start the camera first'); return; }
    openReplay(null);
  } else {
    if (k === 'calls') renderCalls();
    if (k === 'log') renderLog();
    if (k === 'settings') renderSettings();
    $('sheet-' + k).hidden = false;
  }
}));

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (replay) {
    if (e.key === ',') stepReplay(-1);
    else if (e.key === '.') stepReplay(1);
    else if (e.key === ' ') { e.preventDefault(); $('rPlay').click(); }
    else if (e.key === 'Escape') closeReplay();
  } else if (e.key === 'Escape') closeSheets();
});

/* ---------- Keep the screen on ---------- */

let wake = null;
async function requestWake() {
  try { if (navigator.wakeLock && (!wake || wake.released)) wake = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && src) requestWake(); });
window.addEventListener('resize', () => { if (src) drawOverlay(null); });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

renderScore();
renderSettings();
