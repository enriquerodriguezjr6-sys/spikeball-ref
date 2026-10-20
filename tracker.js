// Ball detection and net-contact judging. No DOM here, so it runs the same on camera, clip or demo frames.
//
// Coordinates are pixels in the small processing frame (the area around the net). The rim is an ellipse
// {cx, cy, rx, ry}. A contact is judged by where the bottom of the ball is relative to that
// ellipse: d = 0 at the center of the net, d = 1 on the rim.

export const DEFAULTS = {
  hue: 55,        // Spikeball yellow
  hueTol: 18,
  minSat: 0.4,
  minVal: 0.35,
  netMax: 0.8,    // d below this is a clean net hit
  rimMin: 0.9,    // d from rimMin to rimMax is a rim hit; between netMax and rimMin is a pocket
  rimMax: 1.2,
  rollMs: 350,    // ball sitting on the net this long without bouncing = roll-up
  doubleMs: 700,  // two net contacts this close together, with no trip away from the net = double bounce
  vThr: 0.7,      // vertical speed (in rim-widths per second) that counts as moving up or down
  minPix: 4,
  maxPix: 4000,
  motionThr: 14,  // brightness change (0-255) that counts as movement
  minScore: 0.04, // how ball-like a blob must be to keep following it
  minStartScore: 0.15, // ...and to start following it
};

export const KINDS = {
  net:    { label: 'Net hit',       short: 'NET',    fault: false, why: 'Clean bounce off the net.' },
  pocket: { label: 'Pocket',        short: 'POCKET', fault: false, why: 'Landed near the rim but bounced off the net. Legal unless it rolled.' },
  rim:    { label: 'Rim hit',       short: 'RIM',    fault: true,  why: 'The ball touched the rim. Point to the other team.' },
  roll:   { label: 'Roll-up',       short: 'ROLL',   fault: true,  why: 'The ball rolled along the net instead of bouncing.' },
  double: { label: 'Double bounce', short: 'DOUBLE', fault: true,  why: 'The ball hit the net twice with no touch in between.' },
};

export function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
  let h = 0;
  if (c) {
    if (mx === r) h = ((g - b) / c) % 6;
    else if (mx === g) h = (b - r) / c + 2;
    else h = (r - g) / c + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx ? c / mx : 0, v: mx / 255 };
}

export function ellipseDist(x, y, e) {
  return Math.hypot((x - e.cx) / e.rx, (y - e.cy) / e.ry);
}

// Finds ball-colored blobs in one frame. Each pixel is checked for the ball's color and for
// movement against a slowly updated picture of the background, then touching pixels are grouped.
export class BallDetector {
  constructor(W = 320, H = 180) { this.resize(W, H); }

  resize(W, H) {
    this.W = W; this.H = H;
    const N = W * H;
    this.mask = new Uint8Array(N);
    this.move = new Uint8Array(N);
    this.labels = new Int32Array(N);
    this.stack = new Int32Array(N);
    this.bg = null;
    this.globalMotion = 0;
  }

  resetBackground() { this.bg = null; }

