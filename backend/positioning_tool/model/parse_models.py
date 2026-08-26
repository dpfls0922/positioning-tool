from dataclasses import dataclass
from typing import Any


@dataclass
class ParseResult:
    min_timestamp_ms: int
    max_timestamp_ms: int
    max_id: int
    coords: list[dict[str, Any]]
    parking_lot_state_markers: list[dict[str, Any]]
    lines: list[dict[str, Any]]

    @staticmethod
    def from_payload(payload: dict[str, Any]) -> "ParseResult":
        return ParseResult(
            min_timestamp_ms=int(payload.get("min_timestamp_ms", 0)),
            max_timestamp_ms=int(payload.get("max_timestamp_ms", 1)),
            max_id=int(payload.get("max_id", 1)),
            coords=list(payload.get("coords", [])),
            parking_lot_state_markers=list(payload.get("parking_lot_state_markers", [])),
            lines=list(payload.get("lines", [])),
        )

    def to_payload(self) -> dict[str, Any]:
        return {
            "min_timestamp_ms": self.min_timestamp_ms,
            "max_timestamp_ms": self.max_timestamp_ms,
            "max_id": self.max_id,
            "coords": self.coords,
            "parking_lot_state_markers": self.parking_lot_state_markers,
            "lines": self.lines,
        }
