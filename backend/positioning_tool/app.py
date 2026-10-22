from flask import Flask

from backend.positioning_tool.service.env_file_service import load_env_file
from backend.positioning_tool.service.paths import PATHS
from backend.positioning_tool.controller.log_controller import create_log_controller
from backend.tile_tool.controller.tile_controller import create_tile_controller


# SDI 타일 조회 툴이 붙는 경로. 사이드바 상단의 "SDI 검색" 탭이 여기로 간다.
SDI_TOOL_PREFIX = "/sdi"


def create_app() -> Flask:
    # .env 의 API 키를 먼저 읽어둔다(이미 export 된 값은 그대로 둔다).
    load_env_file()
    app = Flask(
        __name__,
        static_folder=PATHS.static_dir,
        static_url_path="/static",
    )
    app.register_blueprint(create_log_controller())
    # SDI 타일 조회 툴. static 폴더를 공유하므로 그대로 얹으면 된다.
    app.register_blueprint(
        create_tile_controller(SDI_TOOL_PREFIX), url_prefix=SDI_TOOL_PREFIX)
    return app
