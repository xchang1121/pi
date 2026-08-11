// Modified for Pi's speculative-action sandbox migration.
use std::env;
use std::ffi::{CStr, CString, c_char};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};

use crate::protocol::{
    CheckResponse, CommandTransport, ExecuteRequest, ExecuteResponse, PROTOCOL_VERSION,
    canonicalize_request, command_arguments, command_input_file,
};

const SANDBOX_KIND: &str = "workspace+native-macos";

#[link(name = "sandbox")]
unsafe extern "C" {
    fn sandbox_init(profile: *const c_char, flags: u64, error_buffer: *mut *mut c_char) -> i32;
    fn sandbox_free_error(error_buffer: *mut c_char);
}

pub fn check() -> CheckResponse {
    let profile = "(version 1)\n(allow default)\n";
    let probe = crate::unix_process::capture(Duration::from_secs(2), 16 * 1024, || {
        apply_profile(profile)?;
        Ok(0)
    });
    match probe {
        Ok(result) if result.exit == 0 => CheckResponse {
            version: PROTOCOL_VERSION,
            platform: "macos".into(),
            ready: true,
            detail: "native Seatbelt profile and process supervision available".into(),
        },
        Ok(result) => CheckResponse {
            version: PROTOCOL_VERSION,
            platform: "macos".into(),
            ready: false,
            detail: format!(
                "native Seatbelt probe failed: {}",
                String::from_utf8_lossy(&result.output)
            ),
        },
        Err(error) => CheckResponse {
            version: PROTOCOL_VERSION,
            platform: "macos".into(),
            ready: false,
            detail: format!("native Seatbelt probe failed: {error:#}"),
        },
    }
}

pub fn execute(request: &ExecuteRequest) -> Result<ExecuteResponse> {
    let request = canonicalize_request(request)?;
    let temporary = tempfile::Builder::new()
        .prefix(".pi-sandbox-tmp-")
        .tempdir_in(&request.sandbox_root)
        .context("create private sandbox temporary directory")?;
    let profile = sandbox_profile(&request);
    let outcome = crate::unix_process::capture(
        Duration::from_millis(request.timeout_ms),
        request.max_output_bytes as usize,
        || exec_command(&request, temporary.path(), &profile),
    )?;
    temporary
        .close()
        .context("remove private sandbox temporary directory")?;

    let mut output = if outcome.output.is_empty() {
        "(no output)".into()
    } else {
        String::from_utf8_lossy(&outcome.output).into_owned()
    };
    if outcome.truncated {
        output.insert_str(0, "...output truncated...\n\n");
    }
    if outcome.timeout {
        output.push_str(&format!(
            "\n\n<sandbox_metadata>\nCommand timed out after {} ms.\n</sandbox_metadata>",
            request.timeout_ms
        ));
    }
    Ok(ExecuteResponse {
        version: PROTOCOL_VERSION,
        output,
        exit: outcome.exit,
        timeout: outcome.timeout,
        truncated: outcome.truncated,
        sandbox: SANDBOX_KIND.into(),
        isolated: true,
    })
}

fn exec_command(request: &ExecuteRequest, temporary: &Path, profile: &str) -> Result<i32> {
    apply_profile(profile)?;
    let shell = request.shell.as_deref().unwrap_or("/bin/sh");
    let stdin = command_input_file(request, temporary)?
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);
    let error = Command::new(shell)
        .args(command_arguments(request, &request.command))
        .current_dir(&request.cwd)
        .env_clear()
        .envs(&request.environment)
        .stdin(stdin)
        .exec();
    Err(error).with_context(|| format!("exec sandbox shell {shell}"))
}

fn apply_profile(profile: &str) -> Result<()> {
    let profile = CString::new(profile).context("Seatbelt profile contains NUL")?;
    let mut error = std::ptr::null_mut();
    let result = unsafe { sandbox_init(profile.as_ptr(), 0, &mut error) };
    if result == 0 {
        return Ok(());
    }
    let message = if error.is_null() {
        "unknown Seatbelt compiler error".into()
    } else {
        let message = unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned();
        unsafe { sandbox_free_error(error) };
        message
    };
    Err(anyhow!("sandbox_init: {message}"))
}

