#include "window.hpp"

#if defined(__APPLE__)

#include "window_internal.h"

#import <CommonCrypto/CommonDigest.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

@interface DoofBookWebShellMessageBridge : NSObject <WKScriptMessageHandler, WKScriptMessageHandlerWithReply>
@end

@implementation DoofBookWebShellMessageBridge

- (id)handleCommandPayload:(id)body errorMessage:(NSString**)errorMessage {
    NSDictionary* payload = [body isKindOfClass:[NSDictionary class]] ? (NSDictionary*)body : nil;
    NSString* command = [payload[@"command"] isKindOfClass:[NSString class]] ? (NSString*)payload[@"command"] : @"";
    NSDictionary* commandPayload = [payload[@"payload"] isKindOfClass:[NSDictionary class]] ? (NSDictionary*)payload[@"payload"] : nil;

    if ([command isEqualToString:@"openDocument"]) {
        id delegate = [NSApp delegate];
        if ([delegate respondsToSelector:@selector(openDocument:)]) {
            [delegate performSelector:@selector(openDocument:) withObject:nil];
        }
        return @{ @"ok": @YES };
    }

    if ([command isEqualToString:@"persistRuntimeState"]) {
        NSString* cachePath = [commandPayload[@"cachePath"] isKindOfClass:[NSString class]] ? (NSString*)commandPayload[@"cachePath"] : @"";
        NSDictionary* runtimeState = [commandPayload[@"runtimeState"] isKindOfClass:[NSDictionary class]] ? (NSDictionary*)commandPayload[@"runtimeState"] : nil;
        if ([cachePath length] == 0 || runtimeState == nil || ![NSJSONSerialization isValidJSONObject:runtimeState]) {
            return @{ @"ok": @NO };
        }

        NSString* directoryPath = [cachePath stringByDeletingLastPathComponent];
        if ([directoryPath length] > 0) {
            [[NSFileManager defaultManager] createDirectoryAtPath:directoryPath withIntermediateDirectories:YES attributes:nil error:nil];
        }

        NSError* error = nil;
        NSData* jsonData = [NSJSONSerialization dataWithJSONObject:runtimeState options:NSJSONWritingPrettyPrinted error:&error];
        if (jsonData == nil || error != nil) {
            return @{ @"ok": @NO };
        }

        return @{
            @"ok": [NSNumber numberWithBool:[jsonData writeToFile:cachePath options:NSDataWritingAtomic error:nil]]
        };
    }

    if ([command isEqualToString:@"listSecrets"]) {
        return @{
            @"secretNames": RunDownSecretNames()
        };
    }

    if ([command isEqualToString:@"resolveSecrets"]) {
        NSArray* secretNames = [commandPayload[@"secretNames"] isKindOfClass:[NSArray class]] ? (NSArray*)commandPayload[@"secretNames"] : @[];
        return @{
            @"secrets": RunDownResolveSecrets(secretNames)
        };
    }

    if (errorMessage != NULL) {
        *errorMessage = [NSString stringWithFormat:@"Unknown host command: %@", command];
    }
    return nil;
}

- (void)userContentController:(WKUserContentController*)userContentController didReceiveScriptMessage:(WKScriptMessage*)message {
    (void)userContentController;
    if (![[message name] isEqualToString:@"rundownHost"]) {
        return;
    }

    NSString* errorMessage = nil;
    [self handleCommandPayload:[message body] errorMessage:&errorMessage];
}

- (void)userContentController:(WKUserContentController*)userContentController
      didReceiveScriptMessage:(WKScriptMessage*)message
                 replyHandler:(void (^)(id reply, NSString* errorMessage))replyHandler {
    (void)userContentController;
    if (![[message name] isEqualToString:@"rundownHost"]) {
        replyHandler(nil, @"Unknown message bridge");
        return;
    }

    NSString* errorMessage = nil;
    id reply = [self handleCommandPayload:[message body] errorMessage:&errorMessage];
    replyHandler(reply ?: @{ @"ok": @NO }, errorMessage);
}

@end

