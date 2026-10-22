"""로그 라인 정규식과 DLT 키워드 상수.

파서 본체에서 분리해 '무엇을 매칭하는지'만 모아둔다. 상태를 갖지 않는다.
"""

import re


DLT_RELEVANT_BYTE_KEYWORDS = [
    b"[GPS]",
    b"[GNSS]",
    b"GNSS mode:",
    b"GNSS rejected:",
    b"GNSS outlier:",
    b"CNaviModule::ReceiveGps pos(",
    b"Match  Pos",
    b"Match Pos",
    b"[MM_RESULT]",
    b"requestRouting",
    b"NaviARSupportServer::setRouteInformation",
    b"Candidate Link[",
    b"shouldStayRoute distance:",
    b"[[MM] : 4] State =",
    b"[MM_FEEDBACK]",
    b"createCar2XEvent",
    b"processContents",
    b"GetSdiSelected select",
    b"onDriveStatusChanged SDI",
    b"ResetRollPitch",
    b"SetRollPitchFromAccelerometer",
    b"SDIBlock:",
    b"check tunnel",
    b"GetSDIInfo[",
    b"ApplyParkingLotDetector",
    b"ParkingLotDetector transition",
    b"TVAS server route",
    b"online request [",
    b"[TVAS Header]",
    b"ServiceDataCollect",
    b"Route LinkScore RESULT",
    b"[LANE_COLOR]",
    b"GetRenderData pGuidePoint",
]

SET_ROUTE_INFORMATION_PATTERN = re.compile(
    r"NaviARSupportServer::setRouteInformation linkID:\s*"
    r"(-?\d+)\((\-?\d+)\),\s*dir:\s*(\-?\d+),\s*(\-?\d+)"
    r"(?:,\s*(\-?\d+),\s*(\-?\d+))?,\s*"
    r"size:\s*(\d+),\s*v\[st\]:\s*(\-?\d+),\s*(\-?\d+),\s*v\[en\]:\s*(\-?\d+),\s*(\-?\d+)"
)

TVAS_HEADER_ROUTE_OPT_PATTERN = re.compile(r"navisdk :: \[\[TVAS Header\] : \d+\] RouteOptCode = (\-?\d+)")

TVAS_HEADER_SERVICE_CNT_PATTERN = re.compile(r"navisdk :: \[\[TVAS Header\] : \d+\] ServiceCnt = (\-?\d+)")

TVAS_HEADER_TOTAL_TIME_PATTERN = re.compile(r"navisdk :: \[\[TVAS Header\] : \d+\] TotalTime = (\-?\d+)")

TVAS_HEADER_TOTAL_DIST_PATTERN = re.compile(r"navisdk :: \[\[TVAS Header\] : \d+\] TotalDist = (\-?\d+)")

TVAS_SERVER_SESSION_PATTERN = re.compile(
    r"TVAS server route nSessionID\s*:\s*([^,\s]+),\s*errorcode\s*:\s*([^,\s]+)"
)

# Route request point logs (SK coordinates; converted to WGS84 on the frontend):
#   NaviProcessorInternal::online request [10000013]: departName = ..., departXPos = ..., departYPos = ...
#   NaviProcessorInternal::online request [10000013]: wayPoint 0: fixed = 1, wayPointName = ..., destXPos = ..., destYPos = ...
#   NaviProcessorInternal::online request [10000013]: destName = ..., destXPos = ..., destYPos = ...
ROUTE_REQ_DEPART_PATTERN = re.compile(
    r"online request \[(\d+)\]:\s*departName = (.*?),\s*departXPos = (-?\d+),\s*departYPos = (-?\d+)"
)

ROUTE_REQ_WAYPOINT_PATTERN = re.compile(
    r"online request \[(\d+)\]:\s*wayPoint (\d+):\s*fixed = (-?\d+),\s*wayPointName = (.*?),\s*destXPos = (-?\d+),\s*destYPos = (-?\d+)"
)

