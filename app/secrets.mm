#include "window_internal.h"

#if defined(__APPLE__)

#import <Security/Security.h>

namespace {

static NSString* const kRunDownSecretsService = @"dev.doof.rundown.secrets";

NSData* SecretDataFromString(NSString* value) {
    return [(value ?: @"") dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
}

NSString* StringFromSecretData(NSData* data) {
    if (data == nil) {
        return @"";
    }

    NSString* value = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    return value ?: @"";
}

NSString* NormalizedSecretName(NSString* value) {
    return TrimString(value ?: @"");
}

NSDictionary* SecretLookupQuery(NSString* secretName) {
    return @{
        (id)kSecClass: (id)kSecClassGenericPassword,
        (id)kSecAttrService: kRunDownSecretsService,
        (id)kSecAttrAccount: secretName ?: @""
    };
}

BOOL UpsertSecret(NSString* secretName, NSString* secretValue) {
    NSString* normalizedName = NormalizedSecretName(secretName);
    if ([normalizedName length] == 0) {
        return NO;
    }

    NSData* secretData = SecretDataFromString(secretValue);
    NSDictionary* query = SecretLookupQuery(normalizedName);
    NSDictionary* update = @{
        (id)kSecValueData: secretData
    };

    OSStatus updateStatus = SecItemUpdate((CFDictionaryRef)query, (CFDictionaryRef)update);
    if (updateStatus == errSecSuccess) {
        return YES;
    }

    if (updateStatus != errSecItemNotFound) {
        return NO;
    }

    NSMutableDictionary* addQuery = [NSMutableDictionary dictionaryWithDictionary:query];
    addQuery[(id)kSecValueData] = secretData;
    return SecItemAdd((CFDictionaryRef)addQuery, NULL) == errSecSuccess;
}

BOOL DeleteSecret(NSString* secretName) {
    NSString* normalizedName = NormalizedSecretName(secretName);
    if ([normalizedName length] == 0) {
        return NO;
    }

    OSStatus status = SecItemDelete((CFDictionaryRef)SecretLookupQuery(normalizedName));
    return status == errSecSuccess || status == errSecItemNotFound;
}

NSString* ResolveSecret(NSString* secretName) {
    NSString* normalizedName = NormalizedSecretName(secretName);
    if ([normalizedName length] == 0) {
        return nil;
    }

    NSMutableDictionary* query = [NSMutableDictionary dictionaryWithDictionary:SecretLookupQuery(normalizedName)];
    query[(id)kSecReturnData] = @YES;
    query[(id)kSecMatchLimit] = (id)kSecMatchLimitOne;

    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((CFDictionaryRef)query, &result);
    if (status != errSecSuccess || result == NULL) {
        return nil;
    }

    NSData* data = [(NSData*)result autorelease];
    return StringFromSecretData(data);
}

void PresentSecretPanelError(NSString* messageText, NSString* informativeText, NSWindow* window) {
    NSAlert* alert = [[[NSAlert alloc] init] autorelease];
    [alert setAlertStyle:NSAlertStyleWarning];
    [alert setMessageText:messageText ?: @"Secret could not be saved."];
    [alert setInformativeText:informativeText ?: @""];
    if (window != nil) {
        [alert beginSheetModalForWindow:window completionHandler:nil];
        return;
    }

    [alert runModal];
}

NSTextField* RunDownLabel(NSString* text, NSFont* font, NSColor* color, NSRect frame) {
    NSTextField* label = [[[NSTextField alloc] initWithFrame:frame] autorelease];
    [label setStringValue:text ?: @""];
    [label setBezeled:NO];
    [label setDrawsBackground:NO];
    [label setEditable:NO];
    [label setSelectable:NO];
    [label setFont:font ?: [NSFont systemFontOfSize:[NSFont systemFontSize]]];
    [label setTextColor:color ?: [NSColor labelColor]];
    return label;
}

NSBox* RunDownSeparator(NSRect frame) {
    NSBox* separator = [[[NSBox alloc] initWithFrame:frame] autorelease];
    [separator setBoxType:NSBoxSeparator];
    return separator;
}

} // namespace

@interface RunDownSecretsPanelController : NSObject <NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate, NSTextFieldDelegate, NSWindowDelegate> {
    NSWindow* _window;
    NSTableView* _tableView;
    NSSearchField* _searchField;
    NSTextField* _nameField;
    NSSecureTextField* _valueField;
    NSButton* _saveButton;
    NSButton* _deleteButton;
    NSTextField* _countLabel;
    NSTextField* _emptyLabel;
    NSTextField* _statusLabel;
    NSArray<NSString*>* _allSecretNames;
    NSArray<NSString*>* _secretNames;
}

- (void)runModalForParentWindow:(NSWindow*)parentWindow;

@end

@implementation RunDownSecretsPanelController

- (instancetype)init {
    self = [super init];
    if (self == nil) {
        return nil;
    }

    _allSecretNames = [RunDownSecretNames() retain];
    _secretNames = [_allSecretNames retain];

    _window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 680, 430)
                                         styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
                                           backing:NSBackingStoreBuffered
                                             defer:NO];
    [_window setTitle:@"Secrets"];
    [_window setMinSize:NSMakeSize(620, 390)];
    [_window setReleasedWhenClosed:NO];
    [_window setDelegate:self];

    NSView* content = [_window contentView];
    [content setWantsLayer:YES];
    [[content layer] setBackgroundColor:[[NSColor windowBackgroundColor] CGColor]];

    NSVisualEffectView* sidebar = [[[NSVisualEffectView alloc] initWithFrame:NSMakeRect(0, 0, 260, 430)] autorelease];
    [sidebar setMaterial:NSVisualEffectMaterialSidebar];
    [sidebar setBlendingMode:NSVisualEffectBlendingModeWithinWindow];
    [sidebar setState:NSVisualEffectStateActive];
    [sidebar setAutoresizingMask:NSViewHeightSizable | NSViewMaxXMargin];
    [content addSubview:sidebar];

    [content addSubview:RunDownSeparator(NSMakeRect(260, 0, 1, 430))];

    NSTextField* sidebarTitle = RunDownLabel(@"Keychain Secrets", [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold], [NSColor labelColor], NSMakeRect(16, 392, 228, 18));
    [sidebar addSubview:sidebarTitle];

    _searchField = [[NSSearchField alloc] initWithFrame:NSMakeRect(16, 358, 228, 28)];
    [_searchField setPlaceholderString:@"Search secrets"];
    [_searchField setDelegate:self];
    [sidebar addSubview:_searchField];

    NSScrollView* scrollView = [[[NSScrollView alloc] initWithFrame:NSMakeRect(16, 72, 228, 274)] autorelease];
    [scrollView setBorderType:NSBezelBorder];
    [scrollView setHasVerticalScroller:YES];
    [scrollView setAutoresizingMask:NSViewHeightSizable | NSViewMaxXMargin | NSViewWidthSizable];

    _tableView = [[NSTableView alloc] initWithFrame:[[scrollView contentView] bounds]];
    NSTableColumn* column = [[[NSTableColumn alloc] initWithIdentifier:@"name"] autorelease];
    [column setTitle:@"Secret"];
    [column setWidth:228];
    [_tableView addTableColumn:column];
    [_tableView setHeaderView:nil];
    [_tableView setRowHeight:34];
    [_tableView setIntercellSpacing:NSMakeSize(0, 0)];
    [_tableView setDelegate:self];
    [_tableView setDataSource:self];
    [_tableView setAllowsEmptySelection:YES];
    [scrollView setDocumentView:_tableView];
    [sidebar addSubview:scrollView];

    _emptyLabel = [RunDownLabel(@"No secrets yet", [NSFont systemFontOfSize:13], [NSColor secondaryLabelColor], NSMakeRect(16, 198, 228, 20)) retain];
    [_emptyLabel setAlignment:NSTextAlignmentCenter];
    [sidebar addSubview:_emptyLabel];

    NSButton* newButton = [[[NSButton alloc] initWithFrame:NSMakeRect(16, 24, 92, 32)] autorelease];
    [newButton setTitle:@"New"];
    [newButton setBezelStyle:NSBezelStyleRounded];
    [newButton setTarget:self];
    [newButton setAction:@selector(newSecret:)];
    [sidebar addSubview:newButton];

    _deleteButton = [[NSButton alloc] initWithFrame:NSMakeRect(116, 24, 92, 32)];
    [_deleteButton setTitle:@"Delete"];
    [_deleteButton setBezelStyle:NSBezelStyleRounded];
    [_deleteButton setTarget:self];
    [_deleteButton setAction:@selector(deleteSecret:)];
    [sidebar addSubview:_deleteButton];

    _countLabel = [RunDownLabel(@"", [NSFont systemFontOfSize:11], [NSColor secondaryLabelColor], NSMakeRect(16, 52, 228, 16)) retain];
    [sidebar addSubview:_countLabel];

    NSTextField* titleLabel = RunDownLabel(@"Manage Secrets", [NSFont systemFontOfSize:24 weight:NSFontWeightSemibold], [NSColor labelColor], NSMakeRect(294, 374, 340, 32));
    [titleLabel setAutoresizingMask:NSViewMinYMargin | NSViewWidthSizable];
    [content addSubview:titleLabel];

    NSTextField* subtitleLabel = RunDownLabel(@"Store API tokens and passwords in Keychain, then bind them to workbook <secret> slots.", [NSFont systemFontOfSize:13], [NSColor secondaryLabelColor], NSMakeRect(296, 338, 340, 36));
    [subtitleLabel setLineBreakMode:NSLineBreakByWordWrapping];
    [subtitleLabel setAutoresizingMask:NSViewMinYMargin | NSViewWidthSizable];
    [content addSubview:subtitleLabel];

    [content addSubview:RunDownSeparator(NSMakeRect(296, 314, 340, 1))];

    NSTextField* nameLabel = RunDownLabel(@"Name", [NSFont systemFontOfSize:12 weight:NSFontWeightSemibold], [NSColor labelColor], NSMakeRect(296, 276, 340, 18));
    [content addSubview:nameLabel];

    _nameField = [[NSTextField alloc] initWithFrame:NSMakeRect(296, 248, 340, 28)];
    [_nameField setPlaceholderString:@"SECRET_ACCESS_KEY"];
    [_nameField setDelegate:self];
    [content addSubview:_nameField];

    NSTextField* valueLabel = RunDownLabel(@"Value", [NSFont systemFontOfSize:12 weight:NSFontWeightSemibold], [NSColor labelColor], NSMakeRect(296, 202, 340, 18));
    [content addSubview:valueLabel];

    _valueField = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(296, 174, 340, 28)];
    [_valueField setPlaceholderString:@"Type a new value to create or replace"];
    [_valueField setDelegate:self];
    [content addSubview:_valueField];

    NSTextField* noteLabel = RunDownLabel(@"Stored values are hidden after saving. To rotate a secret, select it, enter the replacement value, and save.", [NSFont systemFontOfSize:12], [NSColor secondaryLabelColor], NSMakeRect(296, 124, 340, 38));
    [noteLabel setLineBreakMode:NSLineBreakByWordWrapping];
    [content addSubview:noteLabel];

    _statusLabel = [RunDownLabel(@"", [NSFont systemFontOfSize:12], [NSColor secondaryLabelColor], NSMakeRect(296, 86, 340, 20)) retain];
    [content addSubview:_statusLabel];

    _saveButton = [[NSButton alloc] initWithFrame:NSMakeRect(296, 24, 128, 32)];
    [_saveButton setTitle:@"Save Secret"];
    [_saveButton setBezelStyle:NSBezelStyleRounded];
    [_saveButton setTarget:self];
    [_saveButton setAction:@selector(saveSecret:)];
    [_saveButton setKeyEquivalent:@"\r"];
    [content addSubview:_saveButton];

    NSButton* closeButton = [[[NSButton alloc] initWithFrame:NSMakeRect(546, 24, 90, 32)] autorelease];
    [closeButton setTitle:@"Close"];
    [closeButton setBezelStyle:NSBezelStyleRounded];
    [closeButton setTarget:self];
    [closeButton setAction:@selector(closePanel:)];
    [closeButton setKeyEquivalent:@"\033"];
    [content addSubview:closeButton];

    [self updateListDecorations];
    [self updateActionState];
    [self setStatusText:@"Ready."];

    return self;
}

