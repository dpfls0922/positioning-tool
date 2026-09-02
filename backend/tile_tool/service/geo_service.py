"""타일 / 메시 / 좌표 변환.

세 좌표계를 오간다.
  * WGS84 (지도에 그리는 좌표)
  * Bessel(EPSG:4162, 이른바 "SK 좌표"): benz-ivi2 의 wgs2sk 는 Bessel 도(度)에
    360000 을 곱한 값이다. 메시 코드가 이 좌표계 위에서 정의된다.
  * WebMercator z15 XYZ 타일: VSM 의 VsmTileInfo 가 쓰는 타일 인덱스.

변환식은 benz-ivi2 원본에서 그대로 옮겼다.
  * Bessel <-> WGS84 : module/navisdk/src/common/src/coord/Proj4Transform.h
      (+proj=longlat +ellps=bessel +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43)
    Coord.cpp 의 wgs2bessel 에도 Molodensky 근사가 있지만, proj4 경로가 성공하면
    거기서 반환하므로 런타임에서 실제로 쓰이는 건 위의 7-parameter Helmert 다.
  * 메시 코드 : CCoordBase::GetMeshCodeFromWgs84 (CoordBase.cpp:209)
  * 타일 인덱스 : VsmTileInfo (originShift 기반 z15 XYZ)
"""

import math

# --- 타원체 ---------------------------------------------------------------
WGS84_A = 6378137.0
WGS84_RF = 298.257223563
BESSEL_A = 6377397.155
BESSEL_RF = 299.1528128

# Proj4Transform 의 EPSG:4162 towgs84 파라미터.
# dx, dy, dz(m), rx, ry, rz(arcsec), scale(ppm)
BESSEL_TO_WGS84 = (-115.80, 474.99, 674.11, 1.16, -2.31, -1.63, 6.43)

SEC_TO_RAD = 4.84813681109535993589914102357e-6


def _es(rf):
    f = 1.0 / rf
    return f * (2.0 - f)


WGS84_ES = _es(WGS84_RF)
BESSEL_ES = _es(BESSEL_RF)

# 7-parameter 를 라디안 / 배율로 미리 환산해 둔다.
_DX, _DY, _DZ, _RX, _RY, _RZ, _PPM = BESSEL_TO_WGS84
_RX *= SEC_TO_RAD
_RY *= SEC_TO_RAD
_RZ *= SEC_TO_RAD
_M = _PPM / 1000000.0 + 1.0


def _geodetic_to_geocentric(lon_deg, lat_deg, a, es):
    lon = math.radians(lon_deg)
    lat = math.radians(lat_deg)
    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    rn = a / math.sqrt(1.0 - es * sin_lat * sin_lat)
    return (
        rn * cos_lat * math.cos(lon),
        rn * cos_lat * math.sin(lon),
        rn * (1.0 - es) * sin_lat,
    )


def _geocentric_to_geodetic(x, y, z, a, es):
    """Proj4 의 반복 해법(University of Hannover)을 그대로 옮긴 것."""
    b = a * math.sqrt(1.0 - es)
    genau = 1.0e-12
    p = math.hypot(x, y)
    rr = math.sqrt(x * x + y * y + z * z)

    if p / a < genau:
        lon = 0.0
        if rr / a < genau:
            return 0.0, 90.0
    else:
        lon = math.atan2(y, x)

    ct = z / rr
    st = p / rr
    rx = 1.0 / math.sqrt(1.0 - es * (2.0 - es) * st * st)
    cphi0 = st * (1.0 - es) * rx
    sphi0 = ct * rx

    cphi = cphi0
    sphi = sphi0
    for _ in range(30):
        rn = a / math.sqrt(1.0 - es * sphi0 * sphi0)
        height = p * cphi0 + z * sphi0 - rn * (1.0 - es * sphi0 * sphi0)
        rk = es * rn / (rn + height)
        rx = 1.0 / math.sqrt(1.0 - rk * (2.0 - rk) * st * st)
        cphi = st * (1.0 - rk) * rx
        sphi = ct * rx
        sdphi = sphi * cphi0 - cphi * sphi0
        cphi0 = cphi
        sphi0 = sphi
        if sdphi * sdphi <= genau * genau:
            break

    lat = math.atan(sphi / abs(cphi)) if cphi != 0 else math.copysign(math.pi / 2, sphi)
    _ = b  # 높이는 쓰지 않는다
    return math.degrees(lon), math.degrees(lat)


def _to_wgs84_frame(x, y, z):
    return (
        _M * (x - _RZ * y + _RY * z) + _DX,
        _M * (_RZ * x + y - _RX * z) + _DY,
        _M * (-_RY * x + _RX * y + z) + _DZ,
    )


def _from_wgs84_frame(x, y, z):
    xt = (x - _DX) / _M
    yt = (y - _DY) / _M
    zt = (z - _DZ) / _M
    return (
        xt + _RZ * yt - _RY * zt,
        -_RZ * xt + yt + _RX * zt,
        _RY * xt - _RX * yt + zt,
    )


def wgs_to_bessel(lon, lat):
    """WGS84 경위도 -> Bessel(EPSG:4162) 경위도. benz-ivi2 의 wgs2bessel."""
    x, y, z = _geodetic_to_geocentric(lon, lat, WGS84_A, WGS84_ES)
    x, y, z = _from_wgs84_frame(x, y, z)
    return _geocentric_to_geodetic(x, y, z, BESSEL_A, BESSEL_ES)


def bessel_to_wgs(lon, lat):
    """Bessel(EPSG:4162) 경위도 -> WGS84 경위도. benz-ivi2 의 bessel2wgs."""
    x, y, z = _geodetic_to_geocentric(lon, lat, BESSEL_A, BESSEL_ES)
    x, y, z = _to_wgs84_frame(x, y, z)
    return _geocentric_to_geodetic(x, y, z, WGS84_A, WGS84_ES)


