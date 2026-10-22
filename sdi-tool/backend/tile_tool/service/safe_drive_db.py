"""SAFE_DRIVE_DB(NDSAFEIDX / NDSAFEDAT) 를 읽는다.

**컨테이너 구조는 확정**됐고 실제 파일로 검증했다(FSK1719 기준 1070블록 전부
일치, 88,422 레코드).

    NDSAFEIDX = count(u32 LE) + count x (key:u32 LE, offset:u32 LE)
    NDSAFEDAT = 헤더 8B("FSK" + 버전) + 블록들
      블록 = 키 3B(BCD) + 0xf2 + 레코드수(u16 BE) + 11B 레코드 x 레코드수

**키 = 격자 셀**. 아래 식으로 셀 위치가 나온다(Bessel/EPSG:4162 기준):

    A = floor(besselLat / 40분)        (0°N 기준, 한국은 49~57)
    B = floor(besselLon) mod 100       (한국은 25~30 -> 125~130°E)
    r, c = 셀을 8 x 8 로 쪼갠 행/열 (각 0~7)
    key = A * 10000 + B * 100 + r * 10 + c

즉 한 셀은 **7.5분 x 5분(약 11 x 9 km)**. 로그에서 얻은 실제 SDI 56개가 이
식으로 계산한 키 두 개(562720 에 51개, 562627 에 5개)에 정확히 떨어지는 것을
확인했다.

**레코드 11바이트도 해독 완료**. 좌표는 셀 기준 상대값이고, 타입과 제한속도는
benz-ivi2 의 `VsmTileInfo`(module/navisdk/src/mapmatch/TileInfo.cpp:420~480)
가 쓰는 식을 그대로 옮겼다.

    [0]      = VSM 의 "Type" 속성
               제한속도  = ((Type & 0xf0) >> 4) * 10 + 20   (getSpeedLimit)
               설치점여부 = (Type & 0x0f) == 10              (isExactGuidePoint)
    [1] >> 3 = VSM 의 "Attribute" = eSAFEDRIVE_GGUIDE_TYPE (rgdata_def.h:1718~)
    [2:4] BE = Angle (0~360)
    [4:6] BE = 셀 안에서 동쪽 방향 위치, 단위는 셀 폭의 1/10000 (약 1.1 m)
    [6:8] BE = 셀 안에서 북쪽 방향 위치, 단위는 셀 높이의 1/10000 (약 0.9 m)
    [8:11]   = LINK_ID 로 보인다 (미확인)

검증
  * 좌표 : 로그의 신호과속·버스전용차로가 3~19 m 안에서 일치. 같은 셀에서
    무작위 점의 최근접 거리 기대치가 약 140 m 라 우연이 아니다.
  * 타입 : 구간단속 시점(22) 설치점 84개와 종점(23) 설치점 84개가 개수도
    제한속도 분포도 완전히 같다 - 쌍으로 존재하는 데이터다.
  * 제한속도 : 과속(고정식) 설치점 4,665개가 60/80/100/70 순으로 나오는데
    실제 한국 단속카메라 분포와 맞는다.

과속방지턱(18)·어린이보호구역(19)·철길건널목(20)은 이 DB 에 **없다**. 로그의
과속방지턱 30건이 하나도 맞지 않았던 이유이고, 다른 소스에서 온다.

자세한 경위는 memory 의 ndsafedat-format 참고.
"""

import struct

from backend.tile_tool.service import geo_service as geo


LAT_CELL = 40.0 / 60.0          # 40분
LON_CELL = 1.0                  # 1도
SUB = 8                         # 셀을 8 x 8 로 분할
BLOCK_MARKER = 0xF2
RECORD_SIZE = 11
HEADER_SIZE = 8


class SafeDriveDbError(RuntimeError):
    pass


def cell_key(lon, lat):
    """WGS84 좌표가 속한 셀 키."""
    bx, by = geo.wgs_to_bessel(lon, lat)
    return cell_key_from_bessel(bx, by)


def cell_key_from_bessel(bx, by):
    lat_units = by / LAT_CELL
    a = int(lat_units)
    b = int(bx) % 100
    row = int((lat_units % 1.0) * SUB)
    col = int((bx % 1.0) * SUB)
    return a * 10000 + b * 100 + row * 10 + col


def cell_parts(key):
    key = int(key)
    return key // 10000, (key // 100) % 100, (key // 10) % 10, key % 10