- (void)dealloc {
    [_window setDelegate:nil];
    [_searchField setDelegate:nil];
    [_nameField setDelegate:nil];
    [_valueField setDelegate:nil];
    [_tableView setDelegate:nil];
    [_tableView setDataSource:nil];
    [_allSecretNames release];
    [_secretNames release];
    [_tableView release];
    [_searchField release];
    [_nameField release];
    [_valueField release];
    [_saveButton release];
    [_deleteButton release];
    [_countLabel release];
    [_emptyLabel release];
    [_statusLabel release];
    [_window release];
    [super dealloc];
}

- (void)setStatusText:(NSString*)statusText {
    [_statusLabel setStringValue:statusText ?: @""];
}

- (NSString*)selectedSecretName {
    NSInteger row = [_tableView selectedRow];
    if (row < 0 || row >= (NSInteger)[_secretNames count]) {
        return @"";
    }

    return _secretNames[(NSUInteger)row];
}

- (void)applySecretFilterKeepingSelection:(NSString*)selectedName {
    NSString* query = TrimString([_searchField stringValue] ?: @"");
    NSMutableArray<NSString*>* filteredNames = [NSMutableArray array];
    for (NSString* secretName in _allSecretNames ?: @[]) {
        if ([query length] == 0 || [secretName rangeOfString:query options:NSCaseInsensitiveSearch | NSDiacriticInsensitiveSearch].location != NSNotFound) {
            [filteredNames addObject:secretName];
        }
    }

    [_secretNames release];
    _secretNames = [filteredNames retain];
    [_tableView reloadData];
    [self updateListDecorations];

    if ([selectedName length] > 0) {
        NSUInteger row = [_secretNames indexOfObject:selectedName];
        if (row != NSNotFound) {
            [_tableView selectRowIndexes:[NSIndexSet indexSetWithIndex:row] byExtendingSelection:NO];
        }
    }
}

