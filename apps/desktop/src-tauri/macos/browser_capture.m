#import <WebKit/WebKit.h>
#include <stdbool.h>

typedef void (*BBCaptureCallback)(void *, const unsigned char *, size_t, const char *);
typedef void (*BBResourceCallback)(void *, const unsigned char *, size_t, const char *, const char *);
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
@property(nonatomic) BBResourceCallback resourceCallback;
@property(nonatomic, strong) NSString *responseURL;
@property(nonatomic, strong) NSString *contentType;
@property(nonatomic) void *context;
@property(nonatomic) BOOL finished;
@property(nonatomic) BOOL video;
@property(nonatomic) NSUInteger maxBytes;
@property(nonatomic) NSTimeInterval timeout;
@property(nonatomic) long long expectedLength;
@property(nonatomic) BOOL encoded;
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
        if ([self fileSize] > self.maxBytes) error = self.resourceCallback ? @"媒体超过本次大小限制" : self.video ? @"视频超过 200 MiB 上限" : @"图片超过 50 MiB 上限";
        else {
            bytes = [NSData dataWithContentsOfURL:self.file options:NSDataReadingMappedIfSafe error:nil];
            if (!bytes.length) error = self.video ? @"网站返回了空视频" : @"网站返回了空图片";
            else if (self.video && self.expectedLength >= 0 && bytes.length != (NSUInteger)self.expectedLength) error = @"网站未返回完整视频，请确认视频可播放后重新拖入。";
        }
    }
    if (self.resourceCallback) {
        NSDictionary *metadata = @{ @"url":self.responseURL ?: @"", @"contentType":self.contentType ?: @"",
            @"totalBytes":self.expectedLength >= 0 ? @(self.expectedLength) : [NSNull null] };
        NSData *json = [NSJSONSerialization dataWithJSONObject:metadata options:0 error:nil];
        NSString *text = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        self.resourceCallback(self.context, bytes.bytes, bytes.length, text.UTF8String, error.UTF8String);
    } else self.callback(self.context, bytes.bytes, bytes.length, error.UTF8String);
    if (error && self.download) {
        [self.download cancel:^(NSData *resumeData) { (void)resumeData; [self cleanup]; }];
    } else [self cleanup];
}

- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response
    suggestedFilename:(NSString *)name completionHandler:(void (^)(NSURL *))completion {
    if (self.finished) { completion(nil); return; }
    NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 0;
    NSString *encoding = [response isKindOfClass:[NSHTTPURLResponse class]] ? [(NSHTTPURLResponse *)response valueForHTTPHeaderField:@"Content-Encoding"] : nil;
    self.encoded = encoding.length && ![encoding.lowercaseString isEqual:@"identity"];
    NSString *error = nil;
    if (status < 200 || status >= 300) error = [NSString stringWithFormat:@"网站未允许读取%@（HTTP %ld），请确认已登录或刷新网页", self.video ? @"视频" : @"图片", (long)status];
    else if (self.video && status == 206) error = @"网站只返回了部分视频，无法采集；请使用完整视频文件链接。";
    else if (!self.encoded && response.expectedContentLength > (long long)self.maxBytes) error = self.resourceCallback ? @"媒体超过本次大小限制" : self.video ? @"视频超过 200 MiB 上限" : @"图片超过 50 MiB 上限";
    else if ([response.MIMEType.lowercaseString containsString:@"html"]) error = @"网站返回了网页，请确认已登录或刷新网页";
    else if (self.video && !self.resourceCallback && ([response.MIMEType.lowercaseString containsString:@"mpegurl"] || [response.MIMEType.lowercaseString containsString:@"dash+xml"])) error = @"此视频使用分段播放，暂不支持拖入采集；请使用完整视频文件链接。";
    if (error) { completion(nil); [self finish:error]; return; }
    self.expectedLength = self.encoded ? -1 : response.expectedContentLength;
    self.responseURL = response.URL.absoluteString;
    self.contentType = response.MIMEType;
    self.directory = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:[@"bowerbird-browser-" stringByAppendingString:self.identifier.UUIDString]] isDirectory:YES];
    if (![[NSFileManager defaultManager] createDirectoryAtURL:self.directory withIntermediateDirectories:NO
        attributes:@{NSFilePosixPermissions: @0700} error:nil]) {
        completion(nil); [self finish:self.video ? @"无法创建视频采集临时目录" : @"无法创建图片采集临时目录"]; return;
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
    if (!allowed) [self finish:self.video ? @"视频重定向地址无效" : @"图片重定向地址无效"];
}

- (void)downloadDidFinish:(WKDownload *)download { [self finish:nil]; }
- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData {
    [self finish:self.video ? @"浏览器无法读取视频，请刷新网页后重试" : @"浏览器无法读取这张图片，请刷新网页后重试"];
}
@end

