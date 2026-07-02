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


def lat_lon_dist(lat1, lon1, lat2, lon2):
    local_x = -(((lon2 - lon1) * DEG2RAD) * math.cos(DEG2RAD * lat1)) * EARTH_RADIUS
    local_y = ((lat2 - lat1) * DEG2RAD) * EARTH_RADIUS
    return math.sqrt((local_x * local_x) + (local_y * local_y))


def reset_runtime_state():
    global COORDINATES, LINES, GUIDE_EVENTS
    global min_timestamp, max_timestamp
    global last_road_match_state, last_route_match_state, last_threshold_info, log_base_timestamp, last_tvas_header_info
    global current_route_session_id, current_route_session_index, route_session_indices, route_session_sequence
    global current_gnss_mode, pending_gnss_mode_transition

    COORDINATES = {coord_type: [] for coord_type in CoordType}
    LINES = {line_type: [] for line_type in LineType}
    GUIDE_EVENTS = []
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
    global log_base_timestamp, last_tvas_header_info
    global current_route_session_id, current_route_session_index, route_session_indices, route_session_sequence
    global current_gnss_mode, pending_gnss_mode_transition

    current_id = 1
    temp_gnss1_coord = None
    temp_gnss2_coord = None
    last_dr_coordinate = None
    pending_mm_feedback_reason = None
    last_vpm_coordinate = None
    last_road_match_coord = None
    last_route_match_coord = None
    pending_candidate_link_scores = []
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

            # Parse Guide Events (C2X, Accident)
            parse_guide_event(line, timestamp)

            tvas_header_info = parse_tvas_header_info(line, last_tvas_header_info)
            if tvas_header_info is not None:
                last_tvas_header_info = tvas_header_info

            candidate_link_info = parse_candidate_link_score(line)
            if candidate_link_info:
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
                route_info["extra"]["route_session_name"] = f"Route Info {session_index}"
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
            # "skipped" cases mean no correction was applied -> do not highlight.
            mm_feedback_match = MM_FEEDBACK_PATTERN.search(line)
            if mm_feedback_match:
                reason = mm_feedback_match.group(1).strip()
                if "skip" not in reason.lower():
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
                    if last_vpm_coordinate:
                        group2_value = int(match.group(2))
                        group2_enum = RouteRequestType.get_type_by_value(group2_value)
                        extra_info = {
                            "group_1": match.group(1),
                            "group_2_text": group2_enum.label,
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
                            latitude=last_vpm_coordinate.latitude,
                            longitude=last_vpm_coordinate.longitude,
                            heading=last_vpm_coordinate.heading,
                            extra=extra_info,
                            timestamp=timestamp,
                        )
                        COORDINATES[coord_type].append(request_coordinate)

                # Do not stop at first match. One physical line can contain
                # multiple embedded DLT records in this log format.
                continue

    flush_pending_raw_gnss()
    normalize_sequential_ids()
    fill_missing_timestamps()
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

    # Keep marker ids stable in original DLT log order.
    # Timestamp can be noisy/missing in some logs, which causes ID jumps.
    all_coords.sort(
        key=lambda coord: (
            coord.dlt_id is None,
            coord.dlt_id if coord.dlt_id is not None else 10**15,
            coord.timestamp if coord.timestamp else datetime.min,
        )
    )
    all_lines.sort(key=lambda line: (line.timestamp if line.timestamp else datetime.min))

    # Coordinate IDs are per-type sequential IDs (1..N) in DLT order.
    # This keeps each layer's ID progression intuitive.
    per_type_counters = {coord_type: 0 for coord_type in CoordType}
    for coord in all_coords:
        coord_type = coord.type
        if coord_type not in per_type_counters:
            continue
        per_type_counters[coord_type] += 1
        coord.id = per_type_counters[coord_type]

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
        "distanceProjection": float(match.group(8)),
        "distanceScore": float(match.group(9)),
        "laneWeight": float(match.group(10)),
        "facilityBonus": float(match.group(11)),
        "gyroAngle": float(match.group(12)),
        "vehicleAngle": float(match.group(13)),
        "lane": int(match.group(14)),
    }
    return previous_info


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


def build_runtime_payload():
    all_coords = [coord.to_json() for coords in COORDINATES.values() for coord in coords]
    all_lines = [line.to_json() for lines in LINES.values() for line in lines]

    # Convert guide events to marker coordinates
    all_coords.extend(build_guide_event_markers())

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
        "lines": all_lines,
    }


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
