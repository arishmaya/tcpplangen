/**
 * roadDetectApi.ts
 * =================
 * Client for the two new CV auto-trace endpoints (road_detection_endpoint.py):
 *
 *   POST /api/road-detect/detect       -- screenshot (+ optional px box) -> per-leg
 *                                          detected geometry + an overlay PNG to eyeball
 *   POST /api/road-detect/regenerate   -- the (possibly hand-corrected) per-leg geometry
 *                                          + site metadata -> the real phased TCP plan set
 *
 * This is the "integrate the attached detect.py / tcp_from_screenshot.py solution" path:
 * CV finds the roads in a screenshot instead of a person tracing them on the map, and the
 * one thing a person corrects afterward is a plain numeric form (see RoadDetectPanel.tsx),
 * not a drag-on-image editor -- the full vanilla-JS trace editor those attachments also
 * contained was NOT ported; see the project's "site-json-schema-and-autogen.md" doc.
 *
 * Both endpoints take the aerial image as a real multipart upload (`FormData`), exactly
 * like `generateFullIntersectionPlan` in fullIntersectionPlanApi.ts already does for
 * `/api/tcp-intersection-full-plan` -- NOT a server-side file path, since the browser has
 * no such path to give. `/regenerate` re-uploads the same image rather than referencing
 * `/detect`'s result server-side, keeping both endpoints stateless; the browser already
 * holds the File from the first step, so this is one extra upload, not a re-pick by the
 * user (see RoadDetectPanel.tsx, which keeps the File in state between steps).
 */

// ---------------------------------------------------------------------------
// /detect
// ---------------------------------------------------------------------------

export interface DetectedCenter {
  x: number;
  y: number;
}

/** Mirrors road_detection_cv's own per-leg output field-for-field. This exact shape (minus
 * the fields a person can't correct: cen_t/stop/xw/zebra/road_idx/opp) is what the
 * correction form edits and `/regenerate` expects back as a `LegOverride`. */
export interface DetectedLeg {
  ang: number;
  curbL: number;
  curbR: number;
  cen_t: string;
  cen_a: number;
  cen_b: number;
  nIn: number;
  nOut: number;
  inBikeFt: number;
  outBikeFt: number;
  stop: number;
  xw: number[];
  zebra: boolean;
  road_idx: number;
  opp: string;
}

export interface DetectRoadGeometryResult {
  center: DetectedCenter;
  ftPerPx: number;
  box: [number, number, number, number];
  /** Leg keys in detection order, e.g. ["N","E","S","W"] (or 8-point compass on a skewed site). */
  order: string[];
  legs: Record<string, DetectedLeg>;
  /** `data:image/png;base64,...` -- the screenshot with the traced lines drawn on it, ready
   * for an <img src=...> with no further decoding. */
  overlayDataUrl: string;
}

export interface DetectRoadGeometryOptions {
  /** [x0,y0,x1,y1] px; omit to let the backend find the drawn blue work-limit box itself. */
  box?: [number, number, number, number];
}

/**
 * POSTs the aerial screenshot to /api/road-detect/detect and resolves with one entry per
 * detected leg plus a quick-look overlay image. Throws with the server's `detail` message
 * on a non-2xx response (422 = no box found / detection failed on this image).
 */
export async function detectRoadGeometry(
  image: File | Blob,
  ftPerPx: number,
  opts: DetectRoadGeometryOptions = {},
): Promise<DetectRoadGeometryResult> {
  const form = new FormData();
  const imageName = image instanceof File ? image.name : 'site.png';
  form.append('image', image, imageName);
  form.append('ft_per_px', String(ftPerPx));
  if (opts.box) form.append('box', JSON.stringify(opts.box));

  const resp = await fetch('/api/road-detect/detect', { method: 'POST', body: form });
  const body = await readJsonOrThrow(resp);
  return {
    center: body.center,
    ftPerPx: body.ft_per_px,
    box: body.box,
    order: body.order,
    legs: body.legs,
    overlayDataUrl: `data:image/png;base64,${body.overlay_png_base64}`,
  };
}