ROUTE_REQ_DEST_PATTERN = re.compile(
    r"online request \[(\d+)\]:\s*destName = (.*?),\s*destXPos = (-?\d+),\s*destYPos = (-?\d+)"
)

GNSS_MODE_EVENT_PATTERN = re.compile(
    r"GNSS mode:\s*event=([A-Za-z_]+)\s+from=([A-Za-z_]+)\s+to=([A-Za-z_]+)"
)

GNSS_MODE_INLINE_PATTERN = re.compile(r"mode=([A-Za-z_]+)")

# GnssFilter::classifyGnssOutlier (benz-ivi3 app/if1impl/vehicle/positioningSensors/GnssFilter.cpp).
# 모든 후보 링크까지 최소 수선거리가 width = max(1, round(extLane/2)) * 7m 를
# 넘으면 OUTLIER로 버린다. (이전 빌드: 차로폭 5m, 후보셋 center 60m 밖이면 UNKNOWN)
# width는 로그 값을 그대로 쓰므로 차로폭이 바뀌어도 파싱은 영향 없다.
# 이 줄은 해당 epoch의 [GNSS] 줄 바로 뒤에 찍힌다.
#   GNSS outlier: rejected, raw=(37.7566719, 128.0301580), nearestLinkId=1106, dist=5.0m,
#     width=5.0m, extLane=2, centerDist=6.4m, linkCount=3
#   (신규 포맷은 extLane 뒤에 center=(lat, lon), 이 추가됨 — 선택 그룹으로 처리)
#   GNSS outlier: state INLIER -> OUTLIER, linkCount=3
GNSS_OUTLIER_REJECTED_PATTERN = re.compile(
    r"GNSS outlier:\s*rejected,\s*raw=\((-?\d+\.\d+),\s*(-?\d+\.\d+)\),"
    r"\s*nearestLinkId=(\d+),\s*dist=([\d.]+)m,\s*width=([\d.]+)m,"
    r"\s*extLane=(-?\d+),"
    r"(?:\s*center=\((-?\d+\.\d+),\s*(-?\d+\.\d+)\),)?"
    r"\s*centerDist=([\d.]+)m,\s*linkCount=(\d+)"
)

# 후보 링크 ID 목록 (선택). 현재 GnssFilter 로그에는 없고, rejected 줄 끝에
# ", candidates=[1106,1107,1200]" 처럼 덧붙이면 읽는다.
GNSS_OUTLIER_CANDIDATES_PATTERN = re.compile(r"candidates=(?:\[([^\]]*)\]|([\d/]+))")

GNSS_OUTLIER_STATE_PATTERN = re.compile(
    r"GNSS outlier:\s*state\s+([A-Z_]+)\s*->\s*([A-Z_]+),\s*linkCount=(\d+)"
    r"(?:,\s*center=\((-?\d+\.\d+),\s*(-?\d+\.\d+)\))?"
)

MM_FEEDBACK_PATTERN = re.compile(r"\[MM_FEEDBACK\]\s*([^\r\n\x00]+)")

# 정차 중 roll/pitch 재초기화 (DeadReckoningEstimator):
#   [DRE] ResetRollPitch | roll=0.0 pitch=0.0 heading=123.4
#   [DRE] SetRollPitchFromAccelerometer | before_roll=... before_pitch=... | after_roll=... after_pitch=... heading=...
ROLL_PITCH_RESET_PATTERN = re.compile(
    r"\[DRE\]\s*(ResetRollPitch|SetRollPitchFromAccelerometer)\s*\|\s*([^\r\n\x00]+)"
)

