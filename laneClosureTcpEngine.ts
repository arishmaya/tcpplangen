/**
 * laneClosureTcpEngine.ts
 *
 * Ported from "Marina TCP Studio", a standalone HTML prototype the user
 * built to explore a STRAIGHT-ROAD lane-closure Traffic Control Plan (a
 * taper/buffer/work-space layout along one road) as opposed to this app's
 * existing intersection-shaped TCP flow (generate_intersection_tcp_png.py /
 * mutcd.ts / IntersectionDiagramPreview.tsx). Per the decision made when
 * this was integrated: lane-closure TCP is a NEW plan type alongside the
 * existing intersection one (not a replacement), and this file's tables/
 * formulas are the source of truth for that new type -- ported byte-for-
 * byte from the prototype's own "TTC" engine rather than reconciled against
 * mutcd.ts's numbers, which cover a different geometry (advance-sign A/B/C
 * spacing, buffer/SSD, and taper length here are all keyed by the same CA
 * MUTCD 2026 tables the prototype's own City of Marina TCP set prints, but
 * are NOT guaranteed to match mutcd.ts's intersection-oriented tables
 * field-for-field).
 *
 * Kept framework-free (pure functions + string-built SVG, no React/DOM)
 * so it can be unit-tested and reused headlessly -- the companion
 * LaneClosureTCPStudio.tsx component is the only thing that touches the
 * DOM, mirroring how the prototype's own compute()/render() were kept
 * separate from its UI wiring.
 */

export type ClosureStrategy = 'lane' | 'center' | 'shoulder' | 'flagger';
export type RoadType = 'urban' | 'rural';
export type ComplianceLevel = 'ok' | 'warn' | 'bad' | 'info';

/** As-drawn dimensions from a real TCP sheet, only meaningful when checking
 * a plan against an already-issued drawing (the 5 built-in presets below
 * carry these from the real City of Marina set); omitted entirely for a
 * from-scratch plan, since there's no sheet yet to check against. */
export interface AsDrawnDimensions {
  taper?: number;
  buffer?: number;
  spacing?: number;
}

export type Alignment = 'straight' | 'curve';

export interface LaneClosureParams {
  wa: number;
  /** Cosmetic label shown on the work-area preset button (e.g. "4-LEG",
   * "CURVE") when this preset isn't just a plain numbered work area --
   * purely UI, never read by the compute/render engine. */
  tag?: string;
  addr: string;
  xing: string;
  access: string;
  road: string;
  speed: number;
  strategy: ClosureStrategy;
  lanes: number;
  roadType: RoadType;
  /** Offset width W, ft -- how far the taper has to shift traffic over. */
  offset: number;
  /** Work space length, ft -- the one dimension this engine can't compute,
   * since it depends on the actual job (how long a trench, how big a
   * crew footprint) rather than a MUTCD formula. */
  work: number;
  sidewalk: boolean;
  bus: boolean;
  signal: boolean;
  /** Work hours, "HH:MM" 24-hour -- compared as plain strings (works
   * correctly for zero-padded HH:MM, same trick the prototype used). */
  hs: string;
  he: string;
  /** Splice/access boxes inside the work space, labeled on the sheet. */
  boxes: string[];
  /** Sheet number within the larger set, e.g. "7 OF 14" -- cosmetic
   * (title block + compliance-check labels only). */
  dwg: string;
  drawing?: AsDrawnDimensions;
  /** Cross-street name/posted speed -- only meaningful on a `tag: '4-LEG'`
   * preset (see LANE_CLOSURE_PRESETS below): the work-area list reads
   * these to pre-fill LaneClosureIntersectionPanel's synthetic-legs form
   * instead of routing this preset through the straight/curve renderer.
   * Never read by computeLaneClosurePlan/renderLaneClosurePlanSVG. */
  xroad?: string;
  xspeed?: number;
  /** 'straight' (default when omitted) or 'curve' -- a horizontal-curve
   * work space, same MUTCD taper/buffer/sign math as straight but drawn
   * along a tangent-arc-tangent alignment instead of a straight strip.
   * See renderLaneClosureCurveSVG(). */
  align?: Alignment;
  /** Total curve deflection angle, degrees, only meaningful when
   * align === 'curve'. Defaults to 45 when omitted. */
  curveDeg?: number;
}

export interface AdvanceSpacing {
  A: number;
  B: number;
  C: number;
  row: string;
}

export interface PlanSegment {
  key: string;
  label: string;
  ft: number;
  ref: string;
  start: number;
  end: number;
  px0?: number;
  px1?: number;
  /** Station-space (not pixel-space) start/end along the curved
   * alignment, and the segment's plotted mid-height -- only set by
   * renderLaneClosureCurveSVG(), unused on the straight path. */
  s0?: number;
  s1?: number;
  cy?: number;
}

export interface PlanSign {
  code: string;
  lines: string[];
  pos: number;
  side: 'N' | 'S';
  shape: 'diamond' | 'rect' | 'flag';
  desc: string;
  ref: string;
}

export interface ConeMark {
  ft: number;
  /** 0..1 across the roadway from the closed edge (0) to the open edge
   * (1) -- how far the cone has shifted along the taper at this point. */
  f: number;
}

export interface DeviceSummary {
  taperSp: number;
  tanSp: number;
  cones: number;
  typeIII: number;
  arrow: number;
  flaggers: number;
  typeII: number;
  r99: number;
}

export interface ComplianceCheck {
  lvl: ComplianceLevel;
  t: string;
  d: string;
}

/** Horizontal-curve geometry for a curve-aligned plan (LaneClosureParams
 * with align:'curve'). `pc`/`pt` are the curve's start/end in the plan's
 * own real-feet station space (same axis as PlanSegment.start/end);
 * `used`/`sPC`/`sPT` are filled in by renderLaneClosureCurveSVG() once it
 * solves the auto-fit layout (the final deflection actually drawn, which
 * can differ slightly from `deg` if the curve had to be relaxed to fit
 * the sheet, and the PC/PT stations in the render's own arc-length
 * station space). */
export interface CurveInfo {
  deg: number;
  pc: number;
  pt: number;
  gap: number;
  used?: number;
  sPC?: number;
  sPT?: number;
}

export interface LaneClosurePlan {
  p: LaneClosureParams;
  st: ClosureStrategy;
  stName: string;
  S: number;
  W: number;
  L: number;
  Lf: string;
  adv: AdvanceSpacing;
  buf: number;
  taper: number;
  ttype: string;
  tref: string;
  ds: number;
  dsref: string;
  seg: PlanSegment[];
  total: number;
  signs: PlanSign[];
  cones: ConeMark[];
  dev: DeviceSummary;
  checks: ComplianceCheck[];
  sg: (key: string) => PlanSegment | undefined;
  /** Present only when p.align === 'curve'. */
  curve?: CurveInfo;
}

export interface PlanItem {
  title: string;
  body: string;
  ref: string;
}

/** The geometry a live-traffic overlay needs to place/move cars against the
 * rendered sheet -- pixel positions (not real feet) for the taper/buffer/
 * work-space boundaries and each lane's vertical center. Recomputed by
 * renderLaneClosurePlanSVG on every render since the sheet's own layout
 * (segment widths) changes with it. */
export interface TrafficGeometry {
  XL: number;
  XR: number;
  st: ClosureStrategy;
  tS: number;
  tE: number;
  wS: number;
  wE: number;
  dsE: number;
  t2S: number;
  eb: number[];
  wb: number[];
  closedIdx: number;
  flagE: number;
  flagW: number;
  zoneX0: number;
  zoneX1: number;
  shiftY?: number;
  /** Curve-mode only: projects (station, lane-offset-n) to the actual
   * on-sheet [x,y] the live-traffic layer should draw a car at, and
   * returns the centerline heading (degrees, eastbound convention) at a
   * station -- same `P`/`H` closures the curve renderer itself draws
   * every element through. Absent on the straight-road sheet, where a
   * car is placed directly at (station, offset) with no projection. */
  map?: (s: number, n: number) => [number, number];
  hdeg?: (s: number) => number;
}

export interface LaneClosureRenderResult {
  svg: string;
  geo: TrafficGeometry;
  items: Record<string, PlanItem>;
}

// CA MUTCD 2026 tables, as printed on the City of Marina TCP set (sheet 1
// of 14) -- see this file's own docstring for why these are kept separate
// from mutcd.ts's intersection-oriented tables rather than merged into them.
export const BUFFER_TABLE: Record<number, number> = {
  20: 115, 25: 155, 30: 200, 35: 250, 40: 305, 45: 360, 50: 425, 55: 495, 60: 570, 65: 645, 70: 730, 75: 820,
};

export const STRATEGY_LABELS: Record<ClosureStrategy, string> = {
  lane: 'Right lane closure',
  center: 'Left lane closure',
  shoulder: 'Shoulder / bike lane work',
  flagger: 'One-lane, two-way flagger control',
};

/** Five real work areas from the City of Marina "Reservation Rd. / Del
 * Monte Blvd." TCP set (sheet 1 of 14) the prototype shipped as sample/
 * starter data -- same role the app's Wake Forest, NC drawings play
 * elsewhere as test data, not a claim that these are the user's own
 * projects. Each preset's `drawing` field is that real sheet's own as-
 * drawn dimensions, which is what lets the compliance panel show "drawn
 * vs. minimum" checks instead of just "minimum required." */
export const LANE_CLOSURE_PRESETS: LaneClosureParams[] = [
  { wa: 1, addr: '3158 DEL MONTE BLVD.', xing: 'DEL MONTE BLVD. & RESERVATION RD.', access: 'SB #3144, SB #3156 & SB #3156A ACCESS', road: 'DEL MONTE BLVD.', speed: 40, strategy: 'lane', lanes: 2, roadType: 'urban', offset: 12, work: 260, sidewalk: true, bus: true, signal: true, hs: '09:00', he: '15:00', boxes: ['SB #3144', 'SB #3156', 'SB #3156A'], dwg: '2 OF 14', drawing: { buffer: 520, spacing: 250 } },
  { wa: 2, addr: '212 RESERVATION RD.', xing: 'RESERVATION RD. & DEL MONTE BLVD.', access: 'SB #214 ACCESS', road: 'RESERVATION RD.', speed: 35, strategy: 'shoulder', lanes: 2, roadType: 'urban', offset: 12, work: 40, sidewalk: true, bus: false, signal: true, hs: '09:00', he: '15:00', boxes: ['SB #214'], dwg: '4 OF 14', drawing: { taper: 85, spacing: 200 } },
  { wa: 3, addr: '218 RESERVATION RD.', xing: 'RESERVATION RD. & VISTA DEL CAMINO CIR.', access: 'SB #216 ACCESS', road: 'RESERVATION RD.', speed: 35, strategy: 'shoulder', lanes: 2, roadType: 'urban', offset: 12, work: 40, sidewalk: false, bus: false, signal: false, hs: '09:00', he: '15:00', boxes: ['SB #216'], dwg: '5 OF 14', drawing: { taper: 85, spacing: 200 } },
  { wa: 4, addr: '226 RESERVATION RD.', xing: 'RESERVATION RD. & VISTA DEL CAMINO CIR.', access: 'SB #222 & SB #228 ACCESS', road: 'RESERVATION RD.', speed: 35, strategy: 'shoulder', lanes: 2, roadType: 'urban', offset: 12, work: 120, sidewalk: true, bus: false, signal: false, hs: '09:00', he: '15:00', boxes: ['SB #222', 'SB #228'], dwg: '6 OF 14', drawing: { spacing: 200 } },
  { wa: 5, addr: '226 RESERVATION RD.', xing: 'RESERVATION RD. & VISTA DEL CAMINO CIR.', access: 'CURB LANE CLOSURE', road: 'RESERVATION RD.', speed: 35, strategy: 'lane', lanes: 2, roadType: 'urban', offset: 12, work: 150, sidewalk: true, bus: true, signal: false, hs: '09:00', he: '15:00', boxes: ['SB #228'], dwg: '7 OF 14', drawing: { taper: 245, buffer: 295, spacing: 200 } },
  { wa: 5, tag: 'CURVE', align: 'curve', curveDeg: 45, addr: '226 RESERVATION RD.', xing: 'RESERVATION RD. & VISTA DEL CAMINO CIR.', access: 'CURB LANE CLOSURE · HORIZONTAL CURVE (SAMPLE)', road: 'RESERVATION RD.', speed: 35, strategy: 'lane', lanes: 2, roadType: 'urban', offset: 12, work: 180, sidewalk: true, bus: false, signal: false, hs: '09:00', he: '15:00', boxes: ['SB #228'], dwg: '7A OF 14', drawing: { spacing: 200 } },
  // WA1's companion sheet from the prototype -- the same site as WA1 above
  // (dwg '2 OF 14'), but the "2A" sheet showing the 4-leg signalized
  // intersection the work area sits on rather than the plain lane-closure
  // strip. `tag: '4-LEG'` routes this preset to LaneClosureIntersectionPanel
  // instead of the straight/curve renderer (see LaneClosureTCPStudio.tsx's
  // work-area list) -- strategy/roadType are unused there but still
  // required by this type, so they carry placeholder values.
  { wa: 1, tag: '4-LEG', addr: '3158 DEL MONTE BLVD.', xing: 'DEL MONTE BLVD. & RESERVATION RD.', access: 'SB #3156A ACCESS · 4-LEG SIGNALIZED INTERSECTION', road: 'DEL MONTE BLVD.', xroad: 'RESERVATION RD.', speed: 40, xspeed: 35, strategy: 'lane', lanes: 2, roadType: 'urban', offset: 12, work: 180, sidewalk: true, bus: false, signal: true, hs: '09:00', he: '15:00', boxes: ['SB #3156A'], dwg: '2A OF 14' },
];

