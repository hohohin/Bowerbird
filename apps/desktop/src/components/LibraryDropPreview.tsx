import { useState } from "react";
import { FolderPlus, Image, MousePointer2, Tag } from "lucide-react";

export function LibraryDropPreview({ name, preview, count, target, collection }: {
  name: string; preview: string | null; count: number; target: string; collection: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  return <div className="library-drop-preview" role="status" aria-live="polite"
    aria-label={`${count > 1 ? `${count} 个素材` : name}，${collection ? "即将添加到集合" : "即将分类到"} ${target}，松开鼠标完成`}>
    <div className="library-drop-preview-image">
      {preview && failed !== preview ? <img src={preview} alt={name} draggable={false} onError={() => setFailed(preview)}/> : <Image size={32} aria-label={name}/>}
      {count > 1 && <span className="library-drop-preview-count">{count} 个素材</span>}
    </div>
    <div className="library-drop-preview-copy">
      <span className="library-drop-preview-label">{collection ? "即将添加到集合" : "即将分类到"}</span>
      <div className="library-drop-preview-target">
        {collection ? <FolderPlus size={16} aria-hidden="true"/> : <Tag size={16} aria-hidden="true"/>}
        <strong title={target}>{target}</strong>
      </div>
      <span className="library-drop-preview-hint"><MousePointer2 size={12} aria-hidden="true"/>松开鼠标完成</span>
    </div>
  </div>;
}
