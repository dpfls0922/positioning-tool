import csv
import json
import math
import os
import re
from datetime import datetime, timedelta

from backend.positioning_tool.service.paths import PATHS
from backend.positioning_tool.model.log_entities import Coordinate, Line, CoordType, LineType, RouteRequestType

EARTH_RADIUS = 6371000.0
DEG2RAD = math.pi / 180.0


COORDINATES = {coord_type: [] for coord_type in CoordType}
LINES = {line_type: [] for line_type in LineType}
GUIDE_EVENTS = []  # C2X events and accident events
SDI_EVENTS = []  # SDI (Safety Drive Information) events
GP_ENTRIES = []  # Route guidance points (GP) collected when a route is applied
GP_RENDER_POINTS = []  # TVAS GP table from GetRenderData pGuidePoint logs
ROUTE_MATCH_LINKS = []  # (route link index, route vertex index, timestamp) while driving
GP_LANE_EVENTS = []  # Runtime setLaneColor ticks ([LANE_COLOR] linkIndex:...)
gp_pending = {}  # Per-link scratch built up across the ServiceDataCollect log lines
PARKING_LOT_EVENTS = []  # ParkingLot detector exit events
LANE_EXT_LINKS = {}  # link_id(str) -> 확장 차선수([LANE_EXT] 로그) 정보
last_gnss_coordinate = None  # Track last GNSS position for parking lot events
min_timestamp = datetime.max
max_timestamp = datetime.min
last_road_match_state = None
last_route_match_state = None
last_threshold_info = None
log_base_timestamp = None
last_tvas_header_info = None
current_route_session_id = None
current_route_session_index = 0
route_session_indices = {}
route_session_sequence = {}
current_gnss_mode = None
pending_gnss_mode_transition = None
ROUTE_REQUEST_POINTS = {}  # content_id(str) -> {depart, waypoints{idx: point}, dest}
ROUTE_SESSION_CONTENT_IDS = {}  # route_session_id -> request content_id(str)
DLT_RELEVANT_BYTE_KEYWORDS = [
    b"[GPS]",
    b"[GNSS]",
    b"GNSS mode:",
    b"GNSS rejected:",
    b"CNaviModule::ReceiveGps pos(",
    b"Match  Pos",
    b"Match Pos",
    b"[MM_RESULT]",
    b"requestRouting",
    b"NaviARSupportServer::setRouteInformation",
    b"Candidate Link[",
    b"shouldStayRoute distance:",
    b"[[MM] : 4] State =",
    b"[MM_FEEDBACK]",
    b"createCar2XEvent",
    b"processContents",
    b"GetSdiSelected select",
    b"onDriveStatusChanged SDI",
    b"[LANE_EXT]",
    b"ApplyParkingLotDetector",
    b"ParkingLotDetector transition",
    b"TVAS server route",
    b"online request [",
    b"[TVAS Header]",
    b"ServiceDataCollect",
    b"Route LinkScore RESULT",
    b"[LANE_COLOR]",
    b"GetRenderData pGuidePoint",
]

SET_ROUTE_INFORMATION_PATTERN = re.compile(
    r"NaviARSupportServer::setRouteInformation linkID:\s*"
    r"(-?\d+)\((\-?\d+)\),\s*dir:\s*(\-?\d+),\s*(\-?\d+)"
    r"(?:,\s*(\-?\d+),\s*(\-?\d+))?,\s*"
    r"size:\s*(\d+),\s*v\[st\]:\s*(\-?\d+),\s*(\-?\d+),\s*v\[en\]:\s*(\-?\d+),\s*(\-?\d+)"
)
TVAS_HEADER_ROUTE_OPT_PATTERN = re.compile(r"navisdk :: \[\[TVAS Header\] : \d+\] RouteOptCode = (\-?\d+)")
TVAS_HEADER_SERVICE_CNT_PATTERN = re.compile(r"navisdk :: \[\[TVAS Header\] : \d+\] ServiceCnt = (\-?\d+)")
TVAS_HEADER_TOTAL_TIME_PATTERN = re.compile(r"navisdk :: \[\[TVAS Header\] : \d+\] TotalTime = (\-?\d+)")
TVAS_HEADER_TOTAL_DIST_PATTERN = re.compile(r"navisdk :: \[\[TVAS Header\] : \d+\] TotalDist = (\-?\d+)")
TVAS_SERVER_SESSION_PATTERN = re.compile(
    r"TVAS server route nSessionID\s*:\s*([^,\s]+),\s*errorcode\s*:\s*([^,\s]+)"
)
# Route request point logs (SK coordinates; converted to WGS84 on the frontend):
#   NaviProcessorInternal::online request [10000013]: departName = ..., departXPos = ..., departYPos = ...
#   NaviProcessorInternal::online request [10000013]: wayPoint 0: fixed = 1, wayPointName = ..., destXPos = ..., destYPos = ...
#   NaviProcessorInternal::online request [10000013]: destName = ..., destXPos = ..., destYPos = ...
ROUTE_REQ_DEPART_PATTERN = re.compile(
    r"online request \[(\d+)\]:\s*departName = (.*?),\s*departXPos = (-?\d+),\s*departYPos = (-?\d+)"
)
ROUTE_REQ_WAYPOINT_PATTERN = re.compile(
    r"online request \[(\d+)\]:\s*wayPoint (\d+):\s*fixed = (-?\d+),\s*wayPointName = (.*?),\s*destXPos = (-?\d+),\s*destYPos = (-?\d+)"
)
ROUTE_REQ_DEST_PATTERN = re.compile(
    r"online request \[(\d+)\]:\s*destName = (.*?),\s*destXPos = (-?\d+),\s*destYPos = (-?\d+)"
)
GNSS_MODE_EVENT_PATTERN = re.compile(
    r"GNSS mode:\s*event=([A-Za-z_]+)\s+from=([A-Za-z_]+)\s+to=([A-Za-z_]+)"
)
GNSS_MODE_INLINE_PATTERN = re.compile(r"mode=([A-Za-z_]+)")
MM_FEEDBACK_PATTERN = re.compile(r"\[MM_FEEDBACK\]\s*([^\r\n\x00]+)")
CANDIDATE_LINK_PATTERN = re.compile(
    r"Candidate Link\[\s*(\-?\d+)\]\s*"
    r"([+\-]?\d+(?:\.\d+)?)\s*\|\s*"
    r"Base:\s*([+\-]?\d+(?:\.\d+)?)\s*=\s*([+\-]?\d+(?:\.\d+)?)\s*-\s*([+\-]?\d+(?:\.\d+)?)\s*\+\s*([+\-]?\d+(?:\.\d+)?)\s*\|\s*"
    r"Adj:\s*([+\-]?\d+(?:\.\d+)?)\s*\|\s*"
    r"Dist\(p:\s*([+\-]?\d+(?:\.\d+)?)\s*d:\s*([+\-]?\d+(?:\.\d+)?)\s*laneW:\s*([+\-]?\d+(?:\.\d+)?)\s*fB:\s*([+\-]?\d+(?:\.\d+)?)\)\s*\|\s*"
    r"Angle\(g:\s*([+\-]?\d+(?:\.\d+)?)\s*v:\s*([+\-]?\d+(?:\.\d+)?)\)\s*\|\s*"
    r"Lane:\s*(\-?\d+)"
)

# Link[ID] base * mul = final / Lane:... — extrapoint 곱셈 가중치 적용 결과
LINK_EXTRAPOINT_PATTERN = re.compile(
    r"(?<![Cc]andidate\s)Link\[\s*(\-?\d+)\]\s*"
    r"([+\-]?\d+(?:\.\d+)?)\s*\*\s*([+\-]?\d+(?:\.\d+)?)\s*=\s*([+\-]?\d+(?:\.\d+)?)"
)

# C2X Events & TMAP Incident (MFS) Events — both carry actual WGS84 coordinates.
#
# C2X (V2X 통신 수신):
#   MapObjectProvider createCar2XEvent nEventID : 110, nEventType : 18,
#     aDASISProfile : 14427270, eType : 1, coord : 37.544675,126.976875,
#     eventTime : 202605150652, currentTime : 202605151552
CAR2X_CREATE_PATTERN = re.compile(
    r"createCar2XEvent\s+nEventID\s*:\s*(\d+),\s*nEventType\s*:\s*(\d+)"
    r".*?coord\s*:\s*(-?\d+\.\d+),(-?\d+\.\d+)"
    r"(?:.*?eventTime\s*:\s*(\d+))?"
)

# TMAP 유고정보 (MFS - Map Feature Service):
#   MapObjectProvider processContents type:1 state:1 key:MFS_XXXXX visible:1
#     level:16500 coord:37.XXXXXX,126.XXXXXX bCharge:0 VoltAC:0 bMarker:0 name:교통사고
MFS_CONTENT_PATTERN = re.compile(
    r"processContents\s+type:(\d+)\s+state:(\d+)\s+key:(\S+)\s+visible:(\d+)\s+level:(\d+)"
    r"\s+coord:(-?\d+\.\d+),(-?\d+\.\d+)"
    r".*?name:([^\r\n\x00]+)"
)

# SDI (Safety Drive Information) events:
#   GetSdiSelected select (0): 0, 15 nDist: 300, 500, wptPos: 37.545592, 126.978641
#   MapGuidingInformationProvider::onDriveStatusChanged SDI[15] CurrentSDI Speed : 50 pt(126.978641,37.545592)
SDI_SELECTED_PATTERN = re.compile(
    r"GetSdiSelected select\s*\((\d+)\):\s*(\d+),\s*(\d+)\s+nDist:\s*(\d+),\s*(\d+),\s+wptPos:\s*"
    r"(-?\d+\.\d+),\s*(-?\d+\.\d+)"
)
SDI_DRIVE_STATUS_PATTERN = re.compile(
    r"onDriveStatusChanged\s+SDI\[(\d+)\].*?Speed\s*:\s*(\d+).*?pt\((-?\d+\.\d+),(-?\d+\.\d+)\)"
)

# ParkingLot Detector application results:
#   ApplyParkingLotDetector: state=3, candidateCount=2, bestLinkId=51075, bestMatchState=1
PARKING_LOT_APPLY_PATTERN = re.compile(
    r"ApplyParkingLotDetector:\s*state=(\d+),\s*candidateCount=(\d+),\s*bestLinkId=(\d+)"
)

# ParkingLot Detector state transitions (fallback):
#   ParkingLotDetector transition: Idle -> EnterCandidate, reason=enter_candidate, ...
PARKING_LOT_STATE_CHANGE_PATTERN = re.compile(
    r"ParkingLotDetector transition:\s*([A-Za-z]+)\s*->\s*([A-Za-z]+),\s*reason=([^,]+)"
)

# 확장 차선수(LANE_EXT) 적용 로그 — 링크별로 LANE 값 대신 사용된 확장 차선수를 남긴다:
#   navisdk :: [[MM] : 4] [LANE_EXT] link[16446] lane:2 -> ext:3, dist:29.1, fB:0.353
LANE_EXT_PATTERN = re.compile(
    r"\[LANE_EXT\]\s*link\[\s*(-?\d+)\s*\]\s*lane:\s*(-?\d+)\s*->\s*ext:\s*(-?\d+)"
    r"(?:\s*,\s*dist:\s*([+\-]?\d+(?:\.\d+)?))?"
    r"(?:\s*,\s*fB:\s*([+\-]?\d+(?:\.\d+)?))?"
)