/** Table 6B-1 advance-sign spacing (A = B = C, ft): urban tiers by posted
 * speed, or a flat 500 ft on rural roads. */
export function advanceSignSpacing(S: number, rt: RoadType): AdvanceSpacing {
  if (rt === 'rural') return { A: 500, B: 500, C: 500, row: 'Rural' };
  const d = S <= 25 ? 100 : S <= 30 ? 150 : S <= 35 ? 200 : S <= 40 ? 250 : S <= 45 ? 300 : 350;
  const row = S <= 25 ? 'Urban, 25 mph or less' : S >= 50 ? 'Urban, 50 mph or more' : `Urban, ${S} mph`;
  return { A: d, B: d, C: d, row };
}

/** Table 6B-4 taper length: L = WS²/60 at or below 40 mph, L = WS above it. */
export function taperLength(W: number, S: number): number {
  return Math.ceil(S <= 40 ? (W * S * S) / 60 : W * S);
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Computes every dimension, sign, device and compliance check for a lane-
 * closure plan from its parameters -- the MUTCD math itself, with no SVG
 * or DOM involved. A one-lane-each-way road offered "right lane" or "left
 * lane" closure has no lane left to merge traffic into, so the engine
 * silently falls back to a one-lane, two-way flagger operation and records
 * that switch as an informational compliance note (never a silent,
 * unexplained substitution).
 */
export function computeLaneClosurePlan(p: LaneClosureParams): LaneClosurePlan {
  const notes: string[] = [];
  let st: ClosureStrategy = p.strategy;
  if ((st === 'lane' || st === 'center') && p.lanes < 2) {
    st = 'flagger';
    notes.push('One lane each way leaves no lane to merge into, so the engine switched to a one-lane, two-way flagger operation.');
  }

  const S = p.speed, W = p.offset, L = taperLength(W, S), a = advanceSignSpacing(S, p.roadType), buf = BUFFER_TABLE[S];
  const Lf = S <= 40 ? `L = WS²/60 = ${W} × ${S}² / 60` : `L = WS = ${W} × ${S}`;

  let taper: number, ttype: string, tref: string, ds: number, dsref: string;
  if (st === 'lane' || st === 'center') {
    taper = L; ttype = 'Merging taper'; tref = 'Table 6B-3: at least L'; ds = 100; dsref = 'Table 6B-3: 50 ft min, 100 ft max';
  } else if (st === 'shoulder') {
    taper = Math.ceil(L / 3); ttype = 'Shoulder taper'; tref = 'Table 6B-3: at least 0.33 L'; ds = 50; dsref = 'Table 6B-3: 50 ft min, 100 ft max';
  } else {
    taper = S >= 30 ? 100 : 50; ttype = 'One-lane, two-way taper'; tref = 'Table 6B-3: 50 ft min, 100 ft max'; ds = taper; dsref = tref;
  }

  const seg: PlanSegment[] = [];
  const add = (key: string, label: string, ft: number, ref: string) => { seg.push({ key, label, ft, ref, start: 0, end: 0 }); };
  add('C', 'C', a.C, '6B-1'); add('B', 'B', a.B, '6B-1'); add('A', 'A', a.A, '6B-1');
  if (st === 'flagger') {
    add('taper', 'TAPER', taper, '6B-3'); add('buffer', 'BUFFER', buf, '6B-2'); add('work', 'WORK', p.work, 'FIELD');
    add('buffer2', 'BUFFER', buf, '6B-2'); add('taper2', 'TAPER', taper, '6B-3');
    add('A2', 'A', a.A, '6B-1'); add('B2', 'B', a.B, '6B-1'); add('C2', 'C', a.C, '6B-1');
  } else {
    add('taper', 'TAPER', taper, '6B-3'); add('buffer', 'BUFFER', buf, '6B-2'); add('work', 'WORK', p.work, 'FIELD');
    add('ds', 'DOWNSTR.', ds, '6B-3'); add('end', 'TO G20-2', 100, 'FIELD');
  }
  let acc = 0;
  seg.forEach((s) => { s.start = acc; acc += s.ft; s.end = acc; });
  const sg = (k: string) => seg.find((s) => s.key === k);

  const signs: PlanSign[] = [];
  const sign = (code: string, lines: string[], pos: number, side: 'N' | 'S', shape: PlanSign['shape'], desc: string, ref?: string) => {
    signs.push({ code, lines, pos, side, shape, desc, ref: ref || 'Table 6B-1' });
  };
  const tS = sg('taper')!.start;
  if (st === 'lane' || st === 'center') {
    const LR = st === 'lane' ? 'RIGHT' : 'LEFT';
    sign('W20-1', ['ROAD', 'WORK', 'AHEAD'], 0, 'S', 'diamond', `Third sign, farthest upstream. ${a.A + a.B + a.C} ft ahead of the merging taper.`);
    sign(st === 'lane' ? 'W20-5R' : 'W20-5L', [LR, 'LANE CLOSED', 'AHEAD'], a.C, 'S', 'diamond', `Second sign. B = ${a.B} ft from the first sign.`);
    sign('C30(CA)', ['LANE', 'CLOSED'], a.C + a.B, 'S', 'diamond', `First sign, closest to the transition. A = ${a.A} ft ahead of the taper.`);
  } else if (st === 'shoulder') {
    sign('W20-1', ['ROAD', 'WORK', 'AHEAD'], 0, 'S', 'diamond', `Third sign, farthest upstream. ${a.A + a.B + a.C} ft ahead of the shoulder taper.`);
    sign('W21-5', ['SHOULDER', 'WORK'], a.C, 'S', 'diamond', `Second sign. B = ${a.B} ft from the first sign.`);
    sign('C30A(CA)', ['SHOULDER', 'CLOSED'], a.C + a.B, 'S', 'diamond', `First sign. A = ${a.A} ft ahead of the shoulder taper.`);
  } else {
    sign('W20-1', ['ROAD', 'WORK', 'AHEAD'], 0, 'S', 'diamond', 'Eastbound, farthest upstream.');
    sign('W20-4', ['ONE LANE', 'ROAD', 'AHEAD'], a.C, 'S', 'diamond', `Eastbound second sign. B = ${a.B} ft.`);
    sign('W20-7', ['FLAGGER'], a.C + a.B, 'S', 'flag', `Eastbound first sign. A = ${a.A} ft ahead of the flagger station.`);
    const e = sg('taper2')!.end;
    sign('W20-7', ['FLAGGER'], e + a.A, 'N', 'flag', `Westbound first sign. A = ${a.A} ft ahead of the flagger station.`);
    sign('W20-4', ['ONE LANE', 'ROAD', 'AHEAD'], e + a.A + a.B, 'N', 'diamond', 'Westbound second sign.');
    sign('W20-1', ['ROAD', 'WORK', 'AHEAD'], e + a.A + a.B + a.C, 'N', 'diamond', 'Westbound, farthest upstream.');
  }
  if (st !== 'flagger') sign('G20-2', ['END', 'ROAD WORK'], acc, 'S', 'rect', 'Placed past the downstream taper where normal traffic resumes.', 'Part 6 sign guidance');

  // Channelizing devices: 1.0 x S spacing in tapers, 2.0 x S on tangents.
  const taperSp = S, tanSp = 2 * S;
  const cones: ConeMark[] = [];
  const tT = sg('taper')!, tE = tT.end;
  const nT = Math.max(2, Math.round(taper / taperSp) + 1);
  for (let i = 0; i < nT; i++) { const f = i / (nT - 1); cones.push({ ft: tT.start + f * taper, f }); }
  const tanEnd = st === 'flagger' ? sg('buffer2')!.end : sg('work')!.end;
  const nG = Math.max(1, Math.round((tanEnd - tE) / tanSp));
  for (let i = 1; i <= nG; i++) cones.push({ ft: tE + ((tanEnd - tE) * i) / nG, f: 1 });
  if (st === 'flagger') {
    const t2 = sg('taper2')!;
    for (let i = 1; i < nT; i++) { const f = i / (nT - 1); cones.push({ ft: t2.start + f * taper, f: 1 - f }); }
  } else {
    const d = sg('ds')!, nD = Math.max(2, Math.round(d.ft / 20) + 1);
    for (let i = 1; i < nD; i++) { const f = i / (nD - 1); cones.push({ ft: d.start + f * d.ft, f: 1 - f }); }
  }

  const dev: DeviceSummary = {
    taperSp, tanSp, cones: cones.length,
    typeIII: st === 'shoulder' ? 1 : 2,
    arrow: st === 'lane' || st === 'center' ? 1 : 0,
    flaggers: st === 'flagger' ? 2 : 0,
    typeII: p.sidewalk ? 2 : 0,
    r99: p.sidewalk ? 2 : 0,
  };

  const checks: ComplianceCheck[] = [];
  if (st !== 'shoulder') {
    const okH = p.hs >= '09:00' && p.he <= '15:00' && p.hs < p.he;
    checks.push({
      lvl: okH ? 'ok' : 'bad',
      t: 'Lane closure hours',
      d: okH
        ? `${p.hs} to ${p.he} is inside the City window of 9:00 AM to 3:00 PM.`
        : `${p.hs} to ${p.he} falls outside the City window. No lane closures before 9:00 AM or after 3:00 PM.`,
    });
  } else {
    checks.push({ lvl: 'ok', t: 'Closure hours', d: 'Shoulder work only. The 9:00 AM to 3:00 PM limit applies to lane closures.' });
  }
  const dr = p.drawing || {};
  if (dr.taper != null) { const tOk = dr.taper >= taper; checks.push({ lvl: tOk ? 'ok' : 'bad', t: `Taper on sheet ${p.dwg || ''}`, d: `Drawn ${dr.taper} ft vs ${taper} ft minimum ${tOk ? '(meets).' : '(too short).'}` }); }
  if (dr.buffer != null) { const bOk = dr.buffer >= buf; checks.push({ lvl: bOk ? 'ok' : 'bad', t: `Buffer on sheet ${p.dwg || ''}`, d: `Drawn ${dr.buffer} ft vs ${buf} ft minimum ${bOk ? '(meets).' : '(too short).'}` }); }
  if (dr.spacing != null) { const sOk = dr.spacing >= a.A; checks.push({ lvl: sOk ? 'ok' : 'warn', t: `Sign spacing on sheet ${p.dwg || ''}`, d: `Drawn ${dr.spacing} ft vs ${a.A} ft recommended ${sOk ? '(meets).' : '(shorter than Table 6B-1).'}` }); }
  if (p.bus) checks.push({ lvl: 'warn', t: 'Bus stop in work zone', d: 'Contact the transit authority 3 days before work to relocate the stop.' });
  if (p.sidewalk) checks.push({ lvl: 'info', t: 'Pedestrian route', d: 'Sidewalk closed. R9-9 signs and Type II barricades at both ends, with a detour to the opposite sidewalk.' });
  if (p.signal) checks.push({ lvl: 'warn', t: 'Signalized intersection', d: 'Traffic direction through the signal by City of Marina police or a CSO only. Arrange signal overrides 14 days ahead.' });
  if (S >= 45) checks.push({ lvl: 'info', t: 'High-speed formula', d: 'At 45 mph and above the taper uses L = WS.' });

  let curve: CurveInfo | undefined;
  if (p.align === 'curve') {
    const wk = sg('work')!;
    const pcF = Math.max(0, wk.start - 150), ptF = Math.min(acc, wk.end + 60);
    curve = { deg: p.curveDeg || 45, pc: pcF, pt: ptF, gap: Math.round(pcF - sg('taper')!.end) };
    if (curve.gap >= 0) {
      checks.push({ lvl: 'ok', t: 'Taper on the approach tangent', d: `Taper ends ${fmt(curve.gap)} ft before the curve (PC), so drivers see the merge before entering the curve.` });
    } else {
      checks.push({ lvl: 'warn', t: 'Taper runs into the curve', d: `Taper ends ${fmt(-curve.gap)} ft past the PC. Move the taper upstream onto the tangent or lengthen the buffer so the transition stays visible.` });
    }
    checks.push({ lvl: 'info', t: 'Work space on a horizontal curve', d: 'Confirm sight distance to the taper in the field and extend advance signing if the curve hides the approach.' });
  }
  notes.forEach((n) => checks.unshift({ lvl: 'info', t: 'Strategy changed', d: n }));

  return { p, st, stName: STRATEGY_LABELS[st], S, W, L, Lf, adv: a, buf, taper, ttype, tref, ds, dsref, seg, total: acc, signs, cones, dev, checks, sg, curve };
}

interface CrossSectionRow {
  t: 'sidewalk' | 'bike' | 'lane' | 'median';
  y0: number;
  y1: number;
  h: number;
  side?: 'N' | 'S';
  dir?: 'E' | 'W';
  idx?: number;
}

/**
 * Renders a computed plan to an SVG plan-sheet string -- the same 1600x1035
 * engineering-drawing layout (title block, cross-section, tapers/buffer/
 * work-space bands, signs, cones, barricades, dimension chain, legend,
 * general notes, computed-values box, north arrow) as the source
 * prototype, plus a `geo` object describing pixel positions for the
 * companion live-traffic overlay and an `items` map keyed by each
 * inspectable element's `data-k` attribute (drives the click-to-inspect
 * popup and the hover/select linking with the calc panel).
 *
 * Deliberately still string-built SVG rather than JSX: every position here
 * is derived from the plan's own segment layout (feet -> pixels via the
 * X() closure below), so rebuilding this as declarative React SVG would
 * mean re-deriving the same positional math through a different API for
 * no behavioral gain -- and risks silently drifting from the source
 * prototype's proven layout. `esc()` escapes every piece of user-entered
 * text (road name, address, crossing, access notes) before it's
 * interpolated in, since the result is injected via innerHTML on the
 * consuming side, not parsed as JSX.
 */
export function renderLaneClosurePlanSVG(m: LaneClosurePlan): LaneClosureRenderResult {
  if (m.curve) return renderLaneClosureCurveSVG(m);
  const p = m.p, st = m.st, out: string[] = [], items: Record<string, PlanItem> = {};
  const VW = 1600, VH = 1035, F = 'Arial, Helvetica, sans-serif';
  const INK = '#1b1b1b', OR = '#f7931e', GR = '#6b6b6b';
  const x0 = 70, x1 = 1530, n = m.seg.length, base = n > 8 ? 30 : 42;
  const k = (x1 - x0 - base * n) / m.total;
  let cx = x0;
  m.seg.forEach((s) => { s.px0 = cx; cx += base + k * s.ft; s.px1 = cx; });
  const X = (ft: number): number => {
    for (const s of m.seg) { if (ft <= s.end + 1e-6) return s.px0! + (s.ft ? (ft - s.start) / s.ft : 0) * (s.px1! - s.px0!); }
    return x1;
  };

  // cross-section
  const nl = st === 'flagger' ? 1 : p.lanes, divided = st !== 'flagger' && p.lanes >= 2;
  const LH = 30;
  let y = 270;
  const rows: CrossSectionRow[] = [];
  const push = (t: CrossSectionRow['t'], h: number, ex?: Partial<CrossSectionRow>) => { rows.push({ t, y0: y, y1: y + h, h, ...ex }); y += h; };
  push('sidewalk', 24, { side: 'N' }); push('bike', 18, { side: 'N' });
  for (let i = nl - 1; i >= 0; i--) push('lane', LH, { dir: 'W', idx: i });
  if (divided) push('median', 18);
  for (let i = 0; i < nl; i++) push('lane', LH, { dir: 'E', idx: i });
  push('bike', 18, { side: 'S' }); push('sidewalk', 24, { side: 'S' });
  const rt = 270, rb = y;
  const lane = (d: 'E' | 'W', ix: number) => rows.find((r) => r.t === 'lane' && r.dir === d && r.idx === ix)!;
  const row = (t: CrossSectionRow['t'], side: 'N' | 'S') => rows.find((r) => r.t === t && r.side === side)!;
  const bikeS = row('bike', 'S'), swS = row('sidewalk', 'S'), swN = row('sidewalk', 'N'), bikeN = row('bike', 'N');
  let closed: CrossSectionRow, openRow: CrossSectionRow, eC: number, eO: number;
  if (st === 'lane') { closed = lane('E', nl - 1); openRow = lane('E', nl - 2); eC = closed.y1; eO = closed.y0; }
  else if (st === 'center') { closed = lane('E', 0); openRow = lane('E', 1); eC = closed.y0; eO = closed.y1; }
  else if (st === 'shoulder') { closed = bikeS; openRow = lane('E', nl - 1); eC = closed.y1; eO = closed.y0; }
  else { closed = lane('E', 0); openRow = lane('W', 0); eC = closed.y1; eO = closed.y0; }
  void openRow; // kept for parity with the source layout math; not read further, same as the prototype

  const sT = m.sg('taper')!, sB = m.sg('buffer')!, sW = m.sg('work')!;
  const XL = 40, XR = 1560;

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" font-family="${F}">`);
  out.push(
    '<defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#ffffff"/><line x1="0" y1="0" x2="0" y2="7" stroke="#444" stroke-width="1.3"/></pattern>' +
    '<pattern id="hatch2" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="8" height="8" fill="#f1efe9"/><line x1="0" y1="0" x2="0" y2="8" stroke="#9a9a9a" stroke-width="1"/></pattern>' +
    `<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 L10 5 L0 9 z" fill="${INK}"/></marker></defs>`
  );
  out.push(`<rect width="${VW}" height="${VH}" fill="#ffffff"/>`);
  out.push(`<rect x="20" y="20" width="${VW - 40}" height="${VH - 40}" fill="none" stroke="${INK}" stroke-width="4"/>`);

  // header
  out.push(`<g fill="${INK}"><text x="44" y="64" font-size="26">${esc(p.addr)}</text><text x="44" y="94" font-size="21">${esc(p.xing)}</text><text x="44" y="122" font-size="19">${esc(p.access)}</text><text x="44" y="150" font-size="19">WORK AREA ${esc(String(p.wa))} OF 11</text></g>`);
  out.push(`<g stroke="${INK}" fill="none" stroke-width="1"><rect x="1430" y="30" width="130" height="46"/><line x1="1480" y1="30" x2="1480" y2="76"/><line x1="1430" y1="46" x2="1560" y2="46"/></g>`);
  out.push(`<g fill="${INK}" font-size="9"><text x="1446" y="42">ISSUE</text><text x="1508" y="42">DATE</text></g><g fill="${INK}" font-size="15"><text x="1450" y="68">0</text><text x="1490" y="68">8/26/26</text></g>`);
  out.push(`<text x="44" y="178" font-size="12" fill="${OR}" font-weight="bold">${esc(m.stName.toUpperCase())} · S = ${m.S} MPH · GENERATED DRAFT</text>`);

  // segment highlight bands
  m.seg.forEach((s) => { out.push(`<rect class="hl" data-seg="${s.key}" x="${s.px0!.toFixed(1)}" y="${rt - 4}" width="${(s.px1! - s.px0!).toFixed(1)}" height="${rb - rt + 8}" fill="transparent"/>`); });

  // road surfaces
  rows.forEach((r) => {
    const fill = r.t === 'sidewalk' ? '#ececE8' : r.t === 'median' ? '#e2e2dc' : r.t === 'bike' ? '#f7f7f3' : '#ffffff';
    out.push(`<rect x="${XL}" y="${r.y0}" width="${XR - XL}" height="${r.h}" fill="${fill}"/>`);
  });
  // lines
  const hline = (yy: number, w: number, dash?: string) => { out.push(`<line x1="${XL}" y1="${yy}" x2="${XR}" y2="${yy}" stroke="${INK}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`); };
  hline(swN.y0, 1); hline(swN.y1, 2.2); hline(bikeN.y1, 1.2); hline(bikeS.y0, 1.2); hline(swS.y0, 2.2); hline(swS.y1, 1);
  rows.forEach((r) => { if (r.t === 'median') { hline(r.y0, 1.6); hline(r.y1, 1.6); } });
  if (!divided) { const cl = lane('E', 0).y0; hline(cl - 1.6, 1); hline(cl + 1.6, 1); }
  for (let i = 1; i < nl; i++) { hline(lane('E', i).y0, 1, '14 10'); hline(lane('W', i).y1, 1, '14 10'); }
  // labels on non-traffic strips
  const strip = (r: CrossSectionRow, txt: string) => { for (let xx = 160; xx < XR - 80; xx += 420) out.push(`<text x="${xx}" y="${r.y0 + r.h / 2 + 3.5}" font-size="9" fill="${GR}">${txt}</text>`); };
  strip(swN, 'SIDEWALK'); strip(bikeN, 'BIKE LANE'); strip(bikeS, 'BIKE LANE'); strip(swS, 'SIDEWALK');
  rows.forEach((r) => { if (r.t === 'median') strip(r, 'RAISED MEDIAN'); });

  // direction arrows
  const arrow = (xx: number, yy: number, dir: 'E' | 'W') => { const d = dir === 'E' ? 1 : -1; out.push(`<path d="M${xx - 12 * d} ${yy} L${xx + 6 * d} ${yy} M${xx + 1 * d} ${yy - 4} L${xx + 8 * d} ${yy} L${xx + 1 * d} ${yy + 4}" stroke="${INK}" stroke-width="1.8" fill="none"/>`); };
  const closedX0 = X(sT.start), closedX1 = st === 'flagger' ? X(m.sg('taper2')!.end) : X(m.sg('ds')!.end);
  rows.forEach((r) => { if (r.t !== 'lane') return; [110, 330, 760, 1180, 1490].forEach((xx) => { if (r === closed && xx > closedX0 - 10 && xx < closedX1 + 10) return; arrow(xx, (r.y0 + r.y1) / 2, r.dir!); }); });

  // road name + speed limit
  const rnY = rt - 12;
  out.push(`<text x="60" y="${rnY}" font-size="20" fill="${INK}">${esc(p.road)}</text>`);
  const slx = 60 + p.road.length * 11.6 + 8;
  out.push(`<g><rect x="${slx}" y="${rnY - 24}" width="22" height="28" fill="#fff" stroke="${INK}"/><text x="${slx + 11}" y="${rnY - 16}" font-size="5" text-anchor="middle">SPEED</text><text x="${slx + 11}" y="${rnY - 11}" font-size="5" text-anchor="middle">LIMIT</text><text x="${slx + 11}" y="${rnY + 1}" font-size="12" text-anchor="middle" font-weight="bold">${m.S}</text></g>`);

  // sidewalk closure
  if (p.sidewalk) {
    const sx0 = X(sW.start) - 18, sx1 = X(sW.end) + 18;
    out.push(`<rect x="${sx0.toFixed(1)}" y="${swS.y0}" width="${(sx1 - sx0).toFixed(1)}" height="${swS.h}" fill="url(#hatch2)" stroke="#777" stroke-width=".8"/>`);
    [sx0 - 4, sx1 + 4].forEach((xx, ix) => {
      const key = 'r99' + ix;
      items[key] = { title: 'R9-9 SIDEWALK CLOSED', body: 'Paired with a Type II barricade across the sidewalk at each end of the closure. Pedestrians detour to the opposite sidewalk.', ref: 'Part 6 pedestrian considerations' };
      out.push(`<g class="it" data-k="${key}"><rect x="${(xx - 13).toFixed(1)}" y="${swS.y0 + 3}" width="26" height="12" fill="#fff" stroke="${INK}" stroke-width=".8"/><text x="${xx.toFixed(1)}" y="${swS.y0 + 8.5}" font-size="4" text-anchor="middle">SIDEWALK</text><text x="${xx.toFixed(1)}" y="${swS.y0 + 13}" font-size="4" text-anchor="middle">CLOSED</text><text x="${xx.toFixed(1)}" y="${swS.y1 + 10}" font-size="8" text-anchor="middle" font-weight="bold">R9-9</text></g>`);
    });
  }
  if (p.bus) {
    const bx = X(sW.start + sW.ft * 0.6);
    items.bus = { title: 'Bus stop inside the work zone', body: 'Temporary relocation needed. Contact the transit authority 3 days before work starts.', ref: 'City of Marina general notes' };
    out.push(`<g class="it" data-k="bus"><rect x="${(bx - 22).toFixed(1)}" y="${bikeS.y0 + 2}" width="44" height="${bikeS.h - 4}" fill="#fff" stroke="${INK}" stroke-dasharray="3 2"/><text x="${bx.toFixed(1)}" y="${bikeS.y0 + 12}" font-size="7" text-anchor="middle">BUS STOP</text></g>`);
  }

  // work space hatch
  const wx0 = X(sW.start), wx1 = X(sW.end);
  items.work = { title: `Work space · ${fmt(p.work)} ft`, body: `${esc(p.access)}. Closed to traffic for crew, equipment and materials.`, ref: 'Part 6 · activity area' };
  out.push(`<g class="it" data-k="work"><rect x="${wx0.toFixed(1)}" y="${closed.y0 + 2}" width="${(wx1 - wx0).toFixed(1)}" height="${closed.h - 4}" fill="url(#hatch)" stroke="${INK}" stroke-width="1.2"/></g>`);
  // splice boxes
  const bxs = p.boxes || [];
  bxs.forEach((b, ix) => {
    const xx = wx0 + ((wx1 - wx0) * (ix + 1)) / (bxs.length + 1), yy = (closed.y0 + closed.y1) / 2, key = 'sb' + ix;
    items[key] = { title: b, body: 'Access point inside the work space.', ref: 'Vicinity map, sheet 1' };
    out.push(`<g class="it" data-k="${key}"><rect x="${(xx - 5).toFixed(1)}" y="${yy - 5}" width="10" height="10" fill="#fff" stroke="#d81f1f" stroke-width="2"/><text x="${xx.toFixed(1)}" y="${closed.y0 - 5}" font-size="9" text-anchor="middle" fill="${INK}" font-weight="bold">${esc(b)}</text></g>`);
  });

  // buffer + taper labels
  const bmid = (X(sB.start) + X(sB.end)) / 2, cmid = (closed.y0 + closed.y1) / 2;
  out.push(`<text x="${bmid.toFixed(1)}" y="${(cmid + 3.5).toFixed(1)}" font-size="10" text-anchor="middle" fill="${INK}" font-weight="bold">${fmt(m.buf)}' BUFFER</text>`);
  if (st === 'flagger') { const b2 = m.sg('buffer2')!; out.push(`<text x="${((X(b2.start) + X(b2.end)) / 2).toFixed(1)}" y="${(cmid + 3.5).toFixed(1)}" font-size="10" text-anchor="middle" font-weight="bold">${fmt(m.buf)}' BUFFER</text>`); }

  // cones
  items.cones = { title: `Channelizing devices · ${m.dev.cones} cones`, body: `28-in cones with reflective sleeves. Spaced at most ${m.dev.taperSp} ft (1.0 × S) in tapers and ${m.dev.tanSp} ft (2.0 × S) along the tangent.`, ref: 'MUTCD 11th Ed. Part 6 channelizing guidance' };
  out.push('<g class="it" data-k="cones">');
  m.cones.forEach((c) => { const cx_ = X(c.ft), cy_ = eC + (eO - eC) * c.f; out.push(`<circle cx="${cx_.toFixed(1)}" cy="${cy_.toFixed(1)}" r="3.4" fill="${OR}" stroke="${INK}" stroke-width="1"/>`); });
  out.push('</g>');
  // taper callout
  const tx = (X(sT.start) + X(sT.end)) / 2;
  out.push(`<text x="${tx.toFixed(1)}" y="${st === 'center' ? rt - 4 : swS.y1 + 14}" font-size="10" text-anchor="middle" fill="${INK}" font-weight="bold">${fmt(m.taper)}' ${st === 'flagger' ? 'TAPER' : m.ttype.toUpperCase()}</text>`);

  // Type III barricades
  const barX = st === 'shoulder' ? [wx0 - 6] : [wx0 - 6, wx1 + 6];
  barX.forEach((xx, ix) => {
    const key = 'b3' + ix;
    items[key] = { title: 'Type III barricade with sign', body: `${ix === 0 ? 'Upstream' : 'Downstream'} end of the work space, across the closed ${st === 'shoulder' ? 'shoulder' : 'lane'}.`, ref: 'Part 6 channelizing devices' };
    out.push(`<g class="it" data-k="${key}"><rect x="${(xx - 2.5).toFixed(1)}" y="${closed.y0 + 3}" width="5" height="${closed.h - 6}" fill="#fff" stroke="${INK}"/><line x1="${(xx - 2.5).toFixed(1)}" y1="${closed.y0 + 8}" x2="${(xx + 2.5).toFixed(1)}" y2="${closed.y0 + 13}" stroke="${OR}" stroke-width="2"/><line x1="${(xx - 2.5).toFixed(1)}" y1="${closed.y1 - 13}" x2="${(xx + 2.5).toFixed(1)}" y2="${closed.y1 - 8}" stroke="${OR}" stroke-width="2"/></g>`);
  });

  // arrow board
  if (m.dev.arrow) {
    const ax = X(sB.start) + 10, ay = (closed.y0 + closed.y1) / 2, up = st === 'lane';
    items.ab = { title: 'Flashing arrow board', body: `In the closed lane at the end of the merging taper, arrow pointing ${up ? 'left' : 'right'} toward the open lane.`, ref: 'Part 6 arrow board guidance' };
    out.push(`<g class="it" data-k="ab"><rect x="${(ax - 9).toFixed(1)}" y="${ay - 9}" width="18" height="18" fill="${INK}"/><path d="M${ax.toFixed(1)} ${ay + (up ? -6 : 6)} L${(ax - 5).toFixed(1)} ${ay} M${ax.toFixed(1)} ${ay + (up ? -6 : 6)} L${(ax + 5).toFixed(1)} ${ay} M${ax.toFixed(1)} ${ay + (up ? -6 : 6)} L${ax.toFixed(1)} ${ay + (up ? 6 : -6)}" stroke="${OR}" stroke-width="2" fill="none"/></g>`);
  }

  // flaggers
  const flag: { x: number; y: number; side: 'N' | 'S' }[] = [];
  if (st === 'flagger') {
    flag.push({ x: X(sT.start) - 6, y: bikeS.y0 + 9, side: 'S' }, { x: X(m.sg('taper2')!.end) + 6, y: bikeN.y0 + 9, side: 'N' });
    flag.forEach((f, ix) => {
      const key = 'fl' + ix;
      items[key] = { title: `Flagger station ${ix === 0 ? '(eastbound)' : '(westbound)'}`, body: `At the upstream end of the one-lane taper. Stopping sight distance of ${fmt(m.buf)} ft (Table 6B-2) separates the station from the work space.`, ref: 'Table 6B-2 · flagger station' };
      out.push(`<g class="it" data-k="${key}"><circle cx="${f.x.toFixed(1)}" cy="${f.y - 4}" r="3" fill="${INK}"/><rect x="${(f.x - 3).toFixed(1)}" y="${f.y - 1}" width="6" height="8" fill="${INK}"/><line x1="${(f.x + 3).toFixed(1)}" y1="${f.y}" x2="${(f.x + 9).toFixed(1)}" y2="${f.y - 6}" stroke="${INK}" stroke-width="1.5"/><rect x="${(f.x + 7).toFixed(1)}" y="${f.y - 12}" width="7" height="7" fill="#d81f1f"/><text x="${f.x.toFixed(1)}" y="${f.side === 'S' ? swS.y1 + 26 : swN.y0 - 6}" font-size="9" text-anchor="middle" font-weight="bold">FLAGGER</text></g>`);
    });
  }

  // signs
  const lastX: Record<'S' | 'N', [number, number]> = { S: [-999, -999], N: [-999, -999] };
  m.signs.forEach((s, ix) => {
    let xx = X(s.pos); if (s.shape === 'rect' && xx > x1 - 10) xx = x1 - 10;
    let lv = 0; if (Math.abs(xx - lastX[s.side][0]) < 60) lv = 1; lastX[s.side][lv] = xx; if (lv === 0) lastX[s.side][0] = xx;
    const cy = s.side === 'S' ? rb + 52 + lv * 62 : rt - 58 - lv * 62;
    const key = 'sg' + ix;
    items[key] = { title: `${s.code} · ${s.lines.join(' ')}`, body: s.desc, ref: s.ref };
    let g = `<g class="it" data-k="${key}">`;
    const postY = s.side === 'S' ? swS.y1 : swN.y0;
    const sTop = s.shape === 'rect' ? 8 : 22;
    g += `<line x1="${xx.toFixed(1)}" y1="${postY}" x2="${xx.toFixed(1)}" y2="${s.side === 'S' ? cy - sTop : cy + sTop}" stroke="${INK}" stroke-width="1.2"/>`;
    g += `<circle cx="${xx.toFixed(1)}" cy="${postY}" r="2.4" fill="${INK}"/>`;
    if (s.shape === 'rect') { g += `<rect x="${(xx - 24).toFixed(1)}" y="${cy - 8}" width="48" height="16" fill="${OR}" stroke="${INK}"/>`; }
    else { g += `<path d="M${xx.toFixed(1)} ${cy - 22} L${(xx + 22).toFixed(1)} ${cy} L${xx.toFixed(1)} ${cy + 22} L${(xx - 22).toFixed(1)} ${cy} Z" fill="${OR}" stroke="${INK}" stroke-width="1.2"/>`; }
    const nLines = s.lines.length, lh = s.shape === 'rect' ? 6 : 6.4;
    s.lines.forEach((t, li) => { g += `<text x="${xx.toFixed(1)}" y="${(cy + (li - (nLines - 1) / 2) * lh + 2).toFixed(1)}" font-size="${t.length > 9 ? 4.6 : 5.6}" text-anchor="middle" font-weight="bold" fill="${INK}">${esc(t)}</text>`; });
    const codeY = s.side === 'S' ? cy + (s.shape === 'rect' ? 20 : 33) : cy - (s.shape === 'rect' ? 12 : 27);
    g += `<text x="${xx.toFixed(1)}" y="${codeY}" font-size="10" text-anchor="middle" font-weight="bold" fill="${INK}">${esc(s.code)}</text></g>`;
    out.push(g);
  });

  // dimension chain
  const dy = rb + 190;
  out.push('<g stroke="#b9b9b9" stroke-width=".7" stroke-dasharray="3 3">');
  m.seg.forEach((s, ix) => { if (ix === 0) out.push(`<line x1="${s.px0!.toFixed(1)}" y1="${swS.y1 + 2}" x2="${s.px0!.toFixed(1)}" y2="${dy + 6}"/>`); out.push(`<line x1="${s.px1!.toFixed(1)}" y1="${swS.y1 + 2}" x2="${s.px1!.toFixed(1)}" y2="${dy + 6}"/>`); });
  out.push('</g>');
  m.seg.forEach((s) => {
    const mx = (s.px0! + s.px1!) / 2;
    out.push(
      `<g class="dim" data-seg="${s.key}"><rect x="${s.px0!.toFixed(1)}" y="${dy - 30}" width="${(s.px1! - s.px0!).toFixed(1)}" height="50" fill="transparent"/>` +
      `<line x1="${(s.px0! + 1).toFixed(1)}" y1="${dy}" x2="${(s.px1! - 1).toFixed(1)}" y2="${dy}" stroke="${INK}" stroke-width="1" marker-start="url(#ar)" marker-end="url(#ar)"/>` +
      `<text x="${mx.toFixed(1)}" y="${dy - 17}" font-size="8" text-anchor="middle" fill="${GR}">${s.label}</text>` +
      `<text x="${mx.toFixed(1)}" y="${dy - 5}" font-size="11" text-anchor="middle" font-weight="bold" fill="${INK}">${fmt(s.ft)}'</text>` +
      `<text x="${mx.toFixed(1)}" y="${dy + 13}" font-size="7.5" text-anchor="middle" fill="${OR}">${s.ref === 'FIELD' ? 'FIELD' : 'T' + s.ref}</text></g>`
    );
  });
  out.push(`<text x="${x0}" y="${dy + 30}" font-size="9" fill="${GR}">T.A.N.S.A.T. TOTAL TTC ZONE ${fmt(m.total)}' · DIMENSIONS COMPUTED FROM CA MUTCD 2026 TABLES 6B-1 TO 6B-4 · DRAWING N.T.S.</text>`);

  // north arrow + scale
  out.push(`<g transform="translate(1520 ${dy + 2})"><circle r="16" fill="none" stroke="${INK}"/><path d="M0 -14 L6 8 L0 3 L-6 8 Z" fill="${INK}"/><text y="-20" font-size="11" text-anchor="middle" font-weight="bold">N</text></g>`);

  // bottom band
  const by = 782;
  out.push(`<line x1="20" y1="${by - 12}" x2="${VW - 20}" y2="${by - 12}" stroke="${INK}" stroke-width="1.5"/>`);
  // legend
  const lg: [string, string][] = [['cone', '28" TRAFFIC CONE W/ REFLECTIVE SLEEVE'], ['b3', 'TYPE III BARRICADE W/ SIGN'], ['sign', 'PROPOSED SIGN AND POST'], ['ab', 'FLASHING ARROW BOARD'], ['flag', 'FLAGGER'], ['hatch', 'WORK ZONE LIMITS'], ['hatch2', 'SIDEWALK CLOSED'], ['sb', 'SPLICE BOX'], ['dir', 'DIRECTION OF TRAFFIC']];
  out.push(`<text x="40" y="${by + 8}" font-size="13" font-weight="bold">LEGEND:</text>`);
  lg.forEach(([code, label], ix) => {
    const col = ix < 5 ? 0 : 1, rI = ix < 5 ? ix : ix - 5, lx = 48 + col * 270, ly = by + 30 + rI * 40;
    let s = '';
    if (code === 'cone') s = `<circle cx="${lx}" cy="${ly}" r="3.6" fill="${OR}" stroke="${INK}"/>`;
    if (code === 'b3') s = `<rect x="${lx - 3}" y="${ly - 10}" width="6" height="20" fill="#fff" stroke="${INK}"/><line x1="${lx - 3}" y1="${ly - 5}" x2="${lx + 3}" y2="${ly}" stroke="${OR}" stroke-width="2"/>`;
    if (code === 'sign') s = `<path d="M${lx} ${ly - 9} L${lx + 9} ${ly} L${lx} ${ly + 9} L${lx - 9} ${ly} Z" fill="${OR}" stroke="${INK}"/>`;
    if (code === 'ab') s = `<rect x="${lx - 8}" y="${ly - 8}" width="16" height="16" fill="${INK}"/><path d="M${lx} ${ly - 5} L${lx} ${ly + 5} M${lx - 4} ${ly - 1} L${lx} ${ly - 5} L${lx + 4} ${ly - 1}" stroke="${OR}" stroke-width="1.8" fill="none"/>`;
    if (code === 'flag') s = `<circle cx="${lx}" cy="${ly - 6}" r="3" fill="${INK}"/><rect x="${lx - 3}" y="${ly - 3}" width="6" height="9" fill="${INK}"/><rect x="${lx + 5}" y="${ly - 11}" width="6" height="6" fill="#d81f1f"/>`;
    if (code === 'hatch') s = `<rect x="${lx - 12}" y="${ly - 7}" width="24" height="14" fill="url(#hatch)" stroke="${INK}"/>`;
    if (code === 'hatch2') s = `<rect x="${lx - 12}" y="${ly - 7}" width="24" height="14" fill="url(#hatch2)" stroke="#777"/>`;
    if (code === 'sb') s = `<rect x="${lx - 5}" y="${ly - 5}" width="10" height="10" fill="#fff" stroke="#d81f1f" stroke-width="2"/>`;
    if (code === 'dir') s = `<path d="M${lx - 12} ${ly} L${lx + 6} ${ly} M${lx + 1} ${ly - 4} L${lx + 8} ${ly} L${lx + 1} ${ly + 4}" stroke="${INK}" stroke-width="1.8" fill="none"/>`;
    out.push(`${s}<text x="${lx + 24}" y="${ly + 3.5}" font-size="9.5">${label}</text>`);
  });

  // notes
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
    "5. COVER OR REMOVE CONFLICTING SIGNS, STRIPING AND MARKINGS;",
    '    REPLACE WHEN WORK IS COMPLETE.',
  ];
  if (p.bus) notes.push('6. CONTACT TRANSIT AUTHORITY 3 DAYS BEFORE WORK TO RELOCATE BUS STOP.');
  if (p.signal) notes.push(`${p.bus ? '7' : '6'}. SIGNAL TRAFFIC DIRECTION BY CITY OF MARINA POLICE / CSO ONLY.`);
  notes.forEach((t, ix) => { out.push(`<text x="${nx + 12}" y="${by + 40 + ix * 17}" font-size="10">${esc(t)}</text>`); });
  out.push(`<text x="${nx + 12}" y="${by + 212}" font-size="9.5" fill="#c0392b" font-weight="bold">DRAFT · REQUIRES REVIEW BY A QUALIFIED ENGINEER (MUTCD §6P.01)</text>`);

  // computed values box
  const cxb = 1095;
  out.push(`<rect x="${cxb}" y="${by}" width="215" height="222" fill="none" stroke="${INK}"/>`);
  out.push(`<text x="${cxb + 107}" y="${by + 18}" font-size="11" text-anchor="middle" font-weight="bold">COMPUTED TTC VALUES</text>`);
  const cv: [string, string][] = [
    ['SPEED (S)', `${m.S} MPH`], ['OFFSET (W)', `${m.W}'`], ['L (T6B-4)', `${fmt(m.L)}'`],
    [m.ttype.toUpperCase().replace('ONE-LANE, TWO-WAY', '1-LN 2-WAY'), `${fmt(m.taper)}'`],
    ['BUFFER (T6B-2)', `${fmt(m.buf)}'`], ['A / B / C (T6B-1)', `${m.adv.A}/${m.adv.B}/${m.adv.C}`],
    ['TAPER CONE SPC.', `${m.dev.taperSp}'`], ['TANGENT CONE SPC.', `${m.dev.tanSp}'`], ['CONES', String(m.dev.cones)],
  ];
  cv.forEach(([label, val], ix) => { const yy = by + 40 + ix * 20; out.push(`<text x="${cxb + 10}" y="${yy}" font-size="9.5">${esc(label)}</text><text x="${cxb + 205}" y="${yy}" font-size="10" text-anchor="end" font-weight="bold">${esc(val)}</text>`); });

  // title block
  const tb = 1320, tw = 240;
  out.push(`<rect x="${tb}" y="${by}" width="${tw}" height="222" fill="none" stroke="${INK}"/>`);
  const tbr: [string, string][] = [['CONST ARC', ''], ['GEO/CO', 'NE-46'], ['EXCH.', 'MARNCA11'], ['STANDARD', 'CA MUTCD 2026'], ['TYPE OF CONST.', 'TCP'], ['RO/EST. NO.', 'A05HGG2'], ['DWG.', p.dwg || '—'], ['SCALE', 'N.T.S.']];
  tbr.forEach(([label, val], ix) => { const yy = by + 24 + ix * 25; out.push(`<text x="${tb + 10}" y="${yy}" font-size="9.5">${label}</text><text x="${tb + tw - 10}" y="${yy}" font-size="11" text-anchor="end" font-weight="bold">${esc(val)}</text><line x1="${tb + 10}" y1="${yy + 6}" x2="${tb + tw - 10}" y2="${yy + 6}" stroke="#bbb" stroke-width=".6"/>`); });

  out.push('</svg>');

  // geometry for live traffic
  const geo: TrafficGeometry = {
    XL, XR, st,
    tS: X(sT.start), tE: X(sT.end), wS: wx0, wE: wx1,
    dsE: st === 'flagger' ? X(m.sg('taper2')!.end) : X(m.sg('ds')!.end),
    t2S: st === 'flagger' ? X(m.sg('taper2')!.start) : 0,
    eb: [], wb: [],
    closedIdx: st === 'lane' ? nl - 1 : st === 'center' ? 0 : st === 'flagger' ? 0 : -1,
    flagE: flag[0] ? flag[0].x : 0, flagW: flag[1] ? flag[1].x : 0,
    zoneX0: X(sT.start), zoneX1: closedX1,
  };
  for (let i = 0; i < nl; i++) { const le = lane('E', i), lw = lane('W', i); geo.eb.push((le.y0 + le.y1) / 2); geo.wb.push((lw.y0 + lw.y1) / 2); }
  if (st === 'flagger') geo.shiftY = geo.wb[0];
  else if (st === 'lane') geo.shiftY = nl > 1 ? geo.eb[nl - 2] : geo.eb[0];
  else if (st === 'center') geo.shiftY = geo.eb[1];

  return { svg: out.join(''), geo, items };
}

