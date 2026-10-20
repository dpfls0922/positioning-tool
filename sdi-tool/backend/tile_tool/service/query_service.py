"""검색어 한 줄을 조회 대상(타일 / 메시 / 좌표)으로 해석한다.

기존 툴의 옴니박스와 같은 방식이다: 접두어를 붙이면 그 종류로 강제하고,
없으면 형태를 보고 추론한다.

  37.5665,126.978    위경도 (그 좌표가 속한 타일)
  t:27941,12690      타일 인덱스 (tileX,tileY)
  t:1269027941       타일 id (tileY * 100000 + tileX)
  m:4787             메시 코드
  z:14 를 함께 주면   타일 줌 레벨을 바꾼다 (기본 15)
"""

import re

from backend.tile_tool.service import geo_service as geo


class QueryError(ValueError):
    pass


_NUM = r"[-+]?\d+(?:\.\d+)?"
_ZOOM_RE = re.compile(r"(?:^|\s)z:\s*(\d{1,2})(?:\s|$)", re.IGNORECASE)
_PREFIX_RE = re.compile(r"^\s*(latlon|ll|tile|t|mesh|m)\s*[:=]\s*", re.IGNORECASE)
_PAIR_RE = re.compile(rf"^\s*({_NUM})\s*[,/\s]\s*({_NUM})\s*$")
_INT_RE = re.compile(r"^\s*(\d+)\s*$")

_PREFIX_KIND = {
    "latlon": "latlon", "ll": "latlon",
    "tile": "tile", "t": "tile",
    "mesh": "mesh", "m": "mesh",
}


def _strip_zoom(text):
    zoom = geo.DEFAULT_TILE_ZOOM
    match = _ZOOM_RE.search(text)
    if match:
        zoom = int(match.group(1))
        if not 0 <= zoom <= 22:
            raise QueryError(f"타일 줌 레벨 {zoom} 은 0~22 범위를 벗어납니다.")
        text = text[: match.start()] + " " + text[match.end():]
    return text.strip(), zoom


def _guess_kind(body):
    """접두어가 없을 때 형태로 종류를 추론한다."""
    pair = _PAIR_RE.match(body)
    if pair:
        # 소수점이 있으면 위경도, 둘 다 정수면 타일 인덱스로 본다.
        if "." in pair.group(1) or "." in pair.group(2):
            return "latlon"
        return "tile"

    single = _INT_RE.match(body)
    if single:
        digits = single.group(1)
        # 메시 코드는 4자리, 타일 id 는 9~10자리다.
        if len(digits) == 4:
            return "mesh"
        if len(digits) >= 8:
            return "tile"
        raise QueryError(
            f"'{digits}' 는 메시 코드(4자리)도 타일 id(8자리 이상)도 아닙니다. "
            "m: 또는 t: 를 붙여 종류를 지정해 주세요."
        )

    raise QueryError("좌표(37.5665,126.978), 타일(t:27941,12690), 메시(m:4787) 중 하나로 입력해 주세요.")


def _resolve_latlon(body, zoom):
    pair = _PAIR_RE.match(body)
    if not pair:
        raise QueryError("위경도는 '37.5665,126.978' 형태로 입력해 주세요.")
    lat = float(pair.group(1))
    lon = float(pair.group(2))
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise QueryError(f"위경도 범위를 벗어났습니다: {lat}, {lon}")
    tile_x, tile_y = geo.tile_from_wgs(lon, lat, zoom)
    return _describe(tile_x, tile_y, zoom, matched="latlon", point=(lat, lon))


def _resolve_tile(body, zoom):
    pair = _PAIR_RE.match(body)
    if pair:
        if "." in pair.group(1) or "." in pair.group(2):
            raise QueryError("타일 인덱스는 정수여야 합니다.")
        tile_x, tile_y = int(pair.group(1)), int(pair.group(2))
    else:
        single = _INT_RE.match(body)
        if not single:
            raise QueryError("타일은 't:27941,12690' 또는 't:1269027941' 형태로 입력해 주세요.")
        tile_x, tile_y = geo.tile_from_id(single.group(1))

    if not geo.tile_is_valid(tile_x, tile_y, zoom):
        limit = geo.tile_dim(zoom) - 1
        raise QueryError(f"z{zoom} 타일 인덱스는 0~{limit} 범위여야 합니다: {tile_x},{tile_y}")
    return _describe(tile_x, tile_y, zoom, matched="tile")


def _resolve_mesh(body, zoom):
    single = _INT_RE.match(body)
    if not single or len(single.group(1)) != 4:
        raise QueryError("메시 코드는 'm:4787' 처럼 4자리 숫자입니다.")
    mesh_code = int(single.group(1))
    if not geo.mesh_is_valid(mesh_code):
        raise QueryError(
            f"메시 코드 {mesh_code} 는 격자 범위를 벗어났습니다. "
            "(a=경도 1도 칸, b=위도 40분 칸, c=1~8, d=1~8)"
        )
    lat, lon = geo.mesh_center(mesh_code)
    tile_x, tile_y = geo.tile_from_wgs(lon, lat, zoom)
    return _describe(tile_x, tile_y, zoom, matched="mesh", mesh_code=mesh_code)


_RESOLVERS = {"latlon": _resolve_latlon, "tile": _resolve_tile, "mesh": _resolve_mesh}


def resolve(text):
    if not text or not text.strip():
        raise QueryError("검색어를 입력해 주세요.")

    body, zoom = _strip_zoom(text)
    prefix = _PREFIX_RE.match(body)
    if prefix:
        kind = _PREFIX_KIND[prefix.group(1).lower()]
        body = body[prefix.end():].strip()
    else:
        kind = _guess_kind(body)

    return _RESOLVERS[kind](body, zoom)


def _describe(tile_x, tile_y, zoom, matched, point=None, mesh_code=None):
    """조회 결과: 타일 정보 + 그 타일이 걸친 메시 목록."""
    south, west, north, east = geo.tile_bounds(tile_x, tile_y, zoom)
    center_lat, center_lon = geo.tile_center(tile_x, tile_y, zoom)

    # 타일 네 꼭짓점이 속한 메시를 모으면 타일이 걸친 메시가 나온다
    # (z15 타일은 약 1.2km, 메시는 약 11km x 9km 이므로 최대 4개다).
    mesh_codes = sorted({
        geo.mesh_code_from_wgs(lon, lat)
        for lat in (south, north)
        for lon in (west, east)
    })
    if mesh_code is not None and mesh_code not in mesh_codes:
        mesh_codes.append(mesh_code)

    return {
        "matched": matched,
        "zoom": zoom,
        "tile": {
            "x": tile_x,
            "y": tile_y,
            "id": geo.tile_id(tile_x, tile_y),
            "bounds": {"south": south, "west": west, "north": north, "east": east},
            "center": {"lat": center_lat, "lon": center_lon},
        },
        "point": ({"lat": point[0], "lon": point[1]} if point else None),
        "meshes": [
            {
                "code": code,
                "ring": geo.mesh_ring(code),
                "center": dict(zip(("lat", "lon"), geo.mesh_center(code))),
                "primary": code == (mesh_code if mesh_code is not None else _primary_mesh(point, center_lat, center_lon)),
            }
            for code in mesh_codes
        ],
    }


def _primary_mesh(point, center_lat, center_lon):
    lat, lon = point if point else (center_lat, center_lon)
    return geo.mesh_code_from_wgs(lon, lat)