  blobs(data, s) {
    const { W, H, mask, move, labels, stack } = this;
    const N = W * H;
    const first = !this.bg;
    if (first) this.bg = new Float32Array(N);
    const bg = this.bg;
    const hue = s.hue, tol = s.hueTol;
    const minS = s.minSat, weakS = s.minSat * 0.55;
    const minV = s.minVal * 255, weakV = minV * 0.7;
    const mThr = s.motionThr;
    let moving = 0;

    for (let p = 0, i = 0; p < N; p++, i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const y = (r * 77 + g * 150 + b * 29) >> 8;
      let m = 0;
      if (first) bg[p] = y;
      else {
        const dy = y - bg[p];
        if (dy > mThr || dy < -mThr) m = 1;
        bg[p] += dy * 0.06;
      }
      move[p] = m;
      moving += m;
      mask[p] = 0;

      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (mx < weakV) continue;
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const c = mx - mn;
      if (c === 0 || c < weakS * mx) continue;
      let h;
      if (mx === r) h = ((g - b) / c) % 6;
      else if (mx === g) h = (b - r) / c + 2;
      else h = (r - g) / c + 4;
      h *= 60;
      if (h < 0) h += 360;
      let dh = h > hue ? h - hue : hue - h;
      if (dh > 180) dh = 360 - dh;
      if (dh > tol) continue;
      // Fully ball-colored, or a paler match that is moving (motion blur washes the color out).
      if ((mx >= minV && c >= minS * mx) || m) mask[p] = 1;
    }
    this.globalMotion = first ? 0 : moving / N;

    labels.fill(0);
    const out = [];
    let id = 0;
    for (let p = 0; p < N; p++) {
      if (!mask[p] || labels[p]) continue;
      id++;
      let sp = 0;
      stack[sp++] = p;
      labels[p] = id;
      let n = 0, sx = 0, sy = 0, mv = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
      while (sp) {
        const q = stack[--sp];
        const x = q % W, y = (q / W) | 0;
        n++; sx += x; sy += y; mv += move[q];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const nq = ny * W + nx;
            if (mask[nq] && !labels[nq]) { labels[nq] = id; stack[sp++] = nq; }
          }
        }
      }
      if (n >= s.minPix && n <= s.maxPix) out.push({ n, x: sx / n, y: sy / n, w: x1 - x0 + 1, h: y1 - y0 + 1, mv: mv / n });
      if (out.length > 300) break;
    }
    return out;
  }
}

// Follows one ball from frame to frame. Every blob is scored on how ball-like it is: the right
// size for a ball next to this rim, round, moving, and close to where the last frames say the
// ball should be now. A new track only starts on something that is moving, so still yellow
// things (cones, shoes, sunny grass) are ignored.
export class BallTracker {
  constructor(settings) {
    this.s = settings;
    this.detector = new BallDetector();
    this.track = null;
    this.ignore = []; // spots where something yellow sat still: not the ball
  }

  resize(W, H) { this.detector.resize(W, H); this.track = null; }

  reset() { this.detector.resetBackground(); this.track = null; this.ignore = []; }

  get mask() { return this.detector.mask; }