interface CurveRow {
  t: 'sidewalk' | 'bike' | 'lane' | 'median';
  y0: number;
  y1: number;
  h: number;
  side?: 'N' | 'S';
  dir?: 'E' | 'W';
  idx?: number;
  /** Offset from the alignment's own reference line -- filled in right
   * after the cross-section is built, same two-pass approach as the
   * source prototype (build in y0/y1, then normalize to n0/n1). */
  n0: number;
  n1: number;
}

interface CurveGeom {
  h0: number;
  L: number;
  sPC: number;
  sPT: number;
  R: number;
  ox: number;
  oy: number;
}

/**
 * Curve-aligned counterpart to renderLaneClosurePlanSVG() -- same MUTCD
 * numbers (m.seg/signs/cones/dev/checks are all computed identically by
 * computeLaneClosurePlan; only m.curve differs), but every element is
 * drawn along a tangent-arc-tangent alignment instead of a straight
 * strip. Ported 1:1 from the "Marina TCP Studio" prototype's renderCurve()
 * -- see this file's own docstring and laneClosureTcpEngine.ts's git
 * history for the source. Dispatched from renderLaneClosurePlanSVG() when
 * m.curve is set, the same way the prototype's own render() does.
 *
 * The geometry: stations run along the curving centerline (S(ft) maps a
 * real-feet position from computeLaneClosurePlan's straight station axis
 * onto this arc-length axis); P(s,n) returns the 2D point n ft
 * perpendicular from the centerline at station s (negative/positive =
 * left/right of travel). An auto-fit solver searches the curve's start
 * heading (and, as a last resort, relaxes the deflection angle itself)
 * so the whole alignment always fits the fixed 1600x1035 sheet, however
 * sharp curveDeg is -- see the `tries`/`it` loop below.
 *
 * Live traffic IS supported here, same as the straight-road sheet: the
 * returned `geo.map`/`geo.hdeg` are the same P()/H() closures every
 * static element on this sheet is drawn through, so the consuming hook
 * (useLaneClosurePlanEngine.ts) can drive a car through (station,
 * lane-offset) -> geo.map(...) and get a real on-sheet point that
 * actually follows the curve, instead of cutting across it in a
 * straight line the way a plain (x,y) car would.
 */
