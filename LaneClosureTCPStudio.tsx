import React, { useCallback, useState } from 'react';
import { Route } from 'lucide-react';
import {
  LaneClosureParams,
  ClosureStrategy,
  RoadType,
  Alignment,
  LANE_CLOSURE_PRESETS,
  STRATEGY_LABELS,
  parseQuickDescribe,
} from '../laneClosureTcpEngine';
import { useLaneClosurePlanEngine } from '../useLaneClosurePlanEngine';
import { LaneClosureDiagramStage } from './LaneClosureDiagramStage';
import { LaneClosureSummaryPanel } from './LaneClosureSummaryPanel';
import { LaneClosureIntersectionPanel } from './LaneClosureIntersectionPanel';

/**
 * LaneClosureTCPStudio.tsx
 *
 * A new, standalone plan type -- straight-road lane-closure TCP (taper /
 * buffer / work space along one road) -- alongside the existing
 * intersection-focused TCP flow in App.tsx. Ported from the user's own
 * "Marina TCP Studio" HTML prototype: the compute/render engine lives in
 * ./laneClosureTcpEngine.ts (framework-free), the shared plan/render/pan-
 * zoom/selection/live-traffic wiring lives in ./useLaneClosurePlanEngine.ts
 * (also used by App.tsx's own embedded "Plan style: Lane Closure" wizard
 * step -- see that file's docstring), and this file is purely the console
 * chrome around both: work-area presets, the quick-describe parser, and
 * the parameter form on the left, with the plan sheet / tabs (center) and
 * calc / compliance panel (right) delegated to LaneClosureDiagramStage and
 * LaneClosureSummaryPanel so neither entry point can drift out of sync
 * with the other.
 *
 * Mounted as its own top-level tool (see AppSelector.tsx) rather than
 * folded into App.tsx's internals, the same way FiberPlanning.tsx is --
 * it owns its own state end to end and shares nothing with the
 * intersection TCP flow. It uses this app's own --tcp-* design tokens
 * (App.tsx's dark palette) rather than the prototype's original navy/
 * orange theme, defined locally below so the component renders correctly
 * whether or not it's nested under App.tsx's own [data-theme] wrapper.
 */

const STRATEGY_OPTIONS: { v: ClosureStrategy; label: string }[] = [
  { v: 'lane', label: 'Right lane' },
  { v: 'center', label: 'Left lane' },
  { v: 'shoulder', label: 'Shoulder / bike' },
  { v: 'flagger', label: 'Flagger 1-lane' },
];
const LANE_OPTIONS: { v: number; label: string }[] = [{ v: 1, label: '1' }, { v: 2, label: '2' }, { v: 3, label: '3' }];
const ROAD_TYPE_OPTIONS: { v: RoadType; label: string }[] = [{ v: 'urban', label: 'Urban' }, { v: 'rural', label: 'Rural' }];
const ALIGN_OPTIONS: { v: Alignment; label: string }[] = [{ v: 'straight', label: 'Straight' }, { v: 'curve', label: 'Curve' }];

type StudioMode = 'plan' | 'intersection';

