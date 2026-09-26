/**
 * The example part: the upper housing of a random orbital sander, Rev B.
 *
 * One model feeds every view on the site. The housing is described as a
 * signed distance field (negative inside the material), from which
 *  - the 2D drawings take their outlines: the exterior silhouette, and the
 *    section through the axis, contoured by marching squares, and
 *  - the WebGL render takes its shader (see `glsl`), built from the same
 *    numbers.
 * So a fillet or a wall thickness changes in every view at once.
 *
 * Units are millimetres. y runs up the axis from the bottom rim; x runs to
 * the right in the front view; z points at the viewer. The body is turned
 * about the y axis, and the dust port points along +x.
 */

export const T = 2.5; // nominal wall
export const H = 124; // overall height

/** Rev B dimensions, and the values they replaced. */
export const rev = {
  wall: { was: 2.0, now: 2.5 }, // motor mount wall, Sketch 4 D3
  fillet: { was: 1.5, now: 2 }, // Fillet 7, wall to shell
};

export const G = {
  // Skirt over the fan: a rounded box from below the rim to y = 18
  fan: { cy: 5, hr: 62, hh: 13, round: 4 },
  // Motor section: a frustum from r = 54 at y = 18 to r = 40 at y = 90
  waist: { y0: 18, y1: 90, r0: 54, r1: 40 },
  // Palm grip: an ellipse centred on the axis
  grip: { cy: 96, rx: 46, ry: 28 },
  // Fillet radii where the three meet
  blendShoulder: 10,
  blendGrip: 8,
  // Motor mount wall (the Rev B change) and its bearing boss (608 bearing, OD 22)
  wall: { y0: 40, y1: 40 + rev.wall.now, hole: 5 },
  boss: { r0: 11, r1: 14, y0: 32 },
  top: { r0: 6.5, r1: 9.5, y0: 108 },
  fillet: rev.fillet.now,
  // Dust port out of the skirt, along -x
  port: { y: 14, ro: 13, ri: 10.5, x0: -90, x1: -50 },
};

// ---------------------------------------------------------------------------
// 2D signed distance functions, after Inigo Quilez.

type V2 = [number, number];
const len = (x: number, y: number) => Math.hypot(x, y);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function sdRoundBox(px: number, py: number, hx: number, hy: number, r: number) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdBox(px: number, py: number, hx: number, hy: number) {
  return sdRoundBox(px, py, hx, hy, 0);
}

/** Isosceles trapezoid centred on the origin: half-widths r1 (bottom), r2 (top), half-height he. */
function sdTrapezoid(px: number, py: number, r1: number, r2: number, he: number) {
  const k1x = r2;
  const k1y = he;
  const k2x = r2 - r1;
  const k2y = 2 * he;
  px = Math.abs(px);
  const cax = px - Math.min(px, py < 0 ? r1 : r2);
  const cay = Math.abs(py) - he;
  const t = clamp(((k1x - px) * k2x + (k1y - py) * k2y) / (k2x * k2x + k2y * k2y), 0, 1);
  const cbx = px - k1x + k2x * t;
  const cby = py - k1y + k2y * t;
  const s = cbx < 0 && cay < 0 ? -1 : 1;
  return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
}

/**
 * Distance to an ellipse with semi-axes a, b, by Newton iteration on the
 * nearest point's angle. Stable everywhere, unlike the closed form.
 */
function sdEllipse(px: number, py: number, a: number, b: number) {
  px = Math.abs(px);
  py = Math.abs(py);
  const qx = a * (px - a);
  const qy = b * (py - b);
  let [cx, cy] = qx < qy ? [0.01, 1] : [1, 0.01];
  let l = Math.hypot(cx, cy);
  cx /= l;
  cy /= l;
  for (let i = 0; i < 6; i++) {
    const ux = a * cx;
    const uy = b * cy;
    const vx = -a * cy;
    const vy = b * cx;
    const A = (px - ux) * vx + (py - uy) * vy;
    const C = (px - ux) * ux + (py - uy) * uy + vx * vx + vy * vy;
    const B = Math.sqrt(Math.max(C * C - A * A, 0));
    const nx = (cx * B - cy * A) / C;
    const ny = (cy * B + cx * A) / C;
    l = Math.hypot(nx, ny) || 1;
    cx = nx / l;
    cy = ny / l;
  }
  const d = Math.hypot(px - a * cx, py - b * cy);
  return (px / a) ** 2 + (py / b) ** 2 > 1 ? d : -d;
}

