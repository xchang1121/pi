// Modified for Pi's speculative-action sandbox migration.
//! Launch and supervise a Windows AppContainer process.

use anyhow::{Context, Result, anyhow};
use std::ffi::c_void;
use std::fs::File;
use std::mem::{size_of, zeroed};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0,
};
use windows::Win32::Security::SECURITY_CAPABILITIES;
use windows::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    CreateProcessAsUserW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetCurrentProcess, GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES,
    STARTUPINFOEXW, STARTUPINFOW, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR};

use crate::job::{Job, is_process_in_job};
use crate::self_protect;
use crate::token::{self, open_self_token, to_primary};
use crate::util::{pcwstr, wstr};
use crate::winsta::IsolatedDesk;

// ─── RAII handle wrappers ───────────────────────────────────────────

use crate::util::OwnedHandle;

/// Owns a freshly-spawned (suspended) child. If dropped before
/// [`defuse`] is called, terminates the child — so an error
/// between `CreateProcess*` and `WaitForSingleObject` can't orphan
/// a suspended process that's not yet in the job. Always closes
/// both handles on drop.
pub(crate) struct SpawnedChild {
    pi: PROCESS_INFORMATION,
    armed: bool,
}
impl SpawnedChild {
    pub(crate) fn new(pi: PROCESS_INFORMATION) -> Self {
        Self { pi, armed: true }
    }
    pub(crate) fn process(&self) -> HANDLE {
        self.pi.hProcess
    }
    pub(crate) fn thread(&self) -> HANDLE {
        self.pi.hThread
    }
    /// Disarm the terminate-on-drop. Call after the child has been
    /// assigned to the job AND resumed — past that point
    /// `KILL_ON_JOB_CLOSE` covers cleanup.
    pub(crate) fn defuse(&mut self) {
        self.armed = false;
    }
}
impl Drop for SpawnedChild {
    fn drop(&mut self) {
        unsafe {
            if self.armed {
                let _ = TerminateProcess(self.pi.hProcess, 1);
            }
            let _ = CloseHandle(self.pi.hThread);
            let _ = CloseHandle(self.pi.hProcess);
        }
    }
}

// ─── Process-creation mitigation-policy bits ────────────────────────
//
// The `windows` crate exposes `PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY`
// but not the per-bit DWORD64 macros (they're winnt.h preprocessor
// `#define`s, still absent as of 0.62). Each policy occupies a 4-bit
// slot in the u64; `..._ALWAYS_ON` flips bit 0 of its slot.
//
// Only mitigations that don't break Node/Python JIT or mingw-built
// shells are enabled here. Specifically NOT enabled:
//   - `IMAGE_LOAD_PREFER_SYSTEM32` — flips DLL search-order so System32
//     wins over the EXE's directory; breaks the cygwin1.dll /
//     msys-2.0.dll resolution model.
//   - `CONTROL_FLOW_GUARD_ALWAYS_ON` — forces CFG even when the EXE
//     wasn't built with `/guard:cf`; stock mingw-built `bash.exe`
//     dies in `dofork`. CFG is defense-in-depth, not a primary
//     boundary.

/// Bit 32 — block legacy AppInit / IME / Winsock-LSP DLL injection
/// and `SetWindowsHookEx`.
const MITIGATION_EXTENSION_POINT_DISABLE: u64 = 1u64 << 32;
/// Bit 48 — block GDI from loading non-system fonts (historic
/// kernel font-parser RCE surface; sandbox children are
/// console/network workloads).
const MITIGATION_FONT_DISABLE: u64 = 1u64 << 48;
/// Bit 52 — refuse `LoadLibrary` from UNC / network paths.
const MITIGATION_IMAGE_LOAD_NO_REMOTE: u64 = 1u64 << 52;
/// Bit 56 — refuse `LoadLibrary` of any image whose mandatory label
/// is Low IL.
const MITIGATION_IMAGE_LOAD_NO_LOW_LABEL: u64 = 1u64 << 56;