fn sandbox_profile(request: &ExecuteRequest) -> String {
    let source = sbpl_path(&request.source_root);
    let sandbox = sbpl_path(&request.sandbox_root);
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .map(|path| sbpl_path(&path));
    let mut profile = vec![
        "(version 1)".into(),
        "(deny default)".into(),
        "(allow process-exec process-fork)".into(),
        "(allow process-info* (target same-sandbox))".into(),
        "(allow signal (target same-sandbox))".into(),
        "(allow mach-priv-task-port (target same-sandbox))".into(),
        "(allow user-preference-read)".into(),
        "(allow sysctl-read)".into(),
        "(allow ipc-posix-shm ipc-posix-sem)".into(),
        "(allow iokit-get-properties)".into(),
        "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))".into(),
        "(allow mach-lookup".into(),
        "  (global-name \"com.apple.audio.systemsoundserver\")".into(),
        "  (global-name \"com.apple.distributed_notifications@Uv3\")".into(),
        "  (global-name \"com.apple.FontObjectsServer\")".into(),
        "  (global-name \"com.apple.fonts\")".into(),
        "  (global-name \"com.apple.logd\")".into(),
        "  (global-name \"com.apple.lsd.mapdb\")".into(),
        "  (global-name \"com.apple.PowerManagement.control\")".into(),
        "  (global-name \"com.apple.system.logger\")".into(),
        "  (global-name \"com.apple.system.notification_center\")".into(),
        "  (global-name \"com.apple.system.opendirectoryd.libinfo\")".into(),
        "  (global-name \"com.apple.system.opendirectoryd.membership\")".into(),
        "  (global-name \"com.apple.bsd.dirhelper\")".into(),
        "  (global-name \"com.apple.securityd.xpc\")".into(),
        "  (global-name \"com.apple.SecurityServer\")".into(),
        "  (global-name \"com.apple.coreservices.launchservicesd\"))".into(),
        "(allow distributed-notification-post)".into(),
        "(allow file-ioctl (literal \"/dev/null\"))".into(),
        "(allow file-ioctl (literal \"/dev/zero\"))".into(),
        "(allow file-ioctl (literal \"/dev/random\"))".into(),
        "(allow file-ioctl (literal \"/dev/urandom\"))".into(),
        "(allow file-ioctl (literal \"/dev/tty\"))".into(),
        "(allow file-read*)".into(),
        format!("(deny file-read* (subpath {source}))"),
    ];
    if let Some(home) = home {
        profile.push(format!("(deny file-read* (subpath {home}))"));
    }
    profile.extend([
        format!("(allow file-read* (subpath {sandbox}))"),
        "(allow file-read-metadata (vnode-type DIRECTORY))".into(),
        format!("(allow file-write* (subpath {sandbox}))"),
        format!("(deny file-write* (subpath {source}))"),
    ]);
    profile.join("\n")
}

fn sbpl_path(path: &Path) -> String {
    serde_json::to_string(&path.to_string_lossy()).expect("path JSON encoding cannot fail")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_denies_source_and_allows_sandbox() {
        let request = ExecuteRequest {
            version: PROTOCOL_VERSION,
            command: "true".into(),
            shell: None,
            shell_args: vec!["-c".into()],
            command_transport: CommandTransport::Argv,
            environment: std::env::vars().collect(),
            cwd: PathBuf::from("/private/tmp/sandbox"),
            sandbox_root: PathBuf::from("/private/tmp/sandbox"),
            source_root: PathBuf::from("/Users/me/source"),
            timeout_ms: 1,
            max_output_bytes: 16 * 1024,
        };
        let profile = sandbox_profile(&request);
        assert!(profile.contains("(deny file-read* (subpath \"/Users/me/source\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/private/tmp/sandbox\"))"));
        assert!(!profile.contains("(allow network"));
    }

    #[test]
    fn profile_escapes_paths() {
        assert_eq!(
            sbpl_path(Path::new("/tmp/quote\"line\n")),
            "\"/tmp/quote\\\"line\\n\""
        );
    }
}