// ---------------------------------------------------------------------------
// /regenerate
// ---------------------------------------------------------------------------

/** What the correction form actually edits per leg, pre-filled from a `DetectedLeg` (see
 * `detectedLegToOverride` below) plus the handful of fields the CV can't infer. This is the
 * exact shape `/api/road-detect/regenerate` expects in its JSON-encoded `legs` field. */
export interface LegOverride {
  ang: number;
  curbL: number;
  curbR: number;
  cen_a: number;
  cen_b: number;
  nIn: number;
  nOut: number;
  inBikeFt: number;
  outBikeFt: number;
  speedMph: number;
  /** Distance (ft) from the intersection centre to where this leg's true-scale trace starts. */
  nearFt: number;
  /** Distance (ft) from the intersection centre to the true-scale crop's outer edge. */
  farFt: number;
  stopSetbackFt: number;
  hasLtLane: boolean;
  railCrossingFt: number | null;
}

/** Seeds a `LegOverride` from what `/detect` found for one leg -- the geometry fields
 * round-trip as-is; `speedMph`/`nearFt`/`farFt`/`stopSetbackFt`/`hasLtLane`/`railCrossingFt`
 * get sensible defaults the person fills in via the form (the CV has no way to infer a
 * posted speed limit, a planned lane closure, or a rail crossing from pixels alone). */
export function detectedLegToOverride(leg: DetectedLeg, defaultSpeedMph = 35): LegOverride {
  return {
    ang: leg.ang,
    curbL: leg.curbL,
    curbR: leg.curbR,
    cen_a: leg.cen_a,
    cen_b: leg.cen_b,
    nIn: leg.nIn,
    nOut: leg.nOut,
    inBikeFt: leg.inBikeFt,
    outBikeFt: leg.outBikeFt,
    speedMph: defaultSpeedMph,
    nearFt: 20,
    farFt: 150,
    stopSetbackFt: 15,
    hasLtLane: false,
    railCrossingFt: null,
  };
}

export type RoadDetectPlanOutput = 'pdf' | 'dxf' | 'bundle' | 'viewer';

export interface RegenerateRoadDetectPlanOptions {
  /** The SAME screenshot sent to `detectRoadGeometry` -- re-uploaded; see module docstring. */
  image: File | Blob;
  center: DetectedCenter;
  ftPerPx: number;
  /** 2-4 entries, keyed however `/detect` keyed them (e.g. "N"/"E"/"S"/"W"). */
  legs: Record<string, LegOverride>;
  output?: RoadDetectPlanOutput; // default 'pdf'
  style?: 'aerial' | 'cad'; // default 'cad'
  project?: string;
  location?: string;
  short?: string;
  laneFt?: number;
  hours?: string;
  ewName?: string;
  nsName?: string;
  ewSpeed?: number;
  nsSpeed?: number;
  /** Filename for the downloaded file (extension is added automatically). */
  filenameBase?: string;
}

const EXT_BY_OUTPUT: Record<RoadDetectPlanOutput, string> = { pdf: 'pdf', dxf: 'dxf', bundle: 'zip', viewer: 'html' };
const MIME_BY_OUTPUT: Record<RoadDetectPlanOutput, string> = {
  pdf: 'application/pdf',
  dxf: 'application/dxf',
  bundle: 'application/zip',
  viewer: 'text/html',
};

export interface GeneratedRoadDetectPlan {
  blob: Blob;
  /** Object URL for `blob` (`URL.createObjectURL`) -- suitable directly as an <iframe src>
   * for 'pdf'/'viewer'. The CALLER owns this URL and must `URL.revokeObjectURL(url)` it once
   * no longer shown (e.g. on unmount, or before generating a new one). */
  url: string;
  filename: string;
  output: RoadDetectPlanOutput;
  /** Server-assigned id for this generation run (from the `X-Job-Id` response header), for
   * reference/debugging only -- nothing client-side depends on it. */
  jobId?: string;
}

