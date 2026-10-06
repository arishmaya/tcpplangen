import { LatLng } from './types';
import { TracedFeature, resolvedPoints, WORK_LIMIT_BLUE_RGB } from './tracedGeometry';
import {
  IntersectionSiteConfig,
  IntersectionSiteRoad,
  IntersectionSiteLeg,
  IntersectionSiteDirection,
} from './fullIntersectionPlanApi';

/**
 * siteConfigBuilder.ts
 * =====================
 * Assembles an `IntersectionSiteConfig` (the JSON tcp_intersection_generator.py needs)
 * automatically from data this app already has -- OSM-derived road geometry, per-road
 * speed/lane lookups, a captured map screenshot, and the user's hand-traced work-limit
 * polygon (the new 'work_limit' TracedFeatureType) -- instead of requiring someone to
 * hand-author the JSON the way sites/site1_orthogonal.json etc. were built.
 *
 * WHAT THIS DOES vs. WHAT IT CAN'T DO
 * ------------------------------------
 * Fully exact, not approximated:
 *   - ft_per_px: derived from the screenshot's zoom level + latitude via the same Web
 *     Mercator tile math Google/Bing/OSM all use (256px base tile, doubling per zoom
 *     level) -- no manual "measure a 12ft lane in pixels" step.
 *   - rotate_deg + all leg/box pixel coordinates: computed in the SAME rotated frame
 *     tcp_intersection_generator.py's own rotation_matrix() produces when it rotates the
 *     uploaded (unrotated) screenshot by this rotate_deg -- verified byte-for-byte
 *     against that actual function (see the module's test harness), not just derived by
 *     hand. Get this wrong and every leg/sign/dimension silently lands in the wrong place
 *     on the rendered sheet, so this is the one piece that was cross-checked numerically
 *     against the real script rather than just reasoned about.
 *
 * Reasonable approximations (per-project decision: "good-enough auto-fill", not
 * survey-grade digitizing):
 *   - Per-direction lane geometry (l12/near) is built from ONE OSM centerline per leg,
 *     offset by lane count x a standard lane width either side of a small assumed median
 *     gap -- not two separately-digitized carriageway polylines. Fine for rendering a
 *     plan; not a substitute for as-built lane lines.
 *   - The intersection `box` is sized from each road's own lane-count x lane-width (i.e.
 *     roughly curb-to-curb), which undershoots real intersections with turn bays/medians
 *     wider than through lanes alone. Nudge `box`/`limit`/`stop` by hand afterward for a
 *     site where that matters.
 *   - Both directions of a leg are assumed to have the same lane count (this app's
 *     existing per-road lookups return one "lanes this direction" figure per road, not
 *     per direction).
 *
 * Fundamentally NOT automatable, by design: the work-limit polygon itself. Which lanes
 * and how far are actually being closed is a permit/construction decision, not a fact
 * about the road network -- see the 'work_limit' TracedFeatureType added to
 * tracedGeometry.ts for why this stays a hand-traced input.
 */

// ---------------------------------------------------------------------------
// Inputs already available in App.tsx state
// ---------------------------------------------------------------------------

/** Mirrors the (locally-declared, unexported) `RoadNetworkSegment` interface in App.tsx.
 * TypeScript's structural typing means App.tsx's own array satisfies this without either
 * file needing to import from the other. */
export interface RoadNetworkSegment {
  name: string;
  highway: string;
  /** Ordered polyline in real lat/lng. Either end may be nearest the intersection --
   * this module figures that out from distance to `center`, not array order. */
  points: LatLng[];
}

/** Per-road-segment speed/lane data, however the caller already has it on hand -- e.g.
 * from the existing `/api/road-reference` lookup (`ref.speedLimitMph`/`ref.lanesThisDirection`)
 * that's already called once per neighbor road, or from `design.speed`/`design.lanes` for
 * the primary road. Keyed by the matching `RoadNetworkSegment.name`. */
export interface RoadSpeedLaneInfo {
  speedLimitMph: number;
  lanesThisDirection: number;
  area?: 'urban' | 'rural';
}

/** The exact geographic extent a captured image covers -- e.g. what
 * GoogleMapViewHandle.captureScreenshot() already returns as `bounds` (computed
 * server-side in maps_service.py's static_map_geo_bounds, run against whichever
 * center/zoom the image was ACTUALLY requested at). */
