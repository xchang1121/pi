// Modified for Pi's speculative-action sandbox migration.
use std::ffi::OsString;
use std::io::Read;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use windows::Win32::Foundation::HANDLE;

use crate::protocol::{
    CheckResponse, CommandTransport, ExecuteRequest, ExecuteResponse, PROTOCOL_VERSION,
    canonicalize_request, command_arguments, command_input_file,
};

const SANDBOX_KIND: &str = "workspace+native-windows";

pub fn check() -> CheckResponse {
    match check_ready() {
        Ok(()) => CheckResponse {
            version: PROTOCOL_VERSION,
            platform: "windows".into(),
            ready: true,
			detail: "per-user AppContainer, package-SID workspace ACL, isolated desktop, and job supervision available".into(),
        },
        Err(error) => CheckResponse {
            version: PROTOCOL_VERSION,
            platform: "windows".into(),
            ready: false,
            detail: format!("native Windows AppContainer is unavailable: {error:#}"),
        },
    }
}

pub fn execute(request: &ExecuteRequest) -> Result<ExecuteResponse> {
    let request = canonicalize_request(request)?;
    let appcontainer = crate::appcontainer::AppContainer::open()?;
    set_workspace_access(&request, appcontainer.sid_string(), true)?;
    let result = execute_granted(&request);
    let revoke = set_workspace_access(&request, appcontainer.sid_string(), false);
    match (result, revoke) {
        (Ok(result), Ok(())) => Ok(result),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error).context("sandbox ACL cleanup failed"),
    }
}

fn check_ready() -> Result<()> {
    crate::appcontainer::AppContainer::open()?;
    let root = tempfile::tempdir().context("create native sandbox readiness workspace")?;
    let source = root.path().join("source");
    let sandbox = root.path().join("sandbox");
    std::fs::create_dir(&source)?;
    std::fs::create_dir(&sandbox)?;
    let request = ExecuteRequest {
        version: PROTOCOL_VERSION,
        command: ">sandbox-ready.txt echo ready".into(),
        shell: Some(command_processor()?.to_string_lossy().into_owned()),
        shell_args: vec!["/d".into(), "/s".into(), "/c".into()],
        command_transport: CommandTransport::Argv,
        environment: std::env::vars().collect(),
        cwd: sandbox.clone(),
        sandbox_root: sandbox.clone(),
        source_root: source,
        timeout_ms: 10_000,
        max_output_bytes: 16 * 1024,
    };
    let response = execute(&request).context("execute native sandbox readiness command")?;
    if response.exit != 0 || !sandbox.join("sandbox-ready.txt").is_file() {
        bail!(
            "sandboxed external process probe failed with exit {}: {}",
            response.exit,
            response.output
        );
    }
    Ok(())
}

fn set_workspace_access(request: &ExecuteRequest, sid: &str, enabled: bool) -> Result<()> {
    let path = request
        .sandbox_root
        .to_str()
        .ok_or_else(|| anyhow!("sandboxRoot is not valid UTF-8"))?;
    crate::acl::set_appcontainer_workspace_access(path, sid, enabled)
        .context("update AppContainer workspace ACL")
}

fn execute_granted(request: &ExecuteRequest) -> Result<ExecuteResponse> {
    let request_file = tempfile::NamedTempFile::new().context("create internal request file")?;
    std::fs::write(request_file.path(), serde_json::to_vec(request)?)?;
    let mut command = native_command();
    command
        .args(["--windows-appcontainer-run", "--request"])
        .arg(request_file.path())
        .current_dir(&request.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000);

    let mut child = command.spawn().context("launch Windows sandbox broker")?;
    let job = crate::job::Job::supervisor().context("create outer sandbox job")?;
    job.assign(HANDLE(child.as_raw_handle()))
        .context("assign Windows sandbox broker to outer job")?;

    let stdout = child.stdout.take().context("sandbox stdout unavailable")?;
    let stderr = child.stderr.take().context("sandbox stderr unavailable")?;
    let max = request.max_output_bytes as usize;
    let stdout = thread::spawn(move || read_tail(stdout, max));
    let stderr = thread::spawn(move || read_tail(stderr, max));

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= Duration::from_millis(request.timeout_ms) {
            timed_out = true;
            drop(job);
            let _ = child.kill();
            break child.wait()?;
        }
        thread::sleep(Duration::from_millis(10));
    };

    let stdout = stdout
        .join()
        .map_err(|_| anyhow!("sandbox stdout reader panicked"))??;
    let stderr = stderr
        .join()
        .map_err(|_| anyhow!("sandbox stderr reader panicked"))??;
    let mut combined = stdout.bytes;
    if !stderr.bytes.is_empty() {
        if !combined.is_empty() {
            combined.push(b'\n');
        }
        combined.extend_from_slice(&stderr.bytes);
    }
    let (combined, final_truncated) = bounded_tail(combined, max);
    let truncated = stdout.truncated || stderr.truncated || final_truncated;
    let mut output = if combined.is_empty() {
        "(no output)".into()
    } else {
        String::from_utf8_lossy(&combined).into_owned()
    };
    if truncated {
        output.insert_str(0, "...output truncated...\n\n");
    }
    if timed_out {
        output.push_str(&format!(
            "\n\n<sandbox_metadata>\nCommand timed out after {} ms.\n</sandbox_metadata>",
            request.timeout_ms
        ));
    }
    Ok(ExecuteResponse {
        version: PROTOCOL_VERSION,
        output,
        exit: if timed_out {
            1
        } else {
            status.code().unwrap_or(1)
        },
        timeout: timed_out,
        truncated,
        sandbox: SANDBOX_KIND.into(),
        isolated: true,
    })
}

