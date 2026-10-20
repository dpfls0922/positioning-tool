"""도로 레이어(도로 2023A) 온라인 타일에서 SDI2 / CAM_REF_LINK 스택을 읽는다.

SAFE_DRIVE_DB(NDSAFEDAT)와 달리, 제품(benz-ivi)이 실제로 쓰는 SDI는 도로
네트워크 타일 안에 스택으로 실려 온다. 최신 맵에는 스택이 넷이다:
    LINKSHAPE(링크) / SDI(구버전 호환 - 후면 타입이 22/23 등으로 강등됨)
    / SDI2(진짜 타입 40~53 포함) / CAM_REF_LINK(구간단속 시점->종점 링크 체인)
여기서는 SDI2 와 CAM_REF_LINK 만 쓴다.

타일 바이너리 포맷은 navisdk VsmTileInfo(TileInfo.cpp) 파싱 코드를 그대로
옮긴 것: zlib 압축 해제 후
    헤더: u32 layerId, u8 format, u32 totalLength, u32 propPartLength
    프로퍼티 테이블: u8 keyCount, (u8 len+bytes)*, u16 valueCount, (u8 len+bytes)*
    스택부(헤더 13B + propPartLength): u16 stackCount,
        스택 = u32 id, u32 len, u8 type, u16 featureCount
        피처 = u32 len(자기 포함), u16 geomCount, u16[geomCount] vtxCount,
               (i16 dx, i16 dy)* 누적합, u16 propLen, u8 propCount,
               (u8 keyIdx, u16 valIdx)*
좌표: 슬리피 z15 타일 기준 웹메르카토르 델타 누적합.
"""

import json
import logging
import math
import os
import struct
import threading
import zlib
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from urllib import request as urllib_request

from backend.tile_tool.service.paths import VSM_CACHE_DIR
from backend.tile_tool.service.safe_drive_db import SAFE_DRIVE_TYPE_NAMES

APP_CONF_URL = ("http://farm41.ids.skplanet.com:8012"
                "/hub/vsm/config/application/S001/TMAP_AUTO_BENZ.conf")
# conf 에는 onestore.co.kr 호스트로 적힌 uri 가 오는데 그 호스트는 안 닿는다.
HOST_FIX = ("farm41.ids.onestore.co.kr", "farm41.ids.skplanet.com")

STACK_SDI2 = "SDI2"
STACK_CAM_REF = "CAM_REF_LINK"

TILE_ZOOM = 15
TIMEOUT_SEC = 30

ORIGIN_SHIFT = 20037508.342789244
TILE_SIZE = ORIGIN_SHIFT * 2 ** (1 - TILE_ZOOM)
K = TILE_SIZE * 2 / (0x7FFF - 1)

# 후면·신호과속 계열 (eSAFEDRIVE_GGUIDE_TYPE 40, 41, 48~53)
REAR_TYPES = frozenset({40, 41, 48, 49, 50, 51, 52, 53})


class RoadTileError(RuntimeError):
    pass


def _get(url):
    try:
        with urllib_request.urlopen(url, timeout=TIMEOUT_SEC) as response:
            return response.read()
    except Exception as ex:
        raise RoadTileError(f"{url} 요청 실패: {ex}") from ex


def _meters_to_lnglat(mx, my):
    lon = mx / ORIGIN_SHIFT * 180.0
    lat = my / ORIGIN_SHIFT * 180.0
    lat = 180 / math.pi * (2 * math.atan(math.exp(lat * math.pi / 180.0)) - math.pi / 2)
    return lon, lat


