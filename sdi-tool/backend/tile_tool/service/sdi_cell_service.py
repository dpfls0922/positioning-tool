"""VSM 서버에서 받은 SDI 셀 정보를 앱 안에 들고 있는다.

로그 기반 SDI(sdi_source_service)와는 성격이 다르다.
  * 로그   : 좌표까지 정확한 SDI. 단, 그 주행이 지나간 곳만.
  * VSM 셀 : 전국 전체. 단, 위치는 셀(약 11 x 9 km) 단위까지만.
레코드 11바이트가 해독되면 이 쪽도 좌표 단위로 올라간다.
"""

import logging

from backend.tile_tool.service import geo_service as geo
from backend.tile_tool.service import safe_drive_db as sdb
from backend.tile_tool.service.vsm_client import fetch_safe_drive_db


# 후면·신호과속 단속 계열 (eSAFEDRIVE_GGUIDE_TYPE 40, 41, 48~53)
REAR_ENFORCE_TYPES = frozenset({40, 41, 48, 49, 50, 51, 52, 53})


class SdiCellSource:

    _db = None
    _meta = None
    _rear_cache = None

    @classmethod
    def fetch(cls, server="prod", force=False):
        meta = fetch_safe_drive_db(server=server, force=force)
        cls._db = sdb.load(meta["files"]["NDSAFEIDX"], meta["files"]["NDSAFEDAT"])
        cls._meta = meta
        cls._rear_cache = None
        return cls.status()

    @classmethod
    def loaded(cls):
        return cls._db is not None

    @classmethod
    def ensure(cls, server="prod"):
        """아직 안 읽었으면 읽는다. 실패해도 예외를 올리지 않는다.

        SDI 조회 화면 말고 다른 화면까지 같이 죽으면 안 되기 때문이다.
        각 API 가 알아서 '아직 없음' 으로 응답한다.
        """
        if cls._db is not None:
            return cls.status()
        try:
            return cls.fetch(server=server)
        except Exception as ex:
            logging.warning("SAFE_DRIVE_DB 를 불러오지 못했습니다: %s", ex)
            return None

    @classmethod
    def status(cls):
        if cls._db is None:
            return None
        summary = cls._db.summary()
        summary.update({
            "server": cls._meta["server"],
            "package_name": cls._meta["package_name"],
            "package_version": cls._meta["version"],
            "downloaded": cls._meta["downloaded"],
            "cached": cls._meta["cached"],
            "elapsed_ms": cls._meta["elapsed_ms"],
        })
        return summary

    @classmethod
    def cells_in_bounds(cls, south, west, north, east):
        if cls._db is None:
            return []
        return [
            {"key": key, "mesh": sdb.mesh_from_cell_key(key), "count": count, "ring": ring}
            for key, count, ring in cls._db.cells_in_bounds(south, west, north, east)
        ]

    @classmethod
    def points_in_tile(cls, tile_x, tile_y, zoom):
        """타일 하나 안의 SDI. 화면 전체가 아니라 선택한 타일만 본다."""
        if cls._db is None:
            return []
        south, west, north, east = geo.tile_bounds(tile_x, tile_y, zoom)
        points, _ = cls._db.points_in_bounds(south, west, north, east)
        for point in points:
            point["tile"] = {"x": tile_x, "y": tile_y}
        return points

    @classmethod
    def cell_keys(cls):
        return list(cls._db.cells.keys()) if cls._db is not None else []

    @classmethod
    def points_in_cell(cls, key):
        if cls._db is None:
            return []
        points = cls._db.points_in_cell(key)
        for point in points:
            point["cell"] = int(key)
        return points

    @classmethod
    def rear_points(cls):
        """전국의 후면·신호과속 단속 계열 SDI. 어디에 있는지 한눈에 보기 위한 것.

        전 셀을 훑지만 결과가 작아(현재 DB 기준 0~수백 건) 한 번 만들면 캐시한다.
        """
        if cls._db is None:
            return None
        if cls._rear_cache is not None:
            return cls._rear_cache

        points = []
        cells = {}
        for key in cls._db.cells.keys():
            for point in cls._db.points_in_cell(key):
                if point["type"] not in REAR_ENFORCE_TYPES:
                    continue
                point["cell"] = int(key)
                points.append(point)
                cells[key] = cells.get(key, 0) + 1

        cls._rear_cache = {
            "total": len(points),
            "points": points,
            "cells": [
                {
                    "key": key,
                    "mesh": sdb.mesh_from_cell_key(key),
                    "count": count,
                    "center": sdb.cell_center(key),
                }
                for key, count in sorted(cells.items(), key=lambda kv: -kv[1])
            ],
        }
        return cls._rear_cache

    @classmethod
    def cell_at(cls, lat, lon):
        """좌표가 속한 셀. DB 를 아직 안 받았으면 격자 정보만 돌려준다."""
        key = sdb.cell_key(lon, lat)
        info = {
            "key": key,
            "mesh": sdb.mesh_from_cell_key(key),
            "ring": sdb.cell_ring(key),
            "count": None,
            "in_db": None,
        }
        if cls._db is not None:
            cell = cls._db.cell(key)
            info["count"] = cell["count"] if cell else 0
            info["in_db"] = cell is not None
        return info
