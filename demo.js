// A drawn practice scene: the net seen from a low angle, and a yellow ball playing a loop of
// scripted shots (clean hit, rim, pocket, roll-up, double bounce) so the tracker can be tried
// without a camera. It is made deliberately messy, like a real park: sunny yellow-green grass,
// a yellow cone, a player's yellow shoe sliding around, motion blur on the ball and sensor noise.

const W = 960, H = 540;
const RIM = { cx: 480, cy: 330, rx: 190, ry: 46 };
const R = 18;

// A point on the net surface, given in rim units (a, b), as the ball center resting on it.
const pt = (a, b) => [RIM.cx + a * RIM.rx, RIM.cy + b * RIM.ry - R];

// Segment types: fall speeds up (gravity), rise slows down, line is constant speed.
const PLAYS = [
  { name: 'Clean net hit', segs: [['fall', [300, 40], pt(-0.15, 0.1), 0.45], ['rise', null, [760, 30], 0.5]] },
  { name: 'Rim hit',       segs: [['fall', [650, 30], pt(0.6, 0.8), 0.45], ['rise', null, [900, 250], 0.35]] },
  { name: 'Pocket',        segs: [['fall', [250, 40], pt(-0.72, 0.47), 0.45], ['rise', null, [120, 60], 0.5]] },
  { name: 'Roll-up',       segs: [['fall', [380, 120], pt(-0.5, 0.3), 0.3], ['line', null, pt(0.4, -0.2), 0.75], ['fall', null, [820, 200], 0.25]] },
  { name: 'Double bounce', segs: [['fall', [420, 40], pt(0.1, 0), 0.45], ['rise', null, [470, 230], 0.18], ['fall', null, pt(0.25, 0.2), 0.18], ['rise', null, [640, 40], 0.45]] },
];
const GAP = 0.7; // seconds with no ball between plays
const LENGTHS = PLAYS.map((p) => p.segs.reduce((s, x) => s + x[3], 0) + GAP);
const TOTAL = LENGTHS.reduce((a, b) => a + b, 0);
const SHUTTER = 0.012; // seconds the camera shutter is open: smears a fast ball

