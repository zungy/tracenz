/**
 * Drafting helpers for the SVG drawings, after ISO 128 (lines) and ISO 129
 * (dimensions): filled arrowheads, dimension lines with extension lines, and
 * leaders.
 *
 * A view is laid out in model millimetres with y up; `P` turns a point into
 * SVG coordinates, where y points down. Sizes that belong to the paper, such
 * as lettering, arrowheads and the gaps around extension lines, are given in
 * paper millimetres and divided by the view's scale, so every view prints
 * them the same size.
 */

export type Pt = { x: number; y: number };

export const f = (n: number) => (Math.round(n * 100) / 100).toString();
export const P = (x: number, y: number) => `${f(x)} ${f(-y)}`;

/** Paper sizes, in millimetres on the printed sheet. */
export const PAPER = {
  text: 3.5, // lettering height
  arrow: 3, // arrowhead length
  arrowWidth: 1, // arrowhead width
  gap: 1, // gap between a part and its extension line
  over: 2, // extension line beyond the dimension line
  textGap: 1, // lettering above its dimension line
};

export class View {
  /** @param scale drawing scale, e.g. 0.4 for 1:2.5 */
  constructor(readonly scale: number) {}

  /** A paper size in model millimetres. */
  p(mm: number) {
    return mm / this.scale;
  }

  get text() {
    return this.p(PAPER.text);
  }

  /** Filled arrowhead with its tip on `tip`, pointing away from `from`. */
  arrow(tip: Pt, from: Pt) {
    const len = this.p(PAPER.arrow);
    const w = this.p(PAPER.arrowWidth) / 2;
    const dx = tip.x - from.x;
    const dy = tip.y - from.y;
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    const bx = tip.x - ux * len;
    const by = tip.y - uy * len;
    return `M${P(tip.x, tip.y)}L${P(bx - uy * w, by + ux * w)}L${P(bx + uy * w, by - ux * w)}Z`;
  }

  /**
   * Linear dimension between a and b, measured along x ('h') or y ('v') and
   * drawn at `at` (the dimension line's y for 'h', its x for 'v'). Arrows go
   * inside when there is room for them and the value, outside otherwise.
   */
  dim(a: Pt, b: Pt, dir: 'h' | 'v', at: number, value: string) {
    const gap = this.p(PAPER.gap);
    const over = this.p(PAPER.over);
    const arrowLen = this.p(PAPER.arrow);
    let lines = '';
    let arrows = '';
    if (dir === 'h') {
      const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      const pa = a.x < b.x ? a : b;
      const pb = a.x < b.x ? b : a;
      for (const p of [pa, pb]) {
        const s = Math.sign(at - p.y) || 1;
        lines += `M${P(p.x, p.y + s * gap)}L${P(p.x, at + s * over)}`;
      }
      const inside = x2 - x1 > arrowLen * 2.6;
      if (inside) {
        lines += `M${P(x1, at)}L${P(x2, at)}`;
        arrows += this.arrow({ x: x1, y: at }, { x: x2, y: at });
        arrows += this.arrow({ x: x2, y: at }, { x: x1, y: at });
      } else {
        lines += `M${P(x1 - arrowLen * 2, at)}L${P(x2 + arrowLen * 2, at)}`;
        arrows += this.arrow({ x: x1, y: at }, { x: x1 - 1, y: at });
        arrows += this.arrow({ x: x2, y: at }, { x: x2 + 1, y: at });
      }
      return {
        lines,
        arrows,
        text: { x: (x1 + x2) / 2, y: at + this.p(PAPER.textGap), rotate: 0, value },
      };
    }
    const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    const pa = a.y < b.y ? a : b;
    const pb = a.y < b.y ? b : a;
    for (const p of [pa, pb]) {
      const s = Math.sign(at - p.x) || 1;
      lines += `M${P(p.x + s * gap, p.y)}L${P(at + s * over, p.y)}`;
    }
    const inside = y2 - y1 > arrowLen * 2.6;
    if (inside) {
      lines += `M${P(at, y1)}L${P(at, y2)}`;
      arrows += this.arrow({ x: at, y: y1 }, { x: at, y: y2 });
      arrows += this.arrow({ x: at, y: y2 }, { x: at, y: y1 });
    } else {
      lines += `M${P(at, y1 - arrowLen * 2)}L${P(at, y2 + arrowLen * 2)}`;
      arrows += this.arrow({ x: at, y: y1 }, { x: at, y: y1 - 1 });
      arrows += this.arrow({ x: at, y: y2 }, { x: at, y: y2 + 1 });
    }
    return {
      lines,
      arrows,
      text: { x: at - this.p(PAPER.textGap), y: (y1 + y2) / 2, rotate: -90, value },
    };
  }

  /**
   * Leader from a feature to a note: an arrowhead on the feature (or a dot
   * inside an area), a straight run to the elbow and a short horizontal
   * shoulder under the note.
   */
  leader(target: Pt, elbow: Pt, side: 1 | -1, end: 'arrow' | 'dot' = 'arrow') {
    const shoulder = this.p(4) * side;
    const lines = `M${P(target.x, target.y)}L${P(elbow.x, elbow.y)}L${P(elbow.x + shoulder, elbow.y)}`;
    const mark =
      end === 'arrow'
        ? this.arrow(target, elbow)
        : `M${P(target.x + this.p(0.5), target.y)}a${f(this.p(0.5))} ${f(this.p(0.5))} 0 1 0 ${f(-this.p(1))} 0a${f(this.p(0.5))} ${f(this.p(0.5))} 0 1 0 ${f(this.p(1))} 0`;
    return {
      lines,
      mark,
      text: {
        x: elbow.x + (side === 1 ? this.p(1) : -this.p(1)),
        y: elbow.y + this.p(PAPER.textGap),
        anchor: side === 1 ? 'start' : 'end',
      },
    };
  }
}
