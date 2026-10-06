/**
 * fullIntersectionPlanApi.ts
 * ===========================
 * Client for POST /api/tcp-intersection-full-plan (app.py) -- the endpoint that wraps
 * tcp_intersection_generator.py (an in-repo, behavior-preserving refactor of the user's
 * own reference script `tcp_intersection.py`). Given an aerial screenshot with the work
 * limits outlined in blue, plus a "site" config describing the intersection's roads, legs
 * and lane geometry, it runs the FULL 5-phase pipeline and returns the same aerial-backed,
 * phase-by-phase plan set the reference script itself produces (verified server-side to be
 * byte-identical to the reference script's own output for the sample sites).
 *
 * This is DIFFERENT from `handleExportPlan` in TracedIntersectionDiagram.tsx, which posts
 * the app's own already-computed `IntersectionPlan` (intersectionTcpEngine.ts) to
 * /api/tcp-intersection-plan-pdf|dxf for a single schematic N.T.S. sheet, no aerial image,
 * no construction phasing. This module is the export path for the reference-quality,
 * aerial-backed, multi-phase plan set instead -- it needs the richer `IntersectionSiteConfig`
 * below (see sites/site1_orthogonal.json / site2_skewed.json for worked examples), not the
 * IntersectionPlan the on-screen traced-intersection engine computes.
 *
 * IMPORTANT -- what this module does NOT include: nothing in this codebase currently
 * produces an `IntersectionSiteConfig` from a screenshot (i.e. there is no UI yet for
 * outlining the work limits in blue and digitizing each leg's lane geometry/box/dirs). This
 * module only covers the "send screenshot + site JSON to the Python API, get the exact plan
 * set back" plumbing that was asked for. Building the authoring/tracing UI that produces the
 * site JSON is a separate, larger piece of work.
 */

// ---------------------------------------------------------------------------
// Site config schema (mirrors sites/site1_orthogonal.json & site2_skewed.json exactly --
// field-for-field, so an object built to this shape can be JSON.stringify()'d straight into
// the `site` form field with no transformation).
// ---------------------------------------------------------------------------

export interface IntersectionSiteRoad {
  name: string;
  speed: number;
  area: 'urban' | 'rural';
  legs: string[]; // leg ids, e.g. ["W", "E"]
}

export interface IntersectionSiteDirection {
  role: 'approach' | 'departure';
  o: 1 | -1; // lateral sign toward this direction's curb
  lanes: number;
  /** Outer edge of lane 1 (median-side lane), as (along, lateral) px pairs, rotated frame. */
  l12: Array<[number, number]>;
  /** (curb, median-side edge) lateral px at the box end. */
  near: [number, number];
}

export interface IntersectionSiteLeg {
  label: string;
  road: 'EW' | 'NS';
  axis: 'x' | 'y';
  limit: number; // px, along-axis extent of the work limit on this leg
  box_edge: number; // px
  stop: number; // px, stop-bar position
  toward_box: 1 | -1;
  dirs: Record<string, IntersectionSiteDirection>; // keyed by direction code, e.g. "EB"/"WB"
}

export interface IntersectionSiteFeature {
  kind: 'median_opening' | 'rail_crossing';
  leg: string;
  label?: string;
  s_ft?: number; // median_opening
  along?: number; // rail_crossing, px
}

export interface IntersectionSiteConfig {
  project: string;
  location: string;
  short: string;
  image: string; // display label only -- the actual uploaded file is what gets rendered
  rotate_deg: number;
  tables: 'national' | 'ca';
  standard: string;
  ft_per_px: number;
  lane_ft: number;
  hours: string;
  roads: { EW: IntersectionSiteRoad; NS: IntersectionSiteRoad };
  box: { x0: number; x1: number; y0: number; y1: number };
  legs: Record<string, IntersectionSiteLeg>; // keyed by leg id, e.g. "W"/"E"/"N"/"S"
  dual_lefts?: Record<string, { line: number; bay_start: number; stop: number }>;
  lt_lanes?: Record<string, [number, number]>;
  features?: IntersectionSiteFeature[];
  crop_lateral?: { EW?: [number, number]; NS?: [number, number] };
  phase_notes?: Record<string, string[]>;
  summary?: Array<[string, string]>;
}

export type FullIntersectionPlanOutput = 'pdf' | 'dxf' | 'bundle' | 'viewer';

