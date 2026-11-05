// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
import { BaseCaptionPlugin } from '@platejs/caption';
import {
  BaseAudioPlugin,
  BaseFilePlugin,
  BaseImagePlugin,
  BaseMediaEmbedPlugin,
  BasePlaceholderPlugin,
  BaseVideoPlugin,
} from '@platejs/media';
import { KEYS } from 'platejs';

import { AudioElementStatic } from '@/components/text-editor/plate/ui/media-audio-node-static';
import { FileElementStatic } from '@/components/text-editor/plate/ui/media-file-node-static';
import { ImageElementStatic } from '@/components/text-editor/plate/ui/media-image-node-static';
import { VideoElementStatic } from '@/components/text-editor/plate/ui/media-video-node-static';

export const BaseMediaKit = [
  BaseImagePlugin.withComponent(ImageElementStatic),
  BaseVideoPlugin.withComponent(VideoElementStatic),
  BaseAudioPlugin.withComponent(AudioElementStatic),
  BaseFilePlugin.withComponent(FileElementStatic),
  BaseCaptionPlugin.configure({
    options: {
      query: {
        allow: [KEYS.img, KEYS.video, KEYS.audio, KEYS.file, KEYS.mediaEmbed],
      },
    },
  }),
  BaseMediaEmbedPlugin,
  BasePlaceholderPlugin,
];
