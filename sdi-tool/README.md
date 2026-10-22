# SDI 타일 조회 툴

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
