import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FilePlus2, FolderDown, Loader2, Plus } from "lucide-react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { notifyError, notifySuccess } from "../lib/notify";
import { ModalShell } from "./ModalShell";

const MENU_WIDTH = 200;
// 两项菜单估算高度，用于视口边缘钳制。
const MENU_HEIGHT = 92;

/** 侧栏「项目」区的新建入口：点 + 不再直接弹系统文件夹框，而是先弹菜单——「新建空白
 *  项目」过命名窗建无文件夹项目（kind="blank"，素材之后导入/生成攒），「导入已有文件夹」
 *  走原选文件夹建项+全量导入流程。菜单与命名窗都是本地状态（单一入口，不进 store）。
 *  tour：菜单打开广播 new-project-menu（step 1→2 锚定菜单讲两种方式）；选完文件夹广播
 *  project-import-started（step 2 脚注切「正在导入…」）。 */
export function NewProjectMenu() {
  const reloadProjects = useStore((s) => s.reloadProjects);
  const enterProject = useStore((s) => s.enterProject);
  const [creating, setCreating] = useState(false);
  // 菜单锚点：+ 按钮左下角；null = 关闭。
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 菜单打开时：点外关闭、Esc 关闭、首项聚焦（同项目右键菜单）。
  useEffect(() => {
    if (!menu) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenu(null);
    }
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // 命名窗每次打开重置默认名并聚焦全选（直接输入替换）。
  useEffect(() => {
    if (!naming) return;
    setName("未命名项目");
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [naming]);

  // 菜单打开广播（tour step 1→2：引导从「点 +」推进到锚定菜单、讲两种创建方式）。
  useEffect(() => {
    if (menu) window.dispatchEvent(new CustomEvent("bowerbird://new-project-menu"));
  }, [menu]);

  async function importFolder() {
    // tour 引导期（step 1/2 都可能，开菜单即推进到 2）：默认定位到预设图目录的上一级
    // （已释放到文档目录），让用户点进「初始引导」。
    const tourActive = useStore.getState().tourActive;
    const tourStep = useStore.getState().tourStep;
    let defaultPath: string | undefined;
    if (tourActive && (tourStep === 1 || tourStep === 2)) {
      try {
        defaultPath = await api.releasePresetPack();
      } catch {
        /* 释放失败用系统默认路径 */
      }
    }
    const path = await api.pickFolder(defaultPath);
    if (!path) return;
    // 用户已点 OS「选择文件夹」→ 广播导入开始（tour step 2 脚注切「正在导入…」；
    // step 1→2 的推进已在菜单打开时广播，此处不再 setTourStep）。
    if (useStore.getState().tourActive) {
      window.dispatchEvent(new CustomEvent("bowerbird://project-import-started"));
    }
    setCreating(true);
    try {
      const result = await api.createProject(path);
      await reloadProjects();
      await enterProject(result.project.id);
      notifySuccess(`项目已创建，导入 ${result.imported_count} 张素材`);
      // 导入成功 → 标记完成，让「导入中」步骤的【下一步】按钮出现。
      if (useStore.getState().tourActive && useStore.getState().tourStep === 2) {
        useStore.getState().setTourImported(true);
      }
    } catch (error) {
      notifyError(error, "创建项目失败");
    } finally {
      setCreating(false);
    }
  }

  const trimmed = name.trim();

  async function createBlank() {
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const result = await api.createBlankProject(trimmed);
      await reloadProjects();
      await enterProject(result.project.id);
      notifySuccess("项目已创建，可导入素材或直接开始生成");
      setNaming(false);
    } catch (error) {
      // 失败不关窗，用户可改名重试或取消。
      notifyError(error, "创建项目失败");
    } finally {
      setCreating(false);
    }
  }

  // 菜单定位：锚在 + 按钮下方，超右/下边缘时收进来。
  const x = menu ? Math.max(4, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8)) : 0;
  const y = menu ? Math.max(4, Math.min(menu.y, window.innerHeight - MENU_HEIGHT - 8)) : 0;

  return (
    <>
      <button
        data-tour="new-project"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
        disabled={creating}
        className="rounded px-1 text-cold hover:opacity-80 disabled:opacity-50"
        title={creating ? "创建中…" : "新建项目"}
        aria-label="新建项目"
        aria-haspopup="menu"
      >
        {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
      </button>

      {menu &&
        createPortal(
          // zIndex 80：盖过 tour spotlight(70)/气泡(71)，引导期菜单不被遮暗、不被气泡挡住。
          <div
            id="new-project-menu"
            ref={menuRef}
            style={{ position: "fixed", left: x, top: y, width: MENU_WIDTH, zIndex: 80 }}
            onContextMenu={(e) => e.preventDefault()}
            className="app-context-menu p-1.5 text-xs"
            role="menu"
            aria-label="新建项目"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                setNaming(true);
              }}
              className="app-context-item px-2 py-1.5"
              title="创建空项目，之后再导入素材或生成图片"
            >
              <FilePlus2 size={13} className="shrink-0" />
              新建空白项目
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                void importFolder();
              }}
              className="app-context-item px-2 py-1.5"
              title="选择文件夹，导入其中图片并建立项目"
            >
              <FolderDown size={13} className="shrink-0" />
              导入已有文件夹
            </button>
          </div>,
          document.body,
        )}

      {naming && (
        <ModalShell
          title="新建空白项目"
          eyebrow="New project"
          description="空白项目不关联本地文件夹，之后可在项目内导入素材或直接生成图片。"
          onClose={() => setNaming(false)}
          preventClose={creating}
          footer={
            <>
              <button onClick={() => setNaming(false)} disabled={creating} className="app-modal-button">
                取消
              </button>
              <button
                onClick={() => void createBlank()}
                disabled={!trimmed || creating}
                className="app-modal-button is-primary"
              >
                {creating && <span className="app-spinner" aria-hidden />}
                {creating ? "创建中…" : "创建项目"}
              </button>
            </>
          }
        >
          <label className="block text-[11px] font-medium text-muted" htmlFor="new-project-name-input">
            项目名称
          </label>
          <input
            id="new-project-name-input"
            ref={inputRef}
            data-modal-autofocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createBlank();
            }}
            maxLength={64}
            placeholder="输入项目名称"
            className="app-form-input mt-2 px-3 text-sm"
          />
          <div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-faint">
            <span>最多 64 个字符</span>
            <span>{name.length}/64</span>
          </div>
        </ModalShell>
      )}
    </>
  );
}
