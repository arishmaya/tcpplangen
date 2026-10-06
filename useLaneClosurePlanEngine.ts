import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LaneClosureParams,
  LaneClosurePlan,
  LaneClosureRenderResult,
  ComplianceLevel,
  TrafficGeometry,
  computeLaneClosurePlan,
  renderLaneClosurePlanSVG,
} from './laneClosureTcpEngine';

/**
 * useLaneClosurePlanEngine.ts
 *
 * Everything the lane-closure plan sheet needs BESIDES the parameter form
 * itself, factored out of LaneClosureTCPStudio.tsx so it can be shared
 * between two different presentations of the same underlying plan:
 *  - LaneClosureTCPStudio.tsx, the standalone console (its own AppSelector
 *    tab) -- work-area presets, quick describe, live traffic sim, the
 *    whole three-pane layout.
 *  - App.tsx's own TCP wizard (Step 3 "Design Parameters" / Step 4
 *    diagram) -- the "Plan style: Intersection / Lane Closure" toggle
 *    added there renders the same diagram + calc/compliance panels via
 *    LaneClosureDiagramStage / LaneClosureSummaryPanel, driven by this
 *    same hook, so the two entry points can never drift into two
 *    different-behaving copies of the engine wiring.
 *
 * Owns: the computed plan/render, the SVG DOM mount, pan/zoom, item
 * selection, hover-linked segment highlighting, the live traffic
 * simulation (rAF loop, imperative DOM updates -- see the file-level note
 * in LaneClosureTCPStudio.tsx for why), the sign/devices/checklist/source
 * tabs, and the derived KPI/calc/device/checklist rows. Does NOT own
 * `params` itself (the caller does, since who edits it -- a full sidebar
 * form vs. a compact wizard-step form -- differs by context) or the
 * preset list / quick-describe parser (also caller-specific).
 */

export type LaneClosureTabKey = 'signs' | 'devices' | 'prep' | 'src';

interface Car {
  d: 1 | -1;
  l: number;
  x: number;
  y: number;
  v: number;
  col: string;
}

const EB_COLORS = ['#3a4a6b', '#5b6f96', '#2d3a55', '#7a8aa8', '#44587f'];
const WB_COLORS = ['#8a5a3a', '#a26b45', '#6e4a33'];

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

export function signSize(code: string, p: LaneClosureParams): string {
  if (code === 'G20-2') return '36" × 18"';
  if (code === 'R9-9') return '24" × 12"';
  return p.speed >= 45 || p.roadType === 'rural' ? '48" × 48"' : '36" × 36"';
}

export interface LaneClosureKpi {
  key: string;
  label: string;
  value: string;
  unit: string;
  caption: string;
  seg: string | null;
}

export interface LaneClosureCalcRow {
  name: string;
  value: string;
  how: string;
  cite: string;
  seg: string | null;
}

export interface LaneClosureDeviceRow {
  key: string;
  device: string;
  placement: string;
  qty: number;
}

export interface LaneClosureChecklistItem {
  key: string;
  title: string;
  sub: string;
}

export interface LaneClosurePlanEngine {
  plan: LaneClosurePlan;
  renderResult: LaneClosureRenderResult;

  svgHostRef: React.RefObject<HTMLDivElement>;
  stageWrapRef: React.RefObject<HTMLDivElement>;
  liveStatsRef: React.RefObject<HTMLDivElement>;
  srcPreRef: React.RefObject<HTMLPreElement>;

  selKey: string | null;
  setSelKey: (k: string | null) => void;
  tab: LaneClosureTabKey;
  setTab: (t: LaneClosureTabKey) => void;
  playing: boolean;
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  simVolume: number;
  setSimVolume: (v: number) => void;
  copyStatus: 'idle' | 'copied' | 'blocked';
  handleCopySvg: () => void;

  fitView: () => void;
  zoomView: (fac: number, cx?: number, cy?: number) => void;
  zoomToSeg: (key: string) => void;
  highlightSeg: (seg: string, on: boolean) => void;
  resetTraffic: () => void;

  kpis: LaneClosureKpi[];
  calcRows: LaneClosureCalcRow[];
  deviceRows: LaneClosureDeviceRow[];
  checklist: LaneClosureChecklistItem[];
  checklistState: Record<string, boolean>;
  checklistDone: number;
  toggleChecklistItem: (key: string, checked: boolean) => void;

