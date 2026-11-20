import hashlib
import io
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse

import tos
from requests import Response

from upload_immutable import check_live, upload, verify_downloads


class ReleaseTest(unittest.TestCase):
    version = "1.3.0"
    arch = "x86_64"

    def setUp(self):
        self.client = tos.TosClientV2("test", "test", "https://tos.example.test", "cn-guangzhou",
                                      enable_crc=False, max_retry_count=0)
        self.objects = {}
        self.lock = threading.Lock()
        self.versioning = {}
        self.interrupt = None
        self.client.session.request = self.transport
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)

    def transport(self, method, url, **args):
        response = Response()
        response.status_code = 200
        path = urlparse(url).path
        data = b""
        if args.get("params") == {"versioning": ""}:
            data = json.dumps(self.versioning).encode()
        elif method == "PUT":
            self.assertEqual(str(args["headers"]["x-tos-forbid-overwrite"]).lower(), "true")
            with self.lock:
                if path == self.interrupt:
                    raise ConnectionError("interrupted upload")
                if path in self.objects:
                    response.status_code = 409
                    data = b'{"Code":"FileAlreadyExists","Message":"conflict"}'
                else:
                    self.objects[path] = args["data"].read()
        else:
            self.assertEqual(method, "GET")
            data = self.objects[path]
        response.raw = io.BytesIO(data)
        response.headers["Content-Length"] = str(len(data))
        return response

    def freeze(self, label):
        directory = Path(self.root.name, label)
        directory.mkdir()
        tar = "Bowerbird_1.3.0_x86_64.app.tar.gz"
        dmg = "Bowerbird_1.3.0_x86_64-updater-installer.dmg"
        hashes = []
        for name in (tar, tar + ".sig", tar + ".sha256", dmg, dmg + ".sha256", "darwin-x86_64.json"):
            data = (name + label).encode()
            (directory / name).write_bytes(data)
            hashes.append(f"{hashlib.sha256(data).hexdigest()}  {name}\n")
        (directory / "SHA256SUMS").write_text("".join(hashes), encoding="utf-8")
        return directory

    def stage(self, directory):
        upload(self.client, "fixture-123", directory, self.version, self.arch)

    def test_interrupted_upload_can_reuse_only_identical_bytes(self):
        frozen = self.freeze("a")
        self.interrupt = "/mac_package/Bowerbird_1.3.0_x86_64.app.tar.gz.sig"
        with self.assertRaises(ConnectionError):
            self.stage(frozen)
        self.assertEqual(len(self.objects), 1)
        self.interrupt = None
        self.stage(frozen)
        expected = dict(self.objects)
        self.assertEqual(len(expected), 6)
        self.assertIn("/mac_package/darwin-x86_64-1.3.0.json", expected)
        self.stage(frozen)
        with self.assertRaisesRegex(ValueError, "Immutable"):
            self.stage(self.freeze("b"))
        self.assertEqual(self.objects, expected)
        (frozen / "darwin-x86_64.json").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.stage(frozen)
        self.assertEqual(self.objects, expected)

    def test_racing_releases_only_one_frozen_set_wins(self):
        dirs = [self.freeze(label) for label in ("a", "b")]
        with ThreadPoolExecutor(2) as pool:
            futures = [pool.submit(self.stage, d) for d in dirs]
            winners = [i for i, f in enumerate(futures) if f.exception() is None]
        self.assertEqual(len(winners), 1)
        self.assertEqual(len(self.objects), 6)
        self.assertTrue(all(b.endswith(dirs[winners[0]].name.encode()) for b in self.objects.values()))

    def test_preexisting_signature_dmg_or_versioned_manifest_cannot_be_replaced(self):
        directory = self.freeze("a")
        for existing in ("Bowerbird_1.3.0_x86_64.app.tar.gz.sig",
                         "Bowerbird_1.3.0_x86_64-updater-installer.dmg", "darwin-x86_64-1.3.0.json"):
            key = "/mac_package/" + existing
            self.objects = {key: b"prior archive", "/mac_package/darwin-x86_64.json": b"current channel"}
            with self.assertRaisesRegex(ValueError, "Immutable"):
                self.stage(directory)
            self.assertEqual(self.objects[key], b"prior archive")
            self.assertEqual(self.objects["/mac_package/darwin-x86_64.json"], b"current channel")

    def test_versioning_or_unknown_status_rejects_before_first_write(self):
        directory = self.freeze("a")
        for status in ("Enabled", "Suspended", "Unexpected"):
            self.versioning = {"Status": status}
            with self.assertRaisesRegex(ValueError, "never-versioned"):
                self.stage(directory)
            self.assertFalse(self.objects)

    def test_live_baseline(self):
        with patch("subprocess.check_output", return_value=b'{"version":"1.2.9","platforms":{"darwin-x86_64":{"url":"https://cdn.example/a","signature":"archive-sig"}}}'):
            check_live(self.arch, self.version)
            for version in ("1.2.9", "0.9.0", "1.9"):
                with self.assertRaises(ValueError):
                    check_live(self.arch, version)
        for data in (b"", b"{}", b'{"version":"1.0.0","platforms":{"darwin-aarch64":{}}}',
                     b'{"version":"1.0.0","platforms":{"darwin-x86_64":{}}}'):
            with patch("subprocess.check_output", return_value=data), self.assertRaises((ValueError, KeyError)):
                check_live(self.arch, self.version)
        with patch("subprocess.check_output", side_effect=OSError("offline")), self.assertRaises(OSError):
            check_live(self.arch, self.version)

    def test_cdn_full_download_rejects_same_size_wrong_dmg(self):
        directory = self.freeze("cdn")
        tar = "Bowerbird_1.3.0_x86_64.app.tar.gz"
        dmg = "Bowerbird_1.3.0_x86_64-updater-installer.dmg"
        (directory / "darwin-x86_64.json").write_text(json.dumps({"platforms": {
            "darwin-x86_64": {"url": "https://cdn.example/mac_package/" + tar}}}), encoding="utf-8")
        payloads = {name: (directory / name).read_bytes() for name in (tar, dmg)}
        def fetch(url, **kwargs):
            self.assertTrue(kwargs["stream"])
            response = Response()
            response.status_code = 200
            response.raw = io.BytesIO(payloads[url.rsplit("/", 1)[-1]])
            return response
        with patch("requests.get", side_effect=fetch):
            verify_downloads(directory, self.version, self.arch)
            payloads[dmg] = b"-" * len(payloads[dmg])
            with self.assertRaisesRegex(ValueError, "Public download"):
                verify_downloads(directory, self.version, self.arch)


if __name__ == "__main__":
    unittest.main()
