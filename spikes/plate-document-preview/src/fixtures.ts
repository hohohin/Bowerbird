import flowers from '../../../apps/desktop/src-tauri/resources/samples/preset-07.webp';
import portrait from '../../../apps/desktop/src-tauri/resources/samples/preset-08.webp';
import texture from '../../../apps/desktop/src-tauri/resources/samples/preset-06.webp';
import video from '../../../apps/desktop/src-tauri/tests/fixtures/media/fragmented-audio.mp4';
import type { DocumentValue, PreviewAsset } from './domain';

export const initialAssets: PreviewAsset[] = [
  { id: 'flowers', name: '花间 · 构图参考.webp', kind: 'image', url: flowers },
  { id: 'portrait', name: '人物 · 光线参考.webp', kind: 'image', url: portrait },
  { id: 'texture', name: '印刷 · 颗粒质感.webp', kind: 'image', url: texture },
  { id: 'video-demo', name: '视频播放测试.mp4', kind: 'video', url: video, duration: 1.28 },
  { id: 'audio-demo', name: '节奏参考.wav', kind: 'audio', url: '/pulse.wav', duration: 8 },
];

export interface PreviewDocument {
  id: string;
  name: string;
  kind: 'markdown' | 'text';
  revision: number;
  savedRevision: number;
  value: DocumentValue;
}

export const initialDocuments: PreviewDocument[] = [
  {
    id: 'flower-brief', name: '花间 · 短片提案.md', kind: 'markdown', revision: 1, savedRevision: 1,
    value: [
      { id: 'title', type: 'h1', children: [{ text: '让花，成为风。' }] },
      { id: 'intro', type: 'p', children: [{ text: '为秋日服装系列制作一支 15 秒短片。以人物与花朵的关系展开，让静止的构图慢慢生长出动作。' }] },
      { id: 'visual-heading', type: 'h2', children: [{ text: '视觉方向' }] },
      { id: 'visual-copy', type: 'p', children: [{ text: '保留黑白人物和大面积留白，让红色只出现在花瓣上。参考下图的空间关系，不添加额外装饰。' }] },
      { id: 'flower-image', type: 'img', assetId: 'flowers', url: flowers, caption: '构图参考：人物居中，花朵从画面边缘进入。', children: [{ text: '' }] },
      { id: 'rhythm-heading', type: 'h2', children: [{ text: '节奏与声音' }] },
      { id: 'rhythm-copy', type: 'p', children: [{ text: '开场保留呼吸感，随后缓慢推进。结尾停留在人物与花瓣的特写。' }] },
      { id: 'rhythm-audio', type: 'audio', assetId: 'audio-demo', url: '/pulse.wav', caption: '节奏参考 · 合成音频样例', children: [{ text: '' }] },
      { id: 'video-heading', type: 'h2', children: [{ text: '视频参考' }] },
      { id: 'video-sample', type: 'video', assetId: 'video-demo', url: video, caption: '用于验证文档内的视频播放；可替换为自己的参考视频。', children: [{ text: '' }] },
      { id: 'result-heading', type: 'h2', children: [{ text: '输出要求' }] },
      { id: 'result', type: 'p', listStyleType: 'disc', indent: 1, children: [{ text: '竖版 9:16，保留人物面部与服装细节。' }] },
      { id: 'result2', type: 'p', listStyleType: 'disc', indent: 1, children: [{ text: '先整理分镜，再准备画面与镜头。' }] },
    ],
  },
  {
    id: 'portrait-notes', name: '人物光线笔记.md', kind: 'markdown', revision: 1, savedRevision: 1,
    value: [
      { id: 'note-title', type: 'h1', children: [{ text: '人物光线笔记' }] },
      { id: 'note-text', type: 'p', children: [{ text: '自然窗光从画面左侧进入，保留皮肤细节和黑色衣料层次。' }] },
      { id: 'portrait-image', type: 'img', assetId: 'portrait', url: portrait, caption: '人物与光线参考', children: [{ text: '' }] },
    ],
  },
  {
    id: 'plain-notes', name: '随手记.txt', kind: 'text', revision: 1, savedRevision: 1,
    value: [{ id: 'plain', type: 'p', children: [{ text: '花瓣慢慢经过镜头。\n人物保持安静，光线从侧面进入。\n结尾留出呼吸。' }] }],
  },
];
