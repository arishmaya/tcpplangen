/**
 * intersectionTcpEngine.ts
 *
 * A dynamic, framework-free port of the "Marina TCP Studio" prototype's
 * 4-leg signalized-intersection plan sheet (its renderX()/computeX(), see
 * the uploaded HTML prototype) -- but where the prototype's engine assumes
 * a fixed right-angle cross (its `XG` pixel grid: legs hardcoded at
 * 0/90/180/270 deg), this one is driven by the REAL headings of the
 * user's own hand-traced road-edge legs (see intersectionGeometry.ts),
 * each at its own angle and lane count. Works for ANY real leg count (2 --
 * a plain through road, 3 -- a T, 4 -- a classic cross, 5+) rather than
 * only the classic 4-leg cross the prototype assumed: one leg is the
 * closed (upstream) approach, the best-matching remaining leg becomes the
 * "opposite" (far/downstream) leg the taper/buffer/work-space run across,
 * and every other real leg still gets its own stub, advance-warning sign
 * and (where it can be geometrically paired with another one) live
 * traffic -- see computeIntersectionPlan() and the traffic-geometry
 * section of renderIntersectionPlanSVG() for exactly how. Everything else
 * (taper/buffer/spacing math, sign schedule, cones, legend, notes block,
 * title block, computed-values box, dimension chain) follows the same CA
 * MUTCD 2026 tables and visual language as the prototype and as
 * laneClosureTcpEngine.ts (that file's docstring covers why this is kept
 * as a second, deliberately unreconciled engine rather than merged with
 * the Texas MUTCD intersection tables already in utils/mutcd.ts).
 *
 * Like laneClosureTcpEngine.ts, this only computes numbers and builds an
 * SVG string -- no React, no DOM. A consuming component mounts the SVG via
 * a plain ref (see components/TracedIntersectionDiagram.tsx) the same way
 * the lane-closure plan sheet does, for the same reason: the geometry math
 * here is exact and reused verbatim by the SVG string builder, so nothing
 * is re-derived or risks drifting in a second, declarative-JSX copy.
 *
 * The one piece of real engineering judgment baked in here: since this is
 * a schematic (N.T.S., matching the prototype's own footer note), leg
 * ANGLES are real (computed from the trace) but leg LENGTHS on the sheet
 * are not to scale -- each leg gets a fixed pixel stub, and the real-feet
 * taper/buffer/sign-spacing numbers are proportionally squeezed into that
 * stub, exactly like the original template's `kw`/`ke` scale factors.
 */

// ---------------------------------------------------------------------
// Shared MUTCD 2026 tables (same source tables as laneClosureTcpEngine.ts)
// ---------------------------------------------------------------------

export type IntersectionComplianceLevel = 'ok' | 'warn' | 'bad' | 'info';

const BUFFER_TABLE: Record<number, number> = {
  20: 115, 25: 155, 30: 200, 35: 250, 40: 305, 45: 360, 50: 425, 55: 495, 60: 570, 65: 645, 70: 730, 75: 820,
};

function nearestBufferSpeed(s: number): number {
  const keys = Object.keys(BUFFER_TABLE).map(Number);
  return keys.reduce((best, k) => (Math.abs(k - s) < Math.abs(best - s) ? k : best), keys[0]);
}

interface AdvanceSpacing { A: number; B: number; C: number; row: string; }

function adv(S: number): AdvanceSpacing {
  const d = S <= 25 ? 100 : S <= 30 ? 150 : S <= 35 ? 200 : S <= 40 ? 250 : S <= 45 ? 300 : 350;
  const row = S <= 25 ? 'Urban, 25 mph or less' : S >= 50 ? 'Urban, 50 mph or more' : `Urban, ${S} mph`;
  return { A: d, B: d, C: d, row };
}

function taperLength(W: number, S: number): number {
  return Math.ceil(S <= 40 ? (W * S * S) / 60 : W * S);
}

function fmt(n: number): string { return Math.round(n).toLocaleString('en-US'); }
function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function angDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

/** One traced leg/arm, already reduced to plain numbers -- see
 * intersectionGeometry.ts for how this is derived from the actual
 * lat/lng trace. */
export interface IntersectionLegInput {
  id: string;
  name: string;
  lanes: number;
  speed: number;
  /** Compass bearing (0-360, 0=N/90=E/180=S/270=W) from the shared
   * intersection center out to this leg's far end. */
  bearingDeg: number;
}

export interface IntersectionClosureParams {
  /** At least 2. Any real leg count works (a plain 2-leg through road, a
   * 3-leg T, a 4-leg cross, 5+ legs) -- see computeIntersectionPlan()'s own
   * docstring for how the geometry generalizes. */
  legs: IntersectionLegInput[];
  /** Which leg is the upstream approach (the merging taper + advance
   * signs sit here, traffic travels FROM this leg THROUGH the
   * intersection); the engine finds the leg most nearly opposite it as
   * the far/downstream leg where the work space itself sits. */
  closedLegId: string;
  /** Lane offset width (W), ft -- same meaning as the lane-closure params. */
  offset: number;
  /** Work space length, ft, on the far/downstream leg. */
  work: number;
  sidewalk: boolean;
  bus: boolean;
  signal: boolean;
  hs: string;
  he: string;
  boxes: string[];
  addr: string;
  xing: string;
  access: string;
  dwg?: string;
}

export interface IntersectionCheck { lvl: IntersectionComplianceLevel; t: string; d: string; }

export interface IntersectionDeviceSummary {
  taperSp: number; tanSp: number; cones: number; typeIII: number; arrow: number; flaggers: number; typeII: number;
}

export interface IntersectionPlan {
  p: IntersectionClosureParams;
  closedLeg: IntersectionLegInput;
  /** The leg most nearly opposite closedLeg (best available match by real
   * bearing -- for a straight 2-leg road this is simply the only other leg;
   * for a T or an offset/skewed intersection it's whichever remaining leg
   * is closest to true-opposite, even if that's not very close). The
   * taper/buffer/work-space always sit on this leg's side, same as before. */
  oppositeLeg: IntersectionLegInput;
  /** Every other traced leg (neither closedLeg nor oppositeLeg) -- 0 for a
   * plain 2-leg road, 1 for a T, 2 for a classic 4-leg cross, 3+ for 5+-leg
   * sites. Each just gets a stub, advance-warning sign and (when it can be
   * paired with another otherLeg -- see renderIntersectionPlanSVG's traffic
   * section) a live-traffic movement. */
  otherLegs: IntersectionLegInput[];
  S: number;
  L: number;
  Lf: string;
  adv: AdvanceSpacing;
  buf: number;
  taper: number;
  nb: number;
  far: number;
  XW: number;
  total: number;
  dev: IntersectionDeviceSummary;
  checks: IntersectionCheck[];
}

export interface IntersectionItem { title: string; body: string; ref: string; }

// ---------------------------------------------------------------------
// Live-traffic geometry (mirrors laneClosureTcpEngine.ts's TrafficGeometry
// map/hdeg pattern -- see that file's docstring). Always 2 directed
// through-movements across the closed<->opposite (main) axis, plus 2 more
// for every pair of otherLegs the engine can geometrically pair up (see
// renderIntersectionPlanSVG's traffic-geometry section for the pairing
// algorithm -- it's not always exactly 2 "cross" legs any more). Each
// movement exposes an `at()` closure that reuses the SAME center/dir/perp/
// stopDist numbers the render function above already computed for its own
// pavement, taper wedge and work-space hatch -- so a car's on-sheet
// position always lines up with what's actually drawn, rather than being
// re-derived and risking drift.
// ---------------------------------------------------------------------

/** A movement's key in IntersectionTrafficGeometry.dirs -- `${fromLegId}__${toLegId}`,
 * built dynamically for however many legs the sheet has (2 keys for a
 * plain 2-leg road, up to 2 keys per paired-up leg beyond that -- see
 * renderIntersectionPlanSVG's traffic-geometry section). No longer a fixed
 * 4-value union now that leg count isn't fixed at 4. */
export type IntersectionAxisDirId = string;

/** One directed through-movement across the intersection, e.g. "closedLeg
 * approach, straight across, exiting on oppositeLeg". */
