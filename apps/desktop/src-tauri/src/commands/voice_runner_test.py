"""Run with the managed voice Python and -B to keep the source tree clean."""
from contextlib import contextmanager, nullcontext
import json
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np
import soundfile as sf

import voice_runner as runner


class VoiceRunnerTests(unittest.TestCase):
    def test_split_preserves_words_decimal_punctuation_and_unbroken_text(self):
        text = '第一句。第二句！ “One sentence with 3.14.”\nAnother line. ' + "长" * 305
        chunks = runner.split_text(text, limit=65)
        self.assertTrue(all(0 < len(chunk) <= 65 for chunk in chunks))
        self.assertTrue(any("3.14.”" in chunk for chunk in chunks))
        self.assertEqual("".join(text.split()), "".join("".join(chunks).split()))

    def test_model_reuse_seed_settings_and_progress(self):
        rate = 12000
        optimized = True
        inference_modes = []

        @contextmanager
        def jit_optimization(enabled):
            nonlocal optimized
            previous, optimized = optimized, enabled
            try:
                yield
            finally:
                optimized = previous

        def generate(**_):
            inference_modes.append(optimized)
            return np.full(300, 0.07 + random.random() * 0.05 + np.random.random() * 0.05, dtype=np.float32)

        model = SimpleNamespace(
            tts_model=SimpleNamespace(sample_rate=rate, text_tokenizer=list),
            generate=Mock(side_effect=generate),
        )
        load = Mock(return_value=model)
        cuda_seed = Mock()
        torch = SimpleNamespace(
            manual_seed=Mock(), cuda=SimpleNamespace(is_available=lambda: True, manual_seed_all=cuda_seed),
            jit=SimpleNamespace(optimized_execution=jit_optimization),
        )
        stages = {}
        write = runner.write_status

        def capture(directory, stage, **fields):
            stages.setdefault(directory.name, []).append((stage, fields.get("progress")))
            write(directory, stage, **fields)

        with tempfile.TemporaryDirectory() as temporary, patch.dict(sys.modules, {
            "torch": torch, "voxcpm": SimpleNamespace(VoxCPM=SimpleNamespace(from_pretrained=load)),
        }), patch.object(runner, "write_status", capture):
            base = Path(temporary)
            reference = base / "reference.wav"
            sf.write(reference, np.full(rate, 0.1), rate)
            text = "这是需要自动切成多段的中文长台词，应该完整保留每一段。Another sentence. " * 16
            worker = runner.VoiceWorker()
            for name, preset, seed in (("auto", "quick", None), ("first", "quick", 53), ("warm", "quick", 53),
                                       ("quality", "quality", 53), ("after", "quick", None)):
                directory = base / name
                directory.mkdir()
                request_path = directory / "request.json"
                request_path.write_text(json.dumps({
                    "id": name, "config": {"model": "fixture"}, "reference": str(reference),
                    "text": text, "seed": seed, "preset": preset, "transcript": "原文",
                }), encoding="utf-8")
                self.assertTrue(worker.process(request_path))
                self.assertFalse((directory / "output.partial.wav").exists())
                self.assertEqual(json.loads((directory / "status.json").read_text(encoding="utf-8")),
                                 {"stage": "succeeded", "progress": 100})
            self.assertEqual(load.call_count, 1)
            self.assertEqual(cuda_seed.call_count, 5)
            seeds = [call.args[0] for call in cuda_seed.call_args_list]
            self.assertEqual(seeds[1:4], [53, 53, 53])
            self.assertEqual(len({seeds[0], seeds[-1], 53}), 3)
            self.assertIn(("loading_model", None), stages["auto"])
            self.assertNotIn(("loading_model", None), stages["warm"])
            progress = [percent for stage, percent in stages["warm"] if stage == "synthesizing"]
            self.assertEqual(progress, sorted(progress))
            self.assertGreater(len(progress), 3)
            first = (base / "first" / "output.wav").read_bytes()
            self.assertEqual(first, (base / "warm" / "output.wav").read_bytes())
            segments = len(runner.split_text(text.strip()))
            self.assertEqual(inference_modes, [False] * (5 * segments))
            self.assertTrue(optimized)
            self.assertEqual(sf.info(base / "first" / "output.wav").frames,
                             300 * segments + round(rate * 0.06) * (segments - 1))
            self.assertEqual(model.generate.call_args_list[0].kwargs["inference_timesteps"], 8)
            self.assertFalse(model.generate.call_args_list[0].kwargs["retry_badcase"])
            quality = model.generate.call_args_list[3 * segments]
            self.assertEqual(quality.kwargs["inference_timesteps"], 12)
            self.assertTrue(quality.kwargs["retry_badcase"])

    def test_language_selects_cloning_mode_and_prefixes_every_chunk(self):
        rate = 12000
        tokenizer = Mock(side_effect=list)
        model = SimpleNamespace(
            tts_model=SimpleNamespace(sample_rate=rate, text_tokenizer=tokenizer),
            generate=Mock(return_value=np.full(300, 0.1, dtype=np.float32)),
        )
        worker = runner.VoiceWorker()
        worker.model = model
        worker.model_path = "fixture"
        torch = SimpleNamespace(manual_seed=Mock(), cuda=SimpleNamespace(manual_seed_all=Mock()),
                                jit=SimpleNamespace(optimized_execution=nullcontext))
        text = "  第一  句。\n " + "長" * runner.MAX_SEGMENT_CHARS + "。  餘句。  "
        chunks = [" ".join(chunk.split()) for chunk in runner.split_text(text.strip())]
        self.assertGreater(len(chunks), 1)
        with tempfile.TemporaryDirectory() as temporary, patch.dict(sys.modules, {"torch": torch}):
            base = Path(temporary)
            reference = base / "reference.wav"
            sf.write(reference, np.full(rate, 0.1), rate)
            for index, (language, prefix) in enumerate(
                ((None, ""), ("", ""), ("auto", ""), ("yue", "(粤语)"), ("en", "(English)"))
            ):
                with self.subTest(language=language):
                    directory = base / str(index)
                    directory.mkdir()
                    request = {"id": str(index), "config": {"model": "fixture"}, "reference": str(reference),
                               "text": text, "transcript": " 原文 "}
                    if language is not None:
                        request["language"] = language
                    model.generate.reset_mock()
                    tokenizer.reset_mock()
                    worker.synthesize(request, directory, Mock())
                    expected = [prefix + chunk for chunk in chunks]
                    calls = [call.kwargs for call in model.generate.call_args_list]
                    self.assertEqual([call["text"] for call in calls], expected)
                    self.assertEqual([call.args[0] for call in tokenizer.call_args_list], expected)
                    for call in calls:
                        self.assertEqual(call["reference_wav_path"], str(reference))
                        self.assertEqual(call["prompt_wav_path"], None if prefix else str(reference))
                        self.assertEqual(call["prompt_text"], None if prefix else "原文")
                    self.assertEqual(request["text"], text)

    def test_invalid_language_is_reported_in_worker_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            request_path = directory / "request.json"
            request_path.write_text(json.dumps({"language": "unsupported"}), encoding="utf-8")
            self.assertFalse(runner.VoiceWorker().process(request_path))
            status = json.loads((directory / "status.json").read_text(encoding="utf-8"))
            self.assertEqual(status["error_code"], "invalid_language")

    def test_reference_preprocessing_leaves_recording_intact(self):
        rate = 16000
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            reference = base / "reference.wav"
            target = base / "reference.prepared.wav"
            audio = np.concatenate([np.zeros(rate), np.full(rate * 2, 0.006), np.zeros(rate)])
            sf.write(reference, audio, rate)
            original = reference.read_bytes()
            prepared, warning = runner.prepare_reference(reference, target, np, sf)
            self.assertEqual(reference.read_bytes(), original)
            self.assertEqual(prepared, target)
            self.assertIn("音量偏低", warning)
            samples, _ = sf.read(target)
            self.assertLess(len(samples), len(audio))
            self.assertLessEqual(np.abs(samples).max(), 0.025)
            sf.write(reference, np.zeros(rate), rate)
            with self.assertRaisesRegex(runner.VoiceError, "静音"):
                runner.prepare_reference(reference, target, np, sf)

    def test_failures_publish_diagnostics_without_partial_output(self):
        for exc, code in (
            (RuntimeError("CUDA out of memory. Tried to allocate 1455 MiB."), "cuda_oom"),
            (OSError("[WinError 1455] The paging file is too small"), "paging_file"),
            (ModuleNotFoundError("voxcpm"), "environment"),
            (runner.VoiceError("empty_audio", "没有生成有效声音"), "empty_audio"),
            (runner.VoiceError("text_too_long", "部分台词超过单段合成容量"), "text_too_long"),
        ):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                request_path = directory / "request.json"
                request_path.write_text("{}", encoding="utf-8")
                (directory / "output.partial.wav").write_bytes(b"partial")
                worker = runner.VoiceWorker()
                with patch.object(worker, "synthesize", side_effect=exc):
                    self.assertFalse(worker.process(request_path))
                status = json.loads((directory / "status.json").read_text(encoding="utf-8"))
                self.assertEqual(status["stage"], "failed")
                self.assertEqual(status["error_code"], code)
                self.assertIn(str(exc), (directory / "diagnostic.log").read_text(encoding="utf-8"))
                self.assertFalse((directory / "output.partial.wav").exists())
                self.assertFalse((directory / "output.wav").exists())

    def test_status_retries_windows_sharing_conflict(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            replace = Path.replace
            attempts = []

            def sharing_conflict(source, target):
                attempts.append(source)
                if len(attempts) == 1:
                    raise PermissionError("status.json is open")
                replace(source, target)

            with patch.object(Path, "replace", sharing_conflict):
                runner.write_status(directory, "succeeded", progress=100)
            self.assertEqual(len(attempts), 2)
            self.assertEqual(json.loads((directory / "status.json").read_text(encoding="utf-8")),
                             {"stage": "succeeded", "progress": 100})
            self.assertFalse((directory / "status.partial.json").exists())

    def test_worker_claims_consecutive_requests_from_files_without_stdin(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            mailbox = base / "worker"
            mailbox.mkdir()
            with subprocess.Popen(
                [sys.executable, "-u", runner.__file__, "--worker", str(mailbox)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
            ) as worker:
                try:
                    for name in ("first", "second"):
                        directory = base / name
                        directory.mkdir()
                        request_path = directory / "request.json"
                        request_path.write_text("{}", encoding="utf-8")
                        pending = mailbox / "request.partial.json"
                        pending.write_text(json.dumps({"request_path": str(request_path)}), encoding="utf-8")
                        pending.replace(mailbox / "request.json")
                        status_path = directory / "status.json"
                        deadline = time.monotonic() + 5
                        while time.monotonic() < deadline and worker.poll() is None:
                            if status_path.is_file():
                                status = json.loads(status_path.read_text(encoding="utf-8"))
                                if status["stage"] == "failed":
                                    break
                            time.sleep(0.02)
                        else:
                            self.fail("Worker did not publish a terminal status")
                        self.assertEqual(status["error_code"], "invalid_reference")
                        self.assertEqual(list(mailbox.iterdir()), [])
                    mailbox.rmdir()
                    self.assertEqual(worker.wait(timeout=5), 0)
                finally:
                    if worker.poll() is None:
                        worker.kill()


if __name__ == "__main__":
    unittest.main()
