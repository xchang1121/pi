// Modified for Pi's speculative-action sandbox migration.
#![cfg(windows)]

use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use pi_sandbox_native::protocol::{
    CheckResponse, CommandTransport, ExecuteRequest, ExecuteResponse, PROTOCOL_VERSION,
};

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_pi-sandbox-native")
}

fn available() -> bool {
    let output = Command::new(binary())
        .args(["--native-sandbox", "check"])
        .output()
        .expect("run readiness check");
    let status = serde_json::from_slice::<CheckResponse>(&output.stdout).expect("parse check JSON");
    if status.ready {
        return true;
    }
    assert_ne!(
        std::env::var_os("PI_NATIVE_SANDBOX_REQUIRED").as_deref(),
        Some(std::ffi::OsStr::new("1")),
        "native Windows sandbox required but unavailable: {}",
        status.detail
    );
    eprintln!(
        "native Windows sandbox unavailable; skipping: {}",
        status.detail
    );
    false
}

#[test]
fn binary_uses_user_scoped_appcontainer_entrypoints() {
    let image = fs::read(binary()).unwrap();
    let image = String::from_utf8_lossy(&image);
    assert!(image.contains("CreateAppContainerProfile"));
    for forbidden in [
        "CreateProcessWithLogonW",
        "ShellExecuteExW",
        "NetUserAdd",
        "FwpmEngineOpen",
        "requireAdministrator",
    ] {
        assert!(
            !image.contains(forbidden),
            "forbidden entrypoint: {forbidden}"
        );
    }
}

fn run(
    source: &Path,
    sandbox: &Path,
    command: impl Into<String>,
    timeout_ms: u64,
    max_output_bytes: u64,
) -> ExecuteResponse {
    run_with_shell(
        source,
        sandbox,
        command,
        None,
        vec!["/d".into(), "/s".into(), "/c".into()],
        timeout_ms,
        max_output_bytes,
    )
}

fn run_with_shell(
    source: &Path,
    sandbox: &Path,
    command: impl Into<String>,
    shell: Option<String>,
    shell_args: Vec<String>,
    timeout_ms: u64,
    max_output_bytes: u64,
) -> ExecuteResponse {
    let request = ExecuteRequest {
        version: PROTOCOL_VERSION,
        command: command.into(),
        shell,
        shell_args,
        command_transport: CommandTransport::Argv,
        environment: std::env::vars().collect(),
        cwd: sandbox.to_path_buf(),
        sandbox_root: sandbox.to_path_buf(),
        workspace_root: sandbox.to_path_buf(),
        source_root: source.to_path_buf(),
        timeout_ms,
        max_output_bytes,
    };
    let request_file = tempfile::NamedTempFile::new().expect("request file");
    fs::write(request_file.path(), serde_json::to_vec(&request).unwrap()).unwrap();
    let output = Command::new(binary())
        .args(["--native-sandbox", "execute", "--request"])
        .arg(request_file.path())
        .env("PI_NATIVE_TEST_SECRET", "must-not-leak")
        .output()
        .expect("launch native sandbox");
    assert!(
        output.status.success(),
        "native broker failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("parse execute JSON")
}

fn workspace() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let sandbox = root.path().join("sandbox");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&sandbox).unwrap();
    (root, source, sandbox)
}

fn write_delayed_child_scripts(sandbox: &Path) {
    fs::write(
        sandbox.join("late.cmd"),
        "@echo off\r\npowershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 2\"\r\n>late.txt echo leaked\r\n",
    )
    .unwrap();
    fs::write(
        sandbox.join("parent.cmd"),
        "@echo off\r\n>started.txt echo started\r\nstart \"\" /b cmd.exe /d /s /c \"call late.cmd\"\r\npowershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 20\"\r\n",
    )
    .unwrap();
}