def cell_bessel_bounds(key):
    """셀의 Bessel 좌표 사각형 (lon0, lat0, lon1, lat1)."""
    a, b, row, col = cell_parts(key)
    # B 는 경도 정수부의 아래 두 자리다. 한국(124~132°E)에서만 쓰므로
    # 100 을 더해 되돌린다.
    lon_deg = b + 100 if b < 50 else b
    lon0 = lon_deg + col * (LON_CELL / SUB)
    lat0 = (a + row / SUB) * LAT_CELL
    return lon0, lat0, lon0 + LON_CELL / SUB, lat0 + LAT_CELL / SUB


# 이 격자는 CoordBase 의 메시 격자와 **같은 사각형**이다. 둘 다 0도 기준
# 7.5분 x 5분 격자에 정렬돼 있고(33N = 5분 x 396, 122E = 7.5분 x 976),
# 번호만 다르게 매긴 것이다. 그래서 메시 코드 <-> 셀 키는 1:1 로 오간다.
def cell_key_from_mesh(mesh_code):
    lon0, lat0, _, _ = geo.mesh_sk_bounds(mesh_code)
    return cell_key_from_bessel(lon0 / 360000.0 + 1e-9, lat0 / 360000.0 + 1e-9)


def mesh_from_cell_key(key):
    lon0, lat0, _, _ = cell_bessel_bounds(key)
    return geo.mesh_code_from_sk((lon0 + 1e-9) * 360000.0, (lat0 + 1e-9) * 360000.0)


def cell_ring(key):
    """셀의 WGS84 폴리곤 링([[lat, lon], ...])."""
    lon0, lat0, lon1, lat1 = cell_bessel_bounds(key)
    ring = []
    for blon, blat in ((lon0, lat0), (lon1, lat0), (lon1, lat1), (lon0, lat1)):
        lon, lat = geo.bessel_to_wgs(blon, blat)
        ring.append([lat, lon])
    return ring


def cell_center(key):
    lon0, lat0, lon1, lat1 = cell_bessel_bounds(key)
    lon, lat = geo.bessel_to_wgs((lon0 + lon1) / 2, (lat0 + lat1) / 2)
    return lat, lon


def _be16(record, offset):
    return (record[offset] << 8) | record[offset + 1]


COORD_UNITS = 10000.0

# rgdata_def.h 의 eSAFEDRIVE_GGUIDE_TYPE.
SAFE_DRIVE_TYPE_NAMES = {
    1: "과속 (고정식)", 2: "과속 (이동식)", 3: "과적 (고정식)", 4: "신호 (고정식)",
    5: "신호과속 (고정식)", 6: "버스전용 (고정식)", 7: "주차단속 (고정식)",
    8: "갓길감시 (고정식)", 9: "교통정보 수집", 10: "사고다발지역", 11: "급커브지역",
    12: "안개지역", 13: "고속도로 휴게소", 14: "터널", 15: "충전소", 16: "톨게이트",
    17: "유해물질 단속", 18: "과속방지턱", 19: "어린이보호구역", 20: "철길건널목",
    21: "끼어들기 금지", 22: "구간단속 시점", 23: "구간단속 종점", 24: "적재불량 단속",
    25: "방범용 CCTV", 26: "보행자 사고다발", 27: "가변단속 시점", 28: "가변단속 종점",
    29: "녹색교통지역", 30: "박스형 이동식", 31: "졸음쉼터", 32: "어린이보호구역 시점",
    33: "어린이보호구역 종점", 34: "노인보호구역", 36: "노인보호구역 시점",
    37: "노인보호구역 종점", 40: "후면 과속단속", 41: "후면 신호과속단속",
    48: "후면 신호과속 구간단속 시점", 49: "후면 신호과속 구간단속 종점",
    50: "후면 구간단속 시점", 51: "후면 구간단속 종점",
    52: "신호과속 구간단속 시점", 53: "신호과속 구간단속 종점",
}

EXACT_GUIDE_POINT = 10


def record_speed_limit(type_byte):
    """VsmTileInfo::getSpeedLimit 과 동일."""
    return ((type_byte & 0xF0) >> 4) * 10 + 20


def record_is_exact(type_byte):
    """VsmTileInfo::isExactGuidePoint 과 동일. 실제 설치 지점인지."""
    return (type_byte & 0x0F) == EXACT_GUIDE_POINT


