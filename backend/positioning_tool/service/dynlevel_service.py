"""동적 레벨링(주행 중 roll/pitch 추정) 분석 서비스.

DLT에서 원시 센서를 추출해, 게이트(주행/등속/직진/중력크기) 판정과
저역필터 기반 roll/pitch 추정을 오프라인으로 재현한다.
결과는 [DR] 위치 샘플마다 게이트 상태를 붙인 포인트 리스트로 내려준다.

게이트 정의 (positioningsdk의 정차 leveling과 오차 수준을 맞춘 기준):
  - 주행:   v > 3 m/s
  - 등속:   |dv/dt(LPF)| < 0.3 m/s^2   (pitch 오염 최대 atan(0.3/9.81) ≈ 1.75°)
  - 직진:   |gyro_z(LPF)| < 1.0 deg/s
  - 중력:   |보상 후 가속도 norm - 9.81| < 1.0 (기존 leveling과 동일 허용치)
  - valid:  위 조건이 3초 이상 연속 유지 (LPF 안정화 대기)
"""
import math
import re

DLT_MARKER = b"DLT\x01"

_NEEDLES = [
    b"[SENSOR],[ACCELERATION]",
    b"[DRE] Input",
    b"[DRE] Output",
    b"WheelCircumference :",
    b"CNaviModule::ReceiveGps pos(",
    b"SetRollPitchFromAccelerometer",
]

_ACC_RE = re.compile(rb"\[SENSOR\],\[ACCELERATION\],(\d+),(-?\d+),(-?\d+),(-?\d+),")
_DREIN_RE = re.compile(rb"\[DRE\] Input \| timestamp=[\d.]+ \| gyro_x=(-?[\d.]+) gyro_y=(-?[\d.]+) gyro_z=(-?[\d.]+)")
_DREOUT_RE = re.compile(rb"\[DRE\] Output \| roll=(-?[\d.]+) pitch=(-?[\d.]+) heading=(-?[\d.]+)")
_SPEED_RE = re.compile(rb"WheelCircumference : use\([\d.]+\), mwheel\([\d.]+\) - speed : ([\d.]+) \(mPitch:(-?[\d.]+)\)")
# 본체 지도 앱의 'DR-based' 좌표와 같은 소스 — [DR] 디버그 로그는 DR 모드에서만
# 찍혀 궤적이 끊기므로, 항상 출력되는 ReceiveGps 를 쓴다.
_DR_RE = re.compile(rb"CNaviModule::ReceiveGps pos\(([\d.]+), ([\d.]+)\).*?speed ([\d.]+).*?isDRGps (\d+).*?drHeading ([\d.]+)")
# 실제 정차 leveling 이벤트 (before → after)
_RESET_RE = re.compile(
    rb"SetRollPitchFromAccelerometer \| before_roll=(-?[\d.]+) before_pitch=(-?[\d.]+) \| "
    rb"after_roll=(-?[\d.]+) after_pitch=(-?[\d.]+) heading=(-?[\d.]+)")

GRAVITY = 9.81

# 게이트 임계값
SPEED_MOVING_MPS = 3.0
CONST_SPEED_MAX_ACCEL = 0.3     # m/s^2
STRAIGHT_MAX_GYRO_Z = 1.0       # deg/s
GRAVITY_NORM_TOLERANCE = 1.0    # m/s^2
VALID_HOLD_SECONDS = 3.0        # 게이트 연속 유지 시간
LPF_TAU_SECONDS = 1.0           # 가속도/게이트 신호 시정수 (VectorLowPassFilter 방식)
SPEED_TAU_SECONDS = 0.5


def _iterate_records(path):
    """스토리지 타임스탬프와 레코드 바이트를 스트리밍으로 yield."""
    chunk_bytes = 64 * 1024 * 1024
    with open(path, "rb") as f:
        buffer = b""
        while True:
            chunk = f.read(chunk_bytes)
            at_eof = not chunk
            buffer += chunk
            starts = [m.start() for m in re.finditer(re.escape(DLT_MARKER), buffer)]
            if not starts:
                if at_eof:
                    return
                buffer = buffer[-len(DLT_MARKER):]
                continue
            end_index = len(starts) if at_eof else len(starts) - 1
            for i in range(end_index):
                record = buffer[starts[i]: starts[i + 1] if i + 1 < len(starts) else len(buffer)]
                if len(record) < 16 or not any(n in record for n in _NEEDLES):
                    continue
                sec = int.from_bytes(record[4:8], "little")
                usec = int.from_bytes(record[8:12], "little")
                yield sec + usec / 1e6, record
            if at_eof:
                return
            buffer = buffer[starts[-1]:]


