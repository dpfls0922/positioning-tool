// ===== 하이라이트 · 안내 이벤트(C2X/MFS/SDI) 시각화 =====
// map_script 를 주제별로 나눈 조각. render_html 이 JS_PART_FILES 순서대로 이어붙여 하나의 <script> 로 출력한다.
function highlightMarker(marker) {
    L.circleMarker(marker.getLatLng(), {
        radius: 12,
        color: 'red',
        fillColor: 'yellow',
        fillOpacity: 0.5,
        weight: 3,
        interactive: false
    }).addTo(highlightLayer);
}

function highlightLine(lineLayer) {
    L.polyline(lineLayer.getLatLngs(), {
        color: 'red',
        weight: 6,
        opacity: 0.5,
        interactive: false
    }).addTo(highlightLayer);
}

// ============================================================================
// C2X Events & Traffic Incident Visualization
// ============================================================================

const EVENT_ICON_MAP = {
    'A': { name: '사고', color: '#ef4444', icon: '🚨' },
    'B': { name: '공사', color: '#f59e0b', icon: '🚧' },
    'C': { name: '행사', color: '#8b5cf6', icon: '🎉' },
    'D': { name: '재해', color: '#dc2626', icon: '⚠️' },
    'E': { name: '통제', color: '#059669', icon: '🛑' },
};

