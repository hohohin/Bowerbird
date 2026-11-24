#import "../macos/browser_overlay.m"
#include <assert.h>

@interface BBFlippedParent : NSView
@end
@implementation BBFlippedParent
- (BOOL)isFlipped { return YES; }
@end

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        for (Class parentClass in @[NSView.class, BBFlippedParent.class]) {
            NSView *parent = [[parentClass alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)];
            WKWebViewConfiguration *config = [WKWebViewConfiguration new];
            config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
            WKWebView *browser = [[WKWebView alloc] initWithFrame:parent.bounds configuration:config];
            [parent addSubview:browser];
            assert(bb_browser_overlay((__bridge void *)browser, 10, 30, 40, 80, 8));
            BBSourceBrowserOverlay *host = (BBSourceBrowserOverlay *)browser.superview;
            assert([host isKindOfClass:BBSourceBrowserOverlay.class]);
            assert(host.isFlipped == parent.isFlipped);
            assert(host.hole != nil && browser.layer.mask != nil);
            assert(bb_browser_overlay((__bridge void *)browser, 10, 30, 40, 80, 8));
            assert(browser.superview == host);
            assert(bb_browser_overlay((__bridge void *)browser, 0, 0, 0, 0, 0));
            assert(host.hole == nil && browser.layer.mask == nil);
        }
        puts("PASS Mac browser overlay: inherited coordinates, clipping and reuse");
    }
    return 0;
}
