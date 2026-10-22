"""프로젝트 루트의 .env 파일을 환경변수로 읽어들인다.

API 키를 매번 export 하지 않도록 하는 용도다. 외부 패키지(python-dotenv)를
쓰지 않고, 이미 설정된 환경변수는 덮어쓰지 않는다(셸 export 가 항상 우선).

형식:
    KAKAO_REST_API_KEY=값
    KAKAO_JS_KEY=값        # 주석과 빈 줄, 따옴표, 앞의 export 접두어 허용
"""

import os

from backend.positioning_tool.service.paths import PATHS

ENV_FILE_NAME = ".env"


def env_file_path() -> str:
    return os.path.join(PATHS.project_root, ENV_FILE_NAME)


def _parse_line(line: str):
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export "):
        stripped = stripped[len("export "):].strip()
    if "=" not in stripped:
        return None

    key, raw_value = stripped.split("=", 1)
    key = key.strip()
    value = raw_value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]
    if not key:
        return None
    return key, value


def load_env_file(path: str = None) -> list:
    """.env 를 읽어 아직 설정되지 않은 환경변수만 채우고, 채운 키 목록을 돌려준다."""
    target = path or env_file_path()
    if not os.path.exists(target):
        return []

    applied = []
    with open(target, "r", encoding="utf-8") as file:
        for line in file:
            parsed = _parse_line(line)
            if parsed is None:
                continue
            key, value = parsed
            if os.environ.get(key):
                # 셸에서 직접 export 한 값이 있으면 그것을 우선한다.
                continue
            os.environ[key] = value
            applied.append(key)
    return applied