const SDI_TYPE_MAP = {
    0: { name: '신호과속', color: '#ef4444', text: '🚨', desc: '신호 과속 단속카메라' },
    1: { name: '과속 고정식', color: '#f59e0b', text: '📷', desc: '과속 단속카메라(고정식)' },
    2: { name: '구간단속 시작', color: '#ea580c', text: '시', desc: '구간속도 단속 시작' },
    3: { name: '구간단속 끝', color: '#f97316', text: '끝', desc: '구간속도 단속 종료' },
    4: { name: '구간단속중', color: '#fb923c', text: '중', desc: '구간속도 단속 중' },
    5: { name: '꼬리물기단속', color: '#fbbf24', text: '꼬', desc: '꼬리물기 단속카메라' },
    6: { name: '신호단속', color: '#dc2626', text: '🚥', desc: '신호 단속카메라' },
    7: { name: '과속 이동식', color: '#f59e0b', text: '이', desc: '과속 단속카메라(이동식)' },
    8: { name: '박스형 과속', color: '#d946ef', text: '📦', desc: '박스형 과속위험 구간' },
    9: { name: '후면 사고', color: '#be123c', text: '←', desc: '속도 사고 후면' },
    10: { name: '후면 제한', color: '#f43f5e', text: '←', desc: '속도 제한 후면' },
    11: { name: '버스전용차로', color: '#a855f7', text: '🚌', desc: '버스 전용 차로 구간' },
    12: { name: '가변차로', color: '#9333ea', text: '🔄', desc: '가변 차로 단속' },
    13: { name: '갓길감시', color: '#7c3aed', text: '📸', desc: '갓길 감시 지점' },
    14: { name: '끼어들기금지', color: '#6366f1', text: '⛔', desc: '끼어들기 금지 구간' },
    15: { name: '교통정보수집', color: '#06b6d4', text: '📊', desc: '교통정보 수집지점' },
    16: { name: '방범CCTV', color: '#0891b2', text: '🎥', desc: '방범용 CCTV' },
    17: { name: '과적차량', color: '#f59e0b', text: '⚖️', desc: '과적차량 위험구간' },
    18: { name: '적재불량', color: '#ea580c', text: '📦', desc: '적재 불량 단속' },
    19: { name: '주차단속', color: '#8b5cf6', text: '🚗', desc: '주차 단속 지점' },
    20: { name: '일방통행', color: '#7c3aed', text: '→', desc: '일방통행 도로' },
    21: { name: '철도건널목', color: '#dc2626', text: '🚂', desc: '철도 건널목' },
    22: { name: '스쿨존 시작', color: '#ec4899', text: '🏫', desc: '어린이보호구역 시작' },
    23: { name: '스쿨존 끝', color: '#f43f5e', text: '🏫', desc: '어린이보호구역 종료' },
    24: { name: '과속방지턱', color: '#06b6d4', text: '⌣', desc: '과속방지턱' },
    25: { name: 'LPG충전소', color: '#14b8a6', text: '⛽', desc: 'LPG 충전소' },
    26: { name: '터널구간', color: '#0f766e', text: '🚇', desc: '터널 구간' },
    27: { name: '휴게소', color: '#22c55e', text: '🛑', desc: '휴게소' },
    28: { name: '톨게이트', color: '#16a34a', text: '💳', desc: '톨게이트' },
    29: { name: '안개주의', color: '#9ca3af', text: '☁️', desc: '안개주의 지역' },
    30: { name: '유해물질', color: '#6b7280', text: '☣️', desc: '유해물질 지역' },
    31: { name: '사고다발', color: '#ef4444', text: '⚠️', desc: '사고다발 지역' },
    32: { name: '급경사구간', color: '#f59e0b', text: '⬇️', desc: '급경사 구간' },
    33: { name: '급커브지역', color: '#d97706', text: '↪', desc: '급한 커브 지역' },
    34: { name: '신규급커브', color: '#ea580c', text: '↪', desc: '신규 급커브 구간' },
    35: { name: '야생동물', color: '#7c3aed', text: '🦌', desc: '야생동물 교통사고 잦은 구간' },
    36: { name: '우측시야불량', color: '#8b5cf6', text: '👁️', desc: '우측 시야 불량 지점' },
    37: { name: '시야불량', color: '#9333ea', text: '👁️', desc: '시야 불량 지점' },
    38: { name: '좌측시야불량', color: '#a855f7', text: '👁️', desc: '좌측 시야 불량 지점' },
    39: { name: '신호위반다발', color: '#dc2626', text: '🚥', desc: '신호위반 다발 구간' },
    40: { name: '과속운행다발', color: '#ef4444', text: '🏃', desc: '과속운행 다발 구간' },
    41: { name: '교통혼잡지역', color: '#f59e0b', text: '🚗', desc: '교통혼잡 지역' },
    42: { name: '방향별차로', color: '#3b82f6', text: '🔀', desc: '방향별 차로 선택 지점' },
    43: { name: '무단횡단', color: '#dc2626', text: '🚶', desc: '무단횡단 사고 다발 지점' },
    44: { name: '갓길사고다발', color: '#be123c', text: '📍', desc: '갓길 사고 다발 지점' },
    45: { name: '과속사고다발', color: '#ef4444', text: '⚡', desc: '과속 사고 다발 지점' },
    46: { name: '졸음사고다발', color: '#b91c1c', text: '😴', desc: '졸음 사고 다발 지점' },
    47: { name: '사고다발지점', color: '#dc2626', text: '📍', desc: '사고 다발 지점' },
    48: { name: '보행자사고다발', color: '#ef4444', text: '🚶', desc: '보행자 사고 다발 지점' },
    49: { name: '실버존', color: '#a855f7', text: '👴', desc: '노인보호 구역' },
    50: { name: '차량도난', color: '#8b5cf6', text: '🚗', desc: '차량도난 사고 다발 지점' },
    51: { name: '낙석주의', color: '#78350f', text: '🪨', desc: '낙석 주의 지역' },
    52: { name: '결빙주의', color: '#0ea5e9', text: '❄️', desc: '결빙 주의 지역' },
    53: { name: '병목지점', color: '#f59e0b', text: '⚠️', desc: '병목 지점' },
    54: { name: '합류도로', color: '#3b82f6', text: '➕', desc: '합류 도로' },
    55: { name: '추락주의', color: '#dc2626', text: '⬇️', desc: '추락 주의 지역' },
    56: { name: '지하차도', color: '#1f2937', text: '🚇', desc: '지하차도 구간' },
    57: { name: '주택밀집', color: '#6366f1', text: '🏘️', desc: '주택밀집 교통진정지역' },
    58: { name: '인터체인지', color: '#3b82f6', text: '🔀', desc: '인터체인지' },
    59: { name: '분기점', color: '#0ea5e9', text: '⛔', desc: '분기점' },
    60: { name: '휴게소LPG', color: '#10b981', text: '⛽', desc: '휴게소(LPG충전가능)' },
    61: { name: '교량', color: '#06b6d4', text: '🌉', desc: '교량' },
    62: { name: '제동장치사고', color: '#dc2626', text: '🛑', desc: '제동장치 사고 다발 지점' },
    63: { name: '중앙선침범', color: '#ef4444', text: '↔️', desc: '중앙선 침범 사고 다발 지점' },
    64: { name: '통행위반', color: '#be123c', text: '🚫', desc: '통행위반 사고 다발 지점' },
    65: { name: '목적지건너편', color: '#8b5cf6', text: '🔄', desc: '목적지 건너편 안내' },
    66: { name: '졸음쉼터', color: '#10b981', text: '😴', desc: '졸음 쉼터 안내' },
    67: { name: '노후경유차', color: '#059669', text: '💨', desc: '노후경유차 단속' },
    68: { name: '터널차로변경', color: '#0f766e', text: '🔄', desc: '터널내 차로변경 단속' },
    69: { name: '후면구간단속 시점', color: '#be123c', text: '시', desc: '후면 구간단속 시점' },
    70: { name: '후면구간단속 종점', color: '#e11d48', text: '끝', desc: '후면 구간단속 종점' },
    71: { name: '후면신호과속구간 시점', color: '#9f1239', text: '시', desc: '후면 신호과속 구간단속 시점' },
    72: { name: '후면신호과속구간 종점', color: '#f43f5e', text: '끝', desc: '후면 신호과속 구간단속 종점' },
    73: { name: '신호과속구간 시점', color: '#b91c1c', text: '시', desc: '신호과속 구간단속 시점' },
    74: { name: '신호과속구간 종점', color: '#ef4444', text: '끝', desc: '신호과속 구간단속 종점' },
    75: { name: 'SDI_UNKNOWN', color: '#64748b', text: '?', desc: '알 수 없는 SDI' },
    76: { name: 'SDI_MAX', color: '#94a3b8', text: '–', desc: '선택된 SDI 없음(센티넬)' },
};

function getEventIconConfig(typeCode) {
    return EVENT_ICON_MAP[typeCode] || { name: '기타', color: '#6b7280', icon: '📍' };
}

function getSdiIconConfig(sdiType) {
    return SDI_TYPE_MAP[sdiType] || { name: `기타 안내`, color: '#64748b', text: '⚙️', desc: `SDI Type ${sdiType}` };
}

