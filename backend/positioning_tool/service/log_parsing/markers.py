"""수집 결과를 프론트엔드 마커 형태로 바꾸는 순수 변환기.

입력으로 받은 좌표/라인 목록만 사용하며 전역 상태를 참조하지 않는다.
"""


def build_parking_lot_state_bands(coords):
    """주차장 상태가 이어지는 DR 구간을 밑면 띠(폴리라인) 세그먼트로 묶는다.

    점마다 마커를 찍는 대신 연속 구간 하나를 띠 하나로 표현한다. 상태 구분:
      ParkingLot(주차장 모드): 진분홍 / EnterCandidate·EnterReady(진입 후보/준비): 연분홍
    """
    dr_coords = [c for c in coords if c.get('type') == 'DR-based']
    dr_coords.sort(key=lambda c: (c.get('id') or 0))

    def state_group(parking_state):
        if parking_state == 'ParkingLot':
            return ('ParkingLot', '#db2777')
        if parking_state in ('EnterCandidate', 'EnterReady'):
            return ('Enter', '#f9a8d4')
        return (None, None)

    bands = []
    band_id_counter = 30000  # Start from 30000 to avoid conflicts
    current = None

    def close_current():
        nonlocal current, band_id_counter
        if current is not None:
            current['id'] = band_id_counter
            band_id_counter += 1
            bands.append(current)
        current = None

    for coord in dr_coords:
        parking_state = coord.get('extra', {}).get('parking_state')
        group, color = state_group(parking_state)
        if group is None:
            close_current()
            continue

        if current is not None and current['state_group'] != group:
            close_current()

        if current is None:
            current = {
                "type": "Parking Lot State",
                "state_group": group,
                "color": color,
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
        if parking_state not in current['states']:
            current['states'].append(parking_state)
        current['end_dlt_id'] = coord.get('dlt_id')
        current['end_timestamp_ms'] = coord.get('timestamp_ms')
        current['end_timestamp_str'] = coord.get('timestamp_str')

    close_current()

    import sys
    print(f'[DEBUG] build_parking_lot_state_bands: DR-based={len(dr_coords)}, bands created={len(bands)}', file=sys.stderr)
    return bands


def build_roll_pitch_reset_markers(coords):
    """Extract DR-based coordinates where roll/pitch was reset (정차) as markers."""
    markers = []
    marker_id_counter = 50000  # Start from 50000 to avoid conflicts

    for coord in coords:
        if coord.get('type') != 'DR-based':
            continue

        events = coord.get('extra', {}).get('roll_pitch_reset_events')
        if not events:
            continue

        event_names = {event.get('event') for event in events}
        # 보라 계열로 통일:
        #   SetRollPitchFromAccelerometer: 정차 중 가속도계 기반 자동 초기화 (진보라)
        #   ResetRollPitch: MM feedback 기반 강제 초기화 (연보라)
        if 'SetRollPitchFromAccelerometer' in event_names:
            color = '#7c3aed'
        else:
            color = '#c084fc'

        marker = {
            "id": marker_id_counter,
            "dlt_id": coord.get('dlt_id'),
            "type": "Roll/Pitch Reset",
            "latitude": coord.get("latitude"),
            "longitude": coord.get("longitude"),
            "heading": coord.get("heading"),
            "color": color,
            "fill": True,
            "timestamp_ms": coord.get("timestamp_ms"),
            "timestamp_str": coord.get("timestamp_str"),
            "extra": {
                "roll_pitch_reset_events": events,
                "Speed": coord.get('extra', {}).get('Speed'),
            }
        }
        markers.append(marker)
        marker_id_counter += 1

    return markers


def build_mm_feedback_markers(coords):
    """Extract DR-based coordinates with an MM feedback correction as markers."""
    markers = []
    marker_id_counter = 60000  # Start from 60000 to avoid conflicts

    for coord in coords:
        if coord.get('type') != 'DR-based':
            continue

        extra = coord.get('extra', {})
        if not extra.get('mm_feedback'):
            continue

        reason = str(extra.get('mm_feedback_reason', '')).lower()
        # 무채색 계열로 통일:
        #   위치 보정 (clamped / force correction): 진한 무채색
        #   헤딩만 보정 (heading only / correction normal): 연한 무채색
        if "heading only" in reason or "correction normal" in reason:
            color = '#9ca3af'
        else:
            color = '#111827'

        marker = {
            "id": marker_id_counter,
            "dlt_id": coord.get('dlt_id'),
            "type": "MM Feedback",
            "latitude": coord.get("latitude"),
            "longitude": coord.get("longitude"),
            "heading": coord.get("heading"),
            "color": color,
            "fill": True,
            "timestamp_ms": coord.get("timestamp_ms"),
            "timestamp_str": coord.get("timestamp_str"),
            "extra": {
                "mm_feedback_reason": extra.get('mm_feedback_reason', ''),
                "Speed": extra.get('Speed'),
            }
        }
        markers.append(marker)
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