namespace {

static NSString* const kWebShellHostBridgeName = @"rundownHost";

NSString* Sha256HexString(NSString* value) {
    const char* utf8Value = [value UTF8String];
    if (utf8Value == nullptr) {
        return nil;
    }

    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(utf8Value, (CC_LONG)strlen(utf8Value), digest);

    NSMutableString* hexString = [NSMutableString stringWithCapacity:(NSUInteger)(CC_SHA256_DIGEST_LENGTH * 2)];
    for (NSInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
        [hexString appendFormat:@"%02x", digest[index]];
    }
    return hexString;
}

NSString* BundleDisplayName() {
    NSString* displayName = TrimString([[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleDisplayName"] ?: @"");
    if ([displayName length] > 0) {
        return displayName;
    }

    NSString* bundleName = TrimString([[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleName"] ?: @"");
    return [bundleName length] > 0 ? bundleName : @"RunDown";
}

NSColor* WindowBackgroundColor() {
    return [NSColor colorWithCalibratedRed:0.93 green:0.91 blue:0.87 alpha:1.0];
}

NSDictionary* EmptyRuntimeStateObject() {
    return @{
        @"variableNamespaceCount": @0,
        @"httpEntryCount": @0,
        @"variables": @{},
        @"secretBindings": @{},
        @"http": @{},
        @"javascript": @{}
    };
}

NSDictionary* NormalizeRuntimeStateObject(id value) {
    NSDictionary* object = [value isKindOfClass:[NSDictionary class]] ? (NSDictionary*)value : nil;
    NSDictionary* variablesObject = [object[@"variables"] isKindOfClass:[NSDictionary class]] ? (NSDictionary*)object[@"variables"] : @{};
    NSDictionary* secretBindingsObject = [object[@"secretBindings"] isKindOfClass:[NSDictionary class]] ? (NSDictionary*)object[@"secretBindings"] : @{};
    NSDictionary* httpObject = [object[@"http"] isKindOfClass:[NSDictionary class]] ? (NSDictionary*)object[@"http"] : @{};
    NSDictionary* javascriptObject = [object[@"javascript"] isKindOfClass:[NSDictionary class]] ? (NSDictionary*)object[@"javascript"] : @{};

    return @{
        @"variableNamespaceCount": [NSNumber numberWithUnsignedInteger:[variablesObject count]],
        @"httpEntryCount": [NSNumber numberWithUnsignedInteger:[httpObject count]],
        @"variables": variablesObject,
        @"secretBindings": secretBindingsObject,
        @"http": httpObject,
        @"javascript": javascriptObject
    };
}

NSDictionary* LoadRuntimeStateObject(NSString* cachePath) {
    NSString* normalizedPath = TrimString(cachePath ?: @"");
    if ([normalizedPath length] == 0) {
        return EmptyRuntimeStateObject();
    }

    NSData* jsonData = [NSData dataWithContentsOfFile:normalizedPath];
    if (jsonData == nil || [jsonData length] == 0) {
        return EmptyRuntimeStateObject();
    }

    NSError* error = nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&error];
    if (parsed == nil || error != nil) {
        return EmptyRuntimeStateObject();
    }

    return NormalizeRuntimeStateObject(parsed);
}

NSString* JSONStringFromObject(id object) {
    if (![NSJSONSerialization isValidJSONObject:object]) {
        return nil;
    }

    NSError* error = nil;
    NSData* jsonData = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
    if (jsonData == nil || error != nil) {
        return nil;
    }

    return [[[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding] autorelease];
}

NSString* WebShellBootstrapScript(
    std::shared_ptr<WorkbookDocumentSource> documentSource,
    NSDictionary* runtimeState,
    NSString* cachePath
) {
    NSString* sourceLabel = documentSource != nullptr ? NSStringFromStdString(documentSource->displayPath) : @"";
    NSString* representedPath = ResolvedWorkbookFilePath(sourceLabel);
    NSDictionary* bootstrap = @{
        @"appName": BundleDisplayName(),
        @"phase": @"native-webview-shell",
        @"representedPath": representedPath ?: @"",
        @"cachePath": cachePath ?: @"",
        @"document": @{
            @"sourceLabel": sourceLabel,
            @"source": documentSource != nullptr ? NSStringFromStdString(documentSource->source) : @""
        },
        @"runtimeState": runtimeState ?: EmptyRuntimeStateObject()
    };

    NSString* jsonText = JSONStringFromObject(bootstrap);
    if ([jsonText length] == 0) {
        return nil;
    }

    return [NSString stringWithFormat:@"window.__RUNDOWN_BOOTSTRAP__ = %@;", jsonText];
}

NSString* WebShellHostScript() {
    return @"window.rundownHost = {"
        "available: true,"
        "post(command, payload) {"
        "  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.rundownHost;"
        "  if (!handler || typeof handler.postMessage !== 'function') {"
        "    return null;"
        "  }"
        "  return handler.postMessage({ command, payload: payload || null });"
        "},"
        "send(command, payload) {"
        "  const result = this.post(command, payload);"
        "  if (!result) {"
        "    return false;"
        "  }"
        "  if (typeof result.catch === 'function') {"
        "    result.catch(() => {});"
        "  }"
        "  return true;"
        "},"
        "request(command, payload) {"
        "  const result = this.post(command, payload);"
        "  if (!result) {"
        "    return Promise.reject(new Error('RunDown host bridge is unavailable'));"
        "  }"
        "  return typeof result.then === 'function' ? result : Promise.resolve(result);"
        "},"
        "openDocument() {"
        "  return this.send('openDocument');"
        "},"
        "persistRuntimeState(runtimeState, cachePath) {"
        "  return this.send('persistRuntimeState', { runtimeState, cachePath });"
        "}"
        "};";
}

WKWebView* BuildWorkbookWebView(
    NSRect frame,
    std::shared_ptr<WorkbookDocumentSource> documentSource,
    NSDictionary* runtimeState,
    NSString* cachePath,
    NSString** errorText
) {
    NSString* htmlPath = [[NSBundle mainBundle] pathForResource:@"index" ofType:@"html" inDirectory:@"web"];
    if ([htmlPath length] == 0) {
        if (errorText != NULL) {
            *errorText = @"Could not locate bundled web shell assets";
        }
        return nil;
    }

    WKWebViewConfiguration* configuration = [[[WKWebViewConfiguration alloc] init] autorelease];
    WKUserContentController* contentController = [[[WKUserContentController alloc] init] autorelease];
    DoofBookWebShellMessageBridge* bridge = [[[DoofBookWebShellMessageBridge alloc] init] autorelease];
    [configuration setUserContentController:contentController];
    if ([contentController respondsToSelector:@selector(addScriptMessageHandlerWithReply:contentWorld:name:)]) {
        [contentController addScriptMessageHandlerWithReply:bridge contentWorld:[WKContentWorld pageWorld] name:kWebShellHostBridgeName];
    } else {
        [contentController addScriptMessageHandler:bridge name:kWebShellHostBridgeName];
    }

    WKUserScript* hostScript = [[[WKUserScript alloc] initWithSource:WebShellHostScript()
                                                       injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                    forMainFrameOnly:YES] autorelease];
    [contentController addUserScript:hostScript];

    NSString* bootstrapScript = WebShellBootstrapScript(documentSource, runtimeState, cachePath);
    if ([bootstrapScript length] > 0) {
        WKUserScript* userScript = [[[WKUserScript alloc] initWithSource:bootstrapScript
                                                           injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                        forMainFrameOnly:YES] autorelease];
        [contentController addUserScript:userScript];
    }

    WKWebView* webView = [[WKWebView alloc] initWithFrame:frame configuration:configuration];
    [webView setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
    if ([webView respondsToSelector:@selector(setInspectable:)]) {
        [webView setInspectable:YES];
    }

    NSURL* htmlURL = [NSURL fileURLWithPath:htmlPath];
    NSURL* readAccessURL = [htmlURL URLByDeletingLastPathComponent];
    [webView loadFileURL:htmlURL allowingReadAccessToURL:readAccessURL];
    return [webView autorelease];
}

} // namespace

static WKWebView* FindWorkbookWebView(NSView* view);

@interface RunDownWorkbookFileReloader : NSObject {
    NSString* _workbookPath;
    WKWebView* _webView;
    NSTimer* _timer;
    NSString* _lastAppliedSource;
    BOOL _reloadInFlight;
}

- (instancetype)initWithWorkbookPath:(NSString*)workbookPath webView:(WKWebView*)webView initialSource:(NSString*)initialSource;
- (void)start;
- (void)stop;

@end

@implementation RunDownWorkbookFileReloader

- (instancetype)initWithWorkbookPath:(NSString*)workbookPath webView:(WKWebView*)webView initialSource:(NSString*)initialSource {
    self = [super init];
    if (self != nil) {
        _workbookPath = [TrimString(workbookPath ?: @"") copy];
        _webView = webView;
        _lastAppliedSource = [(initialSource ?: @"") copy];
        _reloadInFlight = NO;
    }
    return self;
}

- (void)dealloc {
    [self stop];
    [_workbookPath release];
    [_lastAppliedSource release];
    [super dealloc];
}

- (void)start {
    if (_timer != nil || [_workbookPath length] == 0 || _webView == nil) {
        return;
    }

    _timer = [[NSTimer timerWithTimeInterval:1.0
                                      target:self
                                    selector:@selector(checkForWorkbookChanges:)
                                    userInfo:nil
                                     repeats:YES] retain];
    [[NSRunLoop mainRunLoop] addTimer:_timer forMode:NSRunLoopCommonModes];
}

- (void)stop {
    if (_timer != nil) {
        [_timer invalidate];
        [_timer release];
        _timer = nil;
    }
    _webView = nil;
    _reloadInFlight = NO;
}

- (void)checkForWorkbookChanges:(NSTimer*)timer {
    (void)timer;
    if (_reloadInFlight || _webView == nil || [_workbookPath length] == 0) {
        return;
    }

    NSError* readError = nil;
    NSString* sourceText = [NSString stringWithContentsOfFile:_workbookPath encoding:NSUTF8StringEncoding error:&readError];
    if (sourceText == nil || readError != nil || [_lastAppliedSource isEqualToString:sourceText]) {
        return;
    }

    NSString* payloadJSON = JSONStringFromObject(@{ @"source": sourceText });
    if ([payloadJSON length] == 0) {
        return;
    }

    _reloadInFlight = YES;
    NSString* script = [NSString stringWithFormat:
        @"(() => {"
        "  if (!window.RunDown || typeof window.RunDown.reloadDocumentSource !== 'function') {"
        "    throw new Error('RunDown reload API is unavailable');"
        "  }"
        "  return window.RunDown.reloadDocumentSource((%@).source);"
        "})();",
        payloadJSON
    ];

    [sourceText retain];
    [self retain];
    [_webView evaluateJavaScript:script completionHandler:^(id result, NSError* error) {
        (void)result;
        if (error == nil) {
            [_lastAppliedSource release];
            _lastAppliedSource = [sourceText copy];
        }
        [sourceText release];
        _reloadInFlight = NO;
        [self release];
    }];
}

@end

static char kRunDownWorkbookFileReloaderKey;

void RunDownStartWorkbookFileReloading(NSWindow* window, NSString* sourceLabel, NSString* initialSource) {
    NSString* workbookPath = ResolvedWorkbookFilePath(sourceLabel);
    WKWebView* webView = FindWorkbookWebView(window != nil ? [window contentView] : nil);
    if ([workbookPath length] == 0 || webView == nil) {
        return;
    }

    RunDownWorkbookFileReloader* reloader = [[RunDownWorkbookFileReloader alloc] initWithWorkbookPath:workbookPath
                                                                                              webView:webView
                                                                                       initialSource:initialSource ?: @""];
    [reloader start];
    objc_setAssociatedObject(window, &kRunDownWorkbookFileReloaderKey, reloader, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [reloader release];
}

void RunDownStopWorkbookFileReloading(NSWindow* window) {
    RunDownWorkbookFileReloader* reloader = (RunDownWorkbookFileReloader*)objc_getAssociatedObject(window, &kRunDownWorkbookFileReloaderKey);
    [reloader stop];
    objc_setAssociatedObject(window, &kRunDownWorkbookFileReloaderKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

NSString* ResolvedWorkbookFilePath(NSString* sourceLabel) {
    NSString* trimmedSourceLabel = TrimString(sourceLabel);
    if ([trimmedSourceLabel length] == 0) {
        return nil;
    }

    NSString* expandedPath = [trimmedSourceLabel stringByExpandingTildeInPath];
    NSString* candidatePath = [expandedPath isAbsolutePath]
        ? expandedPath
        : [[[NSFileManager defaultManager] currentDirectoryPath] stringByAppendingPathComponent:expandedPath];
    NSString* standardizedPath = [candidatePath stringByStandardizingPath];

    BOOL isDirectory = NO;
    if (![[NSFileManager defaultManager] fileExistsAtPath:standardizedPath isDirectory:&isDirectory] || isDirectory) {
        return nil;
    }

    return standardizedPath;
}

NSString* WorkbookCachePathForSourceLabel(NSString* sourceLabel) {
    NSString* workbookPath = ResolvedWorkbookFilePath(sourceLabel);
    if ([workbookPath length] == 0) {
        return nil;
    }

    NSArray* cacheDirectories = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
    NSString* cacheRoot = [cacheDirectories count] > 0 ? (NSString*)cacheDirectories[0] : nil;
    NSString* cacheIdentifier = Sha256HexString(workbookPath);
    if ([cacheRoot length] == 0 || [cacheIdentifier length] == 0) {
        return nil;
    }

    NSString* bundleIdentifier = TrimString([[NSBundle mainBundle] bundleIdentifier] ?: @"dev.doof.rundown");
    if ([bundleIdentifier length] == 0) {
        bundleIdentifier = @"dev.doof.rundown";
    }

    NSString* workbookCacheDirectory = [[cacheRoot stringByAppendingPathComponent:bundleIdentifier] stringByAppendingPathComponent:@"workbooks"];
    return [workbookCacheDirectory stringByAppendingPathComponent:[cacheIdentifier stringByAppendingString:@".json"]];
}

static NSString* WorkbookWindowAutosaveNameForSourceLabel(NSString* sourceLabel) {
    NSString* workbookPath = ResolvedWorkbookFilePath(sourceLabel);
    if ([workbookPath length] > 0) {
        NSString* cacheIdentifier = Sha256HexString(workbookPath);
        if ([cacheIdentifier length] > 0) {
            return [@"RunDownWindow-" stringByAppendingString:cacheIdentifier];
        }
    }

    return @"RunDownWindow-welcome";
}

static void ConfigureWindowTitleForSourceLabel(NSWindow* window, NSString* sourceLabel, NSString* fallbackTitle) {
    NSString* representedPath = ResolvedWorkbookFilePath(sourceLabel);
    if ([representedPath length] > 0) {
        [window setRepresentedURL:[NSURL fileURLWithPath:representedPath]];
        [window setTitleWithRepresentedFilename:representedPath];
        return;
    }

    [window setRepresentedURL:nil];
    [window setTitle:fallbackTitle];
}

static WKWebView* FindWorkbookWebView(NSView* view) {
    if ([view isKindOfClass:[WKWebView class]]) {
        return (WKWebView*)view;
    }

    for (NSView* subview in [view subviews]) {
        WKWebView* match = FindWorkbookWebView(subview);
        if (match != nil) {
            return match;
        }
    }

    return nil;
}

NSWindow* CreateWorkbookDocumentWindow(NSString* windowTitle, std::shared_ptr<WorkbookDocumentSource> content, NSString** errorText) {
    NSString* resolvedWindowTitle = [TrimString(windowTitle ?: @"") length] > 0 ? TrimString(windowTitle ?: @"") : BundleDisplayName();
    if (content == nullptr) {
        if (errorText != NULL) {
            *errorText = @"Could not convert document payload to native types";
        }
        return nil;
    }

    NSString* sourceLabel = NSStringFromStdString(content->displayPath);
    NSString* cachePath = WorkbookCachePathForSourceLabel(sourceLabel);
    NSDictionary* runtimeState = LoadRuntimeStateObject(cachePath);

    const NSRect frame = NSMakeRect(0.0, 0.0, 980.0, 760.0);
    const NSWindowStyleMask styleMask =
        NSWindowStyleMaskTitled |
        NSWindowStyleMaskClosable |
        NSWindowStyleMaskMiniaturizable |
        NSWindowStyleMaskResizable;

    NSWindow* window = [[NSWindow alloc] initWithContentRect:frame
                                                   styleMask:styleMask
                                                     backing:NSBackingStoreBuffered
                                                       defer:NO];
    if (window == nil) {
        if (errorText != NULL) {
            *errorText = @"Could not create RunDown window";
        }
        return nil;
    }

    id delegate = [NSApp delegate];
    if (delegate != nil) {
        [window setDelegate:delegate];
    }
    [window setReleasedWhenClosed:NO];

    ConfigureWindowTitleForSourceLabel(window, sourceLabel, resolvedWindowTitle);
    NSString* autosaveName = WorkbookWindowAutosaveNameForSourceLabel(sourceLabel);
    BOOL restoredFrame = NO;
    if ([autosaveName length] > 0) {
        restoredFrame = [window setFrameAutosaveName:autosaveName];
    }
    if (!restoredFrame) {
        [window center];
    }

    [window setBackgroundColor:WindowBackgroundColor()];

    WKWebView* webView = BuildWorkbookWebView(
        [[window contentView] bounds],
        content,
        runtimeState,
        cachePath,
        errorText
    );
    if (webView == nil) {
        [window release];
        return nil;
    }

    [[window contentView] addSubview:webView];
    [[window contentView] setWantsLayer:YES];
    [[[window contentView] layer] setBackgroundColor:[WindowBackgroundColor() CGColor]];
    RunDownStartWorkbookFileReloading(window, sourceLabel, NSStringFromStdString(content->source));
    [window makeKeyAndOrderFront:nil];

    return [window autorelease];
}

void RunDownToggleHiddenRuntimeCells(NSWindow* window) {
    WKWebView* webView = FindWorkbookWebView(window != nil ? [window contentView] : nil);
    if (webView == nil) {
        return;
    }

    [webView evaluateJavaScript:@"window.RunDown && window.RunDown.toggleHiddenRuntimeCells && window.RunDown.toggleHiddenRuntimeCells();"
              completionHandler:nil];
}

NSMenu* BuildApplicationMenu(NSString* appName) {
    NSMenu* mainMenu = [[NSMenu alloc] initWithTitle:@"MainMenu"];

    NSMenuItem* appItem = [[NSMenuItem alloc] initWithTitle:appName action:nil keyEquivalent:@""];
    [mainMenu addItem:appItem];

    NSMenu* appMenu = [[NSMenu alloc] initWithTitle:appName];
    NSString* aboutTitle = [NSString stringWithFormat:@"About %@", appName];
    [appMenu addItemWithTitle:aboutTitle action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    NSMenuItem* secretsItem = [appMenu addItemWithTitle:@"Secrets…" action:@selector(showSecrets:) keyEquivalent:@","];
    [secretsItem setKeyEquivalentModifierMask:NSEventModifierFlagCommand | NSEventModifierFlagOption];
    [secretsItem setTarget:[NSApp delegate]];
    [appMenu addItem:[NSMenuItem separatorItem]];
    NSString* hideTitle = [NSString stringWithFormat:@"Hide %@", appName];
    [appMenu addItemWithTitle:hideTitle action:@selector(hide:) keyEquivalent:@"h"];
    NSMenuItem* hideOthers = [appMenu addItemWithTitle:@"Hide Others" action:@selector(hideOtherApplications:) keyEquivalent:@"h"];
    [hideOthers setKeyEquivalentModifierMask:NSEventModifierFlagCommand | NSEventModifierFlagOption];
    [appMenu addItemWithTitle:@"Show All" action:@selector(unhideAllApplications:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    NSString* quitTitle = [NSString stringWithFormat:@"Quit %@", appName];
    [appMenu addItemWithTitle:quitTitle action:@selector(terminate:) keyEquivalent:@"q"];
    [appItem setSubmenu:appMenu];

    NSMenuItem* fileItem = [[NSMenuItem alloc] initWithTitle:@"File" action:nil keyEquivalent:@""];
    [mainMenu addItem:fileItem];
    NSMenu* fileMenu = [[NSMenu alloc] initWithTitle:@"File"];
    NSMenuItem* openItem = [fileMenu addItemWithTitle:@"Open…" action:@selector(openDocument:) keyEquivalent:@"o"];
    [openItem setTarget:[NSApp delegate]];

    NSMenuItem* openRecentItem = [[NSMenuItem alloc] initWithTitle:@"Open Recent" action:nil keyEquivalent:@""];
    NSMenu* openRecentMenu = [[NSMenu alloc] initWithTitle:@"Open Recent"];
    [openRecentMenu setAutoenablesItems:NO];
    [openRecentMenu setDelegate:(id<NSMenuDelegate>)[NSApp delegate]];
    [openRecentItem setSubmenu:openRecentMenu];
    [fileMenu addItem:openRecentItem];

    [fileMenu addItem:[NSMenuItem separatorItem]];
    [fileMenu addItemWithTitle:@"Close Window" action:@selector(performClose:) keyEquivalent:@"w"];
    [fileItem setSubmenu:fileMenu];

    NSMenuItem* viewItem = [[NSMenuItem alloc] initWithTitle:@"View" action:nil keyEquivalent:@""];
    [mainMenu addItem:viewItem];
    NSMenu* viewMenu = [[NSMenu alloc] initWithTitle:@"View"];
    NSMenuItem* hiddenRuntimeItem = [viewMenu addItemWithTitle:@"Show/Hide Auto HTTP and JavaScript Cells"
                                                        action:@selector(toggleHiddenRuntimeCells:)
                                                 keyEquivalent:@"j"];
    [hiddenRuntimeItem setKeyEquivalentModifierMask:NSEventModifierFlagCommand | NSEventModifierFlagOption];
    [hiddenRuntimeItem setTarget:[NSApp delegate]];
    [viewItem setSubmenu:viewMenu];

    NSMenuItem* windowItem = [[NSMenuItem alloc] initWithTitle:@"Window" action:nil keyEquivalent:@""];
    [mainMenu addItem:windowItem];
    NSMenu* windowMenu = [[NSMenu alloc] initWithTitle:@"Window"];
    [windowMenu addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [windowMenu addItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""];
    [windowMenu addItem:[NSMenuItem separatorItem]];
    [windowMenu addItemWithTitle:@"Bring All to Front" action:@selector(arrangeInFront:) keyEquivalent:@""];
    [windowItem setSubmenu:windowMenu];

    [NSApp setWindowsMenu:windowMenu];

    [windowMenu release];
    [windowItem release];
    [viewMenu release];
    [viewItem release];
    [openRecentMenu release];
    [openRecentItem release];
    [fileMenu release];
    [fileItem release];
    [appMenu release];
    [appItem release];
    return mainMenu;
}

namespace doofbook_app {
bool runApplication(const std::string& initialWorkbookPath, std::string* errorMessage) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];

        NSString* initialPath = [NSString stringWithUTF8String:initialWorkbookPath.c_str()];
        if (initialPath == nil) {
            initialPath = @"";
        }

        DoofBookAppDelegate* delegate = [[DoofBookAppDelegate alloc] initWithInitialWorkbookPath:initialPath];
        [NSApp setDelegate:delegate];

        NSMenu* mainMenu = BuildApplicationMenu(BundleDisplayName());
        [NSApp setMainMenu:mainMenu];
        [mainMenu release];

        [NSApp finishLaunching];
        [NSApp activateIgnoringOtherApps:YES];
        [NSApp run];

        [NSApp setDelegate:nil];
        [delegate release];
        if (errorMessage != nullptr) {
            errorMessage->clear();
        }
        return true;
    }
}

} // namespace doofbook_app

#else

namespace doofbook_app {

bool runApplication(const std::string&, std::string* errorMessage) {
    if (errorMessage != nullptr) {
        *errorMessage = "RunDown macOS shell is only available on macOS";
    }
    return false;
}

} // namespace doofbook_app

#endif
