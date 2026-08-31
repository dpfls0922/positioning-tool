"""카카오 로컬 API (REST) 래퍼 — 좌표 → 주소/행정구역 변환.

인증: KAKAO_REST_API_KEY (카카오 개발자센터 > 앱 키 > REST API 키)
로컬 API 는 일 100,000건 무료이며 결제수단 등록이 필요 없다.

장소 키워드 검색은 place_search_service 가 담당한다(제공자 전환 때문에 분리).
"""

import json
import os
import ssl
import time
from urllib import parse as urllib_parse
from urllib import request as urllib_request

KAKAO_BASE = "https://dapi.kakao.com"

COORD_TO_ADDRESS_PATH = "/v2/local/geo/coord2address.json"
COORD_TO_REGION_PATH = "/v2/local/geo/coord2regioncode.json"

CACHE_TTL_SECONDS = 300
REQUEST_TIMEOUT_SECONDS = 10

_cache = {}


class KakaoRestKeyMissingError(Exception):
    """KAKAO_REST_API_KEY 가 설정되지 않은 경우."""


def _ssl_context():
    """macOS 파이썬처럼 시스템 CA 를 못 찾는 환경에서도 검증을 유지한다."""
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _auth_headers():
    key = (os.environ.get("KAKAO_REST_API_KEY") or "").strip()
    if not key:
        raise KakaoRestKeyMissingError(
            "카카오 REST API 키가 없습니다. 카카오 개발자센터 > 앱 키 > REST API 키를 "
            "KAKAO_REST_API_KEY 환경변수(또는 프로젝트 루트 .env)에 설정한 뒤 서버를 다시 실행해주세요."
        )
    return {"Authorization": f"KakaoAK {key}", "Accept": "application/json"}


def _get(path, params, cache_key=None):
    if cache_key is not None:
        hit = _cache.get(cache_key)
        if hit and time.time() - hit[0] <= CACHE_TTL_SECONDS:
            return hit[1]

    url = f"{KAKAO_BASE}{path}?{urllib_parse.urlencode(params)}"
    req = urllib_request.Request(url, headers=_auth_headers(), method="GET")
    with urllib_request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS, context=_ssl_context()) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    if cache_key is not None:
        _cache[cache_key] = (time.time(), payload)
    return payload


def _require_coord(lat, lon):
    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except (TypeError, ValueError):
        raise ValueError("lat, lon 값이 올바르지 않습니다.")
    if not (-90 <= lat_f <= 90) or not (-180 <= lon_f <= 180):
        raise ValueError("lat, lon 범위를 벗어났습니다.")
    return lat_f, lon_f


def _pick_address(document):
    address = document.get("address") or {}
    road_address = document.get("road_address") or {}
    return {
        "address": (address.get("address_name") or "").strip(),
        "road_address": (road_address.get("address_name") or "").strip(),
        "building_name": (road_address.get("building_name") or "").strip(),
        "zone_no": (road_address.get("zone_no") or "").strip(),
    }


def _pick_region(documents):
    """행정동(H)과 법정동(B) 을 각각 뽑는다."""
    result = {}
    for doc in documents or []:
        kind = "administrative" if doc.get("region_type") == "H" else "legal"
        result[kind] = {
            "name": (doc.get("address_name") or "").strip(),
            "code": (doc.get("code") or "").strip(),
        }
    return result


class KakaoLocalService:
    @staticmethod
    def reverse_geocode(lat, lon):
        """좌표 → 주소 + 행정구역. 마커 팝업의 '주소' 버튼에서 쓴다."""
        lat_f, lon_f = _require_coord(lat, lon)
        coord_params = {"x": f"{lon_f:.7f}", "y": f"{lat_f:.7f}", "input_coord": "WGS84"}

        address_payload = _get(
            COORD_TO_ADDRESS_PATH, coord_params, cache_key=("addr", round(lat_f, 6), round(lon_f, 6))
        )
        region_payload = _get(
            COORD_TO_REGION_PATH, coord_params, cache_key=("region", round(lat_f, 6), round(lon_f, 6))
        )

        documents = address_payload.get("documents") or []
        return {
            "lat": lat_f,
            "lon": lon_f,
            **_pick_address(documents[0] if documents else {}),
            "region": _pick_region(region_payload.get("documents")),
        }
