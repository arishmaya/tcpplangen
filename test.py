import math
import json
import numpy as np
import geopandas as gpd
import matplotlib.pyplot as plt
import ezdxf
from shapely.geometry import (
    Point,
    Polygon,
    LineString
)
# =====================================================
# CONFIG
# =====================================================
CONFIG = {
    "speed_mph":45,
    "lane_width_ft":12,
    "road_width_ft":24,
    "buffer_length_ft":200,
    "work_zone_length_ft":500,
    "cone_spacing_ft":45,
    "state_plane":"EPSG:2229",
    "signs":[
        {
            "code":"W20-1",
            "text":"ROAD WORK AHEAD",
            "distance_ft":1500
        },
        {
            "code":"W20-4",
            "text":"ONE LANE ROAD AHEAD",
            "distance_ft":1000
        },
        {
            "code":"W20-7",
            "text":"FLAGGER AHEAD",
            "distance_ft":500
        },
        {
            "code":"G20-2",
            "text":"END ROAD WORK",
            "distance_ft":250
        }
    ]
}
# =====================================================
# MUTCD TAPER
# =====================================================
def taper_length_ft(width, speed):
    if speed >= 45:
        return width * speed
    return width * speed**2 / 60
# =====================================================
# STATION OFFSET
# =====================================================
def station_offset(
        line,
        station,
        offset):
    p = line.interpolate(station)
    s1 = max(station-1,0)
    s2 = min(
        station+1,
        line.length
    )
    p1 = line.interpolate(s1)
    p2 = line.interpolate(s2)
    dx = p2.x - p1.x
    dy = p2.y - p1.y
    length = math.hypot(dx,dy)
    nx = -dy/length
    ny = dx/length
    return Point(
        p.x + offset * nx,
        p.y + offset * ny
    )
# =====================================================
# LOAD GIS
# =====================================================
gdf = gpd.read_file(
    "road.geojson"
)
if gdf.crs is None:
    gdf.set_crs(
        epsg=4326,
        inplace=True
    )
gdf = gdf.to_crs(
    CONFIG["state_plane"]
)
road = gdf.geometry.iloc[0]
if road.geom_type == "MultiLineString":
    road = max(
        road.geoms,
        key=lambda g:g.length
    )
# =====================================================
# BASIC VALUES
# =====================================================
speed = CONFIG["speed_mph"]
lane_width = CONFIG["lane_width_ft"]
road_width = CONFIG["road_width_ft"]
buffer_length = CONFIG["buffer_length_ft"]
work_length = CONFIG["work_zone_length_ft"]
cone_spacing = CONFIG["cone_spacing_ft"]
taper_length = taper_length_ft(
    lane_width,
    speed
)
# =====================================================
# ROAD POLYGON
# =====================================================
left_pts = []
right_pts = []
for s in np.arange(
        0,
        road.length,
        10):
    l = station_offset(
        road,
        s,
        road_width/2
    )
    r = station_offset(
        road,
        s,
        -road_width/2
    )
    left_pts.append(
        l.coords[0]
    )
    right_pts.append(
        r.coords[0]
    )
road_poly = Polygon(
    left_pts +
    right_pts[::-1]
)
# =====================================================
# CONES
# =====================================================
cones=[]
for s in np.arange(
        0,
        taper_length,
        cone_spacing):
    ratio = s / taper_length
    offset = ratio * lane_width
    cone = station_offset(
        road,
        s,
        offset
    )
    cones.append(cone)
# =====================================================
# WORK AREA
# =====================================================
work_start = (
    taper_length +
    buffer_length
)
work_end = (
    work_start +
    work_length
)
left_side=[]
right_side=[]
for s in np.arange(
        work_start,
        work_end,
        5):
    left_side.append(
        station_offset(
            road,
            s,
            lane_width
        ).coords[0]
    )
    right_side.append(
        station_offset(
            road,
            s,
            road_width/2
        ).coords[0]
    )
work_area = Polygon(
    left_side +
    right_side[::-1]
)
# =====================================================
# SIGNS
# =====================================================
signs=[]
for sign in CONFIG["signs"]:
    station = max(
        road.length -
        sign["distance_ft"],
        0
    )
    pt = station_offset(
        road,
        station,
        road_width/2 + 8
    )
    signs.append(
        {
            "geom":pt,
            "text":sign["text"],
            "code":sign["code"]
        }
    )
