"""수집 결과를 프론트엔드 마커 형태로 바꾸는 순수 변환기.

입력으로 받은 좌표/라인 목록만 사용하며 전역 상태를 참조하지 않는다.
"""

import math
import re

_EARTH_RADIUS_M = 6371000.0
_DEG2RAD = math.pi / 180.0
_NUM_KV_PATTERN = re.compile(r"([A-Za-z_]+)\s*=\s*(-?\d+(?:\.\d+)?)")


def _lat_lon_dist_m(lat1, lon1, lat2, lon2):
    local_x = -(((lon2 - lon1) * _DEG2RAD) * math.cos(_DEG2RAD * lat1)) * _EARTH_RADIUS_M
    local_y = ((lat2 - lat1) * _DEG2RAD) * _EARTH_RADIUS_M
    return math.sqrt(local_x * local_x + local_y * local_y)


def _heading_delta_deg(prev_heading, heading):
    return (heading - prev_heading + 180.0) % 360.0 - 180.0


def _parse_numeric_fields(text):
    return {key: float(value) for key, value in _NUM_KV_PATTERN.findall(text or '')}


def attach_dr_event_deltas(coords):
    """MM feedback / roll-pitch reset이 붙은 DR 좌표에 변화량을 계산해 붙인다.

    - delta_dist_m / delta_heading_deg: 직전 DR 좌표 대비 이 좌표가 얼마나
      움직였는지(보정/초기화 직후 궤적이 튄 정도).
    - roll_pitch_reset_events[*].values / delta_roll / delta_pitch: 로그의
      before/after 각도와 그 차이.
    - feedback_values / feedback_heading_delta: MM feedback 사유 문자열의
      수치들(dist, laneWidth, dr, feedback ...)과 헤딩 보정량.
    """
    dr_coords = [c for c in coords if c.get('type') == 'DR-based']
    dr_coords.sort(key=lambda c: (c.get('id') or 0))

    prev = None
    for coord in dr_coords:
        extra = coord.get('extra', {})
        is_event = extra.get('mm_feedback') or extra.get('roll_pitch_reset')

        if is_event and prev is not None:
            try:
                extra['delta_dist_m'] = round(_lat_lon_dist_m(
                    prev.get('latitude'), prev.get('longitude'),
                    coord.get('latitude'), coord.get('longitude')), 2)
            except (TypeError, ValueError):
                pass
            prev_heading = prev.get('heading')
            heading = coord.get('heading')
            if isinstance(prev_heading, (int, float)) and isinstance(heading, (int, float)):
                extra['delta_heading_deg'] = round(_heading_delta_deg(prev_heading, heading), 2)

        if extra.get('mm_feedback'):
            values = _parse_numeric_fields(extra.get('mm_feedback_reason', ''))
            if values:
                extra['feedback_values'] = values
            if 'dr' in values and 'feedback' in values:
                extra['feedback_heading_delta'] = round(
                    _heading_delta_deg(values['dr'], values['feedback']), 2)

        for event in extra.get('roll_pitch_reset_events', []) or []:
            values = _parse_numeric_fields(event.get('detail', ''))
            if values:
                event['values'] = values
            if 'before_roll' in values and 'after_roll' in values:
                event['delta_roll'] = round(values['after_roll'] - values['before_roll'], 3)
            if 'before_pitch' in values and 'after_pitch' in values:
                event['delta_pitch'] = round(values['after_pitch'] - values['before_pitch'], 3)

        prev = coord


def build_parking_lot_state_markers(coords):
    """주차장 상태가 붙은 DR 좌표를 점 마커로 추출한다.
    회색 = ParkingLot(주차장 모드), 핑크 = EnterCandidate·EnterReady(진입 평가/준비)."""
    markers = []
    marker_id_counter = 30000  # Start from 30000 to avoid conflicts

    for coord in coords:
        if coord.get('type') != 'DR-based':
            continue

        parking_state = coord.get('extra', {}).get('parking_state')
        if parking_state == 'ParkingLot':
            color = '#808080'
        elif parking_state in ('EnterCandidate', 'EnterReady'):
            color = '#ff1493'
        else:
            continue

        markers.append({
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
        })
        marker_id_counter += 1

    return markers


def build_roll_pitch_reset_markers(coords):
    """정차 중 roll/pitch가 초기화된 DR 좌표를 점 마커로 추출한다 (보라).
    attach_dr_event_deltas 가 먼저 돌아 이벤트 상세/변화량이 extra 에 있어야 한다."""
    markers = []
    marker_id_counter = 50000  # Start from 50000 to avoid conflicts

    for coord in coords:
        if coord.get('type') != 'DR-based':
            continue

        extra = coord.get('extra', {})
        events = extra.get('roll_pitch_reset_events')
        if not events:
            continue

        markers.append({
            "id": marker_id_counter,
            "dlt_id": coord.get('dlt_id'),
            "type": "Roll/Pitch Reset",
            "latitude": coord.get("latitude"),
            "longitude": coord.get("longitude"),
            "heading": coord.get("heading"),
            "color": '#7c3aed',
            "fill": True,
            "timestamp_ms": coord.get("timestamp_ms"),
            "timestamp_str": coord.get("timestamp_str"),
            "extra": {
                "roll_pitch_reset_events": events,
                "Speed": extra.get('Speed'),
                "delta_dist_m": extra.get('delta_dist_m'),
                "delta_heading_deg": extra.get('delta_heading_deg'),
            }
        })
        marker_id_counter += 1

    return markers


def build_gnss_outlier_markers(coords):
    """GnssFilter가 outlier로 버린 Raw GNSS 좌표를 점 마커로 추출한다 (진한 보라 링).
    Raw GNSS 행 하위 레이어로 표시되며 Raw GNSS 점 위에 겹쳐 그린다."""
    markers = []
    marker_id_counter = 60000  # Roll/Pitch Reset(50000~)과 겹치지 않게

    for coord in coords:
        if coord.get('type') != 'Raw GNSS':
            continue

        extra = coord.get('extra', {})
        outlier = extra.get('gnss_outlier')
        if not outlier:
            continue

        markers.append({
            "id": marker_id_counter,
            "dlt_id": coord.get('dlt_id'),
            "type": "GNSS Outlier",
            "latitude": coord.get("latitude"),
            "longitude": coord.get("longitude"),
            "heading": coord.get("heading"),
            "color": '#4c1d95',
            "fill": False,
            "timestamp_ms": coord.get("timestamp_ms"),
            "timestamp_str": coord.get("timestamp_str"),
            "extra": {
                "gnss_outlier": outlier,
                "gnss_outlier_transition": extra.get('gnss_outlier_transition'),
                "Speed": extra.get('Speed'),
            }
        })
        marker_id_counter += 1

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
