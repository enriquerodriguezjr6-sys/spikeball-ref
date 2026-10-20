// A drawn practice scene: the net seen from a low angle, and a yellow ball playing a loop of
// scripted shots (clean hit, rim, pocket, roll-up, double bounce) so the tracker can be tried
// without a camera.

const W = 960, H = 540;
const RIM = { cx: 480, cy: 330, rx: 190, ry: 46 };
const R = 14;

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

export class DemoScene {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = W; canvas.height = H;
    this.ctx = canvas.getContext('2d');
    this.clock = 0;
    this.last = null;
    this.paused = false;
    this.rimNorm = { cx: RIM.cx / W, cy: RIM.cy / H, rx: RIM.rx / W, ry: RIM.ry / H };
    this.bg = this.paintBackground();
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
    // grass texture
    for (let i = 0; i < 2200; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(30,50,25,.25)' : 'rgba(120,150,110,.18)';
      g.fillRect(Math.random() * W, Math.random() * H, 2, 3);
    }
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

  // Returns the ball center for clock time, or null between plays.
  ballAt(clock) {
    const lengths = PLAYS.map(p => p.segs.reduce((s, x) => s + x[3], 0) + GAP);
    const total = lengths.reduce((a, b) => a + b, 0);
    let t = clock % total, idx = 0;
    while (t > lengths[idx]) { t -= lengths[idx]; idx++; }
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

  step(now) {
    if (this.last != null && !this.paused) this.clock += Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const g = this.ctx;
    g.drawImage(this.bg, 0, 0);
    const b = this.ballAt(this.clock);
    if (b) {
      const [x, y] = b;
      g.beginPath();
      g.ellipse(x + 4, Math.max(y + R + 6, RIM.cy), R * 0.9, R * 0.3, 0, 0, Math.PI * 2);
      g.fillStyle = 'rgba(0,0,0,.25)';
      g.fill();
      const grd = g.createRadialGradient(x - 4, y - 5, 2, x, y, R);
      grd.addColorStop(0, '#fff27a');
      grd.addColorStop(1, '#e6c10f');
      g.beginPath();
      g.arc(x, y, R, 0, Math.PI * 2);
      g.fillStyle = grd;
      g.fill();
    }
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.fillRect(16, 16, 230, 34);
    g.fillStyle = '#fff';
    g.font = '600 18px system-ui, sans-serif';
    g.fillText('Demo shot: ' + this.playName, 28, 39);
  }
}
