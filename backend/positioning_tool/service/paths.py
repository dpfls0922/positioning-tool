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
    js_file: str = os.path.join(FRONTEND_DIR, "static", "js", "map_script.js")


PATHS = AppPaths()
