"""DLT 로그에서 SDI 를 읽어 타일 / 메시 단위로 묶어 둔다.

SDI 원본(SAFE_DRIVE_DB 의 NDSAFEDAT)은 레코드 포맷이 공개되어 있지 않아,
지금은 이미 검증된 경로 - positioning-tool 의 로그 파서 - 를 그대로 쓴다.
로그에 GetSdiSelected / onDriveStatusChanged 로 찍힌 SDI 가 곧 단말이 실제로
그 타일에서 꺼내 쓴 SDI 다.
"""

import math

from backend.tile_tool.service import geo_service as geo


class LogParserUnavailable(RuntimeError):
    pass


def _log_parser():
    """DLT 파서는 positioning-tool 쪽에 있다.

    이 툴만 따로 떼어 가면 그 패키지가 없을 수 있어서, 로그를 실제로 읽을 때만
    가져온다. 없으면 로그 대조 기능만 빠지고 나머지는 그대로 돈다.
    """
    try:
        from backend.positioning_tool.service import log_parser_service
    except ImportError as ex:
        raise LogParserUnavailable(
            "주행 로그 파싱은 positioning-tool 패키지가 있어야 합니다"
            " (backend/positioning_tool). SDI 원본 조회는 이것 없이도 동작합니다."
        ) from ex
    return log_parser_service


class SdiSource:
    """마지막으로 읽어들인 SDI 집합. 앱 하나에 하나만 둔다."""

    _points: list = []
    _source_name: str = ""

    @classmethod
    def load_from_log(cls, log_file_path, source_name):
        log_parser = _log_parser()
        log_parser.reset_runtime_state()
        if not log_parser.parse_log(log_file_path):
            return None

        points = [_to_point(marker) for marker in log_parser.build_sdi_markers()]
        points = [point for point in points if point is not None]
        points.sort(key=lambda point: (point["tile"]["y"], point["tile"]["x"], point["sdi_type"]))
        cls._points = points
        cls._source_name = source_name
        return cls.summary()

    @classmethod
    def clear(cls):
        cls._points = []
        cls._source_name = ""

    @classmethod
    def points(cls):
        return cls._points

    @classmethod
    def summary(cls):
        tiles = {}
        meshes = {}
        for point in cls._points:
            tiles[point["tile"]["id"]] = tiles.get(point["tile"]["id"], 0) + 1
            meshes[point["mesh_code"]] = meshes.get(point["mesh_code"], 0) + 1
        return {
            "source_name": cls._source_name,
            "total": len(cls._points),
            "tile_count": len(tiles),
            "mesh_count": len(meshes),
            # 지도에 "SDI 가 있는 타일" 을 통째로 깔아 주기 위한 목록.
            "tiles": [
                {
                    "id": tile_id,
                    "x": tile_id % geo.TILE_ID_STRIDE,
                    "y": tile_id // geo.TILE_ID_STRIDE,
                    "count": count,
                }
                for tile_id, count in sorted(tiles.items())
            ],
            "meshes": [
                {"code": code, "count": count}
                for code, count in sorted(meshes.items())
            ],
        }

    @classmethod
    def in_tile(cls, tile_x, tile_y, zoom):
        """해당 타일 안의 SDI. 줌이 기본(z15)과 다르면 그 줌으로 다시 판정한다."""
        if zoom == geo.DEFAULT_TILE_ZOOM:
            return [
                point for point in cls._points
                if point["tile"]["x"] == tile_x and point["tile"]["y"] == tile_y
            ]
        return [
            point for point in cls._points
            if geo.tile_from_wgs(point["lon"], point["lat"], zoom) == (tile_x, tile_y)
        ]

    @classmethod
    def in_mesh(cls, mesh_code):
        return [point for point in cls._points if point["mesh_code"] == mesh_code]


# VSM 레코드에는 타입 필드가 아직 해독되지 않았다. 같은 자리에 로그 SDI 가
# 있으면 그 타입을 빌려 온다 - 좌표는 10 m 이내로 검증돼 있으므로 이 거리면
# 같은 SDI 로 봐도 된다. (같은 셀에서 무작위 점의 최근접 거리는 약 140 m)
TYPE_MATCH_METERS = 25.0


def annotate_with_log_types(points):
    """VSM 포인트에 로그에서 알아낸 타입을 붙인다. 못 붙이면 그대로 둔다."""
    known = SdiSource.points()
    for point in points:
        best = None
        for candidate in known:
            # 위도 1도 약 111km, 경도 1도 약 88km (한국 위도 기준)
            dy = (candidate["lat"] - point["lat"]) * 111000.0
            dx = (candidate["lon"] - point["lon"]) * 88000.0
            distance = math.hypot(dx, dy)
            if best is None or distance < best[0]:
                best = (distance, candidate)
        if best and best[0] <= TYPE_MATCH_METERS:
            distance, candidate = best
            point["sdi_type"] = candidate["sdi_type"]
            point["sdi_type_name"] = candidate["sdi_type_name"]
            point["speed"] = candidate["speed"]
            point["type_source"] = "log"
            point["type_match_m"] = round(distance, 1)
        else:
            point["sdi_type"] = None
            point["sdi_type_name"] = None
            point["type_source"] = None
    return points


def _to_point(marker):
    lat = marker.get("latitude")
    lon = marker.get("longitude")
    if lat is None or lon is None:
        return None

    extra = marker.get("extra") or {}
    tile_x, tile_y = geo.tile_from_wgs(lon, lat)
    return {
        "id": marker.get("id"),
        "lat": lat,
        "lon": lon,
        "sdi_type": extra.get("sdi_type"),
        "sdi_type_name": extra.get("sdi_type_name"),
        "sdi_code": extra.get("sdi_code"),
        "speed": extra.get("speed"),
        "changeable_speed": extra.get("changeable_speed"),
        "priority": extra.get("priority"),
        "observation_count": extra.get("observation_count"),
        "ever_selected": extra.get("ever_selected"),
        "skip_reasons": extra.get("skip_reasons") or [],
        "source": extra.get("source"),
        "timestamp_str": marker.get("timestamp_str"),
        "tile": {"x": tile_x, "y": tile_y, "id": geo.tile_id(tile_x, tile_y)},
        "mesh_code": geo.mesh_code_from_wgs(lon, lat),
    }
