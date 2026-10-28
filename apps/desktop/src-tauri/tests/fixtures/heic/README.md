# HEIC fixtures

`rgb-strips-96.heic` (96 × 32 RGB strips) and `checker-1024.heic`
(1024 × 1024, four grid tiles) are synthetic images from
[heic-rs](https://github.com/tbraun96/heic-rs/tree/999470f514c8e9a1a7c37ea44ba70cc32b1308fe/tests/fixtures),
revision `999470f514c8e9a1a7c37ea44ba70cc32b1308fe` (0.1.4).
Upstream generated PNG pixels and encoded them with macOS `sips`; no user photos.
Used under the included MIT license. Tests run offline without system codecs.

The orientation test changes the existing `irot` property to 90° counterclockwise;
it does not rotate the coded pixels, so it exercises actual display metadata.