# =====================================================
# FLAGGERS
# =====================================================
flagger1 = station_offset(
    road,
    taper_length/2,
    road_width/2 + 4
)
flagger2 = station_offset(
    road,
    work_end + 50,
    road_width/2 + 4
)
# =====================================================
# PDF SHEET
# =====================================================
fig = plt.figure(
    figsize=(36,24)
)
ax = fig.add_subplot(111)
# roadway
rx,ry = road_poly.exterior.xy
ax.fill(
    rx,
    ry,
    color="#d0d0d0"
)
# centerline
x,y = road.xy
ax.plot(
    x,
    y,
    color="yellow",
    linewidth=2
)
# work area
wx,wy = work_area.exterior.xy
ax.fill(
    wx,
    wy,
    hatch='///',
    facecolor='none',
    edgecolor='black'
)
# cones
for c in cones:
    ax.scatter(
        c.x,
        c.y,
        color='orange',
        marker='D',
        s=35
    )
# signs
for sign in signs:
    p = sign["geom"]
    ax.scatter(
        p.x,
        p.y,
        color='black',
        marker='s',
        s=100
    )
    ax.text(
        p.x + 20,
        p.y + 20,
        sign["code"],
        fontsize=7
    )
# flaggers
for f in [flagger1,flagger2]:
    ax.scatter(
        f.x,
        f.y,
        color='red',
        s=120
    )
# title block
xmin,xmax=ax.get_xlim()
ymin,ymax=ax.get_ylim()
ax.text(
    xmin,
    ymin-200,
    f"""
CA MUTCD ONE-LANE TWO-WAY TAPER
Speed: {speed} MPH
Lane Width: {lane_width} FT
Taper Length: {taper_length:.0f} FT
Cones: {len(cones)}
Signs: {len(signs)}
""",
    fontsize=10
)
ax.axis("equal")
ax.axis("off")
plt.savefig(
    "TCP_PLAN.pdf",
    dpi=300,
    bbox_inches='tight'
)
plt.savefig(
    "TCP_PLAN.png",
    dpi=300,
    bbox_inches='tight'
)
# =====================================================
# DXF
# =====================================================
doc = ezdxf.new()
layers = [
    "TCP_ROAD",
    "TCP_CONES",
    "TCP_SIGNS",
    "TCP_WORK",
    "TCP_LABELS"
]
for layer in layers:
    if layer not in doc.layers:
        doc.layers.add(
            layer
        )
msp = doc.modelspace()
# road centerline
msp.add_lwpolyline(
    list(road.coords),
    dxfattribs={
        "layer":"TCP_ROAD"
    }
)
# cones
for c in cones:
    msp.add_circle(
        (c.x,c.y),
        radius=1.5,
        dxfattribs={
            "layer":"TCP_CONES"
        }
    )
# signs
for sign in signs:
    p=sign["geom"]
    msp.add_circle(
        (p.x,p.y),
        radius=3,
        dxfattribs={
            "layer":"TCP_SIGNS"
        }
    )
    msp.add_text(
        sign["text"],
        height=4,
        dxfattribs={
            "layer":"TCP_LABELS"
        }
    ).set_placement(
        (p.x+10,p.y+10)
    )
# work area
msp.add_lwpolyline(
    list(work_area.exterior.coords),
    close=True,
    dxfattribs={
        "layer":"TCP_WORK"
    }
)
doc.saveas(
    "TCP_PLAN.dxf"
)
# =====================================================
# GEOJSON DEVICES
# =====================================================
points = cones + \
         [s["geom"] for s in signs] + \
         [flagger1,flagger2]
devices = gpd.GeoDataFrame(
    geometry=points,
    crs=CONFIG["state_plane"]
)
devices.to_crs(
    "EPSG:4326"
).to_file(
    "TCP_DEVICES.geojson",
    driver="GeoJSON"
)
print("DONE")
print("Generated:")
print("  TCP_PLAN.pdf")
print("  TCP_PLAN.png")
print("  TCP_PLAN.dxf")
print("  TCP_DEVICES.geojson")
