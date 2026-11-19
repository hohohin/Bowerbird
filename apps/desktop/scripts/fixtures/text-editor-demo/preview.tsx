import { createRoot } from 'react-dom/client';
import { Plate, usePlateEditor } from 'platejs/react';
import { EditorKit } from '../../../src/components/text-editor/plate/components/editor/editor-kit';
import { Editor, EditorContainer } from '../../../src/components/text-editor/plate/ui/editor';
import { TooltipProvider } from '../../../src/components/text-editor/plate/primitives/tooltip';
import { TextEditorServices } from '../../../src/components/text-editor/TextEditorServices';
import '../../../src/styles.css';
import '../../../src/components/IndustrialTheme.css';
import '../../../src/components/text-editor/plate/utilities.css';
function App() {
  const editor = usePlateEditor({ plugins: EditorKit, value: [{ type: 'p', id: 'first', children: [{ text: '' }] }] });
  return <div className="text-plate-ui" style={{ height: '100vh', background: 'var(--bb-surface)', color: 'var(--bb-ink)' }}><TooltipProvider><TextEditorServices><Plate editor={editor} onValueChange={({ value }) => { (window as any).value = value; }}><EditorContainer><Editor aria-label="文档正文" /></EditorContainer></Plate></TextEditorServices></TooltipProvider></div>;
}
document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')!).render(<App/>);
