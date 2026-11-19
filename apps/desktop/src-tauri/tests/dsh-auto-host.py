"""Run native DSH smoke tests with an existing install and with an empty private install.

Pass the path of the desktop Rust lib test binary. On Windows use a copy with
the Common Controls v6 manifest, as for other desktop native tests.
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlsplit


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def handle(self):
        try:
            super().handle()
        except ConnectionResetError:
            # Stopping the real host closes idle keep-alive sockets on Windows.
            pass

    def json_response(self, data, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def platform(self, data):
        self.json_response({"code": 0, "data": {"biz_code": 0, "biz_data": data}})

    def do_GET(self):
        if self.path == "/fixture/callback":
            init = self.server.authorization
            assert urlsplit(init["redirect_uri"]).hostname == "127.0.0.1"
            self.json_response({"url": init["redirect_uri"] + "?" + urlencode(
                {"state": init["state"], "code": "fixture-approved"})})
        elif self.path == "/auth-api/v0/users/current":
            assert self.headers.get("x-dsh-auth-token") == "fixture-account"
            self.platform({"id": "fixture", "email": "fixture@example.invalid"})
        elif urlsplit(self.path).path == "/models":
            self.json_response({"data": [{"id": "deepseek-v4-pro", "output_modalities": ["text"],
                                         "api_capabilities": {"anthropic_messages": {}}}]})
        else:
            self.send_error(404)

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.endswith("/dsh/auth_init"):
            self.server.authorization = request
            self.platform({"authorize_id": "fixture", "expires_in": 180,
                           "authorize_url": "https://platform.deepseek.com/dsh/authorize?fixture=1"})
            return
        if self.path.endswith("/dsh/auth_exchange"):
            assert request["code"] == "fixture-approved"
            challenge = hashlib.sha256(request["code_verifier"].encode()).digest()
            assert base64.urlsafe_b64encode(challenge).decode().rstrip("=") == self.server.authorization["code_challenge"]
            self.server.exchanges += 1
            self.platform({"token": "fixture-account", "authorized_url": "https://platform.deepseek.com/dsh/authorized"})
            return
        if self.path.endswith("/get_unnotified_bonuses"):
            self.platform([])
            return
        if not urlsplit(self.path).path.endswith("/messages"):
            self.send_error(404)
            return
        if self.server.account:
            assert self.headers.get("x-dsh-auth-token") == "fixture-account"
            self.server.account_messages += 1
        tool_names = {t["name"] for t in request.get("tools", [])}
        card_tool = "create_canvas_cards" in tool_names
        if self.server.questions:
            self.question_response(request, tool_names)
            return
        if card_tool:
            self.server.tool_requests += 1
        if card_tool and self.server.tool_requests == 1:
            assert tool_names == {"create_canvas_cards", "skill", "ask_user_question"}, tool_names
            messages = json.dumps(request["messages"], ensure_ascii=False)
            assert "<skill_content" in messages and "Orchid-731" in messages
            block = {"type": "tool_use", "id": "original-1", "name": "create_canvas_cards", "input": {}}
            delta = {"type": "input_json_delta", "partial_json":
                     '{"cards":[{"id":"c1","kind":"content","title":"Orchid-731","text":"Hello"}]}}'}
            stop = "tool_use"
        else:
            block = {"type": "text", "text": ""}
            delta = {"type": "text_delta", "text": "done"}
            stop = "end_turn"
        self.stream(block, delta, stop)

    def question_response(self, request, tool_names):
        if not tool_names:
            self.stream({"type": "text", "text": ""}, {"type": "text_delta", "text": "Fixture title"}, "end_turn")
            return
        messages = json.dumps(request["messages"], ensure_ascii=False)
        tools = {tool["name"]: tool for tool in request["tools"]}
        assert tool_names == {"create_canvas_cards", "skill", "ask_user_question"}, tool_names
        assert "timeout" in tools["ask_user_question"]["input_schema"]["properties"]
        assert sum(message["role"] == "user" and "Bowerbird question fixture" in json.dumps(message)
                   for message in request["messages"]) == 1
        if any(message["role"] == "user" and "亲子家庭" in json.dumps(message, ensure_ascii=False)
               for message in request["messages"]):
            self.server.question_finishes += 1
            self.stream({"type": "text", "text": ""}, {"type": "text_delta", "text": "FINAL_AFTER_ANSWER"}, "end_turn")
            return
        deadline = "with deadline" in messages
        if deadline and any(message["role"] == "user" and "pending" in json.dumps(message)
                            for message in request["messages"]):
            self.stream({"type": "text", "text": ""}, {"type": "text_delta", "text": "PREMATURE_OUTPUT"}, "end_turn")
            return
        if "fixture-card-created" in messages:
            arguments = {"questions": [{"id": "audience", "question": "这张海报面向谁？",
                                       "options": [{"label": "亲子家庭"}, {"label": "年轻影迷"}]}]}
            if deadline:
                arguments["timeout"] = 2
            name, call = "ask_user_question", "audience-call"
            self.server.question_calls += 1
        else:
            arguments = {"cards": [{"id": "fixture", "kind": "content", "title": "fixture", "text": "prepared"}]}
            name, call = "create_canvas_cards", "content-call"
        self.stream({"type": "tool_use", "id": call, "name": name, "input": {}},
                    {"type": "input_json_delta", "partial_json": json.dumps(arguments)}, "tool_use")

    def stream(self, block, delta, stop):
        events = [
            ("message_start", {"message": {"usage": {"input_tokens": 3}}}),
            ("content_block_start", {"index": 0, "content_block": block}),
            ("content_block_delta", {"index": 0, "delta": delta}),
            ("content_block_stop", {"index": 0}),
            ("message_delta", {"delta": {"stop_reason": stop}, "usage": {"output_tokens": 4}}),
            ("message_stop", {}),
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for event, fields in events:
            data = json.dumps({"type": event, **fields})
            self.wfile.write(f"event: {event}\ndata: {data}\n\n".encode())


def run(binary, account, questions=False):
    with tempfile.TemporaryDirectory(prefix="bowerbird-dsh-auto-") as directory:
        root = Path(directory).resolve()
        skill = root / "agents" / "skills" / "fixture-card" / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("---\nname: fixture-card\ndescription: Name the fixture card.\n---\n"
                         "Use Orchid-731 as the card title.\n", encoding="utf-8")
        with ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
            server.tool_requests = 0
            server.account, server.exchanges, server.account_messages = account, 0, 0
            server.questions, server.question_calls, server.question_finishes = questions, 0, 0
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                env = dict(os.environ, APPDATA=str(root / "app"), HOME=str(root),
                           XDG_DATA_HOME=str(root / "data"), DSH_HOME=str(root / "dsh"), DSH_AGENTS_HOME=str(root / "agents"),
                           BOWERBIRD_DSH_AUTO_FIXTURE=str(root), DEEPSEEK_API_KEY="fixture",
                           DSH_TELEMETRY_DISABLED="1", DEEPSEEK_BASE_URL=f"http://127.0.0.1:{server.server_port}")
                if account:
                    # The real DSH plugin sees its official origins. Only this isolated test
                    # process redirects its platform/model fetches to the loopback fixture.
                    preload = Path(__file__).resolve().with_name("dsh-account-fixture.cjs")
                    env["NODE_OPTIONS"] = f'--require "{preload.as_posix()}"'
                    env["BOWERBIRD_DSH_TEST_PRIVATE_INSTALL"] = "1"
                    env["BOWERBIRD_DSH_ACCOUNT_FIXTURE"] = env.pop("DEEPSEEK_BASE_URL")
                    env.pop("DEEPSEEK_API_KEY")
                test = "dsh_native_question_survives_host_crash" if questions else "dsh_auto_installed_host_creates_one_card_call"
                subprocess.run([str(binary), test, "--nocapture",
                                "--ignored", "--test-threads=1"], cwd=root, env=env,
                               check=True, timeout=1200 if account else 180)
                if questions:
                    assert (server.question_calls, server.question_finishes) == (3, 3)
                else:
                    assert server.tool_requests == 2, server.tool_requests
                if account:
                    assert server.exchanges == 1 and server.account_messages >= 2
            finally:
                server.shutdown()


if __name__ == "__main__":
    binary = Path(sys.argv[1]).resolve(strict=True)
    if "--questions" in sys.argv[2:]:
        run(binary, False, questions=True)
    else:
        run(binary, False)
        run(binary, True)