def parse_tile(data, tile_x, tile_y):
    """타일 바이너리 하나를 {stack_id: [feature...]} 로 푼다."""
    if data[:1] == b"\x78":
        data = zlib.decompress(data)

    off = 0

    def rd(fmt):
        nonlocal off
        value = struct.unpack_from(fmt, data, off)[0]
        off += struct.calcsize(fmt)
        return value

    rd("<I")  # layer id
    rd("<B")  # format
    rd("<I")  # total length
    prop_len = rd("<I")
    header_end = off

    keys = []
    for _ in range(rd("<B")):
        n = rd("<B")
        keys.append(data[off:off + n].decode("utf-8", "replace"))
        off += n
    values = []
    for _ in range(rd("<H")):
        n = rd("<B")
        values.append(data[off:off + n].decode("utf-8", "replace"))
        off += n

    off = header_end + prop_len
    stacks = {}
    for _ in range(rd("<H")):
        stack_id = rd("<I")
        rd("<I")  # stack length
        rd("<B")  # geometry type
        feature_count = rd("<H")
        features = []
        for _ in range(feature_count):
            f_start = off
            f_len = rd("<I")
            geom_count = rd("<H")
            vtx_counts = [rd("<H") for _ in range(geom_count)]
            points = []
            for vc in vtx_counts:
                sx = sy = 0
                for _ in range(vc):
                    sx += rd("<h")
                    sy += rd("<h")
                    lon, lat = _meters_to_lnglat(
                        tile_x * TILE_SIZE - ORIGIN_SHIFT + sx * K,
                        ORIGIN_SHIFT - (tile_y + 1) * TILE_SIZE + sy * K)
                    points.append((lat, lon))
            rd("<H")  # property length
            props = {}
            for _ in range(rd("<B")):
                key_idx = rd("<B")
                val_idx = rd("<H")
                props[keys[key_idx]] = values[val_idx]
            features.append({"points": points, "props": props})
            off = f_start + f_len
        stacks[stack_id] = features
    return stacks


def _pt_dist_m(a, b):
    return math.hypot((a[0] - b[0]) * 111000.0, (a[1] - b[1]) * 88000.0)


def _add_link_fragment(link_geoms, key, points):
    """타일 경계에서 잘린 링크 형상 조각을 모은다 (중복 조각은 서명으로 제거)."""
    if not points:
        return
    sig = (len(points),
           round(points[0][0], 6), round(points[0][1], 6),
           round(points[-1][0], 6), round(points[-1][1], 6))
    link_geoms.setdefault(key, {})[sig] = points


def _assemble_geom_path(entry, link_geoms):
    """CAM_REF 체인을 링크 실제 형상(LINKSHAPE)으로 잇는다.

    레코드의 X/Y 는 링크 대표점 하나뿐이라 긴 링크가 직선으로 보인다. 링크
    형상은 타일 경계에서 조각나 있으므로, (메시, 링크ID)의 조각들을 직전 점과
    가까운 끝부터 차례로 이어 붙인다. 형상이 없으면 대표점으로 대체한다.
    """
    path = []
    if entry["start"]:
        path.append(list(entry["start"]))
    for order in sorted(entry["records"]):
        rec = entry["records"][order]
        frags = list((link_geoms.get((rec["mesh"], rec["link"])) or {}).values())
        pts_seq = []
        if path and frags:
            remaining = [list(fr) for fr in frags]
            cur = path[-1]
            while remaining:
                best_i = 0
                best_rev = False
                best_d = None
                for i, fr in enumerate(remaining):
                    d0 = _pt_dist_m(cur, fr[0])
                    d1 = _pt_dist_m(cur, fr[-1])
                    d, rev = (d0, False) if d0 <= d1 else (d1, True)
                    if best_d is None or d < best_d:
                        best_i, best_rev, best_d = i, rev, d
                frag = remaining.pop(best_i)
                if best_rev:
                    frag.reverse()
                pts_seq.extend(frag)
                cur = frag[-1]
        if not pts_seq:
            pts_seq = [rec["pt"]]
        for pnt in pts_seq:
            if not path or _pt_dist_m(path[-1], pnt) > 1.0:
                path.append(list(pnt))
    if entry["end"]:
        path.append(list(entry["end"]))
    return path