# ---------------------------------------------------------------------------
# GP (Guide Point) / turnCode logs — navisdk CRGDataCollector & CRGPlayer
#
# Emitted while a route is being applied (route build time), one burst per
# route link, in this order:
#   [LANE_COLOR] ucSndCode:65, nVoiceCode:65, usImgID:1234, ucImgAvailable:1, turnCode:18
#   ServiceDataCollect #1 bCrossImage:1, nTurnCode:18, nLinkID:57
#   ServiceDataCollect #2 bCrossImage:1, nTurnCode:18, nVoiceCode:65
#   ServiceDataCollect nGPType:196608, nTurnCode:18, nLinkID:57
#   [LANE_COLOR] store GP (new) GPIdx:7, linkIndex:57, nVoiceCode:65, nTurnCode:18, nGPType:0x30000
# The 'store GP (new)' line is the one that actually creates a GP; the earlier
# lines only carry the inputs the GP type was derived from. Links that never
# reach 'store GP (new)' are non-guidance pass-through links (turnCode 4 등).
#
# Emitted while driving (per matched link, once per link):
#   [LANE_COLOR] linkIndex:57, guidePointIndex:7, gpLinkIndex:57, nVoiceCode:65, laneColor:1, gpTurnCode:18
GP_CROSS_IMAGE_RAW_PATTERN = re.compile(
    r"ServiceDataCollect #1 bCrossImage:(-?\d+), nTurnCode:(-?\d+), nLinkID:(-?\d+)"
)
GP_CROSS_IMAGE_FILTERED_PATTERN = re.compile(
    r"ServiceDataCollect #2 bCrossImage:(-?\d+), nTurnCode:(-?\d+), nVoiceCode:(-?\d+)"
)
GP_TYPE_PATTERN = re.compile(
    r"ServiceDataCollect nGPType:(-?\d+), nTurnCode:(-?\d+), nLinkID:(-?\d+)"
)
GP_STORE_PATTERN = re.compile(
    r"\[LANE_COLOR\] store GP \(new\) GPIdx:(-?\d+), linkIndex:(-?\d+), "
    r"nVoiceCode:(-?\d+), nTurnCode:(-?\d+), nGPType:0x([0-9A-Fa-f]+)"
)
GP_CROSS_IMAGE_DATA_PATTERN = re.compile(
    r"\[LANE_COLOR\] ucSndCode:(-?\d+), nVoiceCode:(-?\d+), usImgID:(-?\d+), "
    r"ucImgAvailable:(-?\d+), turnCode:(-?\d+)"
)
GP_LANE_COLOR_PATTERN = re.compile(
    r"\[LANE_COLOR\] linkIndex:(-?\d+), guidePointIndex:(-?\d+), gpLinkIndex:(-?\d+), "
    r"nVoiceCode:(-?\d+), laneColor:(-?\d+), gpTurnCode:(-?\d+)"
)
# Route match result, logged per position fix (NcRouteMatchEX.cpp):
#   Route LinkScore RESULT LINK[1] Vertex[10] Score[110.064] [Angle:...] ...
# LINK[] is the route link index — the same enumeration ServiceDataCollect's
# nLinkID uses — so it ties a route link ordinal to a real driven position.
ROUTE_MATCH_LINK_PATTERN = re.compile(
    r"Route LinkScore RESULT LINK\[(-?\d+)\] Vertex\[(-?\d+)\]"
)
GP_RENDER_DATA_PATTERN = re.compile(
    r"GetRenderData pGuidePoint \[\s*(-?\d+)\] gpType (-?\d+), turnCode:\s*(-?\d+), vertexEnd\s*(-?\d+)"
)

# nGPType bit flags (rgdata_def.h RG_GPTYPE). Kept here so the parser can label
# GPs without the frontend; the map popup decodes the same values again.
GP_TYPE_FLAGS = (
    (0x00000001, "POSITION_S"),
    (0x00000002, "POSITION_E"),
    (0x00000010, "POSITION_V"),
    (0x00010000, "TURN"),
    (0x00020000, "EXTCROSSTURN"),
    (0x00100000, "ROTARY_IN"),
    (0x00200000, "ROTARY_INNER"),
    (0x00400000, "ROTARY_OUT"),
    (0x01000000, "IC"),
    (0x02000000, "JC"),
    (0x04000000, "SA"),
    (0x08000000, "TOLL"),
    (0x10000000, "EV_STATION"),
)


# nVoiceCode -> LaneColor, exactly as RGPlayer.cpp ToLaneColor() maps it. nVoiceCode
# is logged by the upstream 'ServiceDataCollect #2' line, so the lane bubble colour
# can be derived without the locally-added [LANE_COLOR] logs.
LANE_COLOR_BY_VOICE_CODE = {65: 1, 66: 2, 67: 3, 68: 4}


def lane_color_from_voice_code(voice_code):
    """LaneColor value for a voice code (0 = NONE)."""
    if voice_code is None:
        return 0
    return LANE_COLOR_BY_VOICE_CODE.get(int(voice_code), 0)


# LaneColor enum (rgdata_def.h) -> marker colour for the drive-time lane events
LANE_COLOR_HEX = {
    0: "#64748b",  # NONE
    1: "#22c55e",  # GREEN
    2: "#ec4899",  # PINK
    3: "#3b82f6",  # BLUE
    4: "#eab308",  # YELLOW
}


def decode_gp_type_flags(gp_type):
    """Split an nGPType value into its RG_GPTYPE flag names."""
    if not gp_type:
        return []
    return [name for mask, name in GP_TYPE_FLAGS if gp_type & mask]



def lat_lon_dist(lat1, lon1, lat2, lon2):
    local_x = -(((lon2 - lon1) * DEG2RAD) * math.cos(DEG2RAD * lat1)) * EARTH_RADIUS
    local_y = ((lat2 - lat1) * DEG2RAD) * EARTH_RADIUS
    return math.sqrt((local_x * local_x) + (local_y * local_y))


def reset_runtime_state():
    global COORDINATES, LINES, GUIDE_EVENTS, SDI_EVENTS, PARKING_LOT_EVENTS, LANE_EXT_LINKS, last_gnss_coordinate
    global GP_ENTRIES, GP_RENDER_POINTS, GP_LANE_EVENTS, gp_pending, ROUTE_MATCH_LINKS
    global min_timestamp, max_timestamp
    global last_road_match_state, last_route_match_state, last_threshold_info, log_base_timestamp, last_tvas_header_info
    global current_route_session_id, current_route_session_index, route_session_indices, route_session_sequence
    global current_gnss_mode, pending_gnss_mode_transition

    global ROUTE_REQUEST_POINTS, ROUTE_SESSION_CONTENT_IDS

    COORDINATES = {coord_type: [] for coord_type in CoordType}
    LINES = {line_type: [] for line_type in LineType}
    GUIDE_EVENTS = []
    SDI_EVENTS = []
    PARKING_LOT_EVENTS = []
    LANE_EXT_LINKS = {}
    GP_ENTRIES = []
    GP_RENDER_POINTS = []
    GP_LANE_EVENTS = []
    ROUTE_MATCH_LINKS = []
    gp_pending = {}
    ROUTE_REQUEST_POINTS = {}
    ROUTE_SESSION_CONTENT_IDS = {}
    last_gnss_coordinate = None
    min_timestamp = datetime.max
    max_timestamp = datetime.min
    last_road_match_state = None
    last_route_match_state = None
    last_threshold_info = None
    log_base_timestamp = None
    last_tvas_header_info = None
    current_route_session_id = None
    current_route_session_index = 0
    route_session_indices = {}
    route_session_sequence = {}
    current_gnss_mode = None
    pending_gnss_mode_transition = None


