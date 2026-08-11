// Modified for Pi's speculative-action sandbox migration.
#![cfg(target_os = "linux")]

use std::fs;
use std::path::Path;
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
        .unwrap();
    let status = serde_json::from_slice::<CheckResponse>(&output.stdout)
        .map(|status| status.ready)
        .unwrap_or(false);
    if !status {
        assert_ne!(
            std::env::var_os("PI_NATIVE_SANDBOX_REQUIRED").as_deref(),
            Some(std::ffi::OsStr::new("1")),
            "native Linux sandbox required but unavailable: {}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
    status
}

fn run(
    source: &Path,
    sandbox: &Path,
    command: impl Into<String>,
    timeout_ms: u64,
    max_output_bytes: u64,
) -> ExecuteResponse {
    let request = ExecuteRequest {
        version: PROTOCOL_VERSION,
        command: command.into(),
        shell: Some("/bin/sh".into()),
        shell_args: vec!["-c".into()],
        command_transport: CommandTransport::Argv,
        environment: std::env::vars().collect(),
        cwd: sandbox.to_path_buf(),
        sandbox_root: sandbox.to_path_buf(),
        source_root: source.to_path_buf(),
        timeout_ms,
        max_output_bytes,
    };
    let request_file = tempfile::NamedTempFile::new().unwrap();
    fs::write(request_file.path(), serde_json::to_vec(&request).unwrap()).unwrap();
    let output = Command::new(binary())
        .args(["--native-sandbox", "execute", "--request"])
        .arg(request_file.path())
        .env("PI_NATIVE_TEST_SECRET", "must-not-leak")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "native broker failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn workspace() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let sandbox = root.path().join("sandbox");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&sandbox).unwrap();
    (root, source, sandbox)
}

#[test]
fn isolates_source_environment_network_and_host_writes() {
    if !available() {
        eprintln!("native namespaces unavailable; skipping isolation integration test");
        return;
    }
    let (_root, source, sandbox) = workspace();
    fs::write(source.join("secret.txt"), "source-secret").unwrap();
    fs::write(sandbox.join("input.txt"), "sandbox-input").unwrap();
    let marker = format!("/etc/pi-native-sandbox-test-{}", std::process::id());
    let response = run(
        &source,
        &sandbox,
        format!(
            "cat input.txt; printf changed > result.txt; \
             if cat {}/secret.txt >/dev/null 2>&1; then printf SOURCE_VISIBLE; else printf SOURCE_HIDDEN; fi; \
             if printf nope > {marker} 2>/dev/null; then printf HOST_WRITABLE; else printf HOST_READONLY; fi; \
             if curl -sS --connect-timeout 1 http://1.1.1.1 >/dev/null 2>&1; then printf NETWORK_OPEN; else printf NETWORK_BLOCKED; fi; \
             printf ' ENV=%s' \"$PI_NATIVE_TEST_SECRET\"",
            source.display()
        ),
        10_000,
        64 * 1024,
    );
    assert_eq!(response.exit, 0, "{}", response.output);
    assert!(response.output.contains("sandbox-input"));
    assert!(response.output.contains("SOURCE_HIDDEN"));
    assert!(response.output.contains("HOST_READONLY"));
    assert!(response.output.contains("NETWORK_BLOCKED"));
    assert!(response.output.contains("ENV="));
    assert!(!response.output.contains("must-not-leak"));
    assert_eq!(
        fs::read_to_string(sandbox.join("result.txt")).unwrap(),
        "changed"
    );
    assert_eq!(
        fs::read_to_string(source.join("secret.txt")).unwrap(),
        "source-secret"
    );
    assert!(!Path::new(&marker).exists());
}

#[test]
fn timeout_kills_the_process_tree() {
    if !available() {
        return;
    }
    let (_root, source, sandbox) = workspace();
    let response = run(
        &source,
        &sandbox,
        "(sleep 2; printf leaked > late.txt) & wait",
        100,
        16 * 1024,
    );
    assert!(response.timeout);
    thread::sleep(Duration::from_millis(300));
    assert!(!sandbox.join("late.txt").exists());
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
        "yes 0123456789 | head -c 100000",
        10_000,
        16 * 1024,
    );
    assert_eq!(response.exit, 0);
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
                    format!("sleep 0.1; printf {index} > result.txt"),
                    10_000,
                    16 * 1024,
                );
                assert_eq!(response.exit, 0, "{}", response.output);
                assert_eq!(
                    fs::read_to_string(sandbox.join("result.txt")).unwrap(),
                    index.to_string()
                );
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
    let request = ExecuteRequest {
        version: PROTOCOL_VERSION,
        command: "(sleep 2; printf leaked > late.txt) & wait".into(),
        shell: Some("/bin/sh".into()),
        shell_args: vec!["-c".into()],
        command_transport: CommandTransport::Argv,
        environment: std::env::vars().collect(),
        cwd: sandbox.clone(),
        sandbox_root: sandbox.clone(),
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
    thread::sleep(Duration::from_millis(300));
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    child.wait().unwrap();
    thread::sleep(Duration::from_millis(2_500));
    assert!(!sandbox.join("late.txt").exists());
}
