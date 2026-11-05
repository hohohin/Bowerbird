import { createContext, useContext } from 'react';
import { PlateElement, type PlateElementProps } from 'platejs/react';
import type { TMediaElement } from 'platejs';
import type { DocumentMedia } from '../../lib/documentTypes';
import { AudioWaveform } from '../AudioWaveform';
import { ImageElement } from './plate/ui/media-image-node';
import { AudioElement } from './plate/ui/media-audio-node';
import { VideoElement } from './plate/ui/media-video-node';

export const TextMediaContext = createContext<DocumentMedia[]>([]);
function LinkedAudio({ media, ...props }: PlateElementProps<TMediaElement> & { media: DocumentMedia }) {
  const { element, editor, children } = props;
  const caption = typeof element.caption === 'string' ? element.caption : Array.isArray(element.caption) ? element.caption.map(node => node.text).join('') : '';
  return <PlateElement {...props}><figure contentEditable={false}><AudioWaveform assetId={media.asset.id} path={media.path} name={media.asset.name} version={media.asset.file_mtime ?? 0} duration={media.asset.duration}/><input aria-label="素材说明" placeholder="添加说明…" value={caption} onChange={event => { const at = editor.api.findPath(element); if (at) editor.tf.setNodes({ caption: [{ text: event.target.value }] }, { at }); }}/></figure>{children}</PlateElement>;
}
export function TextMediaElement(props: PlateElementProps<TMediaElement>) {
  const { element, children } = props;
  const media = useContext(TextMediaContext).find(item => item.asset.id === element.assetId);
  if (element.assetId && !media) return <PlateElement {...props}><div contentEditable={false} className="text-document-missing">素材未连接，请重新插入原文件。</div>{children}</PlateElement>;
  if (media?.kind === 'audio') return <LinkedAudio {...props} media={media}/>;
  // Plate locates nodes by identity. TextPlateEditor hydrates URLs on the actual node.
  if (element.type === 'img') return <ImageElement {...props}/>;
  if (element.type === 'audio') return <AudioElement {...props}/>;
  return <VideoElement {...props}/>;
}
