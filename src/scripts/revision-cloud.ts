/**
 * Paths for drafting revision clouds: a chain of outward arcs around a
 * rectangle, the mark engineers draw around a changed area on a drawing.
 * Every arc has the same radius, and each side gets a whole number of arcs,
 * so they meet in a cusp at every corner.
 */

/** Radius of every arc, as a share of the target chord length. */
const RADIUS = 0.58;

/**
 * Cloud whose arcs start and end on the rectangle and bulge outward from it.
 *
 * @param x      Left edge of the rectangle, in user units.
 * @param y      Top edge.
 * @param width  Rectangle width.
 * @param height Rectangle height.
 * @param chord  Target distance between arc ends; each side rounds it so its
 *               arcs fit exactly.
 */
export function cloudAround(
  x: number,
  y: number,
  width: number,
  height: number,
  chord: number,
): string {
  const r = chord * RADIUS;
  const along = (length: number) => {
    const count = Math.max(1, Math.round(length / chord));
    // The radius can't be shorter than half a chord.
    return { count, step: length / count, r: Math.max(r, length / count / 2 + 0.01) };
  };
  const top = along(width);
  const side = along(height);
  const f = (n: number) => n.toFixed(2);

  // Clockwise from the top-left corner; sweep-flag 1 bows each arc outward.
  let d = `M${f(x)} ${f(y)}`;
  const run = (
    { count, step, r: radius }: ReturnType<typeof along>,
    x0: number,
    y0: number,
    dx: number,
    dy: number,
  ) => {
    for (let i = 1; i <= count; i++) {
      d += `A${f(radius)} ${f(radius)} 0 0 1 ${f(x0 + dx * step * i)} ${f(y0 + dy * step * i)}`;
    }
  };
  run(top, x, y, 1, 0);
  run(side, x + width, y, 0, 1);
  run(top, x + width, y + height, -1, 0);
  run(side, x, y + height, 0, -1);
  return d;
}