CANDIDATE_LINK_PATTERN = re.compile(
    r"Candidate Link\[\s*(\-?\d+)\]\s*"
    r"([+\-]?\d+(?:\.\d+)?)\s*\|\s*"
    r"Base:\s*([+\-]?\d+(?:\.\d+)?)\s*=\s*([+\-]?\d+(?:\.\d+)?)\s*-\s*([+\-]?\d+(?:\.\d+)?)\s*\+\s*([+\-]?\d+(?:\.\d+)?)\s*\|\s*"
    r"Adj:\s*([+\-]?\d+(?:\.\d+)?)\s*\|\s*"
    r"Dist\(p:\s*([+\-]?\d+(?:\.\d+)?)\s*d:\s*([+\-]?\d+(?:\.\d+)?)\s*laneW:\s*([+\-]?\d+(?:\.\d+)?)\s*fB:\s*([+\-]?\d+(?:\.\d+)?)\)\s*\|\s*"
    r"Angle\(g:\s*([+\-]?\d+(?:\.\d+)?)\s*v:\s*([+\-]?\d+(?:\.\d+)?)\)\s*\|\s*"
    r"Lane:\s*(\-?\d+)"
)

# Link[ID] base * mul = final / Lane:... — extrapoint 곱셈 가중치 적용 결과
LINK_EXTRAPOINT_PATTERN = re.compile(
    r"(?<![Cc]andidate\s)Link\[\s*(\-?\d+)\]\s*"
    r"([+\-]?\d+(?:\.\d+)?)\s*\*\s*([+\-]?\d+(?:\.\d+)?)\s*=\s*([+\-]?\d+(?:\.\d+)?)"
)

# C2X Events & TMAP Incident (MFS) Events — both carry actual WGS84 coordinates.
#
# C2X (V2X 통신 수신):
#   MapObjectProvider createCar2XEvent nEventID : 110, nEventType : 18,
#     aDASISProfile : 14427270, eType : 1, coord : 37.544675,126.976875,
#     eventTime : 202605150652, currentTime : 202605151552
CAR2X_CREATE_PATTERN = re.compile(
    r"createCar2XEvent\s+nEventID\s*:\s*(\d+),\s*nEventType\s*:\s*(\d+)"
    r".*?coord\s*:\s*(-?\d+\.\d+),(-?\d+\.\d+)"
    r"(?:.*?eventTime\s*:\s*(\d+))?"
)

# TMAP 유고정보 (MFS - Map Feature Service):
#   MapObjectProvider processContents type:1 state:1 key:MFS_XXXXX visible:1
#     level:16500 coord:37.XXXXXX,126.XXXXXX bCharge:0 VoltAC:0 bMarker:0 name:교통사고
MFS_CONTENT_PATTERN = re.compile(
    r"processContents\s+type:(\d+)\s+state:(\d+)\s+key:(\S+)\s+visible:(\d+)\s+level:(\d+)"
    r"\s+coord:(-?\d+\.\d+),(-?\d+\.\d+)"
    r".*?name:([^\r\n\x00]+)"
)

# SDI (Safety Drive Information) events.
#
# CSafeDriveInfomation::GetSdiSelected walks every SDI candidate on the route
# and logs one line per candidate before deciding whether to keep it:
#
#   GetSdiSelected select (0): 76, 15 nDist: 300, 500, wptPos: 37.545592, 126.978641
#                         ^i   ^   ^                                ^lat       ^lon
#                              |   `- pSDIInfo->nType: THIS candidate's type,
#                              |      and wptPos is THIS candidate's position
#                              `- stSelected.nType: best-so-far, SDI_MAX (76)
#                                 until something is selected. It belongs to a
#                                 different SDI than the coordinates do.
#
# Candidates that are rejected get a follow-up line carrying the same index,
# which is what attributes a reason to a candidate. 'skip is not service' is
# logged *before* the line above, so those candidates have no position at all.
SDI_SELECTED_PATTERN = re.compile(
    r"GetSdiSelected select\s*\((\d+)\):\s*(\d+),\s*(\d+)\s+nDist:\s*(-?\d+),\s*(-?\d+),\s+wptPos:\s*"
    r"(-?\d+\.\d+),\s*(-?\d+\.\d+)"
)

SDI_SKIP_PATTERN = re.compile(
    r"GetSdiSelected select\s*\((\d+)\):\s*skip\s+(.+?)\s*:\s*(\d+)(?:,\s*(\d+))?\s*$"
)