def parse_log(log_file_path=None):
    global last_road_match_state, last_route_match_state, last_threshold_info
    global log_base_timestamp, last_tvas_header_info, last_gnss_coordinate
    global current_route_session_id, current_route_session_index, route_session_indices, route_session_sequence
    global current_gnss_mode, pending_gnss_mode_transition

    current_id = 1
    temp_gnss1_coord = None
    temp_gnss2_coord = None
    last_dr_coordinate = None
    pending_mm_feedback_reason = None
    # Requests waiting for their TVAS session id (which arrives later in the log)
    pending_route_request_coords = []
    last_vpm_coordinate = None
    last_road_match_coord = None
    last_route_match_coord = None
    pending_candidate_link_scores = []
    pending_extrapoint_by_link_id = {}  # link_id -> extrapoint_info, buffered until Candidate Link line arrives
    source_path = log_file_path or PATHS.log_file_path
    log_base_timestamp = infer_initial_timestamp(source_path)
    current_timestamp = log_base_timestamp
    line_number = 0

    if not os.path.exists(source_path):
        print(f"오류: 로그 파일 '{source_path}'을 찾을 수 없습니다.")
        return False

    def flush_pending_raw_gnss(assign_id=None):
        nonlocal temp_gnss2_coord
        if temp_gnss2_coord is None:
            return
        candidate_id = assign_id if isinstance(assign_id, int) and assign_id > 0 else (current_id - 1 if current_id > 1 else current_id)
        temp_gnss2_coord.id = candidate_id
        COORDINATES[CoordType.GNSS2].append(temp_gnss2_coord)
        temp_gnss2_coord = None

    for dlt_id, line, reception_timestamp in iterate_log_records(source_path):
            line_number += 1

            # Priority: DLT storage-header reception timestamp (absolute time).
            if reception_timestamp is not None:
                current_timestamp = reception_timestamp
            else:
                parsed_timestamp = parse_datetime(line, current_timestamp)
                if parsed_timestamp:
                    current_timestamp = parsed_timestamp

            timestamp = current_timestamp
            if timestamp:
                update_timestamp_range(timestamp)

            threshold_info = parse_threshold_info(line)
            if threshold_info:
                last_threshold_info = threshold_info

            gnss_mode_info = parse_gnss_mode_info(line)
            if gnss_mode_info:
                current_gnss_mode = gnss_mode_info["mode"]
                if gnss_mode_info.get("transition"):
                    pending_gnss_mode_transition = gnss_mode_info["transition"]

            route_session_info = parse_route_session_info(line)
            if route_session_info:
                current_route_session_id = route_session_info["session_id"]
                current_route_session_index = route_session_indices.setdefault(
                    current_route_session_id,
                    len(route_session_indices) + 1,
                )
                route_session_sequence.setdefault(current_route_session_id, 0)
                last_tvas_header_info = None
                # The session id arrives after the request in the log; link it back
                # to any pending Request coordinates so they can be matched later.
                for pending_request in pending_route_request_coords:
                    pending_request.extra["route_session_id"] = current_route_session_id
                    ROUTE_SESSION_CONTENT_IDS[current_route_session_id] = pending_request.extra.get("group_1")
                pending_route_request_coords = []

            # Parse Guide Events (C2X, Accident), SDI Events, and Parking Lot Events
            parse_guide_event(line, timestamp)
            parse_sdi_event(line, timestamp)
            parse_parking_lot_event(line, timestamp)
            parse_lane_ext(line, timestamp)
            parse_gp_guide_event(line, timestamp)
            parse_route_request_points(line)

            tvas_header_info = parse_tvas_header_info(line, last_tvas_header_info)
            if tvas_header_info is not None:
                last_tvas_header_info = tvas_header_info

            extrapoint_info = parse_link_extrapoint(line)
            if extrapoint_info:
                pending_extrapoint_by_link_id[extrapoint_info["link_id"]] = extrapoint_info

            candidate_link_info = parse_candidate_link_score(line)
            if candidate_link_info:
                ep = pending_extrapoint_by_link_id.pop(candidate_link_info["link_id"], None)
                if ep:
                    candidate_link_info["mul"] = ep["mul"]
                    candidate_link_info["score"] = ep["score"]
                if last_dr_coordinate is not None:
                    bucket = last_dr_coordinate.extra.setdefault("candidate_link_scores", [])
                    bucket.append(candidate_link_info)
                else:
                    pending_candidate_link_scores.append(candidate_link_info)

            route_info = parse_set_route_information(line)
            if route_info:
                session_id = current_route_session_id or "unknown"
                session_index = current_route_session_index or route_session_indices.setdefault(
                    session_id,
                    len(route_session_indices) + 1,
                )
                route_session_sequence[session_id] = route_session_sequence.get(session_id, 0) + 1
                route_info["extra"]["route_session_id"] = session_id
                route_info["extra"]["route_session_index"] = session_index
                # Name route layers by the request content id (e.g. 'Route Info 10000013')
                # so each layer is directly identifiable; fall back to session index.
                request_content_id = ROUTE_SESSION_CONTENT_IDS.get(session_id)
                route_info["extra"]["request_content_id"] = request_content_id
                route_info["extra"]["route_session_name"] = (
                    f"Route Info {request_content_id}" if request_content_id else f"Route Info {session_index}"
                )
                route_info["extra"]["route_sequence"] = route_session_sequence[session_id]
                if last_tvas_header_info:
                    route_info["extra"]["tvas_header"] = dict(last_tvas_header_info)
                LINES[LineType.ROUTE_INFO].append(
                    Line(
                        id=current_id,
                        type=LineType.ROUTE_INFO,
                        start=(route_info["start_lat"], route_info["start_lon"]),
                        end=(route_info["end_lat"], route_info["end_lon"]),
                        timestamp=timestamp,
                        extra=route_info["extra"],
                    )
                )

            road_match_state = parse_road_match_state(line)
            route_match_state = parse_route_match_state(line)
            if road_match_state:
                last_road_match_state = road_match_state
            if route_match_state:
                last_route_match_state = route_match_state

            # MM feedback correction: capture the reason so the next DR coordinate
            # can be highlighted and show what triggered the correction.
            # Actual correction events (current log format):
            #   'clamped: dist=..., laneWidth=..., ratio=..., timegap=...'  -> black (lane-width feedback)
            #   'heading only: dr=..., feedback=...'                         -> gray (heading-only feedback)
            # Legacy formats still accepted: 'correction clamped ...' /
            #   'Force correction' -> black, 'correction normal' -> gray.
            # Informational lines ('timegap: ...') and 'skipped' cases must NOT
            # mark the next DR coordinate as feedback-corrected.
            mm_feedback_match = MM_FEEDBACK_PATTERN.search(line)
            if mm_feedback_match:
                reason = mm_feedback_match.group(1).strip()
                reason_lower = reason.lower()
                is_correction = (
                    reason_lower.startswith("clamp")       # clamp to lane edge / clamp to feedback pos
                    or reason_lower.startswith("heading only")
                    or "correction" in reason_lower        # legacy: correction clamped / Force correction
                )
                if is_correction and "skip" not in reason_lower:
                    pending_mm_feedback_reason = reason

            for coord_type in CoordType:
                if coord_type.pattern is None:
                    continue

                match = coord_type.pattern.search(line)
                if not match:
                    continue

                if coord_type == CoordType.GNSS1:
                    gnss_lat = float(match.group(1))
                    gnss_lon = float(match.group(2))
                    heading = float(match.group(3))
                    speed = float(match.group(4))

                    if gnss_lat == 0.0 and gnss_lon == 0.0:
                        break

                    temp_gnss1_coord = Coordinate(
                        dlt_id=dlt_id,
                        type=coord_type,
                        latitude=gnss_lat,
                        longitude=gnss_lon,
                        heading=heading,
                        extra={"Speed": speed},
                        timestamp=timestamp,
                    )
                    if current_gnss_mode:
                        temp_gnss1_coord.extra["gnss_mode"] = current_gnss_mode
                    if pending_gnss_mode_transition:
                        temp_gnss1_coord.extra["gnss_mode_transition"] = pending_gnss_mode_transition
                        temp_gnss1_coord.extra["gnss_transition_highlight"] = True
                        pending_gnss_mode_transition = None

                    # Update last GNSS coordinate for parking lot events
                    last_gnss_coordinate = {"latitude": gnss_lat, "longitude": gnss_lon}

                elif coord_type == CoordType.GNSS2:
                    latitude = float(match.group(1)) / 10000000
                    longitude = float(match.group(2)) / 10000000
                    heading = float(match.group(3))
                    speed = float(match.group(4))

                    if latitude == 0.0 and longitude == 0.0:
                        break

                    flush_pending_raw_gnss()

                    temp_gnss2_coord = Coordinate(
                        dlt_id=dlt_id,
                        type=coord_type,
                        latitude=latitude,
                        longitude=longitude,
                        heading=heading,
                        extra={"Speed": speed, "source": "gnss_line"},
                        timestamp=timestamp,
                    )

                    # Update last GNSS coordinate for parking lot events
                    last_gnss_coordinate = {"latitude": latitude, "longitude": longitude}

                elif coord_type == CoordType.DR:
                    latitude = float(match.group(1))
                    longitude = float(match.group(2))
                    speed = float(match.group(3))
                    is_dr = int(match.group(4))
                    heading = float(match.group(5))

                    if latitude == 0.0 and longitude == 0.0:
                        break

                    if temp_gnss1_coord:
                        temp_gnss1_coord.id = current_id

                        # DR correction must connect: previous DR -> current GNSS
                        if last_dr_coordinate:
                            dist = lat_lon_dist(
                                temp_gnss1_coord.latitude,
                                temp_gnss1_coord.longitude,
                                last_dr_coordinate.latitude,
                                last_dr_coordinate.longitude,
                            )
                            speed_val = temp_gnss1_coord.extra.get("Speed", 0.0)
                            correction_extra = {
                                "reason": f"dist={dist:.2f}m, speed={speed_val:.2f}",
                            }

                            LINES[LineType.DR_CORRECTION].append(
                                Line(
                                    id=current_id,
                                    type=LineType.DR_CORRECTION,
                                    start=(last_dr_coordinate.latitude, last_dr_coordinate.longitude),
                                    end=(temp_gnss1_coord.latitude, temp_gnss1_coord.longitude),
                                    timestamp=temp_gnss1_coord.timestamp,
                                    extra=correction_extra,
                                )
                            )

                        LINES[LineType.GNSS_TO_DR].append(
                            Line(
                                id=current_id,
                                type=LineType.GNSS_TO_DR,
                                start=(temp_gnss1_coord.latitude, temp_gnss1_coord.longitude),
                                end=(latitude, longitude),
                                timestamp=temp_gnss1_coord.timestamp,
                                extra={},
                            )
                        )
                        COORDINATES[CoordType.GNSS1].append(temp_gnss1_coord)
                        temp_gnss1_coord = None

                    if temp_gnss2_coord:
                        flush_pending_raw_gnss(current_id)

                    dr_coordinate = Coordinate(
                        id=current_id,
                        dlt_id=dlt_id,
                        type=coord_type,
                        latitude=latitude,
                        longitude=longitude,
                        heading=heading,
                        extra={"isDRGps": is_dr, "Speed": speed},
                        timestamp=timestamp,
                    )
                    if pending_candidate_link_scores:
                        dr_coordinate.extra["candidate_link_scores"] = pending_candidate_link_scores
                        pending_candidate_link_scores = []

                    if pending_mm_feedback_reason is not None:
                        dr_coordinate.extra["mm_feedback"] = True
                        dr_coordinate.extra["mm_feedback_reason"] = pending_mm_feedback_reason
                        pending_mm_feedback_reason = None

                    COORDINATES[coord_type].append(dr_coordinate)
                    last_dr_coordinate = dr_coordinate
                    current_id += 1

                elif coord_type == CoordType.ROAD_MATCH:
                    if "[MM_RESULT]" not in line:
                        continue
                    latitude, longitude, heading = map(float, match.groups())
                    if latitude == 0.0 and longitude == 0.0:
                        break

                    road_coordinate = Coordinate(
                        id=current_id - 1,
                        dlt_id=dlt_id,
                        type=coord_type,
                        latitude=latitude,
                        longitude=longitude,
                        heading=heading,
                        timestamp=timestamp,
                        extra={"match_state": last_road_match_state if last_road_match_state else ""},
                    )
                    COORDINATES[coord_type].append(road_coordinate)
                    last_road_match_coord = road_coordinate

                elif coord_type == CoordType.ROUTE_MATCH:
                    if "[MM_RESULT]" in line:
                        continue
                    latitude, longitude, heading = map(float, match.groups())
                    if latitude == 0.0 and longitude == 0.0:
                        break

                    route_coordinate = Coordinate(
                        id=current_id - 1,
                        dlt_id=dlt_id,
                        type=coord_type,
                        latitude=latitude,
                        longitude=longitude,
                        heading=heading,
                        timestamp=timestamp,
                        extra={"match_state": last_route_match_state if last_route_match_state else ""},
                    )
                    COORDINATES[coord_type].append(route_coordinate)
                    last_route_match_coord = route_coordinate

                elif coord_type == CoordType.VPM:
                    latitude = float(match.group(1))
                    longitude = float(match.group(2))
                    heading = float(match.group(3))
                    speed = float(match.group(4))
                    match_dist = float(match.group(5)) if match.group(5) is not None else None
                    facility_type = int(match.group(6)) if match.group(6) is not None else None

                    if latitude == 0.0 and longitude == 0.0:
                        break

                    vpm = Coordinate(
                        id=current_id - 1,
                        dlt_id=dlt_id,
                        type=coord_type,
                        latitude=latitude,
                        longitude=longitude,
                        heading=heading,
                        extra={"Speed": speed, "MatchDist": match_dist, "FacilityType": facility_type},
                        timestamp=timestamp,
                    )
                    last_vpm_coordinate = vpm
                    COORDINATES[coord_type].append(vpm)

                    if last_dr_coordinate:
                        LINES[LineType.DR_TO_VPM].append(
                            Line(
                                id=last_dr_coordinate.id,
                                type=LineType.DR_TO_VPM,
                                start=(last_dr_coordinate.latitude, last_dr_coordinate.longitude),
                                end=(latitude, longitude),
                                timestamp=timestamp if timestamp else last_dr_coordinate.timestamp,
                            )
                        )

                elif coord_type == CoordType.REQUEST:
                    # Anchor the request marker to the best-known position.
                    # Fall back to DR / raw GNSS so requests fired before the
                    # first map-matched (VPM) fix are not silently dropped.
                    request_anchor = last_vpm_coordinate or last_dr_coordinate
                    if request_anchor is not None:
                        anchor_lat = request_anchor.latitude
                        anchor_lon = request_anchor.longitude
                        anchor_heading = request_anchor.heading
                    elif last_gnss_coordinate:
                        anchor_lat = last_gnss_coordinate.get("latitude")
                        anchor_lon = last_gnss_coordinate.get("longitude")
                        anchor_heading = None
                    else:
                        anchor_lat = anchor_lon = anchor_heading = None

                    if anchor_lat is not None and anchor_lon is not None:
                        group2_value = int(match.group(2))
                        group2_enum = RouteRequestType.get_type_by_value(group2_value)
                        extra_info = {
                            "group_1": match.group(1),
                            "group_2_text": group2_enum.label,
                            # Filled in when the TVAS session id for this request arrives
                            "route_session_id": None,
                        }

                        if (
                            group2_enum == RouteRequestType.REROUTE_BREAKAWAY
                            and last_threshold_info
                            and last_road_match_coord
                            and last_route_match_coord
                        ):
                            distance_exceeded = last_threshold_info["distance"] > last_threshold_info["distance_threshold"]
                            angle_exceeded = last_threshold_info["angle_diff"] > last_threshold_info["angle_threshold"]

                            if distance_exceeded or angle_exceeded:
                                deviation_type = None
                                if distance_exceeded and angle_exceeded:
                                    deviation_type = "both"
                                elif distance_exceeded:
                                    deviation_type = "distance"
                                elif angle_exceeded:
                                    deviation_type = "angle"

                                LINES[LineType.DEVIATION].append(
                                    Line(
                                        id=current_id - 1,
                                        type=LineType.DEVIATION,
                                        start=(last_road_match_coord.latitude, last_road_match_coord.longitude),
                                        end=(last_route_match_coord.latitude, last_route_match_coord.longitude),
                                        timestamp=timestamp,
                                        distance_threshold=last_threshold_info["distance_threshold"],
                                        angle_threshold=last_threshold_info["angle_threshold"],
                                        actual_distance=last_threshold_info["distance"],
                                        actual_angle_diff=last_threshold_info["angle_diff"],
                                        local_distance=last_threshold_info["local_distance"],
                                        route_distance=last_threshold_info["route_distance"],
                                        deviation_type=deviation_type,
                                    )
                                )

                        request_coordinate = Coordinate(
                            id=current_id - 1,
                            dlt_id=dlt_id,
                            type=coord_type,
                            latitude=anchor_lat,
                            longitude=anchor_lon,
                            heading=anchor_heading,
                            extra=extra_info,
                            timestamp=timestamp,
                        )
                        COORDINATES[coord_type].append(request_coordinate)
                        pending_route_request_coords.append(request_coordinate)
                        # Start a provisional per-request session so subsequent
                        # setRouteInformation dumps group under THIS request even
                        # when the TVAS session-id line is absent from the log.
                        # A real session id (if logged) overrides this via backfill.
                        current_route_session_id = f"REQ_{extra_info['group_1']}"
                        current_route_session_index = 0
                        request_coordinate.extra["route_session_id"] = current_route_session_id
                        ROUTE_SESSION_CONTENT_IDS[current_route_session_id] = extra_info["group_1"]

                # Do not stop at first match. One physical line can contain
                # multiple embedded DLT records in this log format.
                continue

    flush_pending_raw_gnss()
    normalize_sequential_ids()
    fill_missing_timestamps()
    sanitize_outlier_timestamps()
    recompute_timestamp_range_from_coords()
    return True


def iterate_log_records(source_path):
    """
    Yield normalized records as:
      (dlt_id, message_text, reception_timestamp_or_none)
    For .dlt, parse storage header timestamp directly from binary records.
    For text files (or fallback), emit line-based records.
    """
    parsed_binary = False
    if source_path.lower().endswith(".dlt"):
        for dlt_id, message_text, reception_ts in iterate_dlt_storage_records(source_path):
            parsed_binary = True
            yield dlt_id, message_text, reception_ts
        if parsed_binary:
            return

    with open(source_path, "r", encoding="utf-8", errors="replace") as file:
        for line_number, line in enumerate(file, start=1):
            yield line_number, line, None