- (void)reloadSecretNamesKeepingSelection:(NSString*)selectedName {
    [_allSecretNames release];
    _allSecretNames = [RunDownSecretNames() retain];
    [self applySecretFilterKeepingSelection:selectedName];
}

- (void)updateListDecorations {
    NSUInteger totalCount = [_allSecretNames count];
    if (totalCount == 0) {
        [_countLabel setStringValue:@"No saved secrets"];
    } else if (totalCount == 1) {
        [_countLabel setStringValue:@"1 saved secret"];
    } else {
        [_countLabel setStringValue:[NSString stringWithFormat:@"%lu saved secrets", (unsigned long)totalCount]];
    }

    BOOL hasVisibleRows = [_secretNames count] > 0;
    [_emptyLabel setHidden:hasVisibleRows];
    if (totalCount > 0 && !hasVisibleRows) {
        [_emptyLabel setStringValue:@"No matching secrets"];
    } else {
        [_emptyLabel setStringValue:@"No secrets yet"];
    }
}

- (void)updateActionState {
    NSString* secretName = NormalizedSecretName([_nameField stringValue]);
    NSString* secretValue = [_valueField stringValue] ?: @"";
    BOOL hasSelection = [[self selectedSecretName] length] > 0;
    [_saveButton setEnabled:[secretName length] > 0 && [secretValue length] > 0];
    [_deleteButton setEnabled:hasSelection || [secretName length] > 0];
}