# MapGuidingInformationProvider::onDriveStatusChanged SDI[15] CurrentSDI
#   Speed : 50 | ChangeableSpeedType : 0 | <sdiCode> pt(126.978641,37.545592) priority:3
# pt() is (x, y) here, i.e. (lon, lat) — the opposite order from wptPos above.
# sdiCode is g_sSDICode[type] (+ the speed limit for camera types), i.e. the
# exact asset name the navigation UI looks up in its raw image bundle.
SDI_DRIVE_STATUS_PATTERN = re.compile(
    r"onDriveStatusChanged\s+SDI\[(\d+)\].*?Speed\s*:\s*(-?\d+)"
    r"(?:.*?ChangeableSpeedType\s*:\s*(\d+))?"
    r"(?:\s*\|\s*([A-Za-z0-9_]+))?"
    r".*?pt\((-?\d+\.\d+),\s*(-?\d+\.\d+)\)"
    r"(?:\s*priority:\s*(-?\d+))?"
)

# 구간단속 (section speed enforcement) HUD values. The navigation UI shows two
# plates while inside a section — 평균속도 and 남은거리 — and this line carries
# both plus the current speed:
#
#   MapGuidingInformationProvider::onDriveStatusChanged SDIBlock:0->1,
#     SdiChanged:1, SdiBlockUpdate:1 Speed:42 Avg:38 Dist:1240, callback size:1,
#     calculatedTime:3
#
# SDIBlock is <이전 상태>-><현재 상태>; 1 means inside a section.
SDI_BLOCK_STATUS_PATTERN = re.compile(
    r"SDIBlock:(\d+)->(\d+),\s*SdiChanged:(\d+),\s*SdiBlockUpdate:(\d+)"
    r"\s*Speed:(\d+)\s*Avg:(\d+)\s*Dist:(\d+)"
)

# 구간단속 제한속도 — GetSDIInfo[i] [Type:4, speed:0, blockspeed:60, isBlock:1]
SDI_BLOCK_INFO_PATTERN = re.compile(
    r"GetSDIInfo\[(\d+)\]\s*\[Type:(\d+),\s*speed:(\d+),"
    r"\s*blockspeed:(\d+),\s*isBlock:(\d+)\]"
)

# 터널·지하차도(GPS 음영) 구간. link_util.h 의 정의:
#   linkFacil 1=교량, 2=터널, 3=고가, 4=지하차도, 5=교차로내통과
#   IsShadeLink = 터널 또는 지하차도 → GPS 가 끊겨 DR 이 위치를 끌고 가는 구간
#
#   GPS Data : check tunnel m_matchData.prevlinkfacilLocal 0,
#     m_matchData.curlinkfacilLocal 2, m_matchData.nextlinkfacilLocal 0,
#     lengthtoend 44
TUNNEL_CHECK_PATTERN = re.compile(
    r"check tunnel m_matchData\.prevlinkfacilLocal (-?\d+),"
    r"\s*m_matchData\.curlinkfacilLocal (-?\d+),"
    r"\s*m_matchData\.nextlinkfacilLocal (-?\d+),"
    r"\s*lengthtoend (-?\d+)"
)

# ParkingLot Detector application results:
#   ApplyParkingLotDetector: state=3, candidateCount=2, bestLinkId=51075, bestMatchState=1
PARKING_LOT_APPLY_PATTERN = re.compile(
    r"ApplyParkingLotDetector:\s*state=(\d+),\s*candidateCount=(\d+),\s*bestLinkId=(\d+)"
)

# ParkingLot Detector state transitions (fallback):
#   ParkingLotDetector transition: Idle -> EnterCandidate, reason=enter_candidate, ...
PARKING_LOT_STATE_CHANGE_PATTERN = re.compile(
    r"ParkingLotDetector transition:\s*([A-Za-z]+)\s*->\s*([A-Za-z]+),\s*reason=([^,]+)"
)

