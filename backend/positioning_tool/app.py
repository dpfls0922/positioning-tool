from flask import Flask

from backend.positioning_tool.service.paths import PATHS
from backend.positioning_tool.controller.log_controller import create_log_controller


def create_app() -> Flask:
    app = Flask(
        __name__,
        static_folder=PATHS.static_dir,
        static_url_path="/static",
    )
    app.register_blueprint(create_log_controller())
    return app
