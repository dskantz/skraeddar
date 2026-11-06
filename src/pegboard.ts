import * as THREE from 'three';

export const HOLE_WIDTH = 5;
export const HOLE_HEIGHT = 15;
export const HOLE_SPACING_X = 40;
export const HOLE_SPACING_Y = 20;
export const EDGE_MARGIN = 20;
export const BOARD_RADIUS = 8;
export const SCREW_HOLE_DIAMETER = 5;
export const SCREW_HOLE_INSET = 10;

// Holes form a checkerboard with a 20mm pitch in both directions. Seams are routed
// through the hole-free gaps of that checkerboard.
const GRID = 20;
// Horizontal seams: square wave with slanted flanks (dovetail), amplitude = GRID.
const FLANK_SLANT = 3;
// Vertical seams: straight channel with alternating dovetail tabs.
const TAB_DEPTH = 11;
const TAB_NECK_HALF = 4.5;
const TAB_TIP_HALF = 7.5;
const TAB_END_MARGIN = 10;
const CORNER_SEGMENTS = 12;

export const MIN_PART_SIZE = 100;
// Limits keep >= 1mm of wall at the surface between neighbouring holes, holes and seams,
// and the mounting holes and the board edge.
export const MAX_EDGE_FILLET = 4;
export const MAX_HOLE_FILLET = 2.5;
export const MAX_CORNER_CHAMFER = 4;

export interface Pt {
  x: number;
  y: number;
}

export interface HoleSpec {
  kind: 'slot' | 'screw';
  x: number;
  y: number;
}