// SDI type -> real icon asset, extracted from the VSM dev resource server.
// Package 32 SAFE_DRIVE_ICON_ROUTE (RawImageBundle, 64x64 RGBA) provides 23
// icons; the type->code mapping is g_sSDICode in
// MapGuidingInformationProvider.cpp, with the enum name as a fallback where
// that mapping and this bundle version disagree (e.g. SDI_SCHOOL_ZONE).
// Types absent here have no asset on this server and fall back to the drawn sign.
const SDI_ICON_ASSET = {
    0: "SDI_SPEED_ACCIDENT_POS",
    1: "SDI_SPEED_LIMIT_POS",
    2: "SDI_SPEED_BLOCK_START_POS",
    3: "SDI_SPEED_BLOCK_END_POS",
    5: "SDI_TAIL",
    6: "SDI_SIGNAL_ACCIDENT_POS",
    7: "SDI_SPEED_LIMIT_DANGEROUS_AREA",
    8: "SDI_BOX_SPEED_LIMIT_POS",
    12: "SDI_CHANGEROAD_POS",
    13: "SDI_ROAD_CONTROL_POS",
    15: "SDI_TRAFFICINFO_COLLECT_POS",
    16: "SDI_CCTV_AREA",
    18: "SDI_LOAD_BAD_CONTROL_POS",
    19: "SDI_PARKING_CONTROL_POS",
    21: "SDI_RAILWAY_CROSSING",
    22: "SDI_SCHOOL_ZONE_START",
    24: "SDI_SPEEDBUMP",
    29: "SDI_FOG_AREA",
    31: "SDI_ACCIDEDNT_AREA",
    32: "SDI_SHARP_CURVE_AREA",
    33: "SDI_SHARP_CURVE_AREA",
    47: "SDI_ACCIDEDNT_AREA",
    62: "SDI_ACCIDEDNT_AREA",
    63: "SDI_ACCIDEDNT_AREA",
    64: "SDI_ACCIDEDNT_AREA",
    66: "SDI_REST_PLACE",
};

const SDI_ICON_DIR = '/static/img/sdi/';

// Generated from benz-ivi2 module/navisdk/src/include/rg_def.h (SDI_Type).
// Category comes from that enum's '[ 타입 : ... ]' annotation; the 33 types
// without one are classified by identifier.
// Shape follows Korean road-sign convention so every SDI reads as one family:
//   camera(규제)=circle, caution(주의)=triangle, info(안내)=rounded square.
const SDI_CATEGORY = {
    0: { cat: 'camera',   glyph: "신"    },  // 신호과속
    1: { cat: 'camera',   glyph: "속"    },  // 과속 (고정식)
    2: { cat: 'camera',   glyph: "시"    },  // 구간단속 시작
    3: { cat: 'camera',   glyph: "끝"    },  // 구간단속 끝
    4: { cat: 'camera',   glyph: "중"    },  // 구간단속중
    5: { cat: 'camera',   glyph: "꼬"    },  // 꼬리물기단속카메라
    6: { cat: 'camera',   glyph: "신"    },  // 신호 단속
    7: { cat: 'camera',   glyph: "이"    },  // 과속 (이동식)
    8: { cat: 'camera',   glyph: "박"    },  // 고정식 과속위험 구간(박스형)
    9: { cat: 'camera',   glyph: "후"    },  // 후면신호과속단속카메라
    10: { cat: 'camera',   glyph: "후"    },  // 후면과속단속카메라
    11: { cat: 'camera',   glyph: "버"    },  // 버스전용차로구간
    12: { cat: 'camera',   glyph: "가"    },  // 가변 차로 단속
    13: { cat: 'camera',   glyph: "갓"    },  // 갓길 감시 지점
    14: { cat: 'camera',   glyph: "끼"    },  // 끼어들기 금지
    15: { cat: 'info',     glyph: "교"    },  // 교통정보 수집지점
    16: { cat: 'info',     glyph: "C"    },  // 방범용CCTV(신규)
    17: { cat: 'caution',  glyph: "과"    },  // 과적차량 위험구간
    18: { cat: 'camera',   glyph: "적"    },  // 적재 불량 단속
    19: { cat: 'camera',   glyph: "주"    },  // 주차단속 지점
    20: { cat: 'caution',  glyph: "일"    },  // 일방통행도로 (신규)
    21: { cat: 'caution',  glyph: "철"    },  // 철길 건널목
    22: { cat: 'caution',  glyph: "스"    },  // 어린이 보호구역(스쿨존 시작 구간)
    23: { cat: 'caution',  glyph: "스"    },  // 어린이 보호구역(스쿨존 끝 구간 )
    24: { cat: 'caution',  glyph: "⌣"    },  // 과속방지턱
    25: { cat: 'info',     glyph: "L"    },  // LPG충전소
    26: { cat: 'info',     glyph: "터"    },  // 터널 구간
    27: { cat: 'info',     glyph: "휴"    },  // 휴게소
    28: { cat: 'info',     glyph: "톨"    },  // 톨게이트
    29: { cat: 'caution',  glyph: "안"    },  // 안개주의 지역
    30: { cat: 'caution',  glyph: "유"    },  // 유해물질 지역
    31: { cat: 'caution',  glyph: "사"    },  // 사고다발
    32: { cat: 'caution',  glyph: "급"    },  // 급커브지역
    33: { cat: 'caution',  glyph: "급"    },  // 급커브구간1 (신규)
    34: { cat: 'caution',  glyph: "급"    },  // 급경사구간 (신규)
    35: { cat: 'caution',  glyph: "야"    },  // 야생동물 교통사고 잦은 구간
    36: { cat: 'caution',  glyph: "우"    },  // 우측시야불량지점(신규)
    37: { cat: 'caution',  glyph: "시"    },  // 시야불량지점(신규)
    38: { cat: 'caution',  glyph: "좌"    },  // 좌측시야불량지점(신규)
    39: { cat: 'caution',  glyph: "신"    },  // 신호위반다발구간(신규)
    40: { cat: 'caution',  glyph: "과"    },  // 과속운행다발구간(신규)
    41: { cat: 'caution',  glyph: "교"    },  // 교통혼잡지역(신규)
    42: { cat: 'caution',  glyph: "방"    },  // 방향별차로선택지점(신규)
    43: { cat: 'caution',  glyph: "무"    },  // 무단횡단사고다발지점(신규)
    44: { cat: 'caution',  glyph: "갓"    },  // 갓길 사고 다발 지점 (신규)
    45: { cat: 'caution',  glyph: "과"    },  // 과속 사발 다발 지점 (신규)
    46: { cat: 'caution',  glyph: "졸"    },  // 졸음 사고 다발 지점 (신규)
    47: { cat: 'caution',  glyph: "사"    },  // 사고다발지점
    48: { cat: 'caution',  glyph: "보"    },  // 보행자 사고다발지점
    49: { cat: 'caution',  glyph: "노"    },  // 노인보호구역
    50: { cat: 'caution',  glyph: "차"    },  // 차량도난사고 상습발생지점
    51: { cat: 'caution',  glyph: "낙"    },  // 낙석주의지역
    52: { cat: 'caution',  glyph: "결"    },  // 결빙주의지역
    53: { cat: 'caution',  glyph: "병"    },  // 병목지점
    54: { cat: 'caution',  glyph: "합"    },  // 합류 도로
    55: { cat: 'caution',  glyph: "추"    },  // 추락주의지역
    56: { cat: 'info',     glyph: "지"    },  // 지하차도 구간
    57: { cat: 'caution',  glyph: "주"    },  // 주택밀집지역(교통진정지역)
    58: { cat: 'info',     glyph: "IC"   },  // 인터체인지
    59: { cat: 'info',     glyph: "JC"   },  // 분기점
    60: { cat: 'info',     glyph: "휴"    },  // 휴게소(LPG충전가능)
    61: { cat: 'info',     glyph: "교"    },  // 교량
    62: { cat: 'caution',  glyph: "제"    },  // 제동장치사고다발지점
    63: { cat: 'caution',  glyph: "중"    },  // 중앙선침범사고다발지점
    64: { cat: 'caution',  glyph: "통"    },  // 통행위반사고다발지점
    65: { cat: 'info',     glyph: "목"    },  // 목적지 건너편 안내(Tmap 전용, GP 203을 변경해서 사용)
    66: { cat: 'info',     glyph: "졸"    },  // 졸음 쉼터 안내(Tmap 전용, GP 150을 변경해서 사용)
    67: { cat: 'camera',   glyph: "노"    },  // 노후경유차단속(8.0 신규)
    68: { cat: 'camera',   glyph: "터"    },  // 터널내 차로변경단속(8.0신규 - 데이터는 내려오지 않음).
    69: { cat: 'camera',   glyph: "시"    },  // 후면구간단속 시점
    70: { cat: 'camera',   glyph: "끝"    },  // 후면구간단속 종점
    71: { cat: 'camera',   glyph: "시"    },  // 후면신호과속구간단속 시점
    72: { cat: 'camera',   glyph: "끝"    },  // 후면신호과속구간단속 종점
    73: { cat: 'camera',   glyph: "시"    },  // 신호과속구간단속 시점
    74: { cat: 'camera',   glyph: "끝"    },  // 신호과속구간단속 종점
    75: { cat: 'caution',  glyph: "?"    },  // SDI_UNKNOWN
    76: { cat: 'caution',  glyph: "–"    },  // SDI_MAX
};

