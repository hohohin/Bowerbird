#import <AppKit/AppKit.h>
#include <stdbool.h>
#include <string.h>

typedef void (*BBFileDragCallback)(void *, bool, const char *);
typedef bool (*BBFileDragBeforeStart)(void *);

@interface BBFileDragSource : NSObject <NSDraggingSource>
@property(nonatomic) BBFileDragCallback callback;
@property(nonatomic) void *context;
@property(nonatomic) BOOL finished;
- (void)finish:(BOOL)dropped error:(NSString *)error;
@end

// AppKit permits one interactive drag at a time. All access is on its main thread.
// Retain the source ourselves until AppKit delivers the terminal callback.
static BBFileDragSource *BBActiveFileDrag;

@implementation BBFileDragSource
- (void)finish:(BOOL)dropped error:(NSString *)error {
    if (self.finished) return;
    self.finished = YES;
    BBFileDragCallback callback = self.callback;
    void *context = self.context;
    self.callback = NULL;
    self.context = NULL;
    if (BBActiveFileDrag == self) BBActiveFileDrag = nil;
    callback(context, dropped, error.UTF8String);
}

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
    (void)session;
    (void)context;
    return NSDragOperationCopy;
}

- (BOOL)ignoreModifierKeysForDraggingSession:(NSDraggingSession *)session {
    (void)session;
    return YES;
}

- (void)draggingSession:(NSDraggingSession *)session endedAtPoint:(NSPoint)point
    operation:(NSDragOperation)operation {
    (void)session;
    (void)point;
    [self finish:(operation & NSDragOperationCopy) != 0 error:nil];
}
@end

// The caller transfers context to this function. It is returned exactly once
// through callback, synchronously on failure or when the native drag ends.
// paths are borrowed only for this call; NSURL/NSString own their copies.
void bb_start_file_drag(void *rawWindow, const char *const *paths, size_t count,
    bool pickup, const unsigned char *pixels, size_t width, size_t height, double scale, void *context, BBFileDragBeforeStart beforeStart, BBFileDragCallback callback) {
    if (!callback) return;
    if (![NSThread isMainThread]) {
        callback(context, false, "无法开始拖动，请重试。");
        return;
    }
    if (BBActiveFileDrag) {
        callback(context, false, "请先完成当前拖动。");
        return;
    }
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    NSView *view = window.contentView;
    if (!view || !paths || count == 0) {
        callback(context, false, "无法开始拖动，请重新选择素材。");
        return;
    }
    BBFileDragSource *source = nil;
    @try {
        NSPoint windowPoint = window.mouseLocationOutsideOfEventStream;
        NSPoint viewPoint = [view convertPoint:windowPoint fromView:nil];
        NSMutableArray<NSDraggingItem *> *items = [NSMutableArray arrayWithCapacity:count];
        // Rust supplies bounded cached pixels; AppKit copies them before this call returns.
        NSImage *thumbnail = nil;
        if (pixels && width > 0 && height > 0 && width <= 432 && height <= 540 && scale >= 1 && scale <= 3) {
            NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
                pixelsWide:width pixelsHigh:height bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES
                isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bitmapFormat:NSBitmapFormatAlphaNonpremultiplied
                bytesPerRow:width * 4 bitsPerPixel:32];
            if (rep.bitmapData) {
                memcpy(rep.bitmapData, pixels, width * height * 4);
                thumbnail = [[NSImage alloc] initWithSize:NSMakeSize(width / scale, height / scale)];
                [thumbnail addRepresentation:rep];
            }
        }
        // Unsupported media/missing cache keeps the existing system icon.
        NSImage *icon = [NSImage imageNamed:NSImageNameMultipleDocuments];
        for (size_t index = 0; index < count; index++) {
            NSString *path = paths[index] ? [NSString stringWithUTF8String:paths[index]] : nil;
            if (!path.isAbsolutePath) {
                callback(context, false, "无法读取素材位置，请重新连接原文件。");
                return;
            }
            NSURL *url = [NSURL fileURLWithPath:path isDirectory:NO];
            NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:url];
            NSImage *contents = index == 0 && thumbnail ? thumbnail : icon;
            NSSize size = index == 0 && thumbnail ? thumbnail.size : NSMakeSize(48, 48);
            CGFloat y = view.isFlipped ? viewPoint.y + 18 : viewPoint.y - 18 - size.height;
            [item setDraggingFrame:NSMakeRect(viewPoint.x + 18, y, size.width, size.height) contents:contents];
            [items addObject:item];
        }

        // Like drag-rs, supply a local event object; never post global mouse events.
        // pickup intentionally does not require a held button. AppKit's behavior
        // after a menu mouse-up, including next-click delivery, is NOT Mac-tested.
        // Starting a session must not be reported as a successful drop.
        NSEvent *event = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged
            location:windowPoint modifierFlags:0 timestamp:NSApp.currentEvent.timestamp
            windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
        if (!event) {
            callback(context, false, "无法开始拖动，请重试。");
            return;
        }
        source = [BBFileDragSource new];
        source.callback = callback;
        source.context = context;
        BBActiveFileDrag = source;
        // A cancelled preparation stays cancelled even if a later mouse gesture
        // has already begun. The gate only borrows context; finish owns release.
        if (!beforeStart(context)) {
            [source finish:NO error:nil];
            return;
        }
        // Preparation/IPC may outlive a quick gesture. Recheck immediately before
        // handing control to AppKit so hold cannot turn into an unintended pickup.
        if (!pickup && ([NSEvent pressedMouseButtons] & 1) == 0) {
            [source finish:NO error:nil];
            return;
        }
        NSDraggingSession *session = [view beginDraggingSessionWithItems:items event:event source:source];
        if (!session) {
            [source finish:NO error:@"无法开始拖动，请重试。"];
            return;
        }
        session.animatesToStartingPositionsOnCancelOrFail = YES;
        if (count > 1) session.draggingFormation = NSDraggingFormationPile;
    } @catch (NSException *exception) {
        NSLog(@"Bowerbird external drag: %@", exception);
        if (source) [source finish:NO error:@"无法开始拖动，请重试。"];
        else callback(context, false, "无法开始拖动，请重试。");
    }
}
