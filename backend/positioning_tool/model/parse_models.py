from dataclasses import dataclass
from typing import Any


@dataclass
class ParseResult:
    min_timestamp_ms: int
    max_timestamp_ms: int
    max_id: int
    coords: list[dict[str, Any]]
    parking_lot_state_bands: list[dict[str, Any]]
    gnss_mode_bands: list[dict[str, Any]]
    sdi_block_timeline: list[dict[str, Any]]
    shade_timeline: list[dict[str, Any]]
    lines: list[dict[str, Any]]

    @staticmethod
    def from_payload(payload: dict[str, Any]) -> "ParseResult":
        return ParseResult(
            min_timestamp_ms=int(payload.get("min_timestamp_ms", 0)),
            max_timestamp_ms=int(payload.get("max_timestamp_ms", 1)),
            max_id=int(payload.get("max_id", 1)),
            coords=list(payload.get("coords", [])),
            parking_lot_state_bands=list(payload.get("parking_lot_state_bands", [])),
            gnss_mode_bands=list(payload.get("gnss_mode_bands", [])),
            sdi_block_timeline=list(payload.get("sdi_block_timeline", [])),
            shade_timeline=list(payload.get("shade_timeline", [])),
            lines=list(payload.get("lines", [])),
        )

    def to_payload(self) -> dict[str, Any]:
        return {
            "min_timestamp_ms": self.min_timestamp_ms,
            "max_timestamp_ms": self.max_timestamp_ms,
            "max_id": self.max_id,
            "coords": self.coords,
            "parking_lot_state_bands": self.parking_lot_state_bands,
            "gnss_mode_bands": self.gnss_mode_bands,
            "sdi_block_timeline": self.sdi_block_timeline,
            "shade_timeline": self.shade_timeline,
            "lines": self.lines,
        }
