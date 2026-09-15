"""Freeze one local project as the bundled lesson; the source database is read-only."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3

EXCLUDED_FILES = {*(f"preset-{n:02d}.webp" for n in range(1, 12)),
                  "preset-13.png", "preset-14.png", "asset-024.png", "asset-027.png"}


def prune_pack(manifest):
    """The approved v0915 selection; retain graph layout and hidden history."""
    tables = manifest["tables"]
    removed = [asset for asset in tables["assets"] if asset["store_path"] in EXCLUDED_FILES]
    removed_ids = {asset["id"] for asset in removed}
    removed_files = {asset[key] for asset in removed for key in ("store_path", "thumb_path") if asset[key]}
    tables["assets"] = [asset for asset in tables["assets"] if asset["id"] not in removed_ids]
    for table in ("project_assets", "analyses", "asset_colors"):
        tables[table] = [row for row in tables[table] if row["asset_id"] not in removed_ids]
    for node in tables["canvas_nodes"]:
        if node["asset_id"] in removed_ids:
            node["asset_id"] = None
    manifest["files"] = {name: digest for name, digest in manifest["files"].items() if name not in removed_files}
    manifest["revision"] = 2
    return removed_files


def export(database, project_name, output):
    output.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("BEGIN")  # One consistent snapshot, including WAL-backed edits.
    projects = db.execute("SELECT id FROM projects WHERE name=?", (project_name,)).fetchall()
    if len(projects) != 1:
        raise ValueError("Expected exactly one project with the requested name")
    project_id = projects[0]["id"]
    rows = {}
    for table in ("project_canvases", "creative_threads", "canvas_nodes", "canvas_groups",
                  "canvas_group_items", "canvas_edges", "canvas_views", "project_assets"):
        rows[table] = [dict(r) for r in db.execute(
            f"SELECT * FROM {table} WHERE project_id=? ORDER BY rowid", (project_id,))]
    for table in ("assets", "analyses", "asset_colors"):
        key = "id" if table == "assets" else "asset_id"
        rows[table] = [dict(r) for r in db.execute(
            f"SELECT * FROM {table} WHERE {key} IN "
            "(SELECT asset_id FROM project_assets WHERE project_id=?) ORDER BY rowid", (project_id,))]
    db.close()
    # Execution history and local layer-workspace paths are not portable canvas content.
    # Prompts/results remain in the canvas nodes; keep their reusable image analysis.
    rows["analyses"] = [r for r in rows["analyses"] if r["kind"] not in ("generation_meta", "layer_workspace")]

    ids = {project_id: "pack:project"}
    for table, records in rows.items():
        for index, row in enumerate(records):
            if "id" in row:
                ids[row["id"]] = f"pack:{table}:{index + 1:03d}"

    def remap(value):
        if isinstance(value, dict):
            return {k: remap(v) for k, v in value.items()}
        if isinstance(value, list):
            return [remap(v) for v in value]
        return ids.get(value, value) if isinstance(value, str) else value

    files = {}

    def copy_file(source, filename):
        source = Path(source)
        shutil.copyfile(source, output / filename)
        files[filename] = hashlib.sha256((output / filename).read_bytes()).hexdigest()
        return filename

    for index, asset in enumerate(rows["assets"]):
        original = Path(asset["store_path"])
        origin_name = re.split(r"[\\/]", asset["origin_path"] or "")[-1]
        filename = origin_name if re.fullmatch(r"preset-\d+\.(webp|png)", origin_name) else f"asset-{index + 1:03d}.{asset['ext']}"
        asset["store_path"] = copy_file(original, filename)
        asset["thumb_path"] = copy_file(asset["thumb_path"], f"thumb-{index + 1:03d}.jpg") if asset["thumb_path"] else None
        asset["origin_path"] = filename
        asset["generation_session_id"] = None
        asset["folder_id"] = None
        asset["source"] = "imported"
        asset["source_url"] = None
        asset["reference_count"] = 0
    for node in rows["canvas_nodes"]:
        payload = json.loads(node["payload_json"])
        # Preserve visible prompts and results, never resume the author's jobs/accounts.
        for key in ("execution", "provider_session_id", "job_id", "turn_key", "visual_profile"):
            if key in payload:
                payload[key] = None
        node["payload_json"] = json.dumps(remap(payload), ensure_ascii=False, separators=(",", ":"))
    for canvas in rows["project_canvases"]:
        canvas["draft_json"] = json.dumps(remap(json.loads(canvas["draft_json"])), ensure_ascii=False, separators=(",", ":"))
    for analysis in rows["analyses"]:
        analysis["provider"] = "bundled-example"
        if analysis["kind"] == "caption":
            payload = json.loads(analysis["payload"])
            payload["session_id"] = None
            analysis["payload"] = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    manifest = {"version": "v0915", "name": project_name, "files": files, "tables": remap(rows)}
    for filename in prune_pack(manifest):
        (output / filename).unlink()
    (output / "bowerbird-onboarding.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({table: len(records) for table, records in manifest["tables"].items()}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    parser.add_argument("project_name")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    export(args.database, args.project_name, args.output)