export interface BoardPart {
  row: number;
  col: number;
  outline: Pt[];
  /** seamEdges[i] is true when the edge from outline[i] to outline[i + 1] mates with another part. */
  seamEdges: boolean[];
  holes: HoleSpec[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface BoardLayout {
  parts: BoardPart[];
  rows: number;
  cols: number;
  error?: string;
}

export interface BoardOptions {
  width: number;
  height: number;
  withMountingHoles: boolean;
  split: boolean;
  maxPartWidth: number;
  maxPartHeight: number;
  /** Total gap between mating parts in mm (each side is offset by half). */
  clearance: number;
}

interface Cut {
  index: number;
  pos: number;
  lo: number;
  hi: number;
}

const samePt = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

const pointInPolygon = (p: Pt, poly: Pt[]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
};

/**
 * Picks cut positions so that every part (including protruding joints) fits within `max`.
 * Prefers evenly sized parts, falls back to a greedy fill.
 */
const planCuts = (total: number, max: number, candidates: Cut[]): Cut[] | null => {
  const fits = (cuts: Cut[]) => {
    let lo = 0;
    for (let i = 0; i <= cuts.length; i++) {
      const hi = i < cuts.length ? cuts[i].hi : total;
      if (hi - lo > max) return false;
      if (i < cuts.length) {
        if (i > 0 && cuts[i].pos <= cuts[i - 1].pos) return false;
        lo = cuts[i].lo;
      }
    }
    return true;
  };

  if (total <= max) return [];

  const greedy: Cut[] = [];
  let lo = 0;
  while (total - lo > max) {
    const prevPos = greedy.length ? greedy[greedy.length - 1].pos : -Infinity;
    const options = candidates.filter((c) => c.pos > prevPos && c.lo > lo && c.hi - lo <= max);
    if (!options.length) return null;
    const next = options.reduce((best, c) => (c.hi > best.hi ? c : best));
    greedy.push(next);
    lo = next.lo;
  }

  const n = greedy.length + 1;
  const balanced: Cut[] = [];
  for (let k = 1; k < n; k++) {
    const target = (total * k) / n;
    balanced.push(
      candidates.reduce((best, c) => (Math.abs(c.pos - target) < Math.abs(best.pos - target) ? c : best))
    );
  }
  return fits(balanced) ? balanced : greedy;
};

/** Moves every edge along its left normal by its own distance (into the material for CCW outlines and CW holes). */
const offsetPolygon = (pts: Pt[], dist: number[]): Pt[] => {
  const n = pts.length;
  const normal = (i: number) => {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  };
  return pts.map((v, i) => {
    const iPrev = (i - 1 + n) % n;
    const n1 = normal(iPrev);
    const n2 = normal(i);
    const d1 = dist[iPrev];
    const d2 = dist[i];
    if (d1 === 0 && d2 === 0) return v;
    const det = n1.x * n2.y - n1.y * n2.x;
    if (Math.abs(det) < 1e-9) {
      const d = (d1 + d2) / 2;
      return { x: v.x + n1.x * d, y: v.y + n1.y * d };
    }
    const c1 = n1.x * v.x + n1.y * v.y + d1;
    const c2 = n2.x * v.x + n2.y * v.y + d2;
    return { x: (c1 * n2.y - n1.y * c2) / det, y: (n1.x * c2 - c1 * n2.x) / det };
  });
};

export const getHoles = (width: number, height: number, withMountingHoles: boolean): HoleSpec[] => {
  const holesX = Math.floor((width - 2 * EDGE_MARGIN) / HOLE_SPACING_X) + 1;
  const holesY = Math.floor((height - 2 * EDGE_MARGIN) / HOLE_SPACING_Y) + 1;
  const startX = (width - (holesX - 1) * HOLE_SPACING_X) / 2;
  const startY = (height - (holesY - 1) * HOLE_SPACING_Y) / 2;
  const holes: HoleSpec[] = [];
  for (let i = 0; i < holesX; i++) {
    for (let j = 0; j < holesY; j++) {
      const x = startX + i * HOLE_SPACING_X + (j % 2) * (HOLE_SPACING_X / 2);
      if (x < EDGE_MARGIN || x > width - EDGE_MARGIN) continue;
      holes.push({ kind: 'slot', x, y: startY + j * HOLE_SPACING_Y });
    }
  }
  if (withMountingHoles) {
    for (const [x, y] of [
      [SCREW_HOLE_INSET, SCREW_HOLE_INSET],
      [width - SCREW_HOLE_INSET, SCREW_HOLE_INSET],
      [SCREW_HOLE_INSET, height - SCREW_HOLE_INSET],
      [width - SCREW_HOLE_INSET, height - SCREW_HOLE_INSET],
    ]) {
      holes.push({ kind: 'screw', x, y });
    }
  }
  return holes;
};

export const buildBoardLayout = (opts: BoardOptions): BoardLayout => {
  const { width: W, height: H } = opts;
  const holesX = Math.floor((W - 2 * EDGE_MARGIN) / HOLE_SPACING_X) + 1;
  const holesY = Math.floor((H - 2 * EDGE_MARGIN) / HOLE_SPACING_Y) + 1;
  const startX = (W - (holesX - 1) * HOLE_SPACING_X) / 2;
  const startY = (H - (holesY - 1) * HOLE_SPACING_Y) / 2;

  // Hole columns are indexed 1..lastCol (20mm apart), rows 0..holesY-1.
  // Columns 0 and lastCol+1 are virtual columns along the board edges.
  const lastCol = 2 * holesX - 1;
  const colX = (a: number) => startX + GRID * (a - 1);
  const rowY = (j: number) => startY + GRID * j;
  const hasHole = (a: number, j: number) => (((a - 1 + j) % 2) + 2) % 2 === 0;

  const horizontalSeam = (t: number) => {
    const yL = rowY(t);
    const yU = yL + GRID;
    const level = (a: number) => (hasHole(a, t) ? yU : yL);
    const pts: Pt[] = [{ x: 0, y: level(0) }];
    // Vertical seams end on the flat parts next to a flank: from below at (X, yL), from above at (X, yU).
    const junctionLow = new Map<number, number>();
    const junctionHigh = new Map<number, number>();
    for (let a = 0; a <= lastCol; a++) {
      const X = colX(a) + GRID / 2;
      const leftUp = level(a) === yU;
      const dir = leftUp ? 1 : -1;
      const top = { x: X + dir * FLANK_SLANT, y: yU };
      const bottom = { x: X - dir * FLANK_SLANT, y: yL };
      const low = { x: X, y: yL };
      const high = { x: X, y: yU };
      if (leftUp) {
        pts.push(high);
        junctionHigh.set(a, pts.length - 1);
        pts.push(top, bottom, low);
        junctionLow.set(a, pts.length - 1);
      } else {
        pts.push(low);
        junctionLow.set(a, pts.length - 1);
        pts.push(bottom, top, high);
        junctionHigh.set(a, pts.length - 1);
      }
    }
    pts.push({ x: W, y: level(lastCol + 1) });
    return { pts, junctionLow, junctionHigh, yL, yU };
  };

  const verticalSeam = (a: number, y0: number, y1: number): Pt[] => {
    const X = colX(a) + GRID / 2;
    const pts: Pt[] = [{ x: X, y: y0 }];
    for (let j = 0; j < holesY; j++) {
      const y = rowY(j);
      if (y - TAB_TIP_HALF - TAB_END_MARGIN < y0 || y + TAB_TIP_HALF + TAB_END_MARGIN > y1) continue;
      // Tabs alternate direction, always pointing into the column that has a gap at this row.
      const d = hasHole(a + 1, j) ? -1 : 1;
      pts.push(
        { x: X, y: y - TAB_NECK_HALF },
        { x: X + d * TAB_DEPTH, y: y - TAB_TIP_HALF },
        { x: X + d * TAB_DEPTH, y: y + TAB_TIP_HALF },
        { x: X, y: y + TAB_NECK_HALF }
      );
    }
    pts.push({ x: X, y: y1 });
    return pts;
  };

  let xCuts: Cut[] = [];
  let yCuts: Cut[] = [];
  if (opts.split) {
    if (opts.maxPartWidth < MIN_PART_SIZE || opts.maxPartHeight < MIN_PART_SIZE) {
      return { parts: [], rows: 0, cols: 0, error: `Max part size must be at least ${MIN_PART_SIZE}mm.` };
    }
    const xCandidates: Cut[] = [];
    for (let a = 1; a < lastCol; a++) {
      const X = colX(a) + GRID / 2;
      xCandidates.push({ index: a, pos: X, lo: X - TAB_DEPTH, hi: X + TAB_DEPTH });
    }
    const yCandidates: Cut[] = [];
    for (let t = 0; t < holesY - 1; t++) {
      const yL = rowY(t);
      yCandidates.push({ index: t, pos: yL + GRID / 2, lo: yL, hi: yL + GRID });
    }
    const xPlan = planCuts(W, opts.maxPartWidth, xCandidates);
    const yPlan = planCuts(H, opts.maxPartHeight, yCandidates);
    if (!xPlan || !yPlan) {
      return { parts: [], rows: 0, cols: 0, error: 'Could not split the board with this max part size.' };
    }
    xCuts = xPlan;
    yCuts = yPlan;
  }

  const cols = xCuts.length + 1;
  const rows = yCuts.length + 1;
  const hSeams = yCuts.map((c) => horizontalSeam(c.index));
  const allHoles = getHoles(W, H, opts.withMountingHoles);
  const corners: Pt[] = [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: W, y: H },
    { x: 0, y: H },
  ];

  const parts: BoardPart[] = [];
  for (let r = 0; r < rows; r++) {
    const yStart = r === 0 ? 0 : hSeams[r - 1].yU;
    const yEnd = r === rows - 1 ? H : hSeams[r].yL;
    for (let c = 0; c < cols; c++) {
      const edges: { pts: Pt[]; seam: boolean }[] = [];
      const sliceSeam = (seam: ReturnType<typeof horizontalSeam>, junction: Map<number, number>) => {
        const from = c === 0 ? 0 : junction.get(xCuts[c - 1].index)!;
        const to = c === cols - 1 ? seam.pts.length - 1 : junction.get(xCuts[c].index)!;
        return seam.pts.slice(from, to + 1);
      };

      const bottom =
        r === 0
          ? [
            { x: c === 0 ? 0 : xCuts[c - 1].pos, y: 0 },
            { x: c === cols - 1 ? W : xCuts[c].pos, y: 0 },
          ]
          : sliceSeam(hSeams[r - 1], hSeams[r - 1].junctionHigh);
      const top =
        r === rows - 1
          ? [
            { x: c === cols - 1 ? W : xCuts[c].pos, y: H },
            { x: c === 0 ? 0 : xCuts[c - 1].pos, y: H },
          ]
          : sliceSeam(hSeams[r], hSeams[r].junctionLow).reverse();
      edges.push({ pts: bottom, seam: r > 0 });
      edges.push({
        pts:
          c === cols - 1
            ? [bottom[bottom.length - 1], top[0]]
            : verticalSeam(xCuts[c].index, yStart, yEnd),
        seam: c < cols - 1,
      });
      edges.push({ pts: top, seam: r < rows - 1 });
      edges.push({
        pts: c === 0 ? [top[top.length - 1], bottom[0]] : verticalSeam(xCuts[c - 1].index, yStart, yEnd).reverse(),
        seam: c > 0,
      });

      let pts: Pt[] = [];
      let seamFlags: boolean[] = [];
      for (const edge of edges) {
        for (let i = 0; i < edge.pts.length - 1; i++) {
          const p = edge.pts[i];
          if (pts.length && samePt(pts[pts.length - 1], p)) {
            seamFlags[seamFlags.length - 1] = edge.seam;
            continue;
          }
          pts.push(p);
          seamFlags.push(edge.seam);
        }
      }

      // Round the outer board corners like the unsplit board.
      const rounded: Pt[] = [];
      const roundedFlags: boolean[] = [];
      pts.forEach((v, i) => {
        if (!corners.some((k) => samePt(k, v))) {
          rounded.push(v);
          roundedFlags.push(seamFlags[i]);
          return;
        }
        const prev = pts[(i - 1 + pts.length) % pts.length];
        const next = pts[(i + 1) % pts.length];
        const towards = (p: Pt) => {
          const len = Math.hypot(p.x - v.x, p.y - v.y);
          return { x: v.x + ((p.x - v.x) / len) * BOARD_RADIUS, y: v.y + ((p.y - v.y) / len) * BOARD_RADIUS };
        };
        const p0 = towards(prev);
        const p2 = towards(next);
        for (let s = 0; s <= CORNER_SEGMENTS; s++) {
          const t = s / CORNER_SEGMENTS;
          const u = 1 - t;
          rounded.push({
            x: u * u * p0.x + 2 * u * t * v.x + t * t * p2.x,
            y: u * u * p0.y + 2 * u * t * v.y + t * t * p2.y,
          });
          roundedFlags.push(s === CORNER_SEGMENTS ? seamFlags[i] : false);
        }
      });
      pts = rounded;
      seamFlags = roundedFlags;

      const holes = allHoles.filter((h) => pointInPolygon(h, pts));
      const outline = offsetPolygon(
        pts,
        seamFlags.map((s) => (s ? opts.clearance / 2 : 0))
      );
      const xs = outline.map((p) => p.x);
      const ys = outline.map((p) => p.y);
      parts.push({
        row: r,
        col: c,
        outline,
        seamEdges: seamFlags,
        holes,
        bbox: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
      });
    }
  }

  return { parts, rows, cols };
};

export interface FilletOptions {
  thickness: number;
  /** Radius of the rounding on the outer board edges (seam edges stay square). */
  edgeFillet: number;
  /** Radius of the rounding on pegboard slot edges. */
  holeFillet: number;
  /** Equal width and depth of the top chamfer on the four corner holes. */
  cornerHoleChamfer: number;
}

const FILLET_SEGMENTS = 6;

/** Layers through the thickness: at height z the contour is moved `inset` mm into the material. */
const filletProfile = (thickness: number, radius: number) => {
  const r = Math.max(0, Math.min(radius, thickness / 2));
  if (r < 1e-3) {
    return [
      { z: 0, inset: 0 },
      { z: thickness, inset: 0 },
    ];
  }
  const side = Array.from({ length: FILLET_SEGMENTS + 1 }, (_, k) => {
    const a = (k / FILLET_SEGMENTS) * (Math.PI / 2);
    return { s: r * (1 - Math.cos(a)), inset: r * (1 - Math.sin(a)) };
  });
  const profile = [
    ...side.map(({ s, inset }) => ({ z: s, inset })),
    ...[...side].reverse().map(({ s, inset }) => ({ z: thickness - s, inset })),
  ];
  return profile.filter((p, i) => i === 0 || p.z - profile[i - 1].z > 1e-6);
};

const chamferProfile = (thickness: number, size: number) => {
  const chamfer = Math.max(0, Math.min(size, thickness));
  if (chamfer < 1e-3) {
    return [
      { z: 0, inset: 0 },
      { z: thickness, inset: 0 },
    ];
  }
  if (chamfer >= thickness) {
    return [
      { z: 0, inset: 0 },
      { z: thickness, inset: chamfer },
    ];
  }
  return [
    { z: 0, inset: 0 },
    { z: thickness - chamfer, inset: 0 },
    { z: thickness, inset: chamfer },
  ];
};

/** Removes repeated points; flags[i] belongs to the edge starting at point i. */
const dedupe = (pts: Pt[], flags?: boolean[]) => {
  const outPts: Pt[] = [];
  const outFlags: boolean[] = [];
  pts.forEach((p, i) => {
    if (outPts.length && samePt(outPts[outPts.length - 1], p)) {
      outFlags[outFlags.length - 1] = flags ? flags[i] : false;
      return;
    }
    outPts.push(p);
    outFlags.push(flags ? flags[i] : false);
  });
  while (outPts.length > 1 && samePt(outPts[0], outPts[outPts.length - 1])) {
    outPts.pop();
    outFlags.pop();
  }
  return { pts: outPts, flags: outFlags };
};

/** Hole contour in clockwise order, so offsetting by a positive distance grows the hole. */
export const holeContour = (h: HoleSpec): Pt[] => {
  const path = new THREE.Path();
  if (h.kind === 'screw') {
    path.absarc(h.x, h.y, SCREW_HOLE_DIAMETER / 2, 0, Math.PI * 2, false);
  } else {
    const hw = HOLE_WIDTH / 2;
    const hh = HOLE_HEIGHT / 2;
    const { x, y } = h;
    path.moveTo(x - hw, y - hh + hw);
    path.lineTo(x - hw, y + hh - hw);
    path.quadraticCurveTo(x - hw, y + hh, x, y + hh);
    path.quadraticCurveTo(x + hw, y + hh, x + hw, y + hh - hw);
    path.lineTo(x + hw, y - hh + hw);
    path.quadraticCurveTo(x + hw, y - hh, x, y - hh);
    path.quadraticCurveTo(x - hw, y - hh, x - hw, y - hh + hw);
  }
  const { pts } = dedupe(path.getPoints(h.kind === 'screw' ? 8 : 4).map((v) => ({ x: v.x, y: v.y })));
  return THREE.ShapeUtils.isClockWise(pts.map((p) => new THREE.Vector2(p.x, p.y))) ? pts : pts.reverse();
};

/**
 * Drops vertices lying on a straight line between their neighbours. Earcut skips such vertices when
 * triangulating the caps, which would leave T-junctions against the side walls.
 */
const removeCollinear = (pts: Pt[], flags: boolean[]) => {
  let outPts = pts;
  let outFlags = flags;
  let changed = true;
  while (changed && outPts.length > 3) {
    changed = false;
    const n = outPts.length;
    for (let i = 0; i < n; i++) {
      const prev = outPts[(i - 1 + n) % n];
      const cur = outPts[i];
      const next = outPts[(i + 1) % n];
      const ax = cur.x - prev.x;
      const ay = cur.y - prev.y;
      const bx = next.x - cur.x;
      const by = next.y - cur.y;
      const sin = (ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
      if (Math.abs(sin) < 1e-9 && ax * bx + ay * by > 0 && outFlags[(i - 1 + n) % n] === outFlags[i]) {
        outPts = outPts.filter((_, k) => k !== i);
        outFlags = outFlags.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return { pts: outPts, flags: outFlags };
};

/** Builds a closed, non-indexed mesh of a part from z = 0 to z = thickness with filleted edges. */
export const buildPartGeometry = (part: BoardPart, opts: FilletOptions): THREE.BufferGeometry => {
  const deduped = dedupe(part.outline, part.seamEdges);
  const { pts: outline, flags } = removeCollinear(deduped.pts, deduped.flags);
  const edgeProfile = filletProfile(opts.thickness, opts.edgeFillet);
  const holeProfile = filletProfile(opts.thickness, opts.holeFillet);
  const cornerHoleProfile = chamferProfile(opts.thickness, opts.cornerHoleChamfer);

  type Layer = { z: number; ring: Pt[] };
  const outer: Layer[] = edgeProfile.map(({ z, inset }) => ({
    z,
    ring: offsetPolygon(outline, flags.map((seam) => (seam ? 0 : inset))),
  }));
  const holes: Layer[][] = part.holes.map((h) => {
    const contour = holeContour(h);
    const profile = h.kind === 'screw' ? cornerHoleProfile : holeProfile;
    return profile.map(({ z, inset }) => ({ z, ring: offsetPolygon(contour, contour.map(() => inset)) }));
  });

  const pos: number[] = [];
  const push = (p: Pt, z: number) => pos.push(p.x, p.y, z);

  // Outer ring is CCW and hole rings are CW, so this winding gives outward-facing walls for both.
  const addWalls = (layers: Layer[]) => {
    for (let k = 0; k < layers.length - 1; k++) {
      const lo = layers[k];
      const hi = layers[k + 1];
      const n = lo.ring.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        push(lo.ring[i], lo.z);
        push(lo.ring[j], lo.z);
        push(hi.ring[j], hi.z);
        push(lo.ring[i], lo.z);
        push(hi.ring[j], hi.z);
        push(hi.ring[i], hi.z);
      }
    }
  };
  addWalls(outer);
  holes.forEach(addWalls);

  const addCap = (outerRing: Pt[], holeRings: Pt[][], z: number, up: boolean) => {
    const toV = (ring: Pt[]) => ring.map((p) => new THREE.Vector2(p.x, p.y));
    const all = [outerRing, ...holeRings].flat();
    const faces = THREE.ShapeUtils.triangulateShape(toV(outerRing), holeRings.map(toV));
    for (const [a, b, c] of faces) {
      const A = all[a];
      const B = all[b];
      const C = all[c];
      const ccw = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x) > 0;
      push(A, z);
      if (ccw === up) {
        push(B, z);
        push(C, z);
      } else {
        push(C, z);
        push(B, z);
      }
    }
  };
  addCap(outer[0].ring, holes.map((layers) => layers[0].ring), 0, false);
  addCap(
    outer[outer.length - 1].ring,
    holes.map((layers) => layers[layers.length - 1].ring),
    opts.thickness,
    true
  );

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.computeVertexNormals();
  return geometry;
};

