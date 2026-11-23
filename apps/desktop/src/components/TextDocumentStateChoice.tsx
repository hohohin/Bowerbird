interface Props {
  saving: boolean;
  onOpenLatest(): void;
  onSaveDraft(): void;
}

export function TextDocumentStateChoice({ saving, onOpenLatest, onSaveDraft }: Props) {
  return <section className="text-document-state-choice" aria-label="正文已在外部修改">
    <p role="alert">正文已在外部修改。原有的评论、修订、样式和绘图可另存为工作区草稿。</p>
    <div className="text-document-toolbar">
      <button disabled={saving} onClick={onOpenLatest}>按最新正文打开</button>
      <button disabled={saving} onClick={onSaveDraft}>{saving ? '正在另存草稿…' : '保留原富状态另存草稿'}</button>
    </div>
  </section>;
}
