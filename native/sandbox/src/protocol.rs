// Modified for Pi's speculative-action sandbox migration.
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteRequest {
    pub version: u32,
    pub command: String,
    #[serde(default)]
    pub shell: Option<String>,
    pub cwd: PathBuf,
    pub sandbox_root: PathBuf,
    pub source_root: PathBuf,
    pub timeout_ms: u64,
    pub max_output_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResponse {
    pub version: u32,
    pub output: String,
    pub exit: i32,
    pub timeout: bool,
    pub truncated: bool,
    pub sandbox: String,
    pub isolated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResponse {
    pub version: u32,
    pub platform: String,
    pub ready: bool,
    pub detail: String,
}

pub fn shell_arguments(shell: &Path, command: &str) -> Vec<String> {
    let path = shell.as_os_str().to_string_lossy();
    let filename = path.rsplit(['/', '\\']).next().unwrap_or_default();
    let lowercase = filename.to_ascii_lowercase();
    let name = lowercase.strip_suffix(".exe").unwrap_or(&lowercase);
    if name == "cmd" {
        return vec!["/d".into(), "/s".into(), "/c".into(), command.into()];
    }
    if name == "powershell" || name == "pwsh" {
        return vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            command.into(),
        ];
    }
    vec!["-c".into(), command.into()]
}

pub fn run(args: &[OsString]) -> i32 {
    match dispatch(args) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("pi-sandbox-native: {error:#}");
            1
        }
    }
}

pub fn canonicalize_request(request: &ExecuteRequest) -> Result<ExecuteRequest> {
    let mut request = request.clone();
    request.cwd = fs::canonicalize(&request.cwd).context("cwd does not exist")?;
    request.sandbox_root =
        fs::canonicalize(&request.sandbox_root).context("sandboxRoot does not exist")?;
    request.source_root =
        fs::canonicalize(&request.source_root).context("sourceRoot does not exist")?;
    if !request.cwd.starts_with(&request.sandbox_root) {
        bail!("canonical cwd escapes sandboxRoot");
    }
    if request.sandbox_root.starts_with(&request.source_root)
        || request.source_root.starts_with(&request.sandbox_root)
    {
        bail!("sandboxRoot and sourceRoot must not overlap");
    }
    Ok(request)
}

fn dispatch(args: &[OsString]) -> Result<i32> {
    match args.first().and_then(|value| value.to_str()) {
        Some("check") if args.len() == 1 => {
            let response = platform_check();
            let exit = if response.ready { 0 } else { 2 };
            write_json(&response)?;
            Ok(exit)
        }
        Some("execute") => {
            let request_path = parse_request_path(&args[1..])?;
            let request: ExecuteRequest =
                serde_json::from_slice(&fs::read(&request_path).with_context(|| {
                    format!("failed to read request {}", request_path.display())
                })?)
                .context("invalid execute request JSON")?;
            validate_request(&request)?;
            let response = platform_execute(&request)?;
            write_json(&response)?;
            Ok(0)
        }
        _ => bail!("usage: --native-sandbox <check|execute --request FILE>"),
    }
}

fn parse_request_path(args: &[OsString]) -> Result<PathBuf> {
    if args.len() != 2 || args[0].to_str() != Some("--request") {
        bail!("execute requires --request FILE");
    }
    Ok(PathBuf::from(&args[1]))
}

fn validate_request(request: &ExecuteRequest) -> Result<()> {
    if request.version != PROTOCOL_VERSION {
        bail!(
            "unsupported protocol version {}, expected {}",
            request.version,
            PROTOCOL_VERSION
        );
    }
    if request.command.trim().is_empty() {
        bail!("command must not be empty");
    }
    if !request.cwd.is_absolute()
        || !request.sandbox_root.is_absolute()
        || !request.source_root.is_absolute()
    {
        bail!("cwd, sandboxRoot, and sourceRoot must be absolute");
    }
    if !lexically_contains(&request.sandbox_root, &request.cwd) {
        bail!("cwd must be inside sandboxRoot");
    }
    if request.sandbox_root == request.source_root {
        bail!("sandboxRoot and sourceRoot must differ");
    }
    if lexically_contains(&request.sandbox_root, &request.source_root)
        || lexically_contains(&request.source_root, &request.sandbox_root)
    {
        bail!("sandboxRoot and sourceRoot must not overlap");
    }
    if request.timeout_ms == 0 {
        bail!("timeoutMs must be greater than zero");
    }
    if request.max_output_bytes < 16 * 1024 {
        bail!("maxOutputBytes must be at least 16384");
    }
    if request.max_output_bytes > 64 * 1024 * 1024 {
        bail!("maxOutputBytes must not exceed 67108864");
    }
    if request.timeout_ms > 24 * 60 * 60 * 1_000 {
        bail!("timeoutMs must not exceed 86400000");
    }
    Ok(())
}

