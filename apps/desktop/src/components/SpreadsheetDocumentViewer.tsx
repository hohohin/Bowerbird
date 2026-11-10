import { useEffect, useState } from 'react';
import { Plus, RotateCcw } from 'lucide-react';
import type { Asset } from '../lib/types';
import { readSpreadsheet, type SpreadsheetDocument } from '../lib/spreadsheetDocuments';
import { addMaterialAssets } from '../lib/materialActions';
import { userErrorMessage } from '../lib/userError';
import { useStore } from '../store';
import { notifyError } from '../lib/notify';
import './TextDocumentEditor.css';
import './SpreadsheetDocumentViewer.css';

export function SpreadsheetDocumentViewer({ asset, onNavigate }: { asset: Asset; onNavigate(): void }) {
  const [document, setDocument] = useState<SpreadsheetDocument>();
  const [sheet, setSheet] = useState(0), [revision, setRevision] = useState(0);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const projectId = useStore(state => state.activeProjectId);
  useEffect(() => {
    let alive = true; setDocument(undefined); setError(''); setSheet(0);
    void readSpreadsheet(asset.id).then(result => { if (alive) setDocument(result); })
      .catch(error => { if (alive) setError(userErrorMessage(error, '表格暂时无法打开，请检查文件后重试')); });
    return () => { alive = false; };
  }, [asset.id, revision]);
  async function add() {
    if (!document || !projectId || busy) return;
    setBusy(true); setError('');
    try { await addMaterialAssets([asset], projectId, onNavigate, undefined, document.sheets[sheet].name); }
    catch (error) { notifyError(error, '表格未能添加到画板，请重试'); }
    finally { setBusy(false); }
  }
  return <section className="text-document-editor spreadsheet-document" data-spreadsheet-document onKeyDown={event => event.stopPropagation()}>
    <div className="text-document-toolbar">
      <div className="spreadsheet-tabs" role="tablist" aria-label="工作表">
        {document?.sheets.map((item, index) => <button key={item.name} role="tab" aria-selected={index === sheet} onClick={() => setSheet(index)}>{item.name}</button>)}
      </div>
      <button aria-label="重新读取原文件" title="重新读取原文件" onClick={() => setRevision(value => value + 1)}><RotateCcw size={14}/></button>
      {projectId && <button disabled={!document || busy} onClick={() => void add()}><Plus size={14}/>添加当前工作表到画板</button>}
    </div>
    {error && <div className="text-document-error" role="alert">{error}</div>}
    {!document ? <div className="text-document-loading">{error ? '' : '正在读取表格…'}</div> : <div className="spreadsheet-scroll" role="tabpanel" tabIndex={0}>
      <table aria-label={document.sheets[sheet].name}><tbody>{document.sheets[sheet].rows.map((row, r) => <tr key={r}>{row.map((value, c) => <td key={c}>{value}</td>)}</tr>)}</tbody></table>
    </div>}
  </section>;
}
