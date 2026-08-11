// Modified for Pi's speculative-action sandbox migration.
use std::io;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

static ACTIVE_PROCESS_GROUP: AtomicI32 = AtomicI32::new(0);

fn kill_process_group(pid: libc::pid_t) {
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
}

fn kill_process_tree(pid: libc::pid_t) {
    kill_process_group(pid);
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
}

extern "C" fn terminate_process_group(signal: libc::c_int) {
    let pid = ACTIVE_PROCESS_GROUP.load(Ordering::Relaxed);
    if pid > 0 {
        kill_process_tree(pid);
    }
    unsafe { libc::_exit(128 + signal) }
}

struct SignalGuard(Vec<(libc::c_int, libc::sigaction)>);

impl SignalGuard {
    fn install() -> Result<Self> {
        let mut previous = Vec::new();
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            let mut old: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = terminate_process_group as *const () as usize;
            unsafe { libc::sigemptyset(&mut action.sa_mask) };
            cvt(
                unsafe { libc::sigaction(signal, &action, &mut old) },
                "install sandbox termination handler",
            )?;
            previous.push((signal, old));
        }
        Ok(Self(previous))
    }
}

impl Drop for SignalGuard {
    fn drop(&mut self) {
        for (signal, action) in &self.0 {
            unsafe {
                libc::sigaction(*signal, action, std::ptr::null_mut());
            }
        }
    }
}

pub struct ProcessOutcome {
    pub output: Vec<u8>,
    pub exit: i32,
    pub timeout: bool,
    pub truncated: bool,
}

pub fn capture(
    timeout: Duration,
    max_output: usize,
    child: impl FnOnce() -> Result<i32>,
) -> Result<ProcessOutcome> {
    let signals = SignalGuard::install()?;
    let mut pipe = [0; 2];
    cvt(unsafe { libc::pipe(pipe.as_mut_ptr()) }, "pipe")?;
    cvt(
        unsafe { libc::fcntl(pipe[0], libc::F_SETFD, libc::FD_CLOEXEC) },
        "fcntl read FD_CLOEXEC",
    )?;
    cvt(
        unsafe { libc::fcntl(pipe[1], libc::F_SETFD, libc::FD_CLOEXEC) },
        "fcntl write FD_CLOEXEC",
    )?;
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        close(pipe[0]);
        close(pipe[1]);
        return Err(io::Error::last_os_error()).context("fork failed");
    }
    if pid == 0 {
        unsafe {
            libc::setpgid(0, 0);
        }
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            unsafe {
                libc::signal(signal, libc::SIG_DFL);
            }
        }
        close(pipe[0]);
        child_stdio(pipe[1]);
        let code = match child() {
            Ok(code) => code,
            Err(error) => {
                eprintln!("sandbox setup failed: {error:#}");
                125
            }
        };
        unsafe { libc::_exit(code) }
    }

    close(pipe[1]);
    ACTIVE_PROCESS_GROUP.store(pid, Ordering::Release);
    unsafe {
        libc::setpgid(pid, pid);
    }
    let outcome = collect_process(pid, pipe[0], timeout, max_output);
    if outcome.is_err() {
        cleanup_after_collection_error(pid);
    }
    ACTIVE_PROCESS_GROUP.store(0, Ordering::Release);
    drop(signals);
    close(pipe[0]);
    outcome
}

