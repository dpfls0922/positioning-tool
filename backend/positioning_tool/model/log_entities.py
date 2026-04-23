import re
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

GOOD_MATCH_STATES = ["MATCH_OK_TRANSIENT", "MATCH_OK_GOOD"]


class CoordType(Enum):
    GNSS1 = (
        "Filtered GNSS",
        "yellow",
        re.compile(r"\[GPS\] (\d+\.\d+), (\d+\.\d+), (\d+\.\d+), [^,]+, (\d+\.\d+).*?DR : (\d+\.\d+), (\d+\.\d+)")
    )
    GNSS2 = (
        "Raw GNSS",
        "purple",
        re.compile(r"\[GNSS\]\s*,\d+,\d+,(\d+),(\d+),([\d\.-]+).*?,([\d\.-]+)$")
    )
    DR = (
        "DR-based",
        "red",
        re.compile(r"CNaviModule::ReceiveGps pos\(([\d\.]+), ([\d\.]+)\).*?speed ([\d\.]+).*?isDRGps (\d+).*?drHeading ([\d\.]+)")
    )
    ROAD_MATCH = (
        "Road Match",
        "cyan",
        re.compile(r"Match\s+Pos\s*=\s*(-?\d+\.\d+)\s+(-?\d+\.\d+),\s*(-?\d+\.\d+)")
    )
    ROUTE_MATCH = (
        "Route Match",
        "lime",
        re.compile(r"Match\s+Pos\s*=\s*(-?\d+\.\d+)\s+(-?\d+\.\d+),\s*(-?\d+\.\d+)")
    )
    VPM = (
        "VPM",
        "blue",
        re.compile(
            r"\[MM\]\s*(-?\d+\.\d+),\s*(-?\d+\.\d+),\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)"
            r"(?:,\s*(-?\d+\.\d+),\s*(\d+))?"
        )
    )
    REQUEST = (
        "Request",
        "gray",
        re.compile(r"NaviProcessorInternal::requestRouting (\d+), (\d+)")
    )

    def __init__(self, type_name, color, pattern):
        self.type = type_name
        self.color = color
        self.pattern = pattern

    def get_color(self, coord):
        if self == CoordType.DR and coord.extra.get("isDRGps") == 0:
            return "orange"
        return self.color

    def should_fill_marker(self, coord):
        if self == CoordType.ROAD_MATCH or self == CoordType.ROUTE_MATCH:
            match_state = coord.extra.get("match_state", "")
            if match_state not in GOOD_MATCH_STATES:
                return False
        return True


class LineType(Enum):
    GNSS_TO_DR = "GNSS to DR"
    DR_CORRECTION = "DR Correction"
    DR_TO_VPM = "DR to VPM"
    DEVIATION = "Deviation"


class RouteRequestType(Enum):
    NONE = ("None", -1)
    FIRST = ("초기", 0)
    REROUTE_BREAKAWAY = ("이탈", 1)
    REROUTE_FIXED_CYCLE = ("주기", 2)
    REROUTE_FORCE = ("강제", 3)
    REROUTE_BRANCHALT = ("분기대안", 4)
    REROUTE_AVOIDALT = ("우회대안", 5)
    REROUTE_DESTINATION = ("목적지재탐색", 6)
    REROUTE_RESTORE = ("복구", 7)
    TEMPORARY = ("임시", 8)
    AUTO_ONLINE = ("온라인자동", 9)
    FIRST_MMC = ("초기(MMC)", 10)
    FIRST_BT = ("초기(BT)", 11)
    REROUTE_FIXED_CYCLE_BY_MANUALLY = ("주기(수동)", 12)

    def __init__(self, label, code):
        self.label = label
        self.code = code

    @staticmethod
    def get_type_by_value(value):
        for request_type in RouteRequestType:
            if request_type.code == value:
                return request_type
        return RouteRequestType.NONE

    def __str__(self):
        return self.name


@dataclass
class Coordinate:
    id: int = None
    dlt_id: int = None
    type: str = ""
    latitude: float = 0.0
    longitude: float = 0.0
    heading: float = None
    extra: dict = field(default_factory=dict)
    timestamp: datetime = None

    def to_json(self):
        coord_type = self.type if isinstance(self.type, CoordType) else None
        return {
            "id": self.id,
            "dlt_id": self.dlt_id,
            "type": self.type.type,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "heading": self.heading,
            "extra": self.extra,
            "timestamp_ms": int(self.timestamp.timestamp() * 1000) if self.timestamp else None,
            "timestamp_str": self.timestamp.strftime("%Y/%m/%d %H:%M:%S.%f")[:-3] if self.timestamp else "",
            "color": coord_type.get_color(self) if coord_type is not None else "black",
            "fill": coord_type.should_fill_marker(self) if coord_type is not None else True
        }


@dataclass
class Line:
    type: str
    start: tuple
    end: tuple
    id: int = None
    timestamp: datetime = None
    distance_threshold: float = None
    angle_threshold: float = None
    actual_distance: float = None
    actual_angle_diff: float = None
    local_distance: float = None
    route_distance: float = None
    deviation_type: str = None
    extra: dict = field(default_factory=dict)

    def to_json(self):
        return {
            "id": self.id,
            "type": self.type.value,
            "start": list(self.start),
            "end": list(self.end),
            "timestamp_ms": int(self.timestamp.timestamp() * 1000) if self.timestamp else None,
            "timestamp_str": self.timestamp.strftime("%Y/%m/%d %H:%M:%S.%f")[:-3] if self.timestamp else "",
            "distance_threshold": self.distance_threshold,
            "angle_threshold": self.angle_threshold,
            "actual_distance": self.actual_distance,
            "actual_angle_diff": self.actual_angle_diff,
            "local_distance": self.local_distance,
            "route_distance": self.route_distance,
            "deviation_type": self.deviation_type,
            "extra": self.extra
        }


__all__ = ["Coordinate", "Line", "CoordType", "LineType", "RouteRequestType"]
