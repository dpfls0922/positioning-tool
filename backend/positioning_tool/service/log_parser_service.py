import csv
import json
import os
import re
from datetime import datetime, timedelta

from backend.positioning_tool.service.paths import PATHS
from backend.positioning_tool.model.log_entities import Coordinate, Line, CoordType, LineType, RouteRequestType
from backend.positioning_tool.service.log_parsing.patterns import (
    CAR2X_CREATE_PATTERN,
    GP_CROSS_IMAGE_DATA_PATTERN,
    GP_CROSS_IMAGE_FILTERED_PATTERN,
    GP_CROSS_IMAGE_RAW_PATTERN,
    GP_LANE_COLOR_PATTERN,
    GP_RENDER_DATA_PATTERN,
    GP_STORE_PATTERN,
    GP_TYPE_PATTERN,
    MFS_CONTENT_PATTERN,
    MM_FEEDBACK_PATTERN,
    ROLL_PITCH_RESET_PATTERN,
    PARKING_LOT_APPLY_PATTERN,
    PARKING_LOT_STATE_CHANGE_PATTERN,
    ROUTE_MATCH_LINK_PATTERN,
    ROUTE_REQ_DEPART_PATTERN,
    ROUTE_REQ_DEST_PATTERN,
    ROUTE_REQ_WAYPOINT_PATTERN,
    SDI_DRIVE_STATUS_PATTERN,
    SDI_BLOCK_INFO_PATTERN,
    TUNNEL_CHECK_PATTERN,
    SDI_BLOCK_STATUS_PATTERN,
    SDI_SELECTED_PATTERN,
    SDI_SKIP_PATTERN,
    _SCAN_NEXT_TYPE,
    _STOP_LINE,
)
from backend.positioning_tool.service.log_parsing.dlt_records import (
    iterate_log_records,
)
from backend.positioning_tool.service.log_parsing.line_parsers import (
    infer_initial_timestamp,
    lat_lon_dist,
    parse_candidate_link_score,
    parse_gnss_mode_info,
    parse_gnss_outlier_info,
    parse_link_extrapoint,
    parse_road_match_state,
    parse_route_match_state,
    parse_route_session_info,
    parse_set_route_information,
    parse_threshold_info,
    parse_tvas_header_info,
)
from backend.positioning_tool.service.log_parsing.gp_guide import (
    LANE_COLOR_HEX,
    _drive_positions,
    _merge_gp_records_by_link_ordinal,
    _nearest_position,
    _route_links_by_session,
    build_lane_bubble_markers,
    decode_gp_type_flags,
    lane_color_from_voice_code,
)
from backend.positioning_tool.service.log_parsing.markers import (
    attach_dr_event_deltas,
    build_parking_lot_state_markers,
    build_roll_pitch_reset_markers,
    build_gnss_outlier_markers,
    build_route_info_markers,
)


COORDINATES = {coord_type: [] for coord_type in CoordType}
LINES = {line_type: [] for line_type in LineType}
GUIDE_EVENTS = []  # C2X events and accident events
SDI_EVENTS = []  # SDI (Safety Drive Information) events
# 구간단속 HUD 타임라인 원본 샘플 (평균속도 / 남은거리 / 구간 제한속도)
SDI_BLOCK_SAMPLES = []
# 터널/지하차도(GPS 음영) 구간 샘플
SHADE_SAMPLES = []
GP_ENTRIES = []  # Route guidance points (GP) collected when a route is applied
GP_RENDER_POINTS = []  # TVAS GP table from GetRenderData pGuidePoint logs
ROUTE_MATCH_LINKS = []  # (route link index, route vertex index, timestamp) while driving
GP_LANE_EVENTS = []  # Runtime setLaneColor ticks ([LANE_COLOR] linkIndex:...)
gp_pending = {}  # Per-link scratch built up across the ServiceDataCollect log lines
PARKING_LOT_EVENTS = []  # ParkingLot detector exit events
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


def reset_runtime_state():
    global COORDINATES, LINES, GUIDE_EVENTS, SDI_EVENTS, SDI_BLOCK_SAMPLES, SHADE_SAMPLES, PARKING_LOT_EVENTS, last_gnss_coordinate
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
    SDI_BLOCK_SAMPLES = []
    SHADE_SAMPLES = []
    PARKING_LOT_EVENTS = []
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


class _LogParseState:
    """parse_log 루프가 줄 사이에 이어가는 상태.

    이전에는 parse_log 안의 지역변수 + 클로저였고, 코드가 길어질수록
    어떤 값이 줄 사이에 유지되는지 파악하기 어려웠다. 라인 핸들러들이
    이 상태만 주고받도록 모아둔다.
    """

    def __init__(self):
        self.current_id = 1
        self.temp_gnss1_coord = None
        self.temp_gnss2_coord = None
        self.last_dr_coordinate = None
        self.last_vpm_coordinate = None
        self.last_road_match_coord = None
        self.last_route_match_coord = None
        self.pending_mm_feedback_reason = None
        # Roll/pitch resets (정차 재초기화) waiting for the next DR coordinate
        self.pending_roll_pitch_resets = []
        # Requests waiting for their TVAS session id (which arrives later in the log)
        self.pending_route_request_coords = []
        self.pending_candidate_link_scores = []
        # link_id -> extrapoint_info, buffered until Candidate Link line arrives
        self.pending_extrapoint_by_link_id = {}

    def flush_pending_raw_gnss(self, assign_id=None):
        if self.temp_gnss2_coord is None:
            return
        fallback_id = self.current_id - 1 if self.current_id > 1 else self.current_id
        self.temp_gnss2_coord.id = assign_id if isinstance(assign_id, int) and assign_id > 0 else fallback_id
        COORDINATES[CoordType.GNSS2].append(self.temp_gnss2_coord)
        self.temp_gnss2_coord = None


