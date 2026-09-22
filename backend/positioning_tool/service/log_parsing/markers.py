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


def _build_state_bands(coords, coord_type, band_type, classify, id_start):
    """상태가 이어지는 좌표 구간을 밑면 띠(폴리라인) 세그먼트로 묶는 공통 빌더.

    점마다 마커를 찍는 대신 연속 구간 하나를 띠 하나로 표현한다.
    classify(coord) 는 (group_key, color, outline_color, state_label) 을 돌려주고,
    group_key 가 None 이면 그 좌표는 띠에 포함되지 않는다(구간이 끊긴다).
    outline_color 는 띠 가장자리에 얇은 실선으로 그려져 구간 경계를 또렷하게 한다.
    """
    typed_coords = [c for c in coords if c.get('type') == coord_type]
    typed_coords.sort(key=lambda c: (c.get('id') or 0))

    bands = []
    band_id_counter = id_start
    current = None

    def close_current():
        nonlocal current, band_id_counter
        if current is not None:
            current['id'] = band_id_counter
            band_id_counter += 1
            bands.append(current)
        current = None

    for coord in typed_coords:
        group, color, outline_color, state_label = classify(coord)
        if group is None:
            close_current()
            continue

        if current is not None and current['state_group'] != group:
            close_current()

        if current is None:
            current = {
                "type": band_type,
                "state_group": group,
                "color": color,
                "outline_color": outline_color,
                "points": [],
                "states": [],
                "start_dlt_id": coord.get('dlt_id'),
                "end_dlt_id": coord.get('dlt_id'),
                "start_timestamp_ms": coord.get('timestamp_ms'),
                "end_timestamp_ms": coord.get('timestamp_ms'),
                "start_timestamp_str": coord.get('timestamp_str'),
                "end_timestamp_str": coord.get('timestamp_str'),
            }

        current['points'].append([coord.get('latitude'), coord.get('longitude')])
        if state_label not in current['states']:
            current['states'].append(state_label)
        current['end_dlt_id'] = coord.get('dlt_id')
        current['end_timestamp_ms'] = coord.get('timestamp_ms')
        current['end_timestamp_str'] = coord.get('timestamp_str')

    close_current()
    return bands


def build_parking_lot_state_bands(coords):
    """주차장 상태 DR 구간 띠. 페이지 범례와 같은 색을 쓴다:
    회색 = ParkingLot(주차장 모드), 핑크 = EnterCandidate·EnterReady(진입 평가/준비)."""
    def classify(coord):
        parking_state = coord.get('extra', {}).get('parking_state')
        if parking_state == 'ParkingLot':
            return ('ParkingLot', '#808080', '#4b5563', parking_state)
        if parking_state in ('EnterCandidate', 'EnterReady'):
            return ('Enter', '#ff1493', '#c2185b', parking_state)
        return (None, None, None, None)

    bands = _build_state_bands(coords, 'DR-based', 'Parking Lot State', classify, 30000)
    import sys
    print(f'[DEBUG] build_parking_lot_state_bands: bands created={len(bands)}', file=sys.stderr)
    return bands


def build_gnss_mode_bands(coords):
    """Filtered GNSS 모드 구간 띠. 점 색 대신 밑면 띠로 모드를 표현한다.
    연청록 = Normal, 연마젠타 = BusSleep, 회색 = 그 외 모드."""
    def classify(coord):
        mode = str(coord.get('extra', {}).get('gnss_mode', '') or '').strip()
        if not mode:
            return (None, None, None, None)
        if mode == 'Normal':
            return ('Normal', '#99f6e4', '#2dd4bf', mode)
        if mode == 'BusSleep':
            return ('BusSleep', '#e879f9', '#c026d3', mode)
        return (mode, '#cbd5e1', '#94a3b8', mode)

    return _build_state_bands(coords, 'Filtered GNSS', 'GNSS Mode', classify, 35000)


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
