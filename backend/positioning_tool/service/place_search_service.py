"""상호명(장소) 검색 + 리뷰 조회.

장소 검색 제공자 (환경변수로 자동 선택, 카카오 우선):

  1) 카카오 로컬 API      : KAKAO_REST_API_KEY
     일 100,000건 무료, 결제수단 등록 불필요.
  2) 네이버 검색 API '지역' : NAVER_API_HUB_KEY_ID / NAVER_API_HUB_KEY (NAVER API HUB)
     또는 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET (개발자센터, 2027-06-30 까지 유예)

리뷰는 네이버 검색 API '블로그' 로만 가져올 수 있다. 카카오에는 리뷰 API 가 없고,
네이버 플레이스의 방문자 리뷰/별점도 공식 API 가 없다(내부 엔드포인트는 봇 차단).
그래서 네이버 키가 없으면 리뷰 대신 지도 서비스의 후기 페이지 링크를 돌려준다.
"""

import html
import json
import os
import re
import ssl
import time
from urllib import parse as urllib_parse
from urllib import request as urllib_request

KAKAO_KEYWORD_ENDPOINT = "https://dapi.kakao.com/v2/local/search/keyword.json"
NAVER_HUB_LOCAL_ENDPOINT = "https://naverapihub.apigw.ntruss.com/search/v1/local"
NAVER_HUB_BLOG_ENDPOINT = "https://naverapihub.apigw.ntruss.com/search/v1/blog"
NAVER_LEGACY_LOCAL_ENDPOINT = "https://openapi.naver.com/v1/search/local.json"
NAVER_LEGACY_BLOG_ENDPOINT = "https://openapi.naver.com/v1/search/blog.json"

NAVER_PLACE_LINK_BASE = "https://map.naver.com/p/search/"

CACHE_TTL_SECONDS = 300
REQUEST_TIMEOUT_SECONDS = 10
TAG_PATTERN = re.compile(r"<[^>]+>")

_cache = {}


class PlaceApiKeyMissingError(Exception):
    """장소 검색에 쓸 API 키가 하나도 설정되지 않은 경우."""


class ReviewSourceUnavailableError(Exception):
    """리뷰를 가져올 네이버 검색 API 키가 없는 경우."""


def _ssl_context():
    """macOS 파이썬처럼 시스템 CA 를 못 찾는 환경에서도 검증을 유지한다."""
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _env(name):
    return (os.environ.get(name) or "").strip()


def _kakao_auth():
    key = _env("KAKAO_REST_API_KEY")
    return {"Authorization": f"KakaoAK {key}"} if key else None


def _naver_auth():
    """네이버 검색 API 인증 헤더. HUB 키가 있으면 우선 사용한다."""
    hub_key_id = _env("NAVER_API_HUB_KEY_ID")
    hub_key = _env("NAVER_API_HUB_KEY")
    if hub_key_id and hub_key:
        return "hub", {
            "X-NCP-APIGW-API-KEY-ID": hub_key_id,
            "X-NCP-APIGW-API-KEY": hub_key,
        }

    client_id = _env("NAVER_CLIENT_ID")
    client_secret = _env("NAVER_CLIENT_SECRET")
    if client_id and client_secret:
        return "legacy", {
            "X-Naver-Client-Id": client_id,
            "X-Naver-Client-Secret": client_secret,
        }
    return None, None


def active_search_provider():
    """지금 쓸 수 있는 장소 검색 제공자 이름."""
    if _kakao_auth():
        return "kakao"
    if _naver_auth()[1]:
        return "naver"
    return None


def _clean_text(value):
    """검색 API 응답의 <b> 하이라이트 태그와 HTML 엔티티를 제거한다."""
    if not value:
        return ""
    return html.unescape(TAG_PATTERN.sub("", str(value))).strip()


def _cache_get(key):
    hit = _cache.get(key)
    if not hit:
        return None
    stored_at, value = hit
    if time.time() - stored_at > CACHE_TTL_SECONDS:
        _cache.pop(key, None)
        return None
    return value


def _cache_put(key, value):
    _cache[key] = (time.time(), value)


def _get_json(endpoint, params, headers):
    url = f"{endpoint}?{urllib_parse.urlencode(params)}"
    req = urllib_request.Request(
        url,
        headers={**headers, "Accept": "application/json"},
        method="GET",
    )
    with urllib_request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS, context=_ssl_context()) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _to_float(raw):
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return None
    return value or None


def _naver_to_degrees(raw):
    """네이버 지역검색의 mapx/mapy 를 WGS84 도 단위로 변환한다.

    현재 응답은 도 단위 * 1e7 정수(예: 1270276150)로 오지만, 소수점 형태로
    오는 경우도 안전하게 처리한다.
    """
    value = _to_float(raw)
    if value is None:
        return None
    return value / 1e7 if abs(value) > 1000 else value


def _naver_place_link(name, address):
    return NAVER_PLACE_LINK_BASE + urllib_parse.quote(f"{name} {address}".strip())


