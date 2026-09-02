import os
import tempfile

from flask import Blueprint, Response, jsonify, request

from backend.tile_tool.service import geo_service as geo
from backend.tile_tool.service.page_service import render_page
from backend.tile_tool.service.query_service import QueryError, resolve
from backend.tile_tool.service.sdi_cell_service import SdiCellSource
from backend.tile_tool.service.sdi_source_service import (
    LogParserUnavailable,
    SdiSource,
    annotate_with_log_types,
)
from backend.tile_tool.service.vsm_client import SERVERS, VsmError


def _save_upload_to_temp(upload):
    suffix = os.path.splitext(upload.filename)[1] or ".log"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        upload.save(tmp)
        return tmp.name


def create_tile_controller(base: str = "") -> Blueprint:
    """base 는 이 블루프린트를 붙이는 경로 접두어(url_prefix 와 같은 값)."""
    bp = Blueprint("tile", __name__)

    @bp.before_request
    def ensure_db():
        # positioning-tool 안에 마운트되면 앱 시작 때 안 읽으므로 여기서 챙긴다.
        SdiCellSource.ensure()

    @bp.get("/")
    def index():
        response = Response(render_page(base), mimetype="text/html")
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        return response

    @bp.get("/api/resolve")
    def resolve_api():
        try:
            target = resolve(request.args.get("q", ""))
        except QueryError as ex:
            return jsonify({"ok": False, "error": str(ex)}), 400

        tile = target["tile"]
        points = SdiSource.in_tile(tile["x"], tile["y"], target["zoom"])
        cell = SdiCellSource.cell_at(tile["center"]["lat"], tile["center"]["lon"])
        return jsonify({"ok": True, "target": target, "sdi": points, "cell": cell})

    @bp.get("/api/cell")
    def cell_api():
        """마우스가 놓인 좌표의 타일 / 메시를 알려준다."""
        try:
            lat = float(request.args["lat"])
            lon = float(request.args["lon"])
            zoom = int(request.args.get("zoom", geo.DEFAULT_TILE_ZOOM))
        except (KeyError, ValueError):
            return jsonify({"ok": False, "error": "lat, lon 이 필요합니다."}), 400

        tile_x, tile_y = geo.tile_from_wgs(lon, lat, zoom)
        mesh_code = geo.mesh_code_from_wgs(lon, lat)
        return jsonify({
            "ok": True,
            "tile": {"x": tile_x, "y": tile_y, "id": geo.tile_id(tile_x, tile_y)},
            "mesh": {"code": mesh_code, "ring": geo.mesh_ring(mesh_code)},
        })

    @bp.post("/api/sdi-source")
    def upload_sdi_source_api():
        """로그를 올리거나(file), 로컬 경로를 지정해(path) SDI 를 읽는다.

        DLT 로그는 수 GB 인 경우가 많아 브라우저 업로드가 비현실적이다.
        서버가 같은 PC 에서 도는 툴이므로 경로 지정을 함께 받는다.
        """
        upload = request.files.get("file")
        local_path = (request.form.get("path") or "").strip()

        if upload is None and not local_path:
            return jsonify({"ok": False, "error": "파일을 올리거나 로그 경로를 입력해 주세요."}), 400

        tmp_path = None
        try:
            if local_path:
                source_path = os.path.expanduser(local_path)
                if not os.path.isfile(source_path):
                    return jsonify({"ok": False, "error": f"파일을 찾을 수 없습니다: {source_path}"}), 400
                name = os.path.splitext(os.path.basename(source_path))[0]
            else:
                if not upload.filename:
                    return jsonify({"ok": False, "error": "업로드할 파일이 없습니다."}), 400
                tmp_path = _save_upload_to_temp(upload)
                source_path = tmp_path
                name = os.path.splitext(upload.filename)[0]

            summary = SdiSource.load_from_log(source_path, name)
            if summary is None:
                return jsonify({"ok": False, "error": "로그 파싱에 실패했습니다."}), 400
            return jsonify({"ok": True, "summary": summary})
        except LogParserUnavailable as ex:
            return jsonify({"ok": False, "error": str(ex)}), 501
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)

    @bp.get("/api/sdi-source")
    def sdi_source_api():
        return jsonify({"ok": True, "summary": SdiSource.summary()})

    @bp.delete("/api/sdi-source")
    def clear_sdi_source_api():
        SdiSource.clear()
        return jsonify({"ok": True, "summary": SdiSource.summary()})

    @bp.get("/api/sdi")
    def sdi_api():
        """지도에 뿌릴 SDI 전체. 타일/메시로 좁힐 수도 있다."""
        mesh_code = request.args.get("mesh")
        if mesh_code:
            return jsonify({"ok": True, "sdi": SdiSource.in_mesh(int(mesh_code))})
        return jsonify({"ok": True, "sdi": SdiSource.points()})

    @bp.post("/api/vsm/fetch")
    def vsm_fetch_api():
        payload = request.get_json(silent=True) or {}
        server = payload.get("server") or "dev"
        if server not in SERVERS:
            return jsonify({"ok": False, "error": f"알 수 없는 서버: {server}"}), 400
        try:
            return jsonify({"ok": True, "status": SdiCellSource.fetch(
                server=server, force=bool(payload.get("force")))})
        except VsmError as ex:
            return jsonify({"ok": False, "error": str(ex)}), 502
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    @bp.get("/api/vsm/status")
    def vsm_status_api():
        return jsonify({"ok": True, "status": SdiCellSource.status()})

    @bp.get("/api/vsm/cells")
    def vsm_cells_api():
        try:
            south = float(request.args["south"]); west = float(request.args["west"])
            north = float(request.args["north"]); east = float(request.args["east"])
        except (KeyError, ValueError):
            return jsonify({"ok": False, "error": "south, west, north, east 가 필요합니다."}), 400
        return jsonify({"ok": True, "cells": SdiCellSource.cells_in_bounds(south, west, north, east)})

    @bp.get("/api/vsm/points")
    def vsm_points_api():
        """선택한 타일 안의 SDI 좌표만 돌려준다."""
        try:
            tile_x = int(request.args["x"]); tile_y = int(request.args["y"])
            zoom = int(request.args.get("zoom", geo.DEFAULT_TILE_ZOOM))
        except (KeyError, ValueError):
            return jsonify({"ok": False, "error": "x, y 가 필요합니다."}), 400
        points = annotate_with_log_types(SdiCellSource.points_in_tile(tile_x, tile_y, zoom))
        return jsonify({"ok": True, "points": points})

    return bp