def iterate_dlt_storage_records(source_path):
    marker = b"DLT\x01"
    with open(source_path, "rb") as file:
        data = file.read()

    if not data:
        return

    data_len = len(data)
    record_id = 0
    starts = [m.start() for m in re.finditer(re.escape(marker), data)]
    if not starts:
        return

    for idx, start in enumerate(starts):
        end = starts[idx + 1] if idx + 1 < len(starts) else data_len
        if end - start < 16:
            continue

        # Storage header: "DLT\x01" + seconds(4 LE) + microseconds(4 LE) + ecu(4)
        seconds = int.from_bytes(data[start + 4:start + 8], byteorder="little", signed=False)
        microseconds = int.from_bytes(data[start + 8:start + 12], byteorder="little", signed=False)
        try:
            reception_timestamp = datetime.fromtimestamp(seconds + (microseconds / 1_000_000.0))
        except (OSError, OverflowError, ValueError):
            reception_timestamp = None

        record_id += 1
        if not is_relevant_dlt_record_slice(data, start, end):
            continue

        record = data[start:end]
        message_text = record.decode("utf-8", errors="replace")
        yield record_id, message_text, reception_timestamp


def is_relevant_dlt_record_slice(data_bytes, start, end):
    for keyword in DLT_RELEVANT_BYTE_KEYWORDS:
        if data_bytes.find(keyword, start, end) != -1:
            return True

    # VPM payload line format: "[MM] <lat>, <lon>, ..."
    # Exclude verbose MM diagnostic lines like "[[MM] : 4] ..."
    mm_pos = data_bytes.find(b"[MM] ", start, end)
    if mm_pos < 0:
        return False

    value_pos = mm_pos + len(b"[MM] ")
    if value_pos >= end:
        return False

    first_char = data_bytes[value_pos:value_pos + 1]
    return first_char in b"-0123456789"


def is_relevant_dlt_record(record_bytes):
    # Backward-compatible helper for ad-hoc callers.
    if any(keyword in record_bytes for keyword in DLT_RELEVANT_BYTE_KEYWORDS):
        return True

    # VPM payload line format: "[MM] <lat>, <lon>, ..."
    # Exclude verbose MM diagnostic lines like "[[MM] : 4] ..."
    mm_pos = record_bytes.find(b"[MM] ")
    if mm_pos < 0:
        return False

    value_pos = mm_pos + len(b"[MM] ")
    if value_pos >= len(record_bytes):
        return False

    first_char = record_bytes[value_pos:value_pos + 1]
    return first_char in b"-0123456789"


def update_timestamp_range(timestamp):
    global min_timestamp, max_timestamp
    if timestamp:
        if timestamp < min_timestamp:
            min_timestamp = timestamp
        if timestamp > max_timestamp:
            max_timestamp = timestamp


def parse_datetime(line, last_timestamp=None):
    def is_plausible(candidate):
        if candidate is None:
            return False

        # Reject obvious outliers (e.g. random 14-digit payload interpreted as datetime).
        if log_base_timestamp:
            if abs((candidate.date() - log_base_timestamp.date()).days) > 7:
                return False

        if last_timestamp:
            # Avoid large backward/forward jumps caused by malformed extraction.
            if candidate < (last_timestamp - timedelta(hours=12)):
                return False
            if candidate > (last_timestamp + timedelta(days=2)):
                return False
        return True

    # 1) Full datetime in line: yyyy-MM-dd HH:mm:ss(.SSS...)
    full_dt_match = re.search(
        r"\b(20\d{2}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)\b",
        line,
    )
    if full_dt_match:
        for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
            try:
                candidate = datetime.strptime(f"{full_dt_match.group(1)} {full_dt_match.group(2)}", fmt)
                if is_plausible(candidate):
                    return candidate
            except ValueError:
                pass

    # 2) Compact datetime in trusted context: yyyyMMddHHmmss, <epoch-ms>
    # This avoids matching unrelated 14-digit payload values.
    compact_dt_match = re.search(
        r"\b(20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:[01]\d|2[0-3])[0-5]\d[0-5]\d)\b\s*,\s*\d{13}\b",
        line,
    )
    if compact_dt_match:
        try:
            candidate = datetime.strptime(compact_dt_match.group(1), "%Y%m%d%H%M%S")
            if is_plausible(candidate):
                return candidate
        except ValueError:
            pass

    time_only_patterns = [r"\b\d{2}:\d{2}:\d{2}\.\d{1,6}\b", r"\b\d{2}:\d{2}:\d{2}\b"]
    time_formats = ["%H:%M:%S.%f", "%H:%M:%S"]

    if last_timestamp:
        for pattern in time_only_patterns:
            match = re.search(pattern, line)
            if not match:
                continue
            t_str = match.group()
            for fmt in time_formats:
                try:
                    parsed_time = datetime.strptime(t_str, fmt).time()
                    candidate = last_timestamp.replace(
                        hour=parsed_time.hour,
                        minute=parsed_time.minute,
                        second=parsed_time.second,
                        microsecond=parsed_time.microsecond,
                    )
                    if candidate < last_timestamp:
                        # Time-only logs frequently arrive out-of-order across threads.
                        # Never roll date from time-only pattern; keep monotonic timestamp.
                        candidate = last_timestamp
                    return candidate
                except ValueError:
                    pass

    return None


def infer_initial_timestamp(log_file_path):
    filename = os.path.basename(log_file_path)
    # Prefer yyyyMMdd_HHmmss / yyyyMMddHHmmss in filename when available.
    m = re.search(r"(20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))[_-]?([01]\d[0-5]\d[0-5]\d)", filename)
    if m:
        try:
            return datetime.strptime(f"{m.group(1)}{m.group(2)}", "%Y%m%d%H%M%S")
        except ValueError:
            pass

    # Fallback: yyyyMMdd (midnight)
    m = re.search(r"(20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))", filename)
    if m:
        try:
            return datetime.strptime(m.group(1), "%Y%m%d")
        except ValueError:
            pass

    # Legacy fallback: yymmdd
    m = re.search(r"(\d{6})", filename)
    if not m:
        return None

    yymmdd = m.group(1)
    try:
        year = 2000 + int(yymmdd[0:2])
        month = int(yymmdd[2:4])
        day = int(yymmdd[4:6])
        return datetime(year, month, day, 0, 0, 0, 0)
    except ValueError:
        return None


def normalize_sequential_ids():
    all_coords = [coord for coords in COORDINATES.values() for coord in coords]
    all_lines = [line for lines in LINES.values() for line in lines]

    # One positioning cycle (Filtered GNSS -> DR -> Road Match -> Route Match
    # -> VPM -> Request) shares a single parse-time id. Renumber per cycle
    # GROUP so every layer keeps the SAME index for the same cycle — cross-
    # layer debugging (e.g. comparing DR #250 with Road Match #250) relies on
    # this alignment. Per-type 1..N renumbering would drift immediately once
    # any layer skips a cycle (e.g. Road Match while unmatched).
    groups = {}
    for coord in all_coords:
        groups.setdefault(coord.id, []).append(coord)

    def group_order_key(item):
        group_coords = item[1]
        dlt_ids = [c.dlt_id for c in group_coords if c.dlt_id is not None]
        timestamps = [c.timestamp for c in group_coords if c.timestamp is not None]
        return (
            len(dlt_ids) == 0,
            min(dlt_ids) if dlt_ids else 10**15,
            min(timestamps) if timestamps else datetime.min,
        )

    for new_id, (_, group_coords) in enumerate(sorted(groups.items(), key=group_order_key), start=1):
        for coord in group_coords:
            coord.id = new_id

    # Lines stay individually numbered: route-info selection highlighting
    # relies on unique line ids (one cycle can dump hundreds of route lines).
    all_lines.sort(key=lambda line: (line.timestamp if line.timestamp else datetime.min))
    for index, line in enumerate(all_lines, start=1):
        line.id = index


def fill_missing_timestamps():
    global log_base_timestamp
    all_coords = [coord for coords in COORDINATES.values() for coord in coords]
    if not all_coords:
        return

    all_coords.sort(key=lambda coord: coord.id if coord.id is not None else 0)
    known_times = [coord.timestamp for coord in all_coords if coord.timestamp is not None]
    if not known_times:
        base = (log_base_timestamp or datetime(1970, 1, 1)).replace(microsecond=0)
        for offset, coord in enumerate(all_coords):
            coord.timestamp = base + timedelta(milliseconds=offset)
        return

    first_known = known_times[0]
    last_seen = None
    for coord in all_coords:
        if coord.timestamp is None:
            if last_seen is None:
                coord.timestamp = first_known
            else:
                coord.timestamp = last_seen + timedelta(milliseconds=1)
        last_seen = coord.timestamp


