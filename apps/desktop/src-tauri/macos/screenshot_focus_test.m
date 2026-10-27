// Standalone AppKit fixture: synthetic windows only; no Bowerbird startup,
// screen capture, clipboard access, or library files.
#import <Cocoa/Cocoa.h>
#include <stdbool.h>
#include <unistd.h>

extern void bb_screenshot_show(void *native_window, bool capture);
extern void bb_screenshot_finish(void);

// Tao allows its borderless windows to become both main and key.
@interface BBScreenshotTestWindow : NSWindow
@end
@implementation BBScreenshotTestWindow
- (BOOL)canBecomeMainWindow { return YES; }
- (BOOL)canBecomeKeyWindow { return YES; }
@end

static void require(BOOL condition, const char *message) {
    if (!condition) { fprintf(stderr, "FAIL %s\n", message); exit(1); }
}

static void pumpEvents(void) {
    NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
        untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]
        inMode:NSDefaultRunLoopMode dequeue:YES];
    if (event) [NSApp sendEvent:event];
    [NSApp updateWindows];
}

static BOOL waitFor(BOOL (^condition)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:3];
    while (!condition() && deadline.timeIntervalSinceNow > 0) {
        pumpEvents();
    }
    return condition();
}

static void settle(void) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:0.1];
    while (deadline.timeIntervalSinceNow > 0) pumpEvents();
}

static BBScreenshotTestWindow *window(NSString *title, NSWindowStyleMask style) {
    BBScreenshotTestWindow *result = [[BBScreenshotTestWindow alloc]
        initWithContentRect:NSMakeRect(20, 20, 80, 60)
        styleMask:style backing:NSBackingStoreBuffered defer:NO];
    result.title = title;
    result.releasedWhenClosed = NO;
    return result;
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSRunningApplication *previous = [NSWorkspace sharedWorkspace].frontmostApplication;
        BOOL hasPrevious = previous && previous.processIdentifier != getpid() && !previous.terminated;
        dispatch_async(dispatch_get_main_queue(), ^{
            BBScreenshotTestWindow *main = window(@"Screenshot fixture main",
                NSWindowStyleMaskTitled | NSWindowStyleMaskMiniaturizable);
            BBScreenshotTestWindow *snip = window(@"Screenshot fixture capture", NSWindowStyleMaskBorderless);
            BBScreenshotTestWindow *pin = window(@"Screenshot fixture pin", NSWindowStyleMaskBorderless);
            pin.level = NSFloatingWindowLevel;

            require(!main.visible, "main starts hidden");
            bb_screenshot_show((__bridge void *)snip, true);
            BOOL captureFocused = waitFor(^BOOL { return NSApp.active && snip.keyWindow && snip.mainWindow; });
            if (!captureFocused) fprintf(stderr, "capture state: active=%d visible=%d key=%d main=%d foreground=%s\n",
                NSApp.active, snip.visible, snip.keyWindow, snip.mainWindow,
                [NSWorkspace sharedWorkspace].frontmostApplication.localizedName.UTF8String);
            require(captureFocused,
                "capture is active and owns both native main and key roles");
            require(!main.visible && !main.miniaturized, "capture leaves hidden main hidden");

            bb_screenshot_show((__bridge void *)pin, false);
            settle();
            require(pin.visible && snip.keyWindow && snip.mainWindow,
                "pin appears without taking capture's main or key role");
            require(!main.visible, "pin leaves hidden main hidden");

            // Restore focus before hiding the last screenshot window.
            bb_screenshot_finish();
            [snip orderOut:nil];
            if (hasPrevious) {
                require(waitFor(^BOOL { return previous.active; }), "finish restores the preceding foreground app");
            }
            pid_t restoredPID = [NSWorkspace sharedWorkspace].frontmostApplication.processIdentifier;
            bb_screenshot_finish();
            settle();
            require([NSWorkspace sharedWorkspace].frontmostApplication.processIdentifier == restoredPID,
                "finish consumes the session exactly once");
            require(!main.visible, "finish does not show hidden main");
            printf("PASS hidden main, capture main/key roles, pin focus, finish%s and idempotence\n",
                hasPrevious ? " foreground restoration" : " (no preceding app available)");

            [pin orderOut:nil];
            [main makeKeyAndOrderFront:nil];
            [main miniaturize:nil];
            require(waitFor(^BOOL { return main.miniaturized; }), "main fixture can be minimized");
            bb_screenshot_show((__bridge void *)snip, true);
            require(waitFor(^BOOL { return NSApp.active && snip.keyWindow && snip.mainWindow; }),
                "a reused capture again becomes native main/key");
            require(main.miniaturized, "capture does not restore minimized main");
            bb_screenshot_finish();
            [snip orderOut:nil];
            if (hasPrevious) require(waitFor(^BOOL { return previous.active; }), "reused capture restores foreground app");
            require(main.miniaturized, "finish leaves main minimized");
            printf("PASS reused capture preserves minimized main\n");

            NSWindow *keyBeforePin = NSApp.keyWindow;
            NSWindow *mainBeforePin = NSApp.mainWindow;
            pid_t foregroundBeforePin = [NSWorkspace sharedWorkspace].frontmostApplication.processIdentifier;
            bb_screenshot_show((__bridge void *)pin, false);
            settle();
            require(pin.visible && NSApp.keyWindow == keyBeforePin && NSApp.mainWindow == mainBeforePin,
                "standalone pin preserves main and key roles");
            require([NSWorkspace sharedWorkspace].frontmostApplication.processIdentifier == foregroundBeforePin,
                "standalone pin does not activate the application");
            require(main.miniaturized, "standalone pin leaves main minimized");
            printf("PASS standalone pin does not steal foreground focus\n");

            // Starting from an already-focused pin must not expose the main UI.
            [pin makeKeyAndOrderFront:nil];
            [NSRunningApplication.currentApplication activateWithOptions:NSApplicationActivateIgnoringOtherApps];
            require(waitFor(^BOOL { return NSApp.active && pin.keyWindow; }), "pin fixture becomes active");
            bb_screenshot_show((__bridge void *)snip, true);
            require(waitFor(^BOOL { return snip.keyWindow && snip.mainWindow; }), "capture works within the active app");
            bb_screenshot_finish();
            [snip orderOut:nil];
            settle();
            require(NSApp.active && main.miniaturized, "same-app capture leaves minimized main unchanged");
            printf("PASS capture from an active pin preserves minimized main\n");

            [pin close]; [snip close]; [main close];
            fflush(stdout);
            exit(0);
        });
        [NSApp run];
    }
    return 1;
}
