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
