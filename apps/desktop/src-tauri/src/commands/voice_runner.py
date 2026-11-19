"""Bundled, local-only VoxCPM2 subprocess. Paths and text arrive in a JSON file."""
import json
import sys
import os
import threading
import time
import hashlib
import random
from pathlib import Path


def main():
    request_path = Path(sys.argv[1])
    request = json.loads(request_path.read_text(encoding="utf-8"))
    if not request.get("reference") or not Path(request["reference"]).is_file():
        raise RuntimeError("请先选择有效的参考录音，再生成克隆配音")
    import numpy as np
    import soundfile as sf
    import torch
    from voxcpm import VoxCPM

    if not torch.cuda.is_available():
        raise RuntimeError("当前本机声音生成需要可用的 NVIDIA CUDA 环境，请检查安装")
    model = VoxCPM.from_pretrained(request["config"]["model"], load_denoiser=False,
                                  optimize=False, device="cuda", local_files_only=True)
    text = request["text"].strip()
    seed = int.from_bytes(hashlib.sha256(request["id"].encode()).digest()[:4], "little")
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    wav = model.generate(
        text=text,
        reference_wav_path=request.get("reference"),
        prompt_wav_path=request.get("reference") if request.get("transcript") else None,
        prompt_text=request.get("transcript") or None,
        cfg_value=2.0, inference_timesteps=10,
        retry_badcase=False,
        max_len=4096,
    )
    rate = model.tts_model.sample_rate
    if not len(wav) or not np.isfinite(wav).all() or np.max(np.abs(wav)) < 1e-6:
        raise RuntimeError("没有生成有效声音，请调整台词或参考录音")
    # VoxCPM2 emits 160 ms per step; do not publish a result cut off at its limit.
    if len(wav) / rate >= 4095 * .16:
        raise RuntimeError("台词超过单次生成容量，请分段生成")
    temporary = request_path.parent / "output.partial.wav"
    sf.write(temporary, wav, rate)
    temporary.replace(request_path.parent / "output.wav")


if __name__ == "__main__":
    if "--watch-parent" in sys.argv:
        # Watch the parent process without touching stdin (ML imports inspect it).
        def watch_parent():
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
                    time.sleep(.5)
            os._exit(2)
        threading.Thread(target=watch_parent, daemon=True).start()
    main()
