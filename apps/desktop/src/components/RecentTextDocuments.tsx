import { useEffect, useState } from 'react';
import { Check, Clock3, LoaderCircle } from 'lucide-react';
import { listRecentTextDocuments, type RecentTextSummary } from '../lib/recentTextDocuments';
import { userErrorMessage } from '../lib/userError';
import type { AutosaveStatus } from '../lib/textDocumentAutosave';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from './text-editor/plate/primitives/dropdown-menu';

const documentTitle = (item: RecentTextSummary) => item.title.trim() || '空白文档';
function useRecentDocuments(open: boolean, limit: number, beforeOpen: () => Promise<void>) {
  const [items, setItems] = useState<RecentTextSummary[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(''); setLoading(true);
    void beforeOpen().then(() => listRecentTextDocuments(limit)).then(entries => { if (live) setItems(entries); })
      .catch(reason => { if (live) setError(userErrorMessage(reason, '最近文档暂时无法读取，请重试。')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open, limit]);
  return { items, error, loading };
}
export function RecentTextDocuments({ currentId, disabled, beforeOpen, onChoose }: { currentId: string; disabled: boolean; beforeOpen(): Promise<void>; onChoose(id: string): void }) {
  const [open, setOpen] = useState(false), [limit, setLimit] = useState(50);
  const { items, error, loading } = useRecentDocuments(open, limit, beforeOpen);
  return <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
    <DropdownMenuTrigger asChild><button className="text-workspace-recent" aria-label="最近文档" title="最近文档" disabled={disabled}><Clock3 size={15}/><span>最近</span></button></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="text-workspace-recents">
      <DropdownMenuLabel>最近文档</DropdownMenuLabel>
      {error && <p role="alert">{error}</p>}
      {!error && !items.length && <p>{loading ? '正在读取…' : '暂无最近文档'}</p>}
      {items.map(item => <DropdownMenuItem key={item.id} onSelect={() => onChoose(item.id)} title={documentTitle(item)}>
        <span className="text-workspace-recent-title">{documentTitle(item)}</span>
        <time dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time>
        {item.id === currentId && <Check size={13}/>}
      </DropdownMenuItem>)}
      {items.length === limit && <DropdownMenuItem disabled={loading} onSelect={event => { event.preventDefault(); setLimit(value => value + 50); }}>显示更多</DropdownMenuItem>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function TextAutosaveStatus({ status }: { status: AutosaveStatus }) {
  const label = status === 'saved' ? '已自动保存到本机' : status === 'saving' ? '正在自动保存' : '自动保存失败';
  return <span className={`text-workspace-autosave is-${status}`} role="status" aria-label={label} title={label}>
    {status === 'saving' ? <LoaderCircle size={13}/> : status === 'saved' ? <Check size={13}/> : '!'}
  </span>;
}