class _Lpf:
    """ScalarLowPassFilter와 동일한 1차 IIR: alpha = dt/(tau+dt)."""

    def __init__(self, tau):
        self.tau = tau
        self.value = None

    def update(self, x, dt):
        if self.value is None or dt <= 0:
            self.value = x
        else:
            a = dt / (self.tau + dt)
            self.value += a * (x - self.value)
        return self.value


class _StraightnessDetector:
    """positioningsdk StraightnessDetector 의 파이썬 이식.

    (heading, ts_ms) 버퍼를 유지하고, 최근 5m 를 달리는 동안의 heading 이
    최신 heading 과 3° 이상 벌어진 적이 없으면 직진으로 판단한다.
    원본은 CorrectionPoints 에서 DR heading 을 먹인다 — 여기선 [DRE] Output
    heading 을 같은 용도로 쓴다.
    """

    MAX_BUFFER = 200
    MIN_SAMPLES = 2
    LOOKBACK_METERS = 5.0

    def __init__(self):
        self.samples = []  # (heading_deg, ts_ms)

    def update(self, heading_degrees, timestamp_millis):
        self.samples.append((heading_degrees, timestamp_millis))
        if len(self.samples) > self.MAX_BUFFER:
            self.samples.pop(0)

    @staticmethod
    def _heading_diff(a, b):
        diff = abs(a - b)
        return 360.0 - diff if diff > 180.0 else diff

    def is_driving_straight(self, speed_mps, max_heading_diff_degrees=3.0):
        if len(self.samples) < self.MIN_SAMPLES or speed_mps <= 0.0:
            return False
        latest_ts = self.samples[-1][1]
        if latest_ts <= 0:
            return False
        lookback_ms = int(self.LOOKBACK_METERS / speed_mps * 1000.0)
        if lookback_ms <= 0:
            return False
        start_ms = latest_ts - lookback_ms
        start = len(self.samples) - 1
        while start > 0 and self.samples[start - 1][1] >= start_ms:
            start -= 1
        if len(self.samples) - start < self.MIN_SAMPLES:
            return False
        ref = self.samples[-1][0]
        for heading, _ in self.samples[start:-1]:
            if self._heading_diff(ref, heading) > max_heading_diff_degrees:
                return False
        return True


def _interp(t, ts, vs, start_hint=0):
    """단조 증가 ts에 대한 선형 보간. 순차 접근 전제로 hint 인덱스 반환."""
    i = start_hint
    n = len(ts)
    while i + 1 < n and ts[i + 1] < t:
        i += 1
    if i + 1 >= n:
        return vs[-1], i
    if ts[i] >= t:
        return vs[i], i
    r = (t - ts[i]) / (ts[i + 1] - ts[i])
    return vs[i] + (vs[i + 1] - vs[i]) * r, i