def parse_log(log_file_path=None):
    global log_base_timestamp

    source_path = log_file_path or PATHS.log_file_path

    if not os.path.exists(source_path):
        print(f"오류: 로그 파일 '{source_path}'을 찾을 수 없습니다.")
        return False

    log_base_timestamp = infer_initial_timestamp(source_path)
    current_timestamp = log_base_timestamp
    state = _LogParseState()

    for dlt_id, line, reception_timestamp in iterate_log_records(source_path):
        current_timestamp = _resolve_line_timestamp(line, reception_timestamp, current_timestamp)
        timestamp = current_timestamp
        if timestamp:
            update_timestamp_range(timestamp)

        _track_threshold_and_gnss_mode(line)
        _track_route_session(state, line)
        _collect_standalone_events(line, timestamp)
        _track_tvas_header(line)
        _collect_candidate_link_score(state, line)
        _collect_route_information(state, line, timestamp)
        _track_match_states(line)
        _track_mm_feedback(state, line)
        _track_roll_pitch_reset(state, line)
        _track_gnss_outlier(state, line)
        _collect_coordinates(state, line, dlt_id, timestamp)

    state.flush_pending_raw_gnss()
    normalize_sequential_ids()
    fill_missing_timestamps()
    sanitize_outlier_timestamps()
    recompute_timestamp_range_from_coords()
    return True


def _resolve_line_timestamp(line, reception_timestamp, current_timestamp):
    """이 줄에 적용할 시각. DLT 저장 헤더의 수신 시각(절대시간)이 최우선."""
    if reception_timestamp is not None:
        return reception_timestamp

    parsed_timestamp = parse_datetime(line, current_timestamp)
    return parsed_timestamp if parsed_timestamp else current_timestamp


def _track_threshold_and_gnss_mode(line):
    global last_threshold_info, current_gnss_mode, pending_gnss_mode_transition

    threshold_info = parse_threshold_info(line)
    if threshold_info:
        last_threshold_info = threshold_info

    gnss_mode_info = parse_gnss_mode_info(line)
    if gnss_mode_info:
        current_gnss_mode = gnss_mode_info["mode"]
        if gnss_mode_info.get("transition"):
            pending_gnss_mode_transition = gnss_mode_info["transition"]


def _track_route_session(state, line):
    global current_route_session_id, current_route_session_index, last_tvas_header_info

    route_session_info = parse_route_session_info(line)
    if not route_session_info:
        return

    current_route_session_id = route_session_info["session_id"]
    current_route_session_index = route_session_indices.setdefault(
        current_route_session_id,
        len(route_session_indices) + 1,
    )
    route_session_sequence.setdefault(current_route_session_id, 0)
    last_tvas_header_info = None
    # The session id arrives after the request in the log; link it back
    # to any pending Request coordinates so they can be matched later.
    for pending_request in state.pending_route_request_coords:
        pending_request.extra["route_session_id"] = current_route_session_id
        ROUTE_SESSION_CONTENT_IDS[current_route_session_id] = pending_request.extra.get("group_1")
    state.pending_route_request_coords = []


def _collect_standalone_events(line, timestamp):
    """좌표 상태와 무관하게 자기 완결적으로 수집되는 이벤트들."""
    parse_guide_event(line, timestamp)
    parse_sdi_event(line, timestamp)
    parse_sdi_block_status(line, timestamp)
    parse_tunnel_check(line, timestamp)
    parse_parking_lot_event(line, timestamp)
    parse_gp_guide_event(line, timestamp)
    parse_route_request_points(line)


def _track_tvas_header(line):
    global last_tvas_header_info

    tvas_header_info = parse_tvas_header_info(line, last_tvas_header_info)
    if tvas_header_info is not None:
        last_tvas_header_info = tvas_header_info


def _collect_candidate_link_score(state, line):
    extrapoint_info = parse_link_extrapoint(line)
    if extrapoint_info:
        state.pending_extrapoint_by_link_id[extrapoint_info["link_id"]] = extrapoint_info

    candidate_link_info = parse_candidate_link_score(line)
    if not candidate_link_info:
        return

    extrapoint = state.pending_extrapoint_by_link_id.pop(candidate_link_info["link_id"], None)
    if extrapoint:
        candidate_link_info["mul"] = extrapoint["mul"]
        candidate_link_info["score"] = extrapoint["score"]

    if state.last_dr_coordinate is not None:
        bucket = state.last_dr_coordinate.extra.setdefault("candidate_link_scores", [])
        bucket.append(candidate_link_info)
    else:
        state.pending_candidate_link_scores.append(candidate_link_info)


def _collect_route_information(state, line, timestamp):
    route_info = parse_set_route_information(line)
    if not route_info:
        return

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
            id=state.current_id,
            type=LineType.ROUTE_INFO,
            start=(route_info["start_lat"], route_info["start_lon"]),
            end=(route_info["end_lat"], route_info["end_lon"]),
            timestamp=timestamp,
            extra=route_info["extra"],
        )
    )


def _track_match_states(line):
    global last_road_match_state, last_route_match_state

    road_match_state = parse_road_match_state(line)
    route_match_state = parse_route_match_state(line)
    if road_match_state:
        last_road_match_state = road_match_state
    if route_match_state:
        last_route_match_state = route_match_state