export interface ImageGeoBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface ScreenshotFrame {
  /** The lat/lng the captured screenshot is centered on. */
  center: LatLng;
  /** The zoom level used at capture (Google/OSM slippy-map convention). */
  zoom: number;
  /** The CAPTURED IMAGE's actual pixel dimensions (measure these from the real PNG/JPEG
   * blob -- e.g. via `measureImageDimensions()` below -- rather than assuming they equal
   * whatever CSS size the map element was; a HiDPI capture is very often 2x-3x that). */
  widthPx: number;
  heightPx: number;
  /**
   * Extra scale-up baked into the captured pixels beyond what `widthPx`/`heightPx` already
   * measure -- leave at 1 (the default) in the normal case, since `widthPx`/`heightPx`
   * being the ACTUAL measured image dimensions already accounts for any HiDPI capture.
   * IGNORED whenever `bounds` (below) is provided -- an exact ratio is derived from that
   * instead. Only relevant as a fallback when `bounds` isn't available (e.g. the Leaflet/
   * GISMap capture path, a raw 1:1 canvas snapshot with no separate bounds computation).
   */
  pixelRatio?: number;
  /**
   * The captured image's exact geographic bounds, when the capture path already computed
   * them server-side -- GoogleMapViewHandle.captureScreenshot()'s `bounds` field is
   * exactly this. When present, this is used INSTEAD of `pixelRatio` to derive the true
   * scale, by comparing the bounds' own Mercator world-pixel span against the image's
   * actual measured width/height -- e.g. Google's Static Maps API is always requested
   * with `scale=2` (maps_service.py), which doubles the returned pixel density for the
   * SAME geographic footprint (`bounds` is computed from the logical, un-doubled size,
   * per that file's own static_map_geo_bounds docstring) -- exactly the "guessed wrong"
   * failure mode this app's own magic-wand tool already hit and fixed by switching to
   * bounds-based georeferencing (see fetch_static_map_image's docstring) instead of
   * assuming a scale factor. Deriving the ratio from `bounds` here the same way sidesteps
   * needing to know or hardcode that `scale=2` at all, and stays correct even if it changes.
   */
  bounds?: ImageGeoBounds;
}

/** The effective `pixelRatio` for a frame: derived exactly from `frame.bounds` (comparing
 * the bounds' own Mercator world-pixel span at `frame.zoom` against the image's actual
 * measured width/height) when bounds are available, otherwise `frame.pixelRatio ?? 1`.
 * Factored out so `makeProjector` and `feetPerPixel` can't drift out of sync on which one
 * they use. */
export function effectivePixelRatio(frame: ScreenshotFrame): number {
  if (!frame.bounds) return frame.pixelRatio ?? 1;
  const { north, south, east, west } = frame.bounds;
  // World-pixel span at ratio=1 ("logical", pre-scale-multiplier) -- x depends only on
  // lng, y only on lat, so this needs the west/east and north/south pair, not all 4
  // combined into corner points.
  const xWest = latLngToWorldPx(0, west, frame.zoom, 1).x;
  const xEast = latLngToWorldPx(0, east, frame.zoom, 1).x;
  const yNorth = latLngToWorldPx(north, 0, frame.zoom, 1).y;
  const ySouth = latLngToWorldPx(south, 0, frame.zoom, 1).y;
  const logicalWidth = Math.abs(xEast - xWest);
  const logicalHeight = Math.abs(ySouth - yNorth);
  if (logicalWidth < 1e-6 || logicalHeight < 1e-6) return frame.pixelRatio ?? 1;
  // Average the width- and height-derived ratios -- they should already agree closely
  // (both come from the same square capture), this just averages out rounding noise
  // rather than trusting one axis arbitrarily.
  return (frame.widthPx / logicalWidth + frame.heightPx / logicalHeight) / 2;
}

/** Loads a blob as an <img> just long enough to read its true pixel dimensions --
 * the only reliable source of truth for `ScreenshotFrame.widthPx/heightPx`, since a
 * screenshot's actual pixel size shouldn't be assumed from the map element's CSS size. */
export function measureImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e instanceof ErrorEvent ? e.error : new Error('Could not read image dimensions'));
    };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Web Mercator projection (lat/lng -> screenshot pixel, BEFORE rotation)
// ---------------------------------------------------------------------------
// Standard 256px-tile Web Mercator world-pixel formula, identical to what Google Maps,
// Bing and every OSM slippy-map viewer use internally (google.maps.Map's own
// getProjection() implements the same math). Verified by round-trip (project then
// invert) and against known reference values (lng=-180 -> x=0, lng=180 -> x=256 at
// zoom 0, etc.) in the module's test harness.

function latLngToWorldPx(lat: number, lng: number, zoom: number, pixelRatio: number): { x: number; y: number } {
  const scale = 256 * Math.pow(2, zoom) * pixelRatio;
  const sinY = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  const x = ((lng + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + sinY) / (1 - sinY)) / (4 * Math.PI)) * scale;
  return { x, y };
}

