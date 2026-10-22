"""한 줄만 보고 값을 뽑아내는 순수 파서들.

전역 상태를 읽거나 쓰지 않는다. 입력은 로그 한 줄, 출력은 dict/스칼라뿐이다.
"""

import math
import os
import re
from datetime import datetime

from backend.positioning_tool.service.log_parsing.patterns import (
    GNSS_OUTLIER_REJECTED_PATTERN,
    GNSS_OUTLIER_CANDIDATES_PATTERN,
    GNSS_OUTLIER_STATE_PATTERN,
    CANDIDATE_LINK_PATTERN,
    GNSS_MODE_EVENT_PATTERN,
    GNSS_MODE_INLINE_PATTERN,
    LINK_EXTRAPOINT_PATTERN,
    SET_ROUTE_INFORMATION_PATTERN,
    TVAS_HEADER_ROUTE_OPT_PATTERN,
    TVAS_HEADER_SERVICE_CNT_PATTERN,
    TVAS_HEADER_TOTAL_DIST_PATTERN,
    TVAS_HEADER_TOTAL_TIME_PATTERN,
    TVAS_SERVER_SESSION_PATTERN,
)

EARTH_RADIUS = 6371000.0
DEG2RAD = math.pi / 180.0


def lat_lon_dist(lat1, lon1, lat2, lon2):
    local_x = -(((lon2 - lon1) * DEG2RAD) * math.cos(DEG2RAD * lat1)) * EARTH_RADIUS
    local_y = ((lat2 - lat1) * DEG2RAD) * EARTH_RADIUS
    return math.sqrt((local_x * local_x) + (local_y * local_y))


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


def _parse_outlier_candidate_ids(line):
    """rejected 줄의 선택 필드 candidates=[...] 를 링크 ID 리스트로. 없으면 []."""
    match = GNSS_OUTLIER_CANDIDATES_PATTERN.search(line)
    if not match:
        return []
    raw = match.group(1) if match.group(1) is not None else match.group(2)
    return [int(token) for token in re.split(r"[,\s/]+", raw) if token.isdigit()]


def parse_gnss_outlier_info(line):
    """GnssFilter의 outlier 판정 로그. rejected 상세 또는 상태 전환을 돌려준다."""
    rejected = GNSS_OUTLIER_REJECTED_PATTERN.search(line)
    if rejected:
        return {
            "rejected": {
                "raw_latitude": float(rejected.group(1)),
                "raw_longitude": float(rejected.group(2)),
                "nearest_link_id": int(rejected.group(3)),
                "dist_m": float(rejected.group(4)),
                "width_m": float(rejected.group(5)),
                "ext_lane": int(rejected.group(6)),
                "center_latitude": float(rejected.group(7)) if rejected.group(7) else None,
                "center_longitude": float(rejected.group(8)) if rejected.group(8) else None,
                "center_dist_m": float(rejected.group(9)),
                "link_count": int(rejected.group(10)),
                "candidate_link_ids": _parse_outlier_candidate_ids(line),
            }
        }

    state = GNSS_OUTLIER_STATE_PATTERN.search(line)
    if state:
        return {
            "transition": {
                "from": state.group(1),
                "to": state.group(2),
                "link_count": int(state.group(3)),
                "center_latitude": float(state.group(4)) if state.group(4) else None,
                "center_longitude": float(state.group(5)) if state.group(5) else None,
            }
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
