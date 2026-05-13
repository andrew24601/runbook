#include "window_internal.h"

#if defined(__APPLE__)

#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static NSString* const kOpenWorkbookSessionDefaultsKey = @"DoofBookOpenWorkbookPaths";

static NSString* StandardizedWorkbookPath(NSString* path) {
    NSString* trimmed = TrimString(path ?: @"");
    if ([trimmed length] == 0) {
        return @"";
    }

    NSString* expandedPath = [trimmed stringByExpandingTildeInPath];
    NSString* candidatePath = [expandedPath isAbsolutePath]
        ? expandedPath
        : [[[NSFileManager defaultManager] currentDirectoryPath] stringByAppendingPathComponent:expandedPath];
    return [candidatePath stringByStandardizingPath];
}

static BOOL IsSupportedWorkbookPath(NSString* path) {
    NSString* standardizedPath = StandardizedWorkbookPath(path);
    if ([standardizedPath length] == 0) {
        return NO;
    }

    BOOL isDirectory = NO;
    if (![[NSFileManager defaultManager] fileExistsAtPath:standardizedPath isDirectory:&isDirectory] || isDirectory) {
        return NO;
    }

    NSString* pathExtension = [[standardizedPath pathExtension] lowercaseString];
    return [pathExtension isEqualToString:@"md"] || [pathExtension isEqualToString:@"markdown"];
}

static NSArray<NSString*>* UniqueWorkbookPaths(NSArray<NSString*>* paths) {
    NSMutableArray<NSString*>* uniquePaths = [NSMutableArray array];
    NSMutableSet<NSString*>* seenPaths = [NSMutableSet set];
    for (id item in paths) {
        if (![item isKindOfClass:[NSString class]]) {
            continue;
        }

        NSString* standardizedPath = StandardizedWorkbookPath((NSString*)item);
        if ([standardizedPath length] == 0 || [seenPaths containsObject:standardizedPath]) {
            continue;
        }

        [seenPaths addObject:standardizedPath];
        [uniquePaths addObject:standardizedPath];
    }
    return uniquePaths;
}

static NSString* WorkbookFilePathForWindow(NSWindow* window) {
    NSURL* representedURL = window != nil ? [window representedURL] : nil;
    if (representedURL == nil || ![representedURL isFileURL]) {
        return nil;
    }

    return StandardizedWorkbookPath([representedURL path]);
}

static NSString* DefaultWorkbookPath(void) {
    return @"samples/welcome.md";
}

static NSString* BuiltInWelcomeWorkbook(void) {
    return @"# RunDown Welcome\n"
        "\n"
        "This workbook exists so the first native RunDown shell has something concrete to open.\n"
        "\n"
        "```variables name=\"my_vars\"\n"
        "base_url = \"https://jsonplaceholder.typicode.com\"\n"
        "user = \"1\"\n"
        "```\n"
        "\n"
        "The profile request uses the shared base URL and user variables.\n"
        "\n"
        "```http name=\"profile\"\n"
        "GET {{my_vars.base_url}}/users/{{my_vars.user}}\n"
        "Accept: application/json\n"
        "```\n"
        "\n"
        "The JSON viewer can bind directly to cached response data.\n"
        "\n"
        "```json src=\"profile.body\"\n"
        "```\n"
        "\n"
        "JavaScript cells can compute from any named outputs above them. This one reruns when the variables or profile response changes.\n"
        "\n"
        "```javascript name=\"profileSummary\"\n"
        "if (typeof profile === \"undefined\" || !profile.body) {\n"
        "  return { userId: my_vars.user, name: \"\", city: \"\" };\n"
        "}\n"
        "\n"
        "return {\n"
        "  userId: my_vars.user,\n"
        "  name: profile.body.name,\n"
        "  city: profile.body.address.city\n"
        "};\n"
        "```\n"
        "\n"
        "Once the request runs, markdown can reflect the cached response.\n"
        "\n"
        "- Profile status: {{profile.status}}\n"
        "- Profile name: {{profile.body.name}}\n"
        "- Profile city: {{profileSummary.city}}\n";
}

static std::shared_ptr<WorkbookDocumentSource> LoadWorkbookDocumentSource(NSString* workbookPath, NSString** errorText) {
    NSString* normalizedPath = TrimString(workbookPath ?: @"");
    NSError* readError = nil;
    NSString* sourceText = [NSString stringWithContentsOfFile:normalizedPath encoding:NSUTF8StringEncoding error:&readError];
    if (sourceText != nil) {
        return std::make_shared<WorkbookDocumentSource>(StdStringOrEmpty(normalizedPath), StdStringOrEmpty(sourceText));
    }

    if ([normalizedPath length] == 0 || [normalizedPath isEqualToString:DefaultWorkbookPath()]) {
        return std::make_shared<WorkbookDocumentSource>(std::string("Bundled welcome workbook"), StdStringOrEmpty(BuiltInWelcomeWorkbook()));
    }

    if (errorText != NULL) {
        *errorText = [NSString stringWithFormat:@"Could not read workbook: %@", normalizedPath];
    }

    return nullptr;
}