def _track_mm_feedback(state, line):
    """MM feedback 보정 사유를 잡아두고 다음 DR 좌표에 표시한다.

    현재 로그 형식의 실제 보정 이벤트:
      'clamped: dist=..., laneWidth=..., ratio=..., timegap=...'  -> 검정(차로폭 피드백)
      'heading only: dr=..., feedback=...'                        -> 회색(헤딩만 보정)
    레거시 형식도 계속 허용: 'correction clamped ...' / 'Force correction' -> 검정,
      'correction normal' -> 회색.
    안내성 라인('timegap: ...')과 'skipped' 케이스는 다음 DR 좌표를
    피드백 보정으로 표시하지 않아야 한다.
    """
    mm_feedback_match = MM_FEEDBACK_PATTERN.search(line)
    if not mm_feedback_match:
        return

    reason = mm_feedback_match.group(1).strip()
    reason_lower = reason.lower()
    is_correction = (
        reason_lower.startswith("clamp")       # clamp to lane edge / clamp to feedback pos
        or reason_lower.startswith("heading only")
        or "correction" in reason_lower        # legacy: correction clamped / Force correction
    )
    if is_correction and "skip" not in reason_lower:
        state.pending_mm_feedback_reason = reason


def _track_roll_pitch_reset(state, line):
    """정차 중 roll/pitch 재초기화 이벤트를 잡아 다음 DR 좌표에 표시한다.

    SetRollPitchFromAccelerometer는 정차 중에만 발생하고, ResetRollPitch는
    MM feedback 방향 재설정 시 발생한다. 다음 DR 좌표까지 발생한 이벤트를
    모두 모아 붙인다.
    """
    roll_pitch_match = ROLL_PITCH_RESET_PATTERN.search(line)
    if not roll_pitch_match:
        return

    state.pending_roll_pitch_resets.append({
        "event": roll_pitch_match.group(1),
        "detail": roll_pitch_match.group(2).strip(),
    })


def _track_gnss_outlier(state, line):
    """GnssFilter outlier 판정을 해당 epoch의 Raw GNSS 좌표에 붙인다.

    판정 로그는 [GNSS] 줄 바로 뒤에 찍히므로 아직 flush 되지 않은
    Raw GNSS 좌표(없으면 마지막으로 flush 된 것)가 대상이다.
    """
    outlier_info = parse_gnss_outlier_info(line)
    if not outlier_info:
        return

    target = state.temp_gnss2_coord
    if target is None and COORDINATES[CoordType.GNSS2]:
        target = COORDINATES[CoordType.GNSS2][-1]
    if target is None:
        return

    if "rejected" in outlier_info:
        target.extra["gnss_outlier"] = outlier_info["rejected"]
    if "transition" in outlier_info:
        target.extra["gnss_outlier_transition"] = outlier_info["transition"]


def _collect_coordinates(state, line, dlt_id, timestamp):
    """줄에서 좌표 패턴을 찾아 타입별 핸들러로 넘긴다."""
    for coord_type in CoordType:
        if coord_type.pattern is None:
            continue

        match = coord_type.pattern.search(line)
        if not match:
            continue

        handler = _COORD_HANDLERS.get(coord_type)
        if handler is None:
            continue

        if handler(state, coord_type, match, line, dlt_id, timestamp) is _STOP_LINE:
            break


def _handle_gnss1_coord(state, coord_type, match, line, dlt_id, timestamp):
    global last_gnss_coordinate, pending_gnss_mode_transition

    gnss_lat = float(match.group(1))
    gnss_lon = float(match.group(2))
    heading = float(match.group(3))
    speed = float(match.group(4))

    if gnss_lat == 0.0 and gnss_lon == 0.0:
        return _STOP_LINE

    state.temp_gnss1_coord = Coordinate(
        dlt_id=dlt_id,
        type=coord_type,
        latitude=gnss_lat,
        longitude=gnss_lon,
        heading=heading,
        extra={"Speed": speed},
        timestamp=timestamp,
    )
    if current_gnss_mode:
        state.temp_gnss1_coord.extra["gnss_mode"] = current_gnss_mode
    if pending_gnss_mode_transition:
        state.temp_gnss1_coord.extra["gnss_mode_transition"] = pending_gnss_mode_transition
        state.temp_gnss1_coord.extra["gnss_transition_highlight"] = True
        pending_gnss_mode_transition = None

    # Update last GNSS coordinate for parking lot events
    last_gnss_coordinate = {"latitude": gnss_lat, "longitude": gnss_lon}
    return _SCAN_NEXT_TYPE


