"""Local VoxCPM2 inference. Rust supervises the worker and its file mailbox."""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import json
import os
from pathlib import Path
import random
import re
import sys
import threading
import time
import traceback


MAX_SEGMENT_CHARS = 180
MAX_GENERATION_STEPS = 4096
RETRY_RATIO = 6.0
SENTENCE_END = re.compile(r"""(?:[。！？!?]+|\.{2,}|(?<!\d)\.|\.(?!\d)|\n+)["'”’」』）)]*""")
SOFT_BREAK = re.compile(r"[，、；,;：:\s]")
PRESET_OPTIONS = {
    "quick": (8, False),
    "quality": (12, True),
}


class VoiceError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def classify_error(exc):
    if isinstance(exc, VoiceError):
        return exc.code, str(exc)
    # Keep raw exceptions in the local log; the card gets a short action.
    detail = str(exc).lower()
    if getattr(exc, "winerror", None) == 1455 or "winerror 1455" in detail or "paging file" in detail:
        return "paging_file", "Windows 页面文件不足，请关闭占用内存的程序，或增大页面文件后重试"
    if "cuda out of memory" in detail or "cuda error: out of memory" in detail or (
        type(exc).__name__ == "OutOfMemoryError" and "cuda" in detail
    ):
        return "cuda_oom", "显存不足，请关闭占用显存的程序后重试"
    if isinstance(exc, (ImportError, FileNotFoundError)):
        return "environment", "声音环境缺少依赖或模型文件，请在环境详情中重新检测"
    return "inference_failed", "声音生成失败，请打开诊断日志查看原因"


