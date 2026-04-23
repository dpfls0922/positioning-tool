import os

from backend.positioning_tool.service.paths import PATHS
from backend.positioning_tool.model.parse_models import ParseResult
from backend.positioning_tool.service import log_parser_service as log_parser
from backend.positioning_tool.service.export_html_service import write_simple_export_html
from backend.positioning_tool.service.html_renderer_service import write_html_file


class LogService:
    _last_result: ParseResult | None = None
    _last_result_name: str = "result"

    @staticmethod
    def ensure_static_dirs() -> None:
        os.makedirs(os.path.join(PATHS.frontend_dir, "static", "css"), exist_ok=True)
        os.makedirs(os.path.join(PATHS.frontend_dir, "static", "js"), exist_ok=True)

    @classmethod
    def parse_file(cls, log_file_path: str, result_name: str | None = None) -> ParseResult | None:
        cls.ensure_static_dirs()
        log_parser.reset_runtime_state()

        if not log_parser.parse_log(log_file_path):
            return None

        payload = log_parser.build_runtime_payload()
        result = ParseResult.from_payload(payload)
        cls._last_result = result
        cls._last_result_name = result_name or "result"
        return result

    @classmethod
    def generate_outputs_from_log(cls, log_file_path: str | None = None) -> bool:
        cls.ensure_static_dirs()
        log_parser.reset_runtime_state()

        if not log_parser.parse_log(log_file_path):
            return False

        payload = log_parser.build_runtime_payload()
        log_parser.write_data_to_csv(PATHS.output_csv)
        log_parser.write_data_to_json(PATHS.output_json)
        write_html_file(payload["coords"], payload["lines"], PATHS.output_html)
        return True

    @classmethod
    def export_last_result_html(cls, issue_id: str | None = None) -> str | None:
        if cls._last_result is None:
            return None
        payload = cls._last_result.to_payload()
        return write_simple_export_html(
            markers_data=payload.get("coords", []),
            lines_data=payload.get("lines", []),
            result_name=cls._last_result_name,
            issue_id=issue_id,
            out_dir=PATHS.project_root,
        )