static NSArray<NSString*>* StoredWorkbookSessionPaths(void) {
    NSArray* storedPaths = [[NSUserDefaults standardUserDefaults] arrayForKey:kOpenWorkbookSessionDefaultsKey];
    NSMutableArray<NSString*>* validPaths = [NSMutableArray array];
    for (id item in storedPaths) {
        if (![item isKindOfClass:[NSString class]]) {
            continue;
        }

        NSString* standardizedPath = StandardizedWorkbookPath((NSString*)item);
        if (!IsSupportedWorkbookPath(standardizedPath)) {
            continue;
        }

        [validPaths addObject:standardizedPath];
    }
    return UniqueWorkbookPaths(validPaths);
}

static void PersistStoredWorkbookSessionPaths(NSArray<NSString*>* workbookPaths) {
    NSArray<NSString*>* uniquePaths = UniqueWorkbookPaths(workbookPaths ?: @[]);
    NSUserDefaults* defaults = [NSUserDefaults standardUserDefaults];
    if ([uniquePaths count] == 0) {
        [defaults removeObjectForKey:kOpenWorkbookSessionDefaultsKey];
        [defaults synchronize];
        return;
    }

    [defaults setObject:uniquePaths forKey:kOpenWorkbookSessionDefaultsKey];
    [defaults synchronize];
}

static NSArray<NSString*>* OpenWorkbookSessionPaths(NSWindow* closingWindow, BOOL preserveClosingWindowIfLast) {
    NSMutableArray<NSString*>* paths = [NSMutableArray array];
    NSString* closingPath = WorkbookFilePathForWindow(closingWindow);
    NSInteger documentWindowCount = 0;

    for (NSWindow* window in [NSApp windows]) {
        NSString* workbookPath = WorkbookFilePathForWindow(window);
        if ([workbookPath length] == 0) {
            continue;
        }

        documentWindowCount += 1;
        if (window == closingWindow) {
            continue;
        }

        [paths addObject:workbookPath];
    }

    if ([paths count] == 0 && preserveClosingWindowIfLast && [closingPath length] > 0 && documentWindowCount <= 1) {
        [paths addObject:closingPath];
    }

    return UniqueWorkbookPaths(paths);
}

static NSWindow* ExistingWindowForWorkbookPath(NSString* workbookPath) {
    NSString* standardizedPath = StandardizedWorkbookPath(workbookPath);
    if ([standardizedPath length] == 0) {
        return nil;
    }

    for (NSWindow* window in [NSApp windows]) {
        NSString* openWorkbookPath = WorkbookFilePathForWindow(window);
        if ([openWorkbookPath isEqualToString:standardizedPath]) {
            return window;
        }
    }

    return nil;
}

