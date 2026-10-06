import React, { useState, useEffect, useRef } from 'react';
import {
  LatLng,
  SiteAnalysis,
  DesignParams,
  ProjectStatus,
  RoutePoint,
  RouteCorridor,
  RouteAsset,
} from './types';
import {
  SAMPLE_PROJECTS,
  SIGN_SPACING_TABLE,
  BUFFER_SPACE_TABLE,
  SPEED_OPTIONS,
  computeMUTCDMetrics,
  MutcdConfig,
  DEFAULT_MUTCD_CONFIG,
  TaperType,
} from './utils/mutcd';
import { getComplianceItems } from './utils/compliance';
import { TracedFeature } from './tracedGeometry';
import { LaneClosureParams, LANE_CLOSURE_PRESETS, ClosureStrategy, RoadType } from './laneClosureTcpEngine';
import { useLaneClosurePlanEngine } from './useLaneClosurePlanEngine';
import { GISMap, GISMapHandle } from './components/GISMap';
import { GoogleMapView, GoogleMapViewHandle } from './components/GoogleMapView';
import { CADCanvas, CADCanvasHandle } from './components/CADCanvas';
import { IntersectionDiagramPreview, IntersectionDiagramPreviewHandle } from './components/IntersectionDiagramPreview';
import { LaneClosureDiagramStage } from './components/LaneClosureDiagramStage';
import { LaneClosureSummaryPanel } from './components/LaneClosureSummaryPanel';
import { LaneClosureIntersectionPanel } from './components/LaneClosureIntersectionPanel';
import { StreetViewDetector } from './components/StreetViewDetector';
import { SubmissionReview } from './components/SubmissionReview';
import { RouteAssetInventory } from './components/RouteAssetInventory';
import { FullIntersectionPlanPanel } from './components/FullIntersectionPlanPanel';
import { RoadDetectPanel } from './components/RoadDetectPanel';
import {
  Key,
  Layers,
  MapPin,
  MapPinned,
  Pencil,
  Square,
  Camera,
  Loader2,
  Search,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  Printer,
  ShieldCheck,
  Disc,
  School,
  Activity,
  CheckCircle2,
  X,
  Compass,
  FileCheck,
  ExternalLink,
  Eye,
  EyeOff,
  AlertTriangle,
  Check,
  Trash2,
  Navigation,
  RotateCcw,
  Zap,
  Gauge,
  Plus,
  ChevronDown,
  ChevronUp,
  Sun,
  Moon,
  Settings,
  Waypoints,
} from 'lucide-react';

// Bearing from one point to the next, in degrees (0-359). Mirrors the heading
// calculation agent.py's snap_points_tool uses server-side, so a corridor's
// Street View heading actually points the way the route travels instead of
// being left at whatever heading the last-loaded sample happened to have.
function computeHeading(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLon = toRad(to.lng - from.lng);
  const y = Math.sin(dLon) * Math.cos(toRad(to.lat));
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return Math.round((deg + 360) % 360);
}