- (void)controlTextDidChange:(NSNotification*)notification {
    id object = [notification object];
    if (object == _searchField) {
        [self applySecretFilterKeepingSelection:[self selectedSecretName]];
        [self updateActionState];
        return;
    }

    [self updateActionState];
}

- (void)runModalForParentWindow:(NSWindow*)parentWindow {
    [_window center];
    if (parentWindow != nil) {
        [parentWindow beginSheet:_window completionHandler:nil];
    }

    [NSApp runModalForWindow:_window];

    if (parentWindow != nil && [_window sheetParent] != nil) {
        [parentWindow endSheet:_window];
    }
    [_window orderOut:nil];
}

- (NSInteger)numberOfRowsInTableView:(NSTableView*)tableView {
    (void)tableView;
    return (NSInteger)[_secretNames count];
}

- (NSView*)tableView:(NSTableView*)tableView viewForTableColumn:(NSTableColumn*)tableColumn row:(NSInteger)row {
    (void)tableView;
    (void)tableColumn;
    if (row < 0 || row >= (NSInteger)[_secretNames count]) {
        return nil;
    }

    NSTableCellView* cell = [_tableView makeViewWithIdentifier:@"SecretNameCell" owner:self];
    if (cell == nil) {
        cell = [[[NSTableCellView alloc] initWithFrame:NSMakeRect(0, 0, 228, 34)] autorelease];
        [cell setIdentifier:@"SecretNameCell"];

        NSTextField* textField = RunDownLabel(@"", [NSFont systemFontOfSize:13], [NSColor labelColor], NSMakeRect(10, 8, 206, 18));
        [textField setLineBreakMode:NSLineBreakByTruncatingMiddle];
        [textField setAutoresizingMask:NSViewWidthSizable];
        [cell setTextField:textField];
        [cell addSubview:textField];
    }

    [[cell textField] setStringValue:_secretNames[(NSUInteger)row]];
    return cell;
}