def analyze(dlt_path, valid_hold_seconds=VALID_HOLD_SECONDS):
    acc = []       # (t, ax, ay, az) m/s^2
    gyro = []      # (t, gz) deg/s
    dre_out = []   # (t, roll, pitch, heading)
    speed = []     # (t, v) m/s
    dr_pos = []    # (t, lat, lon, heading, speed)
    resets = []    # 정차 leveling 이벤트

    for t, rec in _iterate_records(dlt_path):
        m = _ACC_RE.search(rec)
        if m:
            acc.append((t, int(m.group(2)) * 1e-3, int(m.group(3)) * 1e-3, int(m.group(4)) * 1e-3))
            continue
        m = _DREIN_RE.search(rec)
        if m:
            gyro.append((t, float(m.group(3))))
            continue
        m = _DREOUT_RE.search(rec)
        if m:
            dre_out.append((t, float(m.group(1)), float(m.group(2)), float(m.group(3))))
            continue
        m = _SPEED_RE.search(rec)
        if m:
            speed.append((t, float(m.group(1))))
            continue
        m = _DR_RE.search(rec)
        if m:
            lat, lon = float(m.group(1)), float(m.group(2))
            if lat == 0.0 and lon == 0.0:
                continue
            dr_pos.append((t, lat, lon, float(m.group(5)), float(m.group(3))))
            continue
        m = _RESET_RE.search(rec)
        if m:
            resets.append({
                "t_ms": int(t * 1000),
                "before_roll": float(m.group(1)), "before_pitch": float(m.group(2)),
                "after_roll": float(m.group(3)), "after_pitch": float(m.group(4)),
                "heading": float(m.group(5)),
            })

    if not acc or not speed or not gyro:
        return {"ok": False, "error": "센서 로그([SENSOR]/[DRE] Input/WheelCircumference)가 부족합니다.",
                "counts": {"acc": len(acc), "gyro": len(gyro), "speed": len(speed), "dr": len(dr_pos)}}

    speed_ts = [s[0] for s in speed]
    speed_vs = [s[1] for s in speed]
    gyro_ts = [g[0] for g in gyro]
    gyro_vs = [g[1] for g in gyro]

    # ── 가속도 타임라인에서 게이트/추정 계산 ─────────────────────
    lpf_ax, lpf_ay, lpf_az = _Lpf(LPF_TAU_SECONDS), _Lpf(LPF_TAU_SECONDS), _Lpf(LPF_TAU_SECONDS)
    lpf_v = _Lpf(SPEED_TAU_SECONDS)
    lpf_vdot = _Lpf(LPF_TAU_SECONDS)
    lpf_gz = _Lpf(LPF_TAU_SECONDS)

    samples = []  # dict per sample
    hint_v = hint_g = 0
    prev_t = prev_vs = None
    hold_start = None
    straightness = _StraightnessDetector()
    dre_idx = 0
    # 발동 시 사용할 값은 정차 leveling(구간 샘플 평균)과 동일하게, 게이트를
    # 만족하기 시작한 시점부터의 누적 평균으로 계산한다 (순시 LPF값이 아님).
    win_roll_sum = win_pitch_sum = 0.0
    win_count = 0
    activations = []  # valid 진입(발동) 시점과 그때 초기화될 roll/pitch(누적 평균)
    prev_valid = False

    for t, ax, ay, az in acc:
        v_raw, hint_v = _interp(t, speed_ts, speed_vs, hint_v)
        gz_raw, hint_g = _interp(t, gyro_ts, gyro_vs, hint_g)
        dt = 0.0 if prev_t is None else max(t - prev_t, 1e-4)

        v_s = lpf_v.update(v_raw, dt)
        vdot = 0.0 if prev_vs is None or dt <= 0 else (v_s - prev_vs) / dt
        vdot_s = lpf_vdot.update(vdot, dt)
        gz_s = lpf_gz.update(gz_raw, dt)
        ax_s = lpf_ax.update(ax, dt)
        ay_s = lpf_ay.update(ay, dt)
        az_s = lpf_az.update(az, dt)
        prev_t, prev_vs = t, v_s

        # 동역학 보상 (부호는 이 데이터셋에서 검증된 방향: 종/횡 모두 -)
        axc = ax_s + vdot_s
        ayc = ay_s + v_s * math.radians(gz_s)
        norm = math.sqrt(axc * axc + ayc * ayc + az_s * az_s)

        roll_dyn = math.degrees(math.atan2(ayc, math.sqrt(axc * axc + az_s * az_s)))
        pitch_dyn = math.degrees(math.atan2(axc, math.sqrt(ayc * ayc + az_s * az_s)))

        # StraightnessDetector 는 원본과 같이 DR heading([DRE] Output)으로 갱신
        while dre_idx < len(dre_out) and dre_out[dre_idx][0] <= t:
            straightness.update(dre_out[dre_idx][3], int(dre_out[dre_idx][0] * 1000))
            dre_idx += 1

        g_move = v_s > SPEED_MOVING_MPS
        g_const = abs(vdot_s) < CONST_SPEED_MAX_ACCEL
        g_straight = abs(gz_s) < STRAIGHT_MAX_GYRO_Z
        g_straight_sd = straightness.is_driving_straight(v_s)
        g_norm = abs(norm - GRAVITY) < GRAVITY_NORM_TOLERANCE
        g_all = g_move and g_const and g_straight and g_norm

        if g_all:
            if hold_start is None:
                hold_start = t
                win_roll_sum = win_pitch_sum = 0.0
                win_count = 0
            win_roll_sum += roll_dyn
            win_pitch_sum += pitch_dyn
            win_count += 1
            valid = (t - hold_start) >= valid_hold_seconds
        else:
            hold_start = None
            valid = False

        roll_win = win_roll_sum / win_count if valid and win_count else None
        pitch_win = win_pitch_sum / win_count if valid and win_count else None

        if valid and not prev_valid:
            activations.append({
                "t_ms": int(t * 1000),
                "roll_init": round(roll_win, 2),
                "pitch_init": round(pitch_win, 2),
                "hold_seconds": round(t - hold_start, 1),
            })
        prev_valid = valid

        samples.append((t, v_s, vdot_s, gz_s, roll_dyn, pitch_dyn,
                        g_move, g_const, g_straight, g_norm, g_all, valid,
                        g_straight_sd, roll_win, pitch_win))

    # ── [DR] 위치마다 가장 가까운 샘플의 게이트 상태를 붙임 ─────────
    sample_ts = [s[0] for s in samples]
    points = []
    j = 0
    for t, lat, lon, heading, spd in dr_pos:
        while j + 1 < len(sample_ts) and sample_ts[j + 1] <= t:
            j += 1
        s = samples[j]
        p = {
            "t_ms": int(t * 1000),
            "lat": lat, "lon": lon, "heading": heading,
            "v": round(s[1], 2), "vdot": round(s[2], 3), "gyro_z": round(s[3], 3),
            "roll_dyn": round(s[4], 2), "pitch_dyn": round(s[5], 2),
            "moving": s[6], "const_speed": s[7], "straight": s[8],
            "norm_ok": s[9], "all_gates": s[10], "valid": s[11],
            "straight_sd": s[12],
        }
        if s[13] is not None:
            p["roll_win"] = round(s[13], 2)
            p["pitch_win"] = round(s[14], 2)
        points.append(p)

    # DRE 자세(비교용)를 각 포인트에 붙임
    if dre_out:
        do_ts = [d[0] for d in dre_out]
        k = 0
        for p in points:
            t = p["t_ms"] / 1000.0
            while k + 1 < len(do_ts) and do_ts[k + 1] <= t:
                k += 1
            p["dr_roll"] = round(dre_out[k][1], 1)
            p["dr_pitch"] = round(dre_out[k][2], 1)

    # valid 윈도우 요약
    windows = []
    win_start = None
    acc_roll = acc_pitch = 0.0
    n = 0
    for s in samples:
        if s[11]:
            if win_start is None:
                win_start, acc_roll, acc_pitch, n = s[0], 0.0, 0.0, 0
            acc_roll += s[4]
            acc_pitch += s[5]
            n += 1
            win_end = s[0]
        elif win_start is not None:
            windows.append({"start_ms": int(win_start * 1000), "end_ms": int(win_end * 1000),
                            "duration_s": round(win_end - win_start, 1),
                            "roll_mean": round(acc_roll / n, 2), "pitch_mean": round(acc_pitch / n, 2)})
            win_start = None
    if win_start is not None:
        windows.append({"start_ms": int(win_start * 1000), "end_ms": int(win_end * 1000),
                        "duration_s": round(win_end - win_start, 1),
                        "roll_mean": round(acc_roll / n, 2), "pitch_mean": round(acc_pitch / n, 2)})

    # 이벤트(정차 리셋 / 동적 레벨링 발동)에 가장 가까운 시각의 위치를 붙임
    def attach_position(events):
        if not dr_pos:
            return
        k = 0
        for ev in sorted(events, key=lambda e: e["t_ms"]):
            t = ev["t_ms"] / 1000.0
            while k + 1 < len(dr_pos) and dr_pos[k + 1][0] <= t:
                k += 1
            best = dr_pos[k]
            if k + 1 < len(dr_pos) and abs(dr_pos[k + 1][0] - t) < abs(best[0] - t):
                best = dr_pos[k + 1]
            ev["lat"], ev["lon"] = best[1], best[2]

    attach_position(resets)
    attach_position(activations)

    moving_s = sum(1 for s in samples if s[6])
    valid_s = sum(1 for s in samples if s[11])
    rate = len(samples) / max(samples[-1][0] - samples[0][0], 1e-6)

    return {
        "ok": True,
        "points": points,
        "windows": windows,
        "stationary_resets": resets,
        "activations": activations,
        "stats": {
            "sample_rate_hz": round(rate, 1),
            "moving_seconds": round(moving_s / rate, 1),
            "valid_seconds": round(valid_s / rate, 1),
            "valid_ratio_of_moving": round(valid_s / moving_s, 3) if moving_s else 0.0,
            "window_count": len(windows),
        },
        "thresholds": {
            "moving_mps": SPEED_MOVING_MPS,
            "const_speed_max_accel": CONST_SPEED_MAX_ACCEL,
            "straight_max_gyro_z": STRAIGHT_MAX_GYRO_Z,
            "gravity_norm_tolerance": GRAVITY_NORM_TOLERANCE,
            "valid_hold_seconds": valid_hold_seconds,
            "lpf_tau_seconds": LPF_TAU_SECONDS,
        },
    }