// C2X nEventType -> real Car2X icon, generated from benz-ivi2:
//   Car2XBridge.h (tagCar2XType), MapObjectProvider.cpp (g_cCar2XResourceMap,
//   ObjectResourceIndex, g_sResourcePath). Images copied from app/_res/image.
const C2X_EVENT_ASSET = {
    1: { file: "Car2X_Broken_Down_Vehicle_(BDV).png",         label: "고장차량" },
    3: { file: "Car2X_Approaching_Emergency_Vehicle_(AEV).png", label: "응급차량" },
    4: { file: "Car2X_Road_Works_(RW).png",                   label: "이동작업 구간" },
    5: { file: "Car2X_Vehicle_Accident_(VA).png",             label: "사고 발생" },
    6: { file: "Car2X_Fog_(FOG).png",                         label: "시야 제한" },
    7: { file: "Car2X_General_Warning_(GW).png",              label: "교통상황 주의" },
    8: { file: "Car2X_Severe_Weather_(SW).png",               label: "날씨변화 주의" },
    9: { file: "Car2X_Oversized_Vehicle_(OV).png",            label: "대형차량" },
    10: { file: "Car2X_Slow_Moving_Vehicle_(SMV).png",         label: "저속 주행 차량" },
    11: { file: "Car2X_Wrong_Way_Driver_(WWD).png",            label: "역주행차량" },
    14: { file: "Car2X_Hazard_Light_(HL).png",                 label: "교통상황 주의" },
    15: { file: "Car2X_Emergency_Braking_(EB).png",            label: "교통상황 주의" },
    16: { file: "Car2X_Slippery_Road_(SR).png",                label: "미끄러운 도로" },
    17: { file: "Car2X_AquaPlaning_(AP).png",                  label: "미끄러운 도로" },
    18: { file: "Car2X_Heavy_Rain_(HR).png",                   label: "호우 주의" },
    19: { file: "Car2X_Cross_Wind_(CW).png",                   label: "강풍 주의" },
    20: { file: "Car2X_Reduced_VISibility_(RVIS).png",         label: "시야 확보 주의" },
    21: { file: "Car2X_Objects_On_the_Road_(OOR).png",         label: "도로 위 장애물" },
    22: { file: "Car2X_Animals_On_the_Road_(AOR).png",         label: "도로 위 야생동물" },
    23: { file: "Car2X_people_crossing.png",                   label: "도로 위 보행자" },
    24: { file: "Car2X_Pothole_(PH).png",                      label: "패인 도로 주의" },
    25: { file: "Car2X_Major_Road_Works_(MRW).png",            label: "공사 구간" },
    26: { file: "Car2X_Crossing_Train_(CT).png",               label: "철길 건널목" },
    27: { file: "Car2X_Bump_(BUM).png",                        label: "과속방지턱" },
};

