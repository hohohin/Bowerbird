#import <AVFoundation/AVFoundation.h>
#import <ImageIO/ImageIO.h>

// Called only in the disposable --video-thumbnail-worker process, never in Tauri/WebKit.
int bowerbird_video_thumbnail(const char *source, const char *destination, unsigned size) {
    @autoreleasepool {
        NSURL *input = [NSURL fileURLWithPath:[NSString stringWithUTF8String:source]];
        NSURL *output = [NSURL fileURLWithPath:[NSString stringWithUTF8String:destination]];
        AVAssetImageGenerator *generator = [[AVAssetImageGenerator alloc] initWithAsset:[AVURLAsset URLAssetWithURL:input options:nil]];
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
            if (saved) return 0;
        }
        return 1;
    }
}