def sanitize_outlier_timestamps(max_deviation=timedelta(days=1)):
    """Repair corrupt record timestamps (e.g. zeroed DLT storage headers that
    decode to 1970). A single outlier would otherwise stretch the timeline
    slider across decades, making the actual log span an unusable sliver.
    Timestamps deviating more than max_deviation from the median are treated
    as missing and re-filled from their neighbors."""
    known = [c.timestamp for coords in COORDINATES.values() for c in coords if c.timestamp is not None]
    if len(known) < 3:
        return

    known.sort()
    median = known[len(known) // 2]

    changed = False
    for coords in COORDINATES.values():
        for coord in coords:
            if coord.timestamp is not None and abs(coord.timestamp - median) > max_deviation:
                coord.timestamp = None
                changed = True

    if changed:
        fill_missing_timestamps()


def recompute_timestamp_range_from_coords():
    global min_timestamp, max_timestamp
    all_coords = [coord for coords in COORDINATES.values() for coord in coords if coord.timestamp is not None]
    if not all_coords:
        min_timestamp = datetime.max
        max_timestamp = datetime.min
        return

    min_timestamp = min(coord.timestamp for coord in all_coords)
    max_timestamp = max(coord.timestamp for coord in all_coords)


def parse_road_match_state(line):
    road_match_state = re.search(r"\[MM_RESULT\] State = (\w+)", line)
    if road_match_state:
        return road_match_state.group(1)
    return None


def parse_route_match_state(line):
    route_match_state = re.search(r"navisdk :: \[\[MM\] : 4\] State = (\w+)", line)
    if route_match_state:
        return route_match_state.group(1)
    return None


def parse_threshold_info(line):
    threshold_match = re.search(
        r"shouldStayRoute distance:([\d\.]+), distanceThreshold:([\d\.]+), angleDiff:([\d\.]+), angleThreshold:([\d\.]+), localDistance:([\d\.]+), routeDistance:([\d\.]+)",
        line,
    )
    if threshold_match:
        return {
            "distance": float(threshold_match.group(1)),
            "distance_threshold": float(threshold_match.group(2)),
            "angle_diff": float(threshold_match.group(3)),
            "angle_threshold": float(threshold_match.group(4)),
            "local_distance": float(threshold_match.group(5)),
            "route_distance": float(threshold_match.group(6)),
        }
    return None


def parse_set_route_information(line):
    match = SET_ROUTE_INFORMATION_PATTERN.search(line)
    if not match:
        return None

    link_id_raw = int(match.group(1))
    link_id = int(match.group(2))
    direction = int(match.group(3))
    link_type = int(match.group(4))
    optional_link_str_code = match.group(5)
    optional_road_length = match.group(6)
    vertex_size = int(match.group(7))
    start_lat = int(match.group(8)) / 10000000.0
    start_lon = int(match.group(9)) / 10000000.0
    end_lat = int(match.group(10)) / 10000000.0
    end_lon = int(match.group(11)) / 10000000.0

    extra = {
        "source": "setRouteInformation",
        "link_id": link_id,
        "link_id_raw": link_id_raw,
        "dir": direction,
        "link_type": link_type,
        "vertex_size": vertex_size,
    }
    if optional_link_str_code is not None:
        extra["link_str_code"] = int(optional_link_str_code)
    if optional_road_length is not None:
        extra["road_length"] = int(optional_road_length)

    return {
        "start_lat": start_lat,
        "start_lon": start_lon,
        "end_lat": end_lat,
        "end_lon": end_lon,
        "extra": extra,
    }


def parse_sdi_event(line, timestamp):
    """Parse SDI (Safety Drive Information) events from navisdk logs.

    GetSdiSelected select (0): 0, 15 nDist: 300, 500, wptPos: 37.545592, 126.978641
    onDriveStatusChanged SDI[15] Speed : 50 pt(126.978641,37.545592)
    """
    global SDI_EVENTS

    # Try onDriveStatusChanged pattern first (has both type and speed)
    drive_match = SDI_DRIVE_STATUS_PATTERN.search(line)
    if drive_match:
        sdi_type = int(drive_match.group(1))
        speed = int(drive_match.group(2))
        # Note: onDriveStatusChanged has lon,lat order
        longitude = float(drive_match.group(3))
        latitude = float(drive_match.group(4))

        if not (30.0 < latitude < 45.0 and 120.0 < longitude < 135.0):
            return False

        SDI_EVENTS.append({
            "type": "SDI",
            "sdi_type": sdi_type,
            "speed": speed,
            "latitude": latitude,
            "longitude": longitude,
            "source": "onDriveStatusChanged",
            "timestamp": timestamp,
        })
        return True

    # Try GetSdiSelected pattern (has position info)
    select_match = SDI_SELECTED_PATTERN.search(line)
    if select_match:
        current_type = int(select_match.group(2))
        candidate_type = int(select_match.group(3))
        # GetSdiSelected has lat,lon order
        latitude = float(select_match.group(6))
        longitude = float(select_match.group(7))

        if not (30.0 < latitude < 45.0 and 120.0 < longitude < 135.0):
            return False

        SDI_EVENTS.append({
            "type": "SDI",
            "sdi_type": current_type,
            "candidate_type": candidate_type,
            "latitude": latitude,
            "longitude": longitude,
            "source": "GetSdiSelected",
            "timestamp": timestamp,
        })
        return True

    return False


def parse_parking_lot_event(line, timestamp):
    """Parse ParkingLot detector events from navisdk logs.

    ApplyParkingLotDetector: state=3, candidateCount=2, bestLinkId=51075
    ParkingLotDetector transition: Idle -> EnterCandidate, reason=...
    """
    global PARKING_LOT_EVENTS, last_gnss_coordinate

    # Try ApplyParkingLotDetector pattern first (most frequent)
    apply_match = PARKING_LOT_APPLY_PATTERN.search(line)
    if apply_match:
        state_code = int(apply_match.group(1))
        candidate_count = int(apply_match.group(2))
        best_link_id = int(apply_match.group(3))

        # Only track main parking states: 1=EnterCandidate, 2=EnterReady, 3=ParkingLot
        if state_code not in (1, 2, 3):
            return False

        # Use last known GNSS coordinate if available
        if last_gnss_coordinate is None:
            return False

        latitude = last_gnss_coordinate.get('latitude')
        longitude = last_gnss_coordinate.get('longitude')

        if not (30.0 < latitude < 45.0 and 120.0 < longitude < 135.0):
            return False

        state_names = {1: "EnterCandidate", 2: "EnterReady", 3: "ParkingLot"}
        state_name = state_names.get(state_code, f"State({state_code})")

        PARKING_LOT_EVENTS.append({
            "type": "ParkingLot Apply",
            "state": state_name,
            "state_code": state_code,
            "candidate_count": candidate_count,
            "best_link_id": best_link_id,
            "latitude": latitude,
            "longitude": longitude,
            "timestamp": timestamp,
        })
        return True

    # Try state transition pattern (fallback)
    change_match = PARKING_LOT_STATE_CHANGE_PATTERN.search(line)
    if change_match:
        prev_state = change_match.group(1)
        next_state = change_match.group(2)
        reason = change_match.group(3)

        # Use last known GNSS coordinate if available
        if last_gnss_coordinate is None:
            return False

        latitude = last_gnss_coordinate.get('latitude')
        longitude = last_gnss_coordinate.get('longitude')

        if not (30.0 < latitude < 45.0 and 120.0 < longitude < 135.0):
            return False

        PARKING_LOT_EVENTS.append({
            "type": "ParkingLot Transition",
            "prev_state": prev_state,
            "next_state": next_state,
            "reason": reason,
            "latitude": latitude,
            "longitude": longitude,
            "timestamp": timestamp,
        })
        return True

    return False


def parse_lane_ext(line, timestamp):
    """[LANE_EXT] 로그에서 링크별 확장 차선수(lane -> ext)를 수집한다.

    navisdk :: [[MM] : 4] [LANE_EXT] link[16446] lane:2 -> ext:3, dist:29.1, fB:0.353

    같은 링크가 반복 출력되므로 링크당 1건으로 합치고, 관측 횟수와
    최초/마지막 시각만 누적한다(마지막 값이 최종 상태).
    """
    global LANE_EXT_LINKS

    match = LANE_EXT_PATTERN.search(line)
    if not match:
        return False

    link_id = match.group(1)
    lane = int(match.group(2))
    ext = int(match.group(3))
    dist = float(match.group(4)) if match.group(4) is not None else None
    feedback = float(match.group(5)) if match.group(5) is not None else None
    ts_ms = int(timestamp.timestamp() * 1000) if timestamp else 0

    entry = LANE_EXT_LINKS.get(link_id)
    if entry is None:
        entry = {
            "link_id": link_id,
            "lane": lane,
            "ext": ext,
            "dist": dist,
            "feedback": feedback,
            "count": 0,
            "first_timestamp_ms": ts_ms,
            "last_timestamp_ms": ts_ms,
        }
        LANE_EXT_LINKS[link_id] = entry

    entry["lane"] = lane
    entry["ext"] = ext
    if dist is not None:
        entry["dist"] = dist
    if feedback is not None:
        entry["feedback"] = feedback
    entry["count"] += 1
    entry["last_timestamp_ms"] = ts_ms
    return True


def parse_guide_event(line, timestamp):
    """Parse C2X events and TMAP incident (MFS) events with actual coordinates.

    C2X:  MapObjectProvider createCar2XEvent nEventID : 110, ... coord : 37.544675,126.976875, ...
    MFS:  MapObjectProvider processContents type:1 ... key:MFS_XXX ... coord:37.XX,126.XX ... name:교통사고
    """
    global GUIDE_EVENTS

    c2x_match = CAR2X_CREATE_PATTERN.search(line)
    if c2x_match:
        latitude = float(c2x_match.group(3))
        longitude = float(c2x_match.group(4))
        if not (30.0 < latitude < 45.0 and 120.0 < longitude < 135.0):
            return False

        GUIDE_EVENTS.append({
            "type": "C2X",
            "event_id": int(c2x_match.group(1)),
            "event_type_code": int(c2x_match.group(2)),
            "latitude": latitude,
            "longitude": longitude,
            "event_time": c2x_match.group(5) or "",
            "name": "",
            "timestamp": timestamp,
        })
        return True

    mfs_match = MFS_CONTENT_PATTERN.search(line)
    if mfs_match:
        key = mfs_match.group(3).strip()
        # 유고정보(MFS_*)만 수집 — 충전소 등 다른 processContents 로그 제외
        if not key.startswith("MFS"):
            return False

        latitude = float(mfs_match.group(6))
        longitude = float(mfs_match.group(7))
        if not (30.0 < latitude < 45.0 and 120.0 < longitude < 135.0):
            return False

        GUIDE_EVENTS.append({
            "type": "MFS",
            "event_id": key,
            "event_type_code": int(mfs_match.group(1)),
            "state": int(mfs_match.group(2)),
            "visible": int(mfs_match.group(4)),
            "latitude": latitude,
            "longitude": longitude,
            "event_time": "",
            "name": mfs_match.group(8).strip(),
            "timestamp": timestamp,
        })
        return True

    return False


def parse_gp_guide_event(line, timestamp):
    """Collect GP (guide point) / turnCode information from navisdk logs.

    Three independent sources are merged later in build_gp_guide_markers():
      * ServiceDataCollect bursts  -> one record per route link (map link id
        included, so the GP can be placed with the Route Info link geometry)
      * [LANE_COLOR] store GP      -> GP index / link index of the GPs that were
        actually created out of those links
      * GetRenderData pGuidePoint  -> the TVAS GP table as the renderer sees it
        (gpType/turnCode per GP, positioned by route vertex index)
    """
    global gp_pending

    # --- route build time: cross image data read for the current link ---------
    match = GP_CROSS_IMAGE_DATA_PATTERN.search(line)
    if match:
        gp_pending["snd_code"] = int(match.group(1))
        gp_pending["voice_code"] = int(match.group(2))
        gp_pending["cross_img_code"] = int(match.group(3))
        gp_pending["cross_img_available"] = int(match.group(4))
        return True

    match = GP_CROSS_IMAGE_RAW_PATTERN.search(line)
    if match:
        gp_pending["cross_image_raw"] = int(match.group(1))
        gp_pending["turn_code"] = int(match.group(2))
        gp_pending["link_id"] = int(match.group(3))
        return True

    match = GP_CROSS_IMAGE_FILTERED_PATTERN.search(line)
    if match:
        # '#2' is after the straight-ahead filter, so this is the bCrossImage
        # value GetGuidePointType() actually sees.
        gp_pending["cross_image"] = int(match.group(1))
        gp_pending["turn_code"] = int(match.group(2))
        gp_pending["voice_code"] = int(match.group(3))
        return True

    match = GP_TYPE_PATTERN.search(line)
    if match:
        # Logged once per route link — this line closes the burst for one link.
        gp_type = int(match.group(1))
        entry = dict(gp_pending)
        gp_pending = {}
        entry.update({
            "gp_type": gp_type,
            "turn_code": int(match.group(2)),
            "link_id": int(match.group(3)),
            "gp_type_flags": decode_gp_type_flags(gp_type),
            "route_session_id": current_route_session_id or "unknown",
            "route_session_index": current_route_session_index or 0,
            "timestamp": timestamp,
        })
        GP_ENTRIES.append(entry)
        return True

    match = GP_STORE_PATTERN.search(line)
    if match:
        # Fires right after the ServiceDataCollect burst of the same link.
        gp_type = int(match.group(5), 16)
        stored = {
            "gp_index": int(match.group(1)),
            "link_index": int(match.group(2)),
            "voice_code": int(match.group(3)),
            "turn_code": int(match.group(4)),
            "gp_type": gp_type,
            "gp_type_flags": decode_gp_type_flags(gp_type),
        }
        if GP_ENTRIES and GP_ENTRIES[-1].get("gp_index") is None:
            GP_ENTRIES[-1].update(stored)
        else:
            stored.update({
                "route_session_id": current_route_session_id or "unknown",
                "route_session_index": current_route_session_index or 0,
                "timestamp": timestamp,
            })
            GP_ENTRIES.append(stored)
        return True

    # --- route render time: the TVAS GP table as the renderer walks it -------
    match = GP_RENDER_DATA_PATTERN.search(line)
    if match:
        gp_type = int(match.group(2))
        GP_RENDER_POINTS.append({
            "gp_index": int(match.group(1)),
            "gp_type": gp_type,
            "gp_type_flags": decode_gp_type_flags(gp_type),
            "turn_code": int(match.group(3)),
            "vertex_end": int(match.group(4)),
            "route_session_id": current_route_session_id or "unknown",
            "route_session_index": current_route_session_index or 0,
            "timestamp": timestamp,
        })
        return True

    match = ROUTE_MATCH_LINK_PATTERN.search(line)
    if match:
        ROUTE_MATCH_LINKS.append({
            "link_index": int(match.group(1)),
            "vertex_index": int(match.group(2)),
            "timestamp": timestamp,
        })
        return True

    # --- drive time: which lane bubble colour is active on the current link --
    match = GP_LANE_COLOR_PATTERN.search(line)
    if match:
        GP_LANE_EVENTS.append({
            "link_index": int(match.group(1)),
            "gp_index": int(match.group(2)),
            "gp_link_index": int(match.group(3)),
            "voice_code": int(match.group(4)),
            "lane_color": int(match.group(5)),
            "turn_code": int(match.group(6)),
            "route_session_id": current_route_session_id or "unknown",
            "timestamp": timestamp,
        })
        return True

    return False


def parse_tvas_header_info(line, previous_info=None):
    info = dict(previous_info or {})
    matched = False

    match = TVAS_HEADER_ROUTE_OPT_PATTERN.search(line)
    if match:
        info["route_opt_code"] = int(match.group(1))
        matched = True

    match = TVAS_HEADER_SERVICE_CNT_PATTERN.search(line)
    if match:
        info["service_cnt"] = int(match.group(1))
        matched = True

    match = TVAS_HEADER_TOTAL_TIME_PATTERN.search(line)
    if match:
        info["total_time"] = int(match.group(1))
        matched = True

    match = TVAS_HEADER_TOTAL_DIST_PATTERN.search(line)
    if match:
        info["total_dist"] = int(match.group(1))
        matched = True

    if matched:
        return info


def parse_route_session_info(line):
    match = TVAS_SERVER_SESSION_PATTERN.search(line)
    if not match:
        return None

    return {
        "session_id": match.group(1).strip(),
        "error_code": match.group(2).strip(),
    }


def parse_route_request_points(line):
    """Collect per-request depart/waypoint/destination points (SK coordinates)."""
    match = ROUTE_REQ_WAYPOINT_PATTERN.search(line)
    if match:
        entry = ROUTE_REQUEST_POINTS.setdefault(match.group(1), {"waypoints": {}})
        entry.setdefault("waypoints", {})[int(match.group(2))] = {
            "name": match.group(4).strip(),
            "sk_x": int(match.group(5)),
            "sk_y": int(match.group(6)),
        }
        return True

    match = ROUTE_REQ_DEPART_PATTERN.search(line)
    if match:
        entry = ROUTE_REQUEST_POINTS.setdefault(match.group(1), {"waypoints": {}})
        entry["depart"] = {
            "name": match.group(2).strip(),
            "sk_x": int(match.group(3)),
            "sk_y": int(match.group(4)),
        }
        return True

    match = ROUTE_REQ_DEST_PATTERN.search(line)
    if match:
        entry = ROUTE_REQUEST_POINTS.setdefault(match.group(1), {"waypoints": {}})
        entry["dest"] = {
            "name": match.group(2).strip(),
            "sk_x": int(match.group(3)),
            "sk_y": int(match.group(4)),
        }
        return True

    return False


def attach_route_points_to_requests(coords):
    """Attach ordered [출발지, 경유지..., 목적지] set to each Request coordinate."""
    if not ROUTE_REQUEST_POINTS:
        return

    for coord in coords:
        if coord.get('type') != 'Request':
            continue

        content_id = str(coord.get('extra', {}).get('group_1') or '')
        points = ROUTE_REQUEST_POINTS.get(content_id)
        if not points:
            continue

        ordered = []
        if points.get('depart'):
            ordered.append({"role": "출발지", **points['depart']})
        for idx in sorted(points.get('waypoints', {})):
            ordered.append({"role": "경유지", "waypoint_index": idx, **points['waypoints'][idx]})
        if points.get('dest'):
            ordered.append({"role": "목적지", **points['dest']})

        if ordered:
            coord['extra']['route_points'] = ordered


def parse_gnss_mode_info(line):
    event_match = GNSS_MODE_EVENT_PATTERN.search(line)
    if event_match:
        event_name = event_match.group(1).strip()
        from_mode = event_match.group(2).strip()
        to_mode = event_match.group(3).strip()
        return {
            "mode": to_mode,
            "transition": {
                "event": event_name,
                "from": from_mode,
                "to": to_mode,
            },
        }

    inline_match = GNSS_MODE_INLINE_PATTERN.search(line)
    if inline_match:
        return {
            "mode": inline_match.group(1).strip(),
        }

    return None


def parse_candidate_link_score(line):
    match = CANDIDATE_LINK_PATTERN.search(line or "")
    if not match:
        return None

    return {
        "link_id": int(match.group(1)),
        "score": float(match.group(2)),
        "base": float(match.group(3)),
        "distancePenalty": float(match.group(4)),
        "anglePenalty": float(match.group(5)),
        "laneBonus": float(match.group(6)),
        "adjustment": float(match.group(7)),
        "distanceProjection": float(match.group(8)),  # p: distancePenalty
        "distanceScore": float(match.group(9)),        # d: 실제 투영거리(m)
        "laneWeight": float(match.group(10)),
        "facilityBonus": float(match.group(11)),
        "gyroAngle": float(match.group(12)),
        "vehicleAngle": float(match.group(13)),
        "lane": int(match.group(14)),
    }
    return previous_info


def parse_link_extrapoint(line):
    match = LINK_EXTRAPOINT_PATTERN.search(line or "")
    if not match:
        return None
    return {
        "link_id": int(match.group(1)),
        "base": float(match.group(2)),
        "mul": float(match.group(3)),
        "score": float(match.group(4)),
    }


def write_data_to_csv(out_path=None):
    out_path = out_path or PATHS.output_csv
    header = ["type", "index", "dlt_id", "latitude", "longitude", "heading", "is_dr", "timestamp"]

    with open(out_path, "w", newline="", encoding="utf-8") as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(header)

        for coord_type, coords in COORDINATES.items():
            for coord in coords:
                writer.writerow(
                    [
                        coord_type.type,
                        coord.id,
                        coord.dlt_id,
                        coord.latitude,
                        coord.longitude,
                        coord.heading if coord.heading is not None else "",
                        coord.extra.get("isDRGps", ""),
                        coord.timestamp.strftime("%Y/%m/%d %H:%M:%S.%f") if coord.timestamp else "",
                    ]
                )


def build_sdi_markers():
    """Convert SDI_EVENTS to marker format."""
    if not SDI_EVENTS:
        return []

    markers = []
    event_id_counter = 20000  # Start from 20000 to avoid conflicts
    seen = set()

    # SDI type names
    SDI_TYPE_NAMES = {
        0: "신호위반 단속",
        1: "구간단속 시작",
        2: "과속방지턱",
        3: "버스전용차로",
        15: "고정식 카메라",
    }

    for event in SDI_EVENTS:
        # Dedupe by type/position
        dedupe_key = (event["sdi_type"], event["latitude"], event["longitude"])
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        sdi_type = event["sdi_type"]
        type_name = SDI_TYPE_NAMES.get(sdi_type, f"SDI Type {sdi_type}")

        marker = {
            "id": event_id_counter,
            "dlt_id": None,
            "type": "SDI Event",
            "latitude": event["latitude"],
            "longitude": event["longitude"],
            "heading": None,
            "extra": {
                "event_type": "SDI",
                "sdi_type": sdi_type,
                "sdi_type_name": type_name,
                "speed": event.get("speed"),
                "source": event.get("source", ""),
                "sdi_event": True,
            },
            "timestamp_ms": int(event["timestamp"].timestamp() * 1000) if event["timestamp"] else 0,
            "timestamp_str": event["timestamp"].strftime("%Y/%m/%d %H:%M:%S.%f")[:-3] if event["timestamp"] else "",
            "color": "#f39c12",  # Orange for SDI
            "fill": True,
        }
        markers.append(marker)
        event_id_counter += 1

    return markers


def build_parking_lot_markers():
    """Convert PARKING_LOT_EVENTS to marker format."""
    if not PARKING_LOT_EVENTS:
        return []

    markers = []
    event_id_counter = 30000  # Start from 30000 to avoid conflicts
    seen = set()

    # State transition colors and labels
    TRANSITION_CONFIG = {
        ("Idle", "EnterCandidate"): {"label": "주차장 후보 진입", "color": "#f59e0b", "icon": "🟡"},
        ("EnterCandidate", "EnterReady"): {"label": "주차장 진입 준비", "color": "#f97316", "icon": "🟠"},
        ("EnterReady", "ParkingLot"): {"label": "주차장 진입 완료", "color": "#ef4444", "icon": "🔴"},
        ("ParkingLot", "ExitReady"): {"label": "주차장 탈출 준비", "color": "#8b5cf6", "icon": "🟣"},
        ("ExitReady", "Idle"): {"label": "주차장 탈출 완료", "color": "#06b6d4", "icon": "🔵"},
    }

    # Apply state colors - based on current state
    APPLY_CONFIG = {
        "EnterCandidate": {"color": "#f59e0b", "icon": "🟡", "label": "주차장 후보", "dashed": True},
        "EnterReady": {"color": "#f97316", "icon": "🟠", "label": "주차장 진입 준비", "dashed": True},
        "ParkingLot": {"color": "#000000", "icon": "🔴", "label": "주차장 중", "dashed": False},
    }

    for event in PARKING_LOT_EVENTS:
        event_type = event.get("type", "")

        if event_type == "ParkingLot Apply":
            # ApplyParkingLotDetector events
            state = event.get("state", "Unknown")
            config = APPLY_CONFIG.get(state, {"color": "#6b7280", "icon": "⚪", "label": state, "dashed": False})

            marker = {
                "id": event_id_counter,
                "dlt_id": None,
                "type": "Parking Lot State",
                "latitude": event["latitude"],
                "longitude": event["longitude"],
                "heading": None,
                "extra": {
                    "event_type": "ParkingLot",
                    "state": state,
                    "state_label": config["label"],
                    "candidate_count": event.get("candidate_count", 0),
                    "best_link_id": event.get("best_link_id", -1),
                    "icon": config["icon"],
                    "dashed": config.get("dashed", False),
                },
                "timestamp_ms": int(event["timestamp"].timestamp() * 1000) if event["timestamp"] else 0,
                "timestamp_str": event["timestamp"].strftime("%Y/%m/%d %H:%M:%S.%f")[:-3] if event["timestamp"] else "",
                "color": config["color"],
                "fill": True,
            }
        else:
            # State transition events
            prev_state = event.get("prev_state", "")
            next_state = event.get("next_state", "")
            state_key = (prev_state, next_state)

            config = TRANSITION_CONFIG.get(state_key, {
                "label": f"{prev_state} → {next_state}",
                "color": "#6b7280",
                "icon": "⚪"
            })

            marker = {
                "id": event_id_counter,
                "dlt_id": None,
                "type": "Parking Lot State",
                "latitude": event["latitude"],
                "longitude": event["longitude"],
                "heading": None,
                "extra": {
                    "event_type": "ParkingLot",
                    "prev_state": prev_state,
                    "next_state": next_state,
                    "state_label": config["label"],
                    "reason": event.get("reason", ""),
                    "icon": config["icon"],
                },
                "timestamp_ms": int(event["timestamp"].timestamp() * 1000) if event["timestamp"] else 0,
                "timestamp_str": event["timestamp"].strftime("%Y/%m/%d %H:%M:%S.%f")[:-3] if event["timestamp"] else "",
                "color": config["color"],
                "fill": True,
            }

        markers.append(marker)
        event_id_counter += 1

    return markers


def build_guide_event_markers():
    """Convert GUIDE_EVENTS to marker format. Coordinates come directly from the log."""
    if not GUIDE_EVENTS:
        return []

    markers = []
    event_id_counter = 10000  # Start from 10000 to avoid conflicts with coordinate IDs
    seen = set()

    for event in GUIDE_EVENTS:
        # Same event can be logged repeatedly — dedupe by source/id/position
        dedupe_key = (event["type"], event["event_id"], event["latitude"], event["longitude"])
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        marker = {
            "id": event_id_counter,
            "dlt_id": None,
            "type": "Guide Event",
            "latitude": event["latitude"],
            "longitude": event["longitude"],
            "heading": None,
            "extra": {
                "event_type": event["type"],  # "C2X" or "MFS"
                "event_id": event["event_id"],
                "event_type_code": event.get("event_type_code"),
                "event_time": event.get("event_time", ""),
                "name": event.get("name", ""),
                "guide_event": True,
            },
            "timestamp_ms": int(event["timestamp"].timestamp() * 1000) if event["timestamp"] else 0,
            "timestamp_str": event["timestamp"].strftime("%Y/%m/%d %H:%M:%S.%f")[:-3] if event["timestamp"] else "",
            "color": "#3498db" if event["type"] == "C2X" else "#e74c3c",
            "fill": True,
        }
        markers.append(marker)
        event_id_counter += 1

    return markers


def _route_links_by_session(lines):
    """Group 'Route Info' lines per route session, ordered by log order."""
    sessions = {}
    for line in lines or []:
        if line.get("type") != "Route Info":
            continue
        extra = line.get("extra") or {}
        session_id = extra.get("route_session_id") or "unknown"
        sessions.setdefault(session_id, []).append(line)
    for session_lines in sessions.values():
        session_lines.sort(key=lambda item: (item.get("extra") or {}).get("route_sequence") or 0)
    return sessions


def _drive_positions(coords):
    """Timestamp-sorted vehicle positions used to place drive-time GP events."""
    preferred = [
        coord for coord in coords or []
        if coord.get("type") == "DR-based" and coord.get("timestamp_ms")
    ]
    if not preferred:
        preferred = [
            coord for coord in coords or []
            if coord.get("timestamp_ms") and coord.get("latitude") and coord.get("longitude")
        ]
    return sorted(preferred, key=lambda coord: coord["timestamp_ms"])


def _nearest_position(positions, timestamp, max_gap_ms=10000):
    """Closest vehicle position to a log timestamp, or None when too far away."""
    if not positions or timestamp is None:
        return None
    target = int(timestamp.timestamp() * 1000)
    low, high = 0, len(positions) - 1
    best = None
    best_gap = None
    while low <= high:
        mid = (low + high) // 2
        gap = abs(positions[mid]["timestamp_ms"] - target)
        if best_gap is None or gap < best_gap:
            best_gap = gap
            best = positions[mid]
        if positions[mid]["timestamp_ms"] < target:
            low = mid + 1
        else:
            high = mid - 1
    if best_gap is not None and best_gap > max_gap_ms:
        return None
    return best


def _map_vertex_end_to_link_ordinal(route_links, vertex_ends):
    """Map TVAS route vertex indices to route link ordinals.

    setRouteInformation logs the vertex count of every route link, so the end
    vertex index of link k can be accumulated. Whether neighbouring links share
    their boundary vertex is not stated in the log, so both layouts are tried and
    the one that actually explains the logged vertexEnd values wins. Returns {}
    when neither layout fits (e.g. the route link list was trimmed on reroute),
    in which case GetRenderData GPs simply stay unpositioned.
    """
    sizes = [int((link.get("extra") or {}).get("vertex_size") or 0) for link in route_links]
    wanted = set(vertex_ends)
    if not sizes or not wanted:
        return {}

    best_mapping = {}
    best_hits = -1
    for shares_boundary in (True, False):
        mapping = {}
        cursor = 0
        for ordinal, size in enumerate(sizes):
            end = cursor + max(size, 1) - 1
            mapping.setdefault(end, ordinal)
            cursor = end if shares_boundary else end + 1
        hits = sum(1 for vertex_end in wanted if vertex_end in mapping)
        if hits > best_hits:
            best_hits = hits
            best_mapping = mapping

    if best_hits < len(wanted) * 0.9:
        return {}
    return best_mapping


def _lane_color_by_gp_index():
    """Drive-time lane bubble colours observed per GP index."""
    by_gp = {}
    for event in GP_LANE_EVENTS:
        bucket = by_gp.setdefault(event["gp_index"], {
            "lane_colors": [],
            "voice_code": event["voice_code"],
            "turn_code": event["turn_code"],
            "first_timestamp": event["timestamp"],
        })
        if event["lane_color"] not in bucket["lane_colors"]:
            bucket["lane_colors"].append(event["lane_color"])
    return by_gp


def _merge_gp_records_by_link_ordinal(route_links, entries, render_points):
    """Tie GP log records to route link ordinals.

    ServiceDataCollect carries the map link id, so it is matched against the
    Route Info link list with a forward-only cursor (a route may pass the same
    link twice). GetRenderData only has a route vertex index and is merged on
    top of the matching link when that index can be resolved. Records that
    cannot be tied to any route link are returned separately.
    """
    merged = {}
    floating = []

    route_link_ids = [(link.get("extra") or {}).get("link_id") for link in route_links]
    logged_ids = [entry.get("link_id") for entry in entries if entry.get("link_id") is not None]
    id_matches = sum(1 for value in logged_ids if value in set(route_link_ids))
    # For TVAS routes pstLinkListInfo[i].m_nLinkID is the route link ordinal, not a
    # map link id, so the logged values come out as 0,1,2,... Decide by what the
    # values actually are rather than assuming one of the two.
    treat_as_ordinal = (
        id_matches == 0
        and logged_ids
        and min(logged_ids) == 0
        and max(logged_ids) < max(len(route_links), len(logged_ids))
        and len(set(logged_ids)) == len(logged_ids)
    )

    cursor = 0
    for entry in entries:
        link_id = entry.get("link_id")
        ordinal = None
        if treat_as_ordinal:
            if link_id is not None and 0 <= link_id < len(route_links):
                ordinal = link_id
        else:
            for candidate in range(cursor, len(route_links)):
                if route_link_ids[candidate] == link_id:
                    ordinal = candidate
                    cursor = candidate + 1
                    break
            if ordinal is None:
                # The logged route link list can be trimmed on reroute; fall back to
                # a full scan without moving the cursor.
                for candidate in range(0, len(route_links)):
                    if route_link_ids[candidate] == link_id:
                        ordinal = candidate
                        break
        record = dict(entry)
        record["link_ordinal_from_log"] = bool(treat_as_ordinal)
        record["position_source"] = (
            "route link ordinal (nLinkID)" if treat_as_ordinal else "route link id"
        )
        if ordinal is None:
            floating.append(record)
        else:
            merged[ordinal] = record

    vertex_map = _map_vertex_end_to_link_ordinal(
        route_links, [point["vertex_end"] for point in render_points]
    )
    for point in render_points:
        ordinal = vertex_map.get(point["vertex_end"])
        render_info = {
            "render_gp_index": point["gp_index"],
            "render_gp_type": point["gp_type"],
            "render_turn_code": point["turn_code"],
            "vertex_end": point["vertex_end"],
        }
        if ordinal is not None and ordinal in merged:
            merged[ordinal].update(render_info)
            continue
        record = {
            "gp_type": point["gp_type"],
            "gp_type_flags": point["gp_type_flags"],
            "turn_code": point["turn_code"],
            "route_session_id": point["route_session_id"],
            "route_session_index": point["route_session_index"],
            "timestamp": point["timestamp"],
            "position_source": "route vertex index",
            **render_info,
        }
        if ordinal is None:
            floating.append(record)
        else:
            merged[ordinal] = record

    return merged, floating


def _observed_link_positions(coords):
    """Where the car actually was on each route link, from the route match log.

    'Route LinkScore RESULT LINK[k]' uses the same route link enumeration as
    ServiceDataCollect's nLinkID, so it gives an independent check on GPs that
    were placed by ordinal. The last sample on a link is closest to its end,
    which is where the GP sits.
    """
    if not ROUTE_MATCH_LINKS:
        return {}

    positions = _drive_positions(coords)
    if not positions:
        return {}

    last_sample = {}
    for sample in ROUTE_MATCH_LINKS:
        if sample["timestamp"] is None:
            continue
        current = last_sample.get(sample["link_index"])
        if current is None or sample["timestamp"] > current["timestamp"]:
            last_sample[sample["link_index"]] = sample

    observed = {}
    for link_index, sample in last_sample.items():
        position = _nearest_position(positions, sample["timestamp"], max_gap_ms=3000)
        if position:
            observed[link_index] = {
                "latitude": position["latitude"],
                "longitude": position["longitude"],
                "vertex_index": sample["vertex_index"],
                "timestamp_str": position.get("timestamp_str", ""),
            }
    return observed


def build_gp_guide_markers(lines, coords):
    """Place route guide points (GP) on the map.

    Position source, in order of reliability:
      1. map link id from 'ServiceDataCollect nGPType:...' matched against the
         Route Info link geometry -> the GP sits on that link's end vertex
      2. route vertex index from 'GetRenderData pGuidePoint' -> link ordinal
      3. the vehicle position at the time the GP's lane colour went active
    """
    if not GP_ENTRIES and not GP_RENDER_POINTS:
        return []

    route_sessions = _route_links_by_session(lines)
    positions = _drive_positions(coords)
    lane_colors = _lane_color_by_gp_index()
    observed_links = _observed_link_positions(coords)

    entries_by_session = {}
    for entry in GP_ENTRIES:
        entries_by_session.setdefault(entry["route_session_id"], []).append(entry)
    renders_by_session = {}
    for point in GP_RENDER_POINTS:
        renders_by_session.setdefault(point["route_session_id"], []).append(point)

    markers = []
    marker_id = 50000
    seen = set()

    for session_id in list(entries_by_session.keys()) + [
        sid for sid in renders_by_session if sid not in entries_by_session
    ]:
        route_links = route_sessions.get(session_id, [])
        # A session id is only attached to Route Info lines once the session log
        # arrives; fall back to the single known route when there is just one.
        if not route_links and len(route_sessions) == 1:
            route_links = next(iter(route_sessions.values()))

        merged, floating = _merge_gp_records_by_link_ordinal(
            route_links,
            entries_by_session.get(session_id, []),
            renders_by_session.get(session_id, []),
        )

        ordered = [(ordinal, merged[ordinal]) for ordinal in sorted(merged)]
        ordered.extend((None, record) for record in floating)

        for ordinal, record in ordered:
            latitude = longitude = None
            link_extra = {}
            if ordinal is not None and ordinal < len(route_links):
                route_link = route_links[ordinal]
                link_extra = route_link.get("extra") or {}
                # The turn happens at the end vertex of the link the GP sits on.
                latitude, longitude = route_link.get("end", (None, None))

            gp_index = record.get("gp_index")
            lane_info = lane_colors.get(gp_index) if gp_index is not None else None

            if latitude is None:
                # Last resort: where the car was when this GP's lane went active.
                fallback = _nearest_position(
                    positions, lane_info["first_timestamp"]
                ) if lane_info else None
                if fallback:
                    latitude = fallback["latitude"]
                    longitude = fallback["longitude"]
                    record["position_source"] = "drive position (lane color)"

            if latitude is None or longitude is None:
                continue

            gp_type = int(record.get("gp_type") or 0)
            if not gp_type:
                # GPTYPE_NON — 안내 없는 통과 링크. 마커로 만들지 않는다.
                # 이 링크의 turnCode/nGPType 는 Route Info 링크 팝업에서 볼 수 있다.
                continue

            dedupe_key = (
                session_id, ordinal, record.get("link_id"), gp_index,
                record.get("turn_code"), gp_type,
            )
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)

            # Independent check: where the car actually was on this route link.
            observed = observed_links.get(ordinal) if ordinal is not None else None
            observed_gap_m = None
            if observed:
                observed_gap_m = round(
                    lat_lon_dist(latitude, longitude, observed["latitude"], observed["longitude"]), 1
                )

            timestamp = record.get("timestamp")
            markers.append({
                "id": marker_id,
                "dlt_id": None,
                "type": "GP Guide",
                "latitude": latitude,
                "longitude": longitude,
                "heading": None,
                "extra": {
                    "gp_guide": True,
                    "gp_index": gp_index,
                    "render_gp_index": record.get("render_gp_index"),
                    "link_ordinal": ordinal,
                    "link_index": record.get("link_index"),
                    "link_id": record.get("link_id"),
                    "route_link_id": link_extra.get("link_id"),
                    "turn_code": record.get("turn_code"),
                    "gp_type": gp_type,
                    "gp_type_flags": record.get("gp_type_flags") or decode_gp_type_flags(gp_type),
                    "is_guidance": bool(gp_type),
                    "voice_code": record.get("voice_code"),
                    "snd_code": record.get("snd_code"),
                    "cross_image": record.get("cross_image"),
                    "cross_image_raw": record.get("cross_image_raw"),
                    "cross_img_code": record.get("cross_img_code"),
                    "cross_img_available": record.get("cross_img_available"),
                    "vertex_end": record.get("vertex_end"),
                    "lane_color": lane_color_from_voice_code(record.get("voice_code")),
                    "lane_colors": (lane_info or {}).get("lane_colors") or [],
                    "position_source": record.get("position_source"),
                    "link_ordinal_from_log": record.get("link_ordinal_from_log"),
                    "observed_lat": (observed or {}).get("latitude"),
                    "observed_lon": (observed or {}).get("longitude"),
                    "observed_vertex_index": (observed or {}).get("vertex_index"),
                    "observed_time": (observed or {}).get("timestamp_str"),
                    "observed_gap_m": observed_gap_m,
                    "route_session_id": session_id,
                    "route_session_index": record.get("route_session_index"),
                    "route_session_name": link_extra.get("route_session_name"),
                    "link_start_lat": (route_links[ordinal].get("start") or [None, None])[0]
                    if ordinal is not None and ordinal < len(route_links) else None,
                    "link_start_lon": (route_links[ordinal].get("start") or [None, None])[1]
                    if ordinal is not None and ordinal < len(route_links) else None,
                },
                "timestamp_ms": int(timestamp.timestamp() * 1000) if timestamp else 0,
                "timestamp_str": timestamp.strftime("%Y/%m/%d %H:%M:%S.%f")[:-3] if timestamp else "",
                "color": "#7c3aed" if gp_type & 0x00020000 else ("#0d9488" if gp_type & 0x00010000 else "#94a3b8"),
                "fill": bool(gp_type),
            })
            marker_id += 1

    return markers


