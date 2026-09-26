/**
 * Path for a drafting revision cloud: a chain of outward arcs around a
 * rectangle, the mark engineers draw around a changed area on a drawing.
 * Each side gets a whole number of arcs, so arcs meet at the corners.
 *
 * @param width   Box width in user units.
 * @param height  Box height in user units.
 * @param scallop Target chord length of each arc.
 */
export function cloudPath(width: number, height: number, scallop: number): string {
  // Arcs bulge out by about a third of their chord; keep them inside the box.
  const inset = scallop * 0.34 + 1.5;
  const w = Math.max(width - inset * 2, 1);
  const h = Math.max(height - inset * 2, 1);
  const across = Math.max(2, Math.round(w / scallop));
  const down = Math.max(1, Math.round(h / scallop));
  const dx = w / across;
  const dy = h / down;

  // Clockwise from the top-left corner.
  const points: [number, number][] = [];
  for (let i = 0; i < across; i++) points.push([i * dx, 0]);
  for (let i = 0; i < down; i++) points.push([w, i * dy]);
  for (let i = 0; i < across; i++) points.push([w - i * dx, h]);
  for (let i = 0; i < down; i++) points.push([0, h - i * dy]);

  const fmt = ([x, y]: [number, number]) => `${(x + inset).toFixed(2)} ${(y + inset).toFixed(2)}`;
  let d = `M${fmt(points[0])}`;
  points.forEach((_, i) => {
    const next = points[(i + 1) % points.length];
    const onHorizontalSide = i < across || (i >= across + down && i < 2 * across + down);
    const r = ((onHorizontalSide ? dx : dy) * 0.56).toFixed(2);
    // sweep-flag 1 on a clockwise walk bows each arc outward.
    d += `A${r} ${r} 0 0 1 ${fmt(next)}`;
  });
  // No closepath: the last arc already ends on the first point, and a Z would
  // add a join artifact where the drawn stroke starts and ends.
  return d;
}