fn collect_process(
    pid: libc::pid_t,
    output_fd: RawFd,
    timeout: Duration,
    max_output: usize,
) -> Result<ProcessOutcome> {
    let flags = unsafe { libc::fcntl(output_fd, libc::F_GETFL) };
    cvt(flags, "fcntl F_GETFL")?;
    cvt(
        unsafe { libc::fcntl(output_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) },
        "fcntl F_SETFL",
    )?;

    let started = Instant::now();
    let mut output = Vec::new();
    let mut truncated = false;
    let mut status = 0;
    let mut timed_out = false;
    loop {
        drain_output(output_fd, &mut output, max_output, &mut truncated)?;
        let waited = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if waited == pid {
            // A successful command must not leave background descendants running
            // after the broker reports completion.
            kill_process_group(pid);
            break;
        }
        if waited < 0 {
            return Err(io::Error::last_os_error()).context("waitpid sandbox process");
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            kill_process_tree(pid);
            cvt(
                unsafe { libc::waitpid(pid, &mut status, 0) },
                "waitpid timed-out sandbox process",
            )?;
            break;
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        let wait = remaining.min(Duration::from_millis(25));
        let mut poll = libc::pollfd {
            fd: output_fd,
            events: libc::POLLIN,
            revents: 0,
        };
        unsafe {
            libc::poll(&mut poll, 1, wait.as_millis().max(1) as i32);
        }
    }
    drain_output_until_eof(output_fd, &mut output, max_output, &mut truncated)?;
    Ok(ProcessOutcome {
        output,
        exit: if timed_out {
            1
        } else {
            decode_wait_status(status)
        },
        timeout: timed_out,
        truncated,
    })
}

fn cleanup_after_collection_error(pid: libc::pid_t) {
    kill_process_group(pid);
    let mut status = 0;
    let waited = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    if waited == 0 {
        unsafe {
            libc::kill(pid, libc::SIGKILL);
            libc::waitpid(pid, &mut status, 0);
        }
    }
}

fn drain_output(fd: RawFd, output: &mut Vec<u8>, max: usize, truncated: &mut bool) -> Result<bool> {
    let mut buffer = [0_u8; 16 * 1024];
    let mut eof = false;
    loop {
        let read = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
        if read > 0 {
            append_tail(output, &buffer[..read as usize], max, truncated);
            continue;
        }
        if read == 0 {
            eof = true;
            break;
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::WouldBlock {
            break;
        }
        return Err(error).context("read sandbox output");
    }
    Ok(eof)
}

fn drain_output_until_eof(
    fd: RawFd,
    output: &mut Vec<u8>,
    max: usize,
    truncated: &mut bool,
) -> Result<()> {
    for _ in 0..100 {
        if drain_output(fd, output, max, truncated)? {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

fn append_tail(output: &mut Vec<u8>, next: &[u8], max: usize, truncated: &mut bool) {
    if next.len() >= max {
        output.clear();
        output.extend_from_slice(&next[next.len() - max..]);
        *truncated = true;
        return;
    }
    let overflow = output.len().saturating_add(next.len()).saturating_sub(max);
    if overflow > 0 {
        output.drain(..overflow);
        *truncated = true;
    }
    output.extend_from_slice(next);
}

fn child_stdio(fd: RawFd) {
    unsafe {
        libc::dup2(fd, libc::STDOUT_FILENO);
        libc::dup2(fd, libc::STDERR_FILENO);
    }
    close(fd);
}

fn decode_wait_status(status: i32) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        1
    }
}

fn close(fd: RawFd) {
    unsafe {
        libc::close(fd);
    }
}

fn cvt(value: libc::c_int, operation: &str) -> Result<libc::c_int> {
    if value < 0 {
        Err(io::Error::last_os_error()).with_context(|| operation.to_string())
    } else {
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_tail_is_bounded() {
        let mut output = b"1234".to_vec();
        let mut truncated = false;
        append_tail(&mut output, b"5678", 6, &mut truncated);
        assert_eq!(output, b"345678");
        assert!(truncated);
    }

    #[test]
    fn successful_parent_cannot_leave_background_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("late.txt");
        let child_marker = marker.clone();

        let outcome = capture(Duration::from_secs(2), 1024, move || {
            let descendant = unsafe { libc::fork() };
            if descendant < 0 {
                return Err(io::Error::last_os_error()).context("fork descendant");
            }
            if descendant == 0 {
                std::thread::sleep(Duration::from_millis(250));
                let _ = std::fs::write(child_marker, b"leaked");
                unsafe { libc::_exit(0) }
            }
            Ok(0)
        })
        .unwrap();

        assert_eq!(outcome.exit, 0);
        std::thread::sleep(Duration::from_millis(400));
        assert!(
            !marker.exists(),
            "background descendant survived a successful command"
        );
    }
}