export interface IntersectionArmTraffic {
  fromId: string;
  toId: string;
  /** true for the two main-axis movements (closedLeg<->oppositeLeg) -- these
   * get the green during the "main" half of the signal cycle; false for any
   * other (cross-axis) movement, which gets the "cross" half. */
  isMain: boolean;
  /** Through-lanes each way, shared by both ends of this movement (the
   * smaller of the two legs' own lane counts, in the rare case they
   * differ). Lane index 0 = nearest median .. lanes-1 = outermost/curb. */
  lanes: number;
  /** Distance from center (px) to the spawn point, at the far end of the
   * `fromId` leg's stub. */
  spawnDist: number;
  /** Distance from center (px) to the despawn point, at the far end of the
   * `toId` leg's stub. */
  exitDist: number;
  /** Distance from center (px) to the stop bar on `fromId` -- cars queue
   * with their front bumper near here while the light is red for this
   * movement. */
  stopDist: number;
  /** Given a signed "virtual position" (vpos: +spawnDist at spawn, counting
   * down through 0 around the stop bar/center, to -exitDist at despawn) and
   * a 0-based through-lane index, returns the on-sheet point and heading
   * (degrees, atan2/rotate convention) for a car making this movement.
   * When this movement carries the merging taper (see `taper` below), the
   * outermost lane automatically shifts across the taper zone and stays
   * shifted for the rest of the trip -- the caller never has to special-case
   * the merge itself, only pick which lane a car spawns into. */
  at: (vpos: number, lane: number) => { x: number; y: number; headingDeg: number };
  /** Present only on the movement that carries the actual lane closure
   * (closedLeg -> oppositeLeg): the outermost lane's vpos bounds (far =
   * still full width, upstream; near = fully merged) -- the same station
   * numbers the taper wedge/dimension-chain entry above are drawn from. */
  taper: { farVpos: number; nearVpos: number } | null;
}

export interface IntersectionTrafficGeometry {
  center: { x: number; y: number };
  dirs: Record<IntersectionAxisDirId, IntersectionArmTraffic>;
  /** Full signal-cycle length, seconds -- 12s main green / 3s all-red / 12s
   * cross green / 3s all-red, mirroring the prototype's own xphase(). */
  cycleSec: number;
}

export interface IntersectionRenderResult {
  svg: string;
  items: Record<string, IntersectionItem>;
  /** Live-traffic geometry for this same plan sheet -- see
   * IntersectionTrafficGeometry's own docstring. Always present (unlike
   * laneClosureTcpEngine.ts's curve-mode-only `TrafficGeometry.map/hdeg`,
   * every sheet -- any leg count -- supports at least main-axis traffic,
   * there's no mode where it doesn't). */
  geo: IntersectionTrafficGeometry;
}

// ---------------------------------------------------------------------
// compute()
// ---------------------------------------------------------------------

export function computeIntersectionPlan(p: IntersectionClosureParams): IntersectionPlan | null {
  if (p.legs.length < 2) return null;
  const closedLeg = p.legs.find((l) => l.id === p.closedLegId) || p.legs[0];
  const others = p.legs.filter((l) => l.id !== closedLeg.id);
  if (others.length < 1) return null;

  let oppositeLeg = others[0];
  let bestDiff = angDiff(others[0].bearingDeg, (closedLeg.bearingDeg + 180) % 360);
  for (const l of others.slice(1)) {
    const d = angDiff(l.bearingDeg, (closedLeg.bearingDeg + 180) % 360);
    if (d < bestDiff) { bestDiff = d; oppositeLeg = l; }
  }
  const otherLegs = others.filter((l) => l.id !== oppositeLeg.id);

  const S = closedLeg.speed;
  const W = p.offset;
  const L = taperLength(W, S);
  const a = adv(S);
  const buf = BUFFER_TABLE[nearestBufferSpeed(S)];
  const Lf = S <= 40 ? `L = WS²/60 = ${W} × ${S}² / 60` : `L = WS = ${W} × ${S}`;

  const XW = 120, far = 30;
  const nb = Math.max(50, buf - XW - far);
  const total = nb + L + a.A + a.B + a.C + far + p.work + 100 + 100;

  const nT = Math.max(2, Math.round(L / S) + 1);
  const nN = Math.max(1, Math.round(nb / (2 * S)));
  const nF = Math.max(1, Math.round((far + p.work) / (2 * S)));
  const nD = Math.round(100 / 20);
  const cones = nT + nN + 3 + nF + nD;
  const dev: IntersectionDeviceSummary = {
    taperSp: S, tanSp: 2 * S, cones, typeIII: 2, arrow: 1, flaggers: 0, typeII: p.sidewalk ? 2 : 0,
  };

  const checks: IntersectionCheck[] = [];
  const okH = p.hs >= '09:00' && p.he <= '15:00' && p.hs < p.he;
  checks.push({
    lvl: okH ? 'ok' : 'bad',
    t: 'Lane closure hours',
    d: okH
      ? `${p.hs} to ${p.he} is inside a 9:00 AM to 3:00 PM lane-closure window.`
      : `${p.hs} to ${p.he} falls outside a 9:00 AM to 3:00 PM lane-closure window.`,
  });
  checks.push({ lvl: 'ok', t: 'Merge completes before the intersection', d: `Taper ends ${nb} ft before the stop bar on ${esc(closedLeg.name)}, so no merging happens inside the intersection.` });
  checks.push({ lvl: 'ok', t: 'Buffer carried through the intersection', d: `${nb} ft near side + ${XW} ft intersection + ${far} ft far side = ${nb + XW + far} ft ≥ ${buf} ft (Table 6B-2).` });
  if (p.signal) checks.push({ lvl: 'warn', t: 'Signalized intersection', d: 'Traffic direction through the signal by a qualified flagger, police officer or CSO only. Arrange any signal override or timing change 14 days ahead.' });
  checks.push({ lvl: 'info', t: 'All approaches signed', d: `W20-1 on every approach, each at its own leg's advance-warning spacing for its posted speed.` });
  if (p.sidewalk) checks.push({ lvl: 'info', t: 'Pedestrian route', d: `Sidewalk closed on ${esc(oppositeLeg.name)}, past the intersection on the work side. Signed detour to the opposite sidewalk.` });
  if (p.bus) checks.push({ lvl: 'warn', t: 'Bus stop in work zone', d: 'Contact the transit authority 3 days before work to relocate the stop.' });
  const legAngles = p.legs.map((l) => `${esc(l.name)} ${Math.round(l.bearingDeg)}°`).join(', ');
  checks.push({ lvl: 'info', t: 'Geometry source', d: `Leg headings computed from your traced road edges (${legAngles}) -- not assumed square.` });

  return { p, closedLeg, oppositeLeg, otherLegs, S, L, Lf, adv: a, buf, taper: L, nb, far, XW, total, dev, checks };
}

// ---------------------------------------------------------------------
// Small 2D vector helpers for the corner-fillet / leg-placement geometry
// ---------------------------------------------------------------------

interface Vec { x: number; y: number; }
const toRad = (d: number) => (d * Math.PI) / 180;
const vAdd = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
const vDot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
const vCross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
const vLen = (a: Vec): number => Math.hypot(a.x, a.y);
const vNorm = (a: Vec): Vec => { const l = vLen(a) || 1; return { x: a.x / l, y: a.y / l }; };
/** Rotates a vector +90 degrees (screen/SVG coordinate convention, y-down). */
const vPerp = (a: Vec): Vec => ({ x: -a.y, y: a.x });
const unitAt = (angDeg: number): Vec => { const r = toRad(angDeg); return { x: Math.cos(r), y: Math.sin(r) }; };

function lineIntersect(p1: Vec, d1: Vec, p2: Vec, d2: Vec): Vec | null {
  const denom = vCross(d1, d2);
  if (Math.abs(denom) < 1e-6) return null;
  const t = vCross(vSub(p2, p1), d2) / denom;
  return vAdd(p1, vScale(d1, t));
}

/** Which of a leg's two perpendicular offset directions (+90 vs -90 from
 * its own outward angle) points toward a given neighbor -- picks whichever
 * is angularly closer, which is robust regardless of rotation direction. */
function facingSign(legAngle: number, neighborAngle: number): 1 | -1 {
  const plus = angDiff((legAngle + 90) % 360, neighborAngle);
  const minus = angDiff((legAngle - 90 + 360) % 360, neighborAngle);
  return plus <= minus ? 1 : -1;
}