const C2X_ICON_DIR = '/static/img/c2x/';

// One palette per category, so a camera reads as a camera regardless of which
// of the 14 camera types it is.
const SDI_CATEGORY_STYLE = {
    camera:  { color: '#dc2626', label: '단속(규제)' },
    caution: { color: '#f59e0b', label: '주의구간' },
    info:    { color: '#0284c7', label: '위치정보' },
    other:   { color: '#64748b', label: '기타' }
};

// Measured off the real bundle assets so drawn fallbacks sit in the same family:
// solid fill, dark outline, high-contrast glyph. There is no blue in the real
// set — info shares the caution yellow and is told apart by shape (circle).
const SDI_ASSET_PALETTE = {
    camera:  { fill: '#ef3e11', stroke: '#520303', glyph: '#ffffff' },
    caution: { fill: '#fed100', stroke: '#4e4e4e', glyph: '#111111' },
    info:    { fill: '#fed100', stroke: '#4e4e4e', glyph: '#111111' },
    other:   { fill: '#94a3b8', stroke: '#334155', glyph: '#ffffff' }
};

// Types the navigation UI itself treats as speed cameras
// (MapGuidingInformationProvider::isSpeedCameraType). Only these carry a speed
// limit, so only these show a number instead of a glyph.
const SDI_SPEED_CAMERA_TYPES = new Set([0, 1, 2, 3, 7, 8, 9, 10]);

// C2X and MFS markers. C2X uses the real Car2X images shipped in benz-ivi2's
// app/_res/image (white disc, red ring, black glyph); everything else is drawn
// in that same construction so the two sit together.
//
// Deliberately smaller than the SDI signs: these are transient traffic events,
// not fixed roadside installations, and at the old 26px they dominated the map.
const C2X_ICON_SIZE = 22;

function buildRingIconHtml(glyph, ringColor, size) {
    const fontSize = String(glyph).length > 1 ? Math.round(size * 0.42) : Math.round(size * 0.52);
    return `
        <div style="width:${size}px;height:${size}px;border-radius:50%;box-sizing:border-box;
            background:#ffffff;border:2px solid ${ringColor};
            filter:drop-shadow(0 1px 2px rgba(0,0,0,.3));
            display:flex;align-items:center;justify-content:center;
            color:#111111;font-weight:800;font-size:${fontSize}px;line-height:1">${glyph}</div>`;
}

function createEventMarkerIcon(typeCode, iconText = null, eventTypeCode = null) {
    const size = C2X_ICON_SIZE;
    const asset = C2X_EVENT_ASSET[Number(eventTypeCode)];
    let iconHtml;

    if (asset) {
        iconHtml = `<img src="${C2X_ICON_DIR}${encodeURIComponent(asset.file)}"`
            + ` width="${size}" height="${size}" style="display:block;`
            + `filter:drop-shadow(0 1px 2px rgba(0,0,0,.3))" alt="">`;
    } else {
        const config = getEventIconConfig(typeCode);
        // The A~E MFS codes have no image set; use their initial, not an emoji.
        iconHtml = buildRingIconHtml(iconText || config.name.charAt(0), config.color, size);
    }

    return L.divIcon({
        html: iconHtml,
        className: 'event-marker',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        popupAnchor: [0, -size / 2]
    });
}

function getSdiCategory(sdiType) {
    const entry = SDI_CATEGORY[Number(sdiType)];
    const cat = entry ? entry.cat : 'other';
    return { ...SDI_CATEGORY_STYLE[cat], cat, glyph: entry ? entry.glyph : '?' };
}

// Types with no asset on the resource server fall back to a drawn sign. These
// deliberately copy the real assets' construction — solid fill, dark outline,
// glyph in the contrasting colour — so a mixed map still reads as one set:
//   camera = circle (red), caution = rounded triangle (yellow),
//   info = circle (yellow).
function buildSdiSignHtml(sdiType, speedLimit, size) {
    const category = getSdiCategory(sdiType);
    const palette = SDI_ASSET_PALETTE[category.cat] || SDI_ASSET_PALETTE.other;
    const isSpeedCamera = SDI_SPEED_CAMERA_TYPES.has(Number(sdiType));
    const limit = Number(speedLimit);
    const text = isSpeedCamera && Number.isFinite(limit) && limit > 0
        ? String(limit)
        : category.glyph;
    const fontSize = text.length >= 3 ? Math.round(size * 0.34)
        : (text.length === 2 ? Math.round(size * 0.40) : Math.round(size * 0.48));
    const shadow = 'filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))';

    if (category.cat === 'caution') {
        return `
            <div style="width:${size}px;height:${size}px;position:relative;${shadow}">
                <div style="position:absolute;inset:0;background:${palette.stroke};
                    clip-path:polygon(50% 2%,98% 94%,2% 94%)"></div>
                <div style="position:absolute;inset:2px;background:${palette.fill};
                    clip-path:polygon(50% 2%,98% 94%,2% 94%)"></div>
                <div style="position:absolute;left:0;right:0;bottom:${Math.round(size * 0.08)}px;
                    text-align:center;color:${palette.glyph};font-weight:800;
                    font-size:${Math.round(fontSize * 0.85)}px;line-height:1">${text}</div>
            </div>`;
    }

    return `
        <div style="width:${size}px;height:${size}px;border-radius:50%;
            background:${palette.fill};border:2px solid ${palette.stroke};box-sizing:border-box;
            ${shadow};display:flex;align-items:center;justify-content:center;
            color:${palette.glyph};font-weight:800;font-size:${fontSize}px;line-height:1">${text}</div>`;
}