def split_text(text, limit=MAX_SEGMENT_CHARS):
    # Prefer sentence boundaries, then punctuation or spaces inside overlong sentences.
    start = 0
    parts = []
    for boundary in SENTENCE_END.finditer(text):
        parts.append(text[start:boundary.end()])
        start = boundary.end()
    parts.append(text[start:])

    chunks = []
    pending = ""
    for part in parts:
        while len(part) > limit:
            breaks = list(SOFT_BREAK.finditer(part, limit // 2, limit))
            cut = breaks[-1].end() if breaks else limit
            if pending.strip():
                chunks.append(pending.strip())
            if part[:cut].strip():
                chunks.append(part[:cut].strip())
            pending, part = "", part[cut:]
        if len(pending) + len(part) > limit:
            if pending.strip():
                chunks.append(pending.strip())
            pending = ""
        pending += part
    if pending.strip():
        chunks.append(pending.strip())
    return chunks


def prepare_reference(reference, target, np, sf):
    try:
        samples, rate = sf.read(reference, dtype="float32", always_2d=True)
    except (OSError, sf.SoundFileError) as exc:
        raise VoiceError("invalid_reference", "无法读取参考录音，请重新选择或导入录音") from exc
    if not samples.size or not np.isfinite(samples).all():
        raise VoiceError("invalid_reference", "参考录音没有有效声音，请重新选择录音")

    mono = samples.mean(axis=1)
    level = np.abs(mono)
    peak = float(level.max())
    if peak < 0.0001:
        raise VoiceError("silent_reference", "参考录音接近静音，请更换包含清晰人声的录音")

    # Trim only quiet ends and keep a margin for soft consonants or breaths.
    active = np.flatnonzero(level >= max(peak * 0.01, 0.0001))
    margin = round(rate * 0.15)
    start = max(0, int(active[0]) - margin)
    end = min(len(samples), int(active[-1]) + margin + 1)
    if start < rate * 0.25:
        start = 0
    if len(samples) - end < rate * 0.25:
        end = len(samples)
    if end - start < rate:
        start, end = 0, len(samples)

    rms = float(np.sqrt(np.mean(np.square(mono[start:end]))))
    gain = 1.0
    warning = None
    if float(np.abs(samples).max()) >= 0.999:
        gain = min(1.0, 0.95 / peak)
        warning = "参考录音可能已削波，更换音量适中的录音可改善音质"
    elif rms < 0.015:
        gain = min(4.0, 0.05 / max(rms, 0.0001), 0.95 / peak)
        warning = "参考录音音量偏低，已适度调整。更换清晰录音可改善音质"

    if start or end < len(samples) or gain != 1.0:
        sf.write(target, mono[start:end] * gain, rate, subtype="PCM_16")
        return target, warning
    return reference, warning


def write_status(directory, stage, progress=None, error_code=None, user_message=None, warning=None):
    status = {"stage": stage}
    for name, value in (
        ("progress", progress), ("error_code", error_code),
        ("user_message", user_message), ("warning", warning),
    ):
        if value is not None:
            status[name] = value
    temporary = directory / "status.partial.json"
    temporary.write_text(json.dumps(status, ensure_ascii=False), encoding="utf-8")
    target = directory / "status.json"
    # A Windows reader can briefly hold the previous status without delete sharing.
    deadline = time.monotonic() + 0.5
    while True:
        try:
            temporary.replace(target)
            return
        except PermissionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.025)


class VoiceWorker:
    def __init__(self):
        self.model_path = None
        self.model = None

    def synthesize(self, request, directory, status):
        status("preparing_reference")
        reference = request.get("reference")
        if not reference or not Path(reference).is_file():
            raise VoiceError("invalid_reference", "请先选择有效的参考录音，再生成克隆配音")
        text = request["text"].strip()
        if not text:
            raise VoiceError("empty_text", "请填写要生成的台词")
        chunks = split_text(text)

        import numpy as np
        import soundfile as sf

        reference, warning = prepare_reference(reference, directory / "reference.prepared.wav", np, sf)
        transcript = (request.get("transcript") or "").strip() or None

        model_path = request["config"]["model"]
        needs_model = self.model_path != model_path or self.model is None
        if needs_model:
            self.model = None
            status("loading_model", warning=warning)

        import torch

        if needs_model:
            from voxcpm import VoxCPM

            if not torch.cuda.is_available():
                raise VoiceError("cuda_unavailable", "当前声音生成需要 NVIDIA CUDA，请在环境详情中重新检测")
            self.model = VoxCPM.from_pretrained(
                model_path, load_denoiser=False, optimize=False, device="cuda", local_files_only=True
            )
            self.model_path = model_path

        seed = request.get("seed")
        if seed is None:
            seed = int.from_bytes(hashlib.sha256(request["id"].encode()).digest()[:4], "little")
        random.seed(seed)
        np.random.seed(seed % 2**32)
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)

        timesteps, retry = PRESET_OPTIONS.get(request.get("preset"), (10, False))
        tts = self.model.tts_model
        rate = tts.sample_rate
        # VoxCPM2 emits a 160 ms patch per autoregressive step.
        patch_samples = round(rate * 0.16)
        pause = np.zeros(round(rate * 0.06), dtype=np.float32)
        status("synthesizing", progress=0, warning=warning)
        # The AudioVAE activation caches its optimized graph across requests.
        # Use the same graph from the first inference, including automatic seeds.
        with (
            torch.jit.optimized_execution(False),
            sf.SoundFile(directory / "output.partial.wav", "w", rate, 1, subtype="PCM_16") as output,
        ):
            for index, chunk in enumerate(chunks):
                chunk = " ".join(chunk.split())
                wav = self.model.generate(
                    text=chunk, reference_wav_path=str(reference),
                    prompt_wav_path=str(reference) if transcript else None, prompt_text=transcript,
                    cfg_value=2.0, inference_timesteps=timesteps,
                    retry_badcase=retry, retry_badcase_max_times=2,
                    retry_badcase_ratio_threshold=RETRY_RATIO, max_len=MAX_GENERATION_STEPS,
                )
                if not len(wav) or not np.isfinite(wav).all() or np.max(np.abs(wav)) < 1e-6:
                    raise VoiceError("empty_audio", "没有生成有效声音，请调整台词或参考录音")
                limit = min(MAX_GENERATION_STEPS, int(len(tts.text_tokenizer(chunk)) * RETRY_RATIO + 10))
                if len(wav) >= limit * patch_samples:
                    raise VoiceError("text_too_long", "部分台词超过单段合成容量，请缩短该句或补充分句标点")

                # Fade at either side of the pause without overlapping two spoken phrases.
                fade = min(round(rate * 0.015), len(wav) // 2)
                if fade and len(chunks) > 1:
                    wav = wav.copy()
                    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
                    if index > 0:
                        wav[:fade] *= ramp
                    if index + 1 < len(chunks):
                        wav[-fade:] *= ramp[::-1]
                if index > 0:
                    output.write(pause)
                output.write(wav)
                status("synthesizing", progress=round(100 * (index + 1) / len(chunks)), warning=warning)
            status("saving", progress=100, warning=warning)
        (directory / "output.partial.wav").replace(directory / "output.wav")

    def process(self, request_path):
        directory = request_path.parent
        warning = None
        error = None

        def status(stage, **fields):
            nonlocal warning
            warning = fields.pop("warning", warning)
            write_status(directory, stage, warning=warning, **fields)

        with (directory / "diagnostic.log").open("a", encoding="utf-8", errors="replace") as log:
            with redirect_stdout(log), redirect_stderr(log):
                try:
                    request = json.loads(request_path.read_text(encoding="utf-8"))
                    self.synthesize(request, directory, status)
                except Exception as exc:
                    traceback.print_exc()
                    error = classify_error(exc)
                for name in ("reference.prepared.wav", "output.partial.wav"):
                    try:
                        (directory / name).unlink(missing_ok=True)
                    except OSError:
                        traceback.print_exc()

        if error:
            code, message = error
            status("failed", error_code=code, user_message=message)
            return False
        status("succeeded", progress=100)
        return True


def serve(mailbox):
    worker = VoiceWorker()
    pending = mailbox / "request.json"
    claimed = mailbox / "request.claimed.json"
    while mailbox.is_dir():
        try:
            pending.rename(claimed)
        except FileNotFoundError:
            time.sleep(0.05)
            continue
        payload = json.loads(claimed.read_text(encoding="utf-8"))
        claimed.unlink()
        request_path = Path(payload["request_path"])
        if not request_path.is_absolute() or request_path.name != "request.json":
            raise ValueError("Invalid worker request path")
        worker.process(request_path)


def watch_parent():
    # Never touch stdin; the ML dependencies inspect it during initialization.
    parent = int(os.environ["BOWERBIRD_VOICE_PARENT_PID"])
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, parent)
        if handle:
            kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
            kernel.CloseHandle(handle)
    else:
        while os.getppid() == parent:
            time.sleep(0.5)
    os._exit(2)


def main():
    os.environ.setdefault("TQDM_DISABLE", "1")
    worker_mode = sys.argv[1] == "--worker"
    if "--watch-parent" in sys.argv or (
        worker_mode and sys.platform != "win32" and "BOWERBIRD_VOICE_PARENT_PID" in os.environ
    ):
        threading.Thread(target=watch_parent, daemon=True).start()
    if worker_mode:
        serve(Path(sys.argv[2]))
        return 0
    return 0 if VoiceWorker().process(Path(sys.argv[1])) else 1


if __name__ == "__main__":
    sys.exit(main())
