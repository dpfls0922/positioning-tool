import logging

from flask import Flask

from backend.tile_tool.controller.tile_controller import create_tile_controller
from backend.tile_tool.service.paths import STATIC_DIR
from backend.tile_tool.service.sdi_cell_service import SdiCellSource


def create_app() -> Flask:
    app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
    app.register_blueprint(create_tile_controller())

    # SDI 원본은 이 툴의 기본 데이터다. 캐시가 있으면 즉시, 없으면 1 MB 를
    # 내려받는다(1초 내외). 실패해도 툴 자체는 떠야 하므로 삼켜서 남긴다.
    try:
        status = SdiCellSource.fetch()
        print(f"SAFE_DRIVE_DB {status['version']} 로드: "
              f"SDI {status['record_total']:,}건 / 셀 {status['cell_count']:,}개")
    except Exception as ex:
        logging.warning("SAFE_DRIVE_DB 를 불러오지 못했습니다: %s", ex)

    return app
