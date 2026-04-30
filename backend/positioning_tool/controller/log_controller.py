import os
import tempfile
import time
import json
import base64
from urllib import error as urllib_error
from urllib import request as urllib_request

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


def _read_shape_kind_from_request(req, source: str = "args") -> str:
    if source == "form":
        raw_kind = req.form.get("kind", "")
    else:
        raw_kind = req.args.get("kind", "")
    kind = (raw_kind or "").strip().lower()
    if kind not in {"link", "node"}:
        raise ValueError("kind 파라미터는 link 또는 node 여야 합니다.")
    return kind


def _build_ntmapstg_route_request(payload):
    endpoint = (payload.get("endpoint") or "").strip() or "https://ntmapstg.tmap.co.kr:9443/tmap-channel/rsd/ev/route"
    access_key = (payload.get("accessKey") or "").strip()
    headers = payload.get("headers") or {}
    body = payload.get("body")

    if not isinstance(headers, dict):
        raise ValueError("headers 형식이 올바르지 않습니다.")
    if not isinstance(body, dict):
        raise ValueError("body 형식이 올바르지 않습니다.")

    normalized_headers = {}
    for key, value in headers.items():
        if key is None or value is None:
            continue
        key_str = str(key).strip()
        val_str = str(value).strip()
        if key_str and val_str:
            normalized_headers[key_str] = val_str

    if access_key:
        normalized_headers.setdefault("accessKey", access_key)
        normalized_headers.setdefault("appKey", access_key)

    normalized_headers.setdefault("Accept", "application/octet-stream")
    normalized_headers.setdefault("Content-Type", "application/json; charset=UTF-8")

    return {
        "endpoint": endpoint,
        "headers": normalized_headers,
        "body": body,
    }


def _call_ntmapstg_route_api(route_request):
    req = urllib_request.Request(
        route_request["endpoint"],
        data=json.dumps(route_request["body"]).encode("utf-8"),
        headers=route_request["headers"],
        method="POST",
    )
    with urllib_request.urlopen(req, timeout=25) as resp:
        raw_bytes = resp.read()
        content_type = resp.headers.get("Content-Type", "application/octet-stream")
        return {
            "status": resp.status,
            "content_type": content_type,
            "body_base64": base64.b64encode(raw_bytes).decode("ascii"),
        }


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

    @bp.post("/api/tmap-route")
    def request_tmap_route_api():
        try:
            payload = request.get_json(silent=True) or {}
            route_request = _build_ntmapstg_route_request(payload)
            response_json = _call_ntmapstg_route_api(route_request)
            return jsonify({
                "ok": True,
                "endpoint": route_request["endpoint"],
                "request_headers": route_request["headers"],
                "request_body": route_request["body"],
                "response": response_json,
            })
        except ValueError as ex:
            return jsonify({"ok": False, "error": str(ex)}), 400
        except urllib_error.HTTPError as ex:
            detail_bytes = ex.read()
            detail = detail_bytes.decode("utf-8", errors="replace")
            try:
                detail_json = json.loads(detail)
            except Exception:
                detail_json = None
            return jsonify({
                "ok": False,
                "error": f"ntmapstg API HTTP {ex.code}",
                "detail": detail_json or detail,
                "detail_base64": base64.b64encode(detail_bytes).decode("ascii"),
            }), ex.code
        except urllib_error.URLError as ex:
            return jsonify({"ok": False, "error": f"ntmapstg API 연결 실패: {ex.reason}"}), 502
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    @bp.get("/api/road-shape")
    def get_road_shape_state():
        try:
            metas = RoadShapeService.load_all_meta()
            if not RoadShapeService.any_exists():
                return jsonify({"ok": True, "exists": False})
            return jsonify({"ok": True, "exists": True, "metas": metas})
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    @bp.get("/api/road-shape/content")
    def get_road_shape_content():
        try:
            kind = _read_shape_kind_from_request(request, source="args")
            content = RoadShapeService.load_zip_bytes(kind)
            if content is None:
                return jsonify({"ok": False, "error": f"저장된 {kind} road shape가 없습니다."}), 404
            return Response(
                content,
                mimetype="application/zip",
                headers={"Content-Disposition": f"inline; filename=current_road_shape_{kind}.zip"},
            )
        except ValueError as ex:
            return jsonify({"ok": False, "error": str(ex)}), 400
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    @bp.post("/api/road-shape")
    def upload_road_shape():
        return jsonify({"ok": False, "error": "Road Shape는 폴더 업로드(/api/road-shape/folder)만 지원합니다."}), 400

    @bp.post("/api/road-shape/folder")
    def upload_road_shape_folder():
        try:
            kind = _read_shape_kind_from_request(request, source="form")
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
                kind=kind,
            )
            return jsonify({"ok": True, "meta": meta, "kind": kind})
        except ValueError as ex:
            return jsonify({"ok": False, "error": str(ex)}), 400
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    @bp.delete("/api/road-shape")
    def clear_road_shape():
        try:
            raw_kind = (request.args.get("kind") or "").strip()
            if raw_kind:
                kind = _read_shape_kind_from_request(request, source="args")
                RoadShapeService.clear(kind)
            else:
                RoadShapeService.clear()
            return jsonify({"ok": True})
        except ValueError as ex:
            return jsonify({"ok": False, "error": str(ex)}), 400
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    return bp
