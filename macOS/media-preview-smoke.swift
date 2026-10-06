// Isolated system WKWebView regression: no production app setup, profile or user library.
import AppKit
import WebKit

final class Smoke: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var polls = 0
    let previousApp = NSWorkspace.shared.frontmostApplication
    func finish(_ ok: Bool, _ message: String) {
        previousApp?.activate(options: [])
        print(message)
        fflush(stdout)
        exit(ok ? 0 : 1)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(self, name: "smoke")
        configuration.userContentController.addUserScript(WKUserScript(source: """
          const fail = message => window.webkit.messageHandlers.smoke.postMessage({ok: false, message});
          window.addEventListener('error', event => fail(event.message));
          window.addEventListener('unhandledrejection', event => fail(String(event.reason)));
          """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 850), configuration: configuration)
        webView.navigationDelegate = self
        window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Bowerbird isolated media regression"
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        webView.load(URLRequest(url: URL(string: CommandLine.arguments[1])!))
        // Background WebKit timers are throttled; record progress to distinguish
        // slow UI iterations from a blocked renderer and keep automation IPC active.
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.polls += 1
            self.webView.evaluateJavaScript("JSON.stringify({phase:window.mediaSmokePhase, visibility:document.visibilityState})") { value, error in
                if self.polls % 15 == 0 {
                    print("Native progress: \(value ?? String(describing: error))")
                    fflush(stdout)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 150) {
            self.finish(false, "FAIL: native WebKit smoke exceeded 150 seconds")
        }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let result = message.body as? [String: Any], let ok = result["ok"] as? Bool else {
            finish(false, "FAIL: malformed smoke result"); return
        }
        finish(ok, "System WKWebView: \(result["message"] ?? "no result")")
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(false, "FAIL: \(error)")
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("JSON.stringify({state:document.readyState, fixture:typeof window.runMediaPreviewSmoke})") { value, error in
            print("Native fixture loaded: \(value ?? String(describing: error))")
            fflush(stdout)
        }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(false, "FAIL: WebContent process terminated")
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let smoke = Smoke()
app.delegate = smoke
app.run()