  // e: rim ellipse in frame pixels. Returns {x, y, r, n, score} or null.
  update(data, t, e) {
    const s = this.s;
    const blobs = this.detector.blobs(data, s);
    // A Spikeball is about 9.7 cm across and the rim about 91 cm, so the ball's radius is ~0.107 of the rim's.
    const expR = Math.max(1.5, 0.107 * e.rx);
    const g = 21.5 * e.rx; // gravity in pixels per second², using the rim as the ruler

    let tr = this.track;
    if (tr && (t - tr.t > 350 || t < tr.t)) tr = this.track = null;
    let pred = null;
    if (tr) {
      const dt = (t - tr.t) / 1000;
      const speed = Math.hypot(tr.vx, tr.vy);
      pred = {
        x: tr.x + tr.vx * dt,
        y: tr.y + tr.vy * dt + 0.5 * g * dt * dt,
        sig: Math.min(6 * expR, 2.5 * expR + 0.8 * speed * dt + 0.5 * g * dt * dt),
      };
    }
    const motionOK = this.detector.globalMotion < 0.25; // a shaking camera makes everything look like it moves
    const trackSlow = tr && Math.hypot(tr.vx, tr.vy) < 8 * expR;

    let best = null, bestScore = 0;
    for (const b of blobs) {
      const r = Math.sqrt(b.n / Math.PI);
      const lr = Math.log(r / expR);
      const size = Math.exp(-(lr * lr) / (2 * 0.55 * 0.55));
      const fill = b.n / (b.w * b.h);
      const elong = Math.max(b.w, b.h) / Math.min(b.w, b.h);
      // A ball stays round (a little stretched when it's fast); shoes, arms and shirts don't.
      const shape = Math.min(1, fill / 0.55) * (elong <= 1.7 ? 1 : elong <= 2.6 ? 0.45 : 0.12);
      const motion = motionOK ? 0.25 + 0.75 * Math.min(1, b.mv * 1.5) : 0.7;
      // In play the ball is at net height or above. Well below the rim is where feet are.
      const below = (b.y - (e.cy + e.ry)) / e.rx;
      const height = below > 0.15 ? 0.3 : 1;
      let near = 1, gate = 0;
      if (pred) {
        const d = Math.hypot(b.x - pred.x, b.y - pred.y);
        gate = Math.exp(-(d * d) / (2 * pred.sig * pred.sig));
        near = 0.3 + 0.7 * gate;
      }
      // Anything away from where the ball was heading counts as a fresh start, with the same rules.
      // Only something right on the path of a ball that was already slowing down may be motionless
      // (a ball at the top of its arc, or settling on the net). A fresh start must look clearly like a ball.
      let minScore = s.minScore;
      if (gate < 0.05 || (b.mv < 0.25 && !(gate >= 0.5 && trackSlow))) {
        if (motionOK && b.mv < 0.25) continue;
        if (this.ignore.some((z) => t < z.until && Math.hypot(b.x - z.x, b.y - z.y) < 3 * expR)) continue;
        minScore = s.minStartScore;
      }
      const score = size * shape * motion * height * near;
      if (score >= minScore && score > bestScore) { bestScore = score; best = { b, r }; }
    }

    if (!best) return null;
    const { b } = best;
    if (tr) {
      const dt = (t - tr.t) / 1000;
      if (dt > 0) {
        const vx = (b.x - tr.x) / dt, vy = (b.y - tr.y) / dt;
        tr.vx = tr.vx * 0.3 + vx * 0.7;
        tr.vy = tr.vy * 0.3 + vy * 0.7;
      }
      tr.x = b.x; tr.y = b.y; tr.t = t;
      // Something that has sat still for a while is not a ball in play. Let go of it.
      if (tr.anchor && Math.hypot(b.x - tr.anchor.x, b.y - tr.anchor.y) < 1.2 * expR) {
        if (t - tr.anchor.t > 600) {
          this.ignore = this.ignore.filter((z) => t < z.until);
          this.ignore.push({ x: b.x, y: b.y, until: t + 4000 });
          this.track = null;
          return null;
        }
      } else tr.anchor = { x: b.x, y: b.y, t };
    } else {
      this.track = { x: b.x, y: b.y, vx: 0, vy: 0, t, anchor: { x: b.x, y: b.y, t } };
    }
    // Radius from the blob's narrow side: motion blur stretches a fast ball along its path only.
    const r = Math.min(b.w, b.h) / 2;
    return { x: b.x, y: b.y, r, n: b.n, score: bestScore };
  }
}

// Watches the ball track and reports net contacts: a bounce is the moment the ball stops
// moving down the screen and starts moving up; where that happens decides net / pocket / rim.
export class NetJudge {
  constructor(settings) { this.s = settings; this.reset(); }

  reset() {
    this.hist = [];
    this.vy = 0;
    this.phase = null;
    this.lastEvent = null;
    this.lastSeen = -1e9;
    this.slowSince = null;
    this.pending = null;
    this.insideStart = null;
    this.rollFired = false;
    this.farSinceNet = true;
  }

