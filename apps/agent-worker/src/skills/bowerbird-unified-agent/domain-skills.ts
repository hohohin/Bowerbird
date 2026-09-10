/** Model-facing methods, separate from the legacy Runner registry. */
export const UNIFIED_DOMAIN_SKILLS = [
  {
    id: "bowerbird-controlled-image-edit",
    description: "图片编辑中的主体保持、参考图职责与属性迁移方法。",
    file: "references/image-edit.md",
  },
  {
    id: "bowerbird-html-layout-render",
    description: "HTML/CSS 图文排版与离线截图方法。",
    file: "references/html-layout.md",
  },
  {
    id: "bowerbird-xiaohongshu",
    description: "小红书图文草稿的内容组织方法。",
    file: "references/xiaohongshu.md",
  },
] as const;

export function listUnifiedDomainSkills(): Array<{ id: string; description: string }> {
  return UNIFIED_DOMAIN_SKILLS.map(({ id, description }) => ({ id, description }));
}
