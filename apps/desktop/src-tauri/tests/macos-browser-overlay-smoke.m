#import "../macos/browser_overlay.m"
#include <assert.h>
#include <stdio.h>

@interface BBFlippedParent : NSView
@end
@implementation BBFlippedParent
- (BOOL)isFlipped { return YES; }
@end

static void verify_point(BBSourceBrowserOverlay *host, WKWebView *browser, double x, double top, bool overHandle) {
    NSPoint point = NSMakePoint(x, browser.isFlipped ? top : NSHeight(browser.bounds) - top);
    CAShapeLayer *mask = (CAShapeLayer *)browser.layer.mask;
    assert([host.hole containsPoint:point] == overHandle);
    assert(CGPathContainsPoint(mask.path, NULL, NSPointToCGPoint(point), true) == !overHandle);

    NSPoint parentPoint = [browser convertPoint:point toView:host.superview];
    NSView *hit = [host hitTest:parentPoint];
    if (overHandle) assert(hit == nil);
    else assert(hit == browser || [hit isDescendantOf:browser]);
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        for (Class parentClass in @[NSView.class, BBFlippedParent.class]) {
            NSView *parent = [[parentClass alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)];
            WKWebViewConfiguration *config = [WKWebViewConfiguration new];
            config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
            WKWebView *browser = [[WKWebView alloc] initWithFrame:parent.bounds configuration:config];
            [parent addSubview:browser];
            assert(bb_browser_overlay((__bridge void *)browser, 360, 30, 40, 80, 8, false));
            BBSourceBrowserOverlay *host = (BBSourceBrowserOverlay *)browser.superview;
            assert([host isKindOfClass:BBSourceBrowserOverlay.class]);
            assert(host.isFlipped == parent.isFlipped);
            assert(host.hole != nil && browser.layer.mask != nil);
            verify_point(host, browser, 380, 70, true);
            verify_point(host, browser, 361, 31, false);
            verify_point(host, browser, 361, 109, false);

            assert(bb_browser_overlay((__bridge void *)browser, 0, 30, 40, 80, 8, true));
            assert(browser.superview == host);
            verify_point(host, browser, 20, 70, true);
            verify_point(host, browser, 39, 31, false);
            verify_point(host, browser, 39, 109, false);
            verify_point(host, browser, 1, 31, true);
            assert(bb_browser_overlay((__bridge void *)browser, 0, 0, 0, 0, 0, false));
            assert(host.hole == nil && browser.layer.mask == nil);
        }
        puts("PASS Mac browser overlay: inherited coordinates, mirrored clipping, hit testing and reuse");
    }
    return 0;
}
