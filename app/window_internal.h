#pragma once

#if defined(__APPLE__)

#import <Cocoa/Cocoa.h>

#include <memory>
#include <string>

@interface DoofBookAppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate> {
    NSString* _initialWorkbookPath;
    BOOL _didReceiveOpenRequest;
    BOOL _didOpenAnyWorkbook;
    BOOL _resolvedLaunchDocuments;
    BOOL _isTerminating;
}

- (instancetype)initWithInitialWorkbookPath:(NSString*)initialWorkbookPath;

@end

struct WorkbookDocumentSource {
    std::string displayPath;
    std::string source;

    WorkbookDocumentSource(std::string displayPathValue, std::string sourceValue)
        : displayPath(std::move(displayPathValue)), source(std::move(sourceValue)) {}
};

static inline NSString* TrimString(NSString* value) {
    return [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

static inline NSString* NSStringFromStdString(const std::string& value) {
    return [NSString stringWithUTF8String:value.c_str()] ?: @"";
}

static inline std::string StdStringOrEmpty(NSString* value) {
    if (value == nil) {
        return std::string();
    }

    const char* utf8 = [value UTF8String];
    return utf8 != nullptr ? std::string(utf8) : std::string();
}

NSString* ResolvedWorkbookFilePath(NSString* sourceLabel);
NSString* WorkbookCachePathForSourceLabel(NSString* sourceLabel);
NSWindow* CreateWorkbookDocumentWindow(NSString* windowTitle, std::shared_ptr<WorkbookDocumentSource> content, NSString** errorText);
NSMenu* BuildApplicationMenu(NSString* appName);

#endif