  statusLevel: ComplianceLevel;
  statusLabel: string;
  statusClass: string;

  tS: number;
  workSegEnd: number;
}

/**
 * `active` gates only the live-traffic rAF loop -- the SVG-mount/pan-zoom/
 * selection effects below already no-op safely when the consuming
 * component isn't actually rendered (their DOM refs just stay null), so
 * the only real always-on cost worth skipping is the animation loop
 * itself when the lane-closure view isn't the one currently on screen
 * (e.g. the user is on App.tsx's Intersection plan style, or Step 1/2 of
 * the wizard).
 */
export function useLaneClosurePlanEngine(params: LaneClosureParams, active: boolean = true): LaneClosurePlanEngine {
  const [tab, setTab] = useState<LaneClosureTabKey>('signs');
  const [selKey, setSelKey] = useState<string | null>(null);
  const [prepDone, setPrepDone] = useState<Record<string, Record<string, boolean>>>({});
  const [simVolume, setSimVolume] = useState(12);
  const [playing, setPlaying] = useState(true);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'blocked'>('idle');

  const plan = useMemo(() => computeLaneClosurePlan(params), [params]);
  const renderResult = useMemo(() => renderLaneClosurePlanSVG(plan), [plan]);

  const svgHostRef = useRef<HTMLDivElement | null>(null);
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const liveStatsRef = useRef<HTMLDivElement | null>(null);
  const srcPreRef = useRef<HTMLPreElement | null>(null);

  const vbRef = useRef({ x: 0, y: 0, w: 1600, h: 1035 });
  const trafficLayerRef = useRef<SVGGElement | null>(null);
  const carElsRef = useRef<SVGRectElement[]>([]);
  const carsRef = useRef<Car[]>([]);
  const exitsRef = useRef<number[]>([]);
  const simTRef = useRef(0);
  const phaseTRef = useRef(0);
  const lastTRef = useRef<number | null>(null);
  const geoRef = useRef<TrafficGeometry>(renderResult.geo);
  const itemsRef = useRef(renderResult.items);
  const planRef = useRef(plan);
  const playingRef = useRef(playing);
  const volumeRef = useRef(simVolume);
  const paramsRef = useRef(params);

  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { volumeRef.current = simVolume; }, [simVolume]);
  useEffect(() => { paramsRef.current = params; }, [params]);
  useEffect(() => { planRef.current = plan; }, [plan]);
  useEffect(() => { itemsRef.current = renderResult.items; }, [renderResult]);

  const applyVB = useCallback(() => {
    const svg = svgHostRef.current?.querySelector('svg');
    if (svg) svg.setAttribute('viewBox', `${vbRef.current.x} ${vbRef.current.y} ${vbRef.current.w} ${vbRef.current.h}`);
  }, []);

  const fitView = useCallback(() => {
    vbRef.current = { x: 0, y: 0, w: 1600, h: 1035 };
    applyVB();
  }, [applyVB]);

  const zoomView = useCallback((fac: number, cx?: number, cy?: number) => {
    const vb = vbRef.current;
    const nw = Math.min(2400, Math.max(160, vb.w * fac));
    const r = nw / vb.w;
    const ccx = cx ?? vb.x + vb.w / 2;
    const ccy = cy ?? vb.y + vb.h / 2;
    vbRef.current = { x: ccx - (ccx - vb.x) * r, y: ccy - (ccy - vb.y) * r, w: nw, h: vb.h * r };
    applyVB();
  }, [applyVB]);

  const zoomToSeg = useCallback((key: string) => {
    const s = planRef.current.sg(key);
    if (!s || s.px0 == null || s.px1 == null) return;
    const w = Math.max(260, s.px1 - s.px0 + 160);
    const h = (w * 1035) / 1600;
    vbRef.current = { x: (s.px0 + s.px1) / 2 - w / 2, y: 360 - h / 2, w, h };
    applyVB();
  }, [applyVB]);

  const highlightSeg = useCallback((seg: string, on: boolean) => {
    svgHostRef.current?.querySelectorAll(`[data-seg="${seg}"]`).forEach((el) => el.classList.toggle('on', on));
  }, []);

  const yAt = useCallback((c: Car, x: number): number => {
    const geo = geoRef.current;
    if (c.d < 0) return geo.wb[c.l];
    const y0 = geo.eb[c.l];
    if (geo.st === 'flagger') {
      if (x < geo.tS) return y0;
      if (x < geo.tE) return lerp(y0, geo.shiftY ?? y0, (x - geo.tS) / (geo.tE - geo.tS));
      if (x < geo.t2S) return geo.shiftY ?? y0;
      return lerp(geo.shiftY ?? y0, y0, (x - geo.t2S) / (geo.dsE - geo.t2S));
    }
    if (c.l === geo.closedIdx && geo.st !== 'shoulder') {
      if (x < geo.tS - 6) return y0;
      return lerp(y0, geo.shiftY ?? y0, (x - geo.tS + 6) / (geo.tE - geo.tS));
    }
    return y0;
  }, []);

  const phase = useCallback((): 'E' | 'X' | 'W' => {
    const cyc = phaseTRef.current % 28;
    return cyc < 10 ? 'E' : cyc < 14 ? 'X' : cyc < 24 ? 'W' : 'X';
  }, []);

  const step = useCallback((dt: number) => {
    simTRef.current += dt;
    phaseTRef.current += dt;
    const geo = geoRef.current;
    const p = paramsRef.current;
    const vol = volumeRef.current;
    const base = 30 + p.speed * 1.4;
    const ph = phase();
    let cars = carsRef.current;

    geo.eb.forEach((_, l) => {
      if (Math.random() < (vol / 60) * dt && !cars.some((c) => c.d > 0 && c.l === l && c.x < geo.XL + 40)) {
        cars.push({ d: 1, l, x: geo.XL - 10, y: 0, v: base * 0.9, col: EB_COLORS[(Math.random() * EB_COLORS.length) | 0] });
      }
    });
    geo.wb.forEach((_, l) => {
      if (Math.random() < (vol / 60) * dt && !cars.some((c) => c.d < 0 && c.l === l && c.x > geo.XR - 40)) {
        cars.push({ d: -1, l, x: geo.XR + 10, y: 0, v: base * 0.9, col: WB_COLORS[(Math.random() * WB_COLORS.length) | 0] });
      }
    });

    cars.forEach((c) => { c.y = yAt(c, c.x); });
    cars.forEach((c) => {
      const inZone = c.d > 0 && c.x > geo.zoneX0 - 40 && c.x < geo.zoneX1;
      let target = base * (inZone ? 0.72 : 1);
      for (const o of cars) {
        if (o === c || o.d !== c.d) continue;
        const dx = (o.x - c.x) * c.d;
        if (dx > 0 && dx < 30 && Math.abs(o.y - c.y) < 11) target = Math.min(target, dx < 20 ? 0 : o.v * 0.8);
      }
      if (c.d > 0 && c.l === geo.closedIdx && geo.st !== 'shoulder' && geo.st !== 'flagger' && c.x > geo.tS - 30 && c.x < geo.tE) {
        for (const q of cars) {
          if (q.d > 0 && q.l !== c.l && Math.abs(q.y - (geo.shiftY ?? q.y)) < 6 && q.x - c.x > -18 && q.x - c.x < 26) target = Math.min(target, 4);
        }
        if (c.x > geo.tE - 6) target = Math.max(target, 0);
      }
      if (geo.st === 'flagger') {
        if (c.d > 0 && ph !== 'E' && c.x < geo.flagE - 4 && geo.flagE - 4 - c.x < 30) target = 0;
        if (c.d < 0 && ph !== 'W' && c.x > geo.flagW + 4 && c.x - (geo.flagW + 4) < 30) target = 0;
      }
      c.v += (target - c.v) * Math.min(1, dt * (target < c.v ? 6 : 1.6));
      if (c.v < 0) c.v = 0;
      c.x += c.v * c.d * dt;
    });

    carsRef.current = cars.filter((c) => {
      const gone = c.x > geo.XR + 20 || c.x < geo.XL - 20;
      if (gone && c.d > 0) exitsRef.current.push(simTRef.current);
      return !gone;
    });
    exitsRef.current = exitsRef.current.filter((tExit) => simTRef.current - tExit < 60);
  }, [phase, yAt]);

  const draw = useCallback(() => {
    const g = trafficLayerRef.current;
    if (!g) return;
    const cars = carsRef.current;
    const els = carElsRef.current;
    while (els.length < cars.length) {
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('width', '15'); r.setAttribute('height', '8'); r.setAttribute('rx', '2');
      g.appendChild(r);
      els.push(r);
    }
    const geo = geoRef.current;
    els.forEach((r, i) => {
      const c = cars[i];
      if (!c) { r.setAttribute('display', 'none'); return; }
      r.removeAttribute('display');
      r.setAttribute('x', '-7.5'); r.setAttribute('y', '-4');
      r.setAttribute('fill', c.col);
      if (geo.map && geo.hdeg) {
        // Curve sheet: c.x/c.y are a (station, lane-offset) pair, not a
        // real on-sheet point -- project through the same P()/H()
        // closures the curve renderer itself drew every static element
        // with, so the car actually follows the curving road instead of
        // cutting across it in a straight line.
        const [px, py] = geo.map(c.x, c.y);
        const ang = geo.hdeg(c.x) + (c.d < 0 ? 180 : 0);
        r.setAttribute('transform', `translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${ang.toFixed(1)})`);
      } else {
        const y2 = yAt(c, c.x + 4 * c.d);
        const ang = (Math.atan2(y2 - c.y, 4 * c.d) * 180) / Math.PI;
        r.setAttribute('transform', `translate(${c.x.toFixed(1)} ${c.y.toFixed(1)}) rotate(${ang.toFixed(1)})`);
      }
    });
    const q = cars.filter((c) => c.d > 0 && c.v < 10 && c.x < geo.zoneX1).length;
    const zc = cars.filter((c) => c.d > 0 && c.x > geo.zoneX0 && c.x < geo.zoneX1);
    const avg = zc.length ? zc.reduce((a, c) => a + c.v, 0) / zc.length / 1.4 - 30 / 1.4 : 0;
    const throughput = Math.round((exitsRef.current.length * 60) / Math.max(1, Math.min(60, simTRef.current)));
    const liveEl = liveStatsRef.current;
    if (liveEl) {
      let h =
        `<div class="lc-live-box">Queue<b>${q} veh</b></div>` +
        `<div class="lc-live-box">Zone speed<b>${zc.length ? Math.max(0, Math.round(avg)) : '–'} mph</b></div>` +
        `<div class="lc-live-box">Throughput<b>${throughput}/min</b></div>`;
      if (geo.st === 'flagger') {
        const ph = phase();
        h += `<div class="lc-live-box lc-live-phase">Flaggers<b>${ph === 'E' ? 'EB go' : ph === 'W' ? 'WB go' : 'All stop'}</b></div>`;
      }
      liveEl.innerHTML = h;
    }
  }, [yAt, phase]);

  useEffect(() => {
    if (!active) return; // no point animating a plan sheet that isn't on screen
    let raf = 0;
    const loop = (t: number) => {
      const last = lastTRef.current;
      const dt = last == null ? 0 : Math.min(0.05, (t - last) / 1000);
      lastTRef.current = t;
      if (playingRef.current) { step(dt); draw(); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, step, draw]);

  const resetTraffic = useCallback(() => {
    carsRef.current = [];
    exitsRef.current = [];
    phaseTRef.current = 0;
    simTRef.current = 0;
    if (trafficLayerRef.current) trafficLayerRef.current.innerHTML = '';
    carElsRef.current = [];
  }, []);

  useEffect(() => {
    const host = svgHostRef.current;
    if (!host) return;
    host.innerHTML = renderResult.svg;
    const svg = host.querySelector('svg');
    if (!svg) return;
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    applyVB();

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('id', 'traffic');
    g.setAttribute('pointer-events', 'none');
    // Insert just before the cones group, in ITS OWN parent -- not
    // necessarily <svg> itself. The straight-road sheet puts every element
    // (including the cones group) as a direct child of <svg>, so this used
    // to just be `svg.insertBefore(g, cones)`, but the curve sheet wraps
    // its whole body in a `<g clip-path="url(#clipD)">` for the alignment
    // clip -- cones lives inside THAT group there, so inserting into `svg`
    // with `cones` as the reference node throws ("not a child of this
    // node"). Falling back to appending onto <svg> covers the case where
    // the cones group isn't found at all.
    const cones = svg.querySelector('[data-k="cones"]');
    if (cones && cones.parentNode) cones.parentNode.insertBefore(g, cones);
    else svg.appendChild(g);
    trafficLayerRef.current = g;
    carElsRef.current = [];
    geoRef.current = renderResult.geo;

    if (selKey && !renderResult.items[selKey]) setSelKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderResult, applyVB]);

  useEffect(() => {
    const svg = svgHostRef.current?.querySelector('svg');
    if (!svg) return;
    svg.querySelectorAll('.it.sel').forEach((el) => el.classList.remove('sel'));
    if (selKey) {
      const el = svg.querySelector(`[data-k="${selKey}"]`);
      if (el) el.classList.add('sel');
    }
  }, [selKey, renderResult]);

  useEffect(() => {
    const wrap = stageWrapRef.current;
    const host = svgHostRef.current;
    if (!wrap || !host) return;

    const toSvgPoint = (clientX: number, clientY: number) => {
      const svg = host.querySelector('svg');
      if (!svg) return { x: 0, y: 0, sc: 1 };
      const r = svg.getBoundingClientRect();
      const vb = vbRef.current;
      const sc = Math.max(vb.w / r.width, vb.h / r.height);
      const ox = (r.width * sc - vb.w) / 2, oy = (r.height * sc - vb.h) / 2;
      return { x: vb.x + (clientX - r.left) * sc - ox, y: vb.y + (clientY - r.top) * sc - oy, sc };
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const pt = toSvgPoint(e.clientX, e.clientY);
      zoomView(e.deltaY > 0 ? 1.12 : 1 / 1.12, pt.x, pt.y);
    };

    let drag: { x: number; y: number; vx: number; vy: number; sc: number } | null = null;
    let moved = false;

    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest?.('.lc-info-pop')) return;
      const pt = toSvgPoint(e.clientX, e.clientY);
      drag = { x: e.clientX, y: e.clientY, vx: vbRef.current.x, vy: vbRef.current.y, sc: pt.sc };
      moved = false;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; wrap.classList.add('lc-dragging'); }
      if (moved) {
        vbRef.current = { ...vbRef.current, x: drag.vx - dx * drag.sc, y: drag.vy - dy * drag.sc };
        applyVB();
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (drag && !moved) {
        const target = e.target as HTMLElement;
        const it = target.closest?.('.it') as HTMLElement | null;
        if (it) { const k = it.getAttribute('data-k'); if (k && itemsRef.current[k]) setSelKey(k); }
        const d = target.closest?.('.dim') as HTMLElement | null;
        if (d) { const seg = d.getAttribute('data-seg'); if (seg) zoomToSeg(seg); }
      }
      drag = null;
      wrap.classList.remove('lc-dragging');
    };

    const onMouseOver = (e: MouseEvent) => {
      const d = (e.target as HTMLElement).closest?.('.dim') as HTMLElement | null;
      if (d) { const seg = d.getAttribute('data-seg'); if (seg) highlightSeg(seg, true); }
    };
    const onMouseOut = (e: MouseEvent) => {
      const d = (e.target as HTMLElement).closest?.('.dim') as HTMLElement | null;
      if (d) { const seg = d.getAttribute('data-seg'); if (seg) highlightSeg(seg, false); }
    };

    wrap.addEventListener('wheel', onWheel, { passive: false });
    wrap.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    host.addEventListener('mouseover', onMouseOver);
    host.addEventListener('mouseout', onMouseOut);
    return () => {
      wrap.removeEventListener('wheel', onWheel);
      wrap.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('mouseover', onMouseOver);
      host.removeEventListener('mouseout', onMouseOut);
    };
  }, [zoomView, applyVB, zoomToSeg, highlightSeg]);

  const checklistKey = `WA${params.wa}`;
  const toggleChecklistItem = useCallback((key: string, checked: boolean) => {
    setPrepDone((prev) => ({ ...prev, [checklistKey]: { ...(prev[checklistKey] || {}), [key]: checked } }));
  }, [checklistKey]);

  const handleCopySvg = useCallback(() => {
    navigator.clipboard.writeText(renderResult.svg).then(
      () => { setCopyStatus('copied'); window.setTimeout(() => setCopyStatus('idle'), 2200); },
      () => { setTab('src'); setCopyStatus('blocked'); window.setTimeout(() => setCopyStatus('idle'), 2200); },
    );
  }, [renderResult.svg]);

  useEffect(() => {
    if (copyStatus === 'blocked' && tab === 'src' && srcPreRef.current) {
      const range = document.createRange();
      range.selectNodeContents(srcPreRef.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [copyStatus, tab]);

  const kpis: LaneClosureKpi[] = useMemo(() => {
    const m = plan;
    if (m.curve) {
      return [
        { key: 'total', label: 'TTC zone', value: fmtNum(m.total), unit: 'ft', caption: 'Advance signs to end', seg: null },
        { key: 'taper', label: m.st === 'shoulder' ? 'Shoulder taper' : m.st === 'flagger' ? '1-lane taper' : 'Merge taper', value: fmtNum(m.taper), unit: 'ft', caption: m.tref.replace('Table ', 'T'), seg: 'taper' },
        { key: 'buffer', label: 'Buffer', value: fmtNum(m.buf), unit: 'ft', caption: 'Table 6B-2 · SSD', seg: 'buffer' },
        { key: 'curve', label: 'Curve deflection', value: String(m.curve.used ?? m.curve.deg), unit: '°', caption: m.curve.gap >= 0 ? `${fmtNum(m.curve.gap)} ft taper-to-PC` : 'taper runs into curve', seg: null },
        { key: 'devices', label: 'Devices', value: String(m.dev.cones), unit: 'cones', caption: `${m.signs.length + (m.p.sidewalk ? 2 : 0)} signs · ${m.dev.arrow ? '1 arrow board' : m.dev.flaggers ? '2 flaggers' : 'no arrow board'}`, seg: null },
      ];
    }
    return [
      { key: 'total', label: 'TTC zone', value: fmtNum(m.total), unit: 'ft', caption: 'Advance signs to end', seg: null },
      { key: 'taper', label: m.st === 'shoulder' ? 'Shoulder taper' : m.st === 'flagger' ? '1-lane taper' : 'Merge taper', value: fmtNum(m.taper), unit: 'ft', caption: m.tref.replace('Table ', 'T'), seg: 'taper' },
      { key: 'buffer', label: 'Buffer', value: fmtNum(m.buf), unit: 'ft', caption: 'Table 6B-2 · SSD', seg: 'buffer' },
      { key: 'spacing', label: 'Sign spacing', value: String(m.adv.A), unit: 'ft', caption: 'A = B = C · Table 6B-1', seg: 'A' },
      { key: 'devices', label: 'Devices', value: String(m.dev.cones), unit: 'cones', caption: `${m.signs.length + (m.p.sidewalk ? 2 : 0)} signs · ${m.dev.arrow ? '1 arrow board' : m.dev.flaggers ? '2 flaggers' : 'no arrow board'}`, seg: null },
    ];
  }, [plan]);

  const statusLevel: ComplianceLevel = plan.checks.some((c) => c.lvl === 'bad') ? 'bad' : plan.checks.some((c) => c.lvl === 'warn') ? 'warn' : 'ok';
  const statusLabel = statusLevel === 'bad' ? 'Fix required' : statusLevel === 'warn' ? 'Coordination needed' : 'Checks pass';
  const statusClass = statusLevel === 'bad' ? 'bg-red-950/60 text-red-300 border border-red-800/50' : statusLevel === 'warn' ? 'bg-amber-950/60 text-amber-300 border border-amber-800/50' : 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/50';

  const calcRows: LaneClosureCalcRow[] = useMemo(() => {
    const m = plan;
    return [
      { name: 'Taper length L', value: `${fmtNum(m.L)} ft`, how: `${m.Lf} = ${fmtNum(m.L)}`, cite: `Table 6B-4 · S ${m.S <= 40 ? '≤ 40' : '≥ 45'} mph formula`, seg: null },
      { name: m.ttype, value: `${fmtNum(m.taper)} ft`, how: m.st === 'shoulder' ? `0.33 × ${fmtNum(m.L)} → ${fmtNum(m.taper)}` : m.st === 'flagger' ? 'fixed range 50–100 ft' : 'at least L', cite: m.tref, seg: 'taper' },
      { name: 'Buffer space', value: `${fmtNum(m.buf)} ft`, how: `stopping sight distance at ${m.S} mph`, cite: 'Table 6B-2 (also flagger station location)', seg: 'buffer' },
      { name: 'Advance sign spacing', value: `${m.adv.A} / ${m.adv.B} / ${m.adv.C}`, how: `${m.adv.row} → A, B, C in ft`, cite: 'Table 6B-1', seg: 'C' },
      { name: 'Downstream taper', value: `${fmtNum(m.ds)} ft`, how: '50 ft min, 100 ft max', cite: m.dsref, seg: m.st === 'flagger' ? 'taper2' : 'ds' },
      { name: 'Cone spacing', value: `${m.dev.taperSp} / ${m.dev.tanSp} ft`, how: 'taper 1.0 × S · tangent 2.0 × S', cite: 'MUTCD Part 6 channelizing guidance', seg: null },
      { name: 'Work space', value: `${fmtNum(m.p.work)} ft`, how: (m.p.boxes || []).join(', ') || 'field measured', cite: 'Field input', seg: 'work' },
    ];
  }, [plan]);

  const deviceRows: LaneClosureDeviceRow[] = useMemo(() => {
    const d = plan.dev;
    const rows: LaneClosureDeviceRow[] = [
      { key: 'cones', device: '28" cone, reflective sleeve', qty: d.cones, placement: `Tapers at ${d.taperSp} ft, tangent at ${d.tanSp} ft` },
      { key: 'b30', device: 'Type III barricade with sign', qty: d.typeIII, placement: 'Work space ends' },
    ];
    if (d.arrow) rows.push({ key: 'ab', device: 'Flashing arrow board', qty: 1, placement: 'End of merging taper' });
    if (d.flaggers) rows.push({ key: 'fl0', device: 'Certified flagger', qty: 2, placement: 'Stations at both taper ends' });
    if (d.typeII) rows.push({ key: 'r990', device: 'Type II barricade (pedestrian)', qty: 2, placement: 'Sidewalk closure ends' });
    return rows;
  }, [plan]);

  const checklist: LaneClosureChecklistItem[] = useMemo(() => {
    const list: LaneClosureChecklistItem[] = [
      { key: 'n72', title: 'Notify residents, businesses, agencies and schools', sub: '72 hours before work · keep driveway access' },
      { key: 'np48', title: 'Post temporary NO PARKING signs', sub: '48 hours before work' },
      { key: 'cover', title: 'Cover or remove conflicting signs and striping', sub: 'Replace when work is complete' },
      { key: 'hrs', title: 'Schedule inside the 9:00 AM – 3:00 PM window', sub: 'Lane closures only' },
    ];
    if (params.bus) list.push({ key: 'bus', title: 'Contact the transit authority', sub: '3 days before work · relocate bus stop' });
    if (params.signal) list.push({ key: 'sig', title: 'Arrange police / CSO traffic direction', sub: '14 days ahead if a signal override is needed' });
    list.push({ key: 'pe', title: 'Engineer review and stamp', sub: 'MUTCD §6P.01 · plan is a generated draft' });
    return list;
  }, [params.bus, params.signal]);

  const checklistState = prepDone[checklistKey] || {};
  const checklistDone = checklist.filter((l) => checklistState[l.key]).length;

  return {
    plan, renderResult,
    svgHostRef, stageWrapRef, liveStatsRef, srcPreRef,
    selKey, setSelKey, tab, setTab, playing, setPlaying, simVolume, setSimVolume, copyStatus, handleCopySvg,
    fitView, zoomView, zoomToSeg, highlightSeg, resetTraffic,
    kpis, calcRows, deviceRows, checklist, checklistState, checklistDone, toggleChecklistItem,
    statusLevel, statusLabel, statusClass,
    tS: plan.sg('taper')?.start ?? 0,
    workSegEnd: plan.sg('work')?.end ?? 0,
  };
}