class RoadTileSource:
    """도로 레이어 conf + 타일 다운로드/파싱. 타일은 디스크와 메모리에 캐시."""

    _lock = threading.Lock()
    _layer = None
    _tiles = {}            # (x, y) -> stacks dict | None(타일 없음/실패)

    @classmethod
    def _ensure_layer(cls):
        if cls._layer is not None:
            return cls._layer
        conf = json.loads(_get(APP_CONF_URL).decode("utf-8"))
        layers = conf.get("layersV2") or conf.get("layers") or []
        app_layers = [
            {"id": item.get("id"), "name": item.get("name"), "version": str(item.get("version"))}
            for item in layers
        ]
        road = None
        for item in layers:
            if str(item.get("type", "")).lower() == "network" or "도로" in str(item.get("name", "")):
                road = item
        if road is None:
            raise RoadTileError("TMAP_AUTO_BENZ.conf 에 도로 레이어가 없습니다.")

        uri = road["uri"].replace(HOST_FIX[0], HOST_FIX[1])
        layer = json.loads(_get(f"{uri}.{road['version']}").decode("utf-8"))
        stack_ids = {s.get("code"): s.get("id") for s in layer.get("stacks", [])}
        # SDI2(진짜 타입)를 우선 쓰고, 구버전 맵이라 없으면 SDI 로 폴백한다.
        if STACK_SDI2 in stack_ids:
            sdi_stack_code = STACK_SDI2
        elif "SDI" in stack_ids:
            sdi_stack_code = "SDI"
        else:
            raise RoadTileError("도로 레이어에 SDI/SDI2 스택이 없습니다.")

        map_uri = layer.get("map", {}).get("uri", "").replace(HOST_FIX[0], HOST_FIX[1])
        cls._layer = {
            "id": layer["id"],
            "version": str(layer.get("version")),
            "tile_version": str(layer.get("map", {}).get("version") or layer.get("tilePath")),
            "sdi_version": str(layer.get("properties", {}).get("sdiVersion", "")),
            "tile_base": map_uri.rstrip("/"),
            "stack_ids": stack_ids,
            "stacks": [
                {"id": s.get("id"), "code": s.get("code"), "name": s.get("name")}
                for s in layer.get("stacks", [])
            ],
            "app_layers": app_layers,
            "name": layer.get("name", ""),
            "sdi_stack": sdi_stack_code,
        }
        logging.info("도로 레이어 %s v%s 타일 %s (sdi %s)", layer["id"],
                     cls._layer["version"], cls._layer["tile_version"], cls._layer["sdi_version"])
        return cls._layer

    @classmethod
    def status(cls):
        try:
            layer = cls._ensure_layer()
        except RoadTileError as ex:
            return {"ok": False, "error": str(ex)}
        return {"ok": True, "layer_id": layer["id"], "layer_name": layer["name"],
                "layer_version": layer["version"], "tile_version": layer["tile_version"],
                "sdi_version": layer["sdi_version"], "stacks": layer["stacks"],
                "sdi_stack": layer["sdi_stack"],
                "app_layers": layer["app_layers"], "conf_url": APP_CONF_URL}

    @classmethod
    def _tile(cls, x, y):
        key = (x, y)
        if key in cls._tiles:
            return cls._tiles[key]
        layer = cls._ensure_layer()

        cache_dir = os.path.join(VSM_CACHE_DIR, "roadtile", layer["tile_version"])
        os.makedirs(cache_dir, exist_ok=True)
        path = os.path.join(cache_dir, f"{TILE_ZOOM}_{x}_{y}.tile")

        if os.path.exists(path):
            raw = open(path, "rb").read()
        else:
            try:
                raw = _get(f"{layer['tile_base']}/{TILE_ZOOM}/{x}/{y}.tile")
            except RoadTileError:
                cls._tiles[key] = None
                return None
            with open(path, "wb") as file:
                file.write(raw)

        try:
            stacks = parse_tile(raw, x, y)
        except Exception as ex:
            logging.warning("타일 %d/%d 파싱 실패: %s", x, y, ex)
            cls._tiles[key] = None
            return None
        cls._tiles[key] = stacks
        return stacks

    @classmethod
    def sdi2_around(cls, x, y, radius=1):
        """선택 타일 주변 (2r+1)^2 타일의 SDI2 점 + CAM_REF_LINK 구간."""
        with cls._lock:
            layer = cls._ensure_layer()
            sdi2_id = layer["stack_ids"].get(layer["sdi_stack"])
            cam_id = layer["stack_ids"].get(STACK_CAM_REF)

            link_stack_id = layer["stack_ids"].get("LINKSHAPE")
            points = []
            seen_pt = set()
            groups = {}
            link_geoms = {}
            for tx in range(x - radius, x + radius + 1):
                for ty in range(y - radius, y + radius + 1):
                    stacks = cls._tile(tx, ty)
                    if not stacks:
                        continue
                    for feat in stacks.get(link_stack_id, []):
                        key = (feat["props"].get("MESH_ID"), feat["props"].get("LINK_ID"))
                        _add_link_fragment(link_geoms, key, feat["points"])
                    for feat in stacks.get(sdi2_id, []):
                        props = feat["props"]
                        pt_id = props.get("PT_ID")
                        if pt_id in seen_pt:
                            continue
                        seen_pt.add(pt_id)
                        sdi_type = int(props.get("Attribute", "0") or 0)
                        type_byte = int(props.get("Type", "0") or 0)
                        exact = (type_byte & 0x0F) == 10
                        lat, lon = feat["points"][0] if feat["points"] else (None, None)
                        points.append({
                            "lat": lat, "lon": lon,
                            "type": sdi_type,
                            "type_name": SAFE_DRIVE_TYPE_NAMES.get(sdi_type, f"타입 {sdi_type}"),
                            "exact": exact,
                            "speed_limit": ((type_byte & 0xF0) >> 4) * 10 + 20 if exact else None,
                            "angle": int(props.get("Angle", "0") or 0),
                            "rear": sdi_type in REAR_TYPES,
                            "pt_id": pt_id,
                            "link_id": props.get("LINK_ID"),
                            "tile": {"x": tx, "y": ty},
                        })
                    for feat in stacks.get(cam_id, []):
                        props = feat["props"]
                        group_id = props.get("GROUP_ID")
                        if not group_id:
                            continue
                        entry = groups.setdefault(group_id, {
                            "group_id": group_id,
                            "speed_limit": int(props.get("SPD_LMT", "0") or 0) or None,
                            "distance_m": int(props.get("M_DIST", "0") or 0) or None,
                            "start": feat["points"][0] if feat["points"] else None,
                            "end": None,
                            "records": {},
                        })
                        try:
                            entry["end"] = (float(props.get("E_CAMERA_Y")), float(props.get("E_CAMERA_X")))
                        except (TypeError, ValueError):
                            pass
                        try:
                            order = int(props.get("ORDER_IDX", "0") or 0)
                            entry["records"][order] = {
                                "pt": (float(props.get("Y")), float(props.get("X"))),
                                "mesh": props.get("IDXNAME"),
                                "link": props.get("LINK_ID"),
                            }
                        except (TypeError, ValueError):
                            pass

            sections = []
            for entry in groups.values():
                path = _assemble_geom_path(entry, link_geoms)
                if len(path) < 2:
                    continue
                # 구간 시점 카메라(경로 첫 점)에서 60 m 안의 SDI2 시점 타입으로 후면 여부 판단.
                # 경로 끝(CAM_REF 의 E_CAMERA)은 종점 카메라보다 ~360 m 앞이라,
                # 500 m 안에 종점 설치점이 있으면 경로를 카메라까지 이어 붙인다.
                def _nearest(lat, lon, types, limit_m):
                    best = None
                    best_d = limit_m / 111000.0
                    for point in points:
                        if point["type"] not in types or point["lat"] is None or not point["exact"]:
                            continue
                        d = math.hypot(point["lat"] - lat,
                                       (point["lon"] - lon) * math.cos(math.radians(lat)))
                        if d < best_d:
                            best_d = d
                            best = point
                    return best
                start_pt = _nearest(path[0][0], path[0][1], (22, 27, 48, 50, 52), 60)
                # 종점은 시점과 짝인 타입 우선, 없으면 아무 종점 타입.
                pair = {22: 23, 27: 28, 48: 49, 50: 51, 52: 53}.get(start_pt["type"]) if start_pt else None
                if pair:
                    end_pt = _nearest(path[-1][0], path[-1][1], (pair,), 500)
                else:
                    end_pt = _nearest(path[-1][0], path[-1][1], (23, 28, 49, 51, 53), 500)
                if end_pt is not None:
                    path.append([end_pt["lat"], end_pt["lon"]])
                start_attr = start_pt["type"] if start_pt else None
                sections.append({
                    "group_id": entry["group_id"],
                    "speed_limit": entry["speed_limit"],
                    "distance_m": entry["distance_m"],
                    "start_type": start_attr,
                    "end_type": end_pt["type"] if end_pt else None,
                    "rear": start_attr in REAR_TYPES if start_attr else False,
                    "path": path,
                })

            return {
                "layer": {k: layer[k] for k in ("id", "version", "tile_version", "sdi_version", "sdi_stack")},
                "points": points,
                "sections": sections,
            }

    _national = None

    @classmethod
    def _tile_path(cls, layer, x, y):
        cache_dir = os.path.join(VSM_CACHE_DIR, "roadtile", layer["tile_version"])
        os.makedirs(cache_dir, exist_ok=True)
        return os.path.join(cache_dir, f"{TILE_ZOOM}_{x}_{y}.tile")

    @classmethod
    def national(cls):
        """전국의 후면 단속 + 구간단속(CAM_REF_LINK) 수집.

        전국 타일 45만 장을 다 받을 수는 없으니, SAFE_DRIVE_DB 에서 구간단속
        시점/종점(22/23/27/28 - 후면 구간도 여기엔 이 타입으로 강등돼 실린다)이
        있는 타일만 골라 받는다(약 1,500장, 최초 1회만 다운로드 후 디스크 캐시).
        한계: 후면 지점단속(40/41)은 이 후보 타일 안에서 발견되는 것만 잡힌다.
        """
        if cls._national is not None:
            return cls._national
        layer = cls._ensure_layer()

        result_path = os.path.join(VSM_CACHE_DIR, "roadtile", layer["tile_version"], "national.json")
        if os.path.exists(result_path):
            with open(result_path) as file:
                cls._national = json.load(file)
            return cls._national

        from backend.tile_tool.service import geo_service as geo
        from backend.tile_tool.service.sdi_cell_service import SdiCellSource
        SdiCellSource.ensure()

        candidates = set()
        for key in SdiCellSource.cell_keys():
            for point in SdiCellSource.points_in_cell(key):
                if point["type"] in (22, 23, 27, 28):
                    candidates.add(geo.tile_from_wgs(point["lon"], point["lat"]))
        logging.info("전국 구간단속 후보 타일 %d장", len(candidates))

        def fetch(xy):
            x, y = xy
            try:
                raw = _get(f"{layer['tile_base']}/{TILE_ZOOM}/{x}/{y}.tile")
            except RoadTileError:
                return
            with open(cls._tile_path(layer, x, y), "wb") as file:
                file.write(raw)

        def download(tiles):
            missing = [(x, y) for (x, y) in tiles
                       if not os.path.exists(cls._tile_path(layer, x, y))]
            if missing:
                logging.info("타일 %d장 다운로드", len(missing))
                with ThreadPoolExecutor(max_workers=8) as pool:
                    list(pool.map(fetch, missing))

        sdi2_id = layer["stack_ids"].get(layer["sdi_stack"])
        cam_id = layer["stack_ids"].get(STACK_CAM_REF)
        SECTION_TYPES = {22, 23, 27, 28, 48, 49, 50, 51, 52, 53}

        def collect(tiles):
            """후보 타일들에서 SDI2 점과 CAM_REF 그룹(원시 경로)을 모은다."""
            points = []
            seen_pt = set()
            groups = {}
            for (x, y) in sorted(tiles):
                stacks = cls._tile(x, y)
                if not stacks:
                    continue
                for feat in stacks.get(sdi2_id, []):
                    props = feat["props"]
                    sdi_type = int(props.get("Attribute", "0") or 0)
                    if sdi_type not in REAR_TYPES and sdi_type not in SECTION_TYPES:
                        continue
                    pt_id = props.get("PT_ID")
                    if pt_id in seen_pt:
                        continue
                    seen_pt.add(pt_id)
                    type_byte = int(props.get("Type", "0") or 0)
                    exact = (type_byte & 0x0F) == 10
                    lat, lon = feat["points"][0] if feat["points"] else (None, None)
                    points.append({
                        "lat": lat, "lon": lon,
                        "type": sdi_type,
                        "type_name": SAFE_DRIVE_TYPE_NAMES.get(sdi_type, f"타입 {sdi_type}"),
                        "exact": exact,
                        "speed_limit": ((type_byte & 0xF0) >> 4) * 10 + 20 if exact else None,
                        "angle": int(props.get("Angle", "0") or 0),
                        "rear": sdi_type in REAR_TYPES,
                        "pt_id": pt_id,
                        "link_id": props.get("LINK_ID"),
                        "tile": {"x": x, "y": y},
                    })
                for feat in stacks.get(cam_id, []):
                    props = feat["props"]
                    group_id = props.get("GROUP_ID")
                    if not group_id:
                        continue
                    entry = groups.setdefault(group_id, {
                        "group_id": group_id,
                        "speed_limit": int(props.get("SPD_LMT", "0") or 0) or None,
                        "distance_m": int(props.get("M_DIST", "0") or 0) or None,
                        "start": feat["points"][0] if feat["points"] else None,
                        "end": None,
                        "records": {},
                    })
                    try:
                        entry["end"] = (float(props.get("E_CAMERA_Y")), float(props.get("E_CAMERA_X")))
                    except (TypeError, ValueError):
                        pass
                    try:
                        order = int(props.get("ORDER_IDX", "0") or 0)
                        entry["records"][order] = {
                            "pt": (float(props.get("Y")), float(props.get("X"))),
                            "mesh": props.get("IDXNAME"),
                            "link": props.get("LINK_ID"),
                        }
                    except (TypeError, ValueError):
                        pass
            return points, groups

        def build_path(entry):
            path = []
            if entry["start"]:
                path.append(list(entry["start"]))
            for order in sorted(entry["records"]):
                path.append(list(entry["records"][order]["pt"]))
            if entry["end"]:
                path.append(list(entry["end"]))
            return path

        def dist_m(a, b):
            return math.hypot((a[0] - b[0]) * 111000.0,
                              (a[1] - b[1]) * 88000.0)

        # 1차 수집 후, 경로에 700 m 넘는 점프(중간 타일 누락)가 있으면 그 선분을
        # 따라 타일을 추가로 받아 다시 수집한다. 보통 2~3회면 안정된다.
        download(candidates)
        points, groups = collect(candidates)
        for _ in range(4):
            extra = set()
            for entry in groups.values():
                path = build_path(entry)
                for a, b in zip(path, path[1:]):
                    gap = dist_m(a, b)
                    if gap <= 700:
                        continue
                    steps = int(gap // 500) + 1
                    for i in range(steps + 1):
                        lat = a[0] + (b[0] - a[0]) * i / steps
                        lon = a[1] + (b[1] - a[1]) * i / steps
                        extra.add(geo.tile_from_wgs(lon, lat))
            extra -= candidates
            if not extra:
                break
            logging.info("경로 보강 타일 %d장", len(extra))
            download(extra)
            candidates |= extra
            points, groups = collect(candidates)

        # 구간 완성: 시점 타입 판정 + 경로 끝을 실제 종점 카메라에 스냅.
        # (CAM_REF 의 E_CAMERA 좌표는 종점 카메라보다 전국 공통 ~360 m 앞이라
        #  마커와 선 끝이 어긋나 보인다. 500 m 안에 종점 설치점이 있으면 붙인다.)
        START_TYPES = (22, 27, 48, 50, 52)
        END_TYPES = (23, 28, 49, 51, 53)
        START_END_PAIR = {22: 23, 27: 28, 48: 49, 50: 51, 52: 53}
        exact_starts = [p for p in points if p["exact"] and p["type"] in START_TYPES]
        exact_ends = [p for p in points if p["exact"] and p["type"] in END_TYPES]

        def nearest(cands, lat, lon, limit_m):
            best = None
            best_d = limit_m
            for point in cands:
                if point["lat"] is None:
                    continue
                d = dist_m((point["lat"], point["lon"]), (lat, lon))
                if d < best_d:
                    best_d = d
                    best = point
            return best

        # 경로를 링크 실제 형상으로 잇기 위해 필요한 링크 형상만 골라 모은다.
        link_stack_id = layer["stack_ids"].get("LINKSHAPE")
        needed = set()
        for entry in groups.values():
            for rec in entry["records"].values():
                needed.add((rec["mesh"], rec["link"]))
        def gather_geoms(tiles, geoms):
            for (gx, gy) in tiles:
                stacks = cls._tile(gx, gy)
                if not stacks:
                    continue
                for feat in stacks.get(link_stack_id, []):
                    key = (feat["props"].get("MESH_ID"), feat["props"].get("LINK_ID"))
                    if key in needed:
                        _add_link_fragment(geoms, key, feat["points"])

        link_geoms = {}
        gather_geoms(candidates, link_geoms)
        # 형상을 못 찾은 링크는 대표점이 있는 타일(주변 포함)을 추가로 받아 본다.
        for _ in range(2):
            missing_links = needed - set(link_geoms)
            if not missing_links:
                break
            extra = set()
            for entry in groups.values():
                for rec in entry["records"].values():
                    if (rec["mesh"], rec["link"]) in missing_links:
                        tx, ty = geo.tile_from_wgs(rec["pt"][1], rec["pt"][0])
                        for dx in (-1, 0, 1):
                            for dy in (-1, 0, 1):
                                extra.add((tx + dx, ty + dy))
            extra -= candidates
            if not extra:
                break
            logging.info("링크 형상 보강 타일 %d장", len(extra))
            download(extra)
            candidates |= extra
            gather_geoms(extra, link_geoms)
        logging.info("링크 형상 %d/%d 확보", len(link_geoms), len(needed))

        sections = []
        for entry in groups.values():
            path = _assemble_geom_path(entry, link_geoms)
            if len(path) < 2:
                continue
            start_pt = nearest(exact_starts, path[0][0], path[0][1], 60)
            # 종점 스냅은 시점과 짝인 타입만. 짝 종점이 데이터에 없으면(일부 후면
            # 구간이 그렇다) 다른 구간 종점에 잘못 붙이느니 E_CAMERA 끝점을 둔다.
            pair_type = START_END_PAIR.get(start_pt["type"]) if start_pt else None
            end_pt = None
            if pair_type is not None:
                end_pt = nearest([p for p in exact_ends if p["type"] == pair_type],
                                 path[-1][0], path[-1][1], 500)
            elif start_pt is None:
                end_pt = nearest(exact_ends, path[-1][0], path[-1][1], 500)
            if end_pt is not None:
                path.append([end_pt["lat"], end_pt["lon"]])
            start_attr = start_pt["type"] if start_pt else None
            sections.append({
                "group_id": entry["group_id"],
                "speed_limit": entry["speed_limit"],
                "distance_m": entry["distance_m"],
                "start_type": start_attr,
                "end_type": end_pt["type"] if end_pt else None,
                "rear": start_attr in REAR_TYPES if start_attr else False,
                "path": path,
            })

        # 셀 밀도 - 셀별 후면 SDI / 구간단속 수
        from backend.tile_tool.service import safe_drive_db as sdb
        rear_cells = Counter()
        section_cells = Counter()
        for point in points:
            if point["rear"] and point["lat"] is not None:
                rear_cells[sdb.cell_key(point["lon"], point["lat"])] += 1
        for section in sections:
            s_lat, s_lon = section["path"][0]
            section_cells[sdb.cell_key(s_lon, s_lat)] += 1
        cells = []
        for key in set(rear_cells) | set(section_cells):
            cells.append({
                "key": key,
                "mesh": sdb.mesh_from_cell_key(key),
                "ring": sdb.cell_ring(key),
                "rear_count": rear_cells.get(key, 0),
                "section_count": section_cells.get(key, 0),
            })

        cls._national = {
            "layer": {k: layer[k] for k in ("id", "version", "tile_version", "sdi_version", "sdi_stack")},
            "tile_count": len(candidates),
            "points": points,
            "sections": sections,
            "cells": cells,
        }
        with open(result_path, "w") as file:
            json.dump(cls._national, file)
        return cls._national
