"""로그 파일에서 레코드(줄/DLT 페이로드)를 꺼내는 계층.

텍스트 로그와 DLT 바이너리의 차이를 여기서 흡수해, 상위 파서는
(dlt_id, line, reception_timestamp) 튜플만 다루면 된다.
"""

import re
from datetime import datetime

from backend.positioning_tool.service.log_parsing.patterns import DLT_RELEVANT_BYTE_KEYWORDS


def iterate_log_records(source_path):
    """
    Yield normalized records as:
      (dlt_id, message_text, reception_timestamp_or_none)
    For .dlt, parse storage header timestamp directly from binary records.
    For text files (or fallback), emit line-based records.
    """
    parsed_binary = False
    if source_path.lower().endswith(".dlt"):
        for dlt_id, message_text, reception_ts in iterate_dlt_storage_records(source_path):
            parsed_binary = True
            yield dlt_id, message_text, reception_ts
        if parsed_binary:
            return

    with open(source_path, "r", encoding="utf-8", errors="replace") as file:
        for line_number, line in enumerate(file, start=1):
            yield line_number, line, None


def iterate_dlt_storage_records(source_path):
    marker = b"DLT\x01"
    with open(source_path, "rb") as file:
        data = file.read()

    if not data:
        return

    data_len = len(data)
    record_id = 0
    starts = [m.start() for m in re.finditer(re.escape(marker), data)]
    if not starts:
        return

    for idx, start in enumerate(starts):
        end = starts[idx + 1] if idx + 1 < len(starts) else data_len
        if end - start < 16:
            continue

        # Storage header: "DLT\x01" + seconds(4 LE) + microseconds(4 LE) + ecu(4)
        seconds = int.from_bytes(data[start + 4:start + 8], byteorder="little", signed=False)
        microseconds = int.from_bytes(data[start + 8:start + 12], byteorder="little", signed=False)
        try:
            reception_timestamp = datetime.fromtimestamp(seconds + (microseconds / 1_000_000.0))
        except (OSError, OverflowError, ValueError):
            reception_timestamp = None

        record_id += 1
        if not is_relevant_dlt_record_slice(data, start, end):
            continue

        record = data[start:end]
        message_text = record.decode("utf-8", errors="replace")
        yield record_id, message_text, reception_timestamp


def is_relevant_dlt_record_slice(data_bytes, start, end):
    for keyword in DLT_RELEVANT_BYTE_KEYWORDS:
        if data_bytes.find(keyword, start, end) != -1:
            return True

    # VPM payload line format: "[MM] <lat>, <lon>, ..."
    # Exclude verbose MM diagnostic lines like "[[MM] : 4] ..."
    mm_pos = data_bytes.find(b"[MM] ", start, end)
    if mm_pos < 0:
        return False

    value_pos = mm_pos + len(b"[MM] ")
    if value_pos >= end:
        return False

    first_char = data_bytes[value_pos:value_pos + 1]
    return first_char in b"-0123456789"


def is_relevant_dlt_record(record_bytes):
    # Backward-compatible helper for ad-hoc callers.
    if any(keyword in record_bytes for keyword in DLT_RELEVANT_BYTE_KEYWORDS):
        return True

    # VPM payload line format: "[MM] <lat>, <lon>, ..."
    # Exclude verbose MM diagnostic lines like "[[MM] : 4] ..."
    mm_pos = record_bytes.find(b"[MM] ")
    if mm_pos < 0:
        return False

    value_pos = mm_pos + len(b"[MM] ")
    if value_pos >= len(record_bytes):
        return False

    first_char = record_bytes[value_pos:value_pos + 1]
    return first_char in b"-0123456789"