function buildStreetViewUrl(origin: { lat: number; lng: number }, heading: number): string {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${origin.lat},${origin.lng}&heading=${heading}`;
}

function haversineFt(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 20902231; // Earth radius in feet
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

interface RoadNetworkSegment {
  name: string;
  highway: string;
  points: LatLng[];
}

interface AddressSuggestion {
  description: string;
  lat?: number;
  lng?: number;
  placeId?: string;
  source: string;
}

export default function App() {
  // Global App State
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem('incedo_theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      // ignore
    }
    return 'dark';
  });
  useEffect(() => {
    try {
      localStorage.setItem('incedo_theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const [step, setStep] = useState<number>(1);
  // Kept separate from `design` deliberately — DesignParams is a shared type
  // this app doesn't own the definition of, so new fields go in their own
  // state rather than risk a shape mismatch with the real interface.
  const [dividedHighway, setDividedHighway] = useState<boolean>(false);
  const [opposingLanes, setOpposingLanes] = useState<number>(2);

  // MUTCD configuration — lets a technician override the standard Ch. 6C
  // tables/taper type/curve-warning behavior per-project, sourced from the
  // City of Frisco permit set's own reference tables and notes.
  const [mutcdConfig, setMutcdConfig] = useState<MutcdConfig>(() => ({
    ...DEFAULT_MUTCD_CONFIG,
    signSpacingTable: SIGN_SPACING_TABLE.map((r) => ({ ...r })),
    bufferSpaceTable: BUFFER_SPACE_TABLE.map((r) => ({ ...r })),
  }));
  const [showConfigModal, setShowConfigModal] = useState<boolean>(false);
  const [activeCanvasView, setActiveCanvasView] = useState<'map' | 'cad'>('map');
  // Step 3 (TCP PLAN) has two independent ways to get to a plan set: auto-fill/manual
  // JSON from the current mapped site (FullIntersectionPlanPanel, unchanged), or CV
  // auto-detection from a plain aerial screenshot with no lat/lng at all (RoadDetectPanel,
  // new -- the "integrate detect.py / tcp_from_screenshot.py" solution, scoped to backend
  // auto-detect + a plain numeric correction form, not the full drag-on-image editor those
  // attachments also shipped). Both land on the exact same phased plan generator.
  const [tcpPlanMode, setTcpPlanMode] = useState<'full' | 'roadDetect'>('full');
  const [mapProvider, setMapProvider] = useState<'leaflet' | 'google'>('google');
  const [projectName, setProjectName] = useState<string>('Untitled TCP Project');
  const [status, setStatus] = useState<ProjectStatus>('draft');
  const [addressInput, setAddressInput] = useState<string>('');
  const [activeAddress, setActiveAddress] = useState<string>('');
  const [coords, setCoords] = useState<LatLng | null>(null);
  const [mapMode, setMapMode] = useState<'address' | 'route' | 'draw' | 'bbox' | 'trace'>('address');
  const [bboxCorners, setBboxCorners] = useState<{ lat: number; lng: number }[]>([]);
  // Hand-traced intersection geometry (see tracedGeometry.ts) — lives here,
  // not inside GoogleMapView, so it survives a map-provider toggle and a
  // mode switch, the same way routeCorridor and bboxCorners do.
  const [tracedFeatures, setTracedFeatures] = useState<TracedFeature[]>([]);
  const gisMapRef = useRef<GISMapHandle>(null);
  const googleMapRef = useRef<GoogleMapViewHandle>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [capturingScreenshot, setCapturingScreenshot] = useState(false);
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);

  const handleCaptureBboxScreenshot = async () => {
    const activeRef = mapProvider === 'google' ? googleMapRef.current : gisMapRef.current;
    if (!activeRef) return;
    setCaptureError(null);
    setCapturingScreenshot(true);
    try {
      const result = await activeRef.captureScreenshot();
      if (!result) return;
      const { blob, zoom } = result;
      setCapturedBlob(blob);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `bbox-screenshot-zoom${zoom}-${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (e) {
      setCaptureError(e instanceof Error ? e.message : 'Could not capture a screenshot of this map view.');
    } finally {
      setCapturingScreenshot(false);
    }
  };

  // Same capture path as handleCaptureBboxScreenshot above, but returns the {blob, zoom}
  // pair directly instead of triggering a download -- what FullIntersectionPlanPanel's
  // auto-fill needs to build its own aerial (with the work-limit outline drawn on it)
  // rather than the raw screenshot a person would download.
  const captureScreenshotForAutoFill = async (): Promise<{
    blob: Blob;
    zoom: number;
    bounds?: { north: number; south: number; east: number; west: number } | null;
  }> => {
    const activeRef = mapProvider === 'google' ? googleMapRef.current : gisMapRef.current;
    if (!activeRef) {
      throw new Error('No active map view to capture -- make sure the map has finished loading.');
    }
    const result = await activeRef.captureScreenshot();
    if (!result) {
      throw new Error('Screenshot capture returned nothing -- try again after the map view has settled.');
    }
    return result;
  };
  const [polygon, setPolygon] = useState<LatLng[]>([]);
  const [polygonLength, setPolygonLength] = useState<number>(0);

  // Multi-Point Route Corridor & Detected Assets State
  // Empty until the user geocodes an address or places points on the map themselves —
  // no default corridor should ever appear unprompted.
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>([]);
  const [routeCorridor, setRouteCorridor] = useState<RouteCorridor | null>(null);
  const [routeAssets, setRouteAssets] = useState<RouteAsset[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  // Distinct from selectedAssetId — that's just "currently highlighted/being
  // viewed" (set by clicking any asset marker); this is "the manhole the
  // crew is actually going to work at", explicitly designated by the user,
  // which drives which side of the road the TCP plan's lane closure renders on.
  const [workSiteAssetId, setWorkSiteAssetId] = useState<string | null>(null);
  // The work-site pin's own side of the road, computed geometrically from its
  // real position relative to the road — set whenever a work site is
  // analyzed, independent of whether any specific manhole is later selected.
  const [workSiteGeometricSide, setWorkSiteGeometricSide] = useState<'left' | 'right' | null>(null);
  const [roadNetwork, setRoadNetwork] = useState<RoadNetworkSegment[]>([]);
  // One separate, independently-correct TCP diagram per road — the main
  // work-site road (design/routeCorridor, fully user-editable in Step 4) and
  // each neighboring road that connects to it (lightweight reference data
  // only: real geometry + real speed, heuristic lane count, no vision pass —
  // see analyze_road_reference()'s docstring for why). Rendered one at a
  // time via a tab switch, rather than merged into a single overlaid view —
  // that's what was making the diagram look messy.
  const [neighborRoadDiagrams, setNeighborRoadDiagrams] = useState<{ name: string; design: DesignParams; corridor: RouteCorridor }[]>([]);
  const [activeDiagramRoad, setActiveDiagramRoad] = useState<string | null>(null);
  // Once at least one road leg has been hand-traced, the traced geometry
  // IS the TCP plan's road base -- no more toggling between the CAD
  // drawing / true-scale / intersection previews (three separate renderers
  // that could each show something different for the same site). The
  // strip-style CADCanvas can't represent a second crossing road at all
  // (see generate_intersection_tcp_png.py's module docstring for why), so
  // it remains the fallback only for the un-traced, single-corridor case
  // and for neighbor-road tabs (which were never individually traced).
  const hasTracedRoadEdges = tracedFeatures.some((f) => f.type === 'road_edge');
  const showTracedPlan = hasTracedRoadEdges && !activeDiagramRoad;
  const [showAssetModal, setShowAssetModal] = useState<boolean>(false);

  // Print / PDF export — the live TCP diagram SVG is only reachable via this
  // ref (CADCanvas may not even be mounted if the user is on the map view
  // when they click print), and printSvgMarkup is what the printable sheet
  // set actually renders.
  const cadCanvasRef = useRef<CADCanvasHandle>(null);
  const [printSvgMarkup, setPrintSvgMarkup] = useState<string | null>(null);
  const [isPreparingPrint, setIsPreparingPrint] = useState<boolean>(false);

  // Lets the Step-4 "Configure Design Parameters" transition trigger the
  // intersection diagram itself, rather than requiring a second manual
  // click on "Generate Intersection Diagram" once the person is already
  // there -- see the [step] effect below.
  const intersectionPreviewRef = useRef<IntersectionDiagramPreviewHandle>(null);
  useEffect(() => {
    if (step === 4) {
      // No-ops harmlessly if the traced plan panel isn't mounted right now
      // (e.g. no traced road edges yet, so CADCanvas is showing instead) --
      // the ref is simply null in that case.
      intersectionPreviewRef.current?.generate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Analysis State — null until a real /api/analyze-site (or route/asset) call populates it.
  const [analysis, setAnalysis] = useState<SiteAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Design Parameters
  const [design, setDesign] = useState<DesignParams>({
    workType: 'one-lane',
    lanes: 4,
    speed: 45,
    length: 490,
    offset: 11,
    duration: '1 day',
    contractorName: 'Incedo Telecom Engineering',
    projectName: 'Preston Rd Fiber Expansion - TCP-01',
    flaggersRequired: false,
    arrowBoardRequired: true,
    trenchPlates: true,
  });

  // Plan style — Step 4 can build either the existing intersection-focused
  // plan above (Texas MUTCD Ch. 6C, via `design`/`metrics`) or a straight-
  // road Lane Closure plan (CA MUTCD 2026, ported from the user's own
  // "Marina TCP Studio" prototype — see laneClosureTcpEngine.ts). Both
  // still go through Steps 1-2's located site first; switching to
  // 'laneClosure' just seeds `laneClosureParams.road`/`addr` from that
  // located site rather than skipping it. Kept as a fully separate params
  // object/engine (not merged into `design`) since the two MUTCD tables
  // are deliberately not reconciled — see the engine file's docstring.
  const [planStyle, setPlanStyle] = useState<'intersection' | 'laneClosure'>('intersection');
  const [laneClosureParams, setLaneClosureParams] = useState<LaneClosureParams>(() => JSON.parse(JSON.stringify(LANE_CLOSURE_PRESETS[4])));
  // A `tag: '4-LEG'` work-area preset (see LANE_CLOSURE_PRESETS) isn't a
  // straight/curve lane closure at all -- it routes to the same
  // LaneClosureIntersectionPanel the standalone Lane Closure TCP Studio
  // tool uses (see LaneClosureTCPStudio.tsx's own `mode` state, which this
  // mirrors) rather than through `laneClosureParams`/useLaneClosurePlanEngine.
  // `selectedPresetIdx` is purely for the Work Area Preset dropdown's own
  // controlled value -- by array index, not `wa` number, since more than
  // one preset can share a `wa` (a plain sheet plus a CURVE or 4-LEG
  // companion), which a `wa`-keyed <select> can't tell apart.
  const [laneClosureMode, setLaneClosureMode] = useState<'plan' | 'intersection'>('plan');
  const [intersectionPresetIdx, setIntersectionPresetIdx] = useState<number | null>(null);
  const [selectedPresetIdx, setSelectedPresetIdx] = useState(4);
  const laneClosure = useLaneClosurePlanEngine(laneClosureParams, planStyle === 'laneClosure' && laneClosureMode === 'plan');

  // Google Maps API Key State & Persistence
  const [googleApiKey, setGoogleApiKey] = useState<string>(() => {
    try {
      return localStorage.getItem('incedo_google_maps_api_key') || '';
    } catch {
      return '';
    }
  });
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [showApiKeyModal, setShowApiKeyModal] = useState<boolean>(false);
  const [showKeyPlain, setShowKeyPlain] = useState<boolean>(false);
  const [serverHasKey, setServerHasKey] = useState<boolean>(false);
  const [isValidatingKey, setIsValidatingKey] = useState<boolean>(false);
  const [keyValidationResult, setKeyValidationResult] = useState<{
    valid: boolean;
    message: string;
    services?: any;
  } | null>(null);
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const [optimalOrderNotice, setOptimalOrderNotice] = useState<string | null>(null);

  // Computed MUTCD Metrics
  const metrics = computeMUTCDMetrics(design, mutcdConfig);

  // Which side of the road the TCP plan's lane closure actually renders on —
  // driven by the real detected position of whichever manhole was explicitly
  // designated as the work site, falling back to the work site's own
  // geometric side when none is selected (defaults to 'left' only if
  // neither is available). asset.side is a formatted display string
  // ("Right Curb", "Left Shoulder"), not a bare 'left'/'right' — matching
  // that with strict equality never matches, which silently meant this
  // always fell through to the geometric fallback regardless of what the
  // selected manhole's own detected side actually was.
  const workSiteAsset = workSiteAssetId ? routeAssets.find((a) => a.id === workSiteAssetId) : null;
  const workSiteAssetSideLower = (workSiteAsset?.side || '').toLowerCase();
  const workSide: 'left' | 'right' =
    workSiteAssetSideLower.includes('right') ? 'right'
    : workSiteAssetSideLower.includes('left') ? 'left'
    : workSiteGeometricSide === 'right' ? 'right'
    : 'left';

  // Check initial server configuration
  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
        if (data.hasGoogleMapsApiKey) {
          setServerHasKey(true);
        }
      })
      .catch(() => {});
  }, []);

  // Modal open handler
  const handleOpenApiKeyModal = () => {
    setApiKeyInput(googleApiKey);
    setKeyValidationResult(null);
    setSaveToast(null);
    setShowApiKeyModal(true);
  };

  // Close modal on Escape key
  useEffect(() => {
    if (!showApiKeyModal && !showAssetModal && !showConfigModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowApiKeyModal(false);
        setShowAssetModal(false);
        setShowConfigModal(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showApiKeyModal, showAssetModal, showConfigModal]);

  // Test / Validate Google Maps Key
  const handleValidateKey = async () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setKeyValidationResult({
        valid: false,
        message: 'Please paste a Google Maps API key before testing.',
      });
      return;
    }

    setIsValidatingKey(true);
    setKeyValidationResult(null);
    try {
      const resp = await fetch('/api/validate-maps-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: trimmed }),
      });
      const data = await resp.json();
      setKeyValidationResult({
        valid: Boolean(data.valid),
        message: data.message || (data.valid ? 'Key successfully verified!' : 'Key verification failed.'),
        services: data.services,
      });
    } catch (err: any) {
      setKeyValidationResult({
        valid: false,
        message: 'Could not connect to validation service. Please check your network connection.',
      });
    } finally {
      setIsValidatingKey(false);
    }
  };

  // Save Key to LocalStorage and State
  const handleSaveKey = (andReanalyze = false) => {
    const trimmed = apiKeyInput.trim();
    setGoogleApiKey(trimmed);
    try {
      if (trimmed) {
        localStorage.setItem('incedo_google_maps_api_key', trimmed);
      } else {
        localStorage.removeItem('incedo_google_maps_api_key');
      }
    } catch {
      // ignore
    }
    setSaveToast('API Key saved successfully!');
    setTimeout(() => {
      setShowApiKeyModal(false);
      setSaveToast(null);
    }, 600);

    if (andReanalyze && coords) {
      handleAnalyzeWorksite(false);
    }
  };

  // Clear Key
  const handleClearKey = () => {
    setApiKeyInput('');
    setGoogleApiKey('');
    try {
      localStorage.removeItem('incedo_google_maps_api_key');
    } catch {
      // ignore
    }
    setKeyValidationResult(null);
    setSaveToast('Key removed. Reset to simulated GIS mode.');
    setTimeout(() => setSaveToast(null), 2500);
  };

  // Update canvas view automatically as user advances
  useEffect(() => {
    if (step <= 2) {
      setActiveCanvasView('map');
    } else {
      setActiveCanvasView('cad');
    }
  }, [step]);

  // Address Autocomplete State
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState<boolean>(false);
  const [isSuggestLoading, setIsSuggestLoading] = useState<boolean>(false);

  // Debounced address suggestion fetch as the user types (Google Places
  // Autocomplete — see /api/geocode/suggest; empty list if Google is unavailable).
  useEffect(() => {
    const query = addressInput.trim();
    if (query.length < 3) {
      setAddressSuggestions([]);
      setIsSuggestLoading(false);
      return;
    }
    setIsSuggestLoading(true);
    const handle = setTimeout(async () => {
      try {
        const resp = await fetch('/api/geocode/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, apiKey: googleApiKey }),
        });
        const data = await resp.json();
        setAddressSuggestions(data.suggestions || []);
      } catch {
        setAddressSuggestions([]);
      } finally {
        setIsSuggestLoading(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [addressInput, googleApiKey]);

  // Handle Geocoding / Location search
  const handleGeocode = async (query: string) => {
    if (!query.trim()) return;
    setShowSuggestions(false);
    setIsAnalyzing(true);
    setAnalysisError(null);
    try {
      const resp = await fetch('/api/geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: query, apiKey: googleApiKey }),
      });
      const data = await resp.json();
      if (data.lat && data.lng) {
        setCoords({ lat: data.lat, lng: data.lng });
        setActiveAddress(data.formattedAddress || query);
      }
    } catch {
      setAnalysisError('Geocoding service unavailable; using approximate placement.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // A suggestion picked from the autocomplete dropdown. Google Places Autocomplete
  // predictions only carry a description, so they go through the normal geocode call
  // to resolve coordinates; the lat/lng branch below is a defensive no-op today, kept
  // in case a future suggestion source (e.g. recent/saved locations) supplies them directly.
  const handleSelectSuggestion = (suggestion: AddressSuggestion) => {
    setAddressInput(suggestion.description);
    setAddressSuggestions([]);
    setShowSuggestions(false);
    if (suggestion.lat != null && suggestion.lng != null) {
      setCoords({ lat: suggestion.lat, lng: suggestion.lng });
      setActiveAddress(suggestion.description);
    } else {
      handleGeocode(suggestion.description);
    }
  };

  // Dropdown shared by both address inputs (single-address mode and Point A / route
  // mode) — must sit inside a `relative` wrapper around whichever input renders it.
  const renderSuggestionsDropdown = () => {
    if (!showSuggestions) return null;
    if (!isSuggestLoading && addressSuggestions.length === 0) return null;
    return (
      <div className="absolute z-30 left-0 right-0 top-full mt-1 bg-[var(--tcp-surface-1)] border border-[var(--tcp-border)] rounded-lg shadow-xl overflow-hidden max-h-56 overflow-y-auto">
        {isSuggestLoading && addressSuggestions.length === 0 && (
          <div className="px-3 py-2.5 text-[11px] text-[var(--tcp-text-tertiary)] font-mono flex items-center gap-2">
            <RefreshCw className="w-3 h-3 animate-spin" />
            <span>Searching addresses...</span>
          </div>
        )}
        {addressSuggestions.map((s, i) => (
          <button
            key={`${s.description}-${i}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleSelectSuggestion(s)}
            className="w-full text-left px-3 py-2 text-xs text-[var(--tcp-text-primary)] hover:bg-[var(--tcp-border)] border-b border-[var(--tcp-surface-2)] last:border-b-0 flex items-start gap-2"
          >
            <MapPin className="w-3.5 h-3.5 text-[var(--tcp-accent)] mt-0.5 shrink-0" />
            <span className="truncate">{s.description}</span>
          </button>
        ))}
      </div>
    );
  };

  // Run Site Analysis (Speed limit test, lane detection, manholes)
  // The actual purpose of this app: analyze a single work-site point directly
  // — finds the real road it's on and runs the full detection pipeline
  // (lanes, manholes, poles, speed) centered there, no manually traced route
  // required. handleComputeRouteAndAssets (below) still exists for the
  // multi-point workflow when someone specifically wants to trace a longer
  // corridor, but this is the direct path for "here's where we're working."
  const handleAnalyzeWorksite = async (
    advanceStep = true,
    overridePoint?: { lat: number; lng: number },
    relinkWorkSiteNear?: { lat: number; lng: number }
  ) => {
    const point = overridePoint || coords;
    if (!point) return;
    setIsAnalyzing(true);
    setAnalysisError(null);
    try {
      const resp = await fetch('/api/worksite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: point.lat,
          lng: point.lng,
          apiKey: googleApiKey,
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody.detail || `Work site analysis failed (HTTP ${resp.status}). Check the server logs — this is usually a missing road nearby or an API key issue.`);
      }

      const data = await resp.json();
      const assets: RouteAsset[] = data.assets || [];
      const speedLimitMph = data.speedLimitMph || 45;
      const roadName = data.roadName || 'Telecom Utility Route Corridor';
      const distanceFt = data.distanceFt || 400;
      setRoadNetwork(data.roadNetwork || []);
      setWorkSiteGeometricSide(data.workSiteSide === 'left' || data.workSiteSide === 'right' ? data.workSiteSide : null);
      setActiveDiagramRoad(null); // always land back on the main road's diagram for a fresh analysis

      // A fresh analysis re-runs vision detection, so every asset gets a new
      // id — a previously designated work-site manhole won't match by id
      // anymore even though it's very likely still present in the new list
      // (we just analyzed a segment centered exactly on it). Re-link the
      // designation to whichever manhole in the FRESH list is actually
      // closest to where it was, rather than silently losing it. A brand
      // new analysis with no relink target (not driven by re-selecting a
      // work site) clears any stale designation instead.
      if (relinkWorkSiteNear) {
        const manholes = assets.filter((a) => a.category === 'manholes');
        let closest: RouteAsset | null = null;
        let closestDist = Infinity;
        for (const m of manholes) {
          const d = haversineFt(relinkWorkSiteNear, { lat: m.lat, lng: m.lng });
          if (d < closestDist) {
            closestDist = d;
            closest = m;
          }
        }
        setWorkSiteAssetId(closest && closestDist <= 60 ? closest.id : null);
      } else {
        setWorkSiteAssetId(null);
      }

      // Each neighboring road gets its own independent diagram — a separate,
      // lightweight lookup (real geometry + real speed, no vision pass; see
      // analyze_road_reference()'s docstring), not merged into the main view.
      const network: RoadNetworkSegment[] = data.roadNetwork || [];
      if (network.length > 0) {
        Promise.all(
          network.map(async (road) => {
            try {
              const refResp = await fetch('/api/road-reference', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ points: road.points, apiKey: googleApiKey }),
              });
              if (!refResp.ok) return null;
              const ref = await refResp.json();
              const neighborDesign: DesignParams = {
                workType: 'shoulder',
                lanes: ref.lanesThisDirection || 2,
                speed: ref.speedLimitMph || 35,
                length: Math.min(160, ref.distanceFt || 160),
                offset: design.offset,
                duration: design.duration,
                contractorName: design.contractorName,
                projectName: `${road.name} (Connecting Road Reference)`,
                flaggersRequired: false,
                arrowBoardRequired: (ref.speedLimitMph || 35) >= 40,
                trenchPlates: false,
              };
              const neighborCorridor: RouteCorridor = {
                id: `corr-neighbor-${road.name}-${Date.now()}`,
                name: road.name,
                points: [],
                path: ref.path || road.points,
                distanceMeters: Math.round((ref.distanceFt || 300) / 3.28084),
                distanceFt: ref.distanceFt || 300,
                durationSec: 0,
                roadName: road.name,
                speedLimitMph: ref.speedLimitMph || 35,
                speedSource: ref.speedSource || 'heuristic',
              };
              return { name: road.name, design: neighborDesign, corridor: neighborCorridor };
            } catch {
              return null;
            }
          })
        ).then((results) => {
          setNeighborRoadDiagrams(results.filter((r): r is { name: string; design: DesignParams; corridor: RouteCorridor } => r !== null));
        });
      } else {
        setNeighborRoadDiagrams([]);
      }

      const newCorridor: RouteCorridor = {
        id: `corr-worksite-${Date.now()}`,
        name: roadName,
        points: [],
        path: data.path || [],
        distanceMeters: Math.round(distanceFt / 3.28084),
        distanceFt,
        durationSec: 0,
        roadName,
        speedLimitMph,
        speedSource: data.speedSource || 'google_roads_api',
      };
      setRouteCorridor(newCorridor);
      setRouteAssets(assets);

      setDesign((prev) => ({
        ...prev,
        speed: speedLimitMph,
        lanes: data.lanesThisDirection || prev.lanes,
        projectName: `${roadName} Telecom TCP`,
        arrowBoardRequired: speedLimitMph >= 40 || assets.some((a) => a.type === 'uturn_board'),
        flaggersRequired: assets.some((a) => a.type === 'school_zone') || prev.workType === 'two-lane',
        trenchPlates: assets.some((a) => a.category === 'manholes'),
      }));

      setAnalysis((prev) => ({
        ...(prev || SAMPLE_PROJECTS.preston.analysis),
        speed: speedLimitMph,
        speedSource: data.speedSource || 'google_roads_api',
        routeCorridor: newCorridor,
        routeAssets: assets,
        manholeCount: assets.filter((a) => a.category === 'manholes').length,
        schoolZone: assets.some((a) => a.type === 'school_zone'),
      }));

      setActiveAddress(roadName);
    } catch (err) {
      console.warn('Error analyzing work site:', err);
      setAnalysisError(err instanceof Error ? err.message : 'Work site analysis failed for an unknown reason — check the server logs.');
    } finally {
      setIsAnalyzing(false);
      if (advanceStep) {
        setStep(2);
      }
    }
  };

  // Compute multi-point route path and detect corridor assets with optimal route ordering
  const handleComputeRouteAndAssets = async (
    pointsToRoute: RoutePoint[] = routePoints,
    optimize: boolean = true
  ) => {
    if (!pointsToRoute || pointsToRoute.length < 2) return;
    setIsAnalyzing(true);
    setAnalysisError(null);

    try {
      // 1. Query route directions and polyline with optimal ordering
      const routeResp = await fetch('/api/compute-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: pointsToRoute,
          apiKey: googleApiKey,
          optimize,
        }),
      });

      if (!routeResp.ok) {
        const errBody = await routeResp.json().catch(() => ({}));
        throw new Error(errBody.detail || `Route computation failed (HTTP ${routeResp.status}). Check the server logs — this is usually a Google Maps API key or Routes API issue.`);
      }

      const routeData = await routeResp.json();
      const finalPoints =
        routeData.optimizedPoints && routeData.optimizedPoints.length > 0
          ? routeData.optimizedPoints
          : pointsToRoute;

      setRoutePoints(finalPoints);

      if (optimize && routeData.optimalOrder && routeData.optimalOrder.length > 1) {
        const orderSummary = finalPoints
          .map((p: RoutePoint) => p.label.split(' ')[0] + ' ' + (p.label.split(' ')[1] || ''))
          .join(' → ');
        setOptimalOrderNotice(`Optimal waypoint traversal path applied: ${orderSummary}`);
      } else {
        setOptimalOrderNotice(null);
      }

      const pathCoords = routeData.path || finalPoints.map((p: RoutePoint) => ({ lat: p.lat, lng: p.lng }));
      const distanceFt = routeData.distanceFt || 500;
      const roadName = routeData.roadName || 'Telecom Utility Route Corridor';

      // 2. Query route assets & obstructions along the corridor
      const assetResp = await fetch('/api/route-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: finalPoints,
          path: pathCoords,
          apiKey: googleApiKey,
          address: activeAddress,
        }),
      });

      if (!assetResp.ok) {
        const errBody = await assetResp.json().catch(() => ({}));
        throw new Error(errBody.detail || `Asset detection failed (HTTP ${assetResp.status}). Check the server logs — this is usually a Gemini or Google Maps API key issue.`);
      }

      const assetData = await assetResp.json();
      // No static fallback here on purpose — an empty list honestly means
      // "asked, found nothing real" and renders as such. Silently swapping
      // in a fixed-coordinate placeholder array here (as this used to do)
      // is exactly what made the diagram look identical across every route.
      const assets: RouteAsset[] = assetData.assets || [];
      const speedLimitMph = assetData.speedLimitMph || 45;

      const newCorridor: RouteCorridor = {
        id: `corr-${Date.now()}`,
        name: roadName,
        points: finalPoints,
        path: pathCoords,
        distanceMeters: routeData.distanceMeters || Math.round(distanceFt / 3.28084),
        distanceFt,
        durationSec: routeData.durationSec || 60,
        roadName: assetData.roadName || roadName,
        speedLimitMph,
        speedSource: assetData.speedSource || 'google_roads_api',
      };

      setRouteCorridor(newCorridor);
      setRouteAssets(assets);

      // Dynamically calibrate TCP Design parameters based on route details
      setDesign((prev) => ({
        ...prev,
        speed: speedLimitMph,
        lanes: assetData.lanesThisDirection || prev.lanes,
        length: Math.max(160, Math.min(1200, distanceFt)),
        projectName: `${roadName} Telecom TCP`,
        arrowBoardRequired: speedLimitMph >= 40 || assets.some((a) => a.type === 'uturn_board'),
        flaggersRequired: assets.some((a) => a.type === 'school_zone') || prev.workType === 'two-lane',
        trenchPlates: assets.some((a) => a.category === 'manholes'),
      }));

      // Update active address & coords
      if (finalPoints.length > 0) {
        setCoords({ lat: finalPoints[0].lat, lng: finalPoints[0].lng });
      }

      // Update site analysis
      const originPt = finalPoints[0];
      const nextPt = finalPoints[1] || finalPoints[0];
      const corridorHeading = originPt && nextPt ? computeHeading(originPt, nextPt) : 90;
      setAnalysis((prev) => ({
        ...(prev || SAMPLE_PROJECTS.preston.analysis),
        speed: speedLimitMph,
        speedSource: assetData.speedSource || 'google_roads_api',
        routeCorridor: newCorridor,
        routeAssets: assets,
        manholeCount: assets.filter((a) => a.category === 'manholes').length,
        schoolZone: assets.some((a) => a.type === 'school_zone'),
        streetViewUrl: originPt ? buildStreetViewUrl(originPt, corridorHeading) : prev?.streetViewUrl,
      }));
    } catch (err) {
      console.warn('Error calculating route corridor:', err);
      setAnalysisError(err instanceof Error ? err.message : 'Route/asset lookup failed for an unknown reason — check the server logs.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Recomputes the REAL approach route to a specific work-site manhole —
  // following actual roads and turns (e.g. a route that runs along PGA Pkwy
  // then turns onto Preston Rd to reach the manhole), not just reusing the
  // original traced route's geometry, which may terminate somewhere else on
  // the corridor entirely. Deliberately lighter than
  // handleComputeRouteAndAssets: this only recomputes path GEOMETRY via the
  // same proven /api/compute-route call — it does not re-run vision asset
  // detection, since we already have this exact manhole's data from the
  // detection that already ran.
  const handleSetWorkSite = async (asset: RouteAsset | null) => {
    if (!asset) {
      setWorkSiteAssetId(null);
      return;
    }
    // Re-run the SAME real-road-detection + fresh-vision-detection pipeline
    // used for the initial work site, centered on this manhole's own exact
    // position — not a generic point-to-point driving route computed via
    // /api/compute-route, which can take turns, loop around a median, or
    // otherwise produce a path that doesn't represent a straight segment of
    // the actual road the diagram assumes. This also means lanes, speed, and
    // every other detail get freshly re-verified for this exact location
    // instead of carrying over whatever the ORIGINAL analysis (before this
    // specific manhole was selected) happened to find.
    await handleAnalyzeWorksite(false, { lat: asset.lat, lng: asset.lng }, { lat: asset.lat, lng: asset.lng });
  };

  // Load sample permit projects
  const handleSelectSample = (key: string) => {
    const sample = SAMPLE_PROJECTS[key];
    if (!sample) return;
    setAddressInput(sample.label);
    setActiveAddress(sample.label);
    setCoords({ lat: sample.lat, lng: sample.lng });
    setAnalysis(sample.analysis);
    setDesign((prev) => ({
      ...prev,
      speed: sample.analysis.speed,
      lanes: sample.analysis.lanes,
    }));
  };

  // Waits two animation frames — reliable way to know React has committed a
  // state update AND the browser has painted it, without a magic-number timeout.
  const waitForPaint = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

  const handlePrint = async () => {
    setIsPreparingPrint(true);
    try {
      // The diagram only exists in the DOM while the CAD view is mounted —
      // switch to it first if the user was looking at the map.
      if (activeCanvasView !== 'cad') {
        setActiveCanvasView('cad');
        await waitForPaint();
      }
      const svgMarkup = cadCanvasRef.current?.getSVGMarkup() ?? null;
      setPrintSvgMarkup(svgMarkup);
      // Let the printable sheet set actually render the markup before invoking print.
      await waitForPaint();
      window.print();
    } finally {
      setIsPreparingPrint(false);
    }
  };

  const statusColorMap = {
    draft: 'bg-slate-800 text-[var(--tcp-text-secondary)] border-slate-700',
    submitted: 'bg-blue-950 text-blue-300 border-blue-700',
    review: 'bg-amber-950 text-amber-300 border-amber-700',
    approved: 'bg-emerald-950 text-emerald-300 border-emerald-700',
  };

  return (
    <div data-theme={theme} className="h-screen w-screen flex flex-col bg-[var(--tcp-canvas)] text-[var(--tcp-text-secondary)] overflow-hidden">
      <style>{`
        [data-theme="dark"] {
          --tcp-canvas: #0b121b;
          --tcp-surface-1: #101b28;
          --tcp-surface-2: #17283a;
          --tcp-surface-3: #1a2b3f;
          --tcp-border: #213c56;
          --tcp-border-hover: #2d4f6e;
          --tcp-accent: #e2600a;
          --tcp-accent-hover: #c9530a;
          --tcp-text-primary: #ffffff;
          --tcp-text-secondary: #cbd5e1;
          --tcp-text-tertiary: #94a3b8;
          --tcp-text-muted: #64748b;
          --tcp-surface-1-95: rgba(16, 27, 40, 0.95);
          --tcp-accent-20: rgba(226, 96, 10, 0.20);
          --tcp-accent-15: rgba(226, 96, 10, 0.15);
        }
        [data-theme="light"] {
          --tcp-canvas: #eef1f5;
          --tcp-surface-1: #ffffff;
          --tcp-surface-2: #f3f5f8;
          --tcp-surface-3: #e9edf3;
          --tcp-border: #d7dde6;
          --tcp-border-hover: #b8c2d0;
          --tcp-accent: #e2600a;
          --tcp-accent-hover: #c9530a;
          --tcp-text-primary: #101828;
          --tcp-text-secondary: #344054;
          --tcp-text-tertiary: #667085;
          --tcp-text-muted: #98a2b3;
          --tcp-surface-1-95: rgba(255, 255, 255, 0.95);
          --tcp-accent-20: rgba(226, 96, 10, 0.20);
          --tcp-accent-15: rgba(226, 96, 10, 0.15);
        }
      `}</style>
      {/* ===== TOP TITLE BLOCK BAR ===== */}
      <header className="h-14 bg-[var(--tcp-surface-1)] border-b border-[var(--tcp-border)] px-4 flex items-center justify-between shrink-0 z-30">
        <div className="flex items-center gap-4 min-w-0">
          {/* Brand */}
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-8 h-8 rounded bg-[var(--tcp-surface-2)] border border-[var(--tcp-border-hover)] flex items-center justify-center shadow-inner">
              <Compass className="w-5 h-5 text-[var(--tcp-accent)]" />
            </div>
            <div className="flex flex-col">
              <span className="font-display font-bold text-base tracking-wider text-[var(--tcp-text-primary)] leading-tight">
                INCEDO <span className="text-[var(--tcp-accent)]">TCP</span>
              </span>
              <span className="font-mono text-[9px] text-[#6ea8d8] tracking-widest uppercase">
                TELECOM STUDIO
              </span>
            </div>
          </div>

          <div className="h-6 w-px bg-[var(--tcp-border)] hidden sm:block shrink-0" />

          {/* Project Name Editor */}
          <div className="hidden md:flex flex-col min-w-0">
            <span className="text-[10px] font-mono text-[var(--tcp-text-tertiary)] uppercase tracking-wider">PROJECT</span>
            <input
              type="text"
              value={projectName}
              onChange={(e) => {
                setProjectName(e.target.value);
                setDesign((prev) => ({ ...prev, projectName: e.target.value }));
              }}
              className="bg-transparent border-b border-transparent hover:border-[var(--tcp-border-hover)] focus:border-[var(--tcp-accent)] text-xs font-semibold text-[var(--tcp-text-primary)] outline-none px-0 py-0.5 max-w-[240px] truncate"
            />
          </div>

          <div className="h-6 w-px bg-[var(--tcp-border)] hidden lg:block shrink-0" />

          {/* Site Address */}
          <div className="hidden lg:flex flex-col min-w-0 max-w-xs">
            <span className="text-[10px] font-mono text-[var(--tcp-text-tertiary)] uppercase tracking-wider">SITE LOCATION</span>
            <span className="text-xs text-[var(--tcp-text-primary)] truncate font-mono" title={activeAddress}>
              {activeAddress || 'No location specified'}
            </span>
          </div>
        </div>

        {/* Header Right Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <span className={`px-2.5 py-1 text-[11px] font-mono uppercase font-bold rounded-full border ${statusColorMap[status]}`}>
            {status}
          </span>

          {/* Light / Dark Theme Toggle */}
          <button
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            className="p-1.5 rounded border border-[var(--tcp-border)] bg-[var(--tcp-surface-2)] text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)] hover:border-[var(--tcp-border-hover)] transition-colors"
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>

          {/* MUTCD Configuration */}
          <button
            onClick={() => setShowConfigModal(true)}
            className="p-1.5 rounded border border-[var(--tcp-border)] bg-[var(--tcp-surface-2)] text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)] hover:border-[var(--tcp-border-hover)] transition-colors"
            title="MUTCD tables & drawing configuration"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>

          {/* Google Maps API Key Button */}
          <button
            onClick={handleOpenApiKeyModal}
            className={`px-2.5 py-1.5 rounded text-xs font-medium border flex items-center gap-1.5 transition-colors ${
              googleApiKey
                ? 'bg-[#152e25] border-emerald-600 text-emerald-300 hover:bg-[#1a382d]'
                : serverHasKey
                ? 'bg-[#182939] border-blue-600 text-blue-300 hover:bg-[#20364c]'
                : 'bg-[var(--tcp-surface-2)] border-[var(--tcp-border)] text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)] hover:border-[var(--tcp-border-hover)]'
            }`}
            title="Configure Google Maps API Key"
          >
            <Key className={`w-3.5 h-3.5 ${googleApiKey ? 'text-emerald-400' : 'text-[var(--tcp-accent)]'}`} />
            <span className="hidden sm:inline">
              {googleApiKey
                ? 'Google Maps: Connected'
                : serverHasKey
                ? 'Google Maps: Server Key'
                : 'Configure Maps API'}
            </span>
          </button>

          <button
            onClick={() => setStep(3)}
            className="px-3 py-1.5 bg-[var(--tcp-surface-2)] hover:border-[var(--tcp-border-hover)] border border-[var(--tcp-border)] text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)] text-xs font-semibold rounded flex items-center gap-1.5"
            title="Full Intersection Plan -- aerial/CAD-backed, 5-phase plan set with interactive viewer (Step 3)"
          >
            <MapPinned className="w-3.5 h-3.5 text-[var(--tcp-accent)]" />
            <span className="hidden sm:inline">Full Intersection Plan</span>
          </button>

          <button
            onClick={handlePrint}
            disabled={isPreparingPrint}
            className="px-3 py-1.5 bg-[var(--tcp-accent)] hover:bg-[var(--tcp-accent-hover)] disabled:opacity-60 text-[var(--tcp-text-primary)] text-xs font-semibold rounded flex items-center gap-1.5 shadow"
            title="Export full printable permit set"
          >
            {isPreparingPrint ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{isPreparingPrint ? 'Preparing…' : 'Export Drawing Set'}</span>
          </button>
        </div>
      </header>

      {/* ===== 6-STEP PHASE STEPPER ===== */}
      <nav className="h-11 bg-[var(--tcp-surface-2)] border-b border-[var(--tcp-border)] px-4 flex items-center overflow-x-auto scrollbar-none shrink-0 z-20">
        {[
          { num: 1, label: '1. Locate site' },
          { num: 2, label: '2. Site analysis' },
          { num: 3, label: '3. TCP plan' },
          { num: 4, label: '4. Design parameters' },
          { num: 5, label: '5. TCP diagram' },
          { num: 6, label: '6. Review & submit' },
        ].map((s) => {
          const isActive = step === s.num;
          const isDone = step > s.num;
          return (
            <button
              key={s.num}
              onClick={() => setStep(s.num)}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors relative ${
                isActive
                  ? 'text-[var(--tcp-text-primary)]'
                  : isDone
                  ? 'text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)]'
                  : 'text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-primary)]'
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center font-mono text-[11px] font-bold ${
                  isActive
                    ? 'bg-[var(--tcp-accent)] text-[var(--tcp-text-primary)]'
                    : isDone
                    ? 'bg-emerald-600 text-[var(--tcp-text-primary)]'
                    : 'bg-[var(--tcp-surface-1)] border border-[var(--tcp-border-hover)] text-[var(--tcp-text-tertiary)]'
                }`}
              >
                {isDone ? '✓' : s.num}
              </span>
              <span>{s.label}</span>
              {isActive && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--tcp-accent)]" />
              )}
            </button>
          );
        })}

        {/* Route Corridor Assets & Obstructions — opens as a modal instead of a
            persistent bottom drawer, so it doesn't eat map real estate. */}
        {routeAssets.length > 0 && (
          <button
            onClick={() => setShowAssetModal(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-[var(--tcp-border)] bg-[var(--tcp-surface-1)] text-[11px] font-semibold text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)] hover:border-[var(--tcp-border-hover)] transition-colors"
            title="View route corridor assets & obstructions"
          >
            <Layers className="w-3.5 h-3.5 text-[var(--tcp-accent)]" />
            <span>Assets</span>
            <span className="px-1.5 py-0 rounded-full bg-[var(--tcp-accent)] text-[var(--tcp-text-primary)] text-[10px] font-mono font-bold">
              {routeAssets.length}
            </span>
          </button>
        )}

        {/* Toggle Canvas Button (Map vs CAD) -- hidden on Step 3 (TCP Plan), which is
            full-page and has no map/CAD canvas to toggle. */}
        {step !== 3 && (
        <div className="ml-auto flex items-center gap-1 bg-[var(--tcp-surface-1)] p-0.5 rounded border border-[var(--tcp-border)] text-xs">
          <button
            onClick={() => setActiveCanvasView('map')}
            className={`px-2 py-1 rounded text-[11px] font-semibold flex items-center gap-1 ${
              activeCanvasView === 'map' ? 'bg-[var(--tcp-border)] text-[var(--tcp-text-primary)]' : 'text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-primary)]'
            }`}
          >
            <MapPin className="w-3 h-3" />
            <span>GIS Map</span>
          </button>
          <button
            onClick={() => setActiveCanvasView('cad')}
            className={`px-2 py-1 rounded text-[11px] font-semibold flex items-center gap-1 ${
              activeCanvasView === 'cad' ? 'bg-[var(--tcp-border)] text-[var(--tcp-text-primary)]' : 'text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-primary)]'
            }`}
          >
            <Compass className="w-3 h-3" />
            <span>CAD Drawing</span>
          </button>
        </div>
        )}
      </nav>

      {/* ===== WORKSPACE BODY ===== */}
      <main className="flex-1 flex min-h-0 overflow-hidden relative">
        {step === 3 ? (
          /* STEP 3: TCP PLAN -- full page, not the usual map/CAD canvas + 440px
             sidebar split every other step uses. This is the aerial/CAD-backed,
             5-phase plan set (sheet switcher, pan/zoom SVG viewer, PDF/DXF/bundle
             export) -- it needs real room to be usable, which is exactly what the
             old header-popup version of this panel didn't have. Same component,
             same autoFill source as that popup used; just rendered `embedded` so
             it fills this step instead of opening a modal. */
          <div className="absolute inset-0 flex flex-col">
            <div className="px-5 py-2.5 shrink-0 border-b border-[var(--tcp-border)] flex items-baseline gap-3">
              <h2 className="font-display font-bold text-base text-[var(--tcp-text-primary)] tracking-wide shrink-0">
                TCP PLAN — FULL INTERSECTION PLAN
              </h2>
              <p className="text-[11px] text-[var(--tcp-text-tertiary)] leading-snug truncate">
                {tcpPlanMode === 'full'
                  ? 'Auto-filled from the site located in Steps 1–2 — separate from the Step 4–5 corridor design below.'
                  : 'CV auto-detects each leg from a plain aerial screenshot — no lat/lng or mapped site needed.'}
              </p>
              <div className="ml-auto flex items-center gap-1 bg-[var(--tcp-surface-2)] p-0.5 rounded border border-[var(--tcp-border)] text-xs shrink-0">
                <button
                  onClick={() => setTcpPlanMode('full')}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold ${
                    tcpPlanMode === 'full' ? 'bg-[var(--tcp-border)] text-[var(--tcp-text-primary)]' : 'text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-primary)]'
                  }`}
                  title="Build the plan from the site mapped in Steps 1–2 (auto-fill) or a hand-provided site JSON"
                >
                  Full Intersection Plan
                </button>
                <button
                  onClick={() => setTcpPlanMode('roadDetect')}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold ${
                    tcpPlanMode === 'roadDetect' ? 'bg-[var(--tcp-border)] text-[var(--tcp-text-primary)]' : 'text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-primary)]'
                  }`}
                  title="Detect road geometry from a screenshot with computer vision, correct it, then regenerate"
                >
                  Auto-Detect Roads (CV)
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              {tcpPlanMode === 'full' ? (
                <FullIntersectionPlanPanel
                  embedded
                  autoFill={{
                    center: coords,
                    roadNetwork,
                    tracedFeatures,
                    captureScreenshot: captureScreenshotForAutoFill,
                  }}
                />
              ) : (
                <RoadDetectPanel embedded />
              )}
            </div>

            {/* Navigation Buttons -- pinned footer (not scrolled away with the form/
                preview above), matching every other step's Back/Next pattern. The top
                stepper bar can also jump here directly, but this keeps the in-content
                flow consistent. */}
            <div className="shrink-0 border-t border-[var(--tcp-border)] bg-[var(--tcp-surface-1)] px-5 py-3 flex gap-2">
              <button
                onClick={() => setStep(2)}
                className="px-3 py-2 bg-[var(--tcp-surface-2)] hover:bg-[var(--tcp-border)] text-[var(--tcp-text-secondary)] text-xs font-semibold rounded border border-[var(--tcp-border)] flex items-center gap-1.5"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
              <button
                onClick={() => setStep(4)}
                className="flex-1 py-2 bg-[var(--tcp-accent)] hover:bg-[var(--tcp-accent-hover)] text-[var(--tcp-text-primary)] font-semibold text-xs rounded shadow flex items-center justify-center gap-1.5"
              >
                <span>Continue to Design Parameters</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : (
        <>
        {/* Left Side: Interactive Viewer (GIS Map OR CAD Canvas) */}
        <section className="flex-1 relative bg-[var(--tcp-canvas)] min-w-0 border-r border-[var(--tcp-border)] flex flex-col">
          {activeCanvasView === 'map' ? (
            <div className="flex-1 flex flex-col min-h-0 relative">
              {/* Map Provider Toggle — Leaflet needs no API key and works
                  offline-ish; Google Maps needs a client-side key (the same
                  one from the header's key modal) since it loads directly in
                  the browser, unlike the server-side Street View/Roads calls
                  elsewhere in this app. */}
              <div className="absolute top-3 right-3 z-[600] flex items-center gap-1 bg-[var(--tcp-surface-1)] p-0.5 rounded border border-[var(--tcp-border)] text-xs shadow-lg">
                <button
                  onClick={() => setMapProvider('leaflet')}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold ${
                    mapProvider === 'leaflet' ? 'bg-[var(--tcp-border)] text-[var(--tcp-text-primary)]' : 'text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-primary)]'
                  }`}
                >
                  Leaflet
                </button>
                <button
                  onClick={() => setMapProvider('google')}
                  title={!googleApiKey ? 'Requires a Google Maps API key (see the key icon in the header)' : undefined}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold ${
                    mapProvider === 'google' ? 'bg-[var(--tcp-border)] text-[var(--tcp-text-primary)]' : 'text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-primary)]'
                  }`}
                >
                  Google Maps
                </button>
              </div>

              <div className="flex-1 relative min-h-0">
                {(() => {
                  const mapViewProps = {
                    coords,
                    onLocationChange: (newCoord: LatLng, hint?: string) => {
                      setCoords(newCoord);
                      if (hint) setActiveAddress(hint);
                    },
                    polygon,
                    onPolygonChange: (pts: LatLng[], len: number) => {
                      setPolygon(pts);
                      setPolygonLength(len);
                      setDesign((prev) => ({ ...prev, length: len > 50 ? len : prev.length }));
                    },
                    mode: mapMode,
                    onModeChange: setMapMode,
                    googleApiKey,
                    routePoints,
                    onRoutePointsChange: (pts: RoutePoint[]) => {
                      setRoutePoints(pts);
                    },
                    routeCorridor,
                    routeAssets,
                    selectedAssetId,
                    onSelectAsset: (asset: RouteAsset) => setSelectedAssetId(asset.id),
                    onSetWorkSite: (asset: RouteAsset) => {
                      handleSetWorkSite(asset);
                    },
                    bboxCorners,
                    onBboxComplete: (corners: LatLng[]) => {
                      setBboxCorners(corners);
                    },
                    tracedFeatures,
                    onTracedFeaturesChange: (features: TracedFeature[]) => {
                      setTracedFeatures(features);
                    },
                  };
                  return mapProvider === 'google' ? <GoogleMapView ref={googleMapRef} {...mapViewProps} /> : <GISMap ref={gisMapRef} {...mapViewProps} />;
                })()}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0">
              {planStyle === 'laneClosure' ? (
                <div className="flex-1 min-h-0 p-3 overflow-auto">
                  {laneClosureMode === 'intersection' ? (
                    <LaneClosureIntersectionPanel preset={intersectionPresetIdx != null ? LANE_CLOSURE_PRESETS[intersectionPresetIdx] : undefined} />
                  ) : (
                    <LaneClosureDiagramStage params={laneClosureParams} laneClosure={laneClosure} />
                  )}
                </div>
              ) : (
              <>
              <div className="flex items-center justify-between px-3 py-2 bg-[var(--tcp-surface-1)] border-b border-[var(--tcp-border)] shrink-0">
                <div className="flex items-center gap-1.5 overflow-x-auto">
                  {neighborRoadDiagrams.length > 0 && (
                    <>
                      <span className="text-[10px] font-mono uppercase text-[var(--tcp-text-tertiary)] shrink-0 mr-1">Diagram:</span>
                      <button
                        onClick={() => setActiveDiagramRoad(null)}
                        className={`px-2.5 py-1 text-[11px] font-semibold rounded whitespace-nowrap transition-colors ${
                          !activeDiagramRoad
                            ? 'bg-[var(--tcp-accent)] text-[var(--tcp-text-primary)]'
                            : 'bg-[var(--tcp-surface-2)] text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)] border border-[var(--tcp-border)]'
                        }`}
                      >
                        {routeCorridor?.roadName || 'Main Work Site'}
                      </button>
                      {neighborRoadDiagrams.map((r) => (
                        <button
                          key={r.name}
                          onClick={() => setActiveDiagramRoad(r.name)}
                          className={`px-2.5 py-1 text-[11px] font-semibold rounded whitespace-nowrap transition-colors ${
                            activeDiagramRoad === r.name
                              ? 'bg-[var(--tcp-accent)] text-[var(--tcp-text-primary)]'
                              : 'bg-[var(--tcp-surface-2)] text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)] border border-[var(--tcp-border)]'
                          }`}
                          title={`${r.name} — its own full TCP plan (real geometry & posted speed; lane count from OSM tagging when available, otherwise a speed-based estimate). Not vision-surveyed like the main work site.`}
                        >
                          {r.name}
                        </button>
                      ))}
                    </>
                  )}
                </div>
                {showTracedPlan && (
                  <span className="px-2.5 py-1 text-[11px] font-semibold rounded whitespace-nowrap border border-[var(--tcp-border)] shrink-0 bg-[var(--tcp-accent)] text-[var(--tcp-text-primary)]">
                    Traced Intersection Plan
                  </span>
                )}
              </div>
              {activeDiagramRoad && !showTracedPlan && (
                <div className="px-3 py-1.5 bg-amber-950/40 border-b border-amber-800/60 text-[10px] text-amber-200 shrink-0">
                  Connecting road — its own full TCP plan below, built from real geometry, posted speed, and lane count where OSM has it tagged (otherwise a speed-based estimate). Not vision-surveyed like the main work site's diagram.
                </div>
              )}
              {showTracedPlan ? (
                <div className="flex-1 min-h-0 p-3">
                  <IntersectionDiagramPreview
                    ref={intersectionPreviewRef}
                    corridor={routeCorridor}
                    design={design}
                    tracedFeatures={tracedFeatures}
                  />
                </div>
              ) : (
            <CADCanvas
              ref={cadCanvasRef}
              design={activeDiagramRoad ? (neighborRoadDiagrams.find((r) => r.name === activeDiagramRoad)?.design || design) : design}
              metrics={activeDiagramRoad ? computeMUTCDMetrics(neighborRoadDiagrams.find((r) => r.name === activeDiagramRoad)?.design || design, mutcdConfig) : metrics}
              analysis={analysis}
              address={activeAddress}
              projectName={projectName}
              onPrint={handlePrint}
              routeAssets={activeDiagramRoad ? [] : routeAssets}
              corridor={activeDiagramRoad ? (neighborRoadDiagrams.find((r) => r.name === activeDiagramRoad)?.corridor || routeCorridor) : routeCorridor}
              dividedHighway={dividedHighway}
              opposingLanes={opposingLanes}
              workSide={workSide}
              workSiteAssetId={workSiteAssetId}
              userBbox={bboxCorners}
              googleApiKey={googleApiKey}
            />
              )}
              </>
              )}
            </div>
          )}
        </section>

        {/* Right Side: Step Engineering Control Panel */}
        <aside className="w-[440px] shrink-0 bg-[var(--tcp-surface-1)] flex flex-col min-h-0 overflow-y-auto p-5 border-l border-[var(--tcp-border)]">
          {/* STEP 1: LOCATE SITE */}
          {step === 1 && (
            <div className="space-y-5 animate-fadeIn">
              <div>
                <h2 className="font-display font-bold text-xl text-[var(--tcp-text-primary)] tracking-wide">
                  LOCATE TELECOM WORK SITE
                </h2>
                <p className="text-xs text-[var(--tcp-text-tertiary)] mt-1 leading-relaxed">
                  Enter the public right-of-way permit address or trace the road corridor directly on the GIS map. Coordinates drive the Google Maps speed test and Street View asset survey.
                </p>
              </div>

              {/* Mode Toggle — 3 options: point a single work site directly,
                  trace the corridor centerline (calibrates work-zone
                  length), or draw a 4-point bounding box first (used as the
                  background-layer area for the generated TCP diagram) and
                  then point the work site within it. */}
              <div className="grid grid-cols-2 rounded-md bg-[var(--tcp-surface-2)] p-1 border border-[var(--tcp-border)] gap-1">
                <button
                  onClick={() => setMapMode('address')}
                  className={`py-1.5 px-2 text-xs font-semibold rounded flex items-center justify-center gap-1 transition-colors ${
                    mapMode === 'address' ? 'bg-[var(--tcp-accent)] text-[var(--tcp-text-primary)] shadow' : 'text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)]'
                  }`}
                >
                  <MapPin className="w-3.5 h-3.5" />
                  <span>Point Work Site</span>
                </button>
                <button
                  onClick={() => setMapMode('draw')}
                  className={`py-1.5 px-2 text-xs font-semibold rounded flex items-center justify-center gap-1 transition-colors ${
                    mapMode === 'draw' ? 'bg-[var(--tcp-accent)] text-[var(--tcp-text-primary)] shadow' : 'text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)]'
                  }`}
                >
                  <Pencil className="w-3.5 h-3.5" />
                  <span>Trace Corridor</span>
                </button>
                <button
                  onClick={() => setMapMode('bbox')}
                  className={`py-1.5 px-2 text-xs font-semibold rounded flex items-center justify-center gap-1 transition-colors ${
                    mapMode === 'bbox' ? 'bg-[var(--tcp-accent)] text-[var(--tcp-text-primary)] shadow' : 'text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)]'
                  }`}
                  title="Click 4 points to define the area used for the TCP diagram's background road layer, then point the work site within it"
                >
                  <Square className="w-3.5 h-3.5" />
                  <span>Bounding Box</span>
                </button>
                <button
                  onClick={() => setMapMode('trace')}
                  className={`py-1.5 px-2 text-xs font-semibold rounded flex items-center justify-center gap-1 transition-colors ${
                    mapMode === 'trace' ? 'bg-[var(--tcp-accent)] text-[var(--tcp-text-primary)] shadow' : 'text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)]'
                  }`}
                  title="Trace the real road edges, crosswalks and sidewalks by hand directly over the satellite image -- use this when the auto-generated road shape doesn't match the real intersection. Google Maps view only, for now."
                >
                  <Waypoints className="w-3.5 h-3.5" />
                  <span>Trace Intersection</span>
                </button>
              </div>
              {mapMode === 'trace' && mapProvider !== 'google' && (
                <div className="mt-2 px-3 py-1.5 bg-amber-950/40 border border-amber-800/60 rounded text-[10px] text-amber-200">
                  The tracing toolbar only appears on the Google Maps view right now — switch the map provider toggle (top-right of the map) to "Google Maps" to trace.
                </div>
              )}
              {mapMode === 'trace' && tracedFeatures.length > 0 && (
                <div className="mt-2 px-3 py-1.5 bg-blue-950/40 border border-blue-800/60 rounded text-[10px] text-blue-200">
                  {tracedFeatures.length} feature{tracedFeatures.length === 1 ? '' : 's'} traced — the intersection diagram will be built from this hand-traced geometry instead of local OSM data. Set each road leg's lane count and posted speed in the trace toolbar before generating.
                </div>
              )}

              {mapMode === 'bbox' && (
                <div className="mt-2 p-3.5 bg-[var(--tcp-surface-2)] rounded-lg border border-[var(--tcp-border)] text-xs text-[var(--tcp-text-secondary)] space-y-1.5">
                  <div className="font-semibold text-[var(--tcp-text-primary)] flex items-center gap-1.5">
                    <Square className="w-4 h-4 text-[var(--tcp-accent)]" />
                    <span>Bounding Box — {bboxCorners.length < 4 ? `click ${4 - bboxCorners.length} more corner${4 - bboxCorners.length === 1 ? '' : 's'}` : 'complete'}</span>
                  </div>
                  <p className="text-[var(--tcp-text-tertiary)] leading-relaxed text-[11px]">
                    Click 4 points on the map to define the area. Once the 4th point is placed, this switches back to work-site selection automatically — click within the box to point the work site.
                  </p>
                </div>
              )}
              {bboxCorners.length === 4 && mapMode !== 'bbox' && (
                <div className="mt-2 px-3 py-1.5 bg-blue-950/40 border border-blue-800/60 rounded text-[10px] text-blue-200">
                  Bounding box set — the generated TCP diagram will use this area's road network as its background layer.
                </div>
              )}

              {bboxCorners.length === 4 && (
                <button
                  onClick={handleCaptureBboxScreenshot}
                  disabled={capturingScreenshot}
                  className="mt-2 w-full py-1.5 px-2 text-xs font-semibold rounded flex items-center justify-center gap-1.5 border border-[var(--tcp-border)] bg-[var(--tcp-surface-2)] text-[var(--tcp-text-primary)] disabled:opacity-60"
                  title="Downloads the current map view as a PNG, with the bounding box outline and current zoom level burned into the image"
                >
                  {capturingScreenshot ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
                  <span>{capturingScreenshot ? 'Capturing…' : 'Capture Bounding Box Screenshot'}</span>
                </button>
              )}
              {captureError && (
                <div className="mt-1.5 px-3 py-1.5 bg-red-950/40 border border-red-800/60 rounded text-[10px] text-red-200">
                  {captureError}
                </div>
              )}

              {/* Error display and the corridor/asset summary apply regardless
                  of how the work site was set, so they render once here
                  rather than duplicated per mode. */}
              {analysisError && (
                <div className="p-2 rounded bg-red-950/60 border border-red-700/70 text-[11px] text-red-200 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                  <span className="flex-1">{analysisError}</span>
                  <button onClick={() => setAnalysisError(null)} className="text-red-400 hover:text-red-200 shrink-0" title="Dismiss">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {routeCorridor && (
                <div className="p-3 bg-[var(--tcp-surface-1)] rounded-lg border border-[var(--tcp-border)] space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="min-w-0">
                      <span className="font-semibold text-[var(--tcp-text-primary)] block truncate">{routeCorridor.roadName}</span>
                      <span className="text-[10px] font-mono text-[var(--tcp-accent)]">
                        Total Length: {routeCorridor.distanceFt} FT ({Math.round(routeCorridor.distanceFt / 52.8) / 100} mi)
                      </span>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950 text-emerald-300 border border-emerald-800 shrink-0">
                      {routeCorridor.speedLimitMph} MPH POSTED
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-1.5 text-[11px] pt-1">
                    <div className="p-1.5 bg-[var(--tcp-surface-2)] rounded border border-[var(--tcp-border)] flex items-center justify-between">
                      <span className="text-[var(--tcp-text-tertiary)] flex items-center gap-1">
                        <Gauge className="w-3 h-3 text-emerald-400" />
                        Speed Signs
                      </span>
                      <strong className="text-[var(--tcp-text-primary)] font-mono">
                        {routeAssets.filter((a) => a.type === 'speed_sign').length}
                      </strong>
                    </div>

                    <div className="p-1.5 bg-[var(--tcp-surface-2)] rounded border border-[var(--tcp-border)] flex items-center justify-between">
                      <span className="text-[var(--tcp-text-tertiary)] flex items-center gap-1">
                        <RotateCcw className="w-3 h-3 text-amber-400" />
                        U-Turn Boards
                      </span>
                      <strong className="text-[var(--tcp-text-primary)] font-mono">
                        {routeAssets.filter((a) => a.type === 'uturn_board').length}
                      </strong>
                    </div>

                    <div className="p-1.5 bg-[var(--tcp-surface-2)] rounded border border-[var(--tcp-border)] flex items-center justify-between">
                      <span className="text-[var(--tcp-text-tertiary)] flex items-center gap-1">
                        <School className="w-3 h-3 text-yellow-300" />
                        School Zones
                      </span>
                      <strong className="text-[var(--tcp-text-primary)] font-mono">
                        {routeAssets.filter((a) => a.type === 'school_zone').length}
                      </strong>
                    </div>

                    <div className="p-1.5 bg-[var(--tcp-surface-2)] rounded border border-[var(--tcp-border)] flex items-center justify-between">
                      <span className="text-[var(--tcp-text-tertiary)] flex items-center gap-1">
                        <Disc className="w-3 h-3 text-cyan-400" />
                        Manholes &amp; Vaults
                      </span>
                      <strong className="text-[var(--tcp-text-primary)] font-mono">
                        {routeAssets.filter((a) => a.category === 'manholes').length}
                      </strong>
                    </div>

                    <div className="p-1.5 bg-[var(--tcp-surface-2)] rounded border border-[var(--tcp-border)] flex items-center justify-between">
                      <span className="text-[var(--tcp-text-tertiary)] flex items-center gap-1">
                        <Zap className="w-3 h-3 text-blue-400" />
                        Electric Poles
                      </span>
                      <strong className="text-[var(--tcp-text-primary)] font-mono">
                        {routeAssets.filter((a) => a.category === 'electric_poles').length}
                      </strong>
                    </div>

                    <div className="p-1.5 bg-[var(--tcp-surface-2)] rounded border border-[var(--tcp-border)] flex items-center justify-between">
                      <span className="text-[var(--tcp-text-tertiary)] flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3 text-orange-400" />
                        Obstructions
                      </span>
                      <strong className="text-[var(--tcp-text-primary)] font-mono">
                        {routeAssets.filter((a) => a.category === 'obstructions').length}
                      </strong>
                    </div>
                  </div>
                </div>
              )}

              {/* SINGLE ADDRESS MODE */}
              {mapMode === 'address' && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                      US Roadway or Pathway Address
                    </label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input
                          type="text"
                          value={addressInput}
                          onChange={(e) => setAddressInput(e.target.value)}
                          onFocus={() => setShowSuggestions(true)}
                          onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
                          onKeyDown={(e) => e.key === 'Enter' && handleGeocode(addressInput)}
                          placeholder="e.g. 15300 Preston Rd, Frisco, TX"
                          className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] placeholder:text-[var(--tcp-text-muted)] focus:border-[var(--tcp-accent)] outline-none"
                        />
                        {renderSuggestionsDropdown()}
                      </div>
                      <button
                        onClick={() => handleGeocode(addressInput)}
                        disabled={isAnalyzing}
                        className="px-3.5 py-2 bg-[var(--tcp-border)] hover:bg-[var(--tcp-border-hover)] text-[var(--tcp-text-primary)] text-xs font-semibold rounded flex items-center gap-1.5 transition-colors"
                      >
                        <Search className="w-3.5 h-3.5" />
                        <span>Locate</span>
                      </button>
                    </div>
                  </div>

                  {/* Sample Projects from Permit Set */}
                  <div className="pt-2">
                    <span className="text-[11px] font-mono text-[var(--tcp-text-tertiary)] uppercase tracking-wider block mb-2">
                      Load Sample Permit Projects (Frisco / Celina TX)
                    </span>
                    <div className="space-y-1.5">
                      {Object.values(SAMPLE_PROJECTS).map((s) => (
                        <button
                          key={s.key}
                          onClick={() => handleSelectSample(s.key)}
                          className="w-full text-left p-2.5 rounded bg-[var(--tcp-surface-2)] hover:bg-[var(--tcp-border)] border border-[var(--tcp-border)] transition-colors flex items-center justify-between group"
                        >
                          <div>
                            <div className="text-xs font-semibold text-[var(--tcp-text-primary)] group-hover:text-[var(--tcp-text-primary)]">
                              {s.label}
                            </div>
                            <div className="text-[10px] text-[var(--tcp-text-tertiary)] mt-0.5">
                              {s.analysis.classification} · {s.analysis.speed} MPH · {s.analysis.manholeCount} Manhole(s)
                            </div>
                          </div>
                          <ArrowRight className="w-3.5 h-3.5 text-[var(--tcp-text-muted)] group-hover:text-[var(--tcp-accent)]" />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* CORRIDOR POLYGON DRAW MODE */}
              {mapMode === 'draw' && (
                <div className="p-3.5 bg-[var(--tcp-surface-2)] rounded-lg border border-[var(--tcp-border)] text-xs text-[var(--tcp-text-secondary)] space-y-2">
                  <div className="font-semibold text-[var(--tcp-text-primary)] flex items-center gap-1.5">
                    <Pencil className="w-4 h-4 text-[var(--tcp-accent)]" />
                    <span>Corridor Polygon Tracing Active</span>
                  </div>
                  <p className="text-[var(--tcp-text-tertiary)] leading-relaxed text-[11px]">
                    Click consecutive points along the road centerline on the GIS map to define the work corridor. Double click to seal. The measured length ({polygonLength} ft) will automatically calibrate the work-zone length parameter.
                  </p>
                  <div className="pt-2 flex items-center justify-between font-mono text-xs text-[var(--tcp-text-secondary)]">
                    <span>Traced Points: {polygon.length}</span>
                    <span className="text-[var(--tcp-accent)] font-bold">Length: {polygonLength} FT</span>
                  </div>
                </div>
              )}

              {/* Action Button: Create Traffic Control Plan */}
              <div className="pt-3 border-t border-[var(--tcp-border)]">
                <button
                  onClick={() => {
                    if (mapMode === 'route') {
                      // Calibrate design with route metrics and advance
                      setDesign((prev) => ({
                        ...prev,
                        speed: routeCorridor?.speedLimitMph || prev.speed,
                        length: routeCorridor?.distanceFt || prev.length,
                        arrowBoardRequired: (routeCorridor?.speedLimitMph || prev.speed) >= 40 || routeAssets.some((a) => a.type === 'uturn_board'),
                        flaggersRequired: routeAssets.some((a) => a.type === 'school_zone'),
                        trenchPlates: routeAssets.some((a) => a.category === 'manholes'),
                      }));
                      setStep(2);
                    } else {
                      // Point directly at the work site — finds the real road,
                      // runs the same lane/manhole/pole detection route mode
                      // uses, no manually traced route required.
                      handleAnalyzeWorksite();
                    }
                  }}
                  disabled={isAnalyzing || (mapMode === 'route' ? (routePoints.length < 2 || !routeCorridor) : !coords)}
                  className="w-full py-2.5 bg-[var(--tcp-accent)] hover:bg-[var(--tcp-accent-hover)] disabled:opacity-50 text-[var(--tcp-text-primary)] font-semibold text-xs rounded-md shadow flex items-center justify-center gap-2 transition-colors"
                >
                  {isAnalyzing ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>{mapMode === 'route' ? 'Scanning Route & Obstructions...' : 'Analyzing Work Site...'}</span>
                    </>
                  ) : (
                    <>
                      <span>Generate Traffic Control Plan (TCP) for {mapMode === 'route' ? 'Route' : 'Work Site'}</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
                {mapMode === 'route' && routePoints.length < 2 && (
                  <p className="text-[11px] text-[var(--tcp-text-muted)] mt-1.5 text-center">
                    Search an address or place at least 2 points on the map to enable this.
                  </p>
                )}
                {mapMode === 'address' && !coords && (
                  <p className="text-[11px] text-[var(--tcp-text-muted)] mt-1.5 text-center">
                    Search an address or click on the map to point at the work site first.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* STEP 2: SITE ANALYSIS */}
          {step === 2 && analysis && (
            <div className="space-y-5 animate-fadeIn">
              <div>
                <h2 className="font-display font-bold text-xl text-[var(--tcp-text-primary)] tracking-wide">
                  SITE ANALYSIS &amp; ASSET DETECTION
                </h2>
                <p className="text-xs text-[var(--tcp-text-tertiary)] mt-1 leading-relaxed">
                  Pulled via Google Maps API &amp; Open GIS datasets. Computer vision highlights speed signs, existing telecom vaults/manholes, and school zone boards.
                </p>
              </div>

              {/* Speed Test Metric Card */}
              <div className="p-3.5 bg-[var(--tcp-surface-2)] rounded-lg border border-[var(--tcp-border)]">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] font-mono text-[var(--tcp-text-tertiary)] uppercase">Posted Speed Limit</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950 text-emerald-300 border border-emerald-800">
                    {analysis.speedSource === 'google_roads_api' ? 'GOOGLE ROADS API' : 'GIS TESTED'}
                  </span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-3xl font-bold text-[var(--tcp-text-primary)]">{analysis.speed}</span>
                  <span className="text-sm font-semibold text-[var(--tcp-text-tertiary)]">MPH</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <label className="text-[11px] text-[var(--tcp-text-tertiary)]">Override speed:</label>
                  <select
                    value={design.speed}
                    onChange={(e) => {
                      const newSpeed = parseInt(e.target.value, 10);
                      setDesign((prev) => ({ ...prev, speed: newSpeed }));
                    }}
                    className="px-2 py-1 bg-[var(--tcp-surface-1)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none"
                  >
                    {SPEED_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s} MPH
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Road & OSP Asset Cards */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-3 bg-[var(--tcp-surface-2)] rounded-lg border border-[var(--tcp-border)]">
                  <div className="text-[var(--tcp-text-tertiary)] text-[10px] uppercase font-mono">Classification</div>
                  <div className="text-xs font-semibold text-[var(--tcp-text-primary)] mt-1 leading-snug">
                    {analysis.classification}
                  </div>
                </div>

                <div className="p-3 bg-[var(--tcp-surface-2)] rounded-lg border border-[var(--tcp-border)]">
                  <div className="text-[var(--tcp-text-tertiary)] text-[10px] uppercase font-mono">Directional Lanes</div>
                  <div className="text-xs font-semibold text-[var(--tcp-text-primary)] mt-1 font-mono">
                    {analysis.lanes} Travel Lanes
                  </div>
                </div>

                <div className="p-3 bg-[var(--tcp-surface-2)] rounded-lg border border-[var(--tcp-border)]">
                  <div className="text-[var(--tcp-text-tertiary)] text-[10px] uppercase font-mono flex items-center gap-1">
                    <Disc className="w-3 h-3 text-red-400" />
                    <span>Telecom Manholes</span>
                  </div>
                  <div className="text-xs font-semibold text-[var(--tcp-text-primary)] mt-1 font-mono">
                    {analysis.manholeCount} Existing Found
                  </div>
                </div>

                <div className="p-3 bg-[var(--tcp-surface-2)] rounded-lg border border-[var(--tcp-border)]">
                  <div className="text-[var(--tcp-text-tertiary)] text-[10px] uppercase font-mono flex items-center gap-1">
                    <School className="w-3 h-3 text-amber-400" />
                    <span>School Zone</span>
                  </div>
                  <div className="text-xs font-semibold text-[var(--tcp-text-primary)] mt-1">
                    {analysis.schoolZone ? `${analysis.schoolDist} ft away` : 'None within 1,000 ft'}
                  </div>
                </div>
              </div>

              {/* Street View Visual Detector Preview */}
              <StreetViewDetector analysis={analysis} googleApiKey={googleApiKey} coords={coords} />

              {/* Navigation Buttons */}
              <div className="pt-3 border-t border-[var(--tcp-border)] flex gap-2">
                <button
                  onClick={() => setStep(1)}
                  className="px-3 py-2 bg-[var(--tcp-surface-2)] hover:bg-[var(--tcp-border)] text-[var(--tcp-text-secondary)] text-xs font-semibold rounded border border-[var(--tcp-border)] flex items-center gap-1.5"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back</span>
                </button>
                <button
                  onClick={() => setStep(3)}
                  className="flex-1 py-2 bg-[var(--tcp-accent)] hover:bg-[var(--tcp-accent-hover)] text-[var(--tcp-text-primary)] font-semibold text-xs rounded shadow flex items-center justify-center gap-1.5"
                >
                  <span>Continue to TCP Plan</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* STEP 4: DESIGN PARAMETERS */}
          {step === 4 && (
            <div className="space-y-5 animate-fadeIn">
              <div>
                <h2 className="font-display font-bold text-xl text-[var(--tcp-text-primary)] tracking-wide">
                  TCP DESIGN PARAMETERS
                </h2>
                <p className="text-xs text-[var(--tcp-text-tertiary)] mt-1 leading-relaxed">
                  These drive the merging taper, longitudinal buffer, and warning sign spacing straight from Texas MUTCD Chapter 6C tables.
                </p>
              </div>

              {/* Plan style — which MUTCD engine and wizard form this project uses.
                  Both styles still require the site located in Steps 1-2; picking
                  Lane Closure just seeds its road field from that located site. */}
              <div className="grid grid-cols-2 rounded-md bg-[var(--tcp-surface-2)] p-1 border border-[var(--tcp-border)] gap-1">
                <button
                  onClick={() => setPlanStyle('intersection')}
                  className={`py-1.5 px-2 text-xs font-semibold rounded transition-colors ${
                    planStyle === 'intersection' ? 'bg-[var(--tcp-accent)] text-[var(--tcp-text-primary)] shadow' : 'text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)]'
                  }`}
                >
                  Intersection / Taper (TX MUTCD)
                </button>
                <button
                  onClick={() => {
                    setPlanStyle('laneClosure');
                    setLaneClosureParams((prev) => ({
                      ...prev,
                      road: (routeCorridor?.roadName || activeAddress || prev.road).toUpperCase(),
                      addr: activeAddress || prev.addr,
                    }));
                  }}
                  className={`py-1.5 px-2 text-xs font-semibold rounded transition-colors ${
                    planStyle === 'laneClosure' ? 'bg-[var(--tcp-accent)] text-[var(--tcp-text-primary)] shadow' : 'text-[var(--tcp-text-secondary)] hover:text-[var(--tcp-text-primary)]'
                  }`}
                >
                  Lane Closure (CA MUTCD 2026)
                </button>
              </div>
              <p className="text-[10px] text-[var(--tcp-text-tertiary)] -mt-2">
                Lane Closure builds a straight-road taper/buffer/sign-schedule plan from the located site above, using its own CA MUTCD 2026 tables — kept separate from the Texas MUTCD intersection tables below rather than reconciled with them.
              </p>

              {planStyle === 'intersection' ? (
              <>
              {hasTracedRoadEdges && (
                <div className="p-3 rounded-lg bg-blue-950/30 border border-blue-800/60 space-y-1.5">
                  <div className="text-xs font-semibold text-blue-200">
                    Traced Intersection Geometry — this is the TCP diagram's road base
                  </div>
                  <div className="space-y-1">
                    {tracedFeatures.filter((f) => f.type === 'road_edge').map((f, i) => (
                      <div key={f.id} className="flex items-center justify-between text-[11px] text-blue-100/90 font-mono">
                        <span>Leg {i + 1}{f.name ? ` — ${f.name}` : ''}</span>
                        <span>{f.lanesThisDirection ?? 1} ln · {f.speedLimitMph ?? 35} mph</span>
                      </div>
                    ))}
                  </div>
                  <div className="text-[10px] text-blue-300/80">
                    {tracedFeatures.filter((f) => f.type === 'crosswalk').length} crosswalk(s),{' '}
                    {tracedFeatures.filter((f) => f.type === 'sidewalk').length} sidewalk(s) traced.
                    Edit lane count/speed per leg back on the map's Trace Intersection toolbar — the fields below
                    (Directional Lanes, Posted Speed) only apply to the non-traced CAD diagram, not this plan.
                  </div>
                </div>
              )}

              {/* Work Type Selection */}
              <div className="space-y-1.5">
                <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                  Work Type &amp; Roadway Impact
                </label>
                <select
                  value={design.workType}
                  onChange={(e) =>
                    setDesign((prev) => ({
                      ...prev,
                      workType: e.target.value as DesignParams['workType'],
                    }))
                  }
                  className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] outline-none focus:border-[var(--tcp-accent)]"
                >
                  <option value="shoulder">Shoulder / Parkway Work (No Travel Lane Closure)</option>
                  <option value="one-lane">One Lane Closure with Merging Taper</option>
                  <option value="two-lane">Two Lane Closure with Taper &amp; Flaggers</option>
                  <option value="intersection">Intersection Encroachment</option>
                </select>
              </div>

              {/* Lanes & Speed */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                    Directional Lanes
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={6}
                    value={design.lanes}
                    onChange={(e) =>
                      setDesign((prev) => ({ ...prev, lanes: parseInt(e.target.value, 10) || 1 }))
                    }
                    className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none focus:border-[var(--tcp-accent)]"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                    Posted Speed
                  </label>
                  <select
                    value={design.speed}
                    onChange={(e) =>
                      setDesign((prev) => ({ ...prev, speed: parseInt(e.target.value, 10) }))
                    }
                    className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none focus:border-[var(--tcp-accent)]"
                  >
                    {SPEED_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s} MPH
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Divided Highway / Median */}
              <div className="p-3 rounded-lg bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] space-y-2">
                <div className="flex items-center gap-2.5">
                  <input
                    type="checkbox"
                    id="divided-highway-toggle"
                    checked={dividedHighway}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setDividedHighway(checked);
                      if (checked) setOpposingLanes(design.lanes);
                    }}
                    className="w-4 h-4 accent-[var(--tcp-accent)]"
                  />
                  <label htmlFor="divided-highway-toggle" className="text-xs text-[var(--tcp-text-secondary)] flex-1">
                    Divided highway (raised median, opposing lanes visible)
                  </label>
                </div>
                {dividedHighway && (
                  <div className="flex items-center gap-2 pl-6.5">
                    <label className="text-xs font-mono uppercase text-[var(--tcp-text-tertiary)]">Opposing Lanes</label>
                    <input
                      type="number"
                      min={1}
                      max={6}
                      value={opposingLanes}
                      onChange={(e) => setOpposingLanes(parseInt(e.target.value, 10) || 1)}
                      className="w-16 px-2 py-1 bg-[var(--tcp-surface-1)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none focus:border-[var(--tcp-accent)]"
                    />
                  </div>
                )}
                <p className="text-[10px] text-[var(--tcp-text-tertiary)]">
                  "Directional Lanes" above is only the lanes on your side of the work — check this if the real road (see the Google Maps view) has a median with opposing traffic, so the diagram's width actually matches it.
                </p>
              </div>

              {/* Work Length & Lane Offset */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                    Work Zone Length (ft)
                  </label>
                  <input
                    type="number"
                    min={20}
                    max={3000}
                    step={10}
                    value={design.length}
                    onChange={(e) =>
                      setDesign((prev) => ({ ...prev, length: parseInt(e.target.value, 10) || 50 }))
                    }
                    className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none focus:border-[var(--tcp-accent)]"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                    Lane Width (Offset ft)
                  </label>
                  <select
                    value={design.offset}
                    onChange={(e) =>
                      setDesign((prev) => ({ ...prev, offset: parseInt(e.target.value, 10) }))
                    }
                    className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none focus:border-[var(--tcp-accent)]"
                  >
                    <option value={10}>10 ft</option>
                    <option value={11}>11 ft</option>
                    <option value={12}>12 ft</option>
                  </select>
                </div>
              </div>

              {/* Safety Equipment Checks */}
              <div className="p-3 bg-[var(--tcp-surface-2)] rounded-lg border border-[var(--tcp-border)] space-y-2">
                <span className="text-xs font-mono text-[var(--tcp-text-secondary)] font-bold uppercase block">
                  Safety &amp; Compliance Options
                </span>
                <label className="flex items-center gap-2 text-xs text-[var(--tcp-text-primary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={design.flaggersRequired}
                    onChange={(e) =>
                      setDesign((prev) => ({ ...prev, flaggersRequired: e.target.checked }))
                    }
                    className="rounded border-[var(--tcp-border)] text-[var(--tcp-accent)] focus:ring-0"
                  />
                  <span>Station Certified Flaggers with Two-Way Radio</span>
                </label>
                <label className="flex items-center gap-2 text-xs text-[var(--tcp-text-primary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={design.arrowBoardRequired}
                    onChange={(e) =>
                      setDesign((prev) => ({ ...prev, arrowBoardRequired: e.target.checked }))
                    }
                    className="rounded border-[var(--tcp-border)] text-[var(--tcp-accent)] focus:ring-0"
                  />
                  <span>Deploy Flashing Arrow Board (Type C)</span>
                </label>
                <label className="flex items-center gap-2 text-xs text-[var(--tcp-text-primary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={design.trenchPlates}
                    onChange={(e) =>
                      setDesign((prev) => ({ ...prev, trenchPlates: e.target.checked }))
                    }
                    className="rounded border-[var(--tcp-border)] text-[var(--tcp-accent)] focus:ring-0"
                  />
                  <span>Non-Skid Steel Trench Plates for Overnight Excavation</span>
                </label>
              </div>

              {/* MUTCD Live Reference Tables */}
              <div className="space-y-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono text-[var(--tcp-text-tertiary)] uppercase font-semibold">
                      Table 6C-1: Advance Warning Sign Spacing (X)
                    </span>
                    <span className="text-xs font-mono font-bold text-[var(--tcp-accent)]">
                      X = {metrics.spacing} FT
                    </span>
                  </div>
                  <div className="overflow-x-auto border border-[var(--tcp-border)] rounded">
                    <table className="w-full text-[10px] font-mono text-center border-collapse">
                      <thead className="bg-[var(--tcp-surface-2)] text-[var(--tcp-text-secondary)]">
                        <tr>
                          <th className="p-1 border-r border-[var(--tcp-border)]">MPH</th>
                          {SIGN_SPACING_TABLE.map((r) => (
                            <th
                              key={r.s}
                              className={`p-1 ${r.s === design.speed ? 'bg-[var(--tcp-accent)] text-[var(--tcp-text-primary)] font-bold' : ''}`}
                            >
                              {r.s}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="bg-[var(--tcp-surface-1)] text-[var(--tcp-text-secondary)]">
                        <tr>
                          <td className="p-1 border-r border-[var(--tcp-border)] font-semibold">X (ft)</td>
                          {SIGN_SPACING_TABLE.map((r) => (
                            <td
                              key={r.s}
                              className={`p-1 ${r.s === design.speed ? 'bg-[var(--tcp-accent-20)] text-orange-200 font-bold' : ''}`}
                            >
                              {r.x}
                            </td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono text-[var(--tcp-text-tertiary)] uppercase font-semibold">
                      Table 6C-2: Longitudinal Buffer Space (B)
                    </span>
                    <span className="text-xs font-mono font-bold text-[var(--tcp-accent)]">
                      B = {metrics.buffer} FT
                    </span>
                  </div>
                  <div className="overflow-x-auto border border-[var(--tcp-border)] rounded">
                    <table className="w-full text-[10px] font-mono text-center border-collapse">
                      <thead className="bg-[var(--tcp-surface-2)] text-[var(--tcp-text-secondary)]">
                        <tr>
                          <th className="p-1 border-r border-[var(--tcp-border)]">MPH</th>
                          {BUFFER_SPACE_TABLE.map((r) => (
                            <th
                              key={r.s}
                              className={`p-1 ${r.s === design.speed ? 'bg-[var(--tcp-accent)] text-[var(--tcp-text-primary)] font-bold' : ''}`}
                            >
                              {r.s}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="bg-[var(--tcp-surface-1)] text-[var(--tcp-text-secondary)]">
                        <tr>
                          <td className="p-1 border-r border-[var(--tcp-border)] font-semibold">B (ft)</td>
                          {BUFFER_SPACE_TABLE.map((r) => (
                            <td
                              key={r.s}
                              className={`p-1 ${r.s === design.speed ? 'bg-[var(--tcp-accent-20)] text-orange-200 font-bold' : ''}`}
                            >
                              {r.x}
                            </td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              </>
              ) : (
              <>
              {/* Lane Closure (CA MUTCD 2026) compact params -- full sign
                  schedule / devices / checklist / live traffic and the calc
                  breakdown live on the diagram + summary panel once this
                  step advances to Step 5, via LaneClosureDiagramStage /
                  LaneClosureSummaryPanel (same engine as the standalone
                  Lane Closure TCP tool, see useLaneClosurePlanEngine.ts). */}
              <div className="space-y-1.5">
                <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                  Work Area Preset
                </label>
                <select
                  value={selectedPresetIdx}
                  onChange={(e) => {
                    const idx = parseInt(e.target.value, 10);
                    const preset = LANE_CLOSURE_PRESETS[idx];
                    if (!preset) return;
                    setSelectedPresetIdx(idx);
                    if (preset.tag === '4-LEG') {
                      // Not a straight/curve lane closure at all -- routes
                      // to LaneClosureIntersectionPanel instead (see the
                      // CAD Drawing pane above), so laneClosureParams
                      // itself is left alone rather than being fed a shape
                      // its own engine can't render correctly.
                      setLaneClosureMode('intersection');
                      setIntersectionPresetIdx(idx);
                    } else {
                      setLaneClosureMode('plan');
                      setLaneClosureParams(JSON.parse(JSON.stringify(preset)));
                    }
                  }}
                  className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] outline-none focus:border-[var(--tcp-accent)]"
                >
                  {/* Keyed/valued by array index, not `wa` -- more than one
                      preset can share a `wa` number (a plain sheet plus a
                      CURVE or 4-LEG companion), which a wa-keyed <select>
                      can't tell apart. */}
                  {LANE_CLOSURE_PRESETS.map((w, i) => (
                    <option key={i} value={i}>WA{w.wa}{w.tag ? ` · ${w.tag}` : ''} — {w.addr.replace(/\.$/, '')}</option>
                  ))}
                </select>
                <p className="text-[10px] text-[var(--tcp-text-tertiary)]">
                  {laneClosureMode === 'intersection'
                    ? 'Loaded as a 4-leg signalized intersection -- see the CAD Drawing pane for the diagram, live traffic and compliance checks.'
                    : 'Loads a City of Marina reference work area as a starting point — every field below stays fully editable.'}
                </p>
              </div>

              {laneClosureMode === 'intersection' ? (
              <div className="p-3.5 rounded-lg bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] space-y-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--tcp-text-tertiary)]">4-leg intersection loaded</div>
                <p className="text-xs text-[var(--tcp-text-secondary)] leading-relaxed">
                  This preset is a 4-leg signalized intersection, not a straight/curve lane closure, so the fields below don't apply to it. Open the <strong>CAD Drawing</strong> pane to edit its road names, speeds, lanes, and closure parameters, see the live traffic simulation, and run compliance checks.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveCanvasView('cad')}
                  className="w-full py-1.5 bg-[var(--tcp-border)] hover:bg-[var(--tcp-border-hover)] text-[var(--tcp-text-primary)] text-xs font-semibold rounded flex items-center justify-center gap-1.5"
                >
                  <Compass className="w-3.5 h-3.5 text-[var(--tcp-accent)]" />
                  <span>Open CAD Drawing Pane</span>
                </button>
              </div>
              ) : (
              <>
              <div className="space-y-1.5">
                <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                  Road (from located site)
                </label>
                <input
                  type="text"
                  value={laneClosureParams.road}
                  onChange={(e) => setLaneClosureParams((prev) => ({ ...prev, road: e.target.value.toUpperCase() }))}
                  className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none focus:border-[var(--tcp-accent)]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                    Posted Speed
                  </label>
                  <select
                    value={laneClosureParams.speed}
                    onChange={(e) => setLaneClosureParams((prev) => ({ ...prev, speed: parseInt(e.target.value, 10) }))}
                    className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none focus:border-[var(--tcp-accent)]"
                  >
                    {[20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75].map((s) => (
                      <option key={s} value={s}>{s} MPH</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                    Lanes Each Way
                  </label>
                  <select
                    value={laneClosureParams.lanes}
                    onChange={(e) => setLaneClosureParams((prev) => ({ ...prev, lanes: parseInt(e.target.value, 10) }))}
                    className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none focus:border-[var(--tcp-accent)]"
                  >
                    {[1, 2, 3].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                  Closure Strategy
                </label>
                <select
                  value={laneClosureParams.strategy}
                  onChange={(e) => setLaneClosureParams((prev) => ({ ...prev, strategy: e.target.value as ClosureStrategy }))}
                  className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] outline-none focus:border-[var(--tcp-accent)]"
                >
                  <option value="lane">Right lane</option>
                  <option value="center">Left lane</option>
                  <option value="shoulder">Shoulder / bike lane</option>
                  <option value="flagger">Flagger — single lane</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                    Road Type
                  </label>
                  <select
                    value={laneClosureParams.roadType}
                    onChange={(e) => setLaneClosureParams((prev) => ({ ...prev, roadType: e.target.value as RoadType }))}
                    className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] outline-none focus:border-[var(--tcp-accent)]"
                  >
                    <option value="urban">Urban</option>
                    <option value="rural">Rural</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                    Offset Width (ft)
                  </label>
                  <input
                    type="number"
                    min={4}
                    max={14}
                    value={laneClosureParams.offset}
                    onChange={(e) => setLaneClosureParams((prev) => ({ ...prev, offset: parseInt(e.target.value, 10) || prev.offset }))}
                    className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none focus:border-[var(--tcp-accent)]"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                  Work Space Length (ft)
                </label>
                <input
                  type="number"
                  min={20}
                  max={600}
                  value={laneClosureParams.work}
                  onChange={(e) => setLaneClosureParams((prev) => ({ ...prev, work: parseInt(e.target.value, 10) || prev.work }))}
                  className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none focus:border-[var(--tcp-accent)]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                    Work Starts
                  </label>
                  <input
                    type="time"
                    value={laneClosureParams.hs}
                    onChange={(e) => setLaneClosureParams((prev) => ({ ...prev, hs: e.target.value }))}
                    className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none focus:border-[var(--tcp-accent)]"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold">
                    Work Ends
                  </label>
                  <input
                    type="time"
                    value={laneClosureParams.he}
                    onChange={(e) => setLaneClosureParams((prev) => ({ ...prev, he: e.target.value }))}
                    className="w-full px-3 py-2 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none focus:border-[var(--tcp-accent)]"
                  />
                </div>
              </div>

              <div className="p-3 rounded-lg bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] space-y-2">
                <label className="flex items-center gap-2.5 text-xs text-[var(--tcp-text-secondary)]">
                  <input type="checkbox" checked={laneClosureParams.sidewalk} onChange={(e) => setLaneClosureParams((prev) => ({ ...prev, sidewalk: e.target.checked }))} className="w-4 h-4 accent-[var(--tcp-accent)]" />
                  <span>Sidewalk closed</span>
                </label>
                <label className="flex items-center gap-2.5 text-xs text-[var(--tcp-text-secondary)]">
                  <input type="checkbox" checked={laneClosureParams.bus} onChange={(e) => setLaneClosureParams((prev) => ({ ...prev, bus: e.target.checked }))} className="w-4 h-4 accent-[var(--tcp-accent)]" />
                  <span>Bus stop in work zone</span>
                </label>
                <label className="flex items-center gap-2.5 text-xs text-[var(--tcp-text-secondary)]">
                  <input type="checkbox" checked={laneClosureParams.signal} onChange={(e) => setLaneClosureParams((prev) => ({ ...prev, signal: e.target.checked }))} className="w-4 h-4 accent-[var(--tcp-accent)]" />
                  <span>Near signalized intersection</span>
                </label>
              </div>

              <div className="p-3 bg-[var(--tcp-surface-2)] rounded border border-[var(--tcp-border)] space-y-1">
                <div className="text-[10px] font-mono text-[var(--tcp-text-tertiary)] uppercase">Computed Taper (CA MUTCD 2026)</div>
                <div className="text-lg font-mono font-bold text-[var(--tcp-text-primary)]">
                  <span className="text-[var(--tcp-accent)]">{laneClosure.plan.taper} FT</span>
                  <span className="text-[11px] font-normal text-[var(--tcp-text-tertiary)] ml-2">{laneClosure.plan.tref}</span>
                </div>
                <p className="text-[10px] text-[var(--tcp-text-tertiary)]">Full sign schedule, devices, checklist and compliance checks are on the diagram and summary panel after Generate.</p>
              </div>
              </>
              )}
              </>
              )}

              {/* Navigation Buttons */}
              <div className="pt-3 border-t border-[var(--tcp-border)] flex gap-2">
                <button
                  onClick={() => setStep(3)}
                  className="px-3 py-2 bg-[var(--tcp-surface-2)] hover:bg-[var(--tcp-border)] text-[var(--tcp-text-secondary)] text-xs font-semibold rounded border border-[var(--tcp-border)] flex items-center gap-1.5"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back</span>
                </button>
                <button
                  onClick={() => { setStep(5); setActiveCanvasView('cad'); }}
                  className="flex-1 py-2 bg-[var(--tcp-accent)] hover:bg-[var(--tcp-accent-hover)] text-[var(--tcp-text-primary)] font-semibold text-xs rounded shadow flex items-center justify-center gap-1.5"
                >
                  <span>{planStyle === 'laneClosure' ? 'Generate Lane Closure Plan' : 'Generate CAD Drawing'}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* STEP 5: TCP DIAGRAM (CAD METRICS SUMMARY) */}
          {step === 5 && (
            <div className="space-y-5 animate-fadeIn">
              <div>
                <h2 className="font-display font-bold text-xl text-[var(--tcp-text-primary)] tracking-wide">
                  TRAFFIC CONTROL PLAN CAD DIAGRAM
                </h2>
                <p className="text-xs text-[var(--tcp-text-tertiary)] mt-1 leading-relaxed">
                  {planStyle === 'laneClosure'
                    ? 'Straight-road lane closure plan, CA MUTCD 2026. Taper, buffer, sign schedule, and devices are plotted proportionally on the sheet.'
                    : 'Generated in ANSI engineering format. Taper, buffer space, barricades, and manholes are plotted proportionally.'}
                </p>
              </div>

              {planStyle === 'laneClosure' ? (
                laneClosureMode === 'intersection' ? (
                <div className="p-3.5 rounded-lg bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] space-y-2">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--tcp-text-tertiary)]">4-leg intersection loaded</div>
                  <p className="text-xs text-[var(--tcp-text-secondary)] leading-relaxed">
                    This work area is a 4-leg signalized intersection. Its plan sheet, live traffic simulation, closed-leg picker, and compliance checks all live on the <strong>CAD Drawing</strong> pane rather than this summary -- this step's metric-card layout doesn't fit that diagram.
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveCanvasView('cad')}
                    className="w-full py-1.5 bg-[var(--tcp-border)] hover:bg-[var(--tcp-border-hover)] text-[var(--tcp-text-primary)] text-xs font-semibold rounded flex items-center justify-center gap-1.5"
                  >
                    <Compass className="w-3.5 h-3.5 text-[var(--tcp-accent)]" />
                    <span>Open CAD Drawing Pane</span>
                  </button>
                </div>
                ) : (
                <LaneClosureSummaryPanel laneClosure={laneClosure} />
                )
              ) : (
              <>
              {/* Computed Metric Cards */}
              <div className="space-y-2">
                <div className="p-3 bg-[var(--tcp-surface-2)] rounded border border-[var(--tcp-border)]">
                  <div className="text-[10px] font-mono text-[var(--tcp-text-tertiary)] uppercase">Computed Merging Taper (L)</div>
                  <div className="text-lg font-mono font-bold text-[var(--tcp-text-primary)] flex items-baseline gap-2 mt-0.5">
                    <span className="text-[var(--tcp-accent)]">{metrics.taper} FT</span>
                    <span className="text-[11px] font-normal text-[var(--tcp-text-tertiary)]">
                      Formula: {design.speed <= 40 ? 'WS²/60' : 'WS'} (W={design.offset}ft, S={design.speed}mph)
                    </span>
                  </div>
                </div>

                <div className="p-3 bg-[var(--tcp-surface-2)] rounded border border-[var(--tcp-border)]">
                  <div className="text-[10px] font-mono text-[var(--tcp-text-tertiary)] uppercase">Longitudinal Buffer Space (B)</div>
                  <div className="text-lg font-mono font-bold text-[var(--tcp-text-primary)] flex items-baseline gap-2 mt-0.5">
                    <span className="text-[var(--tcp-accent)]">{metrics.buffer} FT</span>
                    <span className="text-[11px] font-normal text-[var(--tcp-text-tertiary)]">Texas MUTCD Table 6C-2</span>
                  </div>
                </div>

                <div className="p-3 bg-[var(--tcp-surface-2)] rounded border border-[var(--tcp-border)]">
                  <div className="text-[10px] font-mono text-[var(--tcp-text-tertiary)] uppercase">Channelizing Cones / Drums</div>
                  <div className="text-xs font-mono text-[var(--tcp-text-primary)] mt-1">
                    Every <strong className="text-[var(--tcp-text-primary)]">{metrics.deviceTaper} FT</strong> on taper · Every <strong className="text-[var(--tcp-text-primary)]">{metrics.deviceTangent} FT</strong> on tangent
                  </div>
                </div>

                <div className="p-3 bg-[var(--tcp-surface-2)] rounded border border-[var(--tcp-border)]">
                  <div className="text-[10px] font-mono text-[var(--tcp-text-tertiary)] uppercase">Advance Warning Sign Size</div>
                  <div className="text-xs font-mono text-[var(--tcp-text-primary)] mt-1">
                    {metrics.signSize}
                  </div>
                </div>
              </div>

              {/* Quick Actions */}
              <div className="p-3 bg-[#132030] rounded border border-[var(--tcp-border)] space-y-2 text-xs">
                <span className="font-mono text-[10px] uppercase text-[var(--tcp-text-tertiary)] block font-semibold">
                  CAD Canvas Interaction
                </span>
                <p className="text-[var(--tcp-text-tertiary)] leading-relaxed text-[11px]">
                  Use the left viewport to pan, zoom, or toggle dimension lines, standard sign codes, and OSP manhole layers.
                </p>
                <button
                  onClick={() => setActiveCanvasView('cad')}
                  className="w-full py-1.5 bg-[var(--tcp-border)] hover:bg-[var(--tcp-border-hover)] text-[var(--tcp-text-primary)] text-xs font-semibold rounded flex items-center justify-center gap-1.5"
                >
                  <Compass className="w-3.5 h-3.5 text-[var(--tcp-accent)]" />
                  <span>Focus Full CAD Viewport</span>
                </button>
              </div>
              </>
              )}

              {/* Navigation Buttons */}
              <div className="pt-3 border-t border-[var(--tcp-border)] flex gap-2">
                <button
                  onClick={() => setStep(4)}
                  className="px-3 py-2 bg-[var(--tcp-surface-2)] hover:bg-[var(--tcp-border)] text-[var(--tcp-text-secondary)] text-xs font-semibold rounded border border-[var(--tcp-border)] flex items-center gap-1.5"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back</span>
                </button>
                <button
                  onClick={() => setStep(6)}
                  className="flex-1 py-2 bg-[var(--tcp-accent)] hover:bg-[var(--tcp-accent-hover)] text-[var(--tcp-text-primary)] font-semibold text-xs rounded shadow flex items-center justify-center gap-1.5"
                >
                  <span>Review &amp; Submit to Municipality</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* STEP 6: REVIEW & SUBMIT */}
          {step === 6 && (
            <div className="space-y-5 animate-fadeIn">
              <div>
                <h2 className="font-display font-bold text-xl text-[var(--tcp-text-primary)] tracking-wide">
                  REVIEW &amp; SUBMISSION
                </h2>
                <p className="text-xs text-[var(--tcp-text-tertiary)] mt-1 leading-relaxed">
                  Final compliance audit against municipal Right-of-Way permitting rules, drawing set generation, and submittal status tracking.
                </p>
              </div>

              <SubmissionReview
                design={design}
                metrics={metrics}
                analysis={analysis}
                address={activeAddress}
                projectName={projectName}
                status={status}
                onStatusChange={setStatus}
                onPrint={handlePrint}
              />

              <div className="pt-3 border-t border-[var(--tcp-border)]">
                <button
                  onClick={() => setStep(5)}
                  className="w-full py-2 bg-[var(--tcp-surface-2)] hover:bg-[var(--tcp-border)] text-[var(--tcp-text-secondary)] text-xs font-semibold rounded border border-[var(--tcp-border)] flex items-center justify-center gap-1.5"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Return to CAD Diagram</span>
                </button>
              </div>
            </div>
          )}
        </aside>
        </>
        )}
      </main>

      {/* ===== ROUTE CORRIDOR ASSETS & OBSTRUCTIONS MODAL ===== */}
      {showAssetModal && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowAssetModal(false);
          }}
          className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[var(--tcp-surface-1)] border border-[var(--tcp-border)] rounded-xl max-w-3xl w-full shadow-2xl relative text-[var(--tcp-text-primary)] max-h-[85vh] flex flex-col"
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-[var(--tcp-border)] px-6 py-4 shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-[var(--tcp-surface-2)] rounded-lg border border-[var(--tcp-border)]">
                  <Layers className="w-5 h-5 text-[var(--tcp-accent)]" />
                </div>
                <div>
                  <h3 className="font-display font-bold text-base text-[var(--tcp-text-primary)] tracking-wide uppercase">
                    Route Corridor Assets &amp; Obstructions
                  </h3>
                  <p className="text-[11px] text-[var(--tcp-text-tertiary)] font-mono">
                    {routeAssets.length} identified · {routeCorridor?.roadName || 'Preston Rd'} · {routeCorridor?.speedLimitMph || design.speed} MPH
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowAssetModal(false)}
                className="p-1.5 text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-primary)] rounded-lg hover:bg-[var(--tcp-surface-2)] transition-colors"
                title="Close (Esc)"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="overflow-y-auto p-4">
              {/* Designated Work Site — which manhole the crew is actually
                  working at, so the TCP diagram closes lanes on the correct
                  side of the road instead of an assumed default. */}
              {routeAssets.some((a) => a.category === 'manholes') && (
                <div className="mb-4 p-3 rounded-lg bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)]">
                  <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold block mb-1.5">
                    Work Site (which manhole are you working at?)
                  </label>
                  <select
                    value={workSiteAssetId || ''}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      const asset = id ? routeAssets.find((a) => a.id === id) || null : null;
                      handleSetWorkSite(asset);
                    }}
                    className="w-full px-3 py-2 bg-[var(--tcp-surface-1)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] font-mono outline-none focus:border-[var(--tcp-accent)]"
                  >
                    <option value="">Not set (defaults to left-side closure)</option>
                    {routeAssets
                      .filter((a) => a.category === 'manholes')
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.title} — {a.station} · {a.side}{a.offsetFt !== 0 ? ` (${a.offsetFt} ft)` : ''}
                        </option>
                      ))}
                  </select>
                  <p className="text-[10px] text-[var(--tcp-text-tertiary)] mt-1.5">
                    The diagram closes lanes on whichever side this manhole was actually detected on — left or right of the direction of travel.
                  </p>
                </div>
              )}

              <RouteAssetInventory
                corridor={routeCorridor}
                assets={routeAssets}
                speedLimit={design.speed}
                selectedAssetId={selectedAssetId}
                onSelectAsset={(asset) => {
                  setSelectedAssetId(asset.id);
                  setCoords({ lat: asset.lat, lng: asset.lng });
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* ===== MUTCD CONFIGURATION MODAL ===== */}
      {showConfigModal && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowConfigModal(false);
          }}
          className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[var(--tcp-surface-1)] border border-[var(--tcp-border)] rounded-xl max-w-3xl w-full shadow-2xl relative text-[var(--tcp-text-primary)] max-h-[85vh] flex flex-col"
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-[var(--tcp-border)] px-6 py-4 shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-[var(--tcp-surface-2)] rounded-lg border border-[var(--tcp-border)]">
                  <Settings className="w-5 h-5 text-[var(--tcp-accent)]" />
                </div>
                <div>
                  <h3 className="font-display font-bold text-base text-[var(--tcp-text-primary)] tracking-wide uppercase">
                    MUTCD Standards Configuration
                  </h3>
                  <p className="text-[11px] text-[var(--tcp-text-tertiary)] font-mono">
                    Texas MUTCD 2011, Ch. 6C — Tables 6C-1 through 6C-4 &amp; General Notes 1-8
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowConfigModal(false)}
                className="p-1.5 text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-primary)] rounded-lg hover:bg-[var(--tcp-surface-2)] transition-colors"
                title="Close (Esc)"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="overflow-y-auto p-6 space-y-6">
              {/* Taper Type (Table 6C-3) */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--tcp-text-secondary)] mb-2">
                  Table 6C-3 — Taper Type
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {([
                    { key: 'auto', label: 'Auto (from work type)', desc: 'Shoulder work → 0.33L, otherwise merging (1.0L)' },
                    { key: 'merging', label: 'Merging (1.0L)', desc: 'Full lane closure' },
                    { key: 'shifting', label: 'Shifting (0.5L)', desc: 'Lane shift, no closure' },
                    { key: 'shoulder', label: 'Shoulder (0.33L)', desc: 'Shoulder work only' },
                  ] as { key: TaperType; label: string; desc: string }[]).map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => setMutcdConfig((prev) => ({ ...prev, taperType: opt.key }))}
                      title={opt.desc}
                      className={`p-2.5 rounded-lg border text-left transition-colors ${
                        mutcdConfig.taperType === opt.key
                          ? 'bg-[var(--tcp-accent-20)] border-[var(--tcp-accent)] text-[var(--tcp-text-primary)]'
                          : 'bg-[var(--tcp-surface-2)] border-[var(--tcp-border)] text-[var(--tcp-text-secondary)] hover:border-[var(--tcp-border-hover)]'
                      }`}
                    >
                      <div className="text-[11px] font-semibold">{opt.label}</div>
                      <div className="text-[10px] text-[var(--tcp-text-tertiary)] mt-0.5">{opt.desc}</div>
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-[var(--tcp-text-tertiary)] mt-1.5">
                  One-lane two-way and downstream tapers stay at the fixed 50-100 ft minimum/maximum from Table 6C-3, unaffected by this setting.
                </p>
              </div>

              {/* Curve Warning (Note 2) */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--tcp-text-secondary)] mb-2">
                  General Note 2 — Curve Warning Sign
                </h4>
                <div className="flex items-center gap-3 p-3 rounded-lg bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)]">
                  <input
                    type="checkbox"
                    id="curve-warning-toggle"
                    checked={mutcdConfig.curveWarningEnabled}
                    onChange={(e) => setMutcdConfig((prev) => ({ ...prev, curveWarningEnabled: e.target.checked }))}
                    className="w-4 h-4 accent-[var(--tcp-accent)]"
                  />
                  <label htmlFor="curve-warning-toggle" className="text-xs text-[var(--tcp-text-secondary)] flex-1">
                    Include a curve warning sign on the diagram
                  </label>
                  <input
                    type="number"
                    min={5}
                    max={80}
                    step={5}
                    disabled={!mutcdConfig.curveWarningEnabled}
                    value={mutcdConfig.curveRecommendedSpeed}
                    onChange={(e) => setMutcdConfig((prev) => ({ ...prev, curveRecommendedSpeed: parseInt(e.target.value, 10) || prev.curveRecommendedSpeed }))}
                    className="w-16 px-2 py-1 bg-[var(--tcp-surface-1)] border border-[var(--tcp-border)] rounded text-xs text-[var(--tcp-text-primary)] disabled:opacity-40 font-mono"
                  />
                  <span className="text-[11px] text-[var(--tcp-text-tertiary)] font-mono">mph recommended</span>
                  <span className="px-2 py-1 rounded bg-[var(--tcp-surface-1)] border border-[var(--tcp-border)] text-[11px] font-mono font-bold text-[var(--tcp-accent)]">
                    {mutcdConfig.curveRecommendedSpeed <= 30 ? 'W1-3' : 'W1-4'}
                  </span>
                </div>
                <p className="text-[10px] text-[var(--tcp-text-tertiary)] mt-1.5">
                  Per Note 2: W1-3 is used when the recommended curve speed is 30 mph or less; W1-4 when it's 35 mph or greater.
                </p>
              </div>

              {/* Table 6C-1 */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--tcp-text-secondary)] mb-2">
                  Table 6C-1 — Advance Warning Sign Spacing "X" (ft)
                </h4>
                <div className="overflow-x-auto">
                  <table className="text-[11px] font-mono border-collapse w-full">
                    <thead>
                      <tr>
                        {mutcdConfig.signSpacingTable.map((row) => (
                          <th key={row.s} className="border border-[var(--tcp-border)] px-1 py-1 text-[var(--tcp-text-tertiary)] font-semibold">
                            {row.s}{row.star ? '*' : ''}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        {mutcdConfig.signSpacingTable.map((row) => (
                          <td key={row.s} className="border border-[var(--tcp-border)] p-0.5">
                            <input
                              type="number"
                              value={row.x}
                              onChange={(e) => {
                                const val = parseInt(e.target.value, 10) || 0;
                                setMutcdConfig((prev) => ({
                                  ...prev,
                                  signSpacingTable: prev.signSpacingTable.map((r) => (r.s === row.s ? { ...r, x: val } : r)),
                                }));
                              }}
                              className="w-14 text-center bg-transparent text-[var(--tcp-text-primary)] outline-none"
                            />
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Table 6C-2 */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--tcp-text-secondary)] mb-2">
                  Table 6C-2 — Longitudinal Buffer Space (ft)
                </h4>
                <div className="overflow-x-auto">
                  <table className="text-[11px] font-mono border-collapse w-full">
                    <thead>
                      <tr>
                        {mutcdConfig.bufferSpaceTable.map((row) => (
                          <th key={row.s} className="border border-[var(--tcp-border)] px-1 py-1 text-[var(--tcp-text-tertiary)] font-semibold">
                            {row.s}{row.star ? '*' : ''}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        {mutcdConfig.bufferSpaceTable.map((row) => (
                          <td key={row.s} className="border border-[var(--tcp-border)] p-0.5">
                            <input
                              type="number"
                              value={row.x}
                              onChange={(e) => {
                                const val = parseInt(e.target.value, 10) || 0;
                                setMutcdConfig((prev) => ({
                                  ...prev,
                                  bufferSpaceTable: prev.bufferSpaceTable.map((r) => (r.s === row.s ? { ...r, x: val } : r)),
                                }));
                              }}
                              className="w-14 text-center bg-transparent text-[var(--tcp-text-primary)] outline-none"
                            />
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="text-[10px] text-[var(--tcp-text-tertiary)] mt-1.5">* = distance should be increased for 1,500 ft advance warning (Note 6C.04.07).</p>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between border-t border-[var(--tcp-border)] px-6 py-3.5 shrink-0">
              <button
                onClick={() =>
                  setMutcdConfig({
                    ...DEFAULT_MUTCD_CONFIG,
                    signSpacingTable: SIGN_SPACING_TABLE.map((r) => ({ ...r })),
                    bufferSpaceTable: BUFFER_SPACE_TABLE.map((r) => ({ ...r })),
                  })
                }
                className="px-3.5 py-2 text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-primary)] text-xs font-semibold rounded-lg hover:bg-[var(--tcp-surface-2)] transition-colors"
              >
                Reset to Texas MUTCD 2011 Defaults
              </button>
              <button
                onClick={() => setShowConfigModal(false)}
                className="px-4 py-2 bg-[var(--tcp-accent)] hover:bg-[var(--tcp-accent-hover)] text-[var(--tcp-text-primary)] text-xs font-semibold rounded-lg shadow transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== GOOGLE MAPS API KEY CONFIG MODAL ===== */}
      {showApiKeyModal && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowApiKeyModal(false);
          }}
          className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[var(--tcp-surface-1)] border border-[var(--tcp-border)] rounded-xl max-w-lg w-full p-6 shadow-2xl space-y-4 relative text-[var(--tcp-text-primary)]"
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-[var(--tcp-border)] pb-3.5">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-[var(--tcp-surface-2)] rounded-lg border border-[var(--tcp-border)]">
                  <Key className="w-5 h-5 text-[var(--tcp-accent)]" />
                </div>
                <div>
                  <h3 className="font-display font-bold text-base text-[var(--tcp-text-primary)] tracking-wide">
                    GOOGLE MAPS PLATFORM CONFIGURATION
                  </h3>
                  <p className="text-[11px] text-[var(--tcp-text-tertiary)] font-mono">
                    Telecom GIS Road Survey &amp; Speed Diagnostics
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowApiKeyModal(false)}
                className="p-1.5 text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-primary)] rounded-lg hover:bg-[var(--tcp-surface-2)] transition-colors"
                title="Close (Esc)"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Current Status Badge */}
            <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--tcp-canvas)] border border-[var(--tcp-border)]">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[var(--tcp-text-tertiary)]">Current Status:</span>
                {googleApiKey ? (
                  <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold font-mono text-[11px] bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800">
                    <Check className="w-3 h-3" /> Active (Custom User Key)
                  </span>
                ) : serverHasKey ? (
                  <span className="inline-flex items-center gap-1 text-blue-400 font-semibold font-mono text-[11px] bg-blue-950/60 px-2 py-0.5 rounded border border-blue-800">
                    <Check className="w-3 h-3" /> Active (Server Env Key)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-400 font-mono text-[11px] bg-amber-950/40 px-2 py-0.5 rounded border border-amber-800/60">
                    Simulation &amp; OpenStreetMap Mode
                  </span>
                )}
              </div>

              {googleApiKey && (
                <button
                  onClick={handleClearKey}
                  className="text-[11px] font-mono text-red-400 hover:text-red-300 flex items-center gap-1 hover:underline"
                  title="Remove saved key"
                >
                  <Trash2 className="w-3 h-3" /> Clear Key
                </button>
              )}
            </div>

            {/* Explanatory text */}
            <div className="text-xs text-[var(--tcp-text-secondary)] space-y-2 leading-relaxed">
              <p>
                The prototype functions immediately using standard US sample data and OpenStreetMap. Providing your Google Maps Platform key unlocks live real-time queries for roads, speed limits, and street views:
              </p>
              <div className="grid grid-cols-2 gap-2 p-2.5 bg-[var(--tcp-canvas)] rounded-lg border border-[var(--tcp-border)] text-[11px] font-mono text-[var(--tcp-text-secondary)]">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  <span>Roads API (Live Speed Limits)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  <span>Street View Static API</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  <span>Geocoding API (US Addresses)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  <span>Routes &amp; Direction Snapping</span>
                </div>
              </div>
            </div>

            {/* Input Field with Visibility Toggle */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-mono uppercase text-[var(--tcp-text-secondary)] font-semibold flex items-center gap-1.5">
                  <span>Google Maps API Key</span>
                  <span className="text-[var(--tcp-text-muted)] normal-case font-normal">(Stored locally in browser)</span>
                </label>
              </div>

              <div className="relative flex items-center">
                <input
                  type={showKeyPlain ? 'text' : 'password'}
                  value={apiKeyInput}
                  onChange={(e) => {
                    setApiKeyInput(e.target.value);
                    setKeyValidationResult(null);
                  }}
                  placeholder="AIzaSy..."
                  className="w-full pl-3.5 pr-20 py-2.5 bg-[var(--tcp-canvas)] border border-[var(--tcp-border)] rounded-lg text-xs text-[var(--tcp-text-primary)] font-mono placeholder:text-[var(--tcp-text-muted)] focus:border-[var(--tcp-accent)] focus:ring-1 focus:ring-[var(--tcp-accent)] outline-none transition-colors"
                />
                <div className="absolute right-1.5 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setShowKeyPlain(!showKeyPlain)}
                    className="p-1.5 text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-primary)] rounded hover:bg-[var(--tcp-surface-2)]"
                    title={showKeyPlain ? 'Hide API key' : 'Show API key'}
                  >
                    {showKeyPlain ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                  {apiKeyInput && (
                    <button
                      type="button"
                      onClick={() => setApiKeyInput('')}
                      className="p-1.5 text-[var(--tcp-text-tertiary)] hover:text-red-400 rounded hover:bg-[var(--tcp-surface-2)]"
                      title="Clear field"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Validation Feedback Banner */}
            {isValidatingKey && (
              <div className="p-3 bg-[var(--tcp-surface-2)] border border-[var(--tcp-border)] rounded-lg flex items-center gap-2 text-xs text-[var(--tcp-text-secondary)] font-mono">
                <RefreshCw className="w-4 h-4 text-[var(--tcp-accent)] animate-spin" />
                <span>Testing API key with Google Maps Geocoding &amp; Roads services...</span>
              </div>
            )}

            {keyValidationResult && !isValidatingKey && (
              <div
                className={`p-3 rounded-lg border text-xs font-mono leading-relaxed ${
                  keyValidationResult.valid
                    ? 'bg-[#12281e] border-emerald-700 text-emerald-300'
                    : 'bg-[#2a1418] border-red-800 text-red-300'
                }`}
              >
                <div className="flex items-start gap-2">
                  {keyValidationResult.valid ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <div className="font-semibold">
                      {keyValidationResult.valid ? 'API Key Verified & Operational' : 'API Key Validation Issue'}
                    </div>
                    <div className="text-[11px] mt-0.5 opacity-90">{keyValidationResult.message}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Save Toast */}
            {saveToast && (
              <div className="p-2.5 rounded-lg bg-emerald-950 border border-emerald-600 text-emerald-200 text-xs font-mono text-center animate-fadeIn">
                ✓ {saveToast}
              </div>
            )}

            {/* Modal Actions */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 pt-2 border-t border-[var(--tcp-border)]">
              <button
                type="button"
                onClick={handleValidateKey}
                disabled={isValidatingKey || !apiKeyInput.trim()}
                className="px-3.5 py-2 bg-[var(--tcp-surface-2)] hover:bg-[var(--tcp-border)] disabled:opacity-40 text-[var(--tcp-text-primary)] hover:text-[var(--tcp-text-primary)] text-xs font-semibold rounded-lg border border-[var(--tcp-border)] flex items-center justify-center gap-1.5 transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isValidatingKey ? 'animate-spin' : 'text-[var(--tcp-accent)]'}`} />
                <span>Test Connection</span>
              </button>

              <div className="flex items-center gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowApiKeyModal(false)}
                  className="px-3.5 py-2 text-[var(--tcp-text-tertiary)] hover:text-[var(--tcp-text-primary)] text-xs font-semibold rounded-lg hover:bg-[var(--tcp-surface-2)] transition-colors"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={() => handleSaveKey(false)}
                  className="px-4 py-2 bg-[var(--tcp-border)] hover:bg-[var(--tcp-border-hover)] text-[var(--tcp-text-primary)] text-xs font-semibold rounded-lg border border-[var(--tcp-border-hover)] shadow transition-colors flex items-center gap-1.5"
                >
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Save Key</span>
                </button>

                {coords && (
                  <button
                    type="button"
                    onClick={() => handleSaveKey(true)}
                    className="px-4 py-2 bg-[var(--tcp-accent)] hover:bg-[var(--tcp-accent-hover)] text-[var(--tcp-text-primary)] text-xs font-semibold rounded-lg shadow transition-colors flex items-center gap-1.5"
                    title="Save key and re-test speed & assets for current pinned site"
                  >
                    <span>Save &amp; Query Site</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Print CSS: hide the interactive app, show only the printable sheet
          set, one page per drawing sheet. visibility (not display) toggling
          avoids reflow issues and is the standard reliable cross-browser
          approach for "print only this subtree." */}
      <style>{`
        @media screen {
          #printable-tcp-sheet { display: none; }
        }
        @media print {
          body * { visibility: hidden; }
          #printable-tcp-sheet, #printable-tcp-sheet * { visibility: visible; }
          #printable-tcp-sheet { position: absolute; left: 0; top: 0; width: 100%; display: block; }
          .print-page { page-break-after: always; padding: 32px; }
          .print-page:last-child { page-break-after: auto; }
          .print-page svg { max-width: 100%; height: auto; }
        }
      `}</style>

      {/* Printable Drawing Set — populated by handlePrint just before window.print() */}
      <div id="printable-tcp-sheet">
        {/* SHEET 1: COVER & PERMIT PARAMETERS */}
        <div className="print-page bg-white text-black font-sans">
          <h1 className="text-2xl font-bold uppercase tracking-wider mb-1">
            INCEDO TELECOM ENGINEERING — TRAFFIC CONTROL PLAN (TCP)
          </h1>
          <p className="text-xs text-[var(--tcp-text-muted)] mb-4 font-mono">
            Project: {projectName} | Site: {activeAddress || 'Not yet located'} | Status: {status.toUpperCase()} | Date: {new Date().toLocaleDateString()}
          </p>
          <div className="border border-black p-4 mb-6">
            <h2 className="text-sm font-bold uppercase mb-2">Permit Engineering Parameters</h2>
            <ul className="grid grid-cols-2 gap-2 text-xs font-mono">
              <li>Posted Speed: <strong>{design.speed} MPH</strong></li>
              <li>Work Type: <strong>{design.workType.toUpperCase()}</strong></li>
              <li>Calculated Merging Taper (L): <strong>{metrics.taper} FT</strong></li>
              <li>Longitudinal Buffer Space: <strong>{metrics.buffer} FT</strong></li>
              <li>Advance Warning Sign Spacing (X): <strong>{metrics.spacing} FT</strong></li>
              <li>Cone Spacing on Taper: <strong>{metrics.deviceTaper} FT</strong></li>
              <li>Cone Spacing on Tangent: <strong>{metrics.deviceTangent} FT</strong></li>
              <li>Sign Dimension Standard: <strong>{metrics.signSize}</strong></li>
              <li>Work Area Length: <strong>{design.length} FT</strong></li>
              <li>Directional Lanes: <strong>{design.lanes}</strong></li>
            </ul>
          </div>
          <div className="border border-black p-4">
            <h2 className="text-sm font-bold uppercase mb-2">Drawing Set Index</h2>
            <table className="w-full text-xs font-mono border-collapse">
              <tbody>
                {[
                  { num: 1, name: 'Title Block, Vicinity Map & Standard Telecom Notes' },
                  { num: 2, name: 'GIS Road Corridor & OSP Utility Infrastructure Alignment' },
                  { num: 3, name: 'MUTCD Reference Tables & Channelizing Device Schedules' },
                  { num: 4, name: 'Traffic Control Plan (TCP) CAD Diagram & Phasing' },
                ].map((s) => (
                  <tr key={s.num} className="border-b border-slate-300">
                    <td className="py-1 pr-2 font-bold">{s.num}</td>
                    <td className="py-1">{s.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* SHEET 2: MUTCD REFERENCE TABLES */}
        <div className="print-page bg-white text-black font-sans">
          <h2 className="text-lg font-bold uppercase mb-3">MUTCD 2011 Reference Tables — Texas MUTCD Ch. 6C</h2>
          <h3 className="text-sm font-bold uppercase mt-4 mb-1">Table 6C-1 — Advance Warning Sign Spacing (X)</h3>
          <table className="w-full text-xs font-mono border-collapse border border-black">
            <thead>
              <tr>
                {SIGN_SPACING_TABLE.map((row) => (
                  <th key={row.s} className={`border border-black p-1 ${row.s === design.speed ? 'bg-amber-200' : ''}`}>
                    {row.s}{row.star ? '*' : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {SIGN_SPACING_TABLE.map((row) => (
                  <td key={row.s} className={`border border-black p-1 text-center ${row.s === design.speed ? 'bg-amber-200 font-bold' : ''}`}>
                    {row.x}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>

          <h3 className="text-sm font-bold uppercase mt-6 mb-1">Table 6C-2 — Longitudinal Buffer Space</h3>
          <table className="w-full text-xs font-mono border-collapse border border-black">
            <thead>
              <tr>
                {BUFFER_SPACE_TABLE.map((row) => (
                  <th key={row.s} className={`border border-black p-1 ${row.s === design.speed ? 'bg-amber-200' : ''}`}>
                    {row.s}{row.star ? '*' : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {BUFFER_SPACE_TABLE.map((row) => (
                  <td key={row.s} className={`border border-black p-1 text-center ${row.s === design.speed ? 'bg-amber-200 font-bold' : ''}`}>
                    {row.x}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          <p className="text-[10px] text-[var(--tcp-text-muted)] mt-2">Highlighted column = this project's posted speed ({design.speed} MPH). * = distance should be increased for 1,500 ft advance warning.</p>
        </div>

        {/* SHEET 3: TCP CAD DIAGRAM (live SVG, captured at export time) */}
        <div className="print-page bg-white text-black font-sans">
          <h2 className="text-lg font-bold uppercase mb-3">Sheet 4 — Traffic Control Plan (TCP) Diagram</h2>
          {printSvgMarkup ? (
            <div dangerouslySetInnerHTML={{ __html: printSvgMarkup }} />
          ) : (
            <p className="text-sm text-red-700 font-semibold">
              Diagram unavailable — the TCP diagram hadn't rendered yet when this set was prepared. Open the CAD Diagram view and try Export again.
            </p>
          )}
        </div>

        {/* SHEET 4: COMPLIANCE CHECKLIST & SUBMITTAL STATUS */}
        <div className="print-page bg-white text-black font-sans">
          <h2 className="text-lg font-bold uppercase mb-3">MUTCD 2011 Engineering Quality &amp; Safety Audit</h2>
          <table className="w-full text-xs border-collapse">
            <tbody>
              {getComplianceItems(design, analysis, metrics).map((item) => (
                <tr key={item.id} className="border-b border-slate-300 align-top">
                  <td className="py-2 pr-3 font-mono font-bold whitespace-nowrap">
                    [{item.type.toUpperCase()}]
                  </td>
                  <td className="py-2">
                    <div className="font-bold">{item.title} <span className="font-mono font-normal text-[var(--tcp-text-muted)]">({item.codeRef})</span></div>
                    <div className="text-[var(--tcp-text-muted)] mt-0.5">{item.note}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs font-mono mt-6">
            Submittal Status: <strong>{status.toUpperCase()}</strong> · Generated {new Date().toLocaleString()}
          </p>
          <p className="text-[10px] text-[var(--tcp-text-muted)] mt-4">
            This is an auto-generated schematic and compliance summary. It must be reviewed and sealed by a licensed engineer as required by the issuing municipality before work begins.
          </p>
        </div>
      </div>
    </div>
  );
}