def wgs_to_sk(lon, lat):
    """wgs2sk: Bessel 도에 360000 을 곱한 정수 단위 좌표."""
    bx, by = wgs_to_bessel(lon, lat)
    return bx * 360000.0, by * 360000.0


def sk_to_wgs(skx, sky):
    return bessel_to_wgs(skx / 360000.0, sky / 360000.0)


# --- 메시 -----------------------------------------------------------------
# CoordBase.cpp 의 격자. 원점 122E / 33N, 큰 칸이 1도 x 40분이고 이를 8 x 8
# (7.5분 x 5분) 로 쪼갠 것이 4자리 메시 코드다.
MESH_ORIGIN_X = 122 * 360000     # 122E
MESH_ORIGIN_Y = 33 * 360000      # 33N
MESH_BIG_W = 360000              # 1도
MESH_BIG_H = 240000              # 40분
MESH_SMALL_W = 45000             # 7.5분
MESH_SMALL_H = 30000             # 5분


def mesh_code_from_wgs(lon, lat):
    """GetMeshCodeFromWgs84 과 동일한 4자리 메시 코드."""
    skx, sky = wgs_to_sk(lon, lat)
    return mesh_code_from_sk(skx, sky)


def mesh_code_from_sk(skx, sky):
    x1 = int(skx) - MESH_ORIGIN_X
    y1 = int(sky) - MESH_ORIGIN_Y
    a = x1 // MESH_BIG_W
    b = y1 // MESH_BIG_H + 1
    x1 -= a * MESH_BIG_W
    y1 -= (b - 1) * MESH_BIG_H
    c = x1 // MESH_SMALL_W + 1
    d = y1 // MESH_SMALL_H + 1
    return a * 1000 + b * 100 + c * 10 + d


def mesh_code_parts(mesh_code):
    code = int(mesh_code)
    a = code // 1000
    b = (code // 100) % 10
    c = (code // 10) % 10
    d = code % 10
    return a, b, c, d


def mesh_sk_bounds(mesh_code):
    """메시 코드의 SK 좌표 사각형 (x0, y0, x1, y1)."""
    a, b, c, d = mesh_code_parts(mesh_code)
    x0 = MESH_ORIGIN_X + a * MESH_BIG_W + (c - 1) * MESH_SMALL_W
    y0 = MESH_ORIGIN_Y + (b - 1) * MESH_BIG_H + (d - 1) * MESH_SMALL_H
    return x0, y0, x0 + MESH_SMALL_W, y0 + MESH_SMALL_H


def mesh_is_valid(mesh_code):
    a, b, c, d = mesh_code_parts(mesh_code)
    return 1 <= b <= 9 and 1 <= c <= 8 and 1 <= d <= 8 and a >= 0


def _sk_rect_to_wgs_ring(x0, y0, x1, y1):
    """SK 사각형의 네 꼭짓점을 WGS84 로 옮긴 폴리곤 링.

    사각형은 Bessel 좌표계에서 직사각형이므로 WGS84 에서는 아주 살짝
    기울어진다. 사각형 대신 폴리곤으로 돌려 그 왜곡을 유지한다.
    """
    corners = ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
    ring = []
    for cx, cy in corners:
        lon, lat = sk_to_wgs(cx, cy)
        ring.append([lat, lon])
    return ring


def mesh_ring(mesh_code):
    return _sk_rect_to_wgs_ring(*mesh_sk_bounds(mesh_code))


def mesh_center(mesh_code):
    x0, y0, x1, y1 = mesh_sk_bounds(mesh_code)
    lon, lat = sk_to_wgs((x0 + x1) / 2.0, (y0 + y1) / 2.0)
    return lat, lon


# --- 타일 -----------------------------------------------------------------
# VsmTileInfo 와 동일: WebMercator, z15, XYZ(위->아래) 인덱스,
# id = tileY * 100000 + tileX.
# VSM 은 originShift(=적도 반주) 와 tileSize 로 나누지만, 그 식은 아래의
# 표준 slippy-map 공식과 같은 결과를 준다.
DEFAULT_TILE_ZOOM = 15
TILE_ID_STRIDE = 100000


def tile_dim(zoom=DEFAULT_TILE_ZOOM):
    return 1 << int(zoom)


def tile_from_wgs(lon, lat, zoom=DEFAULT_TILE_ZOOM):
    n = tile_dim(zoom)
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(max(min(lat, 85.05112878), -85.05112878))
    y = int((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def tile_bounds(tile_x, tile_y, zoom=DEFAULT_TILE_ZOOM):
    """(south, west, north, east)."""
    n = float(tile_dim(zoom))

    def _lat(ty):
        return math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * ty / n))))

    west = tile_x / n * 360.0 - 180.0
    east = (tile_x + 1) / n * 360.0 - 180.0
    north = _lat(tile_y)
    south = _lat(tile_y + 1)
    return south, west, north, east


def tile_center(tile_x, tile_y, zoom=DEFAULT_TILE_ZOOM):
    south, west, north, east = tile_bounds(tile_x, tile_y, zoom)
    return (south + north) / 2.0, (west + east) / 2.0


def tile_id(tile_x, tile_y):
    return int(tile_y) * TILE_ID_STRIDE + int(tile_x)


def tile_from_id(value):
    value = int(value)
    return value % TILE_ID_STRIDE, value // TILE_ID_STRIDE


def tile_is_valid(tile_x, tile_y, zoom=DEFAULT_TILE_ZOOM):
    n = tile_dim(zoom)
    return 0 <= tile_x < n and 0 <= tile_y < n
