/**
 * The housing rendered in WebGL: the same distance field as the drawings
 * (see sander.ts), ray marched and shaded with a photographed material
 * sphere (a matcap). A quarter is cut away through the axis, the cut faces
 * are hatched like a section, and the change being traced is drawn in
 * redline. Ink creases and silhouettes give it the look of a technical
 * illustration.
 */
import { G, T, glsl, radiusAt } from './sander';

export interface Camera {
  /** Degrees, from +z towards +x. */
  azimuth: number;
  /** Degrees above the horizon. */
  elevation: number;
  /** Point looked at, in mm. */
  target: [number, number, number];
  /** Half the view's height, in mm. */
  half: number;
}

/** The hero's view: framed on the whole part, so the intro starts with it in frame. */
export const heroCamera: Camera = { azimuth: 38, elevation: 24, target: [-6, 49, 0], half: 79 };

/** The CAD window's view: the whole part from the front left, port showing. */
export const cadCamera: Camera = { azimuth: -34, elevation: 22, target: [-10, 56, 0], half: 82 };

export const cameras = { hero: heroCamera, cad: cadCamera };

/** Change keys and the ids the shader highlights for them. */
export const activeIds = { none: 0, wall: 1, material: 2, bearing: 3 } as const;

/** Points on the cut faces where the hero's trace line starts, per change. */
export const anchors: Record<'wall' | 'material' | 'bearing', [number, number, number]> = {
  wall: [30, (G.wall.y0 + G.wall.y1) / 2, 0],
  material: [radiusAt(72) - T / 2, 72, 0],
  bearing: [(G.boss.r0 + G.boss.r1) / 2, (G.boss.y0 + G.wall.y1) / 2 - 2, 0],
};

export function basis(cam: Camera) {
  const az = (cam.azimuth * Math.PI) / 180;
  const el = (cam.elevation * Math.PI) / 180;
  const eye = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  const fw = eye.map((v) => -v);
  // right = normalize(cross(fw, up)); up' = cross(right, fw)
  const rt = [fw[1] * 0 - fw[2] * 1, fw[2] * 0 - fw[0] * 0, fw[0] * 1 - fw[1] * 0];
  const rl = Math.hypot(rt[0], rt[1], rt[2]);
  const r = rt.map((v) => v / rl);
  const u = [r[1] * fw[2] - r[2] * fw[1], r[2] * fw[0] - r[0] * fw[2], r[0] * fw[1] - r[1] * fw[0]];
  return { eye, fw, rt: r, up: u };
}