function createSdiMarkerIcon(sdiType, faded = false, speedLimit = null) {
    const size = 26;
    const asset = SDI_ICON_ASSET[Number(sdiType)];
    let iconHtml;

    if (asset) {
        // Real navigation asset. The bundle's camera icons carry no number — the
        // app composites the limit separately — so it is added as a badge here
        // for the types that have one.
        const limit = Number(speedLimit);
        const showLimit = SDI_SPEED_CAMERA_TYPES.has(Number(sdiType))
            && Number.isFinite(limit) && limit > 0;
        const badge = showLimit
            ? `<div style="position:absolute;right:-3px;bottom:-3px;min-width:13px;height:13px;
                 padding:0 2px;border-radius:7px;background:#fff;border:1.5px solid #dc2626;
                 color:#111827;font-size:9px;font-weight:800;line-height:11px;text-align:center;
                 box-sizing:border-box">${limit}</div>`
            : '';
        iconHtml = `<div style="position:relative;width:${size}px;height:${size}px">`
            + `<img src="${SDI_ICON_DIR}${asset}.png" width="${size}" height="${size}"`
            + ` style="display:block" alt="">${badge}</div>`;
    } else {
        iconHtml = buildSdiSignHtml(sdiType, speedLimit, size);
    }

    return L.divIcon({
        html: faded ? `<div style="opacity:.4">${iconHtml}</div>` : iconHtml,
        className: 'sdi-marker',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        popupAnchor: [0, -size / 2]
    });
}

function renderTrafficIncidents(tvasResult) {
    if (!tvasResult || !tvasResult.incidents || tvasResult.incidents.length === 0) {
        return;
    }

    const eventGroup = ensureTmapFeatureGroup('Traffic Events');
    const coords = resolveVertexCoordinates(tvasResult);
    const coordMap = new Map();
    coords.forEach((coord, idx) => {
        coordMap.set(idx, { lat: coord.lat, lon: coord.lon });
    });

    tvasResult.incidents.forEach((incident) => {
        const vxCoord = coordMap.get(incident.startVxIdx);
        if (!vxCoord) return;

        const eventIcon = createEventMarkerIcon(incident.typeCode);
        const typeConfig = getEventIconConfig(incident.typeCode);
        const marker = L.marker([vxCoord.lat, vxCoord.lon], { icon: eventIcon });

        marker.bindPopup(`
            <div style="min-width: 200px;">
                <div style="font-weight: bold; color: ${typeConfig.color}; margin-bottom: 8px;">
                    ${typeConfig.icon} ${typeConfig.name}
                </div>
                <div style="font-size: 12px;">
                    <div><strong>종류:</strong> ${typeConfig.name}</div>
                    <div><strong>위치 Index:</strong> ${incident.startVxIdx}</div>
                    ${incident.content ? `<div><strong>내용:</strong> ${escapeHtml(incident.content)}</div>` : ''}
                </div>
            </div>
        `);

        eventGroup.addLayer(marker);
    });

    renderLayerControls();
}

function renderDangerAreas(tvasResult) {
    if (!tvasResult || !tvasResult.dangerAreas || tvasResult.dangerAreas.length === 0) {
        return;
    }

    const dangerGroup = ensureTmapFeatureGroup('Danger Areas');
    const coords = resolveVertexCoordinates(tvasResult);
    const coordMap = new Map();
    coords.forEach((coord, idx) => {
        coordMap.set(idx, { lat: coord.lat, lon: coord.lon });
    });

    const DANGER_TYPE_MAP = {
        1: { name: '급커브', color: '#f97316', icon: '🔄' },
        2: { name: '스쿨존', color: '#0ea5e9', icon: '🏫' },
        3: { name: '철도건널목', color: '#8b5cf6', icon: '🚂' },
        4: { name: '속도범프', color: '#ec4899', icon: '⬆️' },
        5: { name: '사고다발지', color: '#dc2626', icon: '⚠️' },
    };

    tvasResult.dangerAreas.forEach((area) => {
        const startCoord = coordMap.get(area.startVxIdx);
        const endCoord = coordMap.get(area.endVxIdx);

        if (!startCoord || !endCoord) return;

        const typeConfig = DANGER_TYPE_MAP[area.type] || { name: '위험구간', color: '#6b7280', icon: '📍' };
        const latlngs = [
            [startCoord.lat, startCoord.lon],
            [endCoord.lat, endCoord.lon]
        ];

        const polyline = L.polyline(latlngs, {
            color: typeConfig.color,
            weight: 3,
            opacity: 0.6,
            dashArray: '5, 5'
        });

        polyline.bindPopup(`
            <div style="min-width: 150px;">
                <div style="font-weight: bold; color: ${typeConfig.color}; margin-bottom: 8px;">
                    ${typeConfig.icon} ${typeConfig.name}
                </div>
                <div style="font-size: 12px;">
                    <div><strong>구간:</strong> ${area.startVxIdx} ~ ${area.endVxIdx}</div>
                    <div><strong>거리:</strong> ${area.sectionLength}m</div>
                    ${area.speedLimit > 0 ? `<div><strong>제한속도:</strong> ${area.speedLimit}km/h</div>` : ''}
                </div>
            </div>
        `);

        dangerGroup.addLayer(polyline);

        const midCoord = {
            lat: (startCoord.lat + endCoord.lat) / 2,
            lon: (startCoord.lon + endCoord.lon) / 2
        };
        const marker = L.marker([midCoord.lat, midCoord.lon], {
            icon: createEventMarkerIcon(null, typeConfig.name.charAt(0))
        });
        dangerGroup.addLayer(marker);
    });

    renderLayerControls();
}

