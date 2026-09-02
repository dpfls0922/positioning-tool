import argparse
import os
import sys

from backend.tile_tool.service.lookup_service import format_text, load_db, lookup
from backend.tile_tool.service.paths import PROJECT_ROOT, STATIC_DIR
from backend.tile_tool.service.query_service import QueryError
from backend.tile_tool.service.static_export_service import write_html
from backend.tile_tool.service.vsm_client import SERVERS, VsmError


def main() -> None:
    parser = argparse.ArgumentParser(
        description="타일 / 메시 SDI 조회",
        epilog="예) %(prog)s 37.5665,126.978        위경도가 속한 타일의 SDI\n"
               "    %(prog)s t:27941,12689         타일 인덱스로\n"
               "    %(prog)s m:4787 --html out.html  단독 HTML 로 저장\n"
               "    %(prog)s --serve               웹 UI 로 띄우기\n"
               "    %(prog)s --pack sdi-tool.zip   다른 PC 로 옮길 zip 만들기",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("query", nargs="?",
                        help="위경도 / t:타일 / m:메시 (--serve 없이 쓰면 결과를 출력합니다)")
    parser.add_argument("--html", metavar="경로",
                        help="결과를 파일 하나짜리 HTML 로 저장합니다(서버 없이 열립니다)")
    parser.add_argument("--server", default="dev", choices=sorted(SERVERS),
                        help="SAFE_DRIVE_DB 를 받아올 VSM 서버 (기본: dev)")
    parser.add_argument("--refresh", action="store_true", help="캐시를 무시하고 다시 받습니다")
    parser.add_argument("--pack", metavar="경로",
                        help="다른 PC 로 옮길 수 있게 zip 하나로 묶습니다")
    parser.add_argument("--no-cache", action="store_true",
                        help="--pack 시 받아 둔 SAFE_DRIVE_DB 를 빼고 묶습니다")
    parser.add_argument("--serve", action="store_true",
                        help="웹 서버 모드 (검색어를 생략해도 같습니다)")
    parser.add_argument("--host", default="127.0.0.1", help="서버 바인딩 호스트")
    parser.add_argument("--port", default=5002, type=int, help="서버 포트")
    args = parser.parse_args()

    if args.pack:
        from backend.tile_tool.service.pack_service import build
        out_path, counts = build(args.pack, include_cache=not args.no_cache)
        detail = ", ".join(f"{name} {n}개" for name, n in counts.items())
        print(f"{out_path}  ({os.path.getsize(out_path) / 1024 / 1024:.1f} MB)")
        print(f"  담긴 것: {detail}")
        print("  받는 쪽에서: 압축 해제 후 "
              "pip3 install -r requirements.txt && python3 run.py")
        return

    # 검색어가 없으면 웹 UI 로 띄운다(`python3 run.py` 만 쳤을 때의 기대 동작).
    if args.serve or not args.query:
        from backend.tile_tool.app import create_app
        print(f"http://{args.host}:{args.port}  (조회만 하려면 검색어를 인자로 주세요)")
        create_app().run(host=args.host, port=args.port, debug=False)
        return

    try:
        if args.refresh:
            load_db(args.server, force=True)
        result = lookup(args.query, server=args.server)
    except QueryError as ex:
        print(f"입력 오류: {ex}", file=sys.stderr)
        raise SystemExit(2)
    except VsmError as ex:
        print(f"SAFE_DRIVE_DB 를 불러오지 못했습니다: {ex}", file=sys.stderr)
        raise SystemExit(1)

    print(format_text(result))

    if args.html:
        out_path = os.path.abspath(os.path.expanduser(args.html))
        write_html(result, out_path, os.path.join(STATIC_DIR, "img", "sdi"))
        print(f"\nHTML      {os.path.relpath(out_path, PROJECT_ROOT)}"
              f"  ({os.path.getsize(out_path) / 1024:.0f} KB, 브라우저로 바로 열면 됩니다)")


if __name__ == "__main__":
    main()
