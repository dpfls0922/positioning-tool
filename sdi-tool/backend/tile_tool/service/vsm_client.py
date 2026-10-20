"""VSM 리소스 서버 클라이언트.

vsm.py(VSM 맵 데이터 다운로더) 가 하는 것과 같은 순서를 그대로 따른다.

    application.conf
      -> resourcePackagesV2 에서 원하는 패키지 id 를 찾고
      -> <패키지 uri>.<version> 로 패키지 설정을 받고
      -> resources[].properties.uri 로 실제 파일을 받는다

vsm.py 는 전체(레이어 + 맵 DB + 모든 리소스)를 받지만 여기서는 SDI 원본인
`SAFE_DRIVE_DB`(id 23) 하나만 받는다. 맵 DB 는 전국 단위라 수 GB 다.
"""

import json
import os
import time
from urllib import request as urllib_request

from backend.tile_tool.service.paths import VSM_CACHE_DIR


# vsm.py main() 의 주석에 남아 있는 두 엔드포인트.
SERVERS = {
    "dev": "http://farm43.ids.skplanet.com:8012/hub/vsm_dev/config/application/TMAP_3D.conf",
    # 기본값은 운영 서버 - SAFE_DRIVE_DB 버전이 훨씬 최신이다 (dev 1719, prod 2617).
    "prod": "http://farm41.ids.skplanet.com:8012/hub/vsm/config/application/TMAP.conf",
}

SAFE_DRIVE_PACKAGE_ID = 23
TIMEOUT_SEC = 120


class VsmError(RuntimeError):
    pass


def _get(url, timeout=TIMEOUT_SEC):
    try:
        with urllib_request.urlopen(url, timeout=timeout) as response:
            return response.read()
    except Exception as ex:
        raise VsmError(f"{url} 요청 실패: {ex}") from ex


def _get_json(url):
    return json.loads(_get(url).decode("utf-8"))


def _package_entry(app_conf, package_id):
    # vsm.py 와 같이 scheme 에 따라 키가 갈린다. 개발/운영 모두 V2 를 쓴다.
    packages = app_conf.get("resourcePackagesV2") or app_conf.get("resourcePackages") or []
    for item in packages:
        if item.get("id") == package_id:
            return item
    raise VsmError(f"application.conf 에 리소스 패키지 {package_id} 가 없습니다.")


def fetch_safe_drive_db(server="dev", force=False):
    """SAFE_DRIVE_DB 의 NDSAFEIDX / NDSAFEDAT 를 받아 로컬 경로를 돌려준다.

    같은 version 이 이미 받아져 있고 크기가 맞으면 다시 받지 않는다.
    """
    url = SERVERS.get(server)
    if not url:
        raise VsmError(f"알 수 없는 서버: {server}")

    started = time.time()
    app_conf = _get_json(url)
    entry = _package_entry(app_conf, SAFE_DRIVE_PACKAGE_ID)
    version = entry["version"]
    package = _get_json(f"{entry['uri']}.{version}")

    target_dir = os.path.join(VSM_CACHE_DIR, server, f"{SAFE_DRIVE_PACKAGE_ID}_{version}")
    os.makedirs(target_dir, exist_ok=True)

    files = {}
    downloaded = 0
    for resource in package.get("resources", []):
        code = resource["code"]
        props = resource["properties"]
        path = os.path.join(target_dir, f"{code}.{props['fileId']}")
        expected = int(props.get("fileSize") or 0)

        if force or not os.path.exists(path) or (expected and os.path.getsize(path) != expected):
            body = _get(props["uri"])
            if expected and len(body) != expected:
                raise VsmError(
                    f"{code} 크기가 설정과 다릅니다: 받은 {len(body)}B, 설정 {expected}B"
                )
            with open(path, "wb") as handle:
                handle.write(body)
            downloaded += 1
        files[code] = path

    missing = {"NDSAFEIDX", "NDSAFEDAT"} - set(files)
    if missing:
        raise VsmError(f"패키지에 {', '.join(sorted(missing))} 가 없습니다.")

    return {
        "server": server,
        "package_id": SAFE_DRIVE_PACKAGE_ID,
        "package_name": package.get("name") or entry.get("code"),
        "version": version,
        "files": files,
        "downloaded": downloaded,
        "cached": len(files) - downloaded,
        "elapsed_ms": int((time.time() - started) * 1000),
    }
