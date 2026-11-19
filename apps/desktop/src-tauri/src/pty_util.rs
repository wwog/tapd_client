//! Helpers shared by the interactive terminal and the built-in agent runtime.
//!
//! Both families of child processes are started in their own session, and both
//! output readers must not split a multi-byte character across two frames.

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

/// Signals a whole process group. Children are spawned in their own session,
/// so their pid is also the group id.
pub(crate) fn kill_process_group(pid: u32, signal: i32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: plain syscall wrapper, no memory is shared.
    unsafe { kill(-(pid as i32), signal) == 0 }
}

#[cfg(not(unix))]
pub(crate) fn kill_process_group(_pid: u32, _signal: i32) -> bool {
    false
}

/// Takes the longest valid UTF-8 prefix out of `buffer`, leaving the rest.
///
/// A genuinely invalid byte would block the buffer forever, so it is emitted
/// (the terminal shows U+FFFD) and the reader keeps going.
pub(crate) fn take_utf8_prefix(buffer: &mut Vec<u8>) -> Vec<u8> {
    let cut = match std::str::from_utf8(buffer) {
        Ok(_) => buffer.len(),
        Err(error) => {
            let valid = error.valid_up_to();
            if error.error_len().is_some() {
                valid.max(1)
            } else {
                valid
            }
        }
    };
    if cut == 0 {
        return Vec::new();
    }
    let rest = buffer.split_off(cut);
    std::mem::replace(buffer, rest)
}
