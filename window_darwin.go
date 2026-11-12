//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <stdlib.h>

@interface WLAppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler>
@property (strong, nonatomic) NSWindow *window;
@property (strong, nonatomic) WKWebView *webView;
@property (copy, nonatomic) NSString *initialURL;
@end

@implementation WLAppDelegate

- (void)setupMenuBar {
	NSMenu *menubar = [[NSMenu alloc] init];
	[NSApp setMainMenu:menubar];

	// App Menu
	NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
	[menubar addItem:appMenuItem];
	NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"WakeGPU"];
	[appMenu addItemWithTitle:@"Acerca de WakeGPU" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
	[appMenu addItem:[NSMenuItem separatorItem]];
	[appMenu addItemWithTitle:@"Ocultar WakeGPU" action:@selector(hide:) keyEquivalent:@"h"];
	NSMenuItem *hideOthers = [appMenu addItemWithTitle:@"Ocultar otros" action:@selector(hideOtherApplications:) keyEquivalent:@"h"];
	[hideOthers setKeyEquivalentModifierMask:(NSEventModifierFlagCommand | NSEventModifierFlagOption)];
	[appMenu addItemWithTitle:@"Mostrar todo" action:@selector(unhideAllApplications:) keyEquivalent:@""];
	[appMenu addItem:[NSMenuItem separatorItem]];
	[appMenu addItemWithTitle:@"Salir de WakeGPU" action:@selector(terminate:) keyEquivalent:@"q"];
	[appMenuItem setSubmenu:appMenu];

	// Edit Menu (required for Cmd+C / Cmd+V / Cmd+X / Cmd+A / Cmd+Z in WKWebView)
	NSMenuItem *editMenuItem = [[NSMenuItem alloc] init];
	[menubar addItem:editMenuItem];
	NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edición"];
	[editMenu addItemWithTitle:@"Deshacer" action:@selector(undo:) keyEquivalent:@"z"];
	NSMenuItem *redoItem = [editMenu addItemWithTitle:@"Rehacer" action:@selector(redo:) keyEquivalent:@"z"];
	[redoItem setKeyEquivalentModifierMask:(NSEventModifierFlagCommand | NSEventModifierFlagShift)];
	[editMenu addItem:[NSMenuItem separatorItem]];
	[editMenu addItemWithTitle:@"Cortar" action:@selector(cut:) keyEquivalent:@"x"];
	[editMenu addItemWithTitle:@"Copiar" action:@selector(copy:) keyEquivalent:@"c"];
	[editMenu addItemWithTitle:@"Pegar" action:@selector(paste:) keyEquivalent:@"v"];
	[editMenu addItemWithTitle:@"Seleccionar todo" action:@selector(selectAll:) keyEquivalent:@"a"];
	[editMenuItem setSubmenu:editMenu];

	// Window Menu
	NSMenuItem *windowMenuItem = [[NSMenuItem alloc] init];
	[menubar addItem:windowMenuItem];
	NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"Ventana"];
	[windowMenu addItemWithTitle:@"Minimizar" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
	[windowMenu addItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""];
	[windowMenuItem setSubmenu:windowMenu];
	[NSApp setWindowsMenu:windowMenu];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
	[self setupMenuBar];

	NSRect frame = NSMakeRect(0, 0, 1320, 860);
	NSUInteger style = NSWindowStyleMaskTitled |
	                   NSWindowStyleMaskClosable |
	                   NSWindowStyleMaskMiniaturizable |
	                   NSWindowStyleMaskResizable;

	self.window = [[NSWindow alloc] initWithContentRect:frame
	                                          styleMask:style
	                                            backing:NSBackingStoreBuffered
	                                              defer:NO];
	[self.window setTitle:@"WakeGPU"];
	[self.window setMinSize:NSMakeSize(1100, 700)];
	[self.window setBackgroundColor:[NSColor colorWithSRGBRed:0.078 green:0.071 blue:0.063 alpha:1.0]];
	[self.window setDelegate:self];
	[self.window center];

	WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
	WKUserContentController *uc = [[WKUserContentController alloc] init];
	[uc addScriptMessageHandler:self name:@"saveFile"];
	config.userContentController = uc;
	if ([config.preferences respondsToSelector:@selector(setValue:forKey:)]) {
		@try {
			[config.preferences setValue:@YES forKey:@"developerExtrasEnabled"];
		} @catch (NSException *exception) {}
	}

	self.webView = [[WKWebView alloc] initWithFrame:[[self.window contentView] bounds] configuration:config];
	[self.webView setAutoresizingMask:(NSViewWidthSizable | NSViewHeightSizable)];
	[self.webView setUIDelegate:self];
	[self.webView setNavigationDelegate:self];
	if ([self.webView respondsToSelector:@selector(setValue:forKey:)]) {
		@try {
			[self.webView setValue:@NO forKey:@"drawsBackground"];
		} @catch (NSException *exception) {}
	}

	[[self.window contentView] addSubview:self.webView];

	NSURL *nsurl = [NSURL URLWithString:self.initialURL];
	if (nsurl) {
		NSURLRequest *req = [NSURLRequest requestWithURL:nsurl];
		[self.webView loadRequest:req];
	}

	[self.window makeKeyAndOrderFront:nil];
	[NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
	return YES;
}

// Native Save As panel for JS downloads (window.webkit.messageHandlers.saveFile.postMessage({filename, content}))
- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
	if (![message.name isEqualToString:@"saveFile"] || ![message.body isKindOfClass:[NSDictionary class]]) {
		return;
	}
	NSDictionary *dict = (NSDictionary *)message.body;
	NSString *filename = dict[@"filename"] ?: @"download.txt";
	NSString *content = dict[@"content"] ?: @"";

	NSSavePanel *panel = [NSSavePanel savePanel];
	[panel setNameFieldStringValue:filename];
	[panel setCanCreateDirectories:YES];
	[panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
		if (result == NSModalResponseOK && [panel URL]) {
			[content writeToURL:[panel URL] atomically:YES encoding:NSUTF8StringEncoding error:nil];
		}
	}];
}