function renderLaneClosureCurveSVG(m: LaneClosurePlan): LaneClosureRenderResult {
  const p = m.p, st = m.st, out: string[] = [], items: Record<string, PlanItem> = {};
  const F = 'Arial, Helvetica, sans-serif', INK = '#1b1b1b', OR = '#f7931e', GR = '#6b6b6b';
  const D2R = Math.PI / 180;
  const curveInfo = m.curve!;

  // cross-section (same rows as the straight renderer, but kept in
  // offset-from-reference n0/n1 space instead of absolute y0/y1 so every
  // element can be projected onto the curve)
  const nl = st === 'flagger' ? 1 : p.lanes, divided = st !== 'flagger' && p.lanes >= 2, LH = 30;
  let y = 0;
  const rows: CurveRow[] = [];
  const push = (t: CurveRow['t'], h: number, ex?: Partial<CurveRow>) => { rows.push({ t, y0: y, y1: y + h, h, n0: 0, n1: 0, ...ex }); y += h; };
  push('sidewalk', 24, { side: 'N' }); push('bike', 18, { side: 'N' });
  for (let i = nl - 1; i >= 0; i--) push('lane', LH, { dir: 'W', idx: i });
  if (divided) push('median', 18);
  for (let i = 0; i < nl; i++) push('lane', LH, { dir: 'E', idx: i });
  push('bike', 18, { side: 'S' }); push('sidewalk', 24, { side: 'S' });
  const lane = (d: 'E' | 'W', ix: number) => rows.find((r) => r.t === 'lane' && r.dir === d && r.idx === ix)!;
  const row = (t: CurveRow['t'], side: 'N' | 'S') => rows.find((r) => r.t === t && r.side === side)!;
  const medRow = rows.find((r) => r.t === 'median') || null;
  const ref = divided ? (medRow!.y0 + medRow!.y1) / 2 : lane('E', 0).y0;
  rows.forEach((r) => { r.n0 = r.y0 - ref; r.n1 = r.y1 - ref; });
  const nTop = rows[0].n0, nBot = rows[rows.length - 1].n1;
  const bikeS = row('bike', 'S'), swS = row('sidewalk', 'S'), swN = row('sidewalk', 'N'), bikeN = row('bike', 'N');
  let closed: CurveRow, eC: number, eO: number;
  if (st === 'lane') { closed = lane('E', nl - 1); eC = closed.n1; eO = closed.n0; }
  else if (st === 'center') { closed = lane('E', 0); eC = closed.n0; eO = closed.n1; }
  else if (st === 'shoulder') { closed = bikeS; eC = closed.n1; eO = closed.n0; }
  else { closed = lane('E', 0); eC = closed.n1; eO = closed.n0; }
  const midn = (r: CurveRow) => (r.n0 + r.n1) / 2;

  // station mapping: real feet (m.seg's own start/end) -> arc-length
  // stations along the curving centerline
  const nseg = m.seg.length, base = nseg > 8 ? 30 : 42;
  const mapSeg = (L: number) => {
    const k = (L - base * nseg) / m.total;
    let c = 0;
    m.seg.forEach((s) => { s.s0 = c; c += base + k * s.ft; s.s1 = c; });
  };
  const S = (ft: number): number => {
    for (const s of m.seg) { if (ft <= s.end + 1e-6) return s.s0! + (s.ft ? (ft - s.start) / s.ft : 0) * (s.s1! - s.s0!); }
    return m.seg[m.seg.length - 1].s1!;
  };
  const hasN = m.signs.some((s) => s.side === 'N');
  const chainN = nBot + 150, topNeed = nTop - (hasN ? 128 : 30), botNeed = chainN + 30;
  const dir = -1;
  let th = curveInfo.deg * D2R;

  const mk = (h0: number, L: number): CurveGeom => {
    mapSeg(L);
    const sPC = S(curveInfo.pc), sPT = S(curveInfo.pt);
    return { h0, L, sPC, sPT, R: Math.max(1, (sPT - sPC) / th), ox: 0, oy: 0 };
  };
  const hd = (gg: CurveGeom, s: number): number => {
    if (s <= gg.sPC) return gg.h0;
    if (s >= gg.sPT) return gg.h0 + dir * th;
    return gg.h0 + (dir * (s - gg.sPC)) / gg.R;
  };
  const cp = (gg: CurveGeom, s: number): [number, number] => {
    const h0 = gg.h0;
    if (s <= gg.sPC) return [s * Math.cos(h0), s * Math.sin(h0)];
    const P0: [number, number] = [gg.sPC * Math.cos(h0), gg.sPC * Math.sin(h0)];
    const u = Math.min(s, gg.sPT) - gg.sPC, h = h0 + (dir * u) / gg.R, k = gg.R / dir;
    const A: [number, number] = [P0[0] + k * (Math.sin(h) - Math.sin(h0)), P0[1] - k * (Math.cos(h) - Math.cos(h0))];
    if (s <= gg.sPT) return A;
    return [A[0] + (s - gg.sPT) * Math.cos(h), A[1] + (s - gg.sPT) * Math.sin(h)];
  };
  const pt = (gg: CurveGeom, s: number, n: number): [number, number] => {
    const c = cp(gg, s), h = hd(gg, s);
    return [c[0] - n * Math.sin(h) + gg.ox, c[1] + n * Math.cos(h) + gg.oy];
  };
  const ext = (gg: CurveGeom) => {
    let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9;
    for (let s = -30; s <= gg.L + 30; s += 15) {
      [topNeed, botNeed].forEach((n) => {
        const q = pt(gg, s, n);
        if (q[1] < mny) mny = q[1];
        if (q[1] > mxy) mxy = q[1];
        if (s >= -10 && s <= gg.L + 10) { if (q[0] < mnx) mnx = q[0]; if (q[0] > mxx) mxx = q[0]; }
      });
    }
    return { mnx, mxx, mny, mxy };
  };

  // Auto-fit solve: search the start heading to minimize vertical extent
  // (rescaling L to hold ~1490px of horizontal extent each pass); if the
  // curve still can't fit 572px of height after 5 inner tries, relax the
  // deflection itself by x0.85 and retry, up to 6 outer tries -- this is
  // what guarantees any curveDeg fits the fixed 1600x1035 canvas.
  let g: CurveGeom = mk(0, 1460);
  for (let tries = 0; tries < 6; tries++) {
    let L = 1460;
    let best: { h: number; g: CurveGeom; e: { mnx: number; mxx: number; mny: number; mxy: number } } | null = null;
    for (let it = 0; it < 5; it++) {
      best = null;
      for (let hdeg = -45; hdeg <= 45; hdeg += 1) {
        const gg = mk(hdeg * D2R, L), e = ext(gg), h = e.mxy - e.mny;
        if (!best || h < best.h) best = { h, g: gg, e };
      }
      L = (L * 1490) / (best!.e.mxx - best!.e.mnx);
    }
    g = mk(best!.g.h0, L);
    const e = ext(g);
    if (e.mxy - e.mny <= 572 || tries === 5) {
      g.ox = 50 - e.mnx;
      g.oy = (195 + 767) / 2 - (e.mny + e.mxy) / 2;
      break;
    }
    th *= 0.85;
  }
  const P = (s: number, n: number) => pt(g, s, n);
  const H = (s: number) => hd(g, s) / D2R;
  curveInfo.used = Math.round(th / D2R);
  curveInfo.sPC = g.sPC;
  curveInfo.sPT = g.sPT;

  const f1 = (v: number) => v.toFixed(1);
  const strip = (s0: number, s1: number, n0: number, n1: number, attrs: string): string => {
    const a: [number, number][] = [], b: [number, number][] = [];
    const stStep = Math.max(2, Math.min(8, (s1 - s0) / 6));
    for (let s = s0; s < s1; s += stStep) { a.push(P(s, n0)); b.push(P(s, n1)); }
    a.push(P(s1, n0)); b.push(P(s1, n1));
    const pts = a.concat(b.reverse()).map((q) => `${f1(q[0])},${f1(q[1])}`).join(' ');
    return `<polygon points="${pts}" ${attrs}/>`;
  };
  const pline = (s0: number, s1: number, n: number, attrs: string): string => {
    const a: [number, number][] = [];
    for (let s = s0; s < s1; s += 8) a.push(P(s, n));
    a.push(P(s1, n));
    return `<polyline points="${a.map((q) => `${f1(q[0])},${f1(q[1])}`).join(' ')}" fill="none" ${attrs}/>`;
  };
  const at = (s: number, n: number, rot: number, inner: string): string => {
    const q = P(s, n);
    return `<g transform="translate(${f1(q[0])} ${f1(q[1])})${rot ? ` rotate(${rot.toFixed(1)})` : ''}">${inner}</g>`;
  };
  const up = (deg: number): number => { const d = ((deg % 360) + 360) % 360; return d > 90 && d < 270 ? deg + 180 : deg; };

  const sA = -30, sB = g.L + 30;
  const sT = m.sg('taper')!, sBf = m.sg('buffer')!, sW = m.sg('work')!;
  const closedS0 = S(sT.start), closedS1 = st === 'flagger' ? S(m.sg('taper2')!.end) : S(m.sg('ds')!.end);

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1035" font-family="${F}">`);
  out.push(
    '<defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#ffffff"/><line x1="0" y1="0" x2="0" y2="7" stroke="#444" stroke-width="1.3"/></pattern>' +
    '<pattern id="hatch2" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="8" height="8" fill="#f1efe9"/><line x1="0" y1="0" x2="0" y2="8" stroke="#9a9a9a" stroke-width="1"/></pattern>' +
    `<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 L10 5 L0 9 z" fill="${INK}"/></marker></defs>`
  );
  out.push(`<rect width="1600" height="1035" fill="#ffffff"/><rect x="20" y="20" width="1560" height="995" fill="none" stroke="${INK}" stroke-width="4"/>`);
  out.push(`<g fill="${INK}"><text x="44" y="64" font-size="26">${esc(p.addr)}</text><text x="44" y="94" font-size="21">${esc(p.xing)}</text><text x="44" y="122" font-size="19">${esc(p.access)}</text><text x="44" y="150" font-size="19">WORK AREA ${esc(String(p.wa))} OF 11</text></g>`);
  out.push(`<g stroke="${INK}" fill="none" stroke-width="1"><rect x="1430" y="30" width="130" height="46"/><line x1="1480" y1="30" x2="1480" y2="76"/><line x1="1430" y1="46" x2="1560" y2="46"/></g><g fill="${INK}" font-size="9"><text x="1446" y="42">ISSUE</text><text x="1508" y="42">DATE</text></g><g fill="${INK}" font-size="15"><text x="1450" y="68">0</text><text x="1490" y="68">8/26/26</text></g>`);
  out.push('<clipPath id="clipD"><rect x="22" y="184" width="1556" height="584"/></clipPath>');
  out.push(`<text x="44" y="178" font-size="12" fill="${OR}" font-weight="bold">${esc(m.stName.toUpperCase())} ON A HORIZONTAL CURVE · S = ${m.S} MPH · GENERATED DRAFT</text>`);

  out.push('<g clip-path="url(#clipD)">');
  m.seg.forEach((s) => { out.push(strip(s.s0!, s.s1!, nTop - 4, nBot + 4, `class="hl" data-seg="${s.key}" fill="transparent"`)); });
  rows.forEach((r) => { const fill = r.t === 'sidewalk' ? '#ececE8' : r.t === 'median' ? '#e2e2dc' : r.t === 'bike' ? '#f7f7f3' : '#ffffff'; out.push(strip(sA, sB, r.n0, r.n1, `fill="${fill}"`)); });
  const L_ = (n: number, w: number, dash?: string) => { out.push(pline(sA, sB, n, `stroke="${INK}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}`)); };
  L_(swN.n0, 1); L_(swN.n1, 2.2); L_(bikeN.n1, 1.2); L_(bikeS.n0, 1.2); L_(swS.n0, 2.2); L_(swS.n1, 1);
  if (medRow) { L_(medRow.n0, 1.6); L_(medRow.n1, 1.6); } else { L_(-1.6, 1); L_(1.6, 1); }
  for (let i = 1; i < nl; i++) { L_(lane('E', i).n0, 1, '14 10'); L_(lane('W', i).n1, 1, '14 10'); }
  const lab = (r: CurveRow, txt: string) => { for (let s = 100; s < g.L - 40; s += 420) out.push(at(s, midn(r), up(H(s)), `<text y="3.5" font-size="9" fill="${GR}" text-anchor="middle">${txt}</text>`)); };
  lab(swN, 'SIDEWALK'); lab(bikeN, 'BIKE LANE'); lab(bikeS, 'BIKE LANE'); lab(swS, 'SIDEWALK'); if (medRow) lab(medRow, 'RAISED MEDIAN');
  const arrowD = `<path d="M-12 0 L6 0 M1 -4 L8 0 L1 4" stroke="${INK}" stroke-width="1.8" fill="none"/>`;
  rows.forEach((r) => {
    if (r.t !== 'lane') return;
    [0.03, 0.2, 0.5, 0.78, 0.97].forEach((fr) => {
      const s = fr * g.L;
      if (r === closed && s > closedS0 - 10 && s < closedS1 + 10) return;
      out.push(at(s, midn(r), H(s) + (r.dir === 'W' ? 180 : 0), arrowD));
    });
  });
  out.push(at(10, nTop - 14, H(10), `<text font-size="20" fill="${INK}">${esc(p.road)}</text><g transform="translate(${p.road.length * 11.6 + 8} -24)"><rect width="22" height="28" fill="#fff" stroke="${INK}"/><text x="11" y="8" font-size="5" text-anchor="middle">SPEED</text><text x="11" y="13" font-size="5" text-anchor="middle">LIMIT</text><text x="11" y="25" font-size="12" text-anchor="middle" font-weight="bold">${m.S}</text></g>`));

  ([[g.sPC, 'PC'], [g.sPT, 'PT']] as [number, string][]).forEach(([station, label]) => {
    const aPt = P(station, nTop - 2), bPt = P(station, nTop - 16), tPt = P(station, nTop - 22);
    out.push(`<line x1="${f1(aPt[0])}" y1="${f1(aPt[1])}" x2="${f1(bPt[0])}" y2="${f1(bPt[1])}" stroke="#2c5db8" stroke-width="1.6"/><text x="${f1(tPt[0])}" y="${f1(tPt[1])}" font-size="10" font-weight="bold" fill="#2c5db8" text-anchor="middle">${label}</text>`);
  });
  const sMidC = (g.sPC + g.sPT) / 2;
  items.curve = { title: `Horizontal curve · Δ = ${curveInfo.used}°`, body: 'The work space sits on the curve between PC and PT. The merging taper and the advance signs stay on the approach tangent so drivers see the lane closure before they enter the curve.', ref: 'Part 6 · sight distance to the transition' };
  out.push(`<g class="it" data-k="curve">${pline(g.sPC, g.sPT, nTop - 9, 'stroke="#2c5db8" stroke-width="1.2" stroke-dasharray="2 3"')}${at(sMidC, nTop - (hasN ? 118 : 34), up(H(sMidC)), `<text font-size="10.5" font-weight="bold" fill="#2c5db8" text-anchor="middle">HORIZONTAL CURVE · Δ = ${curveInfo.used}° LT · WORK ON CURVE</text>`)}</g>`);

  // sidewalk closure
  if (p.sidewalk) {
    const ss0 = S(sW.start) - 18, ss1 = S(sW.end) + 18;
    out.push(strip(ss0, ss1, swS.n0, swS.n1, 'fill="url(#hatch2)" stroke="#777" stroke-width=".8"'));
    [ss0 - 4, ss1 + 4].forEach((s, ix) => {
      const key = 'r99' + ix;
      items[key] = { title: 'R9-9 SIDEWALK CLOSED', body: 'Paired with a Type II barricade across the sidewalk at each end of the closure. Pedestrians detour to the opposite sidewalk.', ref: 'Part 6 pedestrian considerations' };
      out.push(`<g class="it" data-k="${key}">${at(s, swS.n0 + 9, H(s), '<rect x="-13" y="-6" width="26" height="12" fill="#fff" stroke="' + INK + '" stroke-width=".8"/><text y="-.5" font-size="4" text-anchor="middle">SIDEWALK</text><text y="4" font-size="4" text-anchor="middle">CLOSED</text>')}</g>`);
    });
  }
  if (p.bus) {
    const bs = S(sW.start + sW.ft * 0.6);
    items.bus = { title: 'Bus stop inside the work zone', body: 'Temporary relocation needed. Contact the transit authority 3 days before work starts.', ref: 'City of Marina general notes' };
    out.push(`<g class="it" data-k="bus">${at(bs, midn(bikeS), H(bs), '<rect x="-22" y="-7" width="44" height="14" fill="#fff" stroke="' + INK + '" stroke-dasharray="3 2"/><text y="3" font-size="7" text-anchor="middle">BUS STOP</text>')}</g>`);
  }

  // work space
  items.work = { title: `Work space · ${fmt(p.work)} ft`, body: `${esc(p.access)}. Located on the horizontal curve.`, ref: 'Part 6 · activity area' };
  out.push(`<g class="it" data-k="work">${strip(S(sW.start), S(sW.end), closed.n0 + 2, closed.n1 - 2, `fill="url(#hatch)" stroke="${INK}" stroke-width="1.2"`)}</g>`);
  (p.boxes || []).forEach((b, ix, arr) => {
    const s = S(sW.start) + (S(sW.end) - S(sW.start)) * (ix + 1) / (arr.length + 1), key = 'sb' + ix;
    items[key] = { title: b, body: 'Access point inside the work space.', ref: 'Vicinity map, sheet 1' };
    const lp = P(s, closed.n0 - 6);
    out.push(`<g class="it" data-k="${key}">${at(s, midn(closed), H(s), '<rect x="-5" y="-5" width="10" height="10" fill="#fff" stroke="#d81f1f" stroke-width="2"/>')}<text x="${f1(lp[0])}" y="${f1(lp[1])}" font-size="9" text-anchor="middle" font-weight="bold" fill="${INK}">${esc(b)}</text></g>`);
  });
  const bmS = (S(sBf.start) + S(sBf.end)) / 2;
  out.push(at(bmS, midn(closed), up(H(bmS)), `<text y="3.5" font-size="10" text-anchor="middle" font-weight="bold" fill="${INK}">${fmt(m.buf)}' BUFFER</text>`));
  if (st === 'flagger') { const b2 = m.sg('buffer2')!, b2m = (S(b2.start) + S(b2.end)) / 2; out.push(at(b2m, midn(closed), up(H(b2m)), `<text y="3.5" font-size="10" text-anchor="middle" font-weight="bold">${fmt(m.buf)}' BUFFER</text>`)); }

  // cones
  items.cones = { title: `Channelizing devices · ${m.dev.cones} cones`, body: `28-in cones with reflective sleeves. Spaced at most ${m.dev.taperSp} ft (1.0 × S) in tapers and ${m.dev.tanSp} ft (2.0 × S) along the tangent. On the curve, keep spacing tight enough that the line reads as continuous.`, ref: 'MUTCD 11th Ed. Part 6 channelizing guidance' };
  out.push(`<g class="it" data-k="cones">${m.cones.map((c) => { const q = P(S(c.ft), eC + (eO - eC) * c.f); return `<circle cx="${f1(q[0])}" cy="${f1(q[1])}" r="3.4" fill="${OR}" stroke="${INK}" stroke-width="1"/>`; }).join('')}</g>`);
  const tmS = (S(sT.start) + S(sT.end)) / 2;
  out.push(at(tmS, st === 'center' ? nTop - 6 : swS.n1 + 14, up(H(tmS)), `<text font-size="10" text-anchor="middle" font-weight="bold" fill="${INK}">${fmt(m.taper)}' ${st === 'flagger' ? 'TAPER' : m.ttype.toUpperCase()}</text>`));

  // barricades
  const bars = st === 'shoulder' ? [S(sW.start) - 6] : [S(sW.start) - 6, S(sW.end) + 6];
  bars.forEach((s, ix) => {
    const key = 'b3' + ix, h = closed.n1 - closed.n0 - 6;
    items[key] = { title: 'Type III barricade with sign', body: `${ix === 0 ? 'Upstream' : 'Downstream'} end of the work space.`, ref: 'Part 6 channelizing devices' };
    out.push(`<g class="it" data-k="${key}">${at(s, midn(closed), H(s), `<rect x="-2.5" y="${-h / 2}" width="5" height="${h}" fill="#fff" stroke="${INK}"/><line x1="-2.5" y1="${-h / 2 + 5}" x2="2.5" y2="${-h / 2 + 10}" stroke="${OR}" stroke-width="2"/>`)}</g>`);
  });
  if (m.dev.arrow) {
    const abS = S(sBf.start) + 10, upA = st === 'lane';
    items.ab = { title: 'Flashing arrow board', body: 'In the closed lane at the end of the merging taper, on the tangent ahead of the curve.', ref: 'Part 6 arrow board guidance' };
    out.push(`<g class="it" data-k="ab">${at(abS, midn(closed), H(abS), `<rect x="-9" y="-9" width="18" height="18" fill="${INK}"/><path d="M0 ${upA ? -6 : 6} L-5 0 M0 ${upA ? -6 : 6} L5 0 M0 ${upA ? -6 : 6} L0 ${upA ? 6 : -6}" stroke="${OR}" stroke-width="2" fill="none"/>`)}</g>`);
  }
  if (st === 'flagger') {
    ([[S(sT.start) - 6, midn(bikeS), '(eastbound)'], [S(m.sg('taper2')!.end) + 6, midn(bikeN), '(westbound)']] as [number, number, string][]).forEach(([sx, sn, label], ix) => {
      const key = 'fl' + ix, q = P(sx, sn);
      items[key] = { title: `Flagger station ${label}`, body: `At the upstream end of the one-lane taper, ${fmt(m.buf)} ft (Table 6B-2) from the work space.`, ref: 'Table 6B-2 · flagger station' };
      out.push(`<g class="it" data-k="${key}" transform="translate(${f1(q[0])} ${f1(q[1])})"><circle cy="-4" r="3" fill="${INK}"/><rect x="-3" y="-1" width="6" height="8" fill="${INK}"/><rect x="7" y="-12" width="7" height="7" fill="#d81f1f"/></g>`);
    });
  }

  // signs (upright, offset outside the road)
  const lastSign: Record<'S' | 'N', number> = { S: -999, N: -999 };
  let lvlUsed = false;
  m.signs.forEach((s, ix) => {
    const ss = Math.min(S(s.pos), g.L - 10);
    let lv = 0;
    if (Math.abs(ss - lastSign[s.side]) < 62) { lv = 1; lvlUsed = true; } else lastSign[s.side] = ss;
    const n = s.side === 'S' ? nBot + 52 + lv * 62 : nTop - 58 - lv * 62, c = P(ss, n), e = P(ss, s.side === 'S' ? nBot : nTop);
    const key = 'sg' + ix;
    items[key] = { title: `${s.code} · ${s.lines.join(' ')}`, body: s.desc, ref: s.ref };
    let gs = `<g class="it" data-k="${key}"><line x1="${f1(e[0])}" y1="${f1(e[1])}" x2="${f1(c[0])}" y2="${f1(c[1])}" stroke="${INK}" stroke-width="1.2"/><circle cx="${f1(e[0])}" cy="${f1(e[1])}" r="2.4" fill="${INK}"/>`;
    const x = c[0], yy = c[1];
    if (s.shape === 'rect') gs += `<rect x="${f1(x - 24)}" y="${f1(yy - 8)}" width="48" height="16" fill="${OR}" stroke="${INK}"/>`;
    else gs += `<path d="M${f1(x)} ${f1(yy - 22)} L${f1(x + 22)} ${f1(yy)} L${f1(x)} ${f1(yy + 22)} L${f1(x - 22)} ${f1(yy)} Z" fill="${OR}" stroke="${INK}" stroke-width="1.2"/>`;
    const nL = s.lines.length;
    s.lines.forEach((t, li) => { gs += `<text x="${f1(x)}" y="${f1(yy + (li - (nL - 1) / 2) * 6.4 + 2)}" font-size="${t.length > 9 ? 4.6 : 5.6}" text-anchor="middle" font-weight="bold" fill="${INK}">${esc(t)}</text>`; });
    const cy2 = s.side === 'S' ? yy + (s.shape === 'rect' ? 20 : 34) : yy - (s.shape === 'rect' ? 12 : 27);
    gs += `<text x="${f1(x)}" y="${f1(cy2)}" font-size="10" text-anchor="middle" font-weight="bold" fill="${INK}">${esc(s.code)}</text></g>`;
    out.push(gs);
  });

  // dimension chain along the curve
  const cN = lvlUsed ? chainN + 50 : chainN;
  m.seg.forEach((s, ix) => {
    [ix === 0 ? s.s0! : null, s.s1!].forEach((sv) => {
      if (sv == null) return;
      const a = P(sv, nBot + 2), b = P(sv, cN + 6);
      out.push(`<line x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}" stroke="#b9b9b9" stroke-width=".7" stroke-dasharray="3 3"/>`);
    });
  });
  m.seg.forEach((s) => {
    const ms = (s.s0! + s.s1!) / 2, r = up(H(ms));
    out.push(
      `<g class="dim" data-seg="${s.key}">${strip(s.s0!, s.s1!, cN - 30, cN + 20, 'fill="transparent"')}${pline(s.s0! + 1, s.s1! - 1, cN, `stroke="${INK}" stroke-width="1" marker-start="url(#ar)" marker-end="url(#ar)"`)}` +
      `${at(ms, cN, r, `<text y="-17" font-size="8" text-anchor="middle" fill="${GR}">${s.label}</text><text y="-5" font-size="11" text-anchor="middle" font-weight="bold" fill="${INK}">${fmt(s.ft)}'</text><text y="13" font-size="7.5" text-anchor="middle" fill="${OR}">${s.ref === 'FIELD' ? 'FIELD' : 'T' + s.ref}</text>`)}</g>`
    );
  });
  out.push(at(0, cN + 30, H(0), `<text font-size="9" fill="${GR}">T.A.N.S.A.T. TOTAL TTC ZONE ${fmt(m.total)}' · CURVED ALIGNMENT · DRAWING N.T.S.</text>`));
  out.push('</g>');

  // north arrow, repositioned to avoid the road
  const endTop = P(g.L, topNeed), naY = endTop[1] > 300 ? 225 : 735;
  out.push(`<g transform="translate(1530 ${naY})"><circle r="16" fill="#fff" stroke="${INK}"/><path d="M0 -14 L6 8 L0 3 L-6 8 Z" fill="${INK}"/><text y="-20" font-size="11" text-anchor="middle" font-weight="bold">N</text></g>`);

  const cvRows: [string, string][] = [
    ['SPEED (S)', `${m.S} MPH`], ['L (T6B-4)', `${fmt(m.L)}'`],
    [m.ttype.toUpperCase().replace('ONE-LANE, TWO-WAY', '1-LN 2-WAY'), `${fmt(m.taper)}'`],
    ['BUFFER (T6B-2)', `${fmt(m.buf)}'`], ['A / B / C (T6B-1)', `${m.adv.A}/${m.adv.B}/${m.adv.C}`],
    ['CURVE DEFLECTION', `Δ ${curveInfo.used}° LT`],
    ['TAPER TO PC', curveInfo.gap >= 0 ? `${fmt(curveInfo.gap)}' TANGENT` : 'ON CURVE'],
    ['CONE SPC. T / TAN.', `${m.dev.taperSp}' / ${m.dev.tanSp}'`], ['CONES', String(m.dev.cones)],
  ];
  curveBottomBand(out, m, cvRows, ['8. WORK SPACE ON HORIZONTAL CURVE: KEEP TAPER AND ADVANCE SIGNS ON THE', '    APPROACH TANGENT; VERIFY SIGHT DISTANCE TO THE TAPER IN THE FIELD.']);
  out.push('</svg>');

  m.seg.forEach((s) => {
    const a = P(s.s0!, 0), b = P(s.s1!, 0), c = P((s.s0! + s.s1!) / 2, 0);
    s.px0 = Math.min(a[0], b[0]); s.px1 = Math.max(a[0], b[0]); s.cy = c[1];
  });
  const geo: TrafficGeometry = {
    XL: sA, XR: sB, st,
    tS: S(sT.start), tE: S(sT.end), wS: S(sW.start), wE: S(sW.end),
    dsE: closedS1, t2S: st === 'flagger' ? S(m.sg('taper2')!.start) : 0,
    eb: [], wb: [], closedIdx: st === 'lane' ? nl - 1 : st === 'center' ? 0 : st === 'flagger' ? 0 : -1,
    flagE: st === 'flagger' ? S(sT.start) - 6 : 0, flagW: st === 'flagger' ? S(m.sg('taper2')!.end) + 6 : 0,
    zoneX0: closedS0, zoneX1: closedS1,
    map: P, hdeg: H,
  };
  for (let i = 0; i < nl; i++) { geo.eb.push(midn(lane('E', i))); geo.wb.push(midn(lane('W', i))); }
  if (st === 'flagger') geo.shiftY = geo.wb[0];
  else if (st === 'lane') geo.shiftY = nl > 1 ? geo.eb[nl - 2] : geo.eb[0];
  else if (st === 'center') geo.shiftY = geo.eb[1];

  return { svg: out.join(''), geo, items };
}