/// Run a command with zero AppContainer capabilities on a private desktop.
/// `env_overlay` is the complete child environment, not an overlay on the
/// broker's environment.
pub fn run_lockdown(
    target_exe: &Path,
    target_args: &[String],
    env_overlay: &[(String, String)],
    input: Option<&File>,
    appcontainer: &mut SECURITY_CAPABILITIES,
    desktop: &mut IsolatedDesk,
) -> Result<u32> {
    // Protect the unrestricted broker before a child can use it as a
    // parent-process escape target.
    self_protect::install_broker_dacl().context("protect AppContainer broker")?;

    // AppContainer is the isolation boundary. A second restricted-token layer
    // breaks classic tool runtimes without strengthening that boundary.
    let self_tok = OwnedHandle(open_self_token()?);
    let primary = OwnedHandle(to_primary(self_tok.raw()).context("to_primary")?);

    // 3) Job. `breakaway_ok = false` — this is the load-bearing
    //    containment Job; the child must NOT be able to break away.
    let job = Job::sandbox().context("Job::sandbox")?;

    let caller_in_job = is_process_in_job(unsafe { GetCurrentProcess() }, None);
    // The internal broker is in an outer supervisor job. Break away before
    // assigning the child to the stricter sandbox job.
    let breakaway = if caller_in_job {
        CREATE_BREAKAWAY_FROM_JOB
    } else {
        PROCESS_CREATION_FLAGS(0)
    };
    let dbg = std::env::var_os("PI_SANDBOX_NATIVE_WIN_DEBUG").is_some();
    if dbg {
        eprintln!(
            "pi-sandbox-native: run_lockdown: caller_in_job={} breakaway={}",
            caller_in_job,
            breakaway.0 != 0,
        );
    }

    // The environment block contains exactly the resolved invocation.
    let mut env = build_env_block(env_overlay);

    // 6) Command line + application name.
    let cmdline = build_cmdline(target_exe, target_args);
    let mut cmdline_w = wstr(&cmdline);
    let app_w = wstr(&target_exe.display().to_string());

    // 7) PROC_THREAD_ATTRIBUTE_LIST: mitigation policy + explicit
    //    handle whitelist.
    let mitigation: u64 = MITIGATION_EXTENSION_POINT_DISABLE
        | MITIGATION_FONT_DISABLE
        | MITIGATION_IMAGE_LOAD_NO_REMOTE
        | MITIGATION_IMAGE_LOAD_NO_LOW_LABEL;
    let std_handles = collect_inheritable_std_handles(input);
    let mut handle_list: Vec<HANDLE> = std_handles
        .iter()
        .copied()
        .filter(|h| !h.0.is_null())
        .collect();
    if handle_list.is_empty() {
        return Err(anyhow!(
            "no std handle is inheritable; refusing to spawn. \
             pi-sandbox-native requires at least one piped stdio stream."
        ));
    }
    let mut attrs = ProcThreadAttrs::new(3)?;
    attrs.set_mitigation_policy(&mitigation)?;
    attrs.set_handle_list(&mut handle_list)?;
    attrs.set_security_capabilities(appcontainer)?;

    // 8) STARTUPINFOEXW. `STARTF_USESTDHANDLES` + the caller's std
    //    handles is load-bearing: the internal broker has NO console; its
    //    stdio are the outer broker's anonymous pipes. Without explicit
    //    `hStd*`
    //    wiring the child would try to allocate a conhost on the
    //    non-interactive desktop and hang.
    let mut six: STARTUPINFOEXW = unsafe { zeroed() };
    six.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    six.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    six.StartupInfo.hStdInput = std_handles[0];
    six.StartupInfo.hStdOutput = std_handles[1];
    six.StartupInfo.hStdError = std_handles[2];
    six.StartupInfo.lpDesktop = PWSTR(desktop.desktop_name_ptr());
    six.lpAttributeList = attrs.list();

    // 9) Spawn suspended. `breakaway` was derived above (gated on
    //    `IsProcessInJob(self)`).
    let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };
    unsafe {
        CreateProcessAsUserW(
            Some(primary.raw()),
            pcwstr(&app_w),
            Some(PWSTR(cmdline_w.as_mut_ptr())),
            None,
            None,
            // Must be TRUE for `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`
            // to take effect (documented Vista-era quirk: with
            // FALSE the kernel ignores the attribute entirely).
            true,
            // The internal broker has no console for the child to attach to.
            CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT
                | CREATE_NO_WINDOW
                | breakaway,
            Some(env.as_mut_ptr() as *const c_void),
            // Inherit cwd.
            PCWSTR::null(),
            // STARTUPINFOEXW is layout-compatible (StartupInfo is
            // first member); EXTENDED_STARTUPINFO_PRESENT tells the
            // kernel to read past it for lpAttributeList.
            &six.StartupInfo as *const STARTUPINFOW,
            &mut pi,
        )
        .with_context(|| format!("CreateProcessAsUserW({})", target_exe.display()))?;
    }

    // The child exists, suspended, NOT yet in the job. Wrap it
    // in a guard so any `?` from here to `defuse()` terminates
    // it — `KILL_ON_JOB_CLOSE` can't help until after `assign`.
    let mut child = SpawnedChild::new(pi);
    if !token::process_is_app_container(child.process())? {
        return Err(anyhow!("created child token is not an AppContainer"));
    }

    // 10) Assign to job → resume. ResumeThread returns the
    //     previous suspend count, or u32::MAX on failure — a
    //     failure here would leave the child suspended in the
    //     job and `WaitForSingleObject(INFINITE)` below would
    //     hang the broker forever. Check before defusing the
    //     terminate-on-drop guard.
    if let Err(e) = job.assign(child.process()) {
        // Self-explaining diagnostics for the next CI run: which
        // job(s) the child landed in despite breakaway.
        let in_any = is_process_in_job(child.process(), None);
        let in_ours = is_process_in_job(child.process(), Some(job.raw()));
        return Err(e).with_context(|| {
            format!(
                "AssignProcessToJobObject(child) — \
                 caller_in_job={caller_in_job} breakaway={} \
                 child_in_any_job={in_any} child_in_our_job={in_ours}",
                breakaway.0 != 0,
            )
        });
    }
    let prev_suspend = unsafe { ResumeThread(child.thread()) };
    if prev_suspend == u32::MAX {
        return Err(anyhow!("ResumeThread: {}", std::io::Error::last_os_error()));
    }
    // From here the job owns lifetime; disarm terminate-on-drop.
    child.defuse();
    if dbg {
        // Post-spawn diagnostic — paired with the pre-spawn line above
        // so a hung CI run can tell whether `WaitForSingleObject` is
        // the wait point (this line present) or spawn/assign/resume
        // itself is the stall (this line absent).
        eprintln!(
            "pi-sandbox-native: run_lockdown: child pid={} assigned+resumed \
             (prev_suspend={prev_suspend}); waiting",
            pi.dwProcessId,
        );
    }

    // 11) Wait + collect exit code.
    let rc = unsafe { WaitForSingleObject(child.process(), INFINITE) };
    if rc != WAIT_OBJECT_0 {
        eprintln!(
            "pi-sandbox-native: WaitForSingleObject returned 0x{:x}",
            rc.0
        );
    }
    let mut code: u32 = 0;
    unsafe {
        GetExitCodeProcess(child.process(), &mut code).context("GetExitCodeProcess")?;
    }
    // `child` (closes hProcess/hThread), `primary`, and `self_tok` all drop here.
    // Keep `attrs` (its backing buffer + the borrowed `mitigation`
    // and `handle_list`) and `job` alive until here. The kernel
    // snapshots the attribute list at CreateProcess time, but
    // DeleteProcThreadAttributeList (in attrs.drop) may re-read
    // pointers.
    drop(attrs);
    drop(handle_list);
    drop(job);
    Ok(code)
}

