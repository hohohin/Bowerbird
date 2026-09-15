#import <WebKit/WebKit.h>

typedef void (*BBCaptureCallback)(void *, const unsigned char *, size_t, const char *);
static const NSUInteger BBMaxImageBytes = 50 * 1024 * 1024;

// All state is confined to WebKit's main queue. No cookie extraction or page IPC.
API_AVAILABLE(macos(11.3))
@interface BBCapture : NSObject <WKDownloadDelegate>
@property(nonatomic, strong) WKDownload *download;
@property(nonatomic, strong) NSURL *directory;
@property(nonatomic, strong) NSURL *file;
@property(nonatomic, strong) NSUUID *identifier;
@property(nonatomic, strong) dispatch_source_t timer;
@property(nonatomic) BBCaptureCallback callback;
@property(nonatomic) void *context;
@property(nonatomic) BOOL finished;
- (void)finish:(NSString *)error;
@end

static NSMutableDictionary *BBActiveCaptures;

@implementation BBCapture
- (unsigned long long)fileSize {
    return self.file ? [[[NSFileManager defaultManager] attributesOfItemAtPath:self.file.path error:nil][NSFileSize] unsignedLongLongValue] : 0;
}
- (void)cleanup {
    if (self.directory) [[NSFileManager defaultManager] removeItemAtURL:self.directory error:nil];
    [BBActiveCaptures removeObjectForKey:self.identifier];
}

- (void)finish:(NSString *)error {
    if (self.finished) return;
    self.finished = YES;
    if (self.timer) { dispatch_source_cancel(self.timer); self.timer = nil; }
    NSData *bytes = nil;
    if (!error) {
        if ([self fileSize] > BBMaxImageBytes) error = @"图片超过 50 MiB 上限";
        else {
            bytes = [NSData dataWithContentsOfURL:self.file options:NSDataReadingMappedIfSafe error:nil];
            if (!bytes.length) error = @"网站返回了空图片";
        }
    }
    self.callback(self.context, bytes.bytes, bytes.length, error.UTF8String);
    if (error && self.download) {
        [self.download cancel:^(NSData *resumeData) { (void)resumeData; [self cleanup]; }];
    } else [self cleanup];
}

- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response
    suggestedFilename:(NSString *)name completionHandler:(void (^)(NSURL *))completion {
    if (self.finished) { completion(nil); return; }
    NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 0;
    NSString *error = nil;
    if (status < 200 || status >= 300) error = [NSString stringWithFormat:@"网站未允许读取图片（HTTP %ld），请确认已登录或刷新网页", (long)status];
    else if (response.expectedContentLength > (long long)BBMaxImageBytes) error = @"图片超过 50 MiB 上限";
    else if ([response.MIMEType.lowercaseString containsString:@"html"]) error = @"网站返回了网页，请确认已登录或刷新网页";
    if (error) { completion(nil); [self finish:error]; return; }
    self.directory = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:[@"bowerbird-browser-" stringByAppendingString:self.identifier.UUIDString]] isDirectory:YES];
    if (![[NSFileManager defaultManager] createDirectoryAtURL:self.directory withIntermediateDirectories:NO
        attributes:@{NSFilePosixPermissions: @0700} error:nil]) {
        completion(nil); [self finish:@"无法创建图片采集临时目录"]; return;
    }
    // Never trust a filename supplied by the website.
    self.file = [self.directory URLByAppendingPathComponent:@"image"];
    completion(self.file);
}

- (void)download:(WKDownload *)download willPerformHTTPRedirection:(NSHTTPURLResponse *)response
    newRequest:(NSURLRequest *)request decisionHandler:(void (^)(WKDownloadRedirectPolicy))completion {
    NSURL *url = request.URL;
    BOOL allowed = !self.finished && ([url.scheme isEqual:@"https"] || [url.scheme isEqual:@"http"])
        && url.host.length && !url.user.length && !url.password.length;
    completion(allowed ? WKDownloadRedirectPolicyAllow : WKDownloadRedirectPolicyCancel);
    if (!allowed) [self finish:@"图片重定向地址无效"];
}

- (void)downloadDidFinish:(WKDownload *)download { [self finish:nil]; }
- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData {
    [self finish:@"浏览器无法读取这张图片，请刷新网页后重试"];
}
@end

// Called only inside Tauri with_webview (main thread). The callback owns context.
void bb_browser_capture(void *view, const char *rawURL, void *context, BBCaptureCallback callback) {
    if (@available(macOS 11.3, *)) {
        WKWebView *webview = (__bridge WKWebView *)view;
        NSURL *url = [NSURL URLWithString:[NSString stringWithUTF8String:rawURL]];
        if (!webview || !url.host.length || url.user.length || url.password.length
            || !([url.scheme isEqual:@"https"] || [url.scheme isEqual:@"http"])) {
            callback(context, NULL, 0, "图片地址无效"); return;
        }
        if (!BBActiveCaptures) BBActiveCaptures = [NSMutableDictionary new];
        BBCapture *capture = [BBCapture new];
        capture.identifier = [NSUUID UUID]; capture.callback = callback; capture.context = context;
        BBActiveCaptures[capture.identifier] = capture;
        CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
        capture.timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        dispatch_source_set_timer(capture.timer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), NSEC_PER_SEC / 4, NSEC_PER_SEC / 20);
        __weak BBCapture *weakCapture = capture;
        dispatch_source_set_event_handler(capture.timer, ^{
            BBCapture *capture = weakCapture;
            if (!capture || capture.finished) return;
            if (CFAbsoluteTimeGetCurrent() - started > 45) { [capture finish:@"浏览器读取图片超时，请重试"]; return; }
            if (capture.download.progress.completedUnitCount > (int64_t)BBMaxImageBytes || [capture fileSize] > BBMaxImageBytes)
                [capture finish:@"图片超过 50 MiB 上限"];
        });
        dispatch_resume(capture.timer);
        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
        request.timeoutInterval = 45;
        [webview startDownloadUsingRequest:request completionHandler:^(WKDownload *download) {
            if (capture.finished) { [download cancel:nil]; return; }
            capture.download = download;
            download.delegate = capture;
        }];
    } else callback(context, NULL, 0, "内置浏览器拖图需要 macOS 11.3 或更新版本");
}