function worldPxToLatLng(x: number, y: number, zoom: number, pixelRatio: number): LatLng {
  const scale = 256 * Math.pow(2, zoom) * pixelRatio;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

/** The image's TRUE center, derived from `bounds` alone (the Mercator midpoint of its
 * NW/SE corners) rather than trusted from whatever `ScreenshotFrame.center` was set to.
 * This matters because `center` (e.g. App.tsx's `coords` state) can be stale relative to
 * the live map's actual position at the moment of capture -- GoogleMapView's own capture
 * path already fetches a fresh `center = map.getCenter()` right before requesting the
 * image, but that value only reaches this module indirectly, THROUGH `bounds` (computed
 * server-side from that same fresh center) -- not through `ScreenshotFrame.center`. Using
 * `bounds` to recover it exactly, instead of trusting a separately-tracked center value,
 * is the same fix `fetch_static_map_image`'s own docstring describes for the analogous
 * "georeference a pixel from this image" problem elsewhere in this app. */
export function centerFromBounds(bounds: ImageGeoBounds, zoom: number): LatLng {
  const nw = latLngToWorldPx(bounds.north, bounds.west, zoom, 1);
  const se = latLngToWorldPx(bounds.south, bounds.east, zoom, 1);
  return worldPxToLatLng((nw.x + se.x) / 2, (nw.y + se.y) / 2, zoom, 1);
}

/** The frame's effective center for projection purposes: derived from `bounds` when
 * present (see `centerFromBounds`), falling back to the given `center` otherwise (the
 * Leaflet/GISMap capture path, which has no server-computed bounds to fall back on --
 * there, `ScreenshotFrame.center` is trusted as-is). */
function effectiveCenter(frame: ScreenshotFrame): LatLng {
  return frame.bounds ? centerFromBounds(frame.bounds, frame.zoom) : frame.center;
}

/** A projector maps real lat/lng straight to the ORIGINAL (unrotated) screenshot's pixel
 * space -- i.e. the same frame the raw captured PNG/JPEG is in, before
 * tcp_intersection_generator.py (or `applyRotation` below) rotates anything. */
export type Projector = (p: LatLng) => { x: number; y: number };

export function makeProjector(frame: ScreenshotFrame): Projector {
  const pixelRatio = effectivePixelRatio(frame);
  const center = effectiveCenter(frame);
  const centerWorld = latLngToWorldPx(center.lat, center.lng, frame.zoom, pixelRatio);
  const originX = centerWorld.x - frame.widthPx / 2;
  const originY = centerWorld.y - frame.heightPx / 2;
  return (p: LatLng) => {
    const w = latLngToWorldPx(p.lat, p.lng, frame.zoom, pixelRatio);
    return { x: w.x - originX, y: w.y - originY };
  };
}

/** feet-per-pixel at the screenshot's center latitude/zoom -- the exact analogue of the
 * README's "measure a 12ft lane in pixels -> 12/px" step, computed instead of measured. */
export function feetPerPixel(frame: ScreenshotFrame): number {
  const pixelRatio = effectivePixelRatio(frame);
  const center = effectiveCenter(frame);
  const metersPerPixel = (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / (Math.pow(2, frame.zoom) * pixelRatio);
  return metersPerPixel * 3.28084;
}

// ---------------------------------------------------------------------------
// Rotation -- an exact port of tcp_intersection_generator.py's rotation_matrix(), which
// wraps cv2.getRotationMatrix2D() (positive deg = counter-clockwise, as OpenCV documents
// for a top-left-origin, y-down image) plus its canvas-expansion step. Verified to match
// that real function's output to within floating-point rounding across 200 randomized
// (width, height, angle) trials and 1000 sampled points -- see the module's test harness;
// this was NOT just derived by hand and trusted.
// ---------------------------------------------------------------------------

export interface RotationTransform {
  rotateDeg: number;
  /** [a, b, c, d, e, f] such that rotated = (a*x + b*y + c, d*x + e*y + f) */
  matrix: [number, number, number, number, number, number];
  /** The expanded canvas size after rotation -- matches what
   * tcp_intersection_generator.py's own rotation_matrix() computes for the SAME
   * (width, height, rotateDeg), i.e. the pixel space every leg/box/l12 coordinate below
   * must land inside. */
  rotatedWidth: number;
  rotatedHeight: number;
}

export function computeRotationTransform(widthPx: number, heightPx: number, rotateDeg: number): RotationTransform {
  const rad = (rotateDeg * Math.PI) / 180;
  const alpha = Math.cos(rad);
  const beta = Math.sin(rad);
  const cx = widthPx / 2;
  const cy = heightPx / 2;
  let a = alpha;
  let b = beta;
  let c = (1 - alpha) * cx - beta * cy;
  let d = -beta;
  let e = alpha;
  let f = beta * cx + (1 - alpha) * cy;
  const cAbs = Math.abs(a);
  const sAbs = Math.abs(b);
  const rotatedWidth = Math.round(heightPx * sAbs + widthPx * cAbs);
  const rotatedHeight = Math.round(heightPx * cAbs + widthPx * sAbs);
  c += rotatedWidth / 2 - widthPx / 2;
  f += rotatedHeight / 2 - heightPx / 2;
  return { rotateDeg, matrix: [a, b, c, d, e, f], rotatedWidth, rotatedHeight };
}

export function applyRotation(pt: { x: number; y: number }, t: RotationTransform): { x: number; y: number } {
  const [a, b, c, d, e, f] = t.matrix;
  return { x: a * pt.x + b * pt.y + c, y: d * pt.x + e * pt.y + f };
}

/** The `rotate_deg` (image CCW rotation) that makes the leg whose REAL compass bearing
 * (from the intersection center outward) is `legBearingDeg` run due EAST (+x, pointing
 * right) in the rotated frame -- i.e. this is the leg you want to end up as the road's
 * "east"/"+x" side after rotation. Derivation + numeric proof against the real
 * rotation_matrix() are in the module's test harness (max error ~1e-15 across 500
 * randomized bearings). */
export function rotateDegForEastLeg(legBearingDeg: number): number {
  return ((legBearingDeg - 90) % 360 + 360) % 360;
}

// ---------------------------------------------------------------------------
// Bearing helpers
// ---------------------------------------------------------------------------

/** Bearing from `a` to `b`, in degrees, 0-360, compass convention (0=N, 90=E). Mirrors
 * App.tsx's own computeHeading(). */
export function bearingBetween(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLon = toRad(b.lng - a.lng);
  const y = Math.sin(dLon) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b + 540) % 360) - 180);
  return d;
}

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bearingToCompassCode(bearingDeg: number): string {
  const idx = Math.round(((bearingDeg % 360) + 360) % 360 / 45) % 8;
  return COMPASS_8[idx];
}