// Called only inside Tauri with_webview (main thread). The callback owns context.
static void bb_browser_capture_start(void *view, const char *rawURL, bool video, size_t maximum,
    const char *requestID, void *context, BBCaptureCallback callback, BBResourceCallback resourceCallback) {
    if (@available(macOS 11.3, *)) {
        WKWebView *webview = (__bridge WKWebView *)view;
        NSURL *url = [NSURL URLWithString:[NSString stringWithUTF8String:rawURL]];
        if (!webview || !url.host.length || url.user.length || url.password.length
            || !([url.scheme isEqual:@"https"] || [url.scheme isEqual:@"http"])) {
            if (resourceCallback) resourceCallback(context, NULL, 0, NULL, "媒体地址无效");
            else callback(context, NULL, 0, video ? "视频地址无效" : "图片地址无效");
            return;
        }
        if (!BBActiveCaptures) BBActiveCaptures = [NSMutableDictionary new];
        BBCapture *capture = [BBCapture new];
        capture.video = video; capture.maxBytes = maximum; capture.timeout = video ? 120 : 45;
        capture.expectedLength = -1;
        capture.identifier = requestID ? [[NSUUID alloc] initWithUUIDString:[NSString stringWithUTF8String:requestID]] : [NSUUID UUID];
        capture.callback = callback; capture.resourceCallback = resourceCallback; capture.context = context;
        BBActiveCaptures[capture.identifier] = capture;
        CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
        capture.timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        dispatch_source_set_timer(capture.timer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), NSEC_PER_SEC / 4, NSEC_PER_SEC / 20);
        __weak BBCapture *weakCapture = capture;
        dispatch_source_set_event_handler(capture.timer, ^{
            BBCapture *capture = weakCapture;
            if (!capture || capture.finished) return;
            if (CFAbsoluteTimeGetCurrent() - started > capture.timeout) { [capture finish:capture.video ? @"浏览器读取视频超时，请重试" : @"浏览器读取图片超时，请重试"]; return; }
            if ((!capture.encoded && capture.download.progress.completedUnitCount > (int64_t)capture.maxBytes) || [capture fileSize] > capture.maxBytes)
                [capture finish:capture.resourceCallback ? @"媒体超过本次大小限制" : capture.video ? @"视频超过 200 MiB 上限" : @"图片超过 50 MiB 上限"];
        });
        dispatch_resume(capture.timer);
        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
        request.timeoutInterval = capture.timeout;
        [webview startDownloadUsingRequest:request completionHandler:^(WKDownload *download) {
            if (capture.finished) { [download cancel:nil]; return; }
            capture.download = download;
            download.delegate = capture;
        }];
    } else {
        if (resourceCallback) resourceCallback(context, NULL, 0, NULL, "内置浏览器采集需要 macOS 11.3 或更新版本");
        else callback(context, NULL, 0, "内置浏览器拖图需要 macOS 11.3 或更新版本");
    }
}

void bb_browser_capture_media(void *view, const char *rawURL, bool video, void *context, BBCaptureCallback callback) {
    bb_browser_capture_start(view, rawURL, video, video ? 200 * 1024 * 1024 : BBMaxImageBytes, NULL, context, callback, NULL);
}

void bb_browser_capture_resource(void *view, const char *rawURL, size_t maximum, const char *requestID,
    void *context, BBResourceCallback callback) {
    bb_browser_capture_start(view, rawURL, true, maximum, requestID, context, NULL, callback);
}

void bb_browser_cancel_resource(const char *requestID) {
    if (@available(macOS 11.3, *)) {
        NSUUID *identifier = [[NSUUID alloc] initWithUUIDString:[NSString stringWithUTF8String:requestID]];
        BBCapture *capture = identifier ? BBActiveCaptures[identifier] : nil;
        if (capture) [capture finish:@"采集已取消"];
    }
}

// Preserve the image ABI used by the existing standalone Mac fixture.
void bb_browser_capture(void *view, const char *rawURL, void *context, BBCaptureCallback callback) {
    bb_browser_capture_media(view, rawURL, false, context, callback);
}

// Native-initiated, bounded renderer reads; this does not expose a page IPC handler.
void bb_browser_evaluate(void *view, const char *expression, void *context, BBCaptureCallback callback) {
    if (@available(macOS 11.0, *)) {
        WKWebView *webview = (__bridge WKWebView *)view;
        NSString *body = [@"return await (" stringByAppendingFormat:@"%s);", expression];
        [webview callAsyncJavaScript:body arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld
            completionHandler:^(id result, NSError *error) {
                if (error) { callback(context, NULL, 0, "浏览器未能读取当前视频，请播放视频后重试。"); return; }
                NSData *bytes = [NSJSONSerialization dataWithJSONObject:result ?: [NSNull null]
                    options:NSJSONWritingFragmentsAllowed error:&error];
                if (!bytes || bytes.length > 256 * 1024) { callback(context, NULL, 0, "浏览器返回的视频数据无效。"); return; }
                callback(context, bytes.bytes, bytes.length, NULL);
            }];
    } else callback(context, NULL, 0, "当前系统暂不支持浏览器视频采集。");
}