#[test]
fn rejects_junction_escape_before_sandbox_setup() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let sandbox = root.path().join("sandbox");
    let outside = root.path().join("outside");
    let junction = sandbox.join("escape");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&sandbox).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let output = Command::new("cmd.exe")
        .args(["/d", "/s", "/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&outside)
        .output()
        .expect("create junction");
    assert!(
        output.status.success(),
        "mklink failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let request = ExecuteRequest {
        version: PROTOCOL_VERSION,
        command: "echo escaped".into(),
        shell: None,
        shell_args: vec!["/d".into(), "/s".into(), "/c".into()],
        command_transport: CommandTransport::Argv,
        environment: std::env::vars().collect(),
        cwd: junction,
        sandbox_root: sandbox.clone(),
        workspace_root: sandbox,
        source_root: source,
        timeout_ms: 1_000,
        max_output_bytes: 16 * 1024,
    };
    let request_file = tempfile::NamedTempFile::new().unwrap();
    fs::write(request_file.path(), serde_json::to_vec(&request).unwrap()).unwrap();
    let output = Command::new(binary())
        .args(["--native-sandbox", "execute", "--request"])
        .arg(request_file.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("canonical cwd escapes workspaceRoot"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn isolates_identity_source_environment_network_and_writes() {
    if !available() {
        return;
    }
    let (_root, source, sandbox) = workspace();
    fs::write(source.join("secret.txt"), "source-secret").unwrap();
    fs::write(sandbox.join("input.txt"), "sandbox-input\r\n").unwrap();
    let source_file = source.join("secret.txt").display().to_string();
    let script = format!(
        "@echo off\r\n\
         type input.txt\r\n\
         >result.txt echo changed\r\n\
         type \"{source_file}\" >nul 2>&1\r\n\
         if errorlevel 1 (echo SOURCE_HIDDEN) else (echo SOURCE_VISIBLE)\r\n\
         >\"{source_file}\" echo changed\r\n\
         if errorlevel 1 (echo SOURCE_READONLY) else (echo SOURCE_WRITABLE)\r\n\
         curl.exe -sS --connect-timeout 1 http://1.1.1.1 >nul 2>&1\r\n\
         if errorlevel 1 (echo NETWORK_BLOCKED) else (echo NETWORK_OPEN)\r\n\
         if defined PI_NATIVE_TEST_SECRET (echo ENV_LEAK) else (echo ENV_HIDDEN)\r\n\
         whoami /groups | findstr \"S-1-16-4096\" >nul && echo LOW_INTEGRITY\r\n"
    );
    fs::write(sandbox.join("probe.cmd"), script).unwrap();
    let response = run(&source, &sandbox, "call probe.cmd 2>nul", 15_000, 64 * 1024);
    assert_eq!(response.exit, 0, "{}", response.output);
    assert!(response.output.contains("sandbox-input"));
    assert!(response.output.contains("SOURCE_HIDDEN"));
    assert!(response.output.contains("SOURCE_READONLY"));
    assert!(response.output.contains("NETWORK_BLOCKED"));
    assert!(response.output.contains("ENV_HIDDEN"));
    assert!(!response.output.contains("must-not-leak"));
    assert!(
        response.output.contains("LOW_INTEGRITY"),
        "{}",
        response.output
    );
    assert_eq!(
        fs::read_to_string(sandbox.join("result.txt"))
            .unwrap()
            .trim(),
        "changed"
    );
    assert_eq!(
        fs::read_to_string(source.join("secret.txt")).unwrap(),
        "source-secret"
    );
}

#[test]
fn blocks_loopback_for_appcontainer_without_blocking_the_host_user() {
    if !available() {
        return;
    }
    let (_root, source, sandbox) = workspace();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let target = listener.local_addr().unwrap();
    let response = run(
        &source,
        &sandbox,
        format!(
            "powershell.exe -NoProfile -NonInteractive -Command \"try {{ $c = [Net.Sockets.TcpClient]::new(); $t = $c.ConnectAsync('127.0.0.1', {}); if ($t.Wait(1000) -and $c.Connected) {{ Write-Output CONNECTED; exit 9 }} else {{ Write-Output BLOCKED; exit 0 }} }} catch {{ Write-Output BLOCKED; exit 0 }}\"",
            target.port()
        ),
        10_000,
        16 * 1024,
    );
    assert_eq!(
        response.exit, 0,
        "AppContainer reached {target}: {}",
        response.output
    );
    assert!(response.output.contains("BLOCKED"), "{}", response.output);
    TcpStream::connect_timeout(&target, Duration::from_secs(1))
        .expect("AppContainer isolation must not block the real user");
}

#[test]
fn timeout_kills_the_process_tree() {
    if !available() {
        return;
    }
    let (_root, source, sandbox) = workspace();
    write_delayed_child_scripts(&sandbox);
    let response = run(&source, &sandbox, "call parent.cmd", 500, 16 * 1024);
    assert!(response.timeout, "{}", response.output);
    thread::sleep(Duration::from_millis(2_500));
    assert!(sandbox.join("started.txt").exists(), "parent did not start");
    assert!(
        !sandbox.join("late.txt").exists(),
        "descendant survived timeout"
    );
}

#[test]
fn output_is_tail_bounded() {
    if !available() {
        return;
    }
    let (_root, source, sandbox) = workspace();
    let response = run(
        &source,
        &sandbox,
        "powershell.exe -NoProfile -NonInteractive -Command \"[Console]::Out.Write('x' * 100000)\"",
        15_000,
        16 * 1024,
    );
    assert_eq!(response.exit, 0, "{}", response.output);
    assert!(response.truncated);
    assert!(response.output.starts_with("...output truncated..."));
    assert!(response.output.len() <= 16 * 1024 + 64);
}

#[test]
fn independent_brokers_run_concurrently() {
    if !available() {
        return;
    }
    let jobs = (0..4)
        .map(|index| {
            thread::spawn(move || {
                let (_root, source, sandbox) = workspace();
                let response = run(
                    &source,
                    &sandbox,
                    format!(
                        "powershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Milliseconds 250; [IO.File]::WriteAllText('result.txt','{index}')\""
                    ),
                    20_000,
                    16 * 1024,
                );
                assert_eq!(response.exit, 0, "{}", response.output);
                assert_eq!(fs::read_to_string(sandbox.join("result.txt")).unwrap(), index.to_string());
            })
        })
        .collect::<Vec<_>>();
    for job in jobs {
        job.join().unwrap();
    }
}

#[test]
fn terminating_the_broker_kills_descendants() {
    if !available() {
        return;
    }
    let (_root, source, sandbox) = workspace();
    write_delayed_child_scripts(&sandbox);
    let request = ExecuteRequest {
        version: PROTOCOL_VERSION,
        command: "call parent.cmd".into(),
        shell: None,
        shell_args: vec!["/d".into(), "/s".into(), "/c".into()],
        command_transport: CommandTransport::Argv,
        environment: std::env::vars().collect(),
        cwd: sandbox.clone(),
        sandbox_root: sandbox.clone(),
        workspace_root: sandbox.clone(),
        source_root: source,
        timeout_ms: 30_000,
        max_output_bytes: 16 * 1024,
    };
    let request_file = tempfile::NamedTempFile::new().unwrap();
    fs::write(request_file.path(), serde_json::to_vec(&request).unwrap()).unwrap();
    let mut child = Command::new(binary())
        .args(["--native-sandbox", "execute", "--request"])
        .arg(request_file.path())
        .spawn()
        .unwrap();
    thread::sleep(Duration::from_millis(1_000));
    child.kill().unwrap();
    child.wait().unwrap();
    thread::sleep(Duration::from_millis(2_500));
    assert!(sandbox.join("started.txt").exists(), "parent did not start");
    assert!(!sandbox.join("late.txt").exists());
}
