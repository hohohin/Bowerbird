#import <AVFoundation/AVFoundation.h>
#import <ImageIO/ImageIO.h>
#include <math.h>
#include <stdint.h>

static int read_video_metadata(AVURLAsset *asset, uint32_t *width, uint32_t *height, double *duration);

// Called only in the disposable --video-thumbnail-worker process, never in Tauri/WebKit.
int bowerbird_video_thumbnail(const char *source, const char *destination, unsigned size,
                              uint32_t *width, uint32_t *height, double *duration) {
    @autoreleasepool {
        NSURL *input = [NSURL fileURLWithPath:[NSString stringWithUTF8String:source]];
        NSURL *output = [NSURL fileURLWithPath:[NSString stringWithUTF8String:destination]];
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:input options:duration ? @{AVURLAssetPreferPreciseDurationAndTimingKey: @YES} : nil];
        AVAssetImageGenerator *generator = [[AVAssetImageGenerator alloc] initWithAsset:asset];
        generator.appliesPreferredTrackTransform = YES;
        generator.maximumSize = CGSizeMake(size, size);
        for (NSNumber *seconds in @[@1, @0]) {
            NSError *error = nil;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
            CGImageRef frame = [generator copyCGImageAtTime:CMTimeMakeWithSeconds(seconds.doubleValue, 600) actualTime:NULL error:&error];
#pragma clang diagnostic pop
            if (!frame) continue;
            CGImageDestinationRef writer = CGImageDestinationCreateWithURL((__bridge CFURLRef)output, CFSTR("public.jpeg"), 1, NULL);
            BOOL saved = NO;
            if (writer) {
                CGImageDestinationAddImage(writer, frame, (__bridge CFDictionaryRef)@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @0.85});
                saved = CGImageDestinationFinalize(writer);
                CFRelease(writer);
            }
            CGImageRelease(frame);
            if (saved) {
                if (duration) read_video_metadata(asset, width, height, duration);
                return 0;
            }
        }
        return 1;
    }
}

// Synchronous property loading is confined to the disposable, time-limited worker.
static int read_video_metadata(AVURLAsset *asset, uint32_t *width, uint32_t *height, double *duration) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        AVAssetTrack *track = [[asset tracksWithMediaType:AVMediaTypeVideo] firstObject];
        if (!track) return 1;
        CGRect display = CGRectApplyAffineTransform((CGRect){CGPointZero, track.naturalSize}, track.preferredTransform);
        double w = fabs(display.size.width), h = fabs(display.size.height);
        *duration = CMTimeGetSeconds(asset.duration);
#pragma clang diagnostic pop
        if (!isfinite(w) || !isfinite(h) || w < 1 || h < 1 || w > UINT32_MAX || h > UINT32_MAX) return 1;
        *width = (uint32_t)llround(w); *height = (uint32_t)llround(h);
        return 0;
}

int bowerbird_video_probe(const char *source, uint32_t *width, uint32_t *height, double *duration) {
    @autoreleasepool {
        NSURL *input = [NSURL fileURLWithPath:[NSString stringWithUTF8String:source]];
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:input options:@{AVURLAssetPreferPreciseDurationAndTimingKey: @YES}];
        return read_video_metadata(asset, width, height, duration);
    }
}