- (void)tableViewSelectionDidChange:(NSNotification*)notification {
    (void)notification;
    NSString* secretName = [self selectedSecretName];
    if ([secretName length] == 0) {
        [self updateActionState];
        return;
    }

    [_nameField setStringValue:secretName];
    [_valueField setStringValue:@""];
    [self setStatusText:@"Selected. Stored value remains hidden."];
    [self updateActionState];
}

- (IBAction)newSecret:(id)sender {
    (void)sender;
    [_tableView deselectAll:nil];
    [_nameField setStringValue:@""];
    [_valueField setStringValue:@""];
    [self setStatusText:@"Ready to add a new secret."];
    [self updateActionState];
    [_window makeFirstResponder:_nameField];
}

- (IBAction)saveSecret:(id)sender {
    (void)sender;
    NSString* secretName = NormalizedSecretName([_nameField stringValue]);
    NSString* secretValue = [_valueField stringValue] ?: @"";
    if ([secretName length] == 0) {
        PresentSecretPanelError(@"Secret name is required.", @"Choose a stable name such as SECRET_ACCESS_KEY.", _window);
        return;
    }

    if ([secretValue length] == 0) {
        PresentSecretPanelError(@"Secret value is required.", @"Type the value you want stored in Keychain.", _window);
        return;
    }

    if (!UpsertSecret(secretName, secretValue)) {
        PresentSecretPanelError(@"Secret could not be saved.", @"The Keychain rejected the update.", _window);
        return;
    }

    [_nameField setStringValue:secretName];
    [_valueField setStringValue:@""];
    [self reloadSecretNamesKeepingSelection:secretName];
    [self setStatusText:@"Saved to Keychain."];
    [self updateActionState];
}