export interface ExportFullIntersectionPlanOptions {
  output?: FullIntersectionPlanOutput; // default 'pdf'
  speedEw?: number; // override site.roads.EW.speed
  speedNs?: number; // override site.roads.NS.speed
  ftPerPx?: number; // override site.ft_per_px
  /**
   * 'aerial' (default): true-scale photo background, as before.
   * 'cad': no photo -- schematic road linework only (pavement/median/lane dashes/curb/
   * sidewalk/crosswalk), drawn from the same site geometry. Smaller file, print-friendly,
   * no dependency on how well the aerial photo captured the site. Everything else (phase
   * split, MUTCD values, signs/devices, DXF, CSV) is identical between the two styles.
   */
  style?: 'aerial' | 'cad';
  /** Filename for the downloaded file (extension is added automatically). */
  filenameBase?: string;
}

const EXT_BY_OUTPUT: Record<FullIntersectionPlanOutput, string> = {
  pdf: 'pdf',
  dxf: 'dxf',
  bundle: 'zip',
  viewer: 'html',
};

const MIME_BY_OUTPUT: Record<FullIntersectionPlanOutput, string> = {
  pdf: 'application/pdf',
  dxf: 'application/dxf',
  bundle: 'application/zip',
  viewer: 'text/html',
};

export interface GeneratedFullIntersectionPlan {
  /** The raw response body. */
  blob: Blob;
  /**
   * An object URL for `blob` (`URL.createObjectURL`). For `output: 'pdf'` or `output: 'viewer'`
   * this can be set directly as an <iframe> `src` to render the plan in-page -- browsers open a
   * blob: PDF URL in their built-in PDF viewer, and a blob: HTML URL renders the interactive
   * viewer page (sheet switcher, pan/zoom SVG stage, sign/device/compliance tabs) the same way
   * any other page would. The CALLER owns this URL and must revoke it with
   * `URL.revokeObjectURL(url)` once it's no longer shown/needed (e.g. on unmount or
   * before generating a new one), since nothing here revokes it automatically.
   */
  url: string;
  filename: string;
  output: FullIntersectionPlanOutput;
}

/**
 * POSTs the aerial screenshot + site config to /api/tcp-intersection-full-plan and resolves
 * with the raw blob plus an object URL for it -- suitable for an in-page PDF preview
 * (`<iframe src={result.url} />`) as well as for a manual "Download" action
 * (`<a href={result.url} download={result.filename}>`). Doesn't touch the DOM itself; see
 * `exportFullIntersectionPlan` below for a one-call version that downloads immediately.
 *
 * Throws with the server's `detail` message on a non-2xx response (422 = bad/incomplete site
 * JSON or empty image; 500 = generation failed; 503 = DXF requested but ezdxf unavailable).
 */
export async function generateFullIntersectionPlan(
  image: File | Blob,
  site: IntersectionSiteConfig,
  opts: ExportFullIntersectionPlanOptions = {},
): Promise<GeneratedFullIntersectionPlan> {
  const output = opts.output ?? 'pdf';
  const form = new FormData();
  const imageName = image instanceof File ? image.name : `${site.image || 'site'}.png`;
  form.append('image', image, imageName);
  form.append('site', JSON.stringify(site));
  form.append('output', output);
  if (opts.speedEw != null) form.append('speed_ew', String(opts.speedEw));
  if (opts.speedNs != null) form.append('speed_ns', String(opts.speedNs));
  if (opts.ftPerPx != null) form.append('ft_per_px', String(opts.ftPerPx));
  if (opts.style) form.append('style', opts.style);

  const resp = await fetch('/api/tcp-intersection-full-plan', { method: 'POST', body: form });
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
  // Force the MIME type: some servers/proxies can hand back a generic
  // application/octet-stream content-type, and a plain <iframe> won't render that as a PDF.
  const blob = rawBlob.type ? rawBlob : new Blob([rawBlob], { type: MIME_BY_OUTPUT[output] });
  const url = URL.createObjectURL(blob);
  const base = (opts.filenameBase || site.short || site.project || 'intersection-tcp').replace(/[^\w.-]+/g, '_');
  const filename = `${base}.${EXT_BY_OUTPUT[output]}`;
  return { blob, url, filename, output };
}

/**
 * Same as `generateFullIntersectionPlan`, but immediately triggers a browser download of the
 * result and revokes the object URL afterwards -- use this when you don't need an in-page
 * preview (e.g. DXF/bundle outputs, which browsers can't render inline anyway).
 */
export async function exportFullIntersectionPlan(
  image: File | Blob,
  site: IntersectionSiteConfig,
  opts: ExportFullIntersectionPlanOptions = {},
): Promise<void> {
  const { url, filename } = await generateFullIntersectionPlan(image, site, opts);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
