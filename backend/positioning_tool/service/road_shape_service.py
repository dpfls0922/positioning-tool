import json
import os
import posixpath
import zipfile
from datetime import datetime
from typing import Any

from backend.positioning_tool.service.paths import PATHS


ROAD_SHAPE_DIR = os.path.join(PATHS.project_root, "data", "road_shape")
ROAD_SHAPE_ZIP_PATH = os.path.join(ROAD_SHAPE_DIR, "current_road_shape.zip")
ROAD_SHAPE_META_PATH = os.path.join(ROAD_SHAPE_DIR, "meta.json")


class RoadShapeService:
    @staticmethod
    def ensure_dir() -> None:
        os.makedirs(ROAD_SHAPE_DIR, exist_ok=True)

    @staticmethod
    def save_zip(file_bytes: bytes, file_name: str, min_zoom: int) -> dict[str, Any]:
        RoadShapeService.ensure_dir()
        with open(ROAD_SHAPE_ZIP_PATH, "wb") as f:
            f.write(file_bytes)

        meta = {
            "file_name": file_name,
            "min_zoom": max(0, min(22, int(min_zoom))),
            "updated_at": datetime.now().isoformat(timespec="seconds"),
            "size_bytes": len(file_bytes),
        }
        with open(ROAD_SHAPE_META_PATH, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        return meta

    @staticmethod
    def _sanitize_rel_path(path: str) -> str:
        normalized = posixpath.normpath(path.replace("\\", "/")).lstrip("/")
        if normalized in ("", ".") or normalized.startswith("../") or "/../" in normalized:
            return ""
        return normalized

    @staticmethod
    def save_folder_as_zip(
        files_with_paths: list[tuple[bytes, str]],
        folder_name: str,
        min_zoom: int,
    ) -> dict[str, Any]:
        RoadShapeService.ensure_dir()
        if not files_with_paths:
            raise ValueError("업로드된 파일이 없습니다.")

        with zipfile.ZipFile(ROAD_SHAPE_ZIP_PATH, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for file_bytes, rel_path in files_with_paths:
                safe_path = RoadShapeService._sanitize_rel_path(rel_path)
                if not safe_path:
                    continue
                zf.writestr(safe_path, file_bytes)

        size_bytes = os.path.getsize(ROAD_SHAPE_ZIP_PATH) if os.path.exists(ROAD_SHAPE_ZIP_PATH) else 0
        meta = {
            "file_name": f"{folder_name}.zip",
            "folder_name": folder_name,
            "min_zoom": max(0, min(22, int(min_zoom))),
            "updated_at": datetime.now().isoformat(timespec="seconds"),
            "size_bytes": size_bytes,
        }
        with open(ROAD_SHAPE_META_PATH, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        return meta

    @staticmethod
    def exists() -> bool:
        return os.path.exists(ROAD_SHAPE_ZIP_PATH) and os.path.exists(ROAD_SHAPE_META_PATH)

    @staticmethod
    def load_meta() -> dict[str, Any]:
        if not os.path.exists(ROAD_SHAPE_META_PATH):
            return {}
        with open(ROAD_SHAPE_META_PATH, "r", encoding="utf-8") as f:
            return json.load(f)

    @staticmethod
    def load_zip_bytes() -> bytes | None:
        if not os.path.exists(ROAD_SHAPE_ZIP_PATH):
            return None
        with open(ROAD_SHAPE_ZIP_PATH, "rb") as f:
            return f.read()

    @staticmethod
    def clear() -> None:
        if os.path.exists(ROAD_SHAPE_ZIP_PATH):
            os.remove(ROAD_SHAPE_ZIP_PATH)
        if os.path.exists(ROAD_SHAPE_META_PATH):
            os.remove(ROAD_SHAPE_META_PATH)
