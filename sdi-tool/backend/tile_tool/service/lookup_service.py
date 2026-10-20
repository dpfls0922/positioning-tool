"""서버 없이 한 번에 조회하는 경로.

웹 UI 는 /api/resolve + /api/vsm/points 를 이어 붙이지만, CLI 나 HTML 내보내기는
결과가 한 덩어리로 필요하다. 그 조립을 여기서 한 번만 한다.
"""

from backend.tile_tool.service import geo_service as geo
from backend.tile_tool.service import safe_drive_db as sdb
from backend.tile_tool.service.query_service import resolve
from backend.tile_tool.service.vsm_client import fetch_safe_drive_db


_DB_CACHE = {}


def load_db(server="dev", force=False):
    """SAFE_DRIVE_DB 를 읽어 둔다(캐시가 있으면 내려받지 않는다)."""
    if force or server not in _DB_CACHE:
        meta = fetch_safe_drive_db(server=server, force=force)
        _DB_CACHE[server] = (sdb.load(meta["files"]["NDSAFEIDX"], meta["files"]["NDSAFEDAT"]), meta)
    return _DB_CACHE[server]


def lookup(query, server="dev"):
    """검색어 하나로 타일 / 메시 / 셀 / SDI 를 전부 모아 돌려준다."""
    target = resolve(query)
    db, meta = load_db(server)

    tile = target["tile"]
    south, west, north, east = geo.tile_bounds(tile["x"], tile["y"], target["zoom"])
    cell_key = sdb.cell_key(tile["center"]["lon"], tile["center"]["lat"])
    cell = db.cell(cell_key)

    points, truncated = db.points_in_bounds(south, west, north, east)
    points.sort(key=lambda point: (not point["exact"], point["type"]))

    return {
        "query": query,
        "target": target,
        "cell": {
            "key": cell_key,
            "mesh": sdb.mesh_from_cell_key(cell_key),
            "total": cell["count"] if cell else 0,
            "ring": sdb.cell_ring(cell_key),
        },
        "points": points,
        "truncated": truncated,
        "source": {
            "version": db.version,
            "package_version": meta["version"],
            "server": meta["server"],
            "record_total": db.record_total,
        },
    }


def format_text(result):
    """터미널용 요약."""
    target = result["target"]
    tile = target["tile"]
    bounds = tile["bounds"]
    cell = result["cell"]
    points = result["points"]
    exact = sum(1 for point in points if point["exact"])

    matched = {"latlon": "위경도", "tile": "타일 인덱스", "mesh": "메시 코드"}
    lines = [
        f"검색      {matched.get(target['matched'], target['matched'])}  {result['query']}",
        f"타일      {tile['x']}, {tile['y']}   z{target['zoom']}  id {tile['id']}",
        f"  범위    {bounds['south']:.5f} ~ {bounds['north']:.5f}"
        f"  /  {bounds['west']:.5f} ~ {bounds['east']:.5f}",
        f"메시      {cell['mesh']}",
        f"SDI 셀    {cell['key']}   (셀 전체 {cell['total']:,}건)",
        "",
        f"이 타일의 SDI {len(points)}건  (설치점 {exact}건)",
    ]

    if not points:
        lines.append("  없음")
    for point in points:
        speed = f"{point['speed_limit']:>3} km/h" if point["speed_limit"] else "   -    "
        lines.append(
            f"  {'설치점' if point['exact'] else '안내점'}  {point['type_name']:<18}"
            f"  {speed}  {point['lat']:.6f}, {point['lon']:.6f}  {point['angle']:>3}°"
        )

    source = result["source"]
    lines += [
        "",
        f"출처      SAFE_DRIVE_DB {source['version']} (v{source['package_version']},"
        f" {source['server']})  전국 {source['record_total']:,}건",
    ]
    return "\n".join(lines)
