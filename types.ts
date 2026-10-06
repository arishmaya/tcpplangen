export interface LatLng {
  lat: number;
  lng: number;
}

export interface RoutePoint {
  id: string;
  lat: number;
  lng: number;
  label: string; // e.g. "Point A (Start)", "Point B (Work Waypoint)", "Point C (Telecom Site)"
  address?: string;
  seq: number;
}

export interface RouteCorridor {
  id: string;
  name: string;
  points: RoutePoint[];
  path: LatLng[];
  distanceMeters: number;
  distanceFt: number;
  durationSec: number;
  roadName: string;
  speedLimitMph: number;
  speedSource: 'google_roads_api' | 'google_routes_api' | 'osm_live' | 'simulated';
}

export type RouteAssetCategory =
  | 'signals_boards'
  | 'manholes'
  | 'electric_poles'
  | 'obstructions'
  | 'speed';

export type RouteAssetType =
  | 'uturn_board'
  | 'school_zone'
  | 'speed_sign'
  | 'regulatory_board'
  | 'warning_board'
  | 'traffic_signal'
  | 'manhole'
  | 'handhole'
  | 'telecom_vault'
  | 'electric_pole'
  | 'utility_pole'
  | 'driveway'
  | 'drainage_grate'
  | 'fire_hydrant'
  | 'tree_canopy';

export interface RouteAsset {
  id: string;
  type: RouteAssetType;
  category: RouteAssetCategory;
  title: string;
  mutcdCode?: string; // e.g. "R3-4", "S1-1", "R2-1", "W3-3"
  station: string; // e.g. "STA 0+180"
  stationFt: number;
  offsetFt: number; // -ft for left, +ft for right
  side: 'Left Shoulder' | 'Right Curb' | 'Center Median' | 'Traveled Lane';
  lat: number;
  lng: number;
  description: string;
  status?: string;
  tcpImpact: string; // How this feature directly dictates the TCP / CAD design
  iconType: string;
}

export interface SnappedPoint {
  id?: number;
  seq: number;
  lat: number;
  lng: number;
  place_id?: string;
  heading: number;
  street_view_url?: string;
}

export interface DetectedSign {
  id?: number;
  type: string;
  label: string;
  confidence: number;
  value?: string;
  lat?: number;
  lng?: number;
  street_view_url?: string;
  source?: string;
}

export interface UtilityManhole {
  id: string;
  label: string;
  station: string;
  offsetFt: number;
  depthInches?: number;
  type: 'Telecom Manhole' | 'Handhole' | 'Vault';
}

export interface SiteAnalysis {
  speed: number;
  speedLive: boolean;
  speedSource: 'google_roads_api' | 'osm_live' | 'sample_permit' | 'simulated';
  classification: string;
  lanes: number;
  laneConf: 'high' | 'med' | 'low';
  schoolZone: boolean;
  schoolDist: number | null;
  manholeCount: number;
  manholeNote: string;
  manholes: UtilityManhole[];
  detectedSigns: DetectedSign[];
  utilityPolesCount: number;
  pavementCondition: string;
  streetViewUrl?: string;
  streetViewPanoAvailable?: boolean;
  source: string;
  // Route multi-point enhancements
  routeCorridor?: RouteCorridor;
  routeAssets?: RouteAsset[];
}

export interface DesignParams {
  workType: 'shoulder' | 'one-lane' | 'two-lane' | 'intersection';
  lanes: number;
  speed: number;
  length: number;
  offset: number;
  duration: string;
  contractorName: string;
  projectName: string;
  flaggersRequired: boolean;
  arrowBoardRequired: boolean;
  trenchPlates: boolean;
}

export interface MUTCDMetrics {
  taper: number;
  buffer: number;
  spacing: number;
  deviceTaper: number;
  deviceTangent: number;
  signSize: string;
  downstream: number;
}

export interface ComplianceItem {
  id: string;
  type: 'pass' | 'warn' | 'info';
  title: string;
  note: string;
  codeRef: string;
}

export interface DrawingSheet {
  num: number;
  name: string;
  category: string;
  ready: boolean;
}

export type ProjectStatus = 'draft' | 'submitted' | 'review' | 'approved';
