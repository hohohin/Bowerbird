# Native file drag spike

The small Rust crate includes the production Windows implementation directly from
`apps/desktop/src-tauri/src/external_drag.rs`. The Tauri example includes the same
module. Neither source duplicates originals or opens a user library.

## Repeatable checks

Run `cargo test --offline` in this directory for the continuation state,
preparation cancellation, Windows path spelling and real Shell CF_HDROP payload.
The synthetic Unicode/ASCII originals must remain byte-for-byte unchanged.

From `apps/desktop/src-tauri`, build `cargo build --offline --example native_file_drag_smoke`.
Set `BOWERBIRD_DRAG_TEST_ROOT` to an absolute directory containing a
`native-file-drag` path component, then launch the resulting example. It creates
only two synthetic files, an isolated WebView profile and `events.jsonl` there.

`Receiver.cs` is a separate Windows Forms process. Compile it with the installed
.NET Framework C# compiler, `/target:winexe`, and references to
`System.Windows.Forms.dll` and `System.Drawing.dll`. Pass the same test root as
its first argument. It records received paths in `receiver.txt`; it does not
copy, decode or upload file contents. The label and parent both accept FileDrop.
It uses a small topmost window so a bounded input driver can target a separate
process within the source window's screen rectangle.

The HTML source logs DOM drop filenames and retained module IDs before logging
native completion. A true native result alone is insufficient acceptance:
require either the intended DOM-drop record or the independent receiver log.

## Evidence from 2026-11-01

- Windows Shell CF_HDROP, canonical Unicode source paths, UNC spelling and source
  bytes: passed. Initial verbatim-path input produced E_INVALIDARG before the
  Windows Shell path adapter was added.
- Same-WebView pickup: real Computer Use click on pickup, then click the HTML
  target. Log order was `start`, `dom-drop` with both filenames and both retained
  IDs, then `complete` with `dropped: true`.
- Escape and right-button cancellation: real Computer Use inputs completed with
  `dropped: false`.
- Ordinary hold: a successful same-WebView sequence was already present when
  the test window was first captured; its input source was not established.
  Agent-generated fast drags completed after the physical button had been
  released and were correctly cancelled, so they are not acceptance of hold.
- Cross-process receiver: no receiving record established during the child
  agent run. The bounded input driver rejects window-external drag endpoints
  and activates each click's target window. Activating the receiver during an
  OLE pickup left the source pending until Escape; a topmost overlap experiment
  also did not establish receiver acceptance. Root agent owns further native
  validation. The user deferred manual validation and the two synthetic test
  windows have been closed. Do not describe this boundary as a verified native success or as
  proof that a human cross-application gesture fails.

Local run evidence: `.tmp/native-file-drag/run-20261101-1230/events.jsonl`.
The test source/receiver never targeted a chat account or an editing project.