/** Union with a round fillet of radius r in the concave corner only (after hg_sdf). */
function unionRound(a: number, b: number, r: number) {
  const ux = Math.max(r - a, 0);
  const uy = Math.max(r - b, 0);
  return Math.max(r, Math.min(a, b)) - Math.hypot(ux, uy);
}

// ---------------------------------------------------------------------------
// The housing

/** Outer body of revolution, as a 2D field over (radius, height). */
export function body(r: number, y: number) {
  const { fan, waist, grip } = G;
  const f = sdRoundBox(r, y - fan.cy, fan.hr, fan.hh, fan.round);
  const w = sdTrapezoid(
    r,
    y - (waist.y0 + waist.y1) / 2,
    waist.r0,
    waist.r1,
    (waist.y1 - waist.y0) / 2,
  );
  const e = sdEllipse(r, y - grip.cy, grip.rx, grip.ry);
  return unionRound(unionRound(f, w, G.blendShoulder), e, G.blendGrip);
}

/** The molded housing: shell, motor mount wall, bosses and dust port. */
export function solid(x: number, y: number, z: number) {
  const r = Math.hypot(x, z);
  const b = body(r, y);
  // Shell: the band between the outer surface and T inside it, open at the rim.
  let d = Math.max(b, -b - T, -y);
  // Motor mount wall and the bearing boss under it, filleted to the shell.
  const { wall, boss, top } = G;
  // The wall reaches just into the shell, so its fillets form on the inside only.
  const wallBox = Math.max(
    sdBox(
      r - (wall.hole + 70) / 2,
      y - (wall.y0 + wall.y1) / 2,
      (70 - wall.hole) / 2,
      (wall.y1 - wall.y0) / 2,
    ),
    b + T - 0.3,
  );
  d = unionRound(d, wallBox, G.fillet);
  const bossBox = sdBox(
    r - (boss.r0 + boss.r1) / 2,
    y - (boss.y0 + wall.y1) / 2,
    (boss.r1 - boss.r0) / 2,
    (wall.y1 - boss.y0) / 2,
  );
  d = unionRound(d, bossBox, 1.5);
  const topBox = Math.max(
    sdBox(r - (top.r0 + top.r1) / 2, y - (top.y0 + H) / 2, (top.r1 - top.r0) / 2, (H - top.y0) / 2),
    b + T - 0.3,
  );
  d = unionRound(d, topBox, 1.5);
  // Dust port: a tube along -x, its bore cut through the shell.
  const { port } = G;
  const pr = Math.hypot(y - port.y, z);
  const tube = Math.max(pr - port.ro, port.ri - pr, port.x0 - x, x - port.x1, -(b + T));
  d = unionRound(d, tube, 3);
  const bore = Math.max(pr - port.ri, x, port.x0 - 1 - x);
  d = Math.max(d, -bore);
  return d;
}

// ---------------------------------------------------------------------------
// Outlines for the 2D drawings

