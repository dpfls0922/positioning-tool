"""수집 결과를 프론트엔드 마커 형태로 바꾸는 순수 변환기.

입력으로 받은 좌표/라인 목록만 사용하며 전역 상태를 참조하지 않는다.
"""


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
