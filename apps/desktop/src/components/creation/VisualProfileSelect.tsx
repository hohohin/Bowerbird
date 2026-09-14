import { Palette, Settings2 } from "lucide-react";
import { useEffect } from "react";
import { useStore } from "../../store";
import { beginOnboardingOperation } from "../../lib/onboardingStore";

export function VisualProfileSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const profiles = useStore((state) => state.visualProfiles).filter(
    (profile) => profile.status === "confirmed",
  );
  const folders = useStore((state) => state.folders).filter((folder) => !folder.kind || folder.kind === "folder");
  const openVisualProfile = useStore((state) => state.openVisualProfile);
  useEffect(() => { void useStore.getState().reloadVisualProfiles(); }, []);
  const selectedProfile = profiles.find((profile) => profile.id === value);
  return (
    <div className="flex min-w-0 items-center gap-1">
    <label
      className="flex h-7 items-center gap-1 rounded-[3px] border border-edge bg-panel2 px-2 text-[11px] text-muted"
      title={disabled
        ? "当前模式不支持选择品牌规范"
        : profiles.length === 0
          ? "请先打开集合，点击「视觉规范」并提炼保存。"
          : "选择已保存的品牌规范，任何创作都可复用；本次明确要求优先"}
    >
      <Palette size={12} className="shrink-0 text-accent" />
      <span className="shrink-0">品牌规范</span>
      <select
        aria-label="品牌视觉规范"
        value={selectedProfile?.id ?? ""}
        disabled={disabled || profiles.length === 0}
        onChange={(event) => {
          const selected = event.target.value;
          if (!selected || profiles.some((profile) => profile.id === selected)) {
            const completeLesson = beginOnboardingOperation("profile-select", useStore.getState().activeProjectId);
            onChange(selected || null);
            if (selected) completeLesson({ profileId: selected });
          }
        }}
        className="min-w-0 max-w-36 bg-transparent text-[11px] text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-60"
      >
        <option value="">{profiles.length === 0 ? "暂无规范" : "不使用"}</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name} · v{profile.version}
          </option>
        ))}
      </select>
    </label>
    {selectedProfile && <button type="button" disabled={disabled}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-edge text-muted hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-40"
      aria-label="管理当前品牌规范" title="查看当前选择的视觉规范"
      onClick={() => openVisualProfile({ id: selectedProfile.folderId, profileId: selectedProfile.id, name: folders.find((folder) => folder.id === selectedProfile.folderId)?.name ?? selectedProfile.name })}>
      <Settings2 size={13} />
    </button>}
    </div>
  );
}