def build_gp_lane_color_markers(coords):
    """Place drive-time lane bubble events at the vehicle position of that tick."""
    if not GP_LANE_EVENTS:
        return []

    positions = _drive_positions(coords)
    markers = []
    marker_id = 60000
    seen = set()

    for event in GP_LANE_EVENTS:
        dedupe_key = (event["route_session_id"], event["link_index"], event["gp_index"], event["lane_color"])
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        position = _nearest_position(positions, event["timestamp"])
        if not position:
            continue

        lane_color = event["lane_color"]
        markers.append({
            "id": marker_id,
            "dlt_id": None,
            "type": "GP Lane Color",
            "latitude": position["latitude"],
            "longitude": position["longitude"],
            "heading": None,
            "extra": {
                "gp_lane_color": True,
                "gp_index": event["gp_index"],
                "link_index": event["link_index"],
                "gp_link_index": event["gp_link_index"],
                "voice_code": event["voice_code"],
                "lane_color": lane_color,
                "turn_code": event["turn_code"],
                # gpLinkIndex != linkIndex means the active GP was created on a
                # different link than the one the car is matched to.
                "link_mismatch": event["gp_link_index"] != event["link_index"],
                "route_session_id": event["route_session_id"],
            },
            "timestamp_ms": int(event["timestamp"].timestamp() * 1000) if event["timestamp"] else 0,
            "timestamp_str": event["timestamp"].strftime("%Y/%m/%d %H:%M:%S.%f")[:-3] if event["timestamp"] else "",
            "color": LANE_COLOR_HEX.get(lane_color, "#64748b"),
            "fill": lane_color != 0,
        })
        marker_id += 1

    return markers


