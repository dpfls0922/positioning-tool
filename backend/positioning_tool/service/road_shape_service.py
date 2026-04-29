import json
import os
import posixpath
import zipfile
from datetime import datetime
from typing import Any

from backend.positioning_tool.service.paths import PATHS


ROAD_SHAPE_DIR = os.path.join(PATHS.project_root, "data", "road_shape")
ROAD_SHAPE_KINDS = ("link", "node")
REQUIRED_SHAPE_EXTS = {"shp", "shx", "dbf"}


class RoadShapeService:
    @staticmethod
    def _normalize_kind(kind: str) -> str:
        value = (kind or "").strip().lower()
        if value not in ROAD_SHAPE_KINDS:
            raise ValueError("kind는 link 또는 node 여야 합니다.")
        return value

    @staticmethod
    def _kind_dir(kind: str) -> str:
        normalized = RoadShapeService._normalize_kind(kind)
        return os.path.join(ROAD_SHAPE_DIR, normalized)

    @staticmethod
    def _kind_zip_path(kind: str) -> str:
        normalized = RoadShapeService._normalize_kind(kind)
        return os.path.join(RoadShapeService._kind_dir(normalized), f"current_road_shape_{normalized}.zip")

    @staticmethod
    def _kind_meta_path(kind: str) -> str:
        return os.path.join(RoadShapeService._kind_dir(kind), "meta.json")

    @staticmethod
    def ensure_dir(kind: str | None = None) -> None:
        if kind is None:
            os.makedirs(ROAD_SHAPE_DIR, exist_ok=True)
            for each_kind in ROAD_SHAPE_KINDS:
                os.makedirs(RoadShapeService._kind_dir(each_kind), exist_ok=True)
            return
        os.makedirs(RoadShapeService._kind_dir(kind), exist_ok=True)

    @staticmethod
    def _sanitize_rel_path(path: str) -> str:
        normalized = posixpath.normpath(path.replace("\\", "/")).lstrip("/")
        if normalized in ("", ".") or normalized.startswith("../") or "/../" in normalized:
            return ""
        return normalized

    @staticmethod
    def _validate_shp_folder_entries(file_paths: list[str]) -> None:
        if not file_paths:
            raise ValueError("업로드된 파일이 없습니다.")

        folder_roots: set[str] = set()
        for path in file_paths:
            normalized = path.replace("\\", "/")
            if "/" not in normalized:
                raise ValueError("폴더 선택 업로드만 지원합니다. (.shp/.shx/.dbf 포함 폴더)")
            folder_roots.add(normalized.split("/", 1)[0])
        if len(folder_roots) != 1:
            raise ValueError("한 번에 하나의 폴더만 업로드할 수 있습니다.")

        group_exts: dict[str, set[str]] = {}
        found_extensions: set[str] = set()

        for path in file_paths:
            lowered = path.lower()
            dot_idx = lowered.rfind(".")
            if dot_idx <= 0:
                continue
            ext = lowered[dot_idx + 1 :]
            if ext not in {"shp", "shx", "dbf", "prj", "cpg"}:
                continue

            base = lowered[:dot_idx]
            group_exts.setdefault(base, set()).add(ext)
            found_extensions.add(ext)

        if not REQUIRED_SHAPE_EXTS.issubset(found_extensions):
            raise ValueError("선택한 폴더에 .shp/.shx/.dbf 파일이 함께 있어야 합니다.")

        shp_bases = [base for base, exts in group_exts.items() if "shp" in exts]
        if not shp_bases:
            raise ValueError("선택한 폴더에서 .shp 파일을 찾지 못했습니다.")

        incomplete = []
        for base in shp_bases:
            exts = group_exts.get(base, set())
            if not REQUIRED_SHAPE_EXTS.issubset(exts):
                missing = sorted(REQUIRED_SHAPE_EXTS - exts)
                incomplete.append((base, missing))

        if incomplete:
            first_base, missing_exts = incomplete[0]
            base_name = first_base.split("/")[-1]
            missing_label = ", ".join(f".{ext}" for ext in missing_exts)
            raise ValueError(f"SHP 세트 불완전: {base_name}에 {missing_label} 파일이 없습니다.")

    @staticmethod
    def save_folder_as_zip(
        files_with_paths: list[tuple[bytes, str]],
        folder_name: str,
        min_zoom: int,
        kind: str,
    ) -> dict[str, Any]:
        normalized_kind = RoadShapeService._normalize_kind(kind)
        RoadShapeService.ensure_dir(normalized_kind)
        if not files_with_paths:
            raise ValueError("업로드된 파일이 없습니다.")

        incoming_entries: dict[str, bytes] = {}
        for file_bytes, rel_path in files_with_paths:
            safe_path = RoadShapeService._sanitize_rel_path(rel_path)
            if not safe_path:
                continue
            incoming_entries[safe_path] = file_bytes

        if not incoming_entries:
            raise ValueError("유효한 파일 경로가 없습니다.")

        all_paths = list(incoming_entries.keys())
        RoadShapeService._validate_shp_folder_entries(all_paths)

        zip_path = RoadShapeService._kind_zip_path(normalized_kind)
        meta_path = RoadShapeService._kind_meta_path(normalized_kind)
        temp_zip_path = f"{zip_path}.tmp"
        total_entries = len(incoming_entries)

        try:
            with zipfile.ZipFile(temp_zip_path, "w", compression=zipfile.ZIP_DEFLATED) as out_zip:
                for path, content in incoming_entries.items():
                    out_zip.writestr(path, content)

            os.replace(temp_zip_path, zip_path)
        finally:
            if os.path.exists(temp_zip_path):
                os.remove(temp_zip_path)

        size_bytes = os.path.getsize(zip_path) if os.path.exists(zip_path) else 0
        meta = {
            "kind": normalized_kind,
            "file_name": os.path.basename(zip_path),
            "folder_name": folder_name,
            "min_zoom": max(0, min(22, int(min_zoom))),
            "updated_at": datetime.now().isoformat(timespec="seconds"),
            "size_bytes": size_bytes,
            "entry_count": total_entries,
        }
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        return meta

    @staticmethod
    def exists(kind: str) -> bool:
        normalized_kind = RoadShapeService._normalize_kind(kind)
        return os.path.exists(RoadShapeService._kind_zip_path(normalized_kind)) and os.path.exists(
            RoadShapeService._kind_meta_path(normalized_kind)
        )

    @staticmethod
    def any_exists() -> bool:
        return any(RoadShapeService.exists(each_kind) for each_kind in ROAD_SHAPE_KINDS)

    @staticmethod
    def load_meta(kind: str) -> dict[str, Any]:
        normalized_kind = RoadShapeService._normalize_kind(kind)
        meta_path = RoadShapeService._kind_meta_path(normalized_kind)
        if not os.path.exists(meta_path):
            return {}
        with open(meta_path, "r", encoding="utf-8") as f:
            return json.load(f)

    @staticmethod
    def load_all_meta() -> dict[str, dict[str, Any] | None]:
        metas: dict[str, dict[str, Any] | None] = {}
        for each_kind in ROAD_SHAPE_KINDS:
            metas[each_kind] = RoadShapeService.load_meta(each_kind) if RoadShapeService.exists(each_kind) else None
        return metas

    @staticmethod
    def load_zip_bytes(kind: str) -> bytes | None:
        normalized_kind = RoadShapeService._normalize_kind(kind)
        zip_path = RoadShapeService._kind_zip_path(normalized_kind)
        if not os.path.exists(zip_path):
            return None
        with open(zip_path, "rb") as f:
            return f.read()

    @staticmethod
    def clear(kind: str | None = None) -> None:
        if kind is None:
            for each_kind in ROAD_SHAPE_KINDS:
                RoadShapeService.clear(each_kind)
            return

        normalized_kind = RoadShapeService._normalize_kind(kind)
        zip_path = RoadShapeService._kind_zip_path(normalized_kind)
        meta_path = RoadShapeService._kind_meta_path(normalized_kind)
        if os.path.exists(zip_path):
            os.remove(zip_path)
        if os.path.exists(meta_path):
            os.remove(meta_path)