- (IBAction)deleteSecret:(id)sender {
    (void)sender;
    NSString* secretName = NormalizedSecretName([_nameField stringValue]);
    if ([secretName length] == 0) {
        NSInteger row = [_tableView selectedRow];
        if (row >= 0 && row < (NSInteger)[_secretNames count]) {
            secretName = _secretNames[(NSUInteger)row];
        }
    }

    if ([secretName length] == 0) {
        return;
    }

    NSAlert* alert = [[[NSAlert alloc] init] autorelease];
    [alert setAlertStyle:NSAlertStyleWarning];
    [alert setMessageText:[NSString stringWithFormat:@"Delete %@?", secretName]];
    [alert setInformativeText:@"This removes the Keychain item. Workbook bindings that reference this name will become unavailable until another secret with the same name is saved."];
    [alert addButtonWithTitle:@"Delete"];
    [alert addButtonWithTitle:@"Cancel"];
    if ([alert runModal] != NSAlertFirstButtonReturn) {
        return;
    }

    if (!DeleteSecret(secretName)) {
        PresentSecretPanelError(@"Secret could not be deleted.", @"The Keychain rejected the delete request.", _window);
        return;
    }

    [_nameField setStringValue:@""];
    [_valueField setStringValue:@""];
    [self reloadSecretNamesKeepingSelection:@""];
    [self setStatusText:@"Deleted from Keychain."];
    [self updateActionState];
}

- (IBAction)closePanel:(id)sender {
    (void)sender;
    [NSApp stopModal];
}

- (void)windowWillClose:(NSNotification*)notification {
    (void)notification;
    [NSApp stopModal];
}

@end

NSArray<NSString*>* RunDownSecretNames(void) {
    NSDictionary* query = @{
        (id)kSecClass: (id)kSecClassGenericPassword,
        (id)kSecAttrService: kRunDownSecretsService,
        (id)kSecReturnAttributes: @YES,
        (id)kSecMatchLimit: (id)kSecMatchLimitAll
    };

    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((CFDictionaryRef)query, &result);
    if (status == errSecItemNotFound || result == NULL) {
        return @[];
    }

    if (status != errSecSuccess) {
        if (result != NULL) {
            CFRelease(result);
        }
        return @[];
    }

    id bridgedResult = [(id)result autorelease];
    NSMutableArray<NSString*>* names = [NSMutableArray array];
    NSArray* rows = [bridgedResult isKindOfClass:[NSArray class]] ? (NSArray*)bridgedResult : @[bridgedResult];
    for (id row in rows) {
        NSDictionary* attributes = [row isKindOfClass:[NSDictionary class]] ? (NSDictionary*)row : nil;
        NSString* account = [attributes[(id)kSecAttrAccount] isKindOfClass:[NSString class]]
            ? (NSString*)attributes[(id)kSecAttrAccount]
            : @"";
        if ([account length] > 0 && ![names containsObject:account]) {
            [names addObject:account];
        }
    }

    [names sortUsingSelector:@selector(localizedCaseInsensitiveCompare:)];
    return names;
}

NSDictionary<NSString*, NSString*>* RunDownResolveSecrets(NSArray<NSString*>* secretNames) {
    NSMutableDictionary<NSString*, NSString*>* values = [NSMutableDictionary dictionary];
    for (id item in secretNames ?: @[]) {
        if (![item isKindOfClass:[NSString class]]) {
            continue;
        }

        NSString* secretName = NormalizedSecretName((NSString*)item);
        NSString* secretValue = ResolveSecret(secretName);
        if ([secretName length] > 0 && secretValue != nil) {
            values[secretName] = secretValue;
        }
    }
    return values;
}

void RunDownPresentSecretsPanel(NSWindow* parentWindow) {
    RunDownSecretsPanelController* controller = [[[RunDownSecretsPanelController alloc] init] autorelease];
    [controller runModalForParentWindow:parentWindow];
}

#endif