def build_lane_bubble_markers(gp_markers):
    """Lane bubbles, derived from the upstream ServiceDataCollect logs only.

    A lane bubble is drawn wherever a GP carries GPTYPE_TURN. Everything shown in
    it comes from logs that exist upstream:
      colour     <- nVoiceCode via ToLaneColor()   ('ServiceDataCollect #2')
      차로 힌트  <- nVoiceCode (IDV_RG_* lane codes, e.g. 97 = 오른쪽 1개 차로)
      회전       <- nTurnCode
      교차로 이미지 <- bCrossImage + nGPType & EXTCROSSTURN
    Per-lane arrows/highlight are NOT included: no upstream log carries
    nLaneTurnInfo[] / nLaneAvailable[], so they cannot be reconstructed.
    """
    markers = []
    marker_id = 70000

    for gp in gp_markers or []:
        extra = gp.get("extra") or {}
        gp_type = int(extra.get("gp_type") or 0)
        if not (gp_type & 0x00010000):   # GPTYPE_TURN — 버블은 회전 GP에서만 나온다
            continue

        voice_code = extra.get("voice_code")
        lane_color = lane_color_from_voice_code(voice_code)
        # The drive-time log, when present, is the ground truth for the colour.
        observed = extra.get("lane_colors") or []
        markers.append({
            "id": marker_id,
            "dlt_id": None,
            "type": "GP Lane Bubble",
            "latitude": gp["latitude"],
            "longitude": gp["longitude"],
            "heading": None,
            "extra": {
                "lane_bubble": True,
                "gp_index": extra.get("gp_index"),
                "link_index": extra.get("link_index"),
                "link_id": extra.get("link_id"),
                "turn_code": extra.get("turn_code"),
                "gp_type": gp_type,
                "gp_type_flags": extra.get("gp_type_flags"),
                "voice_code": voice_code,
                "lane_color": lane_color,
                "lane_color_source": "nVoiceCode",
                "lane_colors_observed": observed,
                "has_cross_image": bool(gp_type & 0x00020000),
                "cross_image": extra.get("cross_image"),
                "cross_image_raw": extra.get("cross_image_raw"),
                "cross_img_code": extra.get("cross_img_code"),
                "cross_img_available": extra.get("cross_img_available"),
                "route_session_id": extra.get("route_session_id"),
            },
            "timestamp_ms": gp.get("timestamp_ms"),
            "timestamp_str": gp.get("timestamp_str"),
            "color": LANE_COLOR_HEX.get(lane_color, "#64748b"),
            "fill": True,
        })
        marker_id += 1

    return markers


