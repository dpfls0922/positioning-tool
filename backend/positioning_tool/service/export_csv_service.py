import csv
import os

from backend.positioning_tool.service.paths import PATHS
from backend.positioning_tool.service.export_html_service import detect_issue_id, _safe_part


def write_simple_export_csv(
    markers_data: list[dict],
    result_name: str,
    issue_id: str | None = None,
    out_dir: str | None = None,
) -> str:
    out_dir = out_dir or PATHS.project_root
    os.makedirs(out_dir, exist_ok=True)

    final_issue = issue_id or detect_issue_id(result_name) or "NOISSUE"
    safe_issue = _safe_part(final_issue)
    filename = f"result_{safe_issue}.csv"
    out_path = os.path.join(out_dir, filename)

    header = ["type", "index", "dlt_id", "latitude", "longitude", "heading", "is_dr", "timestamp"]

    with open(out_path, "w", newline="", encoding="utf-8") as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(header)

        for coord in markers_data or []:
            extra = coord.get("extra") or {}
            writer.writerow(
                [
                    coord.get("type", ""),
                    coord.get("id", ""),
                    coord.get("dlt_id", ""),
                    coord.get("latitude", ""),
                    coord.get("longitude", ""),
                    coord.get("heading", "") if coord.get("heading") is not None else "",
                    extra.get("isDRGps", ""),
                    coord.get("timestamp_str", ""),
                ]
            )

    return out_path
