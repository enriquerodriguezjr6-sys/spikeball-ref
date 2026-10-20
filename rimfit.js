// Finds the rim in a frame without help. The net and rim are a dark oval on lighter ground, so:
// mark dark pixels (at a few darkness levels, for sun and shade), wipe out thin things like the
// legs, take the outline of each dark shape, fit an oval to the outline while throwing out stray
// points, and keep the oval whose edge best matches a real dark-to-light border.
// No DOM here. Ovals are {cx, cy, rx, ry, score} as fractions of the frame.

// The best oval, or null.
export function fitRim(data, W, H) {
  return findRims(data, W, H)[0] || null;
}

// Every believable oval, best first, without near-duplicates.
export function findRims(data, W, H) {
  const N = W * H;
  const Y = new Uint8Array(N);
  const hist = new Uint32Array(256);
  for (let p = 0, i = 0; p < N; p++, i += 4) {
    const y = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    Y[p] = y;
    hist[y]++;
  }
  let acc = 0, median = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= N / 2) { median = v; break; } }

  const found = [];
  const dark = new Uint8Array(N);
  for (const f of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    const thr = median * f;
    for (let p = 0; p < N; p++) dark[p] = Y[p] < thr ? 1 : 0;
    // A thin rim only survives the small cleanup; legs are only removed by the bigger one. Try both.
    for (const r of [1, 2]) {
      const opened = openMask(dark, W, H, r);
      for (const pts of outlines(opened, W, H, Math.max(40, N * 0.003))) {
       // Also fit the top half of the outline alone: a shadow or a leg merged into the bottom
       // of the net can't pull that one off.
       const ys = pts.map((p) => p[1]).sort((a, b) => a - b);
       const midY = ys[ys.length >> 1];
       const top = pts.filter((p) => p[1] <= midY);
       for (const sub of [pts, top]) {
        const fit = fitOval(sub);
        if (!fit) continue;
        if (fit.rx < W * 0.06 || fit.rx > W * 0.49 || fit.ry < 2 || fit.ry > fit.rx * 1.15) continue;
        if (fit.cx < 0 || fit.cx > W || fit.cy < 0 || fit.cy > H) continue;
        const edge = edgeContrast(dark, W, H, fit);
        const size = 0.7 + 0.3 * Math.min(1, fit.rx / (W * 0.25));
        const legs = legCount(dark, W, H, fit) >= 2 ? 1.25 : 1; // a rim stands on legs; its shadow doesn't
        const score = fit.inliers * edge * size * legs;
        if (score >= 0.45) found.push({ ...fit, score });
       }
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const f of found) {
    if (kept.some((o) => Math.abs(o.cx - f.cx) < f.rx * 0.25 && Math.abs(o.cy - f.cy) < f.rx * 0.15)) continue;
    kept.push(f);
    if (kept.length === 4) break;
  }
  // The outline is the outside of the rim tube; the line to judge against is its middle (~2.7% of the radius in).
  return kept.map((f) => {
    const t = 0.027 * f.rx;
    return { cx: f.cx / W, cy: f.cy / H, rx: (f.rx - t) / W, ry: Math.max(1, f.ry - t) / H, score: f.score };
  });
}

// Thin dark uprights just under the oval: the set's legs.
function legCount(dark, W, H, f) {
  let runs = 0, run = 0;
  const maxRun = Math.max(2, f.rx * 0.12);
  for (let x = Math.ceil(f.cx - f.rx * 0.95); x <= f.cx + f.rx * 0.95; x++) {
    const u = (x - f.cx) / f.rx;
    const y = Math.round(f.cy + f.ry * Math.sqrt(Math.max(0, 1 - u * u)) + Math.max(3, f.rx * 0.1));
    const d = x >= 0 && x < W && y >= 0 && y < H ? dark[y * W + x] : 0;
    if (d) run++;
    else { if (run > 0 && run <= maxRun) runs++; run = 0; }
  }
  return runs;
}

// Several frames at once: fits each and takes the middle value of each measurement, so a ball
// or a player crossing the net in one frame doesn't throw it off.
export function fitRimMedian(fits) {
  const ok = fits.filter(Boolean);
  if (ok.length < Math.ceil(fits.length / 2)) return null;
  const mid = (k) => { const v = ok.map((f) => f[k]).sort((a, b) => a - b); return v[(v.length - 1) >> 1]; };
  return { cx: mid('cx'), cy: mid('cy'), rx: mid('rx'), ry: mid('ry'), score: mid('score') };
}

function integral(mask, W, H) {
  const ii = new Uint32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += mask[y * W + x];
      ii[(y + 1) * (W + 1) + x + 1] = ii[y * (W + 1) + x + 1] + row;
    }
  }
  return ii;
}

