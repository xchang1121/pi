// Modified for Pi's speculative-action sandbox migration.
//! Native sandbox backend used by Pi speculative actions.

use std::ffi::OsString;

pub mod protocol;
#[cfg(unix)]
mod unix_process;

#[cfg(windows)]
mod appcontainer;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows_native;

#[cfg(windows)]
pub mod sid;
#[cfg(windows)]
pub mod util;

#[cfg(windows)]
pub mod job;
#[cfg(windows)]
pub mod launch;
#[cfg(windows)]
pub mod self_protect;
#[cfg(windows)]
pub mod token;
#[cfg(windows)]
pub mod winsta;

#[cfg(windows)]
pub mod acl;

pub fn native_main(args: impl IntoIterator<Item = OsString>) -> i32 {
    let args = args.into_iter().collect::<Vec<_>>();
    if args.get(1).and_then(|value| value.to_str()) == Some("--native-sandbox") {
        return protocol::run(&args[2..]);
    }

    #[cfg(windows)]
    if args.get(1).and_then(|value| value.to_str()) == Some("--windows-appcontainer-run") {
        return windows_native::run_internal(&args[2..]);
    }

    eprintln!("pi-sandbox-native: expected --native-sandbox");
    2
}