  // det: {x, y, r} or null. t: ms. e: rim ellipse in the same pixels. Returns new events.
  update(det, t, e) {
    const s = this.s, out = [];
    this.e = e;
    if (!det) {
      if (t - this.lastSeen > 250) { this.phase = null; this.insideStart = null; this.pending = null; }
      return out;
    }
    if (t - this.lastSeen > 250) {
      this.hist.length = 0; this.phase = null; this.vy = 0; this.pending = null; this.slowSince = null;
      this.insideStart = null; this.rollFired = false;
    }
    this.lastSeen = t;

    const cy = det.y + det.r;              // bottom of the ball is what touches the net
    const d = ellipseDist(det.x, cy, e);
    const p = { t, x: det.x, y: det.y, cy, d, r: det.r };
    const prev = this.hist[this.hist.length - 1];
    this.hist.push(p);
    while (this.hist.length && t - this.hist[0].t > 600) this.hist.shift();
    if (d > 2.5) this.farSinceNet = true;

    if (prev) {
      // Speed over the last ~30 ms rather than one frame, so jitter doesn't grow with frame rate.
      let ref = prev;
      for (let i = this.hist.length - 2; i >= 0; i--) { ref = this.hist[i]; if (t - ref.t >= 30) break; }
      const dt = (t - ref.t) / 1000;
      if (dt > 0) this.vy = (det.y - ref.y) / dt;
      const thr = s.vThr * e.rx;
      // A ball that stops moving up or down for a while (resting or rolling) is no longer "falling".
      if (Math.abs(this.vy) < thr) { if (this.slowSince == null) this.slowSince = t; }
      else this.slowSince = null;
      if (this.slowSince != null && t - this.slowSince > 150) this.phase = null;
      const phase = this.vy > thr ? 'down' : this.vy < -thr ? 'up' : this.phase;
      if (this.phase === 'down' && phase === 'up' && !this.rollFired) this.pending = t;
      this.phase = phase;
    }

    // Wait for a couple of frames after the turnaround so both sides of the bounce are known.
    if (this.pending != null) {
      const contact = this.contactPoint(t);
      if (contact) {
        this.pending = null;
        const ev = this.classify(contact, t);
        if (ev) out.push(ev);
      }
    }

    if (d < 1) {
      if (this.insideStart == null) this.insideStart = t;
      else if (!this.rollFired && t - this.insideStart > s.rollMs) {
        this.rollFired = true;
        out.push(this.emit('roll', p));
      }
    } else {
      this.insideStart = null;
      this.rollFired = false;
    }
    return out;
  }

  // The camera rarely catches the exact frame the ball touches the net, so the touch point is
  // estimated where the falling path and the rising path meet. Returns null to wait another frame.
  contactPoint(t) {
    const win = this.hist.filter((h) => t - h.t < 300);
    let k = -1;
    for (let i = 0; i < win.length; i++) if (k < 0 || win[i].cy > win[k].cy) k = i;
    if (k < 0) return null;
    const low = win[k];
    const after = win.length - 1 - k;
    if (after < 2 && t - this.pending < 90) return null;

    let best = low;
    const a = win[k - 2], b = win[k - 1], c = win[k + 1], d = win[k + 2];
    if (a && b && c && d && b.y > a.y && d.y < c.y) {
      const s1 = (b.y - a.y) / (b.t - a.t), s2 = (d.y - c.y) / (d.t - c.t);
      let tc = (c.y - s2 * c.t - (a.y - s1 * a.t)) / (s1 - s2);
      tc = Math.min(c.t, Math.max(b.t, tc));
      const y = a.y + s1 * (tc - a.t);
      if (y > low.y) {
        const x = tc <= low.t
          ? a.x + ((b.x - a.x) / (b.t - a.t)) * (tc - a.t)
          : c.x + ((d.x - c.x) / (d.t - c.t)) * (tc - c.t);
        best = { t: tc, x, y, cy: y + low.r, r: low.r };
      }
    }
    best.d = ellipseDist(best.x, best.cy, this.e);
    return best;
  }

  classify(p, t) {
    const s = this.s;
    if (!p) return null;
    if (this.lastEvent && t - this.lastEvent.t < 150) return null;
    let kind;
    if (p.d <= s.netMax) kind = 'net';
    else if (p.d < s.rimMin) kind = 'pocket';
    else if (p.d <= s.rimMax) kind = 'rim';
    else return null; // turned around away from the net: a player's touch
    const prev = this.lastEvent;
    if (kind !== 'rim' && prev && (prev.kind === 'net' || prev.kind === 'pocket') &&
        p.t - prev.t < s.doubleMs && !this.farSinceNet) kind = 'double';
    this.farSinceNet = false;
    this.insideStart = p.d < 1 ? t : null;
    return this.emit(kind, p);
  }

  emit(kind, p) {
    const s = this.s;
    const near = Math.abs(p.d - s.rimMin) < 0.05 || Math.abs(p.d - s.rimMax) < 0.05;
    const ev = { kind, t: p.t, x: p.x, y: p.y, cy: p.cy, d: p.d, r: p.r, near };
    this.lastEvent = ev;
    return ev;
  }
}
