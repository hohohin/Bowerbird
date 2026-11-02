import React from 'react';
import { createRoot } from 'react-dom/client';
import '../home-navigation/fixture';
import { Toolbar } from '../../../src/components/Toolbar';
import { useLocalFileMode } from '../../../src/lib/localFileMode';
import '../../../src/styles.css';
import '../../../src/components/LocalFileWorkspace.css';
import '../../../src/components/IndustrialTheme.css';

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
const Home = React.lazy(async () => {
  const module = new URLSearchParams(location.search).has('live')
    ? await import('../../../src/components/LibraryHome') : await import('./LibraryHomePreview');
  return { default: module.LibraryHome };
});
// The preview uses registered synthetic assets only. No native/user library access.
useLocalFileMode.setState({ mode: 'all', views: { global: 'all', project: 'all' } });
createRoot(document.getElementById('root')!).render(<div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
  <Toolbar localFilesOpen canvasMode={false} onCanvasModeChange={() => {}} onRefresh={async () => {}} onCreateCreative={() => {}}/>
  <div style={{ flex: 1, minHeight: 0, display: 'flex' }}><React.Suspense fallback={null}><Home/></React.Suspense></div>
</div>);
