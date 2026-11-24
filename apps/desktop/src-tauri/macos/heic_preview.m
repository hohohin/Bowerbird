#import <CoreImage/CoreImage.h>
#import <Foundation/Foundation.h>

static CIContext *previewContext(void) {
    static CIContext *ctx;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ ctx = [CIContext contextWithOptions:nil]; });
    return ctx;
}

static NSURL *fileURL(const char *path) {
    return [NSURL fileURLWithFileSystemRepresentation:path isDirectory:NO relativeToURL:nil];
}

// Input dimensions have already been validated by the bounded HEIF decoder.
bool bb_heic_color_png(const uint8_t *bytes, size_t length, const char *destination,
                       uint32_t width, uint32_t height) {
    @autoreleasepool {
        NSData *data = [NSData dataWithBytes:bytes length:length];
        NSMutableDictionary *opts = [@{kCIImageApplyOrientationProperty: @YES} mutableCopy];
        if (@available(macOS 11, *)) opts[kCIImageToneMapHDRtoSDR] = @YES;
        CIImage *image = [CIImage imageWithData:data options:opts];
        if (!image || image.extent.size.width != width || image.extent.size.height != height) return false;
        CGColorSpaceRef space = image.colorSpace;
        BOOL keep = space && CGColorSpaceGetModel(space) == kCGColorSpaceModelRGB;
        if (@available(macOS 10.15, *)) keep = keep && !CGColorSpaceIsHDR(space);
        CGColorSpaceRef output = keep ? CGColorSpaceRetain(space) : CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        // The compatibility image carries pixels and their color profile, without source EXIF/GPS.
        image = [image imageBySettingProperties:@{}];
        BOOL ok = [previewContext() writePNGRepresentationOfImage:image toURL:fileURL(destination)
            format:kCIFormatRGBA8 colorSpace:output options:@{} error:NULL];
        CGColorSpaceRelease(output);
        return ok;
    }
}

bool bb_heic_srgb_thumbnail(const char *png, const char *destination, uint32_t maxSize) {
    @autoreleasepool {
        CIImage *image = [CIImage imageWithContentsOfURL:fileURL(png)];
        if (!image || CGRectIsEmpty(image.extent)) return false;
        CGFloat scale = MIN(1.0, maxSize / MAX(image.extent.size.width, image.extent.size.height));
        if (scale < 1.0) {
            image = [image imageByApplyingFilter:@"CILanczosScaleTransform"
                withInputParameters:@{kCIInputScaleKey:@(scale), kCIInputAspectRatioKey:@1}];
        }
        CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        BOOL ok = [previewContext() writeJPEGRepresentationOfImage:image toURL:fileURL(destination)
            colorSpace:srgb options:@{} error:NULL];
        CGColorSpaceRelease(srgb);
        return ok;
    }
}