function SegGroup<T extends string | number>({
  options, value, onChange,
}: {
  options: { v: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded-lg p-1">
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          onClick={() => onChange(o.v)}
          aria-pressed={value === o.v}
          className={`flex-1 min-w-0 px-2 py-1.5 rounded-md text-[11px] font-semibold whitespace-nowrap transition-colors ${
            value === o.v
              ? 'bg-[var(--tcp-surface-1)] text-[var(--tcp-text-primary)] shadow-[0_0_0_1px_var(--tcp-border)]'
              : 'text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-secondary)]'
          }`}
        >
          {value === o.v && <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--tcp-accent)] mr-1.5 align-[1px]" />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-[12.5px] py-1 cursor-pointer select-none">
      <span className="text-[var(--tcp-text-secondary)]">{label}</span>
      <span className="relative inline-block w-9 h-5 shrink-0">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 opacity-0 cursor-pointer m-0"
        />
        <span className="absolute inset-0 rounded-full bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] transition-colors pointer-events-none peer-checked:bg-[var(--tcp-accent)] peer-checked:border-[var(--tcp-accent)]" />
        <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform pointer-events-none peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

export function LaneClosureTCPStudio() {
  const [params, setParams] = useState<LaneClosureParams>(() => JSON.parse(JSON.stringify(LANE_CLOSURE_PRESETS[4])));
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<StudioMode>('plan');
  // Which LANE_CLOSURE_PRESETS entry (a tag:'4-LEG' one) is backing the
  // intersection panel right now -- null only before the user has ever
  // picked one, which can't happen once the panel's own work-area button
  // is the only way into `mode === 'intersection'` (see the work-area list
  // below), but kept optional for safety.
  const [intersectionPresetIdx, setIntersectionPresetIdx] = useState<number | null>(null);
  const [nlText, setNlText] = useState('Close the curb lane on Reservation Rd for 150 ft, posted 35, bus stop and sidewalk closed');
  const [nlTags, setNlTags] = useState<string[]>([]);

  const lc = useLaneClosurePlanEngine(params, mode === 'plan');

  const updateParam = useCallback(<K extends keyof LaneClosureParams>(key: K, value: LaneClosureParams[K]) => {
    setParams((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  const selectPreset = useCallback((i: number) => {
    setParams(JSON.parse(JSON.stringify(LANE_CLOSURE_PRESETS[i])));
    setDirty(false);
    setMode('plan');
    lc.setSelKey(null);
    lc.fitView();
    lc.resetTraffic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectIntersectionPreset = useCallback((i: number) => {
    setMode('intersection');
    setIntersectionPresetIdx(i);
    lc.setSelKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDraftPlan = useCallback(() => {
    const { params: next, tags } = parseQuickDescribe(nlText, params);
    setParams(next);
    setNlTags(tags);
    setDirty(true);
    lc.setSelKey(null);
    lc.resetTraffic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nlText, params]);

  const themeVars = {
    '--tcp-canvas': '#0b121b',
    '--tcp-surface-1': '#101b28',
    '--tcp-surface-2': '#17283a',
    '--tcp-surface-3': '#1a2b3f',
    '--tcp-border': '#213c56',
    '--tcp-border-hover': '#2d4f6e',
    '--tcp-accent': '#e2600a',
    '--tcp-accent-hover': '#c9530a',
    '--tcp-text-primary': '#ffffff',
    '--tcp-text-secondary': '#cbd5e1',
    '--tcp-text-tertiary': '#94a3b8',
    '--tcp-text-muted': '#64748b',
    '--tcp-accent-15': 'rgba(226, 96, 10, 0.15)',
  } as React.CSSProperties;

  return (
    <div className="lc-tcp-studio h-full w-full flex flex-col bg-[var(--tcp-canvas)] text-[var(--tcp-text-secondary)] overflow-hidden" style={themeVars}>
      <style>{`
        .lc-tcp-studio .lc-stage .it{cursor:pointer}
        .lc-tcp-studio .lc-stage .it:hover{filter:drop-shadow(0 0 3px var(--tcp-accent))}
        .lc-tcp-studio .lc-stage .it.sel{filter:drop-shadow(0 0 4px #2c5db8) drop-shadow(0 0 2px #2c5db8)}
        .lc-tcp-studio .lc-stage .hl{transition:fill .15s}
        .lc-tcp-studio .lc-stage .hl.on{fill:rgba(226,96,10,.18)}
        .lc-tcp-studio .lc-stage .dim{cursor:pointer}
        .lc-tcp-studio .lc-stage .dim.on line{stroke:var(--tcp-accent)}
        .lc-tcp-studio .lc-stage .dim.on text{fill:var(--tcp-accent)}
        .lc-tcp-studio .lc-stage.lc-dragging{cursor:grabbing}
        .lc-tcp-studio .lc-live-box{background:rgba(11,18,27,.88);color:#e9eef9;border-radius:8px;padding:6px 10px;font-size:11px;line-height:1.25}
        .lc-tcp-studio .lc-live-box b{display:block;font-family:ui-monospace,"SFMono-Regular",Menlo,monospace;font-size:15px;font-weight:600}
        .lc-tcp-studio .lc-live-box.lc-live-phase b{color:#ffb27a}
      `}</style>

      {/* header */}
      <header className="h-14 bg-[var(--tcp-surface-1)] border-b border-[var(--tcp-border)] px-4 flex items-center gap-4 shrink-0">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="w-8 h-8 rounded bg-[var(--tcp-surface-2)] border border-[var(--tcp-border-hover)] flex items-center justify-center shadow-inner">
            <Route className="w-4 h-4 text-[var(--tcp-accent)]" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-bold text-sm text-[var(--tcp-text-primary)]">Lane Closure TCP</span>
            <span className="font-mono text-[9px] text-[var(--tcp-text-tertiary)] tracking-widest uppercase">Straight-road work zone</span>
          </div>
        </div>
        <div className="h-6 w-px bg-[var(--tcp-border)] shrink-0" />
        <div className="hidden sm:flex items-center gap-4 text-[11px] text-[var(--tcp-text-tertiary)] font-mono min-w-0">
          <span>WA <b className="text-[var(--tcp-text-primary)]">{params.wa}</b></span>
          <span>ROAD <b className="text-[var(--tcp-text-primary)] truncate">{params.road}</b></span>
        </div>
        <div className="flex-1" />
        <span className="hidden md:inline-block text-[11px] border border-[var(--tcp-border)] rounded-full px-2.5 py-1 text-[var(--tcp-text-tertiary)]">CA MUTCD 2026 · MUTCD 11th Ed.</span>
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-[300px_minmax(0,1fr)_330px] gap-4 p-4 overflow-auto items-start">
        {/* LEFT: inputs */}
        <aside className="flex flex-col gap-4 min-w-0">
          <section className="bg-[var(--tcp-surface-1)] border border-[var(--tcp-border)] rounded-lg">
            <div className="px-3.5 pt-3 pb-2 flex items-baseline justify-between">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-[var(--tcp-text-tertiary)]">Work areas</h2>
              <span className="text-[11px] text-[var(--tcp-text-muted)]">City of Marina set</span>
            </div>
            <div className="px-3.5 pb-3 flex flex-col gap-1.5">
              {LANE_CLOSURE_PRESETS.map((w, i) => {
                const isIntersection = w.tag === '4-LEG';
                const isActive = isIntersection
                  ? mode === 'intersection' && intersectionPresetIdx === i
                  : mode === 'plan' && params.wa === w.wa && params.tag === w.tag && !dirty;
                return (
                  <button
                    key={`${w.wa}-${w.tag || i}`}
                    type="button"
                    onClick={() => (isIntersection ? selectIntersectionPreset(i) : selectPreset(i))}
                    aria-pressed={isActive}
                    className={`grid grid-cols-[32px_1fr] gap-2.5 items-center text-left rounded-lg border px-2.5 py-2 transition-colors ${
                      isActive ? 'border-[var(--tcp-accent)] bg-[var(--tcp-accent-15)]' : 'border-[var(--tcp-border)] bg-[var(--tcp-surface-2)] hover:border-[var(--tcp-border-hover)]'
                    }`}
                  >
                    <span className={`font-mono font-bold text-[11px] w-8 h-8 rounded-md flex items-center justify-center ${isActive ? 'bg-[var(--tcp-accent)] text-white' : 'bg-[var(--tcp-surface-3)] text-[var(--tcp-text-primary)]'}`}>
                      WA{w.wa}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-semibold text-[12.5px] text-[var(--tcp-text-primary)] truncate">
                        {w.addr.replace(/\.$/, '')}
                        {w.tag && <span className="ml-1.5 inline-block bg-[var(--tcp-accent-15)] text-[var(--tcp-accent)] rounded px-1.5 py-0.5 text-[9.5px] font-bold align-middle">{w.tag}</span>}
                      </span>
                      <span className="block text-[11px] text-[var(--tcp-text-tertiary)] truncate">
                        {isIntersection
                          ? `${w.road.replace(/\.$/, '')} & ${(w.xroad || '').replace(/\.$/, '')} · ${w.speed}/${w.xspeed} mph`
                          : `${STRATEGY_LABELS[w.strategy]} · ${w.speed} mph · ${w.access.replace(' ACCESS', '')}`}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="bg-[var(--tcp-surface-1)] border border-[var(--tcp-border)] rounded-lg">
            <div className="px-3.5 pt-3 pb-2"><h2 className="text-[11px] font-bold uppercase tracking-wider text-[var(--tcp-text-tertiary)]">Quick describe</h2></div>
            <div className="px-3.5 pb-3.5 flex flex-col gap-2">
              <textarea
                value={nlText}
                onChange={(e) => setNlText(e.target.value)}
                aria-label="Describe the job"
                className="w-full min-h-[62px] resize-y bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded-md px-2.5 py-2 text-[12.5px] text-[var(--tcp-text-primary)] outline-none focus:border-[var(--tcp-accent)]"
              />
              <div className="flex items-center gap-2 flex-wrap">
                <button type="button" onClick={handleDraftPlan} className="px-3 py-1.5 rounded-md bg-[var(--tcp-accent)] hover:bg-[var(--tcp-accent-hover)] text-white text-[12px] font-bold">Draft plan</button>
                <span className="text-[11px] text-[var(--tcp-text-tertiary)]">
                  {nlTags.length ? nlTags.map((t) => <span key={t} className="inline-block bg-[var(--tcp-surface-3)] text-[var(--tcp-text-secondary)] rounded px-1.5 py-0.5 mr-1 mt-1 font-semibold text-[10.5px]">{t}</span>) : 'Reads speed, length, closure type and sidewalk/bus stop.'}
                </span>
              </div>
            </div>
          </section>

          <section className="bg-[var(--tcp-surface-1)] border border-[var(--tcp-border)] rounded-lg">
            <div className="px-3.5 pt-3 pb-2 flex items-baseline justify-between">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-[var(--tcp-text-tertiary)]">Parameters</h2>
              {dirty && <span className="text-[11px] text-[var(--tcp-text-muted)]">edited</span>}
            </div>
            <div className="px-3.5 pb-3.5 flex flex-col gap-3.5">
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-[var(--tcp-text-tertiary)]">Road</label>
                <input
                  type="text"
                  value={params.road}
                  onChange={(e) => updateParam('road', e.target.value.toUpperCase())}
                  className="w-full bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded-md px-2.5 py-1.5 text-[12.5px] text-[var(--tcp-text-primary)] outline-none focus:border-[var(--tcp-accent)]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between items-baseline">
                  <label className="text-[11px] font-semibold text-[var(--tcp-text-tertiary)]">Posted speed (S)</label>
                  <output className="font-mono font-semibold text-[13px] text-[var(--tcp-text-primary)]">{params.speed} mph</output>
                </div>
                <input type="range" min={20} max={75} step={5} value={params.speed} onChange={(e) => updateParam('speed', Number(e.target.value))} className="w-full accent-[var(--tcp-accent)]" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold text-[var(--tcp-text-tertiary)]">Alignment</span>
                <SegGroup
                  options={ALIGN_OPTIONS}
                  value={params.align === 'curve' ? 'curve' : 'straight'}
                  onChange={(v) => { setParams((prev) => ({ ...prev, align: v, curveDeg: v === 'curve' ? (prev.curveDeg ?? 45) : prev.curveDeg })); setDirty(true); }}
                />
              </div>
              {params.align === 'curve' && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-baseline">
                    <label className="text-[11px] font-semibold text-[var(--tcp-text-tertiary)]">Curve deflection (Δ)</label>
                    <output className="font-mono font-semibold text-[13px] text-[var(--tcp-text-primary)]">{params.curveDeg ?? 45}°</output>
                  </div>
                  <input type="range" min={15} max={60} step={5} value={params.curveDeg ?? 45} onChange={(e) => updateParam('curveDeg', Number(e.target.value))} className="w-full accent-[var(--tcp-accent)]" />
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold text-[var(--tcp-text-tertiary)]">Closure strategy</span>
                <SegGroup options={STRATEGY_OPTIONS} value={params.strategy} onChange={(v) => updateParam('strategy', v)} />
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-semibold text-[var(--tcp-text-tertiary)]">Lanes each way</span>
                  <SegGroup options={LANE_OPTIONS} value={params.lanes} onChange={(v) => updateParam('lanes', v)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-semibold text-[var(--tcp-text-tertiary)]">Road type</span>
                  <SegGroup options={ROAD_TYPE_OPTIONS} value={params.roadType} onChange={(v) => updateParam('roadType', v)} />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between items-baseline">
                  <label className="text-[11px] font-semibold text-[var(--tcp-text-tertiary)]">Offset width (W)</label>
                  <output className="font-mono font-semibold text-[13px] text-[var(--tcp-text-primary)]">{params.offset} ft</output>
                </div>
                <input type="range" min={4} max={14} step={1} value={params.offset} onChange={(e) => updateParam('offset', Number(e.target.value))} className="w-full accent-[var(--tcp-accent)]" />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between items-baseline">
                  <label className="text-[11px] font-semibold text-[var(--tcp-text-tertiary)]">Work space length</label>
                  <output className="font-mono font-semibold text-[13px] text-[var(--tcp-text-primary)]">{params.work} ft</output>
                </div>
                <input type="range" min={20} max={600} step={10} value={params.work} onChange={(e) => updateParam('work', Number(e.target.value))} className="w-full accent-[var(--tcp-accent)]" />
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-semibold text-[var(--tcp-text-tertiary)]">Work starts</label>
                  <input type="time" value={params.hs} onChange={(e) => updateParam('hs', e.target.value)} className="w-full bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded-md px-2 py-1.5 text-[12.5px] text-[var(--tcp-text-primary)] outline-none focus:border-[var(--tcp-accent)]" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-semibold text-[var(--tcp-text-tertiary)]">Work ends</label>
                  <input type="time" value={params.he} onChange={(e) => updateParam('he', e.target.value)} className="w-full bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded-md px-2 py-1.5 text-[12.5px] text-[var(--tcp-text-primary)] outline-none focus:border-[var(--tcp-accent)]" />
                </div>
              </div>
              <div className="flex flex-col">
                <ToggleRow label="Sidewalk closed" checked={params.sidewalk} onChange={(v) => updateParam('sidewalk', v)} />
                <ToggleRow label="Bus stop in work zone" checked={params.bus} onChange={(v) => updateParam('bus', v)} />
                <ToggleRow label="Near signalized intersection" checked={params.signal} onChange={(v) => updateParam('signal', v)} />
              </div>
              <hr className="border-[var(--tcp-border)]" />
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between items-baseline">
                  <label className="text-[11px] font-semibold text-[var(--tcp-text-tertiary)]">Simulated traffic</label>
                  <output className="font-mono font-semibold text-[13px] text-[var(--tcp-text-primary)]">{lc.simVolume} veh/min/lane</output>
                </div>
                <input type="range" min={2} max={30} step={1} value={lc.simVolume} onChange={(e) => lc.setSimVolume(Number(e.target.value))} className="w-full accent-[var(--tcp-accent)]" />
              </div>
            </div>
          </section>
        </aside>

        {mode === 'plan' ? (
          <>
            {/* CENTER: plan sheet + tabs */}
            <LaneClosureDiagramStage params={params} laneClosure={lc} />

            {/* RIGHT: calc + compliance */}
            <LaneClosureSummaryPanel laneClosure={lc} />
          </>
        ) : (
          /* CENTER + RIGHT merged: the 4-leg intersection panel owns its
           * own plan sheet, calc/compliance and closure-parameters UI, so
           * it takes both columns rather than splitting into the
           * straight-road layout's stage/summary pair. */
          <LaneClosureIntersectionPanel preset={intersectionPresetIdx != null ? LANE_CLOSURE_PRESETS[intersectionPresetIdx] : undefined} />
        )}
      </div>
    </div>
  );
}
