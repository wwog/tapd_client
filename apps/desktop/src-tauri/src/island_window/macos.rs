//! AppKit wiring the capsule needs but Tauri does not expose.
//!
//! Two macOS behaviours are fixed here:
//!
//! 1. The capsule never becomes the key window. Clicking it (or its buttons)
//!    keeps focus in the window the user was in — the same effect as Electron's
//!    `focusable: false` plus `acceptFirstMouse`. A window cannot be told that
//!    at runtime, so it is re-classed into a subclass whose
//!    `canBecomeKeyWindow` says no.
//! 2. Hover is tracked natively. Both AppKit's default tracking rect (what tao
//!    uses) and WebKit only report hover for the key window, and this window
//!    deliberately never becomes one. An `NSTrackingArea` with
//!    `NSTrackingActiveAlways` is the only way to hear about the pointer.
//!
//! Pointer enter/exit are forwarded to the frontend as `island://hover`, which
//! turns them into the Agent summary card (the peek).

use std::{ffi::CStr, sync::OnceLock};

use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel},
    sel, AnyThread, DefinedClass, MainThreadMarker,
};
use objc2_app_kit::{NSEvent, NSTrackingArea, NSTrackingAreaOptions, NSView, NSWindow};
use objc2_foundation::{NSObject, NSObjectProtocol, NSRect};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Tauri event carrying `{ active: bool }` on pointer enter/exit.
const HOVER_EVENT: &str = "island://hover";

/// `canBecomeKeyWindow` = NO: clicks, drags and scrolling still reach the
/// webview, but focus never moves to the capsule.
extern "C-unwind" fn can_become_key_window(_this: &'static mut AnyObject, _sel: Sel) -> Bool {
    Bool::NO
}

/// `canBecomeMainWindow` = NO for the same reason.
extern "C-unwind" fn can_become_main_window(_this: &'static mut AnyObject, _sel: Sel) -> Bool {
    Bool::NO
}

/// Builds the subclass from the window's *own* class once. tao hands out a
/// `TaoWindow` and AppKit wraps it in an `NSKVONotifying_*` subclass, so the
/// real class is what has to be extended: deriving from `NSWindow` would drop
/// their overrides *and* change the instance size (AppKit asserts when the KVO
/// wrapper itself is subclassed).
fn non_activating_class(superclass: &'static AnyClass) -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| unsafe {
        let mut builder = ClassBuilder::new(
            CStr::from_bytes_with_nul_unchecked(b"TapdCapsuleWindow\0"),
            superclass,
        )
        .expect("capsule window class already registered");
        builder.add_method(
            sel!(canBecomeKeyWindow),
            can_become_key_window as extern "C-unwind" fn(&'static mut AnyObject, Sel) -> Bool,
        );
        builder.add_method(
            sel!(canBecomeMainWindow),
            can_become_main_window as extern "C-unwind" fn(&'static mut AnyObject, Sel) -> Bool,
        );
        builder.register()
    })
}

struct HoverIvars {
    app: AppHandle,
}

define_class!(
    /// Tracking-area owner. AppKit delivers `mouseEntered:`/`mouseExited:` to
    /// the owner object, so hover detection does not depend on WebKit at all.
    #[unsafe(super(NSObject))]
    #[ivars = HoverIvars]
    struct HoverWatcher;

    impl HoverWatcher {
        #[unsafe(method(mouseEntered:))]
        fn mouse_entered(&self, _event: &NSEvent) {
            self.emit(true);
        }

        #[unsafe(method(mouseExited:))]
        fn mouse_exited(&self, _event: &NSEvent) {
            self.emit(false);
        }
    }
);

unsafe impl NSObjectProtocol for HoverWatcher {}

impl HoverWatcher {
    /// The frontend keeps a boolean, so repeated events cost nothing; keeping
    /// the state here as well would only risk going stale while the capsule is
    /// hidden and no exit is delivered.
    fn emit(&self, active: bool) {
        tracing::debug!(active, "capsule hover");
        let _ = self
            .ivars()
            .app
            .emit(HOVER_EVENT, json!({ "active": active }));
    }
}

/// Re-classes the window and installs the hover tracker. Both have to happen on
/// the main thread; when the caller already is on it the work runs inline so a
/// following `show()` cannot briefly make the capsule the key window.
pub fn install(app: &AppHandle, window: &WebviewWindow) {
    let (Ok(ns_window), Ok(ns_view)) = (window.ns_window(), window.ns_view()) else {
        tracing::warn!("capsule window has no native handle");
        return;
    };
    let ns_window = ns_window as usize;
    let ns_view = ns_view as usize;
    let app_for_events = app.clone();
    let setup = move || unsafe {
        install_now(app_for_events, ns_window, ns_view);
    };
    if MainThreadMarker::new().is_some() {
        setup();
    } else {
        let _ = app.run_on_main_thread(setup);
    }
}

unsafe fn install_now(app: AppHandle, ns_window: usize, ns_view: usize) {
    let window = unsafe { &*(ns_window as *const AnyObject) };
    let mut superclass = AnyObject::class(window);
    while superclass.name().to_bytes().starts_with(b"NSKVONotifying_") {
        superclass = superclass.superclass().expect("KVO class has a superclass");
    }
    let class = non_activating_class(superclass);
    if AnyObject::class(window) != class {
        unsafe { AnyObject::set_class(window, class) };
    }
    let ns_window = unsafe { &*(ns_window as *const NSWindow) };
    // Creating the window from a worker thread queues this call behind the
    // first `show()`; if the capsule grabbed key in between, hand it back.
    if ns_window.isKeyWindow() {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.set_focus();
        }
    }

    // Track the deepest view (wry's webview fills the content view); fall back
    // to the content view when wry has not attached it yet.
    let content = unsafe { &*(ns_view as *const NSView) };
    let subviews = content.subviews();
    let first = subviews.firstObject();
    let target = first.as_deref().unwrap_or(content);

    let watcher: Retained<HoverWatcher> = unsafe {
        let this = HoverWatcher::alloc().set_ivars(HoverIvars { app });
        msg_send![super(this), init]
    };
    let owner = watcher.as_ref() as *const HoverWatcher as *const AnyObject;
    let area = unsafe {
        NSTrackingArea::initWithRect_options_owner_userInfo(
            NSTrackingArea::alloc(),
            // `InVisibleRect` keeps the area glued to the view while the window
            // animates between pill, peek card and update panel.
            NSRect::ZERO,
            NSTrackingAreaOptions::MouseEnteredAndExited
                | NSTrackingAreaOptions::ActiveAlways
                | NSTrackingAreaOptions::InVisibleRect,
            Some(&*owner),
            None,
        )
    };
    target.addTrackingArea(&area);

    // Both live for the rest of the process: the capsule is built once and
    // outlives any owner we could hand them to.
    std::mem::forget(watcher);
    std::mem::forget(area);
}
