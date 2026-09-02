import os


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")
# SDI 아이콘 등은 기존 툴과 같은 static 을 그대로 쓴다.
STATIC_DIR = os.path.join(FRONTEND_DIR, "static")
TILE_ASSET_DIR = os.path.join(STATIC_DIR, "tile")

# 서버에서 받은 VSM 리소스를 캐시해 두는 곳(재실행해도 다시 받지 않는다).
VSM_CACHE_DIR = os.path.join(PROJECT_ROOT, "data", "vsm_cache")

TILE_CSS = os.path.join(TILE_ASSET_DIR, "tile.css")

# 포지셔닝 화면과 함께 쓰는 화면 전환 자산 (positioning-tool 에 마운트됐을 때만 사용)
APP_SWITCH_CSS = os.path.join(STATIC_DIR, "css", "app-switch.css")
APP_SWITCH_JS = os.path.join(STATIC_DIR, "js", "app-switch.js")
TILE_JS_FILES = (
    "01-state.js",
    "02-map.js",
    "03-search.js",
    "04-sdi.js",
    "05-upload.js",
    "06-vsm.js",
)