def decode_record(record, bounds):
    """레코드 하나를 WGS84 좌표 + 타입 + 제한속도로 푼다."""
    lon0, lat0, lon1, lat1 = bounds
    blon = lon0 + _be16(record, 4) / COORD_UNITS * (lon1 - lon0)
    blat = lat0 + _be16(record, 6) / COORD_UNITS * (lat1 - lat0)
    lon, lat = geo.bessel_to_wgs(blon, blat)

    sdi_type = record[1] >> 3
    exact = record_is_exact(record[0])
    return {
        "lat": lat,
        "lon": lon,
        "type": sdi_type,
        "type_name": SAFE_DRIVE_TYPE_NAMES.get(sdi_type, f"타입 {sdi_type}"),
        # 설치점이 아니면 상위 니블이 제한속도를 뜻하지 않는다(방범용 CCTV 는
        # 전부 0 이라 20 km/h 로 계산된다). 앱도 설치점에만 이 식을 쓴다.
        "speed_limit": record_speed_limit(record[0]) if exact else None,
        "exact": exact,
        "angle": _be16(record, 2),
        "raw": record.hex(" "),
    }


class SafeDriveDb:
    """읽어들인 NDSAFEIDX / NDSAFEDAT 한 벌."""

    def __init__(self, version, cells):
        self.version = version
        self.cells = cells      # key -> {"count": int, "records": [bytes, ...]}

    @property
    def record_total(self):
        return sum(cell["count"] for cell in self.cells.values())

    def cell(self, key):
        return self.cells.get(int(key))

    def points_in_cell(self, key):
        cell = self.cells.get(int(key))
        if not cell:
            return []
        bounds = cell_bessel_bounds(key)
        return [decode_record(record, bounds) for record in cell["records"]]

    def points_in_bounds(self, south, west, north, east, limit=4000):
        """화면 범위 안의 SDI. 전국 8만여 건이라 상한을 둔다."""
        points = []
        for key, _count, _ring in self.cells_in_bounds(south, west, north, east):
            for point in self.points_in_cell(key):
                if south <= point["lat"] <= north and west <= point["lon"] <= east:
                    point["cell"] = key
                    points.append(point)
                    if len(points) >= limit:
                        return points, True
        return points, False

    def cells_in_bounds(self, south, west, north, east):
        """화면 범위에 걸치는 셀들. 셀이 약 11 x 9 km 라 범위가 넓으면 많아진다."""
        hits = []
        for key, cell in self.cells.items():
            ring = cell_ring(key)
            lats = [point[0] for point in ring]
            lons = [point[1] for point in ring]
            if max(lats) < south or min(lats) > north:
                continue
            if max(lons) < west or min(lons) > east:
                continue
            hits.append((key, cell["count"], ring))
        return hits

    def summary(self):
        counts = [cell["count"] for cell in self.cells.values()]
        return {
            "version": self.version,
            "cell_count": len(self.cells),
            "record_total": sum(counts),
            "max_cell_count": max(counts) if counts else 0,
        }


def load(index_path, data_path):
    with open(index_path, "rb") as handle:
        index = handle.read()
    with open(data_path, "rb") as handle:
        data = handle.read()
    return parse(index, data)


def parse(index, data):
    if len(index) < 4:
        raise SafeDriveDbError("NDSAFEIDX 가 너무 짧습니다.")

    count = struct.unpack("<I", index[:4])[0]
    if len(index) != 4 + count * 8:
        raise SafeDriveDbError(
            f"NDSAFEIDX 크기가 맞지 않습니다: 항목 {count}개면 {4 + count * 8}B 여야 하는데 {len(index)}B"
        )

    version = data[:HEADER_SIZE].rstrip(b"\x00").decode("ascii", "replace")
    entries = [struct.unpack("<II", index[4 + i * 8:12 + i * 8]) for i in range(count)]

    cells = {}
    for i, (key, offset) in enumerate(entries):
        end = entries[i + 1][1] if i + 1 < count else len(data)
        block = data[offset:end]
        if len(block) < 6:
            raise SafeDriveDbError(f"키 {key} 블록이 너무 짧습니다.")
        if f"{key:06d}" != block[:3].hex():
            raise SafeDriveDbError(f"키 {key} 와 블록의 BCD 키 {block[:3].hex()} 가 다릅니다.")
        if block[3] != BLOCK_MARKER:
            raise SafeDriveDbError(f"키 {key} 블록 마커가 0x{block[3]:02x} 입니다(0xf2 기대).")

        record_count = (block[4] << 8) | block[5]
        if len(block) != 6 + record_count * RECORD_SIZE:
            raise SafeDriveDbError(
                f"키 {key} 블록 길이가 맞지 않습니다: 레코드 {record_count}개면 "
                f"{6 + record_count * RECORD_SIZE}B 여야 하는데 {len(block)}B"
            )

        body = block[6:]
        cells[key] = {
            "count": record_count,
            "records": [body[j * RECORD_SIZE:(j + 1) * RECORD_SIZE] for j in range(record_count)],
        }

    return SafeDriveDb(version, cells)
