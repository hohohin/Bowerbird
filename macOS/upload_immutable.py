"""Stage a frozen Mac release on TOS. The website switches its own channel later."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit


def check_live(arch, version):
    if arch not in ("aarch64", "x86_64") or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Invalid release architecture or version")
    channel = f"darwin-{arch}"
    data = subprocess.check_output([
        "curl", "--proto", "=https", "--proto-redir", "=https", "-fsSL", "--max-time", "30",
        f"https://bowerbird.cn/api/desktop-update/{channel}",
    ])
    live = json.loads(data)
    current = live["version"]
    info = live["platforms"][channel]
    if (not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", current)
            or not isinstance(info, dict) or not str(info.get("url", "")).startswith("https://")
            or not isinstance(info.get("signature"), str) or not info["signature"].strip()):
        raise ValueError("Cannot establish current version for " + channel)
    if tuple(map(int, version.split("."))) <= tuple(map(int, current.split("."))):
        raise ValueError(f"Release {version} must exceed live {channel} {current}")


def sha256(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def upload(client, bucket, directory, version, arch):
    import tos

    tar = f"Bowerbird_{version}_{arch}.app.tar.gz"
    dmg = f"Bowerbird_{version}_{arch}-updater-installer.dmg"
    manifest = f"darwin-{arch}.json"
    names = [tar, tar + ".sig", tar + ".sha256", dmg, dmg + ".sha256", manifest]
    # SHA256SUMS is emitted only after the complete signing and notarization gate.
    frozen = dict(line.split("  ", 1)[::-1] for line in
                  (directory / "SHA256SUMS").read_text(encoding="utf-8").splitlines())
    if set(frozen) != set(names):
        raise ValueError("Frozen file list differs from expected Mac release")
    for name in names:
        with (directory / name).open("rb") as file:
            if sha256(file) != frozen[name]:
                raise ValueError("Frozen release changed: " + name)
    # Enabled and Suspended buckets ignore x-tos-forbid-overwrite.
    if client.get_bucket_version(bucket).status is not None:
        raise ValueError("TOS create-only staging requires a never-versioned bucket")
    for name in names:
        remote = f"darwin-{arch}-{version}.json" if name == manifest else name
        key = "mac_package/" + remote
        try:
            with (directory / name).open("rb") as file:
                client.put_object(bucket, key, content=file, forbid_overwrite=True,
                                  acl=tos.ACLType.ACL_Public_Read, meta={"sha256": frozen[name]},
                                  content_type="application/json" if name == manifest else "application/octet-stream",
                                  cache_control="public, max-age=31536000, immutable")
        except tos.exceptions.TosServerError as exc:
            if exc.status_code != 409:
                raise
        if sha256(client.get_object(bucket, key)) != frozen[name]:
            raise ValueError("Immutable object SHA-256 mismatch: " + key)
        print(f"{frozen[name]}  {key}", flush=True)


def verify_downloads(directory, version, arch):
    import requests

    info = json.loads((directory / f"darwin-{arch}.json").read_text(encoding="utf-8"))
    tar_url = info["platforms"][f"darwin-{arch}"]["url"]
    parsed = urlsplit(tar_url)
    tar = f"Bowerbird_{version}_{arch}.app.tar.gz"
    if parsed.scheme != "https" or parsed.path.split("/")[-1] != tar or parsed.query or parsed.fragment:
        raise ValueError("Unexpected download URL in the frozen manifest")
    base = tar_url.rsplit("/", 1)[0]
    for name in (tar, f"Bowerbird_{version}_{arch}-updater-installer.dmg"):
        with (directory / name).open("rb") as file:
            expected = sha256(file)
        with requests.get(f"{base}/{name}", stream=True, timeout=(15, 120)) as response:
            response.raise_for_status()
            if sha256(response.raw) != expected:
                raise ValueError("Public download SHA-256 mismatch: " + name)
        print(f"{expected}  {base}/{name}", flush=True)


if __name__ == "__main__":
    mode, arch, version = sys.argv[1:4]
    check_live(arch, version)
    if mode == "upload" and len(sys.argv) == 5:
        import tos
        config = {}
        env_file = Path(__file__).resolve().parent.parent / ".env.tos"
        if env_file.exists():
            for line in env_file.read_text(encoding="utf-8-sig").splitlines():
                key, sep, value = line.strip().partition("=")
                if sep and key.startswith("TOS_"):
                    config[key] = value.strip().strip("'").strip('"')
        config.update(os.environ)
        client = tos.TosClientV2(config["TOS_ACCESS_KEY_ID"], config["TOS_SECRET_ACCESS_KEY"],
                                 config["TOS_ENDPOINT"], config["TOS_REGION"])
        try:
            upload(client, config["TOS_BUCKET"], Path(sys.argv[4]), version, arch)
            verify_downloads(Path(sys.argv[4]), version, arch)
        finally:
            client.close()
    elif mode != "check-live" or len(sys.argv) != 4:
        raise SystemExit("Usage: upload_immutable.py check-live|upload <arch> <version> [frozen-dir]")
