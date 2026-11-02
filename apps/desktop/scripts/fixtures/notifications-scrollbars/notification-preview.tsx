import { notifyGenerationComplete } from '../../../src/lib/generationNotifications';
import type { AppSettings } from '../../../src/lib/types';
export { ToastViewport as PreviewToastViewport } from '../../../src/components/ToastViewport';

let previewNoticeId = 0;

/** Isolated controls exercise the real completion producer and preferences. */
export function emitPreviewGenerationNotice({ key, message = '图片生成完成，已生成 2 张图片', projectName = '快速生成', onOpen = () => {}, settings }: {
  key?: string; message?: string; projectName?: string; onOpen?: () => void; settings?: Pick<AppSettings, 'generation_completion_popup' | 'generation_completion_sound'>;
} = {}) {
  return notifyGenerationComplete(key ?? `preview:${++previewNoticeId}`, message,
    (settings ?? { generation_completion_popup: true, generation_completion_sound: false }) as AppSettings,
    { projectName, onOpen });
}
