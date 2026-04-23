import argparse

from backend.positioning_tool.app import create_app
from backend.positioning_tool.service.paths import PATHS
from backend.positioning_tool.service.log_service import LogService


def main() -> None:
    parser = argparse.ArgumentParser(description="DLT positioning tool")
    parser.add_argument("--serve", action="store_true", help="웹 서버 모드로 실행합니다.")
    parser.add_argument("--host", default="127.0.0.1", help="서버 바인딩 호스트")
    parser.add_argument("--port", default=5001, type=int, help="서버 포트")
    parser.add_argument("--log", default=PATHS.log_file_path, help="배치 모드에서 사용할 로그 파일 경로")
    args = parser.parse_args()

    if args.serve:
        app = create_app()
        app.run(host=args.host, port=args.port, debug=False)
        return

    LogService.generate_outputs_from_log(args.log)


if __name__ == "__main__":
    main()