static NSString* AppDisplayName(void) {
    NSString* displayName = TrimString([[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleDisplayName"] ?: @"");
    if ([displayName length] > 0) {
        return displayName;
    }

    NSString* bundleName = TrimString([[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleName"] ?: @"");
    return [bundleName length] > 0 ? bundleName : @"RunDown";
}

static void PresentWorkbookOpenError(NSString* workbookPath, NSString* detailText) {
    NSAlert* alert = [[[NSAlert alloc] init] autorelease];
    [alert setAlertStyle:NSAlertStyleWarning];
    [alert setMessageText:[NSString stringWithFormat:@"%@ could not open this workbook.", AppDisplayName()]];

    NSString* informativeText = TrimString(detailText ?: @"");
    NSString* pathText = StandardizedWorkbookPath(workbookPath);
    if ([pathText length] > 0) {
        informativeText = [NSString stringWithFormat:@"%@\n\n%@", pathText, informativeText];
    }
    [alert setInformativeText:[informativeText length] > 0 ? informativeText : @"The selected file could not be opened."];
    [alert runModal];
}

@interface DoofBookAppDelegate ()

- (void)resolveInitialLaunchDocumentsIfNeeded;
- (BOOL)openWorkbookPath:(NSString*)workbookPath;
- (void)openWorkbookPaths:(NSArray<NSString*>*)workbookPaths;
- (void)persistCurrentWorkbookSession;
- (void)rebuildRecentDocumentsMenu:(NSMenu*)menu;
- (IBAction)toggleHiddenJavascriptCells:(id)sender;

@end

@implementation DoofBookAppDelegate

- (instancetype)initWithInitialWorkbookPath:(NSString*)initialWorkbookPath {
    self = [super init];
    if (self != nil) {
        _initialWorkbookPath = [StandardizedWorkbookPath(initialWorkbookPath) retain];
        _didReceiveOpenRequest = NO;
        _didOpenAnyWorkbook = NO;
        _resolvedLaunchDocuments = NO;
        _isTerminating = NO;
    }
    return self;
}

- (void)dealloc {
    [_initialWorkbookPath release];
    [super dealloc];
}

- (void)applicationDidFinishLaunching:(NSNotification*)notification {
    (void)notification;
    dispatch_async(dispatch_get_main_queue(), ^{
        [self resolveInitialLaunchDocumentsIfNeeded];
    });
}

- (BOOL)application:(NSApplication*)application openFile:(NSString*)filename {
    (void)application;
    _didReceiveOpenRequest = YES;
    return [self openWorkbookPath:filename];
}

- (void)application:(NSApplication*)sender openFiles:(NSArray<NSString*>*)filenames {
    _didReceiveOpenRequest = YES;

    BOOL openedAny = NO;
    for (id item in filenames) {
        if (![item isKindOfClass:[NSString class]]) {
            continue;
        }

        openedAny = [self openWorkbookPath:(NSString*)item] || openedAny;
    }

    [sender replyToOpenOrPrint:openedAny ? NSApplicationDelegateReplySuccess : NSApplicationDelegateReplyFailure];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)sender {
    (void)sender;
    return NO;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication*)sender hasVisibleWindows:(BOOL)flag {
    (void)sender;
    if (flag) {
        return NO;
    }

    NSArray<NSString*>* storedPaths = StoredWorkbookSessionPaths();
    if ([storedPaths count] > 0) {
        [self openWorkbookPaths:storedPaths];
    } else {
        [self openWorkbookPath:@""];
    }
    return YES;
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication*)sender {
    (void)sender;
    _isTerminating = YES;
    PersistStoredWorkbookSessionPaths(OpenWorkbookSessionPaths(nil, NO));
    return NSTerminateNow;
}

- (void)applicationWillTerminate:(NSNotification*)notification {
    (void)notification;
    PersistStoredWorkbookSessionPaths(OpenWorkbookSessionPaths(nil, NO));
}

- (void)windowWillClose:(NSNotification*)notification {
    if (_isTerminating) {
        return;
    }

    if (![[notification object] isKindOfClass:[NSWindow class]]) {
        return;
    }

    NSWindow* window = (NSWindow*)[notification object];
    PersistStoredWorkbookSessionPaths(OpenWorkbookSessionPaths(window, YES));
}

- (IBAction)openDocument:(id)sender {
    (void)sender;

    NSOpenPanel* panel = [NSOpenPanel openPanel];
    [panel setCanChooseFiles:YES];
    [panel setCanChooseDirectories:NO];
    [panel setAllowsMultipleSelection:YES];

    NSMutableArray<UTType*>* contentTypes = [NSMutableArray array];
    UTType* markdownType = [UTType typeWithFilenameExtension:@"md"];
    if (markdownType != nil) {
        [contentTypes addObject:markdownType];
    }

    UTType* markdownAliasType = [UTType typeWithFilenameExtension:@"markdown"];
    if (markdownAliasType != nil && ![contentTypes containsObject:markdownAliasType]) {
        [contentTypes addObject:markdownAliasType];
    }

    if ([contentTypes count] > 0) {
        [panel setAllowedContentTypes:contentTypes];
    }

    if ([panel runModal] != NSModalResponseOK) {
        return;
    }

    NSMutableArray<NSString*>* paths = [NSMutableArray array];
    for (NSURL* url in [panel URLs]) {
        if ([url isFileURL]) {
            [paths addObject:[url path]];
        }
    }
    [self openWorkbookPaths:paths];
}

- (IBAction)openRecentDocument:(id)sender {
    NSString* workbookPath = [sender respondsToSelector:@selector(representedObject)] ? [sender representedObject] : nil;
    if (![workbookPath isKindOfClass:[NSString class]]) {
        return;
    }

    [self openWorkbookPath:workbookPath];
}

- (IBAction)clearRecentDocuments:(id)sender {
    (void)sender;
    [[NSDocumentController sharedDocumentController] clearRecentDocuments:nil];
}

- (IBAction)toggleHiddenJavascriptCells:(id)sender {
    (void)sender;
    RunDownToggleHiddenJavascriptCells([NSApp keyWindow]);
}

- (IBAction)showSecrets:(id)sender {
    (void)sender;
    RunDownPresentSecretsPanel([NSApp keyWindow]);
}

- (void)menuNeedsUpdate:(NSMenu*)menu {
    if ([[menu title] isEqualToString:@"Open Recent"]) {
        [self rebuildRecentDocumentsMenu:menu];
    }
}

- (void)resolveInitialLaunchDocumentsIfNeeded {
    if (_resolvedLaunchDocuments) {
        return;
    }

    _resolvedLaunchDocuments = YES;
    if (_didReceiveOpenRequest) {
        return;
    }

    if ([TrimString(_initialWorkbookPath ?: @"") length] > 0) {
        [self openWorkbookPath:_initialWorkbookPath];
        return;
    }

    NSArray<NSString*>* storedPaths = StoredWorkbookSessionPaths();
    if ([storedPaths count] > 0) {
        [self openWorkbookPaths:storedPaths];
        return;
    }

    [self openWorkbookPath:@""];
}

- (BOOL)openWorkbookPath:(NSString*)workbookPath {
    NSString* standardizedPath = StandardizedWorkbookPath(workbookPath);
    const bool shouldOpenWelcomeWorkbook = [standardizedPath length] == 0;

    if (!shouldOpenWelcomeWorkbook) {
        if (!IsSupportedWorkbookPath(standardizedPath)) {
            PresentWorkbookOpenError(standardizedPath, @"RunDown currently supports Markdown workbooks ending in .md or .markdown.");
            return NO;
        }

        NSWindow* existingWindow = ExistingWindowForWorkbookPath(standardizedPath);
        if (existingWindow != nil) {
            [existingWindow makeKeyAndOrderFront:nil];
            [NSApp activateIgnoringOtherApps:YES];
            [self persistCurrentWorkbookSession];
            return YES;
        }
    }

    NSString* loadErrorText = nil;
    std::shared_ptr<WorkbookDocumentSource> documentSource = LoadWorkbookDocumentSource(standardizedPath, &loadErrorText);
    if (documentSource == nullptr) {
        PresentWorkbookOpenError(standardizedPath, loadErrorText);
        return NO;
    }

    NSString* errorText = nil;
    NSWindow* window = CreateWorkbookDocumentWindow(AppDisplayName(), documentSource, &errorText);
    if (window == nil) {
        PresentWorkbookOpenError(standardizedPath, errorText);
        return NO;
    }

    NSURL* representedURL = [window representedURL];
    if (representedURL != nil && [representedURL isFileURL]) {
        [[NSDocumentController sharedDocumentController] noteNewRecentDocumentURL:representedURL];
    }

    _didOpenAnyWorkbook = YES;
    [self persistCurrentWorkbookSession];
    [NSApp activateIgnoringOtherApps:YES];
    return YES;
}

- (void)openWorkbookPaths:(NSArray<NSString*>*)workbookPaths {
    BOOL openedAny = NO;
    for (NSString* workbookPath in UniqueWorkbookPaths(workbookPaths ?: @[])) {
        openedAny = [self openWorkbookPath:workbookPath] || openedAny;
    }

    if (!openedAny && !_didOpenAnyWorkbook) {
        [self openWorkbookPath:@""];
    }
}

- (void)persistCurrentWorkbookSession {
    PersistStoredWorkbookSessionPaths(OpenWorkbookSessionPaths(nil, NO));
}

- (void)rebuildRecentDocumentsMenu:(NSMenu*)menu {
    while ([menu numberOfItems] > 0) {
        [menu removeItemAtIndex:0];
    }

    NSArray<NSURL*>* recentDocumentURLs = [[NSDocumentController sharedDocumentController] recentDocumentURLs];
    NSInteger itemCount = 0;
    for (NSURL* recentURL in recentDocumentURLs) {
        if (![recentURL isFileURL]) {
            continue;
        }

        NSString* workbookPath = [recentURL path];
        if (!IsSupportedWorkbookPath(workbookPath)) {
            continue;
        }

        NSString* displayName = [[NSFileManager defaultManager] displayNameAtPath:workbookPath];
        NSMenuItem* item = [[[NSMenuItem alloc] initWithTitle:[displayName length] > 0 ? displayName : [workbookPath lastPathComponent]
                                                       action:@selector(openRecentDocument:)
                                                keyEquivalent:@""] autorelease];
        [item setTarget:self];
        [item setRepresentedObject:StandardizedWorkbookPath(workbookPath)];
        [menu addItem:item];
        itemCount += 1;
    }

    if (itemCount == 0) {
        NSMenuItem* emptyItem = [[[NSMenuItem alloc] initWithTitle:@"No Recent Documents" action:nil keyEquivalent:@""] autorelease];
        [emptyItem setEnabled:NO];
        [menu addItem:emptyItem];
        return;
    }

    [menu addItem:[NSMenuItem separatorItem]];
    NSMenuItem* clearItem = [[[NSMenuItem alloc] initWithTitle:@"Clear Menu"
                                                        action:@selector(clearRecentDocuments:)
                                                 keyEquivalent:@""] autorelease];
    [clearItem setTarget:self];
    [menu addItem:clearItem];
}

@end

#endif
