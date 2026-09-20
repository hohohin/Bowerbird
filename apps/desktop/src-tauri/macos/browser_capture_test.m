// Standalone hidden WKWebView fixture; never initializes Bowerbird or its library.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
extern void bb_browser_capture(void *, const char *, void *, void (*)(void *, const unsigned char *, size_t, const char *));

@interface BBFixture : NSObject <WKNavigationDelegate>
@property WKWebView *webview;
@property NSString *pageBase;
@property NSString *imageBase;
@property NSData *expected;
@property NSArray *cases;
@property NSUInteger index;
- (void)next;
@end

static BBFixture *fixture;
static void received(void *context, const unsigned char *bytes, size_t length, const char *error) {
    BBFixture *test = (__bridge BBFixture *)context;
    NSDictionary *entry = test.cases[test.index];
    NSString *expectedError = entry[@"error"];
    BOOL ok = expectedError ? (error && [[NSString stringWithUTF8String:error] containsString:expectedError])
        : (!error && [[NSData dataWithBytes:bytes length:length] isEqualToData:test.expected]);
    if (!ok) { fprintf(stderr, "FAIL %s: %s (%zu bytes)\n", [entry[@"path"] UTF8String], error ?: "unexpected bytes", length); exit(1); }
    printf("PASS %s\n", [entry[@"path"] UTF8String]); fflush(stdout);
    test.index++;
    // Allow asynchronous native cancellation and temporary file removal to finish.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_MSEC * 100), dispatch_get_main_queue(), ^{ [test next]; });
}

@implementation BBFixture
- (void)next {
    if (self.index == self.cases.count) {
        [self.webview evaluateJavaScript:@"document.querySelector('input').value + ':' + window.marker" completionHandler:^(id result, NSError *error) {
            if (error || ![result isEqual:@"keep:unchanged"]) exit(2);
            printf("PASS page, form and JS state preserved\n"); fflush(stdout); exit(0);
        }];
        return;
    }
    NSString *url = [self.imageBase stringByAppendingString:self.cases[self.index][@"path"]];
    bb_browser_capture((__bridge void *)self.webview, url.UTF8String, (__bridge void *)self, received);
}
- (void)webView:(WKWebView *)webview didFinishNavigation:(WKNavigation *)navigation { [self next]; }
- (void)webView:(WKWebView *)webview didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    fprintf(stderr, "Page load failed: %s\n", error.localizedDescription.UTF8String); exit(3);
}
@end

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 4) return 4;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        fixture = [BBFixture new];
        fixture.pageBase = [NSString stringWithUTF8String:argv[1]];
        fixture.imageBase = [NSString stringWithUTF8String:argv[2]];
        fixture.expected = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[3]]];
        fixture.cases = @[
            @{@"path": @"/image"}, @{@"path": @"/redirect"}, @{@"path": @"/chunked"},
            @{@"path": @"/unauthorized", @"error": @"HTTP 401"},
            @{@"path": @"/html", @"error": @"网页"},
            @{@"path": @"/oversize", @"error": @"50 MiB"},
            @{@"path": @"/large-chunked", @"error": @"50 MiB"},
            @{@"path": @"/disconnect", @"error": @"无法读取"},
            @{@"path": @"/slow", @"error": @"超时"}
        ];
        WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
        configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
        fixture.webview = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 800, 600) configuration:configuration];
        fixture.webview.navigationDelegate = fixture;
        [fixture.webview loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:[fixture.pageBase stringByAppendingString:@"/page"]]]];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 75 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ fprintf(stderr, "Fixture timeout\n"); exit(5); });
        [NSApp run];
    }
}
