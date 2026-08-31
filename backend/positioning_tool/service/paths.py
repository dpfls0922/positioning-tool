import os
from dataclasses import dataclass


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
BACKEND_DIR = os.path.join(PROJECT_ROOT, "backend")
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")


@dataclass(frozen=True)
class AppPaths:
    project_root: str = PROJECT_ROOT
    backend_dir: str = BACKEND_DIR
    frontend_dir: str = FRONTEND_DIR
    log_file_path: str = os.path.join(PROJECT_ROOT, "test.txt")
    output_html: str = os.path.join(PROJECT_ROOT, "result.html")
    output_csv: str = os.path.join(PROJECT_ROOT, "result.csv")
    output_json: str = os.path.join(PROJECT_ROOT, "result.json")
    static_dir: str = os.path.join(FRONTEND_DIR, "static")
    css_file: str = os.path.join(FRONTEND_DIR, "static", "css", "map.css")
    js_dir: str = os.path.join(FRONTEND_DIR, "static", "js")
    js_map_parts_dir: str = os.path.join(FRONTEND_DIR, "static", "js", "map")



# 렌더 시 이 순서대로 이어붙여 하나의 <script> 로 출력한다.
# (원래 map_script.js 한 파일이었고, 순서를 바꾸면 로드 시점 의존성이 깨질 수 있다)
JS_MAP_PART_FILES = (
    "01-state.js",
    "02-init.js",
    "03-route-info.js",
    "04-measure-tools.js",
    "05-map-interaction.js",
    "06-tmap-route.js",
    "07-ui-panels.js",
    "08-road-style-config.js",
    "09-road-shape-cache.js",
    "10-road-rules.js",
    "11-upload-flow.js",
    "12-road-worker.js",
    "13-road-layers.js",
    "14-lane-width.js",
    "15-road-viewport.js",
    "16-export-reset.js",
    "17-markers.js",
    "18-candidate-table.js",
    "19-polylines.js",
    "20-layer-control.js",
    "21-visibility.js",
    "22-search.js",
    "23-guide-events.js",
    "24-gp-guide.js",
    "25-lane-bubble.js",
    "26-place-search.js",
    "27-omnibox.js",
    "29-sdi-block-hud.js",
    "30-panel-utils.js",
    "31-roadview.js",
    "33-skyview.js",
    "35-search-results.js",
    "34-simulation.js",
)

PATHS = AppPaths()
