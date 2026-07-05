import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { AssetPrompt } from "../lib/types";

/** 单资产的提示词映射编辑器（绑定 role=main/ref/desc）。 */
export function PromptEditor({ assetId }: { assetId: string }) {
  const [items, setItems] = useState<AssetPrompt[]>([]);
  const [body, setBody] = useState("");
  const [role, setRole] = useState("main");

  async function reload() {
    try {
      setItems(await api.listPromptsByAsset(assetId));
    } catch (e) {
      console.error(e);
    }
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  async function add() {
    if (!body.trim()) return;
    const id = await api.createPrompt(body, undefined, "manual");
    await api.linkPrompt(assetId, id, role);
    setBody("");
    await reload();
  }

  async function remove(promptId: string) {
    await api.unlinkPrompt(assetId, promptId);
    await api.deletePrompt(promptId);
    await reload();
  }

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">提示词映射</div>
      <div className="space-y-2">
        {items.map(({ prompt, role: r }) => (
          <div key={prompt.id} className="rounded bg-panel2 p-2 text-xs">
            <div className="mb-1 flex items-center justify-between">
              <span className="rounded bg-edge px-1.5 py-0.5 text-[10px] uppercase">
                {r}
              </span>
              <button
                onClick={() => remove(prompt.id)}
                className="text-muted hover:text-ink"
              >
                删除
              </button>
            </div>
            <div className="whitespace-pre-wrap text-ink">{prompt.body}</div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="text-xs text-muted">暂无提示词 —— 给这张图绑定 role=main 后，多选时会被聚合进创作包</div>
        )}
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="输入提示词正文…"
        className="h-24 w-full rounded bg-panel2 p-2 text-sm text-ink outline-none ring-1 ring-edge focus:ring-accent"
      />
      <div className="flex items-center gap-2">
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded bg-panel2 px-2 py-1 text-xs"
        >
          <option value="main">main（主提示词）</option>
          <option value="ref">ref（参考）</option>
          <option value="desc">desc（描述）</option>
        </select>
        <button
          onClick={add}
          className="rounded bg-accent px-3 py-1 text-xs font-medium text-black"
        >
          添加
        </button>
      </div>
    </div>
  );
}
