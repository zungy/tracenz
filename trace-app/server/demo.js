import { deflateSync } from "node:zlib";
import { crc32, validateEnvelope } from "./domain.js";

// A synthetic CAD-style illustration, never represented as a real Fusion capture.
export function demoPng() {
  const width = 840,
    height = 470,
    pixels = Buffer.alloc(width * height * 4);
  function pixel(x, y, color) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = (y * width + x) * 4;
    pixels[at] = color[0];
    pixels[at + 1] = color[1];
    pixels[at + 2] = color[2];
    pixels[at + 3] = 255;
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixel(x, y, [
        240 - Math.floor(y / 100),
        244 - Math.floor(y / 100),
        249 - Math.floor(y / 100),
      ]);
  function line(x1, y1, x2, y2, color, thick = 1) {
    const count = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    for (let i = 0; i <= count; i++) {
      const x = Math.round(x1 + ((x2 - x1) * i) / count),
        y = Math.round(y1 + ((y2 - y1) * i) / count);
      for (let a = 0; a < thick; a++)
        for (let b = 0; b < thick; b++) pixel(x + a, y + b, color);
    }
  }
  function polygon(points, color, edge = [133, 154, 178]) {
    const min = Math.max(0, Math.floor(Math.min(...points.map((p) => p[1])))),
      max = Math.min(
        height - 1,
        Math.ceil(Math.max(...points.map((p) => p[1]))),
      );
    for (let y = min; y <= max; y++) {
      const cuts = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i],
          b = points[j];
        if (a[1] > y !== b[1] > y)
          cuts.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
      cuts.sort((a, b) => a - b);
      for (let i = 0; i + 1 < cuts.length; i += 2)
        for (let x = Math.ceil(cuts[i]); x <= cuts[i + 1]; x++)
          pixel(x, y, color);
    }
    if (edge)
      points.forEach((p, i) =>
        line(...p, ...points[(i + 1) % points.length], edge),
      );
  }
  function ellipse(cx, cy, rx, ry, color) {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++)
        if ((x - cx) ** 2 / rx ** 2 + (y - cy) ** 2 / ry ** 2 <= 1)
          pixel(x, y, color);
  }
  for (let x = -500; x < 1100; x += 55) {
    line(x, 470, x + 700, 170, [222, 229, 239]);
    line(x, 200, x + 600, 470, [222, 229, 239]);
  }
  ellipse(430, 347, 219, 37, [217, 224, 235]);
  polygon(
    [
      [223, 287],
      [435, 390],
      [651, 285],
      [438, 188],
    ],
    [181, 195, 213],
  );
  polygon(
    [
      [223, 266],
      [435, 366],
      [435, 390],
      [223, 287],
    ],
    [143, 164, 190],
  );
  polygon(
    [
      [435, 366],
      [651, 261],
      [651, 285],
      [435, 390],
    ],
    [161, 180, 202],
  );
  polygon(
    [
      [223, 266],
      [438, 166],
      [651, 261],
      [435, 366],
    ],
    [204, 217, 232],
    [134, 156, 183],
  );
  polygon(
    [
      [249, 253],
      [249, 108],
      [439, 191],
      [439, 337],
    ],
    [170, 190, 215],
  );
  polygon(
    [
      [249, 108],
      [273, 97],
      [464, 179],
      [439, 191],
    ],
    [219, 230, 242],
  );
  polygon(
    [
      [439, 191],
      [464, 179],
      [464, 324],
      [439, 337],
    ],
    [124, 151, 185],
  );
  polygon(
    [
      [278, 239],
      [278, 143],
      [408, 200],
      [408, 297],
    ],
    [184, 203, 224],
    [160, 180, 205],
  );
  ellipse(340, 210, 27, 36, [129, 150, 181]);
  ellipse(342, 213, 21, 29, [107, 129, 161]);
  ellipse(348, 215, 16, 26, [223, 232, 243]);
  for (const [x, y] of [
    [376, 310],
    [529, 283],
  ]) {
    ellipse(x, y, 19, 10, [141, 163, 191]);
    ellipse(x, y + 2, 14, 7, [109, 133, 164]);
    ellipse(x, y + 4, 9, 4, [193, 211, 229]);
  }
  line(170, 340, 214, 360, [168, 112, 114], 2);
  line(170, 340, 130, 362, [100, 155, 137], 2);
  line(170, 340, 170, 302, [104, 137, 185], 2);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    pixels.copy(
      raw,
      y * (width * 4 + 1) + 1,
      y * width * 4,
      (y + 1) * width * 4,
    );
  function chunk(type, bytes) {
    const tag = Buffer.from(type),
      head = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    head.writeUInt32BE(bytes.length);
    crc.writeUInt32BE(crc32(Buffer.concat([tag, bytes])));
    return Buffer.concat([head, tag, bytes, crc]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export function demoEnvelopes() {
  const image = demoPng().toString("base64");
  const definitions = [
    {
      id: "trace-sample-base-v1",
      name: "Base extrusion",
      action: "feature_added",
      kind: "extrude",
      props: [
        { name: "Distance", value: "8.00 mm", unit: "mm", change: "added" },
      ],
      why: "Starting with an 8 mm base to support the upright. I’ll revisit the thickness after checking the available space.",
      hours: 28,
    },
    {
      id: "trace-sample-upright-v1",
      name: "Upright support",
      action: "feature_added",
      kind: "extrude",
      props: [
        { name: "Height", value: "45.00 mm", unit: "mm", change: "added" },
        { name: "Operation", value: "Join", change: "added" },
      ],
      why: "Added the upright to locate the shaft above the mounting face. Keeping it joined to the base for this iteration.",
      hours: 25,
    },
    {
      id: "trace-sample-depth-v1",
      name: "Base extrusion",
      action: "parameter_changed",
      kind: "extrude",
      props: [
        {
          name: "Distance",
          oldValue: "8.00 mm",
          newValue: "6.00 mm",
          unit: "mm",
          change: "modified",
        },
      ],
      why: "The first version was too tall for the assembly envelope. Reduced the base by 2 mm to make room for the adjoining part.",
      hours: 3,
    },
    {
      id: "trace-sample-hole-v1",
      name: "Hole2",
      action: "feature_added",
      kind: "hole",
      props: [
        {
          name: "HoleDepth",
          parameter: "d16",
          value: "2.00 mm",
          unit: "mm",
          change: "added",
        },
        {
          name: "HoleDiameter",
          parameter: "d17",
          value: "4.00 mm",
          unit: "mm",
          change: "added",
        },
        {
          name: "TipAngle",
          parameter: "d18",
          value: "118.0 deg",
          unit: "deg",
          change: "added",
        },
      ],
      why: "Adding the locating hole for the mounting interface. The recorded dimensions are a first pass and still need checking against the mating part.",
      hours: 1,
    },
  ];
  // Fixed date makes repeated demo loads idempotent across application restarts.
  const anchor = Date.parse("2026-09-26T02:00:00Z");
  return definitions.map((d) => ({
    event: {
      id: d.id,
      schemaVersion: 2,
      eventType: "design_checkpoint",
      demo: true,
      timestamp: new Date(anchor - d.hours * 3600000).toISOString(),
      source: "Autodesk Fusion",
      document: {
        name: "Mounting bracket · sample",
        key: "trace:demo:mounting-bracket",
        defaultLengthUnits: "mm",
        versionId: "sample",
      },
      changeCount: 1,
      rawChangeCount: 1 + d.props.length,
      engineeringChanges: [
        {
          action: d.action,
          component: "Mounting bracket",
          feature: {
            name: d.name,
            type: d.kind === "hole" ? "HoleFeature" : "ExtrudeFeature",
            kind: d.kind,
          },
          properties: d.props,
        },
      ],
      changes: { sample: true },
      rationale: d.why,
    },
    viewport: {
      filename: "illustrative-viewport.png",
      contentType: "image/png",
      base64: image,
    },
  }));
}
export async function seedDemo(store, owner) {
  let count = 0;
  for (const envelope of demoEnvelopes()) {
    try {
      const result = await store.ingest(owner, validateEnvelope(envelope));
      if (!result.duplicate) count++;
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
  return count;
}