fn lexically_contains(root: &Path, child: &Path) -> bool {
    let root = normalize(root);
    let child = normalize(child);
    child.starts_with(root)
}

fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

fn write_json(value: &impl Serialize) -> Result<()> {
    println!("{}", serde_json::to_string(value)?);
    Ok(())
}

#[cfg(target_os = "linux")]
fn platform_check() -> CheckResponse {
    crate::linux::check()
}

#[cfg(target_os = "macos")]
fn platform_check() -> CheckResponse {
    crate::macos::check()
}

#[cfg(windows)]
fn platform_check() -> CheckResponse {
    crate::windows_native::check()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn platform_check() -> CheckResponse {
    CheckResponse {
        version: PROTOCOL_VERSION,
        platform: std::env::consts::OS.into(),
        ready: false,
        detail: "unsupported platform".into(),
    }
}

#[cfg(target_os = "linux")]
fn platform_execute(request: &ExecuteRequest) -> Result<ExecuteResponse> {
    crate::linux::execute(request)
}

#[cfg(target_os = "macos")]
fn platform_execute(request: &ExecuteRequest) -> Result<ExecuteResponse> {
    crate::macos::execute(request)
}

#[cfg(windows)]
fn platform_execute(request: &ExecuteRequest) -> Result<ExecuteResponse> {
    crate::windows_native::execute(request)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn platform_execute(_request: &ExecuteRequest) -> Result<ExecuteResponse> {
    bail!("unsupported platform")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_uses_camel_case_json() {
        let request = ExecuteRequest {
            version: PROTOCOL_VERSION,
            command: "printf ok".into(),
            shell: Some("/bin/sh".into()),
            cwd: PathBuf::from("/tmp/sandbox/work"),
            sandbox_root: PathBuf::from("/tmp/sandbox"),
            source_root: PathBuf::from("/source"),
            timeout_ms: 1_000,
            max_output_bytes: 16_384,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["sandboxRoot"], "/tmp/sandbox");
        assert_eq!(value["timeoutMs"], 1_000);
        assert_eq!(value["shell"], "/bin/sh");
        assert_eq!(
            serde_json::from_value::<ExecuteRequest>(value).unwrap(),
            request
        );
    }

    #[test]
    fn rejects_escape_from_sandbox() {
        let request = ExecuteRequest {
            version: PROTOCOL_VERSION,
            command: "true".into(),
            shell: None,
            cwd: PathBuf::from("/tmp/elsewhere"),
            sandbox_root: PathBuf::from("/tmp/sandbox"),
            source_root: PathBuf::from("/source"),
            timeout_ms: 1,
            max_output_bytes: 16_384,
        };
        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn rejects_overlapping_source_and_sandbox() {
        let request = ExecuteRequest {
            version: PROTOCOL_VERSION,
            command: "true".into(),
            shell: None,
            cwd: PathBuf::from("/tmp/source/sandbox"),
            sandbox_root: PathBuf::from("/tmp/source/sandbox"),
            source_root: PathBuf::from("/tmp/source"),
            timeout_ms: 1,
            max_output_bytes: 16_384,
        };
        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn response_reports_native_isolation() {
        let response = ExecuteResponse {
            version: PROTOCOL_VERSION,
            output: "ok".into(),
            exit: 0,
            timeout: false,
            truncated: false,
            sandbox: "workspace+native-test".into(),
            isolated: true,
        };
        let value = serde_json::to_value(&response).unwrap();
        assert_eq!(value["isolated"], true);
        assert_eq!(
            serde_json::from_value::<ExecuteResponse>(value).unwrap(),
            response
        );
    }

    #[test]
    fn uses_shell_specific_command_arguments() {
        assert_eq!(
            shell_arguments(Path::new("/bin/bash"), "printf ok"),
            vec!["-c", "printf ok"]
        );
        assert_eq!(
            shell_arguments(Path::new(r"C:\Windows\System32\cmd.exe"), "echo ok"),
            vec!["/d", "/s", "/c", "echo ok"]
        );
        assert_eq!(
            shell_arguments(Path::new("pwsh.exe"), "Write-Output ok"),
            vec![
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Write-Output ok"
            ]
        );
    }
}
