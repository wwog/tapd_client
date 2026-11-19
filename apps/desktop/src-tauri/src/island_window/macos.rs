//! AppKit wiring the capsule needs but Tauri does not expose.
//!
//! The capsule never becomes the key window. Clicking it (or its buttons)
//! keeps focus in the window the user was in — the same effect as Electron's
//! `focusable: false` plus `acceptFirstMouse`. A window cannot be told that
//! at runtime, so it is re-classed into a subclass whose
//! `canBecomeKeyWindow` says no. The one exception is the answer field on a
//! question card: typing needs the keyboard, so the rule is lifted for as
//! long as it is focused ([`set_answer_focus`]).

use std::{
    ffi::CStr,
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        OnceLock,
    },
};

use objc2::{
    msg_send,
    runtime::{AnyClass, AnyObject, Bool, ClassBuilder, NSObjectProtocol, Sel},
    sel, MainThreadMarker,
};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSRunningApplication, NSWindow, NSWorkspace,
};
use tauri::{AppHandle, Manager, WebviewWindow};

/// Lifted only while the capsule's answer field is focused: typing needs the
/// keyboard, and a non-key window never receives key events. Everything else
/// keeps the capsule out of the focus chain.
static KEY_ALLOWED: AtomicBool = AtomicBool::new(false);
/// App that had the keyboard before we took it (`0` = none). Handed back when
/// the answer is submitted, so the user lands where they were.
static PREVIOUS_APP: AtomicI32 = AtomicI32::new(0);

/// `canBecomeKeyWindow` = NO: clicks, drags and scrolling still reach the
/// webview, but focus never moves to the capsule — except for the answer field,
/// which lifts the rule through [`KEY_ALLOWED`].
extern "C-unwind" fn can_become_key_window(_this: &'static mut AnyObject, _sel: Sel) -> Bool {
    Bool::from(KEY_ALLOWED.load(Ordering::SeqCst))
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

/// Lets the capsule take the keyboard while its answer field is focused.
///
/// A click into the answer field activates the app (key events only reach the
/// active app) and makes the capsule key. `restore` hands the keyboard back to
/// the app the user came from, which is what makes answering "in place" feel
/// like the capsule never stole focus. The activation is cooperative from
/// macOS 14 on, hence the selector checks instead of a version switch.
pub fn set_answer_focus(app: &AppHandle, active: bool, restore: bool) {
    KEY_ALLOWED.store(active, Ordering::SeqCst);
    let Some(window) = app.get_webview_window(super::WINDOW_LABEL) else {
        return;
    };
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window as usize;
    let app_for_call = app.clone();
    let apply = move || unsafe {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let ns_window = &*(ns_window as *const NSWindow);
        let ns_app = NSApplication::sharedApplication(mtm);
        if active {
            if !ns_app.isActive() {
                if let Some(front) = NSWorkspace::sharedWorkspace().frontmostApplication() {
                    PREVIOUS_APP.store(front.processIdentifier(), Ordering::SeqCst);
                }
            }
            activate_app(&ns_app);
            ns_window.makeKeyWindow();
        } else {
            ns_window.resignKeyWindow();
            let pid = PREVIOUS_APP.swap(0, Ordering::SeqCst);
            if restore && pid > 0 {
                if let Some(previous) =
                    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
                {
                    yield_activation(&ns_app, &previous);
                }
            }
        }
    };
    if MainThreadMarker::new().is_some() {
        apply();
    } else {
        let _ = app_for_call.run_on_main_thread(apply);
    }
}

/// Drops the typing permission without touching focus: the card is going away,
/// so the next click on the capsule must not make it key again.
pub fn reset_answer_focus() {
    KEY_ALLOWED.store(false, Ordering::SeqCst);
    PREVIOUS_APP.store(0, Ordering::SeqCst);
}

/// `activate` exists from macOS 14 (where the old variant became a no-op).
unsafe fn activate_app(ns_app: &NSApplication) {
    if ns_app.respondsToSelector(sel!(activate)) {
        let _: () = msg_send![ns_app, activate];
    } else {
        #[allow(deprecated)]
        ns_app.activateIgnoringOtherApps(true);
    }
}

/// Hands the keyboard back: `yieldActivationToApplication:` on macOS 14+, the
/// deprecated activation option before that.
unsafe fn yield_activation(ns_app: &NSApplication, previous: &NSRunningApplication) {
    if ns_app.respondsToSelector(sel!(yieldActivationToApplication:)) {
        let _: () = msg_send![ns_app, yieldActivationToApplication: previous];
    } else {
        #[allow(deprecated)]
        previous.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
    }
}

/// Resizes the capsule while pinning its top edge and horizontal centre.
///
/// `set_size` then `set_position` are two separate window-server calls, and
/// AppKit keeps the *bottom* edge when only the size changes. Every animation
/// step therefore lifted the whole capsule (the pill lives at the top) and
/// dropped it back on the next call — the shake that was visible while the peek
/// card grew. One `setFrame:display:` moves both in the same commit.
pub fn set_frame_keeping_top_center(window: &WebviewWindow, width: f64, height: f64) {
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window as usize;
    let scale = window.scale_factor().unwrap_or(1.0);
    let apply = move || unsafe {
        let ns_window = &*(ns_window as *const NSWindow);
        let mut frame = ns_window.frame();
        let width = width / scale;
        let height = height / scale;
        frame.origin.x += (frame.size.width - width) / 2.0;
        frame.origin.y += frame.size.height - height;
        frame.size.width = width;
        frame.size.height = height;
        ns_window.setFrame_display(frame, true);
    };
    if MainThreadMarker::new().is_some() {
        apply();
    } else {
        let _ = window.run_on_main_thread(apply);
    }
}

/// Re-classes the window so it cannot become key. This has to happen on the
/// main thread; when the caller already is on it the work runs inline so a
/// following `show()` cannot briefly make the capsule the key window.
pub fn install(app: &AppHandle, window: &WebviewWindow) {
    let Ok(ns_window) = window.ns_window() else {
        tracing::warn!("capsule window has no native handle");
        return;
    };
    let ns_window = ns_window as usize;
    let app_for_setup = app.clone();
    let setup = move || unsafe {
        install_now(app_for_setup, ns_window);
    };
    if MainThreadMarker::new().is_some() {
        setup();
    } else {
        let _ = app.run_on_main_thread(setup);
    }
}

unsafe fn install_now(app: AppHandle, ns_window: usize) {
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
}