function boxSum(ii, W, x0, y0, x1, y1) {
  const w = W + 1;
  return ii[(y1 + 1) * w + x1 + 1] - ii[y0 * w + x1 + 1] - ii[(y1 + 1) * w + x0] + ii[y0 * w + x0];
}

// Erode then dilate with a square of side 2r+1: removes anything thinner than that, like legs.
function openMask(mask, W, H, r) {
  const k = (2 * r + 1) * (2 * r + 1);
  const ii = integral(mask, W, H);
  const er = new Uint8Array(W * H);
  for (let y = r; y < H - r; y++)
    for (let x = r; x < W - r; x++)
      if (mask[y * W + x] && boxSum(ii, W, x - r, y - r, x + r, y + r) === k) er[y * W + x] = 1;
  const ie = integral(er, W, H);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (boxSum(ie, W, Math.max(0, x - r), Math.max(0, y - r), Math.min(W - 1, x + r), Math.min(H - 1, y + r)) > 0) out[y * W + x] = 1;
  return out;
}

// For each dark shape big enough to be a net: the leftmost and rightmost point of every row and
// the top and bottom point of every column. That traces the outside edge whether the net looks
// solid dark or only the rim ring does.
function outlines(mask, W, H, minN) {
  const labels = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  const shapes = [];
  let id = 0;
  for (let p = 0; p < W * H; p++) {
    if (!mask[p] || labels[p]) continue;
    id++;
    const pix = [];
    let sp = 0;
    stack[sp++] = p;
    labels[p] = id;
    while (sp) {
      const q = stack[--sp];
      pix.push(q);
      const x = q % W, y = (q / W) | 0;
      if (x > 0 && mask[q - 1] && !labels[q - 1]) { labels[q - 1] = id; stack[sp++] = q - 1; }
      if (x < W - 1 && mask[q + 1] && !labels[q + 1]) { labels[q + 1] = id; stack[sp++] = q + 1; }
      if (y > 0 && mask[q - W] && !labels[q - W]) { labels[q - W] = id; stack[sp++] = q - W; }
      if (y < H - 1 && mask[q + W] && !labels[q + W]) { labels[q + W] = id; stack[sp++] = q + W; }
    }
    if (pix.length < minN || pix.length > W * H * 0.6) continue;
    const rowMin = new Map(), rowMax = new Map(), colMin = new Map(), colMax = new Map();
    for (const q of pix) {
      const x = q % W, y = (q / W) | 0;
      if (!rowMin.has(y) || x < rowMin.get(y)) rowMin.set(y, x);
      if (!rowMax.has(y) || x > rowMax.get(y)) rowMax.set(y, x);
      if (!colMin.has(x) || y < colMin.get(x)) colMin.set(x, y);
      if (!colMax.has(x) || y > colMax.get(x)) colMax.set(x, y);
    }
    const pts = [];
    for (const [y, x] of rowMin) pts.push([x, y]);
    for (const [y, x] of rowMax) pts.push([x + 1, y]);
    for (const [x, y] of colMin) pts.push([x, y]);
    for (const [x, y] of colMax) pts.push([x, y + 1]);
    shapes.push(pts);
  }
  return shapes;
}

