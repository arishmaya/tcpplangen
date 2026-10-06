import { LatLng } from './types';
import { TracedFeature, resolvedPoints } from './tracedGeometry';
import { IntersectionLegInput } from './intersectionTcpEngine';

/**
 * intersectionGeometry.ts
 *
 * Converts the user's hand-traced `road_edge` TracedFeatures (real lat/lng
 * polylines, see tracedGeometry.ts) into the plain-number
 * `IntersectionLegInput[]` that intersectionTcpEngine.ts's
 * computeIntersectionPlan() consumes. Kept lat/lng-aware and
 * framework-free itself (no React), and deliberately separate from the
 * engine file, so that file can stay pure geometry/MUTCD-table math with
 * no notion of the globe (same split as tracedGeometry.ts vs the PNG
 * generator on the backend).
 *
 * Works for ANY real leg count >= 2, matching the engine's own
 * generalization (see that file's docstring) -- originally scoped to
 * exactly 4 legs to match the WA1 sample closely, generalized once it
 * became clear that anything traced with a different leg count was
 * falling back to the older backend-PNG flow, which draws it wrong rather
 * than just less richly (that flow always buckets real geometry into a
 * fixed 4-compass-quadrant frame, so a straight 2-leg road or a 3-leg T
 * comes out mislabeled/misshapen). A trace with fewer than 2 road_edge
 * legs returns `null` and the caller falls back to the existing (OSM or
 * backend-PNG) intersection flow -- the only case left where that
 * fallback still applies is a site with no hand-traced legs at all.
 *
 * Bearing/distance formulas below are the exact ones already used
 * elsewhere in the app (App.tsx's computeHeading()/haversineFt()) so a
 * leg's angle on this new sheet matches what the rest of the app already
 * shows for the same trace, rather than introducing a second, slightly
 * different definition of "bearing."
 */

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

/** Compass bearing (0-360, 0=N/90=E/180=S/270=W) from `from` to `to`. */
function bearingDeg(from: LatLng, to: LatLng): number {
  const dLon = toRad(to.lng - from.lng);
  const y = Math.sin(dLon) * Math.cos(toRad(to.lat));
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Great-circle distance in feet. */
function haversineFt(a: LatLng, b: LatLng): number {
  const R = 20902231; // Earth radius in feet
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * True when `tracedFeatures` has exactly 4 road_edge legs -- the gate the
 * consuming component (TracedIntersectionDiagram.tsx, via
 * IntersectionDiagramPreview.tsx) uses to decide whether to render the
 * new dynamic, real-angle sheet instead of falling back to the existing
 * backend-PNG flow.
 */
export function hasTracedIntersectionLegs(tracedFeatures: TracedFeature[]): boolean {
  return tracedFeatures.filter((f) => f.type === 'road_edge').length >= 2;
}

/**
 * Derives each leg's name/lanes/speed/bearing from the traced road edges.
 * Returns `null` if there are fewer than 2 road_edge features (nothing to
 * form even a straight through-road from), or if any of them has fewer
 * than 2 points (nothing to take a direction from). Any count >= 2 works
 * -- 2 for a plain through road, 3 for a T, 4 for a classic cross, 5+
 * beyond that (see intersectionTcpEngine.ts's own docstring for how the
 * engine renders whatever count comes out of this).
 *
 * A traced road_edge carries no inherent "which end is the intersection
 * end" information -- the user may have clicked outward-in or inward-out
 * on any leg. To find the intersection-side end of each leg without
 * assuming click order:
 *  1. Take a rough centroid of every leg's two endpoints (2N points total).
 *  2. For each leg, whichever of its two endpoints sits closer to that
 *     rough centroid is treated as its near (intersection-side) end.
 *  3. Refine the true center as the centroid of those N near points --
 *     this is a much tighter estimate than step 1 since it excludes the
 *     N far/outboard endpoints.
 *  4. Each leg's bearing is computed from that refined center out to the
 *     leg's own far end -- "the compass direction you'd drive out this
 *     leg from the intersection," which is what the engine's
 *     canvas-rotation math (finalCanvasAngle in intersectionTcpEngine.ts)
 *     expects.
 */
export function deriveIntersectionLegs(tracedFeatures: TracedFeature[]): IntersectionLegInput[] | null {
  const roadEdges = tracedFeatures.filter((f) => f.type === 'road_edge');
  if (roadEdges.length < 2) return null;

  const resolved = roadEdges.map((f) => resolvedPoints(f));
  if (resolved.some((pts) => pts.length < 2)) return null;

  const allEndpoints: LatLng[] = [];
  resolved.forEach((pts) => {
    allEndpoints.push(pts[0], pts[pts.length - 1]);
  });
  const roughCenter: LatLng = {
    lat: allEndpoints.reduce((s, p) => s + p.lat, 0) / allEndpoints.length,
    lng: allEndpoints.reduce((s, p) => s + p.lng, 0) / allEndpoints.length,
  };

  const nearFar = resolved.map((pts) => {
    const first = pts[0];
    const last = pts[pts.length - 1];
    const dFirst = haversineFt(first, roughCenter);
    const dLast = haversineFt(last, roughCenter);
    return dFirst <= dLast ? { near: first, far: last } : { near: last, far: first };
  });

  const center: LatLng = {
    lat: nearFar.reduce((s, nf) => s + nf.near.lat, 0) / nearFar.length,
    lng: nearFar.reduce((s, nf) => s + nf.near.lng, 0) / nearFar.length,
  };

  return roadEdges.map((f, i) => ({
    id: f.id,
    name: (f.name && f.name.trim() ? f.name.trim() : `Leg ${i + 1}`).toUpperCase(),
    lanes: f.lanesThisDirection && f.lanesThisDirection > 0 ? f.lanesThisDirection : 1,
    speed: f.speedLimitMph && f.speedLimitMph > 0 ? f.speedLimitMph : 35,
    bearingDeg: bearingDeg(center, nearFar[i].far),
  }));
}

/** The refined intersection center (lat/lng) for the traced legs (any
 * count >= 2), or `null` under the same conditions as
 * deriveIntersectionLegs(). Exposed separately so a caller that wants to
 * show a center marker on the map doesn't have to re-run the whole
 * derivation. */
export function deriveIntersectionCenter(tracedFeatures: TracedFeature[]): LatLng | null {
  const roadEdges = tracedFeatures.filter((f) => f.type === 'road_edge');
  if (roadEdges.length < 2) return null;
  const resolved = roadEdges.map((f) => resolvedPoints(f));
  if (resolved.some((pts) => pts.length < 2)) return null;

  const allEndpoints: LatLng[] = [];
  resolved.forEach((pts) => {
    allEndpoints.push(pts[0], pts[pts.length - 1]);
  });
  const roughCenter: LatLng = {
    lat: allEndpoints.reduce((s, p) => s + p.lat, 0) / allEndpoints.length,
    lng: allEndpoints.reduce((s, p) => s + p.lng, 0) / allEndpoints.length,
  };

  const nears = resolved.map((pts) => {
    const first = pts[0];
    const last = pts[pts.length - 1];
    const dFirst = haversineFt(first, roughCenter);
    const dLast = haversineFt(last, roughCenter);
    return dFirst <= dLast ? first : last;
  });

  return {
    lat: nears.reduce((s, p) => s + p.lat, 0) / nears.length,
    lng: nears.reduce((s, p) => s + p.lng, 0) / nears.length,
  };
}