def attach_guide_info_to_route_lines(lines):
    """Attach the GP / turnCode information of each route link to its Route Info line.

    Route Info lines already carry the map link id, which is exactly the key the
    ServiceDataCollect logs use — so every route link can show what the guidance
    engine decided for it, without needing the separate GP layers.
    """
    if not GP_ENTRIES and not GP_RENDER_POINTS:
        return 0

    route_sessions = _route_links_by_session(lines)
    lane_colors = _lane_color_by_gp_index()

    entries_by_session = {}
    for entry in GP_ENTRIES:
        entries_by_session.setdefault(entry["route_session_id"], []).append(entry)
    renders_by_session = {}
    for point in GP_RENDER_POINTS:
        renders_by_session.setdefault(point["route_session_id"], []).append(point)

    attached = 0
    session_ids = list(entries_by_session.keys()) + [
        sid for sid in renders_by_session if sid not in entries_by_session
    ]

    for session_id in session_ids:
        route_links = route_sessions.get(session_id, [])
        if not route_links and len(route_sessions) == 1:
            route_links = next(iter(route_sessions.values()))
        if not route_links:
            continue

        merged, _floating = _merge_gp_records_by_link_ordinal(
            route_links,
            entries_by_session.get(session_id, []),
            renders_by_session.get(session_id, []),
        )

        for ordinal, record in merged.items():
            if ordinal >= len(route_links):
                continue
            gp_type = int(record.get("gp_type") or 0)
            gp_index = record.get("gp_index")
            link_index = record.get("link_index")
            guide = {
                "turn_code": record.get("turn_code"),
                "gp_type": gp_type,
                "gp_type_flags": record.get("gp_type_flags") or decode_gp_type_flags(gp_type),
                "is_guidance": bool(gp_type),
                "has_cross_image": bool(gp_type & 0x00020000),
                "gp_index": gp_index,
                "render_gp_index": record.get("render_gp_index"),
                "link_index": link_index,
                "voice_code": record.get("voice_code"),
                "snd_code": record.get("snd_code"),
                "cross_image": record.get("cross_image"),
                "cross_image_raw": record.get("cross_image_raw"),
                "cross_img_code": record.get("cross_img_code"),
                "cross_img_available": record.get("cross_img_available"),
                "vertex_end": record.get("vertex_end"),
                "lane_color": lane_color_from_voice_code(record.get("voice_code")),
                "lane_colors_observed": (lane_colors.get(gp_index) or {}).get("lane_colors") or []
                if gp_index is not None else [],
            }
            route_links[ordinal].setdefault("extra", {})["guide"] = guide
            attached += 1

    return attached


def build_runtime_payload():
    import sys
    print(f'[DEBUG] build_runtime_payload start: PARKING_LOT_EVENTS = {len(PARKING_LOT_EVENTS)}', file=sys.stderr)
    all_coords = [coord.to_json() for coords in COORDINATES.values() for coord in coords]
    all_lines = [line.to_json() for lines in LINES.values() for line in lines]

    # Attach parking lot state information to DR-based coordinates
    attach_parking_state_to_coords(all_coords)

    # Attach [출발지, 경유지..., 목적지] point sets to Request coordinates
    attach_route_points_to_requests(all_coords)

    # Extract parking lot state markers from DR-based coordinates with parking state
    parking_lot_state_markers = build_parking_lot_state_markers(all_coords)
    import sys
    print(f'[DEBUG] build_runtime_payload: created parking_lot_state_markers = {len(parking_lot_state_markers)}', file=sys.stderr)

    # Attach per-link GP / turnCode info to the route links themselves so the
    # Route Info layer shows the guidance decision for each link.
    attached_guides = attach_guide_info_to_route_lines(all_lines)
    print(f'[DEBUG] build_runtime_payload: guide info attached to {attached_guides} route links', file=sys.stderr)

    # Convert guide events and route info to marker coordinates
    all_coords.extend(build_guide_event_markers())
    all_coords.extend(build_route_info_markers(all_lines))
    gp_guide_markers = build_gp_guide_markers(all_lines, all_coords)
    all_coords.extend(gp_guide_markers)
    all_coords.extend(build_gp_lane_color_markers(all_coords))
    all_coords.extend(build_lane_bubble_markers(gp_guide_markers))

    all_coords.sort(key=lambda c: c.get("id") if c.get("id") is not None else 0)
    all_lines.sort(key=lambda l: l.get("id") if l.get("id") is not None else 0)
    valid_ids = [data["id"] for data in all_coords if data.get("id") is not None]

    min_ts_ms = int(min_timestamp.timestamp() * 1000) if min_timestamp != datetime.max else 0
    max_ts_ms = int(max_timestamp.timestamp() * 1000) if max_timestamp != datetime.min else 1
    max_id = max(valid_ids) if valid_ids else 1

    return {
        "min_timestamp_ms": min_ts_ms,
        "max_timestamp_ms": max_ts_ms,
        "max_id": max_id,
        "coords": all_coords,
        "parking_lot_state_markers": parking_lot_state_markers,
        "lane_ext_links": sorted(LANE_EXT_LINKS.values(), key=lambda e: e["link_id"]),
        "lines": all_lines,
    }


def build_parking_lot_state_markers(coords):
    """Extract DR-based coordinates with parking state and format as markers."""
    markers = []
    marker_id_counter = 30000  # Start from 30000 to avoid conflicts

    dr_based_count = 0
    with_parking_state = 0

    for coord in coords:
        if coord.get('type') != 'DR-based':
            continue

        dr_based_count += 1
        parking_state = coord.get('extra', {}).get('parking_state')
        if not parking_state:
            continue

        with_parking_state += 1

        # Set color based on parking state
        if parking_state == 'ParkingLot':
            color = '#808080'  # 회색 - 주차장 중
        elif parking_state in ('EnterCandidate', 'EnterReady'):
            color = '#ff1493'  # 분홍색 - 진입 후보/준비
        else:
            continue  # Skip unknown states

        marker = {
            "id": marker_id_counter,
            "dlt_id": coord.get('dlt_id'),
            "type": "Parking Lot State",
            "latitude": coord.get("latitude"),
            "longitude": coord.get("longitude"),
            "heading": coord.get("heading"),
            "color": color,
            "fill": True,
            "timestamp_ms": coord.get("timestamp_ms"),
            "timestamp_str": coord.get("timestamp_str"),
            "extra": {
                "parking_state": parking_state,
                "parking_candidate_count": coord.get('extra', {}).get('parking_candidate_count', 0),
                "parking_best_link_id": coord.get('extra', {}).get('parking_best_link_id', -1),
            }
        }
        markers.append(marker)
        marker_id_counter += 1

    import sys
    print(f'[DEBUG] build_parking_lot_state_markers: DR-based={dr_based_count}, with_parking_state={with_parking_state}, markers created={len(markers)}', file=sys.stderr)
    return markers


def build_route_info_markers(lines):
    """Convert Route Info lines to marker coordinates for displaying route details."""
    markers = []
    marker_id_counter = 40000  # Start from 40000 to avoid conflicts

    if not lines:
        return markers

    route_info_lines = [line for line in lines if line.get('type') == 'Route Info']

    for line in route_info_lines:
        start_lat, start_lon = line.get('start', (None, None))
        end_lat, end_lon = line.get('end', (None, None))

        if start_lat is None or start_lon is None:
            continue

        marker = {
            "id": marker_id_counter,
            "dlt_id": None,
            "type": "Route Info",
            "latitude": start_lat,
            "longitude": start_lon,
            "heading": None,
            "color": "#e91e63",  # Deep pink for route info
            "fill": False,
            "timestamp_ms": line.get('timestamp_ms'),
            "timestamp_str": line.get('timestamp_str', ''),
            "extra": {
                "route_session_id": line.get('extra', {}).get('route_session_id'),
                "link_id": line.get('extra', {}).get('link_id'),
                "route_start_lat": start_lat,
                "route_start_lon": start_lon,
                "route_end_lat": end_lat,
                "route_end_lon": end_lon,
                "route_session_index": line.get('extra', {}).get('route_session_index'),
                "route_sequence": line.get('extra', {}).get('route_sequence'),
                "guide": line.get('extra', {}).get('guide'),
            }
        }
        markers.append(marker)
        marker_id_counter += 1

    return markers


def attach_parking_state_to_coords(coords):
    """Attach closest parking lot state to DR-based coordinates (only attach to extra, no color change)."""
    import sys
    print(f'[DEBUG] attach_parking_state_to_coords: PARKING_LOT_EVENTS count = {len(PARKING_LOT_EVENTS)}', file=sys.stderr)
    if not PARKING_LOT_EVENTS:
        return

    # Sort parking events by timestamp for efficient matching
    sorted_events = sorted(PARKING_LOT_EVENTS, key=lambda e: e['timestamp'])
    attached_count = 0

    for coord in coords:
        if coord.get('type') != 'DR-based':
            continue

        coord_ts = coord.get('timestamp_ms', 0)
        if not coord_ts:
            continue

        # Find closest parking state within 2 seconds
        closest_event = None
        min_diff = float('inf')

        for event in sorted_events:
            event_ts = int(event['timestamp'].timestamp() * 1000)
            diff = abs(coord_ts - event_ts)

            if diff < min_diff:
                min_diff = diff
                closest_event = event

            # Early exit if found exact match
            if diff == 0:
                break

        # Attach parking state if within 2 second window (only store in extra, no color override)
        if closest_event and min_diff <= 2000:
            coord['extra']['parking_state'] = closest_event.get('state')
            coord['extra']['parking_candidate_count'] = closest_event.get('candidate_count', 0)
            coord['extra']['parking_best_link_id'] = closest_event.get('best_link_id', -1)
            attached_count += 1

    import sys
    print(f'[DEBUG] attach_parking_state_to_coords: attached to {attached_count} DR-based coordinates', file=sys.stderr)


def write_data_to_json(out_path=None):
    out_path = out_path or PATHS.output_json
    payload = build_runtime_payload()
    with open(out_path, "w", encoding="utf-8") as file:
        json.dump(
            {
                "min_timestamp_ms": payload["min_timestamp_ms"],
                "max_timestamp_ms": payload["max_timestamp_ms"],
                "coords": payload["coords"],
                "lines": payload["lines"],
            },
            file,
            ensure_ascii=False,
            indent=2,
        )