/** Standard circle-fillet construction: given a raw (unrounded) corner and
 * the two outward unit directions of the curb lines meeting there, returns
 * the two trim points and an SVG elliptical-arc command connecting them
 * (exact sweep-flag, derived from the real arc center -- not guessed).
 *
 * `maxTrim` bounds how far the trim points can slide back along each curb
 * line -- the caller passes in a distance tied to the two arms' own
 * stopDist (see render()), so a fillet can never reach out past a leg's
 * own stop bar and collide with that leg's signs/dimension chain. Without
 * this, a tight real-world corner (two traced legs meeting well under 90
 * degrees apart, which happens at skewed/offset intersections) pushes the
 * unbounded trig-derived trim distance toward its old fixed 120px cap
 * regardless of how short the legs actually are, producing both a stray
 * far-flung arc and overlapping sign placements -- exactly the failure
 * mode a too-acute real intersection triggered. */
function filletCorner(corner: Vec, uI: Vec, uJ: Vec, R: number, maxTrim: number = 120): { trimI: Vec; trimJ: Vec; arcCmd: string } | null {
  const cosTheta = Math.max(-1, Math.min(1, vDot(uI, uJ)));
  const theta = Math.acos(cosTheta);
  // Below ~34 degrees between the two curb lines, even a bounded fillet
  // stops reading as a curb return -- skip rounding and fall back to the
  // plain, unrounded corner, which is always geometrically safe.
  if (theta < 0.6 || theta > Math.PI - 0.05) return null;
  const t = Math.min(maxTrim, Math.max(4, R / Math.tan(theta / 2)));
  const trimI = vAdd(corner, vScale(uI, t));
  const trimJ = vAdd(corner, vScale(uJ, t));
  const bisector = vNorm(vAdd(uI, uJ));
  const arcCenter = vAdd(corner, vScale(bisector, R / Math.sin(theta / 2)));
  const a1 = Math.atan2(trimI.y - arcCenter.y, trimI.x - arcCenter.x);
  const a2 = Math.atan2(trimJ.y - arcCenter.y, trimJ.x - arcCenter.x);
  let delta = a2 - a1;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  const sweep = delta > 0 ? 1 : 0;
  const arcCmd = `A ${R} ${R} 0 0 ${sweep} ${trimJ.x.toFixed(1)} ${trimJ.y.toFixed(1)}`;
  return { trimI, trimJ, arcCmd };
}

// ---------------------------------------------------------------------
// render()
// ---------------------------------------------------------------------

const SIDEWALK_PX = 20, BIKE_PX = 16, LANE_PX = 26, MEDIAN_PX = 16, FILLET_R = 18;
const MAIN_STUB = 520, CROSS_STUB = 230;

function halfWidth(lanes: number): number {
  return SIDEWALK_PX + BIKE_PX + lanes * LANE_PX + MEDIAN_PX / 2;
}

interface ArmGeom {
  leg: IntersectionLegInput;
  canvasAngle: number;
  dir: Vec;
  perp: Vec;
  halfW: number;
  stopDist: number;
  stub: number;
}