fn native_command() -> Command {
    Command::new(std::env::current_exe().expect("current executable is unavailable"))
}

pub fn run_internal(args: &[OsString]) -> i32 {
    match run_internal_inner(args) {
        Ok(code) => code as i32,
        Err(error) => {
            eprintln!("pi-sandbox-native: AppContainer launch failed: {error:#}");
            1
        }
    }
}

fn run_internal_inner(args: &[OsString]) -> Result<u32> {
    if args.len() != 2 || args[0].to_str() != Some("--request") {
        bail!("--windows-appcontainer-run requires --request FILE");
    }
    let request: ExecuteRequest = serde_json::from_slice(
        &std::fs::read(&args[1]).context("read internal AppContainer request")?,
    )
    .context("parse internal AppContainer request")?;
    let request = canonicalize_request(&request)?;
    let appcontainer = crate::appcontainer::AppContainer::open()?;
    crate::winsta::grant_appcontainer_on_winsta(appcontainer.sid_string())?;
    let mut desktop = crate::winsta::IsolatedDesk::new(appcontainer.sid_string())?;
    let temporary = tempfile::Builder::new()
        .prefix(".pi-appcontainer-temp-")
        .tempdir_in(&request.sandbox_root)
        .context("create AppContainer temporary directory")?;
    std::env::set_current_dir(process_path(&request.cwd)).context("enter AppContainer cwd")?;
    let command = requested_shell(&request)?;
    let args = command_arguments(&request, &request.command);
    let input = command_input_file(&request, temporary.path())?;
    let environment = request
        .environment
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<Vec<_>>();
    let mut capabilities = appcontainer.security_capabilities();
    crate::launch::run_lockdown(
        &command,
        &args,
        &environment,
        input.as_ref(),
        &mut capabilities,
        &mut desktop,
    )
}

fn process_path(path: &Path) -> PathBuf {
    let wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    const VERBATIM: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const UNC: &[u16] = &[b'U' as u16, b'N' as u16, b'C' as u16, b'\\' as u16];
    if !wide.starts_with(VERBATIM) {
        return path.to_path_buf();
    }
    let mut value = Vec::new();
    if wide[VERBATIM.len()..].starts_with(UNC) {
        value.extend([b'\\' as u16, b'\\' as u16]);
        value.extend_from_slice(&wide[VERBATIM.len() + UNC.len()..]);
    } else {
        value.extend_from_slice(&wide[VERBATIM.len()..]);
    }
    PathBuf::from(OsString::from_wide(&value))
}

fn command_processor() -> Result<PathBuf> {
    let root = std::env::var_os("SystemRoot").context("SystemRoot is missing")?;
    let cmd = PathBuf::from(root).join("System32").join("cmd.exe");
    if !cmd.is_file() {
        bail!("command processor not found: {}", cmd.display());
    }
    Ok(cmd)
}

fn requested_shell(request: &ExecuteRequest) -> Result<PathBuf> {
    let Some(shell) = request.shell.as_deref() else {
        return command_processor();
    };
    let requested = PathBuf::from(shell);
    if requested.is_absolute() {
        if requested.is_file() {
            return Ok(requested);
        }
        bail!("configured shell not found: {}", requested.display());
    }
    let extensions = std::env::var_os("PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec![".COM".into(), ".EXE".into(), ".BAT".into(), ".CMD".into()]);
    for directory in std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default()
    {
        let direct = directory.join(&requested);
        if direct.is_file() {
            return Ok(direct);
        }
        if requested.extension().is_some() {
            continue;
        }
        for extension in &extensions {
            let candidate = directory.join(format!("{shell}{extension}"));
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    bail!("configured shell not found on PATH: {shell}")
}

struct Tail {
    bytes: Vec<u8>,
    truncated: bool,
}

fn read_tail(mut reader: impl Read, max: usize) -> Result<Tail> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        append_tail(&mut bytes, &buffer[..count], max, &mut truncated);
    }
    Ok(Tail { bytes, truncated })
}

fn append_tail(bytes: &mut Vec<u8>, next: &[u8], max: usize, truncated: &mut bool) {
    if next.len() >= max {
        bytes.clear();
        bytes.extend_from_slice(&next[next.len() - max..]);
        *truncated = true;
        return;
    }
    let overflow = bytes.len().saturating_add(next.len()).saturating_sub(max);
    if overflow > 0 {
        bytes.drain(..overflow);
        *truncated = true;
    }
    bytes.extend_from_slice(next);
}

fn bounded_tail(mut bytes: Vec<u8>, max: usize) -> (Vec<u8>, bool) {
    if bytes.len() <= max {
        return (bytes, false);
    }
    let start = bytes.len() - max;
    bytes.drain(..start);
    (bytes, true)
}

trait CommandCreationFlags {
    fn creation_flags(&mut self, flags: u32) -> &mut Self;
}

impl CommandCreationFlags for Command {
    fn creation_flags(&mut self, flags: u32) -> &mut Self {
        use std::os::windows::process::CommandExt;
        CommandExt::creation_flags(self, flags)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_tail_is_bounded() {
        let mut bytes = b"1234".to_vec();
        let mut truncated = false;
        append_tail(&mut bytes, b"5678", 6, &mut truncated);
        assert_eq!(bytes, b"345678");
        assert!(truncated);
    }
}