/** Where a model point lands on a canvas of the given size, in CSS pixels. */
export function project(cam: Camera, p: [number, number, number], width: number, height: number) {
  const { rt, up } = basis(cam);
  const d = [p[0] - cam.target[0], p[1] - cam.target[1], p[2] - cam.target[2]];
  const sx = (d[0] * rt[0] + d[1] * rt[1] + d[2] * rt[2]) / cam.half;
  const sy = (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / cam.half;
  // uv.y spans -1..1 over the height; uv.x is scaled by the same factor.
  return { x: width / 2 + (sx * height) / 2, y: height / 2 - (sy * height) / 2 };
}

const n = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const wallRin = radiusAt(G.wall.y0, -T);

export const vertexSource = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const fragmentSource = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes;
uniform vec3 uEye;
uniform vec3 uTarget;
uniform float uHalf;
uniform float uCut;
uniform int uActive;
uniform sampler2D uMatcap;
uniform vec3 uCrease;
uniform vec3 uOutline;
uniform vec3 uShadowColor;
uniform vec3 uCap;
uniform vec3 uHatch;
uniform vec3 uChange;
uniform float uShadow;
uniform float uMatcapGain;
uniform vec3 uShade0;
uniform vec3 uShade1;
uniform vec3 uShade2;
uniform vec3 uShade3;
${glsl}
float cutTerm(vec3 p) { return min(p.x - uCut, p.z - uCut); }
float scene(vec3 p) { float id; return max(solid(p, id), cutTerm(p)); }
vec3 normalAt(vec3 p, float e) {
  vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * scene(p + k.xyy * e) + k.yyx * scene(p + k.yyx * e) +
                   k.yxy * scene(p + k.yxy * e) + k.xxx * scene(p + k.xxx * e));
}
float occlusion(vec3 p, vec3 n) {
  float o = 0.0, s = 1.0;
  for (int i = 1; i <= 5; i++) {
    float h = 1.2 * float(i);
    o += (h - scene(p + n * h)) * s;
    s *= 0.62;
  }
  return clamp(1.0 - 0.09 * o, 0.0, 1.0);
}
// 1 motor mount wall, 3 bearing boss, 0 elsewhere.
float part(vec3 p) {
  float r = length(p.xz);
  if (abs(p.y - ${n((G.wall.y0 + G.wall.y1) / 2)}) < ${n((G.wall.y1 - G.wall.y0) / 2 + 0.25)} && r > ${n(G.boss.r1 + 0.5)} && r < ${n(wallRin - 0.9)}) return 1.0;
  if (r > ${n(G.boss.r0 - 0.4)} && r < ${n(G.boss.r1 + 0.4)} && p.y > ${n(G.boss.y0 - 0.4)} && p.y < ${n(G.wall.y0)}) return 3.0;
  return 0.0;
}
void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
  vec3 fw = -uEye;
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  vec3 ro = uTarget + (rt * uv.x + up * uv.y) * uHalf - fw * 300.0;
  float px = 2.0 * uHalf / uRes.y;
  float t = 0.0, d = 1.0, minD = 1e9;
  bool hit = false;
  for (int i = 0; i < 240; i++) {
    vec3 p = ro + fw * t;
    d = scene(p);
    if (t > 120.0) minD = min(minD, d);
    if (d < 0.004) { hit = true; break; }
    t += d * 0.72;
    if (t > 620.0) break;
  }
  if (!hit) {
    // Silhouette line over a soft contact shadow on the ground plane.
    float a = 1.0 - smoothstep(px * 0.35, px * 1.35, minD);
    float s = 0.0;
    if (fw.y < 0.0) {
      float tg = -ro.y / fw.y;
      vec3 g = ro + fw * tg;
      s = uShadow * (1.0 - smoothstep(46.0, 84.0, length(g.xz + vec2(6.0, 0.0))));
    }
    float alpha = a + s * (1.0 - a);
    vec3 col = (uOutline * a + uShadowColor * s * (1.0 - a)) / max(alpha, 1e-4);
    outColor = vec4(col * alpha, alpha);
    return;
  }
  vec3 p = ro + fw * t;
  float idOut;
  float ds = solid(p, idOut);
  float ct = cutTerm(p);
  bool cap = ct > ds - 0.03;
  vec3 n = normalAt(p, 0.02);
  vec3 nWide = normalAt(p, max(0.8, px * 1.6));
  float crease = smoothstep(0.04, 0.16, 1.0 - dot(n, nWide));
  float which = part(p);
  bool live = (uActive == 1 && which == 1.0) || (uActive == 3 && which == 3.0);
  vec3 col;
  if (cap) {
    // Cut faces: paper, as thin sections are drawn at this scale; the
    // change being traced is filled with redline.
    col = uCap;
    if (live || uActive == 2) col = uChange;
  } else {
    // The photographed material's light, graded onto the palette: its
    // luminance picks a colour from a four-stop ramp.
    vec3 vn = vec3(dot(n, rt), dot(n, up), dot(n, -fw));
    vec2 m = vn.xy * 0.485 + 0.5;
    vec3 mc = textureLod(uMatcap, vec2(m.x, 1.0 - m.y), 2.0).rgb;
    float l = clamp(dot(mc, vec3(0.299, 0.587, 0.114)) * uMatcapGain, 0.0, 1.0);
    col = l < 0.33 ? mix(uShade0, uShade1, l / 0.33)
        : l < 0.66 ? mix(uShade1, uShade2, (l - 0.33) / 0.33)
        : mix(uShade2, uShade3, (l - 0.66) / 0.34);
    col *= mix(0.62, 1.0, occlusion(p, n));
    if (live) col = mix(col, uChange, 0.8);
  }
  col = mix(col, uCrease, crease * 0.92);
  outColor = vec4(col, 1.0);
}
`;
