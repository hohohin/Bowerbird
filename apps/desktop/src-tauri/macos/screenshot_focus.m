#import <AppKit/AppKit.h>
#include <stdbool.h>

// Called on the main thread; one focus handoff is shared by all capture displays.
static NSRunningApplication *BBPreviousCaptureApp;
static BOOL BBCaptureShowing;

void bb_screenshot_show(void *native_window, bool capture) {
    NSWindow *window = (__bridge NSWindow *)native_window;
    if (!capture) {
        // A new pin is a floating reference, not a request to open the main UI.
        [window orderFrontRegardless];
        return;
    }
    if (!BBCaptureShowing) {
        NSRunningApplication *previous = NSWorkspace.sharedWorkspace.frontmostApplication;
        BBPreviousCaptureApp = [previous isEqual:NSRunningApplication.currentApplication] ? nil : previous;
        BBCaptureShowing = YES;
    }
    // App activation raises both the native main and key windows. Make both the
    // capture window first, so the workspace window stays in its existing place.
    [window makeMainWindow];
    [window makeKeyAndOrderFront:nil];
    [NSRunningApplication.currentApplication activateWithOptions:NSApplicationActivateIgnoringOtherApps];
}

void bb_screenshot_finish(void) {
    NSRunningApplication *previous = BBPreviousCaptureApp;
    BBPreviousCaptureApp = nil;
    BBCaptureShowing = NO;
    // Do not steal focus if the user has already switched to a different app.
    if (!previous || previous.terminated || !NSApp.active) return;
    if (@available(macOS 14.0, *)) {
        [NSApp yieldActivationToApplication:previous];
        [previous activateFromApplication:NSRunningApplication.currentApplication options:0];
    } else {
        [previous activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    }
}
