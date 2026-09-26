/**
 * Path for a drafting revision cloud: a chain of outward arcs around a
 * rectangle, the mark engineers draw around a changed area on a drawing.
 * Arcs vary in size, as they do when drawn by hand, from a seeded generator
 * so the same box always gets the same cloud. Each side gets a whole number
 * of arcs, so arcs meet at the corners.
 *
 * @param width   Box width in user units.
 * @param height  Box height in user units.
 * @param scallop Typical chord length of an arc.
 * @param seed    Changes the pattern of arc sizes.
 */
export function cloudPath(width: number, height: number, scallop: number, seed = 11): string {
  let state = seed >>> 0;
  const random = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // The largest arcs bulge out by about 0.4 of their chord; keep them inside the box.
  const inset = scallop * 0.5 + 1.5;
  const w = Math.max(width - inset * 2, 1);
  const h = Math.max(height - inset * 2, 1);

  // Split a side into arcs of uneven length that add up exactly.
  const split = (length: number) => {
    const count = Math.max(1, Math.round(length / scallop));
    const weights = Array.from({ length: count }, () => 0.65 + random() * 0.7);
    const total = weights.reduce((a, b) => a + b, 0);
    let at = 0;
    return weights.map((weight) => {
      const start = at;
      at += (weight / total) * length;
      return start;
    });
  };

  // Clockwise from the top-left corner.
  const points: [number, number][] = [
    ...split(w).map((d): [number, number] => [d, 0]),
    ...split(h).map((d): [number, number] => [w, d]),
    ...split(w).map((d): [number, number] => [w - d, h]),
    ...split(h).map((d): [number, number] => [0, h - d]),
  ];

  const fmt = ([x, y]: [number, number]) => `${(x + inset).toFixed(2)} ${(y + inset).toFixed(2)}`;
  let d = `M${fmt(points[0])}`;
  points.forEach((point, i) => {
    const next = points[(i + 1) % points.length];
    const chord = Math.hypot(next[0] - point[0], next[1] - point[1]);
    const r = (chord * (0.52 + random() * 0.14)).toFixed(2);
    // sweep-flag 1 on a clockwise walk bows each arc outward.
    d += `A${r} ${r} 0 0 1 ${fmt(next)}`;
  });
  // No closepath: the last arc already ends on the first point.
  return d;
}