export function renderIntersectionPlanSVG(m: IntersectionPlan): IntersectionRenderResult {
  const p = m.p, out: string[] = [], items: Record<string, IntersectionItem> = {};
  const F = 'Arial, Helvetica, sans-serif', INK = '#1b1b1b', OR = '#f7931e', GR = '#6b6b6b';
  const CX = 800, CY = 475;
  const center: Vec = { x: CX, y: CY };

  const canvasAngle = (bearing: number) => {
    let a = (bearing - m.closedLeg.bearingDeg + 180) % 360;
    if (a < 0) a += 360;
    return a;
  };

  const allLegs = m.p.legs;
  const arms: Record<string, ArmGeom> = {};
  allLegs.forEach((leg) => {
    const ca = canvasAngle(leg.bearingDeg);
    const isMain = leg.id === m.closedLeg.id || leg.id === m.oppositeLeg.id;
    arms[leg.id] = {
      leg, canvasAngle: ca, dir: unitAt(ca), perp: vPerp(unitAt(ca)),
      halfW: halfWidth(leg.lanes), stopDist: 0, stub: isMain ? MAIN_STUB : CROSS_STUB,
    };
  });
  // stopDist per arm = how far its own stop bar sits from the true center,
  // based on the WIDEST of every other real leg meeting here -- i.e. "as
  // wide as the widest road you'd be crossing", not this arm's own width.
  // Generalizes cleanly to any leg count (was a fixed pair-vs-pair lookup
  // when this engine only ever saw exactly 4 legs).
  allLegs.forEach((leg) => {
    const others = allLegs.filter((l) => l.id !== leg.id);
    arms[leg.id].stopDist = Math.max(...others.map((l) => arms[l.id].halfW)) + 10;
  });

  const order = [...allLegs].sort((a, b) => arms[a.id].canvasAngle - arms[b.id].canvasAngle);

  // Canvas is taller than this engine's previous 1035px (now 1120) to fit
  // the bottom band's 222px-tall boxes -- see that section's own comment
  // for why laneClosureTcpEngine.ts's exact y-coordinates can't be reused
  // directly on top of this engine's radial leg layout.
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1120" font-family="${F}">`);
  out.push(
    '<defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#ffffff"/><line x1="0" y1="0" x2="0" y2="7" stroke="#444" stroke-width="1.3"/></pattern>' +
    '<pattern id="hatch2" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="8" height="8" fill="#f1efe9"/><line x1="0" y1="0" x2="0" y2="8" stroke="#9a9a9a" stroke-width="1"/></pattern>' +
    '<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 L10 5 L0 9 z" fill="' + INK + '"/></marker></defs>',
  );
  out.push(`<rect width="1600" height="1120" fill="#ffffff"/><rect x="20" y="20" width="1560" height="1080" fill="none" stroke="${INK}" stroke-width="4"/>`);

  // header -- matches laneClosureTcpEngine.ts's own header block line for
  // line (same 4 header lines, same title-block ISSUE/DATE box WITH its
  // value row, which this sheet was previously missing entirely, and the
  // same single-line orange subtitle format), so the two plan-sheet
  // engines produce visually identical headers. There's no "N of 11"
  // Work-Area-preset numbering for a traced intersection, so that header
  // line uses the drawing number instead of a work-area index.
  out.push(`<g fill="${INK}"><text x="44" y="64" font-size="26">${esc(p.addr)}</text><text x="44" y="94" font-size="21">${esc(p.xing)}</text><text x="44" y="122" font-size="19">${esc(p.access)}</text><text x="44" y="150" font-size="19">WORK AREA ${esc(p.dwg || '—')}</text></g>`);
  out.push(`<g stroke="${INK}" fill="none" stroke-width="1"><rect x="1430" y="30" width="130" height="46"/><line x1="1480" y1="30" x2="1480" y2="76"/><line x1="1430" y1="46" x2="1560" y2="46"/></g>`);
  out.push(`<g fill="${INK}" font-size="9"><text x="1446" y="42">ISSUE</text><text x="1508" y="42">DATE</text></g><g fill="${INK}" font-size="15"><text x="1450" y="68">0</text><text x="1490" y="68">8/26/26</text></g>`);
  // Site-kind label reflects the REAL leg count -- this used to say
  // "4-LEG SIGNALIZED INTERSECTION" unconditionally, which was wrong for
  // anything traced with a different number of legs (or a non-signalized
  // one). allLegs.length is already the true count from p.legs.
  const legCount = allLegs.length;
  const siteKind = legCount <= 2 ? 'STRAIGHT-ROAD CLOSURE' : legCount === 3 ? 'T-INTERSECTION' : `${legCount}-LEG INTERSECTION`;
  const siteKindTag = legCount >= 3 ? `${siteKind}${p.signal ? ' · SIGNALIZED' : ''}` : siteKind;
  out.push(`<text x="44" y="178" font-size="12" fill="${OR}" font-weight="bold">${siteKindTag} · S = ${m.S} MPH · GENERATED DRAFT</text>`);

  // -------- corner fillets (compute once, reused for pavement bounds,
  // crosswalks and the outer curb polygon) --------
  const cornerTrims: Record<string, { toward: string; trim: Vec }[]> = {};
  allLegs.forEach((l) => { cornerTrims[l.id] = []; });
  const boxPts: Vec[] = [];
  for (let i = 0; i < order.length; i++) {
    const legI = order[i], legJ = order[(i + 1) % order.length];
    const armI = arms[legI.id], armJ = arms[legJ.id];
    const sI = facingSign(armI.canvasAngle, armJ.canvasAngle);
    const sJ = facingSign(armJ.canvasAngle, armI.canvasAngle);
    const offI = vAdd(center, vScale(armI.perp, sI * armI.halfW));
    const offJ = vAdd(center, vScale(armJ.perp, sJ * armJ.halfW));
    const corner = lineIntersect(offI, armI.dir, offJ, armJ.dir);
    if (!corner) continue;
    // Never let a fillet reach out past either leg's own stop bar -- see
    // filletCorner()'s docstring for why this matters at a tight real-world
    // corner.
    const maxTrim = Math.max(4, Math.min(armI.stopDist, armJ.stopDist) * 0.6);
    const fillet = filletCorner(corner, armI.dir, armJ.dir, FILLET_R, maxTrim);
    if (fillet) {
      cornerTrims[legI.id].push({ toward: legJ.id, trim: fillet.trimI });
      cornerTrims[legJ.id].push({ toward: legI.id, trim: fillet.trimJ });
      boxPts.push(fillet.trimI, fillet.trimJ);
    } else {
      cornerTrims[legI.id].push({ toward: legJ.id, trim: corner });
      cornerTrims[legJ.id].push({ toward: legI.id, trim: corner });
      boxPts.push(corner);
    }
  }

  // intersection pavement box (plain surface under everything else)
  if (boxPts.length >= 3) {
    out.push(`<path d="M ${boxPts.map((v) => `${v.x.toFixed(1)} ${v.y.toFixed(1)}`).join(' L ')} Z" fill="#ffffff" stroke="${INK}" stroke-width="1.4"/>`);
  }
  // rounded curb-return arcs on top of the box edge
  for (let i = 0; i < order.length; i++) {
    const legI = order[i], legJ = order[(i + 1) % order.length];
    const armI = arms[legI.id], armJ = arms[legJ.id];
    const sI = facingSign(armI.canvasAngle, armJ.canvasAngle);
    const sJ = facingSign(armJ.canvasAngle, armI.canvasAngle);
    const offI = vAdd(center, vScale(armI.perp, sI * armI.halfW));
    const offJ = vAdd(center, vScale(armJ.perp, sJ * armJ.halfW));
    const corner = lineIntersect(offI, armI.dir, offJ, armJ.dir);
    if (!corner) continue;
    const maxTrim = Math.max(4, Math.min(armI.stopDist, armJ.stopDist) * 0.6);
    const fillet = filletCorner(corner, armI.dir, armJ.dir, FILLET_R, maxTrim);
    if (fillet) out.push(`<path d="M ${fillet.trimI.x.toFixed(1)} ${fillet.trimI.y.toFixed(1)} ${fillet.arcCmd}" fill="none" stroke="${INK}" stroke-width="2"/>`);
  }

  // -------- per-arm pavement rows (sidewalk / bike / lanes / median) --------
  const SWF = '#ececE8';
  function armRow(arm: ArmGeom, offA: number, offB: number, fill: string, nearOverride?: number) {
    const near = nearOverride ?? (Math.abs(offA) < 1 || Math.abs(offB) < 1 ? -Math.max(60, arm.halfW) : FILLET_R + 6);
    const p1 = vAdd(center, vAdd(vScale(arm.dir, near), vScale(arm.perp, offA)));
    const p2 = vAdd(center, vAdd(vScale(arm.dir, near), vScale(arm.perp, offB)));
    const p3 = vAdd(center, vAdd(vScale(arm.dir, arm.stub), vScale(arm.perp, offB)));
    const p4 = vAdd(center, vAdd(vScale(arm.dir, arm.stub), vScale(arm.perp, offA)));
    out.push(`<polygon points="${[p1, p2, p3, p4].map((v) => `${v.x.toFixed(1)},${v.y.toFixed(1)}`).join(' ')}" fill="${fill}"/>`);
  }
  allLegs.forEach((leg) => {
    const arm = arms[leg.id];
    const medianEdge = MEDIAN_PX / 2, laneEnd = medianEdge + leg.lanes * LANE_PX, bikeEnd = laneEnd + BIKE_PX, swEnd = bikeEnd + SIDEWALK_PX;
    [-1, 1].forEach((side) => {
      armRow(arm, side * medianEdge, side * laneEnd, '#ffffff'); // lanes (through pavement)
      armRow(arm, side * laneEnd, side * bikeEnd, '#f7f7f3'); // bike lane
      armRow(arm, side * bikeEnd, side * swEnd, SWF); // sidewalk
      // internal dashed lane separators
      for (let i = 1; i < leg.lanes; i++) {
        const off = side * (medianEdge + i * LANE_PX);
        const q1 = vAdd(center, vAdd(vScale(arm.dir, FILLET_R + 6), vScale(arm.perp, off)));
        const q2 = vAdd(center, vAdd(vScale(arm.dir, arm.stub), vScale(arm.perp, off)));
        out.push(`<line x1="${q1.x.toFixed(1)}" y1="${q1.y.toFixed(1)}" x2="${q2.x.toFixed(1)}" y2="${q2.y.toFixed(1)}" stroke="${INK}" stroke-width="1" stroke-dasharray="14 10"/>`);
      }
    });
    // median strip
    armRow(arm, -medianEdge, medianEdge, '#e2e2dc');
    // outer edge lines (sidewalk boundary)
    [-1, 1].forEach((side) => {
      const q1 = vAdd(center, vAdd(vScale(arm.dir, -Math.max(60, arm.halfW)), vScale(arm.perp, side * swEnd)));
      const q2 = vAdd(center, vAdd(vScale(arm.dir, arm.stub), vScale(arm.perp, side * swEnd)));
      out.push(`<line x1="${q1.x.toFixed(1)}" y1="${q1.y.toFixed(1)}" x2="${q2.x.toFixed(1)}" y2="${q2.y.toFixed(1)}" stroke="${INK}" stroke-width="1"/>`);
    });
    // road name + speed placard, near the stub tip
    const labelPt = vAdd(center, vScale(arm.dir, arm.stub - 16));
    const labelOffsetPt = vAdd(labelPt, vScale(arm.perp, -(swEnd + 10)));
    out.push(`<text x="${labelOffsetPt.x.toFixed(1)}" y="${labelOffsetPt.y.toFixed(1)}" font-size="15" fill="${INK}" text-anchor="middle">${esc(leg.name)}</text>`);
    const spPt = vAdd(labelOffsetPt, vScale(arm.perp, -26));
    out.push(`<g><rect x="${(spPt.x - 11).toFixed(1)}" y="${(spPt.y - 14).toFixed(1)}" width="22" height="24" fill="#fff" stroke="${INK}"/><text x="${spPt.x.toFixed(1)}" y="${(spPt.y - 6).toFixed(1)}" font-size="5" text-anchor="middle">SPEED</text><text x="${spPt.x.toFixed(1)}" y="${(spPt.y - 1).toFixed(1)}" font-size="5" text-anchor="middle">LIMIT</text><text x="${spPt.x.toFixed(1)}" y="${(spPt.y + 9).toFixed(1)}" font-size="11" text-anchor="middle" font-weight="bold">${leg.speed}</text></g>`);
    // stop bar
    const b1 = vAdd(center, vAdd(vScale(arm.dir, arm.stopDist), vScale(arm.perp, -laneEnd)));
    const b2 = vAdd(center, vAdd(vScale(arm.dir, arm.stopDist), vScale(arm.perp, medianEdge)));
    out.push(`<line x1="${b1.x.toFixed(1)}" y1="${b1.y.toFixed(1)}" x2="${b2.x.toFixed(1)}" y2="${b2.y.toFixed(1)}" stroke="${INK}" stroke-width="4"/>`);
    // crosswalk band just outside the stop bar
    const cw: string[] = [];
    for (let d = -laneEnd; d < medianEdge; d += 10) {
      const q1 = vAdd(center, vAdd(vScale(arm.dir, arm.stopDist + 6), vScale(arm.perp, d)));
      const q2 = vAdd(center, vAdd(vScale(arm.dir, arm.stopDist + 22), vScale(arm.perp, d)));
      cw.push(`<line x1="${q1.x.toFixed(1)}" y1="${q1.y.toFixed(1)}" x2="${q2.x.toFixed(1)}" y2="${q2.y.toFixed(1)}" stroke="${INK}" stroke-width="4"/>`);
    }
    out.push(`<g>${cw.join('')}</g>`);
    // direction arrows on the lane pavement
    [0.35, 0.7].forEach((f) => {
      const at = vAdd(center, vAdd(vScale(arm.dir, arm.stopDist + f * (arm.stub - arm.stopDist)), vScale(arm.perp, -medianEdge - LANE_PX / 2)));
      const tip = vAdd(at, vScale(arm.dir, -14));
      out.push(`<path d="M${at.x.toFixed(1)} ${at.y.toFixed(1)} L${tip.x.toFixed(1)} ${tip.y.toFixed(1)}" stroke="${INK}" stroke-width="1.8" fill="none" marker-end="url(#ar)"/>`);
    });
  });

  // signal symbol -- only when this site actually has one (used to be
  // drawn unconditionally, which showed a signal even on a non-signalized
  // closure/T/straight-road site).
  if (p.signal) {
    items.sig = { title: 'Signalized intersection', body: 'Existing signal stays in normal operation. Only a qualified flagger, police officer or CSO may direct traffic through it; signal overrides are arranged 14 days ahead.', ref: 'Part 6 general notes' };
    out.push(`<g class="it" data-k="sig"><circle cx="${CX}" cy="${CY}" r="11" fill="#fff" stroke="${INK}" stroke-width="1.6"/><text x="${CX}" y="${CY + 5}" font-size="14" text-anchor="middle" font-weight="bold" fill="${INK}">S</text></g>`);
  }

  // -------- main-road segments (closed leg upstream -> opposite leg downstream) --------
  const closedArm = arms[m.closedLeg.id], oppArm = arms[m.oppositeLeg.id];
  const totW = m.nb + m.L + m.adv.A + m.adv.B + m.adv.C;
  const kw = (MAIN_STUB - closedArm.stopDist - 60) / totW;
  const totE = m.far + p.work + 100 + 100;
  const ke = (MAIN_STUB - oppArm.stopDist - 40) / totE;

  const atClosed = (station: number) => vAdd(center, vScale(closedArm.dir, closedArm.stopDist + station * kw));
  const atOpp = (station: number) => vAdd(center, vScale(oppArm.dir, oppArm.stopDist + station * ke));

  const segKeys: { key: string; label: string; ft: number; ref: string; from: () => Vec; to: () => Vec }[] = [
    { key: 'C', label: 'C', ft: m.adv.C, ref: '6B-1', from: () => atClosed(m.nb + m.L + m.adv.A + m.adv.B), to: () => atClosed(m.nb + m.L + m.adv.A + m.adv.B + m.adv.C) },
    { key: 'B', label: 'B', ft: m.adv.B, ref: '6B-1', from: () => atClosed(m.nb + m.L + m.adv.A), to: () => atClosed(m.nb + m.L + m.adv.A + m.adv.B) },
    { key: 'A', label: 'A', ft: m.adv.A, ref: '6B-1', from: () => atClosed(m.nb + m.L), to: () => atClosed(m.nb + m.L + m.adv.A) },
    { key: 'taper', label: 'TAPER', ft: m.L, ref: '6B-3', from: () => atClosed(m.nb), to: () => atClosed(m.nb + m.L) },
    { key: 'buffer', label: 'BUFFER (THRU INTERSECTION)', ft: m.buf, ref: '6B-2', from: () => atClosed(0), to: () => atOpp(0) },
    { key: 'work', label: 'WORK', ft: p.work, ref: 'FIELD', from: () => atOpp(m.far), to: () => atOpp(m.far + p.work) },
    { key: 'ds', label: 'DOWNSTR.', ft: 100, ref: '6B-3', from: () => atOpp(m.far + p.work), to: () => atOpp(m.far + p.work + 100) },
    { key: 'end', label: 'TO G20-2', ft: 100, ref: 'FIELD', from: () => atOpp(m.far + p.work + 100), to: () => atOpp(m.far + p.work + 200) },
  ];

  // taper callout (the closed lane visually narrows -- a simple wedge overlay on the outer lane)
  const laneEndClosed = MEDIAN_PX / 2 + m.closedLeg.lanes * LANE_PX;
  const tp0 = vAdd(center, vAdd(vScale(closedArm.dir, closedArm.stopDist + m.nb * kw), vScale(closedArm.perp, -laneEndClosed)));
  const tp1 = vAdd(center, vAdd(vScale(closedArm.dir, closedArm.stopDist + (m.nb + m.L) * kw), vScale(closedArm.perp, -(laneEndClosed - LANE_PX))));
  out.push(`<g data-seg="taper" class="dim"><line x1="${tp0.x.toFixed(1)}" y1="${tp0.y.toFixed(1)}" x2="${tp1.x.toFixed(1)}" y2="${tp1.y.toFixed(1)}" stroke="${OR}" stroke-width="3"/></g>`);
  const taperMid = vAdd(tp0, vScale(vSub(tp1, tp0), 0.5));
  out.push(`<text x="${taperMid.x.toFixed(1)}" y="${(taperMid.y - 8).toFixed(1)}" font-size="10" text-anchor="middle" font-weight="bold" fill="${INK}">${fmt(m.taper)}' MERGING TAPER</text>`);

  // work space hatch on the far leg's outer lane
  const wx0 = atOpp(m.far), wx1 = atOpp(m.far + p.work);
  const wLaneEnd = MEDIAN_PX / 2 + m.oppositeLeg.lanes * LANE_PX;
  const workCorners = [
    vAdd(wx0, vScale(oppArm.perp, -(wLaneEnd - 2))), vAdd(wx0, vScale(oppArm.perp, -(wLaneEnd - LANE_PX + 2))),
    vAdd(wx1, vScale(oppArm.perp, -(wLaneEnd - LANE_PX + 2))), vAdd(wx1, vScale(oppArm.perp, -(wLaneEnd - 2))),
  ];
  items.work = { title: `Work space · ${fmt(p.work)} ft`, body: `${esc(p.access)}. Far side of the intersection, ${esc(m.oppositeLeg.name)}, curb lane.`, ref: 'Part 6 · activity area' };
  out.push(`<g class="it" data-k="work"><polygon points="${workCorners.map((v) => `${v.x.toFixed(1)},${v.y.toFixed(1)}`).join(' ')}" fill="url(#hatch)" stroke="${INK}" stroke-width="1.2"/></g>`);
  (p.boxes || []).forEach((b, ix) => {
    const at = vAdd(wx0, vScale(vSub(wx1, wx0), (ix + 1) / ((p.boxes || []).length + 1)));
    const key = `sb${ix}`;
    items[key] = { title: b, body: 'Access point inside the work space.', ref: 'Vicinity map, sheet 1' };
    out.push(`<g class="it" data-k="${key}"><rect x="${(at.x - 5).toFixed(1)}" y="${(at.y - 5).toFixed(1)}" width="10" height="10" fill="#fff" stroke="#d81f1f" stroke-width="2"/></g>`);
  });

  // barricades at each end of the work space
  [wx0, wx1].forEach((pt, ix) => {
    const key = `b3${ix}`;
    items[key] = { title: 'Type III barricade with sign', body: `${ix === 0 ? 'Upstream' : 'Downstream'} end of the work space, across the closed lane.`, ref: 'Part 6 channelizing devices' };
    const perpVec = vScale(oppArm.perp, 1);
    const q1 = vAdd(pt, vScale(perpVec, -(wLaneEnd - 4))), q2 = vAdd(pt, vScale(perpVec, -(wLaneEnd - LANE_PX + 4)));
    out.push(`<g class="it" data-k="${key}"><line x1="${q1.x.toFixed(1)}" y1="${q1.y.toFixed(1)}" x2="${q2.x.toFixed(1)}" y2="${q2.y.toFixed(1)}" stroke="${INK}" stroke-width="4"/></g>`);
  });

  // arrow board at end of merging taper
  const abPt = vAdd(atClosed(m.nb - 12), vScale(closedArm.perp, -(laneEndClosed - LANE_PX / 2)));
  items.ab = { title: 'Flashing arrow board', body: 'In the closed curb lane at the end of the near-side merging taper.', ref: 'Part 6 arrow board guidance' };
  out.push(`<g class="it" data-k="ab"><rect x="${(abPt.x - 9).toFixed(1)}" y="${(abPt.y - 9).toFixed(1)}" width="18" height="18" fill="${INK}"/></g>`);

  // cones along the taper + tangent + far-side segments
  items.cones = { title: `Channelizing devices · ${m.dev.cones} cones`, body: `Merging taper at ${m.dev.taperSp} ft spacing, tangent at ${m.dev.tanSp} ft, carried through to the far-side work space.`, ref: 'MUTCD 11th Ed. Part 6 channelizing guidance' };
  const coneEls: string[] = [];
  const dropCone = (pt: Vec) => coneEls.push(`<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="3.4" fill="${OR}" stroke="${INK}" stroke-width="1"/>`);
  for (let i = 0; i <= 8; i++) {
    const f = i / 8;
    dropCone(vAdd(vAdd(center, vScale(closedArm.dir, closedArm.stopDist + (m.nb + f * m.L) * kw)), vScale(closedArm.perp, -(laneEndClosed - f * LANE_PX))));
  }
  for (let i = 1; i <= 4; i++) dropCone(atClosed((m.nb * i) / 5));
  for (let i = 0; i <= 3; i++) {
    const f = i / 3;
    dropCone(vAdd(wx0, vScale(vSub(wx1, wx0), f)).x !== undefined ? vAdd(vAdd(wx0, vScale(vSub(wx1, wx0), f)), vScale(oppArm.perp, -(wLaneEnd - LANE_PX / 2))) : wx0);
  }
  out.push(`<g class="it" data-k="cones">${coneEls.join('')}</g>`);

  // -------- signs --------
  let sIx = 0;
  const placeSign = (key: string, code: string, lines: string[], body: string, ref: string, at: Vec, labelBelow: boolean) => {
    items[key] = { title: `${code} · ${lines.join(' ')}`, body, ref };
    const shape = code === 'G20-2' ? 'rect' : code.startsWith('R9') ? 'reg' : 'diamond';
    let g = `<g class="it" data-k="${key}">`;
    if (shape === 'rect') g += `<rect x="${(at.x - 24).toFixed(1)}" y="${(at.y - 8).toFixed(1)}" width="48" height="16" fill="${OR}" stroke="${INK}"/>`;
    else if (shape === 'reg') g += `<rect x="${(at.x - 22).toFixed(1)}" y="${(at.y - 10).toFixed(1)}" width="44" height="20" fill="#fff" stroke="${INK}"/>`;
    else g += `<path d="M${at.x.toFixed(1)} ${(at.y - 22).toFixed(1)} L${(at.x + 22).toFixed(1)} ${at.y.toFixed(1)} L${at.x.toFixed(1)} ${(at.y + 22).toFixed(1)} L${(at.x - 22).toFixed(1)} ${at.y.toFixed(1)} Z" fill="${OR}" stroke="${INK}" stroke-width="1.2"/>`;
    const n = lines.length;
    lines.forEach((t, li) => { g += `<text x="${at.x.toFixed(1)}" y="${(at.y + (li - (n - 1) / 2) * 6.4 + 2).toFixed(1)}" font-size="${t.length > 9 ? 4.6 : 5.6}" text-anchor="middle" font-weight="bold" fill="${INK}">${esc(t)}</text>`; });
    g += `<text x="${at.x.toFixed(1)}" y="${(labelBelow ? at.y + 34 : at.y - 28).toFixed(1)}" font-size="10" text-anchor="middle" font-weight="bold" fill="${INK}">${code}</text></g>`;
    out.push(g);
  };

  const closedSignOffset = -(laneEndClosed + SIDEWALK_PX + 20);
  placeSign(`sg${sIx++}`, 'W20-1', ['ROAD', 'WORK', 'AHEAD'], `Approaching ${esc(m.closedLeg.name)}, farthest upstream sign. ${m.adv.A + m.adv.B + m.adv.C} ft ahead of the merging taper.`, '6B-1', vAdd(atClosed(m.nb + m.L + m.adv.A + m.adv.B + m.adv.C), vScale(closedArm.perp, closedSignOffset)), true);
  placeSign(`sg${sIx++}`, 'W20-5R', ['RIGHT', 'LANE CLOSED', 'AHEAD'], `Second sign. B = ${m.adv.B} ft from the first sign.`, '6B-1', vAdd(atClosed(m.nb + m.L + m.adv.A + m.adv.B), vScale(closedArm.perp, closedSignOffset)), true);
  placeSign(`sg${sIx++}`, 'C30(CA)', ['LANE', 'CLOSED'], `First sign, closest to the taper. A = ${m.adv.A} ft ahead of the merge.`, '6B-1', vAdd(atClosed(m.nb + m.L + m.adv.A), vScale(closedArm.perp, closedSignOffset)), true);
  placeSign(`sg${sIx++}`, 'G20-2', ['END', 'ROAD WORK'], 'Placed past the downstream taper where normal traffic resumes.', 'Part 6 sign guidance', vAdd(atOpp(m.far + p.work + 190), vScale(oppArm.perp, -(wLaneEnd + SIDEWALK_PX + 20))), true);

  const oppA = adv(m.oppositeLeg.speed);
  placeSign(`sg${sIx++}`, 'W20-1', ['ROAD', 'WORK', 'AHEAD'], `Approaching ${esc(m.oppositeLeg.name)} from the far side.`, '6B-1', vAdd(atOpp(oppA.A), vScale(oppArm.perp, wLaneEnd + SIDEWALK_PX + 20)), false);

  // Every other real leg (0 for a plain 2-leg road, 1 for a T, 2 for a
  // classic 4-leg cross, 3+ beyond that) gets its own advance-warning sign
  // at its own real speed/lane geometry -- was a fixed 2-element tuple
  // (m.crossLegs) when this engine only ever handled exactly 4 legs.
  m.otherLegs.forEach((leg) => {
    const arm = arms[leg.id];
    const crossA = adv(leg.speed);
    const laneEnd = MEDIAN_PX / 2 + leg.lanes * LANE_PX;
    const at = vAdd(vAdd(center, vScale(arm.dir, arm.stopDist + crossA.A)), vScale(arm.perp, -(laneEnd + SIDEWALK_PX + 20)));
    placeSign(`sg${sIx++}`, 'W20-1', ['ROAD', 'WORK', 'AHEAD'], `Approaching ${esc(leg.name)}. A = ${crossA.A} ft for ${leg.speed} mph.`, '6B-1', at, true);
  });

  if (p.sidewalk) {
    const s0 = vAdd(wx0, vScale(oppArm.perp, wLaneEnd + BIKE_PX + 6));
    placeSign('r9a', 'R9-11a', ['SIDEWALK CLOSED', 'CROSS HERE'], 'Sends pedestrians across to the opposite sidewalk.', 'Part 6 pedestrian considerations', s0, false);
    const s1 = vAdd(wx1, vScale(oppArm.perp, wLaneEnd + BIKE_PX + 6));
    placeSign('r99', 'R9-9', ['SIDEWALK', 'CLOSED'], 'Downstream end of the sidewalk closure, on a Type II barricade.', 'Part 6 pedestrian considerations', s1, false);
    const s0b = vAdd(wx0, vScale(oppArm.perp, wLaneEnd + BIKE_PX + 2));
    const s1b = vAdd(wx1, vScale(oppArm.perp, wLaneEnd + BIKE_PX + 2));
    out.push(`<line x1="${s0b.x.toFixed(1)}" y1="${s0b.y.toFixed(1)}" x2="${s1b.x.toFixed(1)}" y2="${s1b.y.toFixed(1)}" stroke="#777" stroke-width="6" stroke-dasharray="2 4"/>`);
  }

  if (p.bus) {
    const bx = vAdd(wx0, vScale(vSub(wx1, wx0), 0.5));
    items.bus = { title: 'Bus stop inside the work zone', body: 'Temporary relocation needed. Contact the transit authority 3 days before work starts.', ref: 'General notes' };
    out.push(`<g class="it" data-k="bus"><rect x="${(bx.x - 22).toFixed(1)}" y="${(bx.y + wLaneEnd - LANE_PX).toFixed(1)}" width="44" height="12" fill="#fff" stroke="${INK}" stroke-dasharray="3 2"/></g>`);
  }

  // north arrow
  out.push(`<g transform="translate(1530 250)"><circle r="16" fill="none" stroke="${INK}"/><path d="M0 -14 L6 8 L0 3 L-6 8 Z" fill="${INK}"/><text y="-20" font-size="11" text-anchor="middle" font-weight="bold">N</text></g>`);

  // -------- dimension chain (along the closed/opposite main axis only) --------
  const dy = 800;
  out.push('<g stroke="#b9b9b9" stroke-width=".7" stroke-dasharray="3 3">');
  segKeys.forEach((s) => {
    const from = s.from(), to = s.to();
    out.push(`<line x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" x2="${from.x.toFixed(1)}" y2="${dy}"/>`);
    out.push(`<line x1="${to.x.toFixed(1)}" y1="${to.y.toFixed(1)}" x2="${to.x.toFixed(1)}" y2="${dy}"/>`);
  });
  out.push('</g>');
  segKeys.forEach((s) => {
    const from = s.from(), to = s.to();
    const mx = (from.x + to.x) / 2;
    const px0 = Math.min(from.x, to.x), px1 = Math.max(from.x, to.x);
    out.push(`<g class="dim" data-seg="${s.key}"><rect x="${px0.toFixed(1)}" y="${dy - 30}" width="${(px1 - px0).toFixed(1)}" height="50" fill="transparent"/>` +
      `<line x1="${(px0 + 1).toFixed(1)}" y1="${dy}" x2="${(px1 - 1).toFixed(1)}" y2="${dy}" stroke="${INK}" stroke-width="1" marker-start="url(#ar)" marker-end="url(#ar)"/>` +
      `<text x="${mx.toFixed(1)}" y="${dy - 17}" font-size="8" text-anchor="middle" fill="${GR}">${s.label}</text>` +
      `<text x="${mx.toFixed(1)}" y="${dy - 5}" font-size="11" text-anchor="middle" font-weight="bold" fill="${INK}">${fmt(s.ft)}'</text>` +
      `<text x="${mx.toFixed(1)}" y="${dy + 13}" font-size="7.5" text-anchor="middle" fill="${OR}">${s.ref === 'FIELD' ? 'FIELD' : 'T' + s.ref}</text></g>`);
  });
  out.push(`<text x="44" y="${dy + 30}" font-size="9" fill="${GR}">T.A.N.S.A.T. TOTAL TTC ZONE ${fmt(m.total)}' · DIMENSIONS COMPUTED FROM CA MUTCD 2026 TABLES 6B-1 TO 6B-4 · LEG ANGLES FROM TRACED GEOMETRY · DRAWING N.T.S.</text>`);

  // -------- bottom band: legend / notes / computed values / title block --------
  // Box heights (222, up from this engine's previous 140), legend row
  // spacing (40px, not 34), notes box copy, computed-values row spacing
  // (20px, not 12.5) and the title block's row set/placeholder codes all
  // now match laneClosureTcpEngine.ts's own bottom band line for line --
  // the viewBox itself grew (see BOTTOM_BAND_H below) to give the taller
  // boxes room without colliding with the dimension chain above them,
  // since this engine's radial leg layout can't reuse Lane Closure's own
  // fixed y-coordinates directly (a straight cross-section and a set of
  // legs radiating from a center don't share a coordinate system).
  const by = 860;
  out.push(`<line x1="20" y1="${by - 12}" x2="1580" y2="${by - 12}" stroke="${INK}" stroke-width="1.5"/>`);
  const legend: [string, string][] = [
    ['cone', '28" TRAFFIC CONE W/ REFLECTIVE SLEEVE'], ['b3', 'TYPE III BARRICADE W/ SIGN'], ['sign', 'PROPOSED SIGN AND POST'],
    ['ab', 'FLASHING ARROW BOARD'], ...(p.signal ? [['sig', 'SIGNALIZED INTERSECTION'] as [string, string]] : []),
    ['hatch', 'WORK ZONE LIMITS'], ['hatch2', 'SIDEWALK CLOSED'], ['sb', 'SPLICE BOX'], ['xw', 'CROSSWALK'],
  ];
  out.push(`<text x="40" y="${by + 8}" font-size="13" font-weight="bold">LEGEND:</text>`);
  legend.forEach((l, ix) => {
    const half = Math.ceil(legend.length / 2), col = ix < half ? 0 : 1, rI = ix < half ? ix : ix - half, lx = 48 + col * 270, ly = by + 30 + rI * 40;
    let s = '';
    if (l[0] === 'cone') s = `<circle cx="${lx}" cy="${ly}" r="3.6" fill="${OR}" stroke="${INK}"/>`;
    if (l[0] === 'b3') s = `<rect x="${lx - 3}" y="${ly - 10}" width="6" height="20" fill="#fff" stroke="${INK}"/>`;
    if (l[0] === 'sign') s = `<path d="M${lx} ${ly - 9} L${lx + 9} ${ly} L${lx} ${ly + 9} L${lx - 9} ${ly} Z" fill="${OR}" stroke="${INK}"/>`;
    if (l[0] === 'ab') s = `<rect x="${lx - 8}" y="${ly - 8}" width="16" height="16" fill="${INK}"/>`;
    if (l[0] === 'sig') s = `<circle cx="${lx}" cy="${ly}" r="9" fill="#fff" stroke="${INK}" stroke-width="1.4"/><text x="${lx}" y="${ly + 4}" font-size="11" text-anchor="middle" font-weight="bold">S</text>`;
    if (l[0] === 'hatch') s = `<rect x="${lx - 12}" y="${ly - 7}" width="24" height="14" fill="url(#hatch)" stroke="${INK}"/>`;
    if (l[0] === 'hatch2') s = `<rect x="${lx - 12}" y="${ly - 7}" width="24" height="14" fill="url(#hatch2)" stroke="#777"/>`;
    if (l[0] === 'sb') s = `<rect x="${lx - 5}" y="${ly - 5}" width="10" height="10" fill="#fff" stroke="#d81f1f" stroke-width="2"/>`;
    if (l[0] === 'xw') s = `<g fill="${INK}"><rect x="${lx - 12}" y="${ly - 7}" width="24" height="3"/><rect x="${lx - 12}" y="${ly - 1.5}" width="24" height="3"/><rect x="${lx - 12}" y="${ly + 4}" width="24" height="3"/></g>`;
    out.push(`${s}<text x="${lx + 24}" y="${ly + 3.5}" font-size="9.5">${l[1]}</text>`);
  });

  const nx = 580;
  out.push(`<rect x="${nx}" y="${by}" width="500" height="222" fill="none" stroke="${INK}"/>`);
  out.push(`<text x="${nx + 250}" y="${by + 18}" font-size="12" text-anchor="middle" font-weight="bold">GENERAL TRAFFIC CONTROL NOTES</text>`);
  const notes = [
    '1. TRAFFIC CONTROL SHALL CONFORM TO THE CURRENT CALIFORNIA MUTCD',
    '    AND STATE STANDARD PLANS.',
    '2. NO LANE CLOSURES BEFORE 9:00A OR AFTER 3:00P.',
    '3. GIVE AFFECTED RESIDENTS, BUSINESSES, AGENCIES AND SCHOOLS 72 HOURS',
    '    NOTICE. MAINTAIN DRIVEWAY ACCESS AT ALL TIMES.',
    '4. POST TEMPORARY NO PARKING SIGNS 48 HOURS BEFORE WORK.',
    '5. COVER OR REMOVE CONFLICTING SIGNS, STRIPING AND MARKINGS;',
    '    REPLACE WHEN WORK IS COMPLETE.',
  ];
  if (p.bus) notes.push('6. CONTACT TRANSIT AUTHORITY 3 DAYS BEFORE WORK TO RELOCATE BUS STOP.');
  if (p.signal) notes.push(`${p.bus ? '7' : '6'}. SIGNAL TRAFFIC DIRECTION BY A QUALIFIED FLAGGER / POLICE / CSO ONLY.`);
  notes.forEach((t, ix) => out.push(`<text x="${nx + 12}" y="${by + 40 + ix * 17}" font-size="10">${esc(t)}</text>`));
  out.push(`<text x="${nx + 12}" y="${by + 212}" font-size="9.5" fill="#c0392b" font-weight="bold">DRAFT · REQUIRES REVIEW BY A QUALIFIED ENGINEER (MUTCD §6P.01)</text>`);

  const cxb = 1095;
  out.push(`<rect x="${cxb}" y="${by}" width="215" height="222" fill="none" stroke="${INK}"/>`);
  out.push(`<text x="${cxb + 107}" y="${by + 18}" font-size="11" text-anchor="middle" font-weight="bold">COMPUTED TTC VALUES</text>`);
  const cv: [string, string][] = [
    ['SPEED (S)', `${m.S} MPH`], ['OFFSET (W)', `${p.offset}'`], ['L (T6B-4)', `${fmt(m.L)}'`], ['MERGING TAPER', `${fmt(m.taper)}'`],
    ['BUFFER (T6B-2)', `${fmt(m.buf)}'`], ['NEAR / X / FAR', `${m.nb} / ${m.XW} / ${m.far}`], ['A / B / C', `${m.adv.A}/${m.adv.B}/${m.adv.C}`], ['CONES', String(m.dev.cones)],
  ];
  cv.forEach((r, ix) => { const yy = by + 40 + ix * 20; out.push(`<text x="${cxb + 10}" y="${yy}" font-size="9.5">${esc(r[0])}</text><text x="${cxb + 205}" y="${yy}" font-size="10" text-anchor="end" font-weight="bold">${esc(r[1])}</text>`); });

  const tb = 1320, tw = 240;
  out.push(`<rect x="${tb}" y="${by}" width="${tw}" height="222" fill="none" stroke="${INK}"/>`);
  const tbr: [string, string][] = [
    ['CONST ARC', ''], ['GEO/CO', 'NE-46'], ['EXCH.', 'MARNCA11'], ['STANDARD', 'CA MUTCD 2026'],
    ['TYPE OF CONST.', 'TCP'], ['RO/EST. NO.', 'A05HGG2'], ['DWG.', p.dwg || '—'], ['SCALE', 'N.T.S.'],
  ];
  tbr.forEach((r, ix) => { const yy = by + 24 + ix * 25; out.push(`<text x="${tb + 10}" y="${yy}" font-size="9.5">${r[0]}</text><text x="${tb + tw - 10}" y="${yy}" font-size="11" text-anchor="end" font-weight="bold">${esc(r[1])}</text><line x1="${tb + 10}" y1="${yy + 6}" x2="${tb + tw - 10}" y2="${yy + 6}" stroke="#bbb" stroke-width=".6"/>`); });

  out.push('</svg>');

  // -------- live-traffic geometry (see IntersectionTrafficGeometry's own
  // docstring) -- built from the same arms[] ArmGeoms
  // and the same kw-scaled taper station numbers already used above for
  // the taper wedge and dimension chain, so cars line up with the drawing.
  //
  // `perp` is each arm's OWN +90-degree rotation of its own outward `dir`,
  // so for a normal (near-180-degree) leg pair fromArm.perp and toArm.perp
  // end up pointing in roughly OPPOSITE absolute directions -- applying the
  // same literal sideSign to both would put a car on physically opposite
  // curbs before and after the stop bar, i.e. a visible sideways jump right
  // at the middle of the intersection (confirmed by rendering a sample
  // sheet and inspecting it: the two arms' "-1" sides land on opposite
  // sides of the pavement). `at()` below picks the toArm sign that keeps
  // the SAME physical side (a dot-product test against fromArm.perp), so a
  // car crossing the stop bar continues in a straight, un-jumping line; for
  // an exactly-opposite leg pair (the common case) this makes the two
  // halves meet exactly, and only a real, non-exactly-opposite traced pair
  // gets the small residual offset a skewed intersection would actually
  // have.
  const laneCenterOffset = (i: number) => MEDIAN_PX / 2 + (i + 0.5) * LANE_PX;
  const mkMovement = (
    fromArm: ArmGeom,
    toArm: ArmGeom,
    isMain: boolean,
    fromSign: 1 | -1,
    taperInfo: { farVpos: number; nearVpos: number } | null,
  ): IntersectionArmTraffic => {
    const lanes = Math.max(1, Math.min(fromArm.leg.lanes, toArm.leg.lanes));
    const toSign: 1 | -1 = vDot(fromArm.perp, toArm.perp) >= 0 ? fromSign : ((-fromSign) as 1 | -1);
    const at = (vpos: number, lane: number) => {
      const li = Math.max(0, Math.min(lanes - 1, Math.round(lane)));
      if (vpos >= 0) {
        let off = fromSign * laneCenterOffset(li);
        if (taperInfo && li === lanes - 1) {
          const { farVpos, nearVpos } = taperInfo;
          const fullOff = fromSign * laneCenterOffset(li);
          const mergedOff = fromSign * laneCenterOffset(Math.max(0, lanes - 2));
          if (vpos >= farVpos) off = fullOff;
          else if (vpos <= nearVpos) off = mergedOff;
          else { const t = (farVpos - vpos) / (farVpos - nearVpos); off = fullOff + (mergedOff - fullOff) * t; }
        }
        const pt = vAdd(center, vAdd(vScale(fromArm.dir, vpos), vScale(fromArm.perp, off)));
        const headingDeg = (Math.atan2(-fromArm.dir.y, -fromArm.dir.x) * 180) / Math.PI;
        return { x: pt.x, y: pt.y, headingDeg };
      }
      // Already past the stop bar/center: a car that was merging on the
      // outermost lane finished merging before it got here (nearVpos is
      // always > 0), so it continues in the merged (lanes-2) lane for the
      // rest of the trip; every other lane just keeps its own index.
      const effLi = taperInfo && li === lanes - 1 ? Math.max(0, lanes - 2) : li;
      const off = toSign * laneCenterOffset(effLi);
      const pt = vAdd(center, vAdd(vScale(toArm.dir, -vpos), vScale(toArm.perp, off)));
      const headingDeg = (Math.atan2(toArm.dir.y, toArm.dir.x) * 180) / Math.PI;
      return { x: pt.x, y: pt.y, headingDeg };
    };
    return {
      fromId: fromArm.leg.id, toId: toArm.leg.id, isMain, lanes,
      spawnDist: fromArm.stub, exitDist: toArm.stub, stopDist: fromArm.stopDist,
      at, taper: taperInfo,
    };
  };

  // Both directions of a through-movement pair are passed the SAME fromSign
  // (not opposite signs -- that was the bug: for a near-opposite arm pair,
  // toSign's own dot-product flip already puts each movement's OWN
  // before/after-crossing offset on one consistent side, so handing the
  // reverse movement the opposite fromSign made it land back on the SAME
  // absolute side as the forward movement on both arms, instead of the
  // opposite side -- i.e. both directions of traffic drawn in the same
  // lane, overlapping, on both legs. Passing the reverse movement the SAME
  // fromSign makes its own toSign flip land it on the opposite absolute
  // side from the forward movement on both arms, which is what real 2-way
  // traffic needs: confirmed algebraically (and by re-rendering and
  // inspecting a sample) that when armA.perp and armB.perp are
  // near-antiparallel (any reasonably-paired near-opposite legs, which is
  // all the pairing above ever produces), passing both movements identical
  // fromSign is exactly what keeps them apart.
  const dirs: Record<string, IntersectionArmTraffic> = {};
  dirs[`${closedArm.leg.id}__${oppArm.leg.id}`] = mkMovement(
    closedArm, oppArm, true, -1,
    { farVpos: closedArm.stopDist + (m.nb + m.L) * kw, nearVpos: closedArm.stopDist + m.nb * kw },
  );
  dirs[`${oppArm.leg.id}__${closedArm.leg.id}`] = mkMovement(oppArm, closedArm, true, -1, null);

  // m.otherLegs (any count, including 0) don't have a single fixed "cross1/
  // cross2" pair to draw traffic on anymore -- greedily pair up whichever
  // two remaining legs are closest to true-opposite each other (repeat
  // until fewer than 2 are left). This degrades gracefully: 0 otherLegs ->
  // no cross traffic at all (a plain 2-leg road); 1 (a T's third leg) is
  // left with pavement/signs but no simulated movement, since it has no
  // sane "straight across" partner; 2 (a classic 4-leg cross) reproduces
  // the exact cross1/cross2 pairing this engine always drew; 3+ pairs off
  // the best-matching legs first and leaves at most one leg unpaired.
  const remaining = [...m.otherLegs];
  while (remaining.length >= 2) {
    let bestI = 0, bestJ = 1, bestDiff = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) {
        const d = angDiff(remaining[i].bearingDeg, (remaining[j].bearingDeg + 180) % 360);
        if (d < bestDiff) { bestDiff = d; bestI = i; bestJ = j; }
      }
    }
    const legA = remaining[bestI], legB = remaining[bestJ];
    const armA = arms[legA.id], armB = arms[legB.id];
    // Same-fromSign fix as the main pair above -- see that block's comment.
    dirs[`${legA.id}__${legB.id}`] = mkMovement(armA, armB, false, -1, null);
    dirs[`${legB.id}__${legA.id}`] = mkMovement(armB, armA, false, -1, null);
    // Remove the higher index first so the lower index stays valid.
    remaining.splice(Math.max(bestI, bestJ), 1);
    remaining.splice(Math.min(bestI, bestJ), 1);
  }

  const geo: IntersectionTrafficGeometry = {
    center: { x: center.x, y: center.y },
    dirs,
    cycleSec: 30,
  };

  return { svg: out.join(''), items, geo };
}
