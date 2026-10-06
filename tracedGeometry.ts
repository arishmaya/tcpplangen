import { LatLng } from './types';

/**
 * tracedGeometry.ts
 * Shared data model for the hand-traced intersection tool.
 *
 * Why this exists: the auto-generated intersection diagram (from local OSM
 * data) kept failing to match the real, on-the-ground intersection shape --
 * OSM geometry is sparse/simplified and sometimes just wrong for a given
 * site. Instead of continuing to patch heuristics that infer road shape
 * from that data, this lets the user trace the ACTUAL road edges,
 * crosswalks and sidewalks directly over the satellite/street basemap by
 * clicking points, the same way "Draw Corridor" mode already traces a
 * single work-zone line today. That traced vector data becomes the input
 * to the TCP plan renderer instead of (or alongside) OSM-derived geometry.
 *
 * Kept deliberately small: a traced feature is just a type tag + an ordered
 * list of real lat/lng points. Curves are resolved to a dense polyline of
 * points on the CLIENT side (see densifyCurve below), so nothing downstream
 * -- the map rendering, the backend adapter, the TCP plan renderer -- ever
 * needs to know a feature was drawn "curved" vs "straight"; it just sees a
 * polyline either way.
 */

export type TracedFeatureType = 'road_edge' | 'crosswalk' | 'sidewalk' | 'lane_line' | 'work_limit';
export type TracedFeatureShape = 'straight' | 'curved';

export interface TracedFeature {
  id: string;
  type: TracedFeatureType;
  shape: TracedFeatureShape;
  /**
   * The user's actual clicks, in order. For a 'curved' shape this is the
   * sparse set of control points -- NOT the densified render points -- so
   * the shape stays editable (add/move/undo a control point) without
   * losing the original click history.
   */
  points: LatLng[];
  /**
   * Only meaningful for type 'road_edge'. A hand-traced line carries no
   * OSM tags, so the renderer has nothing to derive lane width, taper
   * length or sign spacing from -- these have to be typed in per leg.
   * Left undefined until the user fills in the attributes panel; the
   * backend applies its own sane defaults (1 lane, 35 mph) if still unset
   * when generation is requested, and says so on the sheet.
   */
  lanesThisDirection?: number;
  speedLimitMph?: number;
  /** Free-text road name, optional -- feeds the sheet's title block the
   * same way an OSM 'name' tag does today. */
  name?: string;
}

/**
 * A closed 'work_limit' feature is the construction closure boundary --
 * the SAME thing the reference tcp_intersection.py script expects drawn in
 * blue on its input aerial (see extract_work_limits() in
 * tcp_intersection_generator.py). This can't come from OSM or Google Maps
 * data at all -- which lanes and how far are actually being closed is a
 * permit/construction decision, not a fact about the road network -- so it
 * is always hand-traced, the same way road_edge/crosswalk/etc. are. Unlike
 * those types it's expected to be a CLOSED polygon (first and last point
 * implicitly connected) rather than an open line; siteConfigBuilder.ts is
 * what turns the traced points into the work-limit polygon a screenshot
 * gets annotated with before being sent to the full-plan endpoint.
 */
export const WORK_LIMIT_FEATURE_TYPE: TracedFeatureType = 'work_limit';

/**
 * The exact RGB used both for the map-drawn 'work_limit' trace style (below)
 * and for rasterizing the traced polygon onto the screenshot in
 * siteConfigBuilder.ts -- kept as one constant so the two can't drift apart.
 * Verified against extract_work_limits()'s detection test in
 * tcp_intersection_generator.py, which reads images as BGR (cv2 default) and
 * requires b>170, b-r>80, b-g>40: R=30,G=64,B=255 gives b-r=225, b-g=191 --
 * comfortably inside the threshold with margin for PNG/JPEG recompression.
 */
export const WORK_LIMIT_BLUE_RGB: [number, number, number] = [30, 64, 255];

export type TracedGeometry = TracedFeature[];

let _idCounter = 0;
export function newTracedFeatureId(): string {
  _idCounter += 1;
  return `trace-${Date.now().toString(36)}-${_idCounter}`;
}

