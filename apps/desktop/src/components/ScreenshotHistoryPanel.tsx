import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, Pin, Save, Trash2 } from 'lucide-react';
import { ModalShell } from './ModalShell';
import { userErrorMessage } from '../lib/userError';
import './ScreenshotHistoryPanel.css';

type HistoryEntry = { id: string; created_at: string; width: number; height: number; bytes: number };

function HistoryImage({ id, full = false }: { id: string; full?: boolean }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false, objectUrl = '';
    void invoke<ArrayBuffer | number[]>('screenshot_history_image', { id, thumbnail: !full }).then(bytes => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(new Blob([bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)], { type: 'image/png' }));
      setUrl(objectUrl);
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, full]);
  return url ? <img src={url} alt="历史截图预览" /> : <span>{failed ? '预览不可用' : '正在加载…'}</span>;
}

export function ScreenshotHistoryPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const fullView = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const selectedEntry = entries.find(entry => entry.id === selected);
  useEffect(() => { if (selected) fullView.current?.querySelector('button')?.focus(); }, [selected]);
  useEffect(() => {
    if (document.activeElement === document.body) content.current?.focus();
  }, [selected, entries, confirmClear]);
  useEffect(() => {
    let disposed = false;
    void invoke<HistoryEntry[]>('screenshot_history_list').then(rows => { if (!disposed) setEntries(rows); })
      .catch(e => { if (!disposed) setError(userErrorMessage(e, '暂时无法读取截图历史，请关闭后重试。')); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, []);
  async function perform(command: string, args?: Record<string, unknown>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    try {
      await invoke(command, args);
      if (command === 'screenshot_history_delete') { setEntries(rows => rows.filter(row => row.id !== args?.id)); setSelected(null); }
      if (command === 'screenshot_history_clear') { setEntries([]); setConfirmClear(false); setSelected(null); }
    } catch (e) { setError(userErrorMessage(e, '操作未完成，请重试。')); }
    finally { running.current = false; setBusy(false); }
  }
  return <ModalShell title="历史截图" width="lg" className="screenshot-history-modal" onClose={onClose} preventClose={busy}
    panelProps={{ onKeyDownCapture: event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!running.current) onClose(); }
      if (!busy && selected && ['ArrowLeft', 'ArrowRight', ',', '.'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const next = entries.findIndex(entry => entry.id === selected) + (event.key === 'ArrowLeft' || event.key === ',' ? -1 : 1);
        if (entries[next]) setSelected(entries[next].id);
      }
    } }}
    headerActions={<button type="button" disabled={busy || !entries.length} onClick={() => setConfirmClear(true)}>清空历史</button>}>
    <div ref={content} tabIndex={-1} className="screenshot-history-content">
    {confirmClear && <div className="screenshot-history-confirm"><span>清空截图历史？已入库的素材会保留。</span><button disabled={busy} onClick={() => void perform('screenshot_history_clear')}>确认清空</button><button disabled={busy} onClick={() => setConfirmClear(false)}>取消</button></div>}
    {error && <p role="alert" className="screenshot-history-error">{error}</p>}
    {selectedEntry && <div className="screenshot-history-full" ref={fullView}>
      <div className="screenshot-history-actions"><button onClick={() => setSelected(null)}>返回列表</button><span>{entries.findIndex(entry => entry.id === selected) + 1} / {entries.length}</span></div>
      <div className="screenshot-history-full-image"><HistoryImage key={selectedEntry.id} id={selectedEntry.id} full /></div>
      <div className="screenshot-history-actions">{([['copy', '复制', Copy], ['save', '保存', Save], ['pin', '钉住', Pin]] as const).map(([action, label, Icon]) => <button key={action} disabled={busy} onClick={() => void perform('screenshot_history_output', { id: selectedEntry.id, action })}><Icon size={14} aria-hidden="true" />{label}</button>)}</div>
    </div>}
    {loading ? <p className="screenshot-history-empty" role="status">正在读取…</p> : !entries.length ? <p className="screenshot-history-empty">{error ? '截图历史暂时不可用' : '暂无历史截图'}</p> : !selectedEntry && <div className="screenshot-history-grid">
      {entries.map(entry => <article key={entry.id} className="screenshot-history-card">
        <button type="button" className="screenshot-history-preview" aria-label="查看这张历史截图" onClick={() => setSelected(entry.id)}><HistoryImage id={entry.id} /></button>
        <div className="screenshot-history-meta"><time dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time><span>{entry.width} × {entry.height}</span></div>
        <div className="screenshot-history-actions">
          {([['copy', '复制', Copy], ['save', '保存', Save], ['pin', '钉住', Pin]] as const).map(([action, label, Icon]) => <button key={action} disabled={busy} onClick={() => void perform('screenshot_history_output', { id: entry.id, action })}><Icon size={14} aria-hidden="true" />{label}</button>)}
          <button aria-label="删除这张历史截图" title="删除这张历史截图" disabled={busy} onClick={() => void perform('screenshot_history_delete', { id: entry.id })}><Trash2 size={14} aria-hidden="true" /></button>
        </div>
      </article>)}
    </div>}
    </div>
  </ModalShell>;
}
