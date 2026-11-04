#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>
#include <stdbool.h>

// A transparent parent leaves the tab's mouse events to the main webview below.
@interface BBSourceBrowserOverlay : NSView
@property(nonatomic, weak) WKWebView *browser;
@property(nonatomic) NSRect hole;
@property(nonatomic) BOOL flipped;
@end

@implementation BBSourceBrowserOverlay
- (BOOL)isFlipped { return self.flipped; }
- (NSView *)hitTest:(NSPoint)point {
    NSPoint browserPoint = [self.browser convertPoint:point fromView:self.superview];
    if (NSPointInRect(browserPoint, self.hole)) return nil;
    NSView *hit = [super hitTest:point];
    return hit == self ? nil : hit;
}
@end

bool bb_browser_overlay(void *raw, double x, double y, double width, double height) {
    WKWebView *browser = (__bridge WKWebView *)raw;
    if (!browser.superview) return false;
    BBSourceBrowserOverlay *host;
    if ([browser.superview isKindOfClass:[BBSourceBrowserOverlay class]]) host = (BBSourceBrowserOverlay *)browser.superview;
    else {
        NSView *parent = browser.superview;
        host = [[BBSourceBrowserOverlay alloc] initWithFrame:parent.bounds];
        host.flipped = parent.isFlipped;
        host.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        NSRect frame = browser.frame;
        [browser removeFromSuperview];
        [parent addSubview:host]; [host addSubview:browser];
        browser.frame = frame; host.browser = browser;
    }
    host.hole = NSMakeRect(x, browser.isFlipped ? y : NSHeight(browser.bounds) - y - height, width, height);
    browser.wantsLayer = YES;
    if (width <= 0 || height <= 0) { browser.layer.mask = nil; return true; }
    CAShapeLayer *mask = [CAShapeLayer layer];
    mask.frame = browser.bounds; mask.geometryFlipped = browser.layer.geometryFlipped;
    CGMutablePathRef path = CGPathCreateMutable();
    CGPathAddRect(path, NULL, NSRectToCGRect(browser.bounds));
    CGPathAddRect(path, NULL, NSRectToCGRect(host.hole));
    mask.path = path; mask.fillRule = kCAFillRuleEvenOdd;
    CGPathRelease(path); browser.layer.mask = mask;
    return true;
}