# ---------------------------------------------------------------------------
# GP (Guide Point) / turnCode logs — navisdk CRGDataCollector & CRGPlayer
#
# Emitted while a route is being applied (route build time), one burst per
# route link, in this order:
#   [LANE_COLOR] ucSndCode:65, nVoiceCode:65, usImgID:1234, ucImgAvailable:1, turnCode:18
#   ServiceDataCollect #1 bCrossImage:1, nTurnCode:18, nLinkID:57
#   ServiceDataCollect #2 bCrossImage:1, nTurnCode:18, nVoiceCode:65
#   ServiceDataCollect nGPType:196608, nTurnCode:18, nLinkID:57
#   [LANE_COLOR] store GP (new) GPIdx:7, linkIndex:57, nVoiceCode:65, nTurnCode:18, nGPType:0x30000
# The 'store GP (new)' line is the one that actually creates a GP; the earlier
# lines only carry the inputs the GP type was derived from. Links that never
# reach 'store GP (new)' are non-guidance pass-through links (turnCode 4 등).
#
# Emitted while driving (per matched link, once per link):
#   [LANE_COLOR] linkIndex:57, guidePointIndex:7, gpLinkIndex:57, nVoiceCode:65, laneColor:1, gpTurnCode:18
GP_CROSS_IMAGE_RAW_PATTERN = re.compile(
    r"ServiceDataCollect #1 bCrossImage:(-?\d+), nTurnCode:(-?\d+), nLinkID:(-?\d+)"
)

GP_CROSS_IMAGE_FILTERED_PATTERN = re.compile(
    r"ServiceDataCollect #2 bCrossImage:(-?\d+), nTurnCode:(-?\d+), nVoiceCode:(-?\d+)"
)

GP_TYPE_PATTERN = re.compile(
    r"ServiceDataCollect nGPType:(-?\d+), nTurnCode:(-?\d+), nLinkID:(-?\d+)"
)

GP_STORE_PATTERN = re.compile(
    r"\[LANE_COLOR\] store GP \(new\) GPIdx:(-?\d+), linkIndex:(-?\d+), "
    r"nVoiceCode:(-?\d+), nTurnCode:(-?\d+), nGPType:0x([0-9A-Fa-f]+)"
)

GP_CROSS_IMAGE_DATA_PATTERN = re.compile(
    r"\[LANE_COLOR\] ucSndCode:(-?\d+), nVoiceCode:(-?\d+), usImgID:(-?\d+), "
    r"ucImgAvailable:(-?\d+), turnCode:(-?\d+)"
)

GP_LANE_COLOR_PATTERN = re.compile(
    r"\[LANE_COLOR\] linkIndex:(-?\d+), guidePointIndex:(-?\d+), gpLinkIndex:(-?\d+), "
    r"nVoiceCode:(-?\d+), laneColor:(-?\d+), gpTurnCode:(-?\d+)"
)

# Route match result, logged per position fix (NcRouteMatchEX.cpp):
#   Route LinkScore RESULT LINK[1] Vertex[10] Score[110.064] [Angle:...] ...
# LINK[] is the route link index — the same enumeration ServiceDataCollect's
# nLinkID uses — so it ties a route link ordinal to a real driven position.
ROUTE_MATCH_LINK_PATTERN = re.compile(
    r"Route LinkScore RESULT LINK\[(-?\d+)\] Vertex\[(-?\d+)\]"
)

GP_RENDER_DATA_PATTERN = re.compile(
    r"GetRenderData pGuidePoint \[\s*(-?\d+)\] gpType (-?\d+), turnCode:\s*(-?\d+), vertexEnd\s*(-?\d+)"
)


# 좌표 핸들러 반환값: 이 줄에서 다른 좌표 타입도 계속 확인할지 여부.
# 한 줄에 여러 DLT 레코드가 들어있을 수 있어 첫 매칭에서 멈추지 않는다.
_SCAN_NEXT_TYPE = True

_STOP_LINE = False
