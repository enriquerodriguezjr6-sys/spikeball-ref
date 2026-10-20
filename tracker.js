// Ball detection and net-contact judging. No DOM here, so it runs the same on camera, clip or demo frames.
//
// Coordinates are pixels in the small processing frame (320 px wide). The rim is an ellipse
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
  minPix: 6,
  maxPix: 3000,
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

export class BallDetector {
  constructor(W = 320, H = 180) { this.resize(W, H); }

  resize(W, H) {
    this.W = W; this.H = H; this.CS = 6;
    this.gw = Math.ceil(W / this.CS); this.gh = Math.ceil(H / this.CS);
    this.cells = new Uint16Array(this.gw * this.gh);
    this.mask = new Uint8Array(W * H);
  }

  // data: RGBA pixels of the W×H frame. roi: {x0,x1,y0,y1}. pred: {x,y,r} near where we expect the ball, or null.
  detect(data, s, roi, pred) {
    const { W, H, CS, gw, gh, cells, mask } = this;
    cells.fill(0);
    mask.fill(0);
    const x0 = Math.max(0, roi.x0 | 0), x1 = Math.min(W, Math.ceil(roi.x1));
    const y0 = Math.max(0, roi.y0 | 0), y1 = Math.min(H, Math.ceil(roi.y1));
    const hue = s.hue, tol = s.hueTol, minS = s.minSat, minV = s.minVal * 255;

    for (let y = y0; y < y1; y++) {
      let i = (y * W + x0) * 4;
      const row = ((y / CS) | 0) * gw;
      for (let x = x0; x < x1; x++, i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        if (mx < minV) continue;
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        const c = mx - mn;
        if (c < minS * mx || c === 0) continue;
        let h;
        if (mx === r) h = ((g - b) / c) % 6;
        else if (mx === g) h = (b - r) / c + 2;
        else h = (r - g) / c + 4;
        h *= 60;
        if (h < 0) h += 360;
        let dh = h > hue ? h - hue : hue - h;
        if (dh > 180) dh = 360 - dh;
        if (dh > tol) continue;
        mask[y * W + x] = 1;
        cells[row + ((x / CS) | 0)]++;
      }
    }

    // Pick the densest 3×3 block of cells, favoring blocks near where the ball was last seen.
    let best = -1, bestScore = 0;
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) {
        if (!cells[cy * gw + cx]) continue;
        let sum = 0;
        for (let yy = Math.max(0, cy - 1); yy <= Math.min(gh - 1, cy + 1); yy++)
          for (let xx = Math.max(0, cx - 1); xx <= Math.min(gw - 1, cx + 1); xx++) sum += cells[yy * gw + xx];
        if (sum < s.minPix) continue;
        let score = sum;
        if (pred) {
          const dx = (cx + 0.5) * CS - pred.x, dy = (cy + 0.5) * CS - pred.y;
          score *= 0.3 + Math.exp(-(dx * dx + dy * dy) / (2 * pred.r * pred.r));
        }
        if (score > bestScore) { bestScore = score; best = cy * gw + cx; }
      }
    }
    if (best < 0) return null;

    const bx = best % gw, by = (best / gw) | 0;
    const wx0 = Math.max(0, (bx - 3) * CS), wx1 = Math.min(W, (bx + 4) * CS);
    const wy0 = Math.max(0, (by - 3) * CS), wy1 = Math.min(H, (by + 4) * CS);
    let n = 0, sx = 0, sy = 0;
    for (let y = wy0; y < wy1; y++) {
      const o = y * W;
      for (let x = wx0; x < wx1; x++) if (mask[o + x]) { n++; sx += x; sy += y; }
    }
    if (n < s.minPix || n > s.maxPix) return null;
    return { x: sx / n, y: sy / n, n, r: Math.sqrt(n / Math.PI) };
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