export function haversineFt(a: LatLng, b: LatLng): number {
  const R = 20902231; // feet
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// ---------------------------------------------------------------------------
// Main assembly
// ---------------------------------------------------------------------------

export interface BuildSiteConfigInput {
  project: string;
  location: string;
  short: string;
  /** The intersection center -- e.g. App.tsx's `coords`. */
  center: LatLng;
  screenshot: ScreenshotFrame;
  /** Exactly 4 segments expected: two roughly-opposite pairs radiating out from `center`.
   * Fewer/more, or pairs that aren't roughly opposite, fail with a clear error rather than
   * silently producing a nonsensical config. IGNORED whenever `tracedRoadEdgeLegs` below
   * has exactly 4 legs -- OSM data is the fallback, not the preferred source. */
  roadNetwork: RoadNetworkSegment[];
  /**
   * Hand-traced 'road_edge' features (see tracedGeometry.ts), when the user has traced
   * them -- used INSTEAD of `roadNetwork` whenever there are exactly 4. This matters
   * because OSM road geometry is often sparse, simplified, or simply wrong for a specific
   * site (tracedGeometry.ts's own module docstring is explicit about this), which is
   * exactly why this app already has a mature hand-tracing tool and already prefers
   * traced road edges over OSM for its OTHER intersection-diagram pipeline
   * (intersectionGeometry.ts's deriveIntersectionLegs, gated by hasTracedIntersectionLegs)
   * -- this auto-fill path was initially built to read OSM `roadNetwork` only and missed
   * that same preference, which produced a less accurate plan whenever accurate traced
   * edges were available but silently went unused. Each traced leg also carries its OWN
   * `lanesThisDirection`/`speedLimitMph` (typed in per leg in the trace toolbar) -- used
   * in preference to `roadInfo` (which is keyed by name, and so can't distinguish two
   * legs of the same named road that are actually different widths at a real site).
   * Fewer than 4 (including 0) falls back to `roadNetwork` as before; 1-3 produces a
   * warning that they're being ignored, since partial traced legs can't be mixed with OSM
   * ones (the pairing/rotation math below needs one consistent coordinate source).
   */
  tracedRoadEdgeLegs?: TracedFeature[];
  /** Speed/lane data per segment, keyed by `RoadNetworkSegment.name`. A segment missing
   * from this map falls back to `fallbackSpeedLaneInfo`. Only consulted for a segment
   * that isn't itself a traced leg with its own lanesThisDirection/speedLimitMph set --
   * see `tracedRoadEdgeLegs` above. */
  roadInfo: Record<string, RoadSpeedLaneInfo>;
  fallbackSpeedLaneInfo?: RoadSpeedLaneInfo;
  /** The user's traced closure boundary -- must be a 'work_limit' feature (see
   * tracedGeometry.ts) with at least 3 points. */
  workLimit: TracedFeature;
  tables?: 'national' | 'ca';
  standard?: string;
  laneFt?: number; // default 12
  hours?: string;
  /** Assumed gap between the two directions' lane-1 lines at a leg (median/double-yellow
   * area), in feet -- part of the "good-enough approximation" for lane geometry. */
  medianGapFt?: number; // default 4
}

export interface BuildSiteConfigResult {
  config: IntersectionSiteConfig;
  rotation: RotationTransform;
  screenshotWidthPx: number;
  screenshotHeightPx: number;
  /** The work-limit polygon already projected + rotated into the SAME frame `config`'s
   * leg/box coordinates use -- exactly what `rasterizeWorkLimitOntoScreenshot` (in the
   * companion module) needs, computed once here so both stay in sync. NOT part of the
   * IntersectionSiteConfig JSON itself (the reference pipeline gets the work limit from
   * the image's blue pixels, not from the JSON). */
  workLimitRotatedPx: Array<{ x: number; y: number }>;
  warnings: string[];
}

interface LegAssembly {
  id: string;
  road: 'EW' | 'NS';
  axis: 'x' | 'y';
  legBearing: number; // real-world, from center to this leg
  rotatedNear: { x: number; y: number };
  rotatedFar: { x: number; y: number };
  laneFt: number;
  lanesThisDirection: number;
}

export function buildSiteConfig(input: BuildSiteConfigInput): BuildSiteConfigResult {
  const warnings: string[] = [];
  if (input.workLimit.type !== 'work_limit') {
    throw new Error(`workLimit must be a 'work_limit' traced feature, got '${input.workLimit.type}'`);
  }
  const workLimitLatLng = resolvedPoints(input.workLimit);
  if (workLimitLatLng.length < 3) {
    throw new Error('Work-limit trace needs at least 3 points to form a closure polygon.');
  }
  // ---- 0. pick the segment source: traced road-edge legs (accurate, hand-drawn) when
  // there are exactly 4, otherwise OSM `roadNetwork` -- see `tracedRoadEdgeLegs`'s doc for
  // why traced legs are preferred, not just an alternate equally-good source. ----
  const tracedLegs = (input.tracedRoadEdgeLegs ?? []).filter((f) => f.type === 'road_edge');
  const perSegmentInfo = new Map<RoadNetworkSegment, RoadSpeedLaneInfo>();
  let segments: RoadNetworkSegment[];

  if (tracedLegs.length === 4) {
    segments = tracedLegs.map((f, i) => {
      const pts = resolvedPoints(f);
      const seg: RoadNetworkSegment = { name: (f.name && f.name.trim()) || `LEG ${i + 1}`, highway: 'traced', points: pts };
      if (f.lanesThisDirection || f.speedLimitMph) {
        perSegmentInfo.set(seg, {
          speedLimitMph: f.speedLimitMph && f.speedLimitMph > 0 ? f.speedLimitMph : input.fallbackSpeedLaneInfo?.speedLimitMph ?? 35,
          lanesThisDirection: f.lanesThisDirection && f.lanesThisDirection > 0 ? f.lanesThisDirection : input.fallbackSpeedLaneInfo?.lanesThisDirection ?? 1,
          area: input.fallbackSpeedLaneInfo?.area ?? 'urban',
        });
      }
      return seg;
    });
    warnings.push(
      'Using your 4 hand-traced road-edge legs for geometry instead of the OSM road network -- more accurate when OSM data for this ' +
        "site is sparse or wrong. Lane count/speed come from each leg's own trace-toolbar fields where set, otherwise from the fallback."
    );
  } else {
    if (tracedLegs.length > 0) {
      warnings.push(
        `${tracedLegs.length} hand-traced road-edge leg(s) found, but exactly 4 are needed to use them in place of the OSM road ` +
          'network (the pairing/rotation math needs one consistent source, not a mix) -- falling back to OSM data for all 4 legs. ' +
          'Trace all 4 legs with the Trace tool to use your own geometry instead.'
      );
    }
    if (input.roadNetwork.length !== 4) {
      throw new Error(
        `Auto-fill expects exactly 4 road segments meeting at the intersection (one per leg); got ${input.roadNetwork.length} from ` +
          `OSM and ${tracedLegs.length} hand-traced. tcp_intersection_generator.py's pipeline is built for a signalized 4-leg ` +
          `intersection -- for anything else, build the site JSON by hand (see fullIntersectionPlanApi.ts's IntersectionSiteConfig).`
      );
    }
    segments = input.roadNetwork;
  }

  const laneFt = input.laneFt ?? 12.0;
  const medianGapFt = input.medianGapFt ?? 4.0;
  const ftPerPx = feetPerPixel(input.screenshot);
  const lanePx = laneFt / ftPerPx;
  const medianGapPx = medianGapFt / ftPerPx;

  const projector = makeProjector(input.screenshot);
  // The screenshot's TRUE center -- from `screenshot.bounds` when available (see
  // `centerFromBounds`'s doc), not trusted from `input.center` as-is, since a caller's
  // tracked center (e.g. App.tsx's `coords` state) can be a beat stale relative to the
  // live map position at the moment of capture. Using anything else here would silently
  // reintroduce that drift into `rotatedCenter` below (the box's own placement in the
  // rendered image) even though `projector` itself is already bounds-corrected.
  const center = input.screenshot.bounds ? centerFromBounds(input.screenshot.bounds, input.screenshot.zoom) : input.center;

  // ---- 1. bearing + near/far end for each of the 4 segments ----
  const segBearings = segments.map((seg) => {
    const far = seg.points.reduce((best, p) => (haversineFt(center, p) > haversineFt(center, best) ? p : best), seg.points[0]);
    const near = seg.points.reduce((best, p) => (haversineFt(center, p) < haversineFt(center, best) ? p : best), seg.points[0]);
    return { seg, bearing: bearingBetween(center, far), near, far };
  });

  // ---- 2. pair the 4 segments into 2 roughly-opposite pairs ----
  const pairings: Array<[number, number][]> = [
    [[0, 1], [2, 3]],
    [[0, 2], [1, 3]],
    [[0, 3], [1, 2]],
  ];
  let bestPairing = pairings[0];
  let bestError = Infinity;
  for (const pairing of pairings) {
    const err = pairing.reduce((sum, [i, j]) => sum + angleDiff(segBearings[i].bearing, (segBearings[j].bearing + 180) % 360), 0);
    if (err < bestError) {
      bestError = err;
      bestPairing = pairing;
    }
  }
  if (bestError > 60) {
    warnings.push(
      `The 4 road segments don't pair up into two clearly-opposite roads (best pairing off by ${bestError.toFixed(0)}° total) -- ` +
        `this usually means the intersection is heavily skewed, or the road-network lookup returned an unexpected leg. Check the result carefully.`
    );
  }

  const [pairA, pairB] = bestPairing;
  const avgBearingMod180 = (pair: [number, number][number][]) => {
    const bs = pair.map((i) => segBearings[i].bearing % 180);
    return bs.reduce((a, b) => a + b, 0) / bs.length;
  };
  // Arbitrary but deterministic: whichever pair's bearing is closer to due E/W (90 mod
  // 180) is labeled "EW" -- purely a label, rotate_deg squares up whichever pair is EW
  // regardless, so this choice doesn't affect the render, only the road-key names.
  const pairAisEW = angleDiff(avgBearingMod180(pairA as any), 90) <= angleDiff(avgBearingMod180(pairB as any), 90);
  const ewPair = (pairAisEW ? pairA : pairB) as [number, number];
  const nsPair = (pairAisEW ? pairB : pairA) as [number, number];

  // Pick whichever of the two EW-pair legs is ALREADY closer to due east (not just
  // "arbitrarily one of the pair") as the rotation reference. The two legs' bearings are
  // ~180 deg apart, and rotateDegForEastLeg(bearing) differs by a full 180 deg between
  // them -- using the wrong one still produces an axis-aligned road (rotateDegForEastLeg
  // IS 180-periodic in that sense), but flips the whole image, which would then make the
  // "W = smaller rotated x" labeling below assign true-west to "E" and vice versa. Always
  // anchoring to the bearing nearest 90 deg keeps rotate_deg's orientation deterministic
  // and keeps the later W/E/N/S labeling matching true compass directions.
  const ewBearingCandidates: [number, number] = [segBearings[ewPair[0]].bearing, segBearings[ewPair[1]].bearing];
  const eastRefBearing =
    angleDiff(ewBearingCandidates[0], 90) <= angleDiff(ewBearingCandidates[1], 90) ? ewBearingCandidates[0] : ewBearingCandidates[1];
  const rotateDeg = rotateDegForEastLeg(eastRefBearing);

  const rotation = computeRotationTransform(input.screenshot.widthPx, input.screenshot.heightPx, rotateDeg);
  const rotatedCenter = applyRotation(projector(center), rotation);

  const projectRotate = (p: LatLng) => applyRotation(projector(p), rotation);

  const clip = (v: number, max: number) => Math.max(0, Math.min(max, v));

  // ---- 3. build per-leg assemblies (bearing, rotated near/far) ----
  const roadInfoFor = (seg: RoadNetworkSegment): RoadSpeedLaneInfo => {
    const traced = perSegmentInfo.get(seg);
    if (traced) return traced;
    const info = input.roadInfo[seg.name];
    if (info) return info;
    warnings.push(`No speed/lane data for road segment "${seg.name}" -- using fallback defaults.`);
    return input.fallbackSpeedLaneInfo ?? { speedLimitMph: 35, lanesThisDirection: 2, area: 'urban' };
  };

  const legsRaw: LegAssembly[] = [];
  const buildLeg = (idx: number, road: 'EW' | 'NS', axis: 'x' | 'y'): LegAssembly => {
    const { seg, bearing, near, far } = segBearings[idx];
    const info = roadInfoFor(seg);
    return {
      id: '', // filled after near/far ordering is known
      road,
      axis,
      legBearing: bearing,
      rotatedNear: projectRotate(near),
      rotatedFar: projectRotate(far),
      laneFt,
      lanesThisDirection: info.lanesThisDirection,
    };
  };

  const ewLegA = buildLeg(ewPair[0], 'EW', 'x');
  const ewLegB = buildLeg(ewPair[1], 'EW', 'x');
  const nsLegA = buildLeg(nsPair[0], 'NS', 'y');
  const nsLegB = buildLeg(nsPair[1], 'NS', 'y');

  // W = smaller rotated x, E = larger. N = smaller rotated y (further "up"/north in the
  // rotated, north-up-before-rotation frame), S = larger.
  const [wLeg, eLeg] = ewLegA.rotatedNear.x <= ewLegB.rotatedNear.x ? [ewLegA, ewLegB] : [ewLegB, ewLegA];
  const [nLeg, sLeg] = nsLegA.rotatedNear.y <= nsLegB.rotatedNear.y ? [nsLegA, nsLegB] : [nsLegB, nsLegA];
  wLeg.id = 'W';
  eLeg.id = 'E';
  nLeg.id = 'N';
  sLeg.id = 'S';

  // ---- 4. box: each road's own half-width bounds the CROSSING road's extent through
  // the intersection (see module docstring for the "good-enough" reasoning) ----
  const ewHalfWidthPx = ewLegA.lanesThisDirection * lanePx;
  const nsHalfWidthPx = nsLegA.lanesThisDirection * lanePx;
  const box = {
    x0: rotatedCenter.x - nsHalfWidthPx,
    x1: rotatedCenter.x + nsHalfWidthPx,
    y0: rotatedCenter.y - ewHalfWidthPx,
    y1: rotatedCenter.y + ewHalfWidthPx,
  };

  // Lateral crop margin for the single-road phase sheets (render_phase_sheet in
  // tcp_intersection_generator.py): a phase sheet for one road crops tightly along that
  // road (leg limit-to-limit) but still needs to be told how much of the CROSS street's
  // width to include in frame -- everything narrower than that gets clipped off the
  // sheet entirely. `box` alone is exactly the crossing road's lane envelope with no
  // slack, which would crop signs, curb returns and crosswalk markings sitting just
  // outside it. CROP_PAD_FT pads box on both sides by a fixed, conservative real-world
  // margin so those still fit on the sheet -- required by the renderer (site["crop_lateral"]
  // is read directly, KeyError if absent) but not something OSM/Maps data can size exactly,
  // so this errs generous rather than guessing a precise curb-return radius.
  const CROP_PAD_FT = 15;
  const cropPadPx = CROP_PAD_FT / ftPerPx;

  const stopOffsetPx = Math.max(1, Math.round(3 / ftPerPx));

  const makeLeg = (leg: LegAssembly, boxEdge: number, label: string, roadKey: 'EW' | 'NS'): IntersectionSiteLeg => {
    const alongOf = (pt: { x: number; y: number }) => (leg.axis === 'x' ? pt.x : pt.y);
    const lateralOf = (pt: { x: number; y: number }) => (leg.axis === 'x' ? pt.y : pt.x);
    const maxAlong = leg.axis === 'x' ? rotation.rotatedWidth : rotation.rotatedHeight;
    const nearAlong = alongOf(leg.rotatedNear);
    const farAlongRaw = alongOf(leg.rotatedFar);
    const limit = clip(farAlongRaw, maxAlong);
    const towardBox = Math.sign(boxEdge - limit) || 1;
    const stop = boxEdge - towardBox * stopOffsetPx;

    const centerlineLateralAtBox = lateralOf(leg.rotatedNear); // near end sits essentially at the box
    const centerlineLateralAtLimit = lateralOf(leg.rotatedFar);
    const lateralAt = (along: number) => {
      const t = farAlongRaw === nearAlong ? 0 : (along - nearAlong) / (farAlongRaw - nearAlong);
      return centerlineLateralAtBox + t * (centerlineLateralAtLimit - centerlineLateralAtBox);
    };

    const buildDir = (role: 'approach' | 'departure', o: 1 | -1): IntersectionSiteDirection => {
      const travelBearing = role === 'approach' ? (leg.legBearing + 180) % 360 : leg.legBearing;
      const code = `${bearingToCompassCode(travelBearing)}B`;
      const l12At = (along: number) => lateralAt(along) + o * (medianGapPx / 2);
      const l12Limit = l12At(limit);
      const l12Box = l12At(boxEdge);
      const curbBox = l12Box + o * (leg.lanesThisDirection * lanePx);
      const point = (along: number, lateral: number): [number, number] =>
        leg.axis === 'x' ? [along, lateral] : [lateral, along];
      return {
        role,
        o,
        lanes: leg.lanesThisDirection,
        l12: [point(limit, l12Limit), point(boxEdge, l12Box)],
        near: [curbBox, l12Box],
      };
    };

    const dirCodes: Record<string, IntersectionSiteDirection> = {};
    const approach = buildDir('approach', -1);
    const departure = buildDir('departure', 1);
    dirCodes[`${bearingToCompassCode((leg.legBearing + 180) % 360)}B`] = approach;
    dirCodes[`${bearingToCompassCode(leg.legBearing)}B`] = departure;

    return {
      label,
      road: roadKey,
      axis: leg.axis,
      limit,
      box_edge: boxEdge,
      stop,
      toward_box: towardBox as 1 | -1,
      dirs: dirCodes,
    };
  };

  const legs: Record<string, IntersectionSiteLeg> = {
    W: makeLeg(wLeg, box.x0, 'W LEG', 'EW'),
    E: makeLeg(eLeg, box.x1, 'E LEG', 'EW'),
    N: makeLeg(nLeg, box.y0, 'N LEG', 'NS'),
    S: makeLeg(sLeg, box.y1, 'S LEG', 'NS'),
  };

  const ewInfo = roadInfoFor(segBearings[ewPair[0]].seg);
  const nsInfo = roadInfoFor(segBearings[nsPair[0]].seg);
  const roads: { EW: IntersectionSiteRoad; NS: IntersectionSiteRoad } = {
    EW: {
      name: segBearings[ewPair[0]].seg.name || segBearings[ewPair[1]].seg.name || 'E–W ROAD',
      speed: ewInfo.speedLimitMph,
      area: ewInfo.area ?? 'urban',
      legs: ['W', 'E'],
    },
    NS: {
      name: segBearings[nsPair[0]].seg.name || segBearings[nsPair[1]].seg.name || 'N–S ROAD',
      speed: nsInfo.speedLimitMph,
      area: nsInfo.area ?? 'urban',
      legs: ['N', 'S'],
    },
  };

  const workLimitRotatedPx = workLimitLatLng.map((p) => projectRotate(p));

  const config: IntersectionSiteConfig = {
    project: input.project,
    location: input.location,
    short: input.short,
    image: 'site.png',
    // The extra %360 wraparound AFTER rounding (not just inside rotateDegForEastLeg)
    // matters: floating-point noise can put `rotateDeg` a hair below a multiple of 360
    // (e.g. 359.9999999999999 for a "should be exactly 0" case), which rounds UP to
    // 360.00 -- functionally identical to 0 deg once fed through cos/sin, but confusing
    // to read in the JSON. Wrapping again after rounding turns that into a clean 0.
    rotate_deg: (Math.round(rotateDeg * 100) / 100) % 360,
    tables: input.tables ?? 'national',
    standard: input.standard ?? (input.tables === 'ca' ? 'CA MUTCD 2026' : 'MUTCD 11TH ED. (2023)'),
    ft_per_px: Math.round(ftPerPx * 10000) / 10000,
    lane_ft: laneFt,
    hours: input.hours ?? '9:00 AM – 3:30 PM WEEKDAYS (VERIFY WITH PERMIT)',
    roads,
    box: {
      x0: Math.round(box.x0 * 10) / 10,
      x1: Math.round(box.x1 * 10) / 10,
      y0: Math.round(box.y0 * 10) / 10,
      y1: Math.round(box.y1 * 10) / 10,
    },
    legs,
    features: [],
    crop_lateral: {
      EW: [Math.round((box.y0 - cropPadPx) * 10) / 10, Math.round((box.y1 + cropPadPx) * 10) / 10],
      NS: [Math.round((box.x0 - cropPadPx) * 10) / 10, Math.round((box.x1 + cropPadPx) * 10) / 10],
    },
    summary: [],
    phase_notes: {},
  };

  return {
    config,
    rotation,
    screenshotWidthPx: input.screenshot.widthPx,
    screenshotHeightPx: input.screenshot.heightPx,
    workLimitRotatedPx,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Work-limit rasterization -- draws the traced closure polygon onto a copy of the
// UNROTATED screenshot (tcp_intersection_generator.py rotates the image itself, using
// `config.rotate_deg`, before running its own blue-pixel detection) in the exact blue
// WORK_LIMIT_BLUE_RGB uses, so extract_work_limits() finds it with zero changes to that
// function.
// ---------------------------------------------------------------------------

export async function rasterizeWorkLimitOntoScreenshot(
  screenshotBlob: Blob,
  workLimitPoints: LatLng[],
  projector: Projector,
  lineWidthPx: number = 3,
): Promise<Blob> {
  const dims = await measureImageDimensions(screenshotBlob);
  const url = URL.createObjectURL(screenshotBlob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = (e) => reject(e instanceof ErrorEvent ? e.error : new Error('Could not load screenshot image'));
      el.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = dims.width;
    canvas.height = dims.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    ctx.drawImage(img, 0, 0, dims.width, dims.height);

    const [r, g, b] = WORK_LIMIT_BLUE_RGB;
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.lineWidth = lineWidthPx;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    workLimitPoints.forEach((p, i) => {
      const px = projector(p);
      if (i === 0) ctx.moveTo(px.x, px.y);
      else ctx.lineTo(px.x, px.y);
    });
    ctx.closePath();
    ctx.stroke();

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('canvas.toBlob failed'))), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
