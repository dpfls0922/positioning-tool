from flask import Flask

from backend.positioning_tool.service.env_file_service import load_env_file
from backend.positioning_tool.service.paths import PATHS
from backend.positioning_tool.controller.log_controller import create_log_controller


def create_app() -> Flask:
    # .env 의 API 키를 먼저 읽어둔다(이미 export 된 값은 그대로 둔다).
    load_env_file()
    app = Flask(
        __name__,
        static_folder=PATHS.static_dir,
        static_url_path="/static",
    )
    app.register_blueprint(create_log_controller())
    return app