def _locality_from_address(address):
    """리뷰 검색 정확도를 위해 주소에서 '구/동' 수준 키워드를 뽑는다."""
    tokens = (address or "").split()
    picked = [t for t in tokens if t.endswith(("구", "동", "읍", "면", "시"))]
    return picked[-1] if picked else ""


def _normalize_kakao_place(item):
    name = _clean_text(item.get("place_name"))
    address = _clean_text(item.get("address_name"))
    road_address = _clean_text(item.get("road_address_name"))
    return {
        "provider": "kakao",
        "name": name,
        "category": _clean_text(item.get("category_name")),
        "telephone": _clean_text(item.get("phone")),
        "address": address,
        "road_address": road_address,
        "lat": _to_float(item.get("y")),
        "lon": _to_float(item.get("x")),
        # 카카오맵 장소 상세 페이지 — 후기 탭이 여기 있다.
        "place_url": _clean_text(item.get("place_url")),
        "naver_place_url": _naver_place_link(name, road_address or address),
    }


def _normalize_naver_place(item):
    name = _clean_text(item.get("title"))
    address = _clean_text(item.get("address"))
    road_address = _clean_text(item.get("roadAddress"))
    return {
        "provider": "naver",
        "name": name,
        "category": _clean_text(item.get("category")),
        "telephone": _clean_text(item.get("telephone")),
        "address": address,
        "road_address": road_address,
        "lat": _naver_to_degrees(item.get("mapy")),
        "lon": _naver_to_degrees(item.get("mapx")),
        "place_url": _naver_place_link(name, road_address or address),
        "naver_place_url": _naver_place_link(name, road_address or address),
    }


def _normalize_review(item):
    raw_date = _clean_text(item.get("postdate"))
    if len(raw_date) == 8:
        posted_at = f"{raw_date[0:4]}.{raw_date[4:6]}.{raw_date[6:8]}"
    else:
        posted_at = raw_date
    return {
        "title": _clean_text(item.get("title")),
        "snippet": _clean_text(item.get("description")),
        "author": _clean_text(item.get("bloggername")),
        "author_link": _clean_text(item.get("bloggerlink")),
        "posted_at": posted_at,
        "link": _clean_text(item.get("link")),
    }


class PlaceSearchService:
    @staticmethod
    def search_places(query, display=5):
        keyword = (query or "").strip()
        if not keyword:
            raise ValueError("검색할 상호명을 입력해주세요.")

        provider = active_search_provider()
        if provider is None:
            raise PlaceApiKeyMissingError(
                "장소 검색 API 키가 없습니다. 카카오 개발자센터에서 REST API 키를 발급받아 "
                "KAKAO_REST_API_KEY 환경변수를 설정한 뒤 서버를 다시 실행해주세요."
            )

        # 카카오는 최대 15, 네이버 지역검색은 최대 5 까지 허용한다.
        limit = 15 if provider == "kakao" else 5
        count = max(1, min(int(display or 5), limit))

        cache_key = ("place", provider, keyword, count)
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

        if provider == "kakao":
            payload = _get_json(
                KAKAO_KEYWORD_ENDPOINT,
                {"query": keyword, "size": count},
                _kakao_auth(),
            )
            places = [_normalize_kakao_place(item) for item in (payload.get("documents") or [])]
        else:
            mode, headers = _naver_auth()
            endpoint = NAVER_HUB_LOCAL_ENDPOINT if mode == "hub" else NAVER_LEGACY_LOCAL_ENDPOINT
            payload = _get_json(
                endpoint,
                {"query": keyword, "display": count, "sort": "random"},
                headers,
            )
            places = [_normalize_naver_place(item) for item in (payload.get("items") or [])]

        result = {"provider": provider, "places": places}
        _cache_put(cache_key, result)
        return result

    @staticmethod
    def search_reviews(place_name, address="", display=10):
        name = (place_name or "").strip()
        if not name:
            raise ValueError("리뷰를 조회할 상호명이 없습니다.")

        mode, headers = _naver_auth()
        if headers is None:
            raise ReviewSourceUnavailableError(
                "리뷰를 가져올 수 있는 API 키가 없습니다. 카카오에는 리뷰 API 가 없어서, "
                "블로그 리뷰는 네이버 검색 API 키(NAVER_API_HUB_KEY_ID / NAVER_API_HUB_KEY)가 "
                "있을 때만 표시됩니다. 그때까지는 아래 지도 링크에서 후기를 확인하세요."
            )

        count = max(1, min(int(display or 10), 20))
        locality = _locality_from_address(address)
        keyword = " ".join(part for part in (name, locality, "리뷰") if part)

        cache_key = ("review", keyword, count)
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

        endpoint = NAVER_HUB_BLOG_ENDPOINT if mode == "hub" else NAVER_LEGACY_BLOG_ENDPOINT
        payload = _get_json(endpoint, {"query": keyword, "display": count, "sort": "sim"}, headers)
        reviews = [_normalize_review(item) for item in (payload.get("items") or [])]
        result = {
            "query": keyword,
            "total": payload.get("total", len(reviews)),
            "reviews": reviews,
        }
        _cache_put(cache_key, result)
        return result
