"""GP(안내지점) 데이터의 순수 계산 로직.

경로 링크 정렬, 링크 순번 매핑, 레코드 병합, 차선 버블 마커 생성 등
수집된 GP 레코드를 입력으로만 받아 계산하는 부분을 모았다.
"""


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

# LaneColor enum (rgdata_def.h) -> marker colour for the drive-time lane events
LANE_COLOR_HEX = {
    0: "#64748b",  # NONE
    1: "#22c55e",  # GREEN
    2: "#ec4899",  # PINK
    3: "#3b82f6",  # BLUE
    4: "#eab308",  # YELLOW
}

# nVoiceCode -> LaneColor, exactly as RGPlayer.cpp ToLaneColor() maps it. nVoiceCode
# is logged by the upstream 'ServiceDataCollect #2' line, so the lane bubble colour
# can be derived without the locally-added [LANE_COLOR] logs.
LANE_COLOR_BY_VOICE_CODE = {65: 1, 66: 2, 67: 3, 68: 4}


def lane_color_from_voice_code(voice_code):
    """LaneColor value for a voice code (0 = NONE)."""
    if voice_code is None:
        return 0
    return LANE_COLOR_BY_VOICE_CODE.get(int(voice_code), 0)


def decode_gp_type_flags(gp_type):
    """Split an nGPType value into its RG_GPTYPE flag names."""
    if not gp_type:
        return []
    return [name for mask, name in GP_TYPE_FLAGS if gp_type & mask]


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