// Oval (level, not tilted) through outline points. Many quick guesses from 4 random outline
// points; the guess most points agree with wins, so a leg or shadow stuck to the net can't drag
// it off. Then a careful least-squares fit on the points that agree.
function fitOval(all) {
  const n = all.length;
  if (n < 12) return null;
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let best = null;
  for (let it = 0; it < 300; it++) {
    const f = solveOval([all[(rnd() * n) | 0], all[(rnd() * n) | 0], all[(rnd() * n) | 0], all[(rnd() * n) | 0]]);
    if (!f || f.rx < 4 || f.ry < 1.5 || f.rx > 4000 || f.ry > 4000) continue;
    const tol = Math.max(1.5, 0.02 * f.rx);
    let cnt = 0;
    for (const [x, y] of all) if (offBy(f, x, y) < tol) cnt++;
    if (!best || cnt > best.cnt) best = { f, cnt };
  }
  if (!best || best.cnt < 12) return null;
  let fit = best.f;
  for (const k of [0.03, 0.02, 0.02]) {
    const tol = Math.max(1.5, k * fit.rx);
    const keep = all.filter(([x, y]) => offBy(fit, x, y) < tol);
    if (keep.length < 12) return null;
    const next = solveOval(keep);
    if (!next) return null;
    fit = next;
  }
  const tol = Math.max(1.5, 0.02 * fit.rx);
  fit.inliers = all.filter(([x, y]) => offBy(fit, x, y) < tol).length / n;
  return fit;
}

// Roughly how many pixels a point is off the oval.
function offBy(f, x, y) {
  const dx = x - f.cx, dy = y - f.cy;
  const F = (dx * dx) / (f.rx * f.rx) + (dy * dy) / (f.ry * f.ry) - 1;
  const gx = (2 * dx) / (f.rx * f.rx), gy = (2 * dy) / (f.ry * f.ry);
  return Math.abs(F) / (Math.hypot(gx, gy) || 1e-9);
}

// A x² + C y² + D x + E y = 1, solved on centered, scaled points for stable numbers.
function solveOval(pts) {
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let sc = 0;
  for (const [x, y] of pts) sc += Math.abs(x - mx) + Math.abs(y - my);
  sc = sc / pts.length || 1;
  const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], v = [0, 0, 0, 0];
  for (const [px, py] of pts) {
    const x = (px - mx) / sc, y = (py - my) / sc;
    const row = [x * x, y * y, x, y];
    for (let i = 0; i < 4; i++) {
      v[i] += row[i];
      for (let j = 0; j < 4; j++) M[i][j] += row[i] * row[j];
    }
  }
  const sol = solve4(M, v);
  if (!sol) return null;
  const [A, C, D, E] = sol;
  if (!(A > 0 && C > 0)) return null;
  const x0 = -D / (2 * A), y0 = -E / (2 * C);
  const G = 1 + A * x0 * x0 + C * y0 * y0;
  if (!(G > 0)) return null;
  return { cx: mx + x0 * sc, cy: my + y0 * sc, rx: Math.sqrt(G / A) * sc, ry: Math.sqrt(G / C) * sc };
}

function solve4(M, v) {
  const a = M.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (Math.abs(a[piv][c]) < 1e-12) return null;
    [a[c], a[piv]] = [a[piv], a[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k < 5; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((r, i) => r[4] / r[i]);
}

// Share of points around the oval where it is dark just inside and light just outside.
function edgeContrast(dark, W, H, f) {
  let good = 0, total = 0;
  const at = (x, y) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return -1;
    return dark[yi * W + xi];
  };
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const pad = Math.max(1.5, 0.06 * f.ry);
    const inside = at(f.cx + c * (f.rx - pad * 1.5), f.cy + s * (f.ry - pad));
    const outside = at(f.cx + c * (f.rx + pad * 1.5), f.cy + s * (f.ry + pad));
    if (inside < 0 || outside < 0) continue;
    total++;
    if (inside === 1 && outside === 0) good++;
  }
  return total ? good / total : 0;
}