function legOverrideToWire(lo: LegOverride) {
  return {
    ang: lo.ang,
    curbL: lo.curbL,
    curbR: lo.curbR,
    cen_a: lo.cen_a,
    cen_b: lo.cen_b,
    nIn: lo.nIn,
    nOut: lo.nOut,
    inBikeFt: lo.inBikeFt,
    outBikeFt: lo.outBikeFt,
    speed_mph: lo.speedMph,
    near_ft: lo.nearFt,
    far_ft: lo.farFt,
    stop_setback_ft: lo.stopSetbackFt,
    has_lt_lane: lo.hasLtLane,
    rail_crossing_ft: lo.railCrossingFt,
  };
}

/**
 * POSTs the (possibly-corrected) per-leg geometry + site metadata + the aerial screenshot to
 * /api/road-detect/regenerate and resolves with the raw blob plus an object URL for it --
 * suitable for an in-page preview (`<iframe src={result.url} />`, for `output: 'pdf'` or
 * `'viewer'`) as well as a manual download (`<a href={result.url} download={result.filename}>`).
 * Doesn't touch the DOM itself; see `exportRoadDetectPlan` below for a one-call version that
 * downloads immediately. Throws with the server's `detail` message on a non-2xx response.
 */
export async function regenerateRoadDetectPlan(
  opts: RegenerateRoadDetectPlanOptions,
): Promise<GeneratedRoadDetectPlan> {
  const output = opts.output ?? 'pdf';
  const legsWire: Record<string, ReturnType<typeof legOverrideToWire>> = {};
  for (const [key, lo] of Object.entries(opts.legs)) legsWire[key] = legOverrideToWire(lo);

  const form = new FormData();
  const imageName = opts.image instanceof File ? opts.image.name : 'site.png';
  form.append('image', opts.image, imageName);
  form.append('center_x', String(opts.center.x));
  form.append('center_y', String(opts.center.y));
  form.append('ft_per_px', String(opts.ftPerPx));
  form.append('legs', JSON.stringify(legsWire));
  form.append('output', output);
  form.append('style', opts.style ?? 'cad');
  if (opts.project) form.append('project', opts.project);
  if (opts.location) form.append('location', opts.location);
  if (opts.short) form.append('short', opts.short);
  if (opts.laneFt != null) form.append('lane_ft', String(opts.laneFt));
  if (opts.hours) form.append('hours', opts.hours);
  if (opts.ewName) form.append('ew_name', opts.ewName);
  if (opts.nsName) form.append('ns_name', opts.nsName);
  if (opts.ewSpeed != null) form.append('ew_speed', String(opts.ewSpeed));
  if (opts.nsSpeed != null) form.append('ns_speed', String(opts.nsSpeed));

  const resp = await fetch('/api/road-detect/regenerate', { method: 'POST', body: form });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body?.detail) detail = body.detail;
    } catch {
      /* non-JSON error body, fall back to status text */
    }
    throw new Error(detail);
  }

  const rawBlob = await resp.blob();
  const blob = rawBlob.type ? rawBlob : new Blob([rawBlob], { type: MIME_BY_OUTPUT[output] });
  const url = URL.createObjectURL(blob);
  const base = (opts.filenameBase || opts.short || opts.project || 'road-detect-tcp').replace(/[^\w.-]+/g, '_');
  const filename = `${base}.${EXT_BY_OUTPUT[output]}`;
  return { blob, url, filename, output, jobId: resp.headers.get('X-Job-Id') ?? undefined };
}

/**
 * Same as `regenerateRoadDetectPlan`, but immediately triggers a browser download of the
 * result and revokes the object URL afterwards -- use this when you don't need an in-page
 * preview (e.g. DXF/bundle outputs, which browsers can't render inline anyway).
 */
export async function exportRoadDetectPlan(opts: RegenerateRoadDetectPlanOptions): Promise<void> {
  const { url, filename } = await regenerateRoadDetectPlan(opts);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function readJsonOrThrow(resp: Response): Promise<any> {
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body?.detail) detail = body.detail;
    } catch {
      /* non-JSON error body, fall back to status text */
    }
    throw new Error(detail);
  }
  return resp.json();
}
