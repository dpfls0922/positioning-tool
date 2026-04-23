import os
import tempfile
import time

from flask import Blueprint, Response, jsonify, request, send_from_directory

from backend.positioning_tool.service.log_service import LogService
from backend.positioning_tool.service.html_renderer_service import render_html
from backend.positioning_tool.service.road_shape_service import RoadShapeService
from backend.positioning_tool.service.paths import PATHS


def _validate_upload_file(req):
    upload = req.files.get("file")
    if upload is None or not upload.filename:
        return None, (jsonify({"ok": False, "error": "업로드할 파일이 없습니다."}), 400)
    return upload, None


def _save_upload_to_temp(upload):
    suffix = os.path.splitext(upload.filename)[1] or ".log"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        upload.save(tmp)
        return tmp.name


def _parse_uploaded_log(tmp_path, upload_name):
    result_name = os.path.splitext(upload_name)[0]
    return LogService.parse_file(tmp_path, result_name=result_name), result_name


def _build_parse_response(result, result_name, start_time):
    payload = result.to_payload()
    payload["result_name"] = result_name
    payload["ok"] = True
    payload["elapsed_ms"] = int((time.time() - start_time) * 1000)
    return jsonify(payload)


def _cleanup_temp_file(path):
    if path and os.path.exists(path):
        os.remove(path)


def create_log_controller() -> Blueprint:
    bp = Blueprint("log", __name__)

    @bp.get("/favicon.ico")
    def favicon():
        favicon_path = os.path.join(PATHS.static_dir, "favicon.ico")
        if os.path.exists(favicon_path):
            return send_from_directory(PATHS.static_dir, "favicon.ico", mimetype="image/vnd.microsoft.icon")
        return Response(status=204)

    @bp.get("/")
    def index():
        return render_html([], [])

    @bp.post("/api/parse-log")
    def parse_log_api():
        upload, error_response = _validate_upload_file(request)
        if error_response:
            return error_response

        start_time = time.time()
        tmp_path = None

        try:
            tmp_path = _save_upload_to_temp(upload)
            result, result_name = _parse_uploaded_log(tmp_path, upload.filename)

            if result is None:
                return jsonify({"ok": False, "error": "로그 파싱에 실패했습니다."}), 400

            return _build_parse_response(result, result_name, start_time)
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500
        finally:
            _cleanup_temp_file(tmp_path)

    @bp.post("/api/export-html")
    def export_html_api():
        try:
            body = request.get_json(silent=True) or {}
            issue_id = (body.get("issue_id") or "").strip() or None
            out_path = LogService.export_last_result_html(issue_id=issue_id)
            if not out_path:
                return jsonify({"ok": False, "error": "먼저 로그를 파싱해주세요."}), 400
            return jsonify(
                {
                    "ok": True,
                    "path": out_path,
                    "file_name": os.path.basename(out_path),
                }
            )
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    @bp.get("/api/road-shape")
    def get_road_shape_state():
        try:
            if not RoadShapeService.exists():
                return jsonify({"ok": True, "exists": False})
            meta = RoadShapeService.load_meta()
            return jsonify({"ok": True, "exists": True, "meta": meta})
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    @bp.get("/api/road-shape/content")
    def get_road_shape_content():
        try:
            content = RoadShapeService.load_zip_bytes()
            if content is None:
                return jsonify({"ok": False, "error": "저장된 road shape가 없습니다."}), 404
            return Response(
                content,
                mimetype="application/zip",
                headers={"Content-Disposition": "inline; filename=current_road_shape.zip"},
            )
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    @bp.post("/api/road-shape")
    def upload_road_shape():
        try:
            upload = request.files.get("file")
            if upload is None or not upload.filename:
                return jsonify({"ok": False, "error": "업로드할 zip 파일이 없습니다."}), 400

            if not upload.filename.lower().endswith(".zip"):
                return jsonify({"ok": False, "error": "road shape는 .zip 파일만 지원합니다."}), 400

            min_zoom_raw = request.form.get("min_zoom", "16")
            min_zoom = int(min_zoom_raw)
            file_bytes = upload.read()
            if not file_bytes:
                return jsonify({"ok": False, "error": "빈 파일입니다."}), 400

            meta = RoadShapeService.save_zip(file_bytes, upload.filename, min_zoom)
            return jsonify({"ok": True, "meta": meta})
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    @bp.post("/api/road-shape/folder")
    def upload_road_shape_folder():
        try:
            uploads = request.files.getlist("files")
            rel_paths = request.form.getlist("paths")
            folder_name = (request.form.get("folder_name") or "road_shape").strip() or "road_shape"
            min_zoom_raw = request.form.get("min_zoom", "16")
            min_zoom = int(min_zoom_raw)

            if not uploads:
                return jsonify({"ok": False, "error": "업로드할 폴더 파일이 없습니다."}), 400
            if rel_paths and len(rel_paths) != len(uploads):
                return jsonify({"ok": False, "error": "파일 경로 정보가 일치하지 않습니다."}), 400

            files_with_paths = []
            for idx, upload in enumerate(uploads):
                file_bytes = upload.read()
                if not file_bytes:
                    continue
                rel_path = rel_paths[idx] if rel_paths else upload.filename
                files_with_paths.append((file_bytes, rel_path))

            if not files_with_paths:
                return jsonify({"ok": False, "error": "빈 파일만 업로드되었습니다."}), 400

            meta = RoadShapeService.save_folder_as_zip(
                files_with_paths=files_with_paths,
                folder_name=folder_name,
                min_zoom=min_zoom,
            )
            return jsonify({"ok": True, "meta": meta})
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    @bp.delete("/api/road-shape")
    def clear_road_shape():
        try:
            RoadShapeService.clear()
            return jsonify({"ok": True})
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    return bp