// ─── Environment block ──────────────────────────────────────────────

/// Build a `CREATE_UNICODE_ENVIRONMENT` block from the resolved key/value
/// pairs. No broker environment variable is inherited implicitly.
fn build_env_block(overlay: &[(String, String)]) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    let mut entries: Vec<(std::ffi::OsString, std::ffi::OsString)> = Vec::new();
    for (k, v) in overlay {
        entries.push((k.into(), v.into()));
    }

    // Order the block case-insensitively by name; values pass
    // through verbatim. No dedup — case-variant duplicates are
    // preserved. The sort key uses `to_string_lossy` only for
    // ordering; the encoded bytes use `encode_wide` losslessly.
    entries.sort_by_cached_key(|(k, _)| k.to_string_lossy().to_ascii_uppercase());

    // Encode: `KEY=VALUE\0`… `\0`.
    let mut out: Vec<u16> = Vec::new();
    for (k, v) in entries {
        out.extend(k.encode_wide());
        out.push(b'=' as u16);
        out.extend(v.encode_wide());
        out.push(0);
    }
    out.push(0);
    out
}

// ─── Command-line quoting ───────────────────────────────────────────

/// MSVCRT / `CommandLineToArgvW` quoting for one argument.
pub fn quote_arg(a: &str) -> String {
    if !a.is_empty() && !a.chars().any(|c| matches!(c, ' ' | '\t' | '"' | '\\')) {
        return a.to_string();
    }
    let mut out = String::with_capacity(a.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for c in a.chars() {
        match c {
            '\\' => {
                backslashes += 1;
                out.push('\\');
            }
            '"' => {
                // Double the run of backslashes, then escape the
                // quote.
                for _ in 0..backslashes {
                    out.push('\\');
                }
                out.push('\\');
                out.push('"');
                backslashes = 0;
            }
            _ => {
                backslashes = 0;
                out.push(c);
            }
        }
    }
    // Trailing backslash run before the closing quote must double.
    for _ in 0..backslashes {
        out.push('\\');
    }
    out.push('"');
    out
}

fn target_is_cmd(exe: &Path) -> bool {
    exe.file_name()
        .and_then(|n| n.to_str())
        .map(|s| {
            // Win32 strips trailing dots/spaces from the final
            // path component, so `cmd.exe.` launches real cmd —
            // match it here so it gets cmd quoting, not MSVCRT.
            let s = s.trim_end_matches(['.', ' ']);
            s.eq_ignore_ascii_case("cmd.exe") || s.eq_ignore_ascii_case("cmd")
        })
        .unwrap_or(false)
}

/// Build the full command line.
///
/// **Non-cmd targets:** every arg is MSVCRT-quoted via
/// [`quote_arg`] so `CommandLineToArgvW` in the child recovers
/// the exact argv.
///
/// **`cmd.exe` targets:** cmd does NOT use `CommandLineToArgvW`;
/// it parses `lpCommandLine` itself. With `/s`, it strips the
/// first and last `"` of the post-`/c` portion and runs what's
/// between *verbatim* under cmd's own rules. The caller is
/// expected to include `/s`; without it cmd falls back to the
/// legacy "if exactly two quotes and they wrap a runnable
/// command, strip them; otherwise leave alone" heuristic, and
/// the wrapper quote may not strip cleanly. (The TS
/// `wrapWithSandboxArgv` always passes `/d /s /c`.) So we:
///   1. Emit the exe + flags up to and including `/c|/k|/r`
///      using `quote_arg` (these are simple tokens; quoting is
///      a no-op unless the exe path has spaces).
///   2. Join the remaining argv elements with single spaces —
///      this is the user's cmd command string, reconstructed.
///   3. Wrap that in ONE outer `"…"` pair for `/s` to strip.
///
/// The post-`/c` content is **passed through unmodified**. We
/// do NOT caret-escape `& | < > ^ ( )` and do NOT touch `"` —
/// the contract is "this is a cmd.exe command string" and the
/// caller (the TS `wrapWithSandboxArgv`) supplies it as such.
/// `&` chains commands, `"…"` quotes — exactly as the user
/// typed. The child IS the sandbox, so cmd metachars here are
/// the user's tool, not an escape vector. (The host-shell
/// injection concern is about the OUTER spawn, which is solved
/// by argv-mode in the TS layer; this is the inner sandboxed
/// cmd.)
///
/// An earlier revision per-arg-doubled `"` → `""`, which cmd
/// treats as a quote-state *toggle*, not a literal — that
/// mis-parsed payloads containing `&` and was reverted.
pub fn build_cmdline(exe: &Path, args: &[String]) -> String {
    let cmd_split = if target_is_cmd(exe) {
        args.iter()
            .position(|a| matches!(a.to_ascii_lowercase().as_str(), "/c" | "/k" | "/r"))
    } else {
        None
    };
    let mut s = quote_arg(&exe.display().to_string());
    match cmd_split {
        Some(p) => {
            for a in &args[..=p] {
                s.push(' ');
                s.push_str(&quote_arg(a));
            }
            // One outer pair of quotes around the whole post-/c
            // command for `/s` to strip; contents verbatim.
            s.push_str(" \"");
            s.push_str(&args[p + 1..].join(" "));
            s.push('"');
        }
        None => {
            for a in args {
                s.push(' ');
                s.push_str(&quote_arg(a));
            }
        }
    }
    s
}

// ─── PROC_THREAD_ATTRIBUTE_LIST helper ──────────────────────────────

/// RAII wrapper over an opaque `LPPROC_THREAD_ATTRIBUTE_LIST`.
/// `Drop` calls `DeleteProcThreadAttributeList`. The values passed
/// to [`set_*`] must outlive `self` — the kernel reads them by
/// pointer at `CreateProcess` time.
struct ProcThreadAttrs {
    storage: Vec<u8>,
}

impl ProcThreadAttrs {
    fn new(count: u32) -> Result<Self> {
        let mut size = 0usize;
        // Sizing call — expected to fail with
        // ERROR_INSUFFICIENT_BUFFER and write the required size.
        unsafe {
            let _ = InitializeProcThreadAttributeList(None, count, None, &mut size);
        }
        if size == 0 {
            return Err(anyhow!(
                "InitializeProcThreadAttributeList sizing returned 0"
            ));
        }
        let mut storage = vec![0u8; size];
        unsafe {
            InitializeProcThreadAttributeList(
                Some(LPPROC_THREAD_ATTRIBUTE_LIST(
                    storage.as_mut_ptr() as *mut c_void
                )),
                count,
                None,
                &mut size,
            )
            .context("InitializeProcThreadAttributeList")?;
        }
        Ok(Self { storage })
    }

    fn list(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        LPPROC_THREAD_ATTRIBUTE_LIST(self.storage.as_mut_ptr() as *mut c_void)
    }

    fn set_mitigation_policy(&mut self, policy: &u64) -> Result<()> {
        unsafe {
            UpdateProcThreadAttribute(
                self.list(),
                0,
                PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY as usize,
                Some(policy as *const u64 as *const c_void),
                size_of::<u64>(),
                None,
                None,
            )
            .context("UpdateProcThreadAttribute(MITIGATION_POLICY)")
        }
    }

    /// `UpdateProcThreadAttribute(HANDLE_LIST)` requires at least
    /// one entry — Windows rejects an empty list with
    /// `ERROR_BAD_LENGTH`. The caller is expected to have filtered
    /// already.
    fn set_handle_list(&mut self, handles: &mut [HANDLE]) -> Result<()> {
        debug_assert!(!handles.is_empty());
        unsafe {
            UpdateProcThreadAttribute(
                self.list(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                Some(handles.as_ptr() as *const c_void),
                std::mem::size_of_val(handles),
                None,
                None,
            )
            .context("UpdateProcThreadAttribute(HANDLE_LIST)")
        }
    }

    fn set_security_capabilities(
        &mut self,
        capabilities: &mut SECURITY_CAPABILITIES,
    ) -> Result<()> {
        unsafe {
            UpdateProcThreadAttribute(
                self.list(),
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                Some(capabilities as *mut SECURITY_CAPABILITIES as *const c_void),
                size_of::<SECURITY_CAPABILITIES>(),
                None,
                None,
            )
            .context("UpdateProcThreadAttribute(SECURITY_CAPABILITIES)")
        }
    }
}

impl Drop for ProcThreadAttrs {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.list());
        }
    }
}

