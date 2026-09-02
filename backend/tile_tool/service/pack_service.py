"""이 툴을 다른 PC 로 옮길 수 있게 zip 하나로 묶는다.

positioning-tool 저장소 전체가 아니라 이 툴이 실제로 쓰는 것만 담는다.
  * backend/tile_tool          코드
  * frontend/static/tile       화면 조각
  * frontend/static/img/sdi    SDI 아이콘
  * data/vsm_cache             받아 둔 SAFE_DRIVE_DB (있으면)
받는 쪽은 압축을 풀고 `python3 run.py` 만 하면 된다.

주행 로그 대조 기능만 positioning-tool 의 DLT 파서를 쓰는데, 그건 여기 담지
않는다(파서가 저장소 전체에 얽혀 있다). 없으면 그 기능만 빠지고 나머지는 돈다.
"""

import os
import subprocess
import zipfile
from datetime import datetime

from backend.tile_tool.service.paths import (
    PROJECT_ROOT,
    STATIC_DIR,
    TILE_ASSET_DIR,
    VSM_CACHE_DIR,
)


ROOT_NAME = "sdi-tool"

RUN_PY = '''#!/usr/bin/env python3
"""SDI 타일 조회 툴.

    python3 run.py                     웹 UI (http://127.0.0.1:5002)
    python3 run.py 37.5665,126.978     터미널에서 바로 조회
    python3 run.py m:4787 --html a.html  단독 HTML 로 저장
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.tile_tool.cli import main

if __name__ == "__main__":
    main()
'''

REQUIREMENTS = "flask>=3.0\n"

README = """# SDI 타일 조회 툴

Tmap 레이어 위에서 좌표 / 타일 인덱스 / 메시 코드로 타일을 찾고, 그 타일 안의
SDI(안전운전 정보)를 표시합니다. 데이터는 VSM 리소스 서버의
`SAFE_DRIVE_DB`(전국 88,422건) 원본입니다.

## 실행

```
pip3 install -r requirements.txt
python3 run.py
```

브라우저에서 http://127.0.0.1:5002 를 엽니다.

서버를 띄우기 싫으면 터미널에서 바로 볼 수도 있습니다.

```
python3 run.py 37.5665,126.978          # 위경도가 속한 타일
python3 run.py t:27941,12689            # 타일 인덱스
python3 run.py m:4787                   # 메시 코드
python3 run.py 37.5665,126.978 --html out.html   # 단독 HTML 로 저장
```

`--html` 로 만든 파일은 데이터를 안에 다 담고 있어서 더블클릭으로 열립니다
(배경지도 타일만 인터넷을 씁니다).

## 필요한 것

* Python 3.10 이상, Flask
* 인터넷 - 배경지도(Tmap)와, `data/vsm_cache` 가 비어 있을 때 SAFE_DRIVE_DB
  내려받기(약 1 MB, 한 번만)에 필요합니다. 캐시가 같이 들어 있으면 첫 실행부터
  네트워크 없이 SDI 조회가 됩니다.
* VSM 개발 서버(`farm42/43.ids.skplanet.com:8012`)에 닿을 수 있는 망

## 안 담긴 것

`주행 로그 대조`(DLT 로그를 올려 단말이 실제로 쓴 SDI 와 비교) 기능은 원본
positioning-tool 의 DLT 파서를 쓰기 때문에 여기 없습니다. 그 기능만 빠지고
SDI 원본 조회는 그대로 됩니다. 쓰려면 `backend/positioning_tool` 을 같은
위치에 두면 됩니다.
"""


def _add_tree(archive, src_dir, arc_prefix, skip_dirs=("__pycache__",)):
    added = 0
    for base, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for name in files:
            if name.endswith((".pyc", ".pyo")) or name == ".DS_Store":
                continue
            full = os.path.join(base, name)
            rel = os.path.relpath(full, src_dir)
            archive.write(full, os.path.join(ROOT_NAME, arc_prefix, rel))
            added += 1
    return added


def _build_stamp():
    """언제 만든 패키지인지. 예전에 푼 폴더를 계속 쓰는 걸 알아채려고 넣는다."""
    when = datetime.now().strftime("%Y-%m-%d %H:%M")
    try:
        sha = subprocess.run(
            ["git", "-C", PROJECT_ROOT, "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        sha = ""
    return f"{when} {sha}".strip()


def build(out_path, include_cache=True):
    out_path = os.path.abspath(os.path.expanduser(out_path))
    counts = {}

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(os.path.join(ROOT_NAME, "run.py"), RUN_PY)
        archive.writestr(os.path.join(ROOT_NAME, "backend", "tile_tool", "BUILD"), _build_stamp())
        archive.writestr(os.path.join(ROOT_NAME, "README.md"), README)
        archive.writestr(os.path.join(ROOT_NAME, "requirements.txt"), REQUIREMENTS)
        # backend 를 패키지로 만들기 위한 빈 __init__.py
        archive.writestr(os.path.join(ROOT_NAME, "backend", "__init__.py"), "")

        tile_tool_dir = os.path.join(PROJECT_ROOT, "backend", "tile_tool")
        counts["코드"] = _add_tree(archive, tile_tool_dir, "backend/tile_tool")
        counts["화면"] = _add_tree(archive, TILE_ASSET_DIR, "frontend/static/tile")
        counts["아이콘"] = _add_tree(
            archive, os.path.join(STATIC_DIR, "img", "sdi"), "frontend/static/img/sdi")

        if include_cache and os.path.isdir(VSM_CACHE_DIR):
            counts["SDI 캐시"] = _add_tree(archive, VSM_CACHE_DIR, "data/vsm_cache")

    return out_path, counts