// Handle <input type="file"> in WKWebView
- (void)webView:(WKWebView *)webView
runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
initiatedByFrame:(WKFrameInfo *)frame
completionHandler:(void (^)(NSArray<NSURL *> *URLs))completionHandler {
	NSOpenPanel *panel = [NSOpenPanel openPanel];
	[panel setCanChooseFiles:YES];
	[panel setCanChooseDirectories:[parameters allowsDirectories]];
	[panel setAllowsMultipleSelection:[parameters allowsMultipleSelection]];
	[panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
		if (result == NSModalResponseOK) {
			completionHandler([panel URLs]);
		} else {
			completionHandler(nil);
		}
	}];
}

// Handle window.alert()
- (void)webView:(WKWebView *)webView
runJavaScriptAlertPanelWithMessage:(NSString *)message
initiatedByFrame:(WKFrameInfo *)frame
completionHandler:(void (^)(void))completionHandler {
	NSAlert *alert = [[NSAlert alloc] init];
	[alert setMessageText:@"WakeGPU"];
	[alert setInformativeText:message ?: @""];
	[alert addButtonWithTitle:@"Aceptar"];
	[alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse returnCode) {
		completionHandler();
	}];
}

// Handle window.confirm()
- (void)webView:(WKWebView *)webView
runJavaScriptConfirmPanelWithMessage:(NSString *)message
initiatedByFrame:(WKFrameInfo *)frame
completionHandler:(void (^)(BOOL result))completionHandler {
	NSAlert *alert = [[NSAlert alloc] init];
	[alert setMessageText:@"WakeGPU"];
	[alert setInformativeText:message ?: @""];
	[alert addButtonWithTitle:@"Aceptar"];
	[alert addButtonWithTitle:@"Cancelar"];
	[alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse returnCode) {
		completionHandler(returnCode == NSAlertFirstButtonReturn);
	}];
}

// Handle window.prompt()
- (void)webView:(WKWebView *)webView
runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt
defaultText:(NSString *)defaultText
initiatedByFrame:(WKFrameInfo *)frame
completionHandler:(void (^)(NSString *result))completionHandler {
	NSAlert *alert = [[NSAlert alloc] init];
	[alert setMessageText:prompt ?: @"WakeGPU"];
	[alert addButtonWithTitle:@"Aceptar"];
	[alert addButtonWithTitle:@"Cancelar"];
	NSTextField *input = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 300, 24)];
	[input setStringValue:defaultText ?: @""];
	[alert setAccessoryView:input];
	[alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse returnCode) {
		if (returnCode == NSAlertFirstButtonReturn) {
			completionHandler([input stringValue]);
		} else {
			completionHandler(nil);
		}
	}];
}

// Handle target="_blank" or window.open
- (WKWebView *)webView:(WKWebView *)webView
createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
forNavigationAction:(WKNavigationAction *)navigationAction
windowFeatures:(WKWindowFeatures *)windowFeatures {
	NSURL *url = navigationAction.request.URL;
	if (url) {
		if ([url.host isEqualToString:@"127.0.0.1"] || [url.host isEqualToString:@"localhost"]) {
			[webView loadRequest:navigationAction.request];
		} else {
			[[NSWorkspace sharedWorkspace] openURL:url];
		}
	}
	return nil;
}

@end

static void runCocoaWindow(const char *cUrl) {
	@autoreleasepool {
		[NSApplication sharedApplication];
		[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
		WLAppDelegate *delegate = [[WLAppDelegate alloc] init];
		delegate.initialURL = [NSString stringWithUTF8String:cUrl];
		[NSApp setDelegate:delegate];
		[NSApp run];
	}
}

static void showCocoaFatal(const char *cMsg) {
	@autoreleasepool {
		[NSApplication sharedApplication];
		[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
		NSAlert *alert = [[NSAlert alloc] init];
		[alert setAlertStyle:NSAlertStyleCritical];
		[alert setMessageText:@"WakeGPU"];
		[alert setInformativeText:[NSString stringWithUTF8String:cMsg]];
		[alert addButtonWithTitle:@"Aceptar"];
		[NSApp activateIgnoringOtherApps:YES];
		[alert runModal];
	}
}
*/
import "C"

import (
	"fmt"
	"os"
	"runtime"
	"unsafe"
)

func init() {
	runtime.LockOSThread()
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	if os.Getenv("CKWB_HEADLESS") == "" {
		cMsg := C.CString(msg)
		C.showCocoaFatal(cMsg)
		C.free(unsafe.Pointer(cMsg))
	}
	os.Exit(1)
}

func runWindow(url string) {
	if os.Getenv("CKWB_HEADLESS") != "" {
		fmt.Println("WakeGPU:", url)
		select {}
	}
	cUrl := C.CString(url)
	defer C.free(unsafe.Pointer(cUrl))
	C.runCocoaWindow(cUrl)
}
