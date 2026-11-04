#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>
#include <stdbool.h>

// A transparent parent leaves the tab's mouse events to the main webview below.
@interface BBSourceBrowserOverlay : NSView
@property(nonatomic, weak) WKWebView *browser;
@property(nonatomic, strong) NSBezierPath *hole;
@property(nonatomic) BOOL flipped;
@end

@implementation BBSourceBrowserOverlay
- (BOOL)isFlipped { return self.flipped; }
- (NSView *)hitTest:(NSPoint)point {
    NSPoint browserPoint = [self.browser convertPoint:point fromView:self.superview];
    if ([self.hole containsPoint:browserPoint]) return nil;
    NSView *hit = [super hitTest:point];
    return hit == self ? nil : hit;
}
@end

bool bb_browser_overlay(void *raw, double x, double y, double width, double height, double cut) {
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
    browser.wantsLayer = YES;
    if (width <= 0 || height <= 0) { host.hole = nil; browser.layer.mask = nil; return true; }
    CGPoint points[] = {{x+cut,y},{x+width,y},{x+width,y+height},{x+cut,y+height},{x,y+height-cut},{x,y+cut}};
    host.hole = [NSBezierPath bezierPath];
    for (int i = 0; i < 6; i++) {
        if (!browser.isFlipped) points[i].y = NSHeight(browser.bounds) - points[i].y;
        if (i == 0) [host.hole moveToPoint:NSPointFromCGPoint(points[i])];
        else [host.hole lineToPoint:NSPointFromCGPoint(points[i])];
    }
    [host.hole closePath];
    CAShapeLayer *mask = [CAShapeLayer layer];
    mask.frame = browser.bounds; mask.geometryFlipped = browser.layer.geometryFlipped;
    CGMutablePathRef path = CGPathCreateMutable();
    CGPathAddRect(path, NULL, NSRectToCGRect(browser.bounds));
    CGPathAddLines(path, NULL, points, 6); CGPathCloseSubpath(path);
    mask.path = path; mask.fillRule = kCAFillRuleEvenOdd;
    CGPathRelease(path); browser.layer.mask = mask;
    return true;
}