export class DemoScene {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = W; canvas.height = H;
    this.ctx = canvas.getContext('2d');
    this.clock = 0;
    this.last = null;
    this.paused = false;
    this.rimNorm = { cx: RIM.cx / W, cy: RIM.cy / H, rx: RIM.rx / W, ry: RIM.ry / H };
    this.ballRadius = R;
    this.bg = this.paintBackground();
    this.noise = this.paintNoise();
  }

  get playName() { return this.current ? this.current.name : ''; }

  paintBackground() {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#5d7a52');
    grd.addColorStop(1, '#43603b');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    // Sunny, dried-out patches of grass close to the ball's yellow
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const [px, py, s] of [[150, 200, 60], [790, 120, 70], [720, 430, 50], [260, 470, 45], [880, 300, 40]]) {
      for (let i = 0; i < 9; i++) {
        g.beginPath();
        g.ellipse(px + (rnd() - 0.5) * s * 1.6, py + (rnd() - 0.5) * s * 0.7, s * (0.25 + rnd() * 0.35), s * (0.12 + rnd() * 0.2), rnd() * 3, 0, Math.PI * 2);
        g.fillStyle = `hsla(${66 + rnd() * 10}, 55%, ${48 + rnd() * 12}%, .8)`;
        g.fill();
      }
    }
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(30,50,25,.25)' : 'rgba(120,150,110,.18)';
      g.fillRect(rnd() * W, rnd() * H, 2, 3);
    }
    // A yellow cone that never moves
    g.beginPath();
    g.moveTo(110, 380); g.lineTo(130, 336); g.lineTo(150, 380); g.closePath();
    g.fillStyle = '#f0c419';
    g.fill();
    g.fillStyle = '#c99d0e';
    g.fillRect(104, 378, 52, 7);
    // legs
    g.fillStyle = '#1b1e22';
    for (const a of [-0.95, -0.55, 0, 0.55, 0.95]) {
      const x = RIM.cx + a * RIM.rx, y = RIM.cy + Math.sqrt(1 - a * a) * RIM.ry * 0.9;
      g.fillRect(x - 5, y - 4, 10, 46);
    }
    // net
    g.beginPath();
    g.ellipse(RIM.cx, RIM.cy, RIM.rx, RIM.ry, 0, 0, Math.PI * 2);
    g.fillStyle = '#23272d';
    g.fill();
    g.save();
    g.clip();
    g.strokeStyle = 'rgba(255,255,255,.08)';
    g.lineWidth = 1;
    for (let x = RIM.cx - RIM.rx; x < RIM.cx + RIM.rx; x += 14) { g.beginPath(); g.moveTo(x, RIM.cy - RIM.ry); g.lineTo(x + 30, RIM.cy + RIM.ry); g.stroke(); }
    g.restore();
    // rim
    g.beginPath();
    g.ellipse(RIM.cx, RIM.cy, RIM.rx, RIM.ry, 0, 0, Math.PI * 2);
    g.strokeStyle = '#0e1013';
    g.lineWidth = 9;
    g.stroke();
    return c;
  }

  paintNoise() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const id = g.createImageData(256, 256);
    for (let i = 0; i < id.data.length; i += 4) {
      const v = Math.random() * 255;
      id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
      id.data[i + 3] = 22;
    }
    g.putImageData(id, 0, 0);
    return this.ctx.createPattern(c, 'repeat');
  }

  // Ball center at a clock time, or null between plays.
  ballAt(clock) {
    let t = ((clock % TOTAL) + TOTAL) % TOTAL, idx = 0;
    while (t > LENGTHS[idx]) { t -= LENGTHS[idx]; idx++; }
    const play = PLAYS[idx];
    this.current = play;
    let from = play.segs[0][1];
    for (const [type, start, to, dur] of play.segs) {
      if (start) from = start;
      if (t <= dur) {
        const s = t / dur;
        const ey = type === 'fall' ? s * s : type === 'rise' ? 1 - (1 - s) * (1 - s) : s;
        return [from[0] + (to[0] - from[0]) * s, from[1] + (to[1] - from[1]) * ey];
      }
      t -= dur;
      from = to;
    }
    return null;
  }

  // A player's yellow shoe shuffling back and forth near the front of the net.
  shoeAt(clock) {
    return [160 + Math.sin(clock * 1.9) * 110, 455 + Math.sin(clock * 3.1) * 6];
  }

  step(now) {
    if (this.last != null && !this.paused) this.clock += Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.render(this.clock);
  }

  render(clock) {
    const g = this.ctx;
    g.drawImage(this.bg, 0, 0);

    const [sx, sy] = this.shoeAt(clock);
    g.fillStyle = '#e8c21a';
    g.beginPath();
    g.roundRect(sx - 26, sy - 9, 52, 18, 8);
    g.fill();
    g.fillStyle = '#f5f5f5';
    g.fillRect(sx - 26, sy + 6, 52, 4);

    const b = this.ballAt(clock);
    const name = this.playName;
    if (b) {
      g.beginPath();
      g.ellipse(b[0] + 4, Math.max(b[1] + R + 6, RIM.cy), R * 0.9, R * 0.3, 0, 0, Math.PI * 2);
      g.fillStyle = 'rgba(0,0,0,.25)';
      g.fill();
      // Several exposures across the shutter time make a fast ball smear like it does on camera
      const shots = 5;
      for (let j = shots - 1; j >= 0; j--) {
        const p = this.ballAt(clock - (SHUTTER * j) / (shots - 1)) || b;
        g.globalAlpha = j === 0 ? 1 : 0.45;
        const grd = g.createRadialGradient(p[0] - 5, p[1] - 6, 2, p[0], p[1], R);
        grd.addColorStop(0, '#fff27a');
        grd.addColorStop(1, '#d4ad0d');
        g.beginPath();
        g.arc(p[0], p[1], R, 0, Math.PI * 2);
        g.fillStyle = grd;
        g.fill();
      }
      g.globalAlpha = 1;
    }
    this.current = PLAYS.find((p) => p.name === name);

    g.save();
    g.translate(Math.random() * 256, Math.random() * 256);
    g.fillStyle = this.noise;
    g.fillRect(-256, -256, W + 256, H + 256);
    g.restore();

    g.fillStyle = 'rgba(0,0,0,.45)';
    g.fillRect(16, 16, 250, 34);
    g.fillStyle = '#fff';
    g.font = '600 18px system-ui, sans-serif';
    g.fillText('Demo shot: ' + this.playName, 28, 39);
  }
}