/** Outer radius of the body at height y, found by bisection. */
export function radiusAt(y: number, level = 0) {
  let lo = 0;
  let hi = 80;
  if (body(lo, y) > level) return 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (body(mid, y) > level) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** The exterior silhouette in the front view: [radius, height] pairs from rim to apex. */
export function silhouette(step = 0.5): V2[] {
  const pts: V2[] = [];
  for (let y = 0; y <= H + 0.001; y += step) pts.push([radiusAt(y), y]);
  pts.push([0, H]);
  return pts;
}

type Seg = [V2, V2];

/**
 * Contours f = 0 over a box by marching squares and joins the segments into
 * closed or open polylines.
 */
export function contour(
  f: (x: number, y: number) => number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  step: number,
): V2[][] {
  const nx = Math.ceil((x1 - x0) / step);
  const ny = Math.ceil((y1 - y0) / step);
  const v: number[][] = [];
  for (let j = 0; j <= ny; j++) {
    v[j] = [];
    for (let i = 0; i <= nx; i++) v[j][i] = f(x0 + i * step, y0 + j * step);
  }
  const segs: Seg[] = [];
  const lerp = (a: number, b: number) => a / (a - b);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = v[j][i];
      const b = v[j][i + 1];
      const c = v[j + 1][i + 1];
      const d = v[j + 1][i];
      const X = x0 + i * step;
      const Y = y0 + j * step;
      const e: V2[] = [];
      // Edges: bottom a-b, right b-c, top d-c, left a-d
      if (a < 0 !== b < 0) e.push([X + lerp(a, b) * step, Y]);
      if (b < 0 !== c < 0) e.push([X + step, Y + lerp(b, c) * step]);
      if (d < 0 !== c < 0) e.push([X + lerp(d, c) * step, Y + step]);
      if (a < 0 !== d < 0) e.push([X, Y + lerp(a, d) * step]);
      if (e.length === 2) segs.push([e[0], e[1]]);
      else if (e.length === 4) {
        const center = (a + b + c + d) / 4;
        if (center < 0 === a < 0) {
          segs.push([e[0], e[1]], [e[2], e[3]]);
        } else {
          segs.push([e[0], e[3]], [e[1], e[2]]);
        }
      }
    }
  }
  // Join segments that share end points.
  const key = (p: V2) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const byPoint = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const p of s) {
      const k = key(p);
      const list = byPoint.get(k) ?? [];
      list.push(i);
      byPoint.set(k, list);
    }
  });
  const used = new Array(segs.length).fill(false);
  const lines: V2[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const line: V2[] = [segs[i][0], segs[i][1]];
    for (const dir of [1, -1]) {
      for (;;) {
        const end = dir === 1 ? line[line.length - 1] : line[0];
        const next = (byPoint.get(key(end)) ?? []).find((n) => !used[n]);
        if (next === undefined) break;
        used[next] = true;
        const [p, q] = segs[next];
        const other = key(p) === key(end) ? q : p;
        if (dir === 1) line.push(other);
        else line.unshift(other);
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Ramer–Douglas–Peucker simplification. A closed loop is split at the point
 * farthest from its start, so each half has a real chord to measure from.
 */
export function simplify(pts: V2[], tolerance: number): V2[] {
  if (pts.length < 3) return pts;
  const [sx, sy] = pts[0];
  const [ex, ey] = pts[pts.length - 1];
  if (Math.hypot(ex - sx, ey - sy) < 1e-9) {
    let split = 1;
    let far = 0;
    pts.forEach(([x, y], i) => {
      const dist = Math.hypot(x - sx, y - sy);
      if (dist > far) {
        far = dist;
        split = i;
      }
    });
    return [
      ...simplify(pts.slice(0, split + 1), tolerance).slice(0, -1),
      ...simplify(pts.slice(split), tolerance),
    ];
  }
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const lx = bx - ax;
  const ly = by - ay;
  const ll = Math.hypot(lx, ly) || 1;
  let far = 0;
  let index = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    const dist = Math.abs((px - ax) * ly - (py - ay) * lx) / ll;
    if (dist > far) {
      far = dist;
      index = i;
    }
  }
  if (far <= tolerance) return [pts[0], pts[pts.length - 1]];
  return [
    ...simplify(pts.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(pts.slice(index), tolerance),
  ];
}

/** Section through the axis, right half (x ≥ 0): the cut material as closed loops. */
export function sectionLoops(step = 0.2, tolerance = 0.04) {
  const f = (x: number, y: number) => Math.max(solid(x, y, 0), -x);
  return contour(f, -0.5, -1, 100, H + 1, step)
    .filter((l) => l.length > 8)
    .map((l) => simplify(l, tolerance));
}

// ---------------------------------------------------------------------------
// Shader source for the WebGL render, built from the same numbers.

const n = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

export const glsl = /* glsl */ `
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float sdBox(vec2 p, vec2 b) { return sdRoundBox(p, b, 0.0); }
float sdTrapezoid(vec2 p, float r1, float r2, float he) {
  vec2 k1 = vec2(r2, he);
  vec2 k2 = vec2(r2 - r1, 2.0 * he);
  p.x = abs(p.x);
  vec2 ca = vec2(p.x - min(p.x, (p.y < 0.0) ? r1 : r2), abs(p.y) - he);
  vec2 cb = p - k1 + k2 * clamp(dot(k1 - p, k2) / dot(k2, k2), 0.0, 1.0);
  float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
  return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}
float sdEllipse(vec2 p, vec2 ab) {
  p = abs(p);
  vec2 q = ab * (p - ab);
  vec2 cs = normalize((q.x < q.y) ? vec2(0.01, 1.0) : vec2(1.0, 0.01));
  for (int i = 0; i < 6; i++) {
    vec2 u = ab * vec2(cs.x, cs.y);
    vec2 v = ab * vec2(-cs.y, cs.x);
    float a = dot(p - u, v);
    float c = dot(p - u, u) + dot(v, v);
    float b = sqrt(max(c * c - a * a, 0.0));
    cs = normalize(vec2(cs.x * b - cs.y * a, cs.y * b + cs.x * a));
  }
  float d = length(p - ab * cs);
  return (dot(p / ab, p / ab) > 1.0) ? d : -d;
}
float unionRound(float a, float b, float r) {
  vec2 u = max(vec2(r - a, r - b), vec2(0.0));
  return max(r, min(a, b)) - length(u);
}
float body(float r, float y) {
  float f = sdRoundBox(vec2(r, y - ${n(G.fan.cy)}), vec2(${n(G.fan.hr)}, ${n(G.fan.hh)}), ${n(G.fan.round)});
  float w = sdTrapezoid(vec2(r, y - ${n((G.waist.y0 + G.waist.y1) / 2)}), ${n(G.waist.r0)}, ${n(G.waist.r1)}, ${n((G.waist.y1 - G.waist.y0) / 2)});
  float e = sdEllipse(vec2(r, y - ${n(G.grip.cy)}), vec2(${n(G.grip.rx)}, ${n(G.grip.ry)}));
  return unionRound(unionRound(f, w, ${n(G.blendShoulder)}), e, ${n(G.blendGrip)});
}
// Returns the housing's distance; id is 1 on the motor mount wall.
float solid(vec3 p, out float id) {
  float r = length(p.xz);
  float b = body(r, p.y);
  float d = max(max(b, -b - ${n(T)}), -p.y);
  float wallBox = max(sdBox(vec2(r - ${n((G.wall.hole + 70) / 2)}, p.y - ${n((G.wall.y0 + G.wall.y1) / 2)}), vec2(${n((70 - G.wall.hole) / 2)}, ${n((G.wall.y1 - G.wall.y0) / 2)})), b + ${n(T - 0.3)});
  id = step(wallBox, 0.35) * step(abs(p.y - ${n((G.wall.y0 + G.wall.y1) / 2)}), ${n((G.wall.y1 - G.wall.y0) / 2 + 0.3)}) * step(${n(G.boss.r1)}, r) * step(r, ${n(radiusAt(G.wall.y0, -T) - 0.8)});
  d = unionRound(d, wallBox, ${n(G.fillet)});
  float bossBox = sdBox(vec2(r - ${n((G.boss.r0 + G.boss.r1) / 2)}, p.y - ${n((G.boss.y0 + G.wall.y1) / 2)}), vec2(${n((G.boss.r1 - G.boss.r0) / 2)}, ${n((G.wall.y1 - G.boss.y0) / 2)}));
  d = unionRound(d, bossBox, 1.5);
  float topBox = max(sdBox(vec2(r - ${n((G.top.r0 + G.top.r1) / 2)}, p.y - ${n((G.top.y0 + H) / 2)}), vec2(${n((G.top.r1 - G.top.r0) / 2)}, ${n((H - G.top.y0) / 2)})), b + ${n(T - 0.3)});
  d = unionRound(d, topBox, 1.5);
  float pr = length(vec2(p.y - ${n(G.port.y)}, p.z));
  float tube = max(max(max(pr - ${n(G.port.ro)}, ${n(G.port.ri)} - pr), max(${n(G.port.x0)} - p.x, p.x - ${n(G.port.x1)})), -(b + ${n(T)}));
  d = unionRound(d, tube, 3.0);
  float bore = max(max(pr - ${n(G.port.ri)}, p.x), ${n(G.port.x0 - 1)} - p.x);
  d = max(d, -bore);
  return d;
}
`;