def _handle_gnss2_coord(state, coord_type, match, line, dlt_id, timestamp):
    global last_gnss_coordinate

    latitude = float(match.group(1)) / 10000000
    longitude = float(match.group(2)) / 10000000
    heading = float(match.group(3))
    speed = float(match.group(4))

    if latitude == 0.0 and longitude == 0.0:
        return _STOP_LINE

    state.flush_pending_raw_gnss()

    state.temp_gnss2_coord = Coordinate(
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
    return _SCAN_NEXT_TYPE


def _handle_dr_coord(state, coord_type, match, line, dlt_id, timestamp):
    latitude = float(match.group(1))
    longitude = float(match.group(2))
    speed = float(match.group(3))
    is_dr = int(match.group(4))
    heading = float(match.group(5))

    if latitude == 0.0 and longitude == 0.0:
        return _STOP_LINE

    if state.temp_gnss1_coord:
        _emit_gnss1_transition_lines(state, latitude, longitude)

    if state.temp_gnss2_coord:
        state.flush_pending_raw_gnss(state.current_id)

    dr_coordinate = Coordinate(
        id=state.current_id,
        dlt_id=dlt_id,
        type=coord_type,
        latitude=latitude,
        longitude=longitude,
        heading=heading,
        extra={"isDRGps": is_dr, "Speed": speed},
        timestamp=timestamp,
    )
    if state.pending_candidate_link_scores:
        dr_coordinate.extra["candidate_link_scores"] = state.pending_candidate_link_scores
        state.pending_candidate_link_scores = []

    if state.pending_mm_feedback_reason is not None:
        dr_coordinate.extra["mm_feedback"] = True
        dr_coordinate.extra["mm_feedback_reason"] = state.pending_mm_feedback_reason
        state.pending_mm_feedback_reason = None

    if state.pending_roll_pitch_resets:
        dr_coordinate.extra["roll_pitch_reset"] = True
        dr_coordinate.extra["roll_pitch_reset_events"] = state.pending_roll_pitch_resets
        state.pending_roll_pitch_resets = []

    COORDINATES[coord_type].append(dr_coordinate)
    state.last_dr_coordinate = dr_coordinate
    state.current_id += 1
    return _SCAN_NEXT_TYPE


def _emit_gnss1_transition_lines(state, dr_latitude, dr_longitude):
    """보류 중인 Filtered GNSS 좌표를 확정하고 DR 보정/연결선을 만든다."""
    gnss_coord = state.temp_gnss1_coord
    gnss_coord.id = state.current_id

    # DR correction must connect: previous DR -> current GNSS
    if state.last_dr_coordinate:
        dist = lat_lon_dist(
            gnss_coord.latitude,
            gnss_coord.longitude,
            state.last_dr_coordinate.latitude,
            state.last_dr_coordinate.longitude,
        )
        speed_val = gnss_coord.extra.get("Speed", 0.0)
        LINES[LineType.DR_CORRECTION].append(
            Line(
                id=state.current_id,
                type=LineType.DR_CORRECTION,
                start=(state.last_dr_coordinate.latitude, state.last_dr_coordinate.longitude),
                end=(gnss_coord.latitude, gnss_coord.longitude),
                timestamp=gnss_coord.timestamp,
                extra={"reason": f"dist={dist:.2f}m, speed={speed_val:.2f}"},
            )
        )

    LINES[LineType.GNSS_TO_DR].append(
        Line(
            id=state.current_id,
            type=LineType.GNSS_TO_DR,
            start=(gnss_coord.latitude, gnss_coord.longitude),
            end=(dr_latitude, dr_longitude),
            timestamp=gnss_coord.timestamp,
            extra={},
        )
    )
    COORDINATES[CoordType.GNSS1].append(gnss_coord)
    state.temp_gnss1_coord = None


def _handle_road_match_coord(state, coord_type, match, line, dlt_id, timestamp):
    # Road Match와 Route Match는 같은 패턴을 쓰고 [MM_RESULT] 유무로 갈린다.
    if "[MM_RESULT]" not in line:
        return _SCAN_NEXT_TYPE

    latitude, longitude, heading = map(float, match.groups())
    if latitude == 0.0 and longitude == 0.0:
        return _STOP_LINE

    road_coordinate = Coordinate(
        id=state.current_id - 1,
        dlt_id=dlt_id,
        type=coord_type,
        latitude=latitude,
        longitude=longitude,
        heading=heading,
        timestamp=timestamp,
        extra={"match_state": last_road_match_state if last_road_match_state else ""},
    )
    COORDINATES[coord_type].append(road_coordinate)
    state.last_road_match_coord = road_coordinate
    return _SCAN_NEXT_TYPE


def _handle_route_match_coord(state, coord_type, match, line, dlt_id, timestamp):
    if "[MM_RESULT]" in line:
        return _SCAN_NEXT_TYPE

    latitude, longitude, heading = map(float, match.groups())
    if latitude == 0.0 and longitude == 0.0:
        return _STOP_LINE

    route_coordinate = Coordinate(
        id=state.current_id - 1,
        dlt_id=dlt_id,
        type=coord_type,
        latitude=latitude,
        longitude=longitude,
        heading=heading,
        timestamp=timestamp,
        extra={"match_state": last_route_match_state if last_route_match_state else ""},
    )
    COORDINATES[coord_type].append(route_coordinate)
    state.last_route_match_coord = route_coordinate
    return _SCAN_NEXT_TYPE


def _handle_vpm_coord(state, coord_type, match, line, dlt_id, timestamp):
    latitude = float(match.group(1))
    longitude = float(match.group(2))
    heading = float(match.group(3))
    speed = float(match.group(4))
    match_dist = float(match.group(5)) if match.group(5) is not None else None
    facility_type = int(match.group(6)) if match.group(6) is not None else None

    if latitude == 0.0 and longitude == 0.0:
        return _STOP_LINE

    vpm = Coordinate(
        id=state.current_id - 1,
        dlt_id=dlt_id,
        type=coord_type,
        latitude=latitude,
        longitude=longitude,
        heading=heading,
        extra={"Speed": speed, "MatchDist": match_dist, "FacilityType": facility_type},
        timestamp=timestamp,
    )
    state.last_vpm_coordinate = vpm
    COORDINATES[coord_type].append(vpm)

    if state.last_dr_coordinate:
        LINES[LineType.DR_TO_VPM].append(
            Line(
                id=state.last_dr_coordinate.id,
                type=LineType.DR_TO_VPM,
                start=(state.last_dr_coordinate.latitude, state.last_dr_coordinate.longitude),
                end=(latitude, longitude),
                timestamp=timestamp if timestamp else state.last_dr_coordinate.timestamp,
            )
        )
    return _SCAN_NEXT_TYPE


def _handle_request_coord(state, coord_type, match, line, dlt_id, timestamp):
    global current_route_session_id, current_route_session_index

    anchor_lat, anchor_lon, anchor_heading = _resolve_request_anchor(state)
    if anchor_lat is None or anchor_lon is None:
        return _SCAN_NEXT_TYPE

    group2_value = int(match.group(2))
    group2_enum = RouteRequestType.get_type_by_value(group2_value)
    extra_info = {
        "group_1": match.group(1),
        "group_2_text": group2_enum.label,
        # Filled in when the TVAS session id for this request arrives
        "route_session_id": None,
    }

    if group2_enum == RouteRequestType.REROUTE_BREAKAWAY:
        _emit_deviation_line(state, timestamp)

    request_coordinate = Coordinate(
        id=state.current_id - 1,
        dlt_id=dlt_id,
        type=coord_type,
        latitude=anchor_lat,
        longitude=anchor_lon,
        heading=anchor_heading,
        extra=extra_info,
        timestamp=timestamp,
    )
    COORDINATES[coord_type].append(request_coordinate)
    state.pending_route_request_coords.append(request_coordinate)
    # Start a provisional per-request session so subsequent
    # setRouteInformation dumps group under THIS request even
    # when the TVAS session-id line is absent from the log.
    # A real session id (if logged) overrides this via backfill.
    current_route_session_id = f"REQ_{extra_info['group_1']}"
    current_route_session_index = 0
    request_coordinate.extra["route_session_id"] = current_route_session_id
    ROUTE_SESSION_CONTENT_IDS[current_route_session_id] = extra_info["group_1"]
    return _SCAN_NEXT_TYPE


def _resolve_request_anchor(state):
    """요청 마커를 붙일 위치.

    첫 맵매칭(VPM) 이전에 발생한 요청이 조용히 사라지지 않도록
    VPM -> DR -> raw GNSS 순으로 폴백한다.
    """
    request_anchor = state.last_vpm_coordinate or state.last_dr_coordinate
    if request_anchor is not None:
        return request_anchor.latitude, request_anchor.longitude, request_anchor.heading

    if last_gnss_coordinate:
        return last_gnss_coordinate.get("latitude"), last_gnss_coordinate.get("longitude"), None

    return None, None, None


def _emit_deviation_line(state, timestamp):
    """이탈 재탐색 요청에서 임계값을 넘긴 경우 이탈 선을 남긴다."""
    if not (last_threshold_info and state.last_road_match_coord and state.last_route_match_coord):
        return

    distance_exceeded = last_threshold_info["distance"] > last_threshold_info["distance_threshold"]
    angle_exceeded = last_threshold_info["angle_diff"] > last_threshold_info["angle_threshold"]
    if not (distance_exceeded or angle_exceeded):
        return

    if distance_exceeded and angle_exceeded:
        deviation_type = "both"
    elif distance_exceeded:
        deviation_type = "distance"
    else:
        deviation_type = "angle"

    LINES[LineType.DEVIATION].append(
        Line(
            id=state.current_id - 1,
            type=LineType.DEVIATION,
            start=(state.last_road_match_coord.latitude, state.last_road_match_coord.longitude),
            end=(state.last_route_match_coord.latitude, state.last_route_match_coord.longitude),
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


def parse_sdi_event(line, timestamp):
    """Parse SDI (Safety Drive Information) events from navisdk logs.

    GetSdiSelected select (0): 76, 15 nDist: 300, 500, wptPos: 37.545592, 126.978641
    GetSdiSelected select (0): skip due to distance: 15
    MapGuidingInformationProvider::onDriveStatusChanged SDI[15] CurrentSDI Speed : 50 ...

    The GetSdiSelected line reports two types: the best-so-far selection and the
    candidate being examined. The coordinates belong to the candidate, so that
    is what the marker is typed by; the best-so-far value is kept separately as
    context. Skip lines share the candidate index, which is how a rejection
    reason gets attached to the candidate it rejected.
    """
    global SDI_EVENTS

    drive_match = SDI_DRIVE_STATUS_PATTERN.search(line)
    if drive_match:
        sdi_type = int(drive_match.group(1))
        speed = int(drive_match.group(2))
        sdi_code = drive_match.group(4)
        # pt() here is (x, y) = (lon, lat).
        longitude = float(drive_match.group(5))
        latitude = float(drive_match.group(6))

        if not (30.0 < latitude < 45.0 and 120.0 < longitude < 135.0):
            return False

        SDI_EVENTS.append({
            "type": "SDI",
            "sdi_type": sdi_type,
            "speed": speed,
            "changeable_speed": (drive_match.group(3) == "1") if drive_match.group(3) else None,
            "sdi_code": sdi_code,
            "priority": int(drive_match.group(7)) if drive_match.group(7) else None,
            "latitude": latitude,
            "longitude": longitude,
            "source": "onDriveStatusChanged",
            "timestamp": timestamp,
        })
        return True

    select_match = SDI_SELECTED_PATTERN.search(line)
    if select_match:
        candidate_index = int(select_match.group(1))
        selected_type = int(select_match.group(2))
        # The candidate's own type — this is what wptPos belongs to.
        sdi_type = int(select_match.group(3))
        remain_dist = int(select_match.group(4))
        guide_dist = int(select_match.group(5))
        # wptPos is (y, x) = (lat, lon).
        latitude = float(select_match.group(6))
        longitude = float(select_match.group(7))

        if not (30.0 < latitude < 45.0 and 120.0 < longitude < 135.0):
            return False

        SDI_EVENTS.append({
            "type": "SDI",
            "sdi_type": sdi_type,
            "selected_type": selected_type,
            "candidate_index": candidate_index,
            "remain_dist": remain_dist,
            "guide_dist": guide_dist,
            "latitude": latitude,
            "longitude": longitude,
            "source": "GetSdiSelected",
            "timestamp": timestamp,
        })
        return True

    skip_match = SDI_SKIP_PATTERN.search(line)
    if skip_match:
        # Attach to the most recent candidate with this index — the skip line
        # always follows its candidate line within the same pass.
        candidate_index = int(skip_match.group(1))
        reason = skip_match.group(2).strip()
        # 'skip due to priority' logs two types (best-so-far, candidate); every
        # other variant logs one. The candidate is always the last number.
        skipped_type = int(skip_match.group(4) or skip_match.group(3))
        for event in reversed(SDI_EVENTS):
            if event.get("source") != "GetSdiSelected":
                continue
            if event.get("candidate_index") != candidate_index:
                continue
            if event.get("sdi_type") != skipped_type:
                continue
            event["skip_reason"] = reason
            return True
        # 'skip is not service' fires before the position line, so there is
        # nothing to attach it to; the candidate has no coordinates at all.
        return False

    return False


def parse_sdi_block_status(line, timestamp):
    """Collect the 구간단속 HUD values the navigation UI displays.

    The section plates (평균속도 / 남은거리) need Avg and Dist, which only the
    onDriveStatusChanged SDIBlock line carries; the section's own speed limit
    comes from GetSDIInfo's blockspeed, logged separately. Both are sampled over
    time so the HUD can follow the timeline instead of showing one frozen value.
    """
    global SDI_BLOCK_SAMPLES

    match = SDI_BLOCK_STATUS_PATTERN.search(line)
    if match:
        SDI_BLOCK_SAMPLES.append({
            "kind": "status",
            "state_from": int(match.group(1)),
            "state": int(match.group(2)),
            "speed": int(match.group(5)),
            "avg_speed": int(match.group(6)),
            "remain_dist": int(match.group(7)),
            "timestamp_ms": int(timestamp.timestamp() * 1000) if timestamp else 0,
        })
        return True

    match = SDI_BLOCK_INFO_PATTERN.search(line)
    if match and match.group(5) == "1":
        block_speed = int(match.group(4))
        if block_speed > 0:
            SDI_BLOCK_SAMPLES.append({
                "kind": "limit",
                "sdi_type": int(match.group(2)),
                "block_speed": block_speed,
                "timestamp_ms": int(timestamp.timestamp() * 1000) if timestamp else 0,
            })
            return True

    return False


LINK_FACIL_NAMES = {1: "교량", 2: "터널", 3: "고가도로", 4: "지하차도", 5: "교차로 통과"}
# IsShadeLink(link_util.h): 터널 또는 지하차도 — GPS 가 끊기는 구간.
SHADE_FACILS = (2, 4)


def parse_tunnel_check(line, timestamp):
    """터널·지하차도 진행 상태와 남은 거리를 모은다.

    이 로그는 GPS 주기마다 나오므로 그대로 타임라인이 된다. 음영 구간은 GPS 가
    끊겨 DR 이 위치를 끌고 가는 구간이라, 이 도구에서 특히 볼 값이다.
    """
    global SHADE_SAMPLES

    match = TUNNEL_CHECK_PATTERN.search(line)
    if not match:
        return False
    SHADE_SAMPLES.append({
        "facil": int(match.group(2)),
        "next_facil": int(match.group(3)),
        "length_to_end": int(match.group(4)),
        "timestamp_ms": int(timestamp.timestamp() * 1000) if timestamp else 0,
    })
    return True


def build_shade_timeline():
    """음영 구간(터널/지하차도) 샘플만 시간순으로 남긴다."""
    return [
        {
            "timestamp_ms": item["timestamp_ms"],
            "facil": item["facil"],
            "facil_name": LINK_FACIL_NAMES.get(item["facil"], f"시설 {item['facil']}"),
            "length_to_end": item["length_to_end"],
        }
        for item in sorted(SHADE_SAMPLES, key=lambda x: x["timestamp_ms"])
        if item["facil"] in SHADE_FACILS
    ]


def build_sdi_block_timeline():
    """Merge both sample kinds into one timeline of in-section states.

    Only samples taken inside a section (state == 1) reach the HUD; the limit is
    carried forward from the most recent GetSDIInfo blockspeed.
    """
    timeline = []
    current_limit = None
    for sample in sorted(SDI_BLOCK_SAMPLES, key=lambda item: item["timestamp_ms"]):
        if sample["kind"] == "limit":
            current_limit = sample["block_speed"]
            continue
        if sample["state"] != 1:
            continue
        timeline.append({
            "timestamp_ms": sample["timestamp_ms"],
            "speed": sample["speed"],
            "avg_speed": sample["avg_speed"],
            "remain_dist": sample["remain_dist"],
            "block_speed": current_limit,
            "entered": sample["state_from"] != 1,
        })
    return timeline


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


def parse_route_request_points(line):
    """Collect per-request depart/waypoint/destination points (SK coordinates)."""
    match = ROUTE_REQ_WAYPOINT_PATTERN.search(line)
    if match:
        entry = ROUTE_REQUEST_POINTS.setdefault(match.group(1), {"waypoints": {}})
        entry.setdefault("waypoints", {})[int(match.group(2))] = {
            "name": match.group(4).strip(),
            "fixed": int(match.group(3)),
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


# Generated from benz-ivi2 module/navisdk/src/include/rg_def.h (SDI_Type).
# Ordinals come from declaration order: the numbers in that enum's comments
# drifted when the backside types were inserted, so they cannot be used.
SDI_TYPE_NAMES = {
    0: "신호과속",  # SDI_SPEED_ACCIDENT_POS
    1: "과속 (고정식)",  # SDI_SPEED_LIMIT_POS
    2: "구간단속 시작",  # SDI_SPEED_BLOCK_START_POS
    3: "구간단속 끝",  # SDI_SPEED_BLOCK_END_POS
    4: "구간단속중",  # SDI_SPEED_BLOCK_MID_POS
    5: "꼬리물기단속카메라",  # SDI_TAIL
    6: "신호 단속",  # SDI_SIGNAL_ACCIDENT_POS
    7: "과속 (이동식)",  # SDI_SPEED_LIMIT_DANGEROUS_AREA
    8: "고정식 과속위험 구간(박스형)",  # SDI_BOX_SPEED_LIMIT_POS
    9: "후면신호과속단속카메라",  # SDI_SPEED_ACCIDENT_BACKSIDE_POS
    10: "후면과속단속카메라",  # SDI_SPEED_LIMIT_BACKSIDE_POS
    11: "버스전용차로구간",  # SDI_BUS_LANE
    12: "가변 차로 단속",  # SDI_CHANGEROAD_POS
    13: "갓길 감시 지점",  # SDI_ROAD_CONTROL_POS
    14: "끼어들기 금지",  # SDI_INTRUDER_AREA
    15: "교통정보 수집지점",  # SDI_TRAFFICINFO_COLLECT_POS
    16: "방범용CCTV(신규)",  # SDI_CCTV_AREA
    17: "과적차량 위험구간",  # SDI_OVERLOAD_DANGEROUS_AREA
    18: "적재 불량 단속",  # SDI_LOAD_BAD_CONTROL_POS
    19: "주차단속 지점",  # SDI_PARKING_CONTROL_POS
    20: "일방통행도로 (신규)",  # SDI_ONE_WAY_AREA
    21: "철길 건널목",  # SDI_RAILWAY_CROSSING
    22: "어린이 보호구역(스쿨존 시작 구간)",  # SDI_SCHOOL_ZONE_START
    23: "어린이 보호구역(스쿨존 끝 구간 )",  # SDI_SCHOOL_ZONE_END
    24: "과속방지턱",  # SDI_SPEEDBUMP
    25: "LPG충전소",  # SDI_LPG_STATION
    26: "터널 구간",  # SDI_TUNNEL_AREA
    27: "휴게소",  # SDI_SERVICE_AREA
    28: "톨게이트",  # SDI_TOLLGATE
    29: "안개주의 지역",  # SDI_FOG_AREA
    30: "유해물질 지역",  # SDI_HAZARDOUS_AREA
    31: "사고다발",  # SDI_ACCIDEDNT_AREA
    32: "급커브지역",  # SDI_SHARP_CURVE_AREA
    33: "급커브구간1 (신규)",  # SDI_NEW_CURVE_AREA
    34: "급경사구간 (신규)",  # SDI_SLOPE_AREA
    35: "야생동물 교통사고 잦은 구간",  # SDI_ROAD_KILL_AREA
    36: "우측시야불량지점(신규)",  # SDI_VISUAL_RIGHT_AREA
    37: "시야불량지점(신규)",  # SDI_VISUAL_FRONT_AREA
    38: "좌측시야불량지점(신규)",  # SDI_VISUAL_LEFT_AREA
    39: "신호위반다발구간(신규)",  # SDI_SIGNAL_VIOLATION_AREA
    40: "과속운행다발구간(신규)",  # SDI_SPEED_DRIVING_AREA
    41: "교통혼잡지역(신규)",  # SDI_TRAFFIC_CONGEST_AREA
    42: "방향별차로선택지점(신규)",  # SDI_DIRECTION_LANE
    43: "무단횡단사고다발지점(신규)",  # SDI_WALK_CROSS_AREA
    44: "갓길 사고 다발 지점 (신규)",  # SDI_ROAD_ACCIDEDNT_AREA
    45: "과속 사발 다발 지점 (신규)",  # SDI_SPEED_ACCIDEDNT_AREA
    46: "졸음 사고 다발 지점 (신규)",  # SDI_SLEEP_ACCIDEDNT_AREA
    47: "사고다발지점",  # SDI_ACCIDENT_POS
    48: "보행자 사고다발지점",  # SDI_PEDESTRIAN_ACCIDENT_POS
    49: "노인보호구역",  # SDI_SILVER_ZONE
    50: "차량도난사고 상습발생지점",  # SDI_VEHICLE_BURGLARY_POS
    51: "낙석주의지역",  # SDI_FALLING_AREA
    52: "결빙주의지역",  # SDI_FREEZING_AREA
    53: "병목지점",  # SDI_BOTTLENECK_POINT
    54: "합류 도로",  # SDI_MERGE_POINT
    55: "추락주의지역",  # SDI_CRASH_AREA
    56: "지하차도 구간",  # SDI_UNDERGROUND_AREA
    57: "주택밀집지역(교통진정지역)",  # SDI_TRAFFIC_CALMING_AREA
    58: "인터체인지",  # SDI_INTERCHANGE
    59: "분기점",  # SDI_JUNCTION
    60: "휴게소(LPG충전가능)",  # SDI_SERVICE_AREA_LPG
    61: "교량",  # SDI_BRIDGE
    62: "제동장치사고다발지점",  # SDI_HWA03
    63: "중앙선침범사고다발지점",  # SDI_HWA06
    64: "통행위반사고다발지점",  # SDI_HWA09
    65: "목적지 건너편 안내(Tmap 전용, GP 203을 변경해서 사용)",  # SDI_GOAL_OPPOSITE
    66: "졸음 쉼터 안내(Tmap 전용, GP 150을 변경해서 사용)",  # SDI_REST_PLACE
    67: "노후경유차단속(8.0 신규)",  # SDI_EXHAUST_GAS_GRADE
    68: "터널내 차로변경단속(8.0신규 - 데이터는 내려오지 않음).",  # SDI_TUNNEL_CHANGE_LANE_POS
    69: "후면구간단속 시점",  # SDI_SPEED_BLOCK_BACKSIDE_START_POS
    70: "후면구간단속 종점",  # SDI_SPEED_BLOCK_BACKSIDE_END_POS
    71: "후면신호과속구간단속 시점",  # SDI_SPEED_BLOCK_BACKSIDE_SIGNAL_START_POS
    72: "후면신호과속구간단속 종점",  # SDI_SPEED_BLOCK_BACKSIDE_SIGNAL_END_POS
    73: "신호과속구간단속 시점",  # SDI_SIGNAL_SPEED_BLOCK_START_POS
    74: "신호과속구간단속 종점",  # SDI_SIGNAL_SPEED_BLOCK_END_POS
    75: "SDI_UNKNOWN",  # SDI_UNKNOWN
    76: "SDI_MAX",  # SDI_MAX
}

# stSelected.nType starts at SDI_MAX and means 'nothing selected yet'.
SDI_TYPE_MAX = 76


def build_sdi_markers():
    """Convert SDI_EVENTS to marker format.

    GetSdiSelected logs every candidate on every pass, so the same SDI appears
    many times. Candidates are collapsed by (type, position) while keeping the
    number of observations and the rejection reasons seen, which is what tells
    you whether an SDI was ever actually used.
    """
    if not SDI_EVENTS:
        return []

    markers = []
    event_id_counter = 20000  # Start from 20000 to avoid conflicts
    by_key = {}

    for event in SDI_EVENTS:
        key = (event["sdi_type"], round(event["latitude"], 6), round(event["longitude"], 6))
        record = by_key.get(key)
        if record is None:
            record = dict(event)
            record["observation_count"] = 0
            record["skip_reasons"] = []
            record["ever_selected"] = False
            by_key[key] = record

        record["observation_count"] += 1
        # Each source knows different things about the same SDI: GetSdiSelected
        # has the distances, onDriveStatusChanged has the speed limit and
        # priority. Fill in whatever the record is still missing.
        for field in ("speed", "priority", "changeable_speed", "sdi_code",
                      "guide_dist", "candidate_index", "selected_type"):
            if record.get(field) is None and event.get(field) is not None:
                record[field] = event[field]
        reason = event.get("skip_reason")
        if reason:
            if reason not in record["skip_reasons"]:
                record["skip_reasons"].append(reason)
        elif event.get("source") == "GetSdiSelected":
            # A candidate line with no skip line after it survived the filters.
            record["ever_selected"] = True
        elif event.get("source") == "onDriveStatusChanged":
            # Reported as the current SDI to the UI — selected by definition.
            record["ever_selected"] = True

        # Keep the closest approach; that is the most informative distance.
        remain = event.get("remain_dist")
        if remain is not None:
            previous = record.get("remain_dist")
            if previous is None or remain < previous:
                record["remain_dist"] = remain

    for record in by_key.values():
        sdi_type = record["sdi_type"]
        type_name = SDI_TYPE_NAMES.get(sdi_type, f"SDI Type {sdi_type}")
        selected_type = record.get("selected_type")

        marker = {
            "id": event_id_counter,
            "dlt_id": None,
            "type": "SDI Event",
            "latitude": record["latitude"],
            "longitude": record["longitude"],
            "heading": None,
            "extra": {
                "event_type": "SDI",
                "sdi_type": sdi_type,
                "sdi_type_name": type_name,
                "speed": record.get("speed"),
                "changeable_speed": record.get("changeable_speed"),
                # Asset name the navigation UI uses for this SDI's icon.
                "sdi_code": record.get("sdi_code"),
                "priority": record.get("priority"),
                "remain_dist": record.get("remain_dist"),
                "guide_dist": record.get("guide_dist"),
                "candidate_index": record.get("candidate_index"),
                # Best-so-far selection at the time this candidate was examined;
                # SDI_MAX means nothing had been selected yet.
                "selected_type": selected_type,
                "selected_type_name": (
                    None if selected_type is None or selected_type >= SDI_TYPE_MAX
                    else SDI_TYPE_NAMES.get(selected_type, f"SDI Type {selected_type}")
                ),
                "observation_count": record["observation_count"],
                "skip_reasons": record["skip_reasons"],
                "ever_selected": record["ever_selected"],
                "source": record.get("source", ""),
                "sdi_event": True,
            },
            "timestamp_ms": int(record["timestamp"].timestamp() * 1000) if record["timestamp"] else 0,
            "timestamp_str": record["timestamp"].strftime("%Y/%m/%d %H:%M:%S.%f")[:-3] if record["timestamp"] else "",
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
    # 이벤트가 붙은 DR 좌표(MM feedback / roll-pitch reset)에 변화량을 계산해 붙인다
    attach_dr_event_deltas(all_coords)

    parking_lot_state_markers = build_parking_lot_state_markers(all_coords)
    roll_pitch_reset_markers = build_roll_pitch_reset_markers(all_coords)
    gnss_outlier_markers = build_gnss_outlier_markers(all_coords)
    import sys
    print(f'[DEBUG] build_runtime_payload: parking markers = {len(parking_lot_state_markers)}, roll/pitch markers = {len(roll_pitch_reset_markers)}', file=sys.stderr)

    # Attach per-link GP / turnCode info to the route links themselves so the
    # Route Info layer shows the guidance decision for each link.
    attached_guides = attach_guide_info_to_route_lines(all_lines)
    print(f'[DEBUG] build_runtime_payload: guide info attached to {attached_guides} route links', file=sys.stderr)

    # Convert guide events and route info to marker coordinates
    all_coords.extend(build_guide_event_markers())
    all_coords.extend(build_sdi_markers())
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
        "roll_pitch_reset_markers": roll_pitch_reset_markers,
        "gnss_outlier_markers": gnss_outlier_markers,
        "sdi_block_timeline": build_sdi_block_timeline(),
        "shade_timeline": build_shade_timeline(),
        "lines": all_lines,
    }


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


_COORD_HANDLERS = {
    CoordType.GNSS1: _handle_gnss1_coord,
    CoordType.GNSS2: _handle_gnss2_coord,
    CoordType.DR: _handle_dr_coord,
    CoordType.ROAD_MATCH: _handle_road_match_coord,
    CoordType.ROUTE_MATCH: _handle_route_match_coord,
    CoordType.VPM: _handle_vpm_coord,
    CoordType.REQUEST: _handle_request_coord,
}