/** Legend / general-notes / computed-values / title-block band shared by
 * the curve renderer -- same 782..1004 band layout as the straight
 * renderer's own inline bottom band (kept as a separate, non-exported
 * helper here rather than a shared refactor, so the already-verified
 * straight-render path in renderLaneClosurePlanSVG() above is never
 * touched by this addition). `cv` overrides the computed-values rows,
 * `extraNotes` appends to the general notes list. */
function curveBottomBand(out: string[], m: LaneClosurePlan, cv: [string, string][], extraNotes: string[]): void {
  const p = m.p, INK = '#1b1b1b', OR = '#f7931e';
  const by = 782;
  out.push(`<line x1="20" y1="${by - 12}" x2="1580" y2="${by - 12}" stroke="${INK}" stroke-width="1.5"/>`);
  const lg: [string, string][] = [['cone', '28" TRAFFIC CONE W/ REFLECTIVE SLEEVE'], ['b3', 'TYPE III BARRICADE W/ SIGN'], ['sign', 'PROPOSED SIGN AND POST'], ['ab', 'FLASHING ARROW BOARD'], ['flag', 'FLAGGER'], ['hatch', 'WORK ZONE LIMITS'], ['hatch2', 'SIDEWALK CLOSED'], ['sb', 'SPLICE BOX'], ['dir', 'DIRECTION OF TRAFFIC']];
  out.push(`<text x="40" y="${by + 8}" font-size="13" font-weight="bold">LEGEND:</text>`);
  const half = Math.ceil(lg.length / 2);
  lg.forEach(([code, label], ix) => {
    const col = ix < half ? 0 : 1, rI = ix < half ? ix : ix - half, lx = 48 + col * 270, ly = by + 30 + rI * (half > 5 ? 34 : 40);
    let s = '';
    if (code === 'cone') s = `<circle cx="${lx}" cy="${ly}" r="3.6" fill="${OR}" stroke="${INK}"/>`;
    if (code === 'b3') s = `<rect x="${lx - 3}" y="${ly - 10}" width="6" height="20" fill="#fff" stroke="${INK}"/><line x1="${lx - 3}" y1="${ly - 5}" x2="${lx + 3}" y2="${ly}" stroke="${OR}" stroke-width="2"/>`;
    if (code === 'sign') s = `<path d="M${lx} ${ly - 9} L${lx + 9} ${ly} L${lx} ${ly + 9} L${lx - 9} ${ly} Z" fill="${OR}" stroke="${INK}"/>`;
    if (code === 'ab') s = `<rect x="${lx - 8}" y="${ly - 8}" width="16" height="16" fill="${INK}"/><path d="M${lx} ${ly - 5} L${lx} ${ly + 5} M${lx - 4} ${ly - 1} L${lx} ${ly - 5} L${lx + 4} ${ly - 1}" stroke="${OR}" stroke-width="1.8" fill="none"/>`;
    if (code === 'flag') s = `<circle cx="${lx}" cy="${ly - 6}" r="3" fill="${INK}"/><rect x="${lx - 3}" y="${ly - 3}" width="6" height="9" fill="${INK}"/><rect x="${lx + 5}" y="${ly - 11}" width="6" height="6" fill="#d81f1f"/>`;
    if (code === 'hatch') s = `<rect x="${lx - 12}" y="${ly - 7}" width="24" height="14" fill="url(#hatch)" stroke="${INK}"/>`;
    if (code === 'hatch2') s = `<rect x="${lx - 12}" y="${ly - 7}" width="24" height="14" fill="url(#hatch2)" stroke="#777"/>`;
    if (code === 'sb') s = `<rect x="${lx - 5}" y="${ly - 5}" width="10" height="10" fill="#fff" stroke="#d81f1f" stroke-width="2"/>`;
    if (code === 'dir') s = `<path d="M${lx - 12} ${ly} L${lx + 6} ${ly} M${lx + 1} ${ly - 4} L${lx + 8} ${ly} L${lx + 1} ${ly + 4}" stroke="${INK}" stroke-width="1.8" fill="none"/>`;
    out.push(`${s}<text x="${lx + 24}" y="${ly + 3.5}" font-size="9.5">${label}</text>`);
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
  if (p.signal) notes.push(`${p.bus ? '7' : '6'}. SIGNAL TRAFFIC DIRECTION BY CITY OF MARINA POLICE / CSO ONLY.`);
  extraNotes.forEach((t) => notes.push(t));
  notes.forEach((t, ix) => { out.push(`<text x="${nx + 12}" y="${by + 40 + ix * 17}" font-size="10">${esc(t)}</text>`); });
  out.push(`<text x="${nx + 12}" y="${by + 212}" font-size="9.5" fill="#c0392b" font-weight="bold">DRAFT · REQUIRES REVIEW BY A QUALIFIED ENGINEER (MUTCD §6P.01)</text>`);

  const cxb = 1095;
  out.push(`<rect x="${cxb}" y="${by}" width="215" height="222" fill="none" stroke="${INK}"/>`);
  out.push(`<text x="${cxb + 107}" y="${by + 18}" font-size="11" text-anchor="middle" font-weight="bold">COMPUTED TTC VALUES</text>`);
  cv.forEach(([label, val], ix) => { const yy = by + 40 + ix * 20; out.push(`<text x="${cxb + 10}" y="${yy}" font-size="9.5">${esc(label)}</text><text x="${cxb + 205}" y="${yy}" font-size="10" text-anchor="end" font-weight="bold">${esc(val)}</text>`); });

  const tb = 1320, tw = 240;
  out.push(`<rect x="${tb}" y="${by}" width="${tw}" height="222" fill="none" stroke="${INK}"/>`);
  const tbr: [string, string][] = [['CONST ARC', ''], ['GEO/CO', 'NE-46'], ['EXCH.', 'MARNCA11'], ['STANDARD', 'CA MUTCD 2026'], ['TYPE OF CONST.', 'TCP'], ['RO/EST. NO.', 'A05HGG2'], ['DWG.', p.dwg || '—'], ['SCALE', 'N.T.S.']];
  tbr.forEach(([label, val], ix) => { const yy = by + 24 + ix * 25; out.push(`<text x="${tb + 10}" y="${yy}" font-size="9.5">${label}</text><text x="${tb + tw - 10}" y="${yy}" font-size="11" text-anchor="end" font-weight="bold">${esc(val)}</text><line x1="${tb + 10}" y1="${yy + 6}" x2="${tb + tw - 10}" y2="${yy + 6}" stroke="#bbb" stroke-width=".6"/>`); });
}

export interface QuickDescribeResult {
  params: LaneClosureParams;
  tags: string[];
}

/**
 * Best-effort free-text parser: pulls a posted speed, work-space length,
 * closure strategy, lane count, road type, sidewalk/bus-stop mentions and a
 * road name out of a plain description ("close the curb lane on
 * Reservation Rd for 150 ft, posted 35, bus stop and sidewalk closed") and
 * applies whatever it recognized on top of the current params. Anything it
 * doesn't recognize is left as-is, EXCEPT sidewalk/bus, which are always
 * set from whether those words appear at all (so re-running this after
 * editing the text away from "sidewalk" correctly clears the toggle
 * instead of leaving a stale one behind) -- same asymmetry the source
 * prototype's own parser used.
 */
export function parseQuickDescribe(text: string, current: LaneClosureParams): QuickDescribeResult {
  const t = text.toLowerCase();
  const tags: string[] = [];
  const params: LaneClosureParams = { ...current };

  const sp = t.match(/(\d{2})\s*(mph|miles)/) || t.match(/(?:posted|speed|limit)\D{0,12}(\d{2})/);
  if (sp) { const s = Math.min(75, Math.max(20, Math.round(Number(sp[1]) / 5) * 5)); params.speed = s; tags.push(`${s} mph`); }

  const ln = t.match(/(\d{2,4})\s*(ft|feet|foot|')/);
  if (ln) { params.work = Math.min(600, Math.max(20, Math.round(Number(ln[1]) / 10) * 10)); tags.push(`${params.work} ft work`); }

  if (/flagger|one[- ]lane|two[- ]way/.test(t)) { params.strategy = 'flagger'; tags.push('flagger'); }
  else if (/shoulder|bike lane work|bike-lane/.test(t)) { params.strategy = 'shoulder'; tags.push('shoulder'); }
  else if (/left lane|median lane|inside lane|inner lane|fast lane/.test(t)) { params.strategy = 'center'; tags.push('left lane'); }
  else if (/lane/.test(t)) { params.strategy = 'lane'; tags.push('right lane'); }

  const nlanes = t.match(/(\d)\s*lanes?\s*(each|per|in each)/);
  if (nlanes) { params.lanes = Math.min(3, Math.max(1, Number(nlanes[1]))); tags.push(`${params.lanes} lanes/dir`); }
  if (/two[- ]lane road|2[- ]lane road/.test(t)) params.lanes = 1;

  if (/rural/.test(t)) { params.roadType = 'rural'; tags.push('rural'); }
  else if (/urban|city|downtown/.test(t)) params.roadType = 'urban';

  params.sidewalk = /sidewalk/.test(t); if (params.sidewalk) tags.push('sidewalk closed');
  params.bus = /bus/.test(t); if (params.bus) tags.push('bus stop');

  const rd = t.match(/on ([a-z0-9 .]+?(?:rd|road|blvd|ave|avenue|st|street|dr|drive|way|cir)\.?)(?=[ ,]|$)/);
  if (rd) { params.road = rd[1].toUpperCase().replace(/ ROAD$/, ' RD.').replace(/ RD$/, ' RD.'); tags.push(params.road); }

  return { params, tags };
}