/// Mark this process's std handles inheritable and return them as
/// `[stdin, stdout, stderr]`. A slot whose handle is unavailable
/// (null / `INVALID_HANDLE_VALUE` / `SetHandleInformation` refused)
/// is `HANDLE::default()`.
///
/// `run_lockdown` plugs the array into BOTH `STARTUPINFO.hStd*`
/// (`STARTF_USESTDHANDLES`) and the `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`
/// inherit whitelist — one source of truth so a handle that didn't
/// make the whitelist is also `default()` in `hStd*` (the child sees
/// a null std handle for that stream rather than a stale value the
/// kernel never duplicated).
fn collect_inheritable_std_handles(input: Option<&File>) -> [HANDLE; 3] {
    let mut out = [HANDLE::default(); 3];
    for (i, which) in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE]
        .into_iter()
        .enumerate()
    {
        let h = match unsafe { GetStdHandle(which) } {
            Ok(h) => h,
            Err(_) => continue,
        };
        if h.0.is_null() || (h.0 as isize) == -1 {
            continue;
        }
        // Best-effort: a detached caller may have non-inheritable
        // (or pseudo) handles here; skip rather than fail.
        let r = unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) };
        if r.is_ok() {
            out[i] = h;
        }
    }
    if let Some(input) = input {
        let handle = HANDLE(input.as_raw_handle());
        if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) }
            .is_ok()
        {
            out[0] = handle;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_arg_simple() {
        assert_eq!(quote_arg("foo"), "foo");
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("a b"), "\"a b\"");
    }

    #[test]
    fn quote_arg_backslash_quote() {
        // a\"b → "a\\\"b"
        assert_eq!(quote_arg(r#"a\"b"#), r#""a\\\"b""#);
        // trailing backslashes double before closing quote
        assert_eq!(quote_arg(r"a\"), r#""a\\""#);
        assert_eq!(quote_arg(r"a\\"), r#""a\\\\""#);
    }

    #[test]
    fn build_cmdline_cmd_passthrough() {
        let exe = Path::new(r"C:\Windows\System32\cmd.exe");
        // post-/c content is wrapped once in "…" for /s to strip;
        // inner quotes and metachars are NOT touched.
        let line = build_cmdline(
            exe,
            &[
                "/d".into(),
                "/s".into(),
                "/c".into(),
                r#"echo "x & y""#.into(),
            ],
        );
        assert_eq!(
            line,
            r#""C:\Windows\System32\cmd.exe" /d /s /c "echo "x & y"""#
        );
        // Multiple post-/c argv elements are joined with a space.
        let line2 = build_cmdline(
            exe,
            &[
                "/c".into(),
                "echo".into(),
                "a".into(),
                "&".into(),
                "echo".into(),
                "b".into(),
            ],
        );
        assert_eq!(
            line2,
            r#""C:\Windows\System32\cmd.exe" /c "echo a & echo b""#
        );
    }

    #[test]
    fn build_cmdline_cmd_no_split_when_no_c_flag() {
        // cmd.exe without /c|/k|/r → MSVCRT quoting throughout.
        let exe = Path::new("cmd.exe");
        let line = build_cmdline(exe, &["/?".into()]);
        assert_eq!(line, r#"cmd.exe /?"#);
    }

    #[test]
    fn build_cmdline_non_cmd_uses_msvcrt_quoting() {
        let exe = Path::new(r"C:\foo\bar.exe");
        let args = vec![r#"a "b"#.into()];
        let line = build_cmdline(exe, &args);
        assert!(line.ends_with(r#""a \"b""#), "got: {line}");
    }
}
