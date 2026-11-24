# Video metadata fixtures

Synthetic red video (and generated sine audio), no user media. Created with FFmpeg
for offline tests; running the Rust tests does not require FFmpeg/ffprobe.

```sh
ffmpeg -f lavfi -i 'color=c=red:s=320x240:r=25' -t 0.4 -c:v libx264 -pix_fmt yuv420p -movflags empty_moov+frag_keyframe fragmented.mp4
ffmpeg -f lavfi -i 'color=c=red:s=320x240:r=25' -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 1.2 -c:v libx264 -g 5 -pix_fmt yuv420p -c:a aac -movflags empty_moov+frag_keyframe fragmented-audio.mp4
```

The first fixture has a 0.08s presentation offset but 0.4s duration. Windows Media
Foundation on the test machine reports only 0.08s, so fragmented files must use
their sample timing. The second has multiple audio/video fragments and 1.28s
container duration (including encoder timing), verified independently with ffprobe.

## Audio waveform fixtures

`audio-preview-{wav,mp3,flac,m4a,ogg}` are 0.2-second, 440 Hz mono sine waves,
created for `media::audio::tests::audio_verified_codecs_decode_without_external_tools`.
They contain no recorded or user audio. The Rust test reads these small fixtures
directly and verifies decoded duration (allowing codec padding) and nonzero peaks;
FFmpeg is only needed to regenerate them.

Generated with FFmpeg 7.1 from the macOS ARM64 `imageio-ffmpeg 0.6.0` wheel.
Run in this directory:

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=44100:duration=0.2' -ac 1 -c:a pcm_s16le audio-preview-wav.wav
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=44100:duration=0.2' -ac 1 -c:a libmp3lame -b:a 64k audio-preview-mp3.mp3
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=44100:duration=0.2' -ac 1 -c:a flac audio-preview-flac.flac
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=44100:duration=0.2' -ac 1 -c:a aac -b:a 64k audio-preview-m4a.m4a
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=44100:duration=0.2' -ac 1 -c:a libvorbis -q:a 3 audio-preview-ogg.ogg
```