/**
 * Catmull-Rom spline through the given control points, resampled to
 * roughly one point every ~`stepFt` feet of ground distance (default 8ft --
 * dense enough to look smooth at intersection scale, sparse enough not to
 * bloat the payload). Falls back to returning the control points unchanged
 * if there are fewer than 3 (nothing to curve through).
 *
 * Runs entirely in lat/lng "degree space" for the spline math itself (fine
 * at this scale -- a few hundred feet across) and only uses real feet to
 * decide the output density.
 */
export function densifyCurve(points: LatLng[], stepFt: number = 8): LatLng[] {
  if (points.length < 3) return points;

  const FT_PER_DEG_LAT = 364000;
  const cosLat = Math.cos((points[0].lat * Math.PI) / 180);

  const catmullRom = (p0: LatLng, p1: LatLng, p2: LatLng, p3: LatLng, t: number): LatLng => {
    const t2 = t * t;
    const t3 = t2 * t;
    const a = (v0: number, v1: number, v2: number, v3: number) =>
      0.5 *
      (2 * v1 +
        (-v0 + v2) * t +
        (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 +
        (-v0 + 3 * v1 - 3 * v2 + v3) * t3);
    return { lat: a(p0.lat, p1.lat, p2.lat, p3.lat), lng: a(p0.lng, p1.lng, p2.lng, p3.lng) };
  };

  const pad = [points[0], ...points, points[points.length - 1]];
  const out: LatLng[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = pad[i];
    const p1 = pad[i + 1];
    const p2 = pad[i + 2];
    const p3 = pad[i + 3];

    const segFt = Math.hypot((p2.lat - p1.lat) * FT_PER_DEG_LAT, (p2.lng - p1.lng) * FT_PER_DEG_LAT * cosLat);
    const steps = Math.max(4, Math.round(segFt / stepFt));

    for (let s = 0; s < steps; s++) {
      out.push(catmullRom(p0, p1, p2, p3, s / steps));
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Render/points-to-send helper: resolves a feature's actual geometry,
 * densifying curves and passing straight traces through unchanged. */
export function resolvedPoints(feature: TracedFeature): LatLng[] {
  return feature.shape === 'curved' ? densifyCurve(feature.points) : feature.points;
}

export const TRACE_FEATURE_STYLE: Record<TracedFeatureType, { color: string; weight: number; dash?: string; label: string }> = {
  // Thin, precise strokes -- these are traced by hand directly over the
  // real pavement/curb/paint, so a heavy line hides exactly the edge
  // you're trying to click along. Colors match the real-world convention
  // each one is standing in for: blue edge-of-pavement, white crosswalk
  // striping, yellow lane paint.
  road_edge: { color: '#2563eb', weight: 1.5, label: 'Road edge' },
  crosswalk: { color: '#ffffff', weight: 1, dash: '6 4', label: 'Crosswalk' },
  sidewalk: { color: '#c9b896', weight: 2, dash: '2 4', label: 'Sidewalk' },
  // On the MAP itself (traced over satellite imagery) this is drawn bright
  // yellow so it's actually visible against dark pavement, matching real
  // lane paint -- the FINAL generated diagram always renders it as a
  // grey dashed line regardless of this map color (see
  // generate_intersection_tcp_png.py's lane_line_runs drawing loop).
  lane_line: { color: '#facc15', weight: 1, dash: '10 6', label: 'Lane line' },
  // Solid, saturated blue on purpose -- this is traced in the exact hue
  // extract_work_limits() in tcp_intersection_generator.py looks for
  // (b>170 & b-r>80 & b-g>40), so drawing it on the map with this color and
  // later rasterizing it onto the screenshot with the SAME color (see
  // WORK_LIMIT_BLUE_RGB above) is what makes the CV extraction step find it
  // without any changes to that script.
  work_limit: {
    color: `#${WORK_LIMIT_BLUE_RGB.map((c) => c.toString(16).padStart(2, '0')).join('')}`,
    weight: 2.5,
    label: 'Work limit (closure boundary)',
  },
};