function renderTmapRouteResultWithEvents(routeResponse) {
    renderTmapRouteResult(routeResponse);

    if (!tmapRouteResult || !tmapRouteResult.tvasResult) {
        return;
    }

    setTimeout(() => {
        renderTrafficIncidents(tmapRouteResult.tvasResult);
        renderDangerAreas(tmapRouteResult.tvasResult);
    }, 100);
}

// MFS 유고정보 name → 이벤트 타입 코드 (사고/공사/행사/재해/통제)
function mfsNameToEventCode(name) {
    const s = String(name || '');
    if (s.includes('사고')) return 'A';
    if (s.includes('공사')) return 'B';
    if (s.includes('행사')) return 'C';
    if (s.includes('재해')) return 'D';
    if (s.includes('통제')) return 'E';
    return null;
}

function visualizeGuideEventsFromLog() {
    if (!Array.isArray(markersData) || markersData.length === 0) {
        console.log('❌ visualizeGuideEventsFromLog: No markers data');
        return;
    }

    const guideMarkers = markersData.filter((m) => m.extra?.guide_event);
    const sdiMarkers = markersData.filter((m) => m.extra?.sdi_event);
    const c2xEvents = guideMarkers.filter((m) => m.extra.event_type === 'C2X');
    const mfsEvents = guideMarkers.filter((m) => m.extra.event_type === 'MFS');
    console.log(`📊 Guide Events: ${c2xEvents.length} C2X, ${mfsEvents.length} MFS(유고정보), SDI: ${sdiMarkers.length}`);

    // SDI is rendered further down and is independent of C2X/MFS, so this must
    // not bail out on guide events alone — a log with SDI but no C2X/MFS still
    // has something to draw.
    if (guideMarkers.length === 0 && sdiMarkers.length === 0) {
        return;
    }

    // C2X 이벤트 (V2X 통신 수신 — EventPos 좌표)
    if (c2xEvents.length > 0) {
        const c2xGroup = ensureTmapFeatureGroup('C2X Events');
        c2xGroup.clearLayers();

        c2xEvents.forEach((marker) => {
            const icon = createEventMarkerIcon(null, null, marker.extra.event_type_code);
            const markerObj = L.marker([marker.latitude, marker.longitude], { icon });

            markerObj.bindPopup(`
                <div style="min-width: 200px;">
                    <div style="font-weight: bold; color: #3b82f6; margin-bottom: 8px;">
                        📡 가이드 이벤트 (Guide Event) - C2X
                    </div>
                    <div style="font-size: 11px; color: #64748b; margin-bottom: 8px;">
                        V2X 통신으로 수신한 위험정보
                    </div>
                    <div style="font-size: 12px;">
                        <div><strong>Event ID:</strong> ${escapeHtml(String(marker.extra.event_id))}</div>
                        <div><strong>Event Type(CC):</strong> ${marker.extra.event_type_code ?? '-'}</div>
                        ${marker.extra.event_time ? `<div><strong>Event Time:</strong> ${escapeHtml(marker.extra.event_time)}</div>` : ''}
                        <div><strong>좌표:</strong> ${marker.latitude.toFixed(6)}, ${marker.longitude.toFixed(6)}</div>
                        <div><strong>Log Time:</strong> ${marker.timestamp_str || '-'}</div>
                    </div>
                </div>
            `);

            c2xGroup.addLayer(markerObj);
        });
    }

    // TMAP 유고정보 (MFS — 서버 Point.location 좌표)
    if (mfsEvents.length > 0) {
        const mfsGroup = ensureTmapFeatureGroup('Tmap Incidents (MFS)');
        mfsGroup.clearLayers();

        mfsEvents.forEach((marker) => {
            const code = mfsNameToEventCode(marker.extra.name);
            const typeConfig = getEventIconConfig(code);
            const icon = createEventMarkerIcon(code);
            const markerObj = L.marker([marker.latitude, marker.longitude], { icon });

            markerObj.bindPopup(`
                <div style="min-width: 220px;">
                    <div style="font-weight: bold; color: ${typeConfig.color}; margin-bottom: 8px;">
                        ${typeConfig.icon} 가이드 이벤트 (Guide Event) - MFS
                    </div>
                    <div style="font-size: 11px; color: #64748b; margin-bottom: 8px;">
                        TMAP 유고정보 (Map Feature Service)
                    </div>
                    <div style="font-size: 12px;">
                        <div><strong>이벤트명:</strong> ${escapeHtml(marker.extra.name || typeConfig.name)}</div>
                        <div><strong>Key:</strong> ${escapeHtml(String(marker.extra.event_id))}</div>
                        <div><strong>좌표:</strong> ${marker.latitude.toFixed(6)}, ${marker.longitude.toFixed(6)}</div>
                        <div><strong>Log Time:</strong> ${marker.timestamp_str || '-'}</div>
                    </div>
                </div>
            `);

            mfsGroup.addLayer(markerObj);
        });
    }

    // SDI Events (Safety Drive Information — 카메라, 과속방지턱 등)
    if (sdiMarkers.length > 0) {
        const sdiGroup = ensureTmapFeatureGroup('SDI Events');
        sdiGroup.clearLayers();

        sdiMarkers.forEach((marker) => {
            const extra = marker.extra || {};
            // GetSdiSelected logs every candidate on the route, most of which
            // are rejected. Showing them identically would imply every marker
            // was actually guided, so rejected ones are drawn faded.
            const wasSelected = extra.ever_selected !== false;
            const icon = createSdiMarkerIcon(extra.sdi_type, !wasSelected, extra.speed);
            const config = getSdiIconConfig(extra.sdi_type);
            const markerObj = L.marker([marker.latitude, marker.longitude], { icon });

            const reasons = Array.isArray(extra.skip_reasons) ? extra.skip_reasons : [];
            const row = (label, value) => (value === null || value === undefined || value === '')
                ? ''
                : `<div><strong>${label}:</strong> ${value}</div>`;

            markerObj.bindPopup(`
                <div style="min-width: 240px;">
                    <div style="font-weight: bold; color: ${config.color}; margin-bottom: 8px; font-size: 14px;">
                        🛣️ ${config.name}
                        <span style="font-size:11px;font-weight:600;padding:1px 6px;border-radius:8px;margin-left:4px;
                            background:${wasSelected ? '#dcfce7' : '#f1f5f9'};color:${wasSelected ? '#15803d' : '#64748b'}">
                            ${wasSelected ? '선택됨' : '후보(미선택)'}
                        </span>
                    </div>
                    <div style="font-size: 12px; line-height: 1.6;">
                        <div style="background-color: ${config.color}20; padding: 6px; border-radius: 4px; margin-bottom: 8px; color: ${config.color}; font-weight: bold;">
                            ${config.desc}
                        </div>
                        ${row('분류', getSdiCategory(extra.sdi_type).label)}
                        ${row('타입 코드', extra.sdi_type)}
                        ${row('제한속도', extra.speed ? `${extra.speed} km/h` : '')}
                        ${row('가변속도', extra.changeable_speed === true ? '예' : (extra.changeable_speed === false ? '아니오' : ''))}
                        ${row('우선순위', extra.priority)}
                        ${row('최근접 거리', extra.remain_dist !== null && extra.remain_dist !== undefined ? `${extra.remain_dist} m` : '')}
                        ${row('안내 기준거리', extra.guide_dist !== null && extra.guide_dist !== undefined ? `${extra.guide_dist} m` : '')}
                        ${reasons.length ? `<div><strong>미선택 사유:</strong> ${reasons.map(escapeHtml).join(', ')}</div>` : ''}
                        ${row('직전 선택', extra.selected_type_name)}
                        ${row('관측 횟수', extra.observation_count)}
                        ${row('아이콘 코드', extra.sdi_code ? escapeHtml(extra.sdi_code) : '')}
                        ${row('아이콘 에셋', SDI_ICON_ASSET[Number(extra.sdi_type)] || '없음(도형으로 대체)')}
                        ${row('정보원', extra.source)}
                        <div><strong>좌표:</strong> ${marker.latitude.toFixed(6)}, ${marker.longitude.toFixed(6)}</div>
                        <div><strong>기록시간:</strong> ${marker.timestamp_str || '-'}</div>
                    </div>
                </div>
            `);

            sdiGroup.addLayer(markerObj);
        });
    }

    // Parking Lot State Transitions
    const parkingLotMarkers = markersData.filter((m) => m.extra?.event_type === 'ParkingLot');
    if (parkingLotMarkers.length > 0) {
        const parkingGroup = ensureTmapFeatureGroup('Parking Lot State');
        parkingGroup.clearLayers();

        parkingLotMarkers.forEach((markerData) => {
            const icon = markerData.extra?.icon || '🅿️';
            const color = markerData.color || '#6b7280';
            const isDashed = markerData.extra?.dashed || false;

            const markerObj = L.circleMarker([markerData.latitude, markerData.longitude], {
                radius: 7,
                color: color,
                weight: isDashed ? 1 : 2.5,
                dashArray: isDashed ? '5, 3' : null,
                fill: !isDashed,
                fillColor: color,
                fillOpacity: isDashed ? 0.3 : 0.8,
                pane: 'markerPane'
            });

            let popupContent = `
                <div class="popup-content" style="min-width: 240px;">
                    <div style="font-weight: bold; color: ${color}; margin-bottom: 8px;">
                        ${icon} ${markerData.extra?.state_label || '주차장 상태'}
                    </div>
                    <table style="font-size: 12px;">
            `;

            // Show state transition or apply info
            if (markerData.extra?.prev_state) {
                popupContent += `
                        <tr><td><strong>상태:</strong></td><td>${markerData.extra.prev_state} → ${markerData.extra.next_state}</td></tr>
                        <tr><td><strong>이유:</strong></td><td>${markerData.extra.reason || 'N/A'}</td></tr>
                `;
            } else if (markerData.extra?.state) {
                popupContent += `
                        <tr><td><strong>상태:</strong></td><td>${markerData.extra.state}</td></tr>
                        <tr><td><strong>후보 개수:</strong></td><td>${markerData.extra.candidate_count || 0}</td></tr>
                        <tr><td><strong>최고 매칭 Link:</strong></td><td>${markerData.extra.best_link_id || 'N/A'}</td></tr>
                `;
            }

            popupContent += `
                        <tr><td><strong>좌표:</strong></td><td>${markerData.latitude.toFixed(6)}, ${markerData.longitude.toFixed(6)}</td></tr>
                        <tr><td><strong>시간:</strong></td><td>${markerData.timestamp_str || 'N/A'}</td></tr>
                    </table>
                </div>
            `;

            markerObj.bindPopup(popupContent);
            parkingGroup.addLayer(markerObj);
        });
    }

    renderLayerControls();
}

