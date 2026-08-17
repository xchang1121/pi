// Modified for Pi's speculative-action sandbox migration.
use std::env;
use std::ffi::{CString, OsStr};
use std::fs;
use std::io;
use std::mem::size_of;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};

use crate::protocol::{
    CheckResponse, CommandTransport, ExecuteRequest, ExecuteResponse, PROTOCOL_VERSION,
    canonicalize_request, command_arguments, command_input_file,
};

const SANDBOX_KIND: &str = "workspace+native-linux";
const SETUP_ERROR_EXIT: i32 = 125;

pub fn check() -> CheckResponse {
    match probe_isolation() {
        Ok(()) => CheckResponse {
            version: PROTOCOL_VERSION,
            platform: "linux".into(),
            ready: true,
            detail: "native namespaces, mounts, seccomp, and process supervision available".into(),
        },
        Err(error) => CheckResponse {
            version: PROTOCOL_VERSION,
            platform: "linux".into(),
            ready: false,
            detail: format!("native namespace probe failed: {error:#}"),
        },
    }
}

fn probe_isolation() -> Result<()> {
    probe_namespaces()?;
    let root = tempfile::tempdir().context("create native isolation probe root")?;
    let source = root.path().join("source");
    let sandbox = root.path().join("sandbox");
    fs::create_dir(&source).context("create native isolation probe source")?;
    fs::create_dir(&sandbox).context("create native isolation probe sandbox")?;
    let response = execute(&ExecuteRequest {
        version: PROTOCOL_VERSION,
        command: "true".into(),
        shell: Some("/bin/sh".into()),
        shell_args: vec!["-c".into()],
        command_transport: CommandTransport::Argv,
        environment: env::vars().collect(),
        cwd: sandbox.clone(),
        sandbox_root: sandbox.clone(),
        workspace_root: sandbox,
        source_root: source,
        timeout_ms: 5_000,
        max_output_bytes: 16 * 1024,
    })?;
    if response.exit == 0 {
        Ok(())
    } else {
        bail!("native isolation probe command failed: {}", response.output)
    }
}

pub fn execute(request: &ExecuteRequest) -> Result<ExecuteResponse> {
    let request = canonicalize_request(request)?;
    let root = tempfile::tempdir().context("failed to create sandbox rootfs")?;
    let rootfs = root.path().join("rootfs");
    fs::create_dir(&rootfs).context("failed to create sandbox rootfs mount point")?;

    let outcome = crate::unix_process::capture(
        Duration::from_millis(request.timeout_ms),
        request.max_output_bytes as usize,
        || run_setup_child(&request, &rootfs),
    )?;

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

fn run_setup_child(request: &ExecuteRequest, rootfs: &Path) -> Result<i32> {
    cvt(
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) },
        "set sandbox supervisor parent-death signal",
    )?;
    if unsafe { libc::getppid() } == 1 {
        bail!("sandbox supervisor exited before child initialization");
    }
    unsafe {
        libc::setpgid(0, 0);
    }
    unshare_user()?;
    cvt(
        unsafe {
            libc::unshare(
                libc::CLONE_NEWNS | libc::CLONE_NEWNET | libc::CLONE_NEWIPC | libc::CLONE_NEWUTS,
            )
        },
        "unshare isolation namespaces",
    )?;
    cvt(
        unsafe {
            libc::mount(
                std::ptr::null(),
                c_path(Path::new("/"))?.as_ptr(),
                std::ptr::null(),
                (libc::MS_REC | libc::MS_PRIVATE) as libc::c_ulong,
                std::ptr::null(),
            )
        },
        "make mount namespace private",
    )?;
    setup_filesystem(request, rootfs)?;

    cvt(
        unsafe { libc::unshare(libc::CLONE_NEWPID) },
        "unshare PID namespace",
    )?;
    let init = unsafe { libc::fork() };
    if init < 0 {
        return Err(io::Error::last_os_error()).context("fork sandbox init failed");
    }
    if init == 0 {
        let code = match run_namespace_init(request, rootfs) {
            Ok(code) => code,
            Err(error) => {
                eprintln!("sandbox init failed: {error:#}");
                SETUP_ERROR_EXIT
            }
        };
        unsafe { libc::_exit(code) }
    }
    wait_for_pid(init)
}

fn run_namespace_init(request: &ExecuteRequest, rootfs: &Path) -> Result<i32> {
    let logical_cwd = logical_cwd(request)?;
    cvt(
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) },
        "set parent-death signal",
    )?;
    cvt(
        unsafe { libc::chroot(c_path(rootfs)?.as_ptr()) },
        "chroot sandbox rootfs",
    )?;
    cvt(
        unsafe { libc::chdir(c_path(&logical_cwd)?.as_ptr()) },
        "chdir sandbox cwd",
    )?;
    mount_proc()?;

    let command = unsafe { libc::fork() };
    if command < 0 {
        return Err(io::Error::last_os_error()).context("fork sandbox command failed");
    }
    if command == 0 {
        unsafe {
            libc::setpgid(0, 0);
        }
        if let Err(error) = exec_command(request) {
            eprintln!("sandbox command launch failed: {error:#}");
            unsafe { libc::_exit(126) }
        }
    }

    let status = wait_for_pid(command)?;
    unsafe {
        libc::kill(-1, libc::SIGKILL);
    }
    reap_children();
    Ok(status)
}

fn exec_command(request: &ExecuteRequest) -> Result<()> {
    install_seccomp()?;
    drop_capabilities()?;

    let shell = request.shell.as_deref().unwrap_or("/bin/sh");
    let stdin = command_input_file(request, Path::new("/tmp"))?
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);
    let error = Command::new(shell)
        .args(command_arguments(request, &request.command))
        .current_dir(logical_cwd(request)?)
        .env_clear()
        .envs(&request.environment)
        .stdin(stdin)
        .exec();
    Err(error).with_context(|| format!("exec sandbox shell {shell}"))
}

fn setup_filesystem(request: &ExecuteRequest, rootfs: &Path) -> Result<()> {
    bind_mount(Path::new("/"), rootfs, true)?;
    let mut replaced = ["dev", "home", "proc", "root", "run", "sys", "tmp"]
        .map(|path| rootfs.join(path))
        .to_vec();
    let home = env::var_os("HOME").map(PathBuf::from);
    if let Some(home) = home.as_deref()
        && home.is_absolute()
        && !request.sandbox_root.starts_with(home)
        && !home.starts_with(Path::new("/tmp"))
        && !home.starts_with(Path::new("/home"))
        && !home.starts_with(Path::new("/root"))
    {
        replaced.push(rootfs_path(rootfs, home)?);
    }
    if !request.source_root.starts_with(Path::new("/tmp"))
        && !home
            .as_ref()
            .is_some_and(|home| request.source_root.starts_with(home))
    {
        replaced.push(rootfs_path(rootfs, &request.source_root)?);
    }
    remount_tree_read_only(rootfs, &replaced)?;

    mount_tmpfs(&rootfs.join("tmp"), 0o1777, "64M")?;
    mount_tmpfs(&rootfs.join("run"), 0o755, "16M")?;
    mount_tmpfs(&rootfs.join("sys"), 0o555, "4M")?;
    hide_directory(rootfs, Path::new("/home"))?;
    hide_directory(rootfs, Path::new("/root"))?;
    setup_dev(&rootfs.join("dev"))?;

    if let Some(home) = home.as_deref()
        && home.is_absolute()
        && !request.sandbox_root.starts_with(home)
        && !home.starts_with(Path::new("/tmp"))
        && !home.starts_with(Path::new("/home"))
        && !home.starts_with(Path::new("/root"))
    {
        hide_directory(rootfs, home)?;
    }
    if !request.source_root.starts_with(Path::new("/tmp"))
        && !home
            .as_ref()
            .is_some_and(|home| request.source_root.starts_with(home))
    {
        hide_directory(rootfs, &request.source_root)?;
    }

    let sandbox_target = rootfs_path(rootfs, &request.sandbox_root)?;
    fs::create_dir_all(&sandbox_target).context("create sandboxRoot target")?;
    bind_mount(&request.sandbox_root, &sandbox_target, true)?;

    let source_target = rootfs_path(rootfs, &request.source_root)?;
    fs::create_dir_all(&source_target).context("create logical workspace target")?;
    bind_mount(&request.workspace_root, &source_target, true)?;
    Ok(())
}

fn logical_cwd(request: &ExecuteRequest) -> Result<PathBuf> {
    let relative = request
        .cwd
        .strip_prefix(&request.workspace_root)
        .context("cwd is outside workspaceRoot")?;
    Ok(request.source_root.join(relative))
}

fn setup_dev(target: &Path) -> Result<()> {
    mount_tmpfs(target, 0o755, "16M")?;
    fs::create_dir_all(target.join("shm"))?;
    fs::create_dir_all(target.join("pts"))?;
    for name in ["null", "zero", "random", "urandom", "tty"] {
        let source = Path::new("/dev").join(name);
        if !source.exists() {
            continue;
        }
        let destination = target.join(name);
        fs::File::create(&destination)?;
        bind_mount(&source, &destination, false)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink("/proc/self/fd", target.join("fd"))?;
        symlink("/proc/self/fd/0", target.join("stdin"))?;
        symlink("/proc/self/fd/1", target.join("stdout"))?;
        symlink("/proc/self/fd/2", target.join("stderr"))?;
    }
    Ok(())
}

fn hide_directory(rootfs: &Path, path: &Path) -> Result<()> {
    let target = rootfs_path(rootfs, path)?;
    if target.exists() {
        mount_tmpfs(&target, 0o000, "4K")?;
    }
    Ok(())
}

fn mount_proc() -> Result<()> {
    cvt(
        unsafe {
            libc::mount(
                c_string("proc")?.as_ptr(),
                c_string("/proc")?.as_ptr(),
                c_string("proc")?.as_ptr(),
                (libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC) as libc::c_ulong,
                std::ptr::null(),
            )
        },
        "mount private procfs",
    )?;
    Ok(())
}

fn bind_mount(source: &Path, target: &Path, recursive: bool) -> Result<()> {
    let mut flags = libc::MS_BIND;
    if recursive {
        flags |= libc::MS_REC;
    }
    cvt(
        unsafe {
            libc::mount(
                c_path(source)?.as_ptr(),
                c_path(target)?.as_ptr(),
                std::ptr::null(),
                flags as libc::c_ulong,
                std::ptr::null(),
            )
        },
        &format!("bind mount {}", source.display()),
    )?;
    Ok(())
}

fn mount_tmpfs(target: &Path, mode: u32, size: &str) -> Result<()> {
    let options = format!("mode={mode:o},size={size}");
    cvt(
        unsafe {
            libc::mount(
                c_string("tmpfs")?.as_ptr(),
                c_path(target)?.as_ptr(),
                c_string("tmpfs")?.as_ptr(),
                (libc::MS_NOSUID | libc::MS_NODEV) as libc::c_ulong,
                c_string(&options)?.as_ptr().cast(),
            )
        },
        &format!("mount tmpfs at {}", target.display()),
    )?;
    Ok(())
}

fn remount_tree_read_only(rootfs: &Path, replaced: &[PathBuf]) -> Result<()> {
    if recursive_read_only(rootfs).is_ok() {
        return Ok(());
    }
    let mountinfo = fs::read_to_string("/proc/self/mountinfo")?;
    let mut mounts = mountinfo
        .lines()
        .filter_map(writable_mount_path)
        .filter(|path| path == rootfs || path.starts_with(rootfs))
        .filter(|path| {
            !replaced
                .iter()
                .any(|replacement| path.starts_with(replacement))
        })
        .collect::<Vec<_>>();
    mounts.sort_by_key(|path| std::cmp::Reverse(path.as_os_str().len()));
    for mount in mounts {
        cvt(
            unsafe {
                libc::mount(
                    std::ptr::null(),
                    c_path(&mount)?.as_ptr(),
                    std::ptr::null(),
                    (libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY) as libc::c_ulong,
                    std::ptr::null(),
                )
            },
            &format!("remount {} read-only", mount.display()),
        )?;
    }
    Ok(())
}

fn recursive_read_only(rootfs: &Path) -> Result<()> {
    const AT_RECURSIVE: libc::c_uint = 0x8000;
    const MOUNT_ATTR_RDONLY: u64 = 0x0000_0001;
    #[repr(C)]
    struct MountAttr {
        attr_set: u64,
        attr_clr: u64,
        propagation: u64,
        userns_fd: u64,
    }
    let attributes = MountAttr {
        attr_set: MOUNT_ATTR_RDONLY,
        attr_clr: 0,
        propagation: 0,
        userns_fd: 0,
    };
    let result = unsafe {
        libc::syscall(
            libc::SYS_mount_setattr,
            libc::AT_FDCWD,
            c_path(rootfs)?.as_ptr(),
            AT_RECURSIVE,
            &attributes as *const MountAttr,
            size_of::<MountAttr>(),
        )
    };
    if result < 0 {
        Err(anyhow!(
            "recursively remount {} read-only: {}",
            rootfs.display(),
            io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

fn writable_mount_path(line: &str) -> Option<PathBuf> {
    let mut fields = line.split_whitespace();
    let mount = fields.nth(4)?;
    let options = fields.next()?;
    options
        .split(',')
        .any(|option| option == "rw")
        .then(|| decode_mountinfo_path(mount))
}

fn decode_mountinfo_path(value: &str) -> PathBuf {
    PathBuf::from(
        value
            .replace("\\040", " ")
            .replace("\\011", "\t")
            .replace("\\012", "\n")
            .replace("\\134", "\\"),
    )
}

fn rootfs_path(rootfs: &Path, absolute: &Path) -> Result<PathBuf> {
    let relative = absolute
        .strip_prefix("/")
        .with_context(|| format!("path is not absolute: {}", absolute.display()))?;
    Ok(rootfs.join(relative))
}

fn unshare_user() -> Result<()> {
    let uid = unsafe { libc::getuid() };
    let gid = unsafe { libc::getgid() };
    cvt(
        unsafe { libc::unshare(libc::CLONE_NEWUSER) },
        "unshare user namespace",
    )?;
    let _ = fs::write("/proc/self/setgroups", "deny\n");
    fs::write("/proc/self/uid_map", format!("0 {uid} 1\n")).context("write uid_map")?;
    fs::write("/proc/self/gid_map", format!("0 {gid} 1\n")).context("write gid_map")?;
    Ok(())
}

fn install_seccomp() -> Result<()> {
    const SECCOMP_MODE_FILTER: libc::c_ulong = 2;
    const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    const BPF_LD_W_ABS: u16 = 0x20;
    const BPF_JMP_JEQ_K: u16 = 0x15;
    const BPF_RET_K: u16 = 0x06;

    #[cfg(target_arch = "x86_64")]
    const AUDIT_ARCH: u32 = 0xc000_003e;
    #[cfg(target_arch = "aarch64")]
    const AUDIT_ARCH: u32 = 0xc000_00b7;

    let mut filter = vec![
        stmt(BPF_LD_W_ABS, 4),
        jump(BPF_JMP_JEQ_K, AUDIT_ARCH, 1, 0),
        stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
        stmt(BPF_LD_W_ABS, 0),
    ];
    for syscall in forbidden_syscalls() {
        filter.push(jump(BPF_JMP_JEQ_K, syscall as u32, 0, 1));
        filter.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | libc::EPERM as u32));
    }
    filter.push(stmt(BPF_RET_K, SECCOMP_RET_ALLOW));

    let mut program = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };
    cvt(
        unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) },
        "set no_new_privs",
    )?;
    cvt(
        unsafe {
            libc::prctl(
                libc::PR_SET_SECCOMP,
                SECCOMP_MODE_FILTER,
                &mut program as *mut libc::sock_fprog,
            )
        },
        "install seccomp filter",
    )?;
    Ok(())
}

fn forbidden_syscalls() -> Vec<libc::c_long> {
    vec![
        libc::SYS_socket,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_ptrace,
        libc::SYS_bpf,
        libc::SYS_perf_event_open,
        libc::SYS_userfaultfd,
        libc::SYS_keyctl,
        libc::SYS_add_key,
        libc::SYS_request_key,
        libc::SYS_open_by_handle_at,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
        libc::SYS_kexec_load,
        libc::SYS_reboot,
        libc::SYS_swapon,
        libc::SYS_swapoff,
        libc::SYS_setns,
        libc::SYS_unshare,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
    ]
}

fn stmt(code: u16, value: u32) -> libc::sock_filter {
    libc::sock_filter {
        code,
        jt: 0,
        jf: 0,
        k: value,
    }
}

fn jump(code: u16, value: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter {
        code,
        jt,
        jf,
        k: value,
    }
}

fn drop_capabilities() -> Result<()> {
    const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;
    #[repr(C)]
    struct CapHeader {
        version: u32,
        pid: i32,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CapData {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    }
    let mut header = CapHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let mut data = [CapData {
        effective: 0,
        permitted: 0,
        inheritable: 0,
    }; 2];
    cvt(
        unsafe {
            libc::syscall(
                libc::SYS_capset,
                &mut header as *mut CapHeader,
                data.as_mut_ptr(),
            ) as i32
        },
        "drop capabilities",
    )?;
    Ok(())
}

fn wait_for_pid(pid: libc::pid_t) -> Result<i32> {
    let mut status = 0;
    loop {
        let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
        if waited == pid {
            return Ok(decode_wait_status(status));
        }
        if waited < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return Err(io::Error::last_os_error()).context("waitpid");
        }
    }
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

fn reap_children() {
    loop {
        let mut status = 0;
        let waited = unsafe { libc::waitpid(-1, &mut status, 0) };
        if waited <= 0 {
            break;
        }
    }
}

fn probe_namespaces() -> Result<()> {
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(io::Error::last_os_error()).context("namespace probe fork");
    }
    if pid == 0 {
        let code = if unshare_user().is_ok()
            && cvt(
                unsafe {
                    libc::unshare(
                        libc::CLONE_NEWNS
                            | libc::CLONE_NEWNET
                            | libc::CLONE_NEWIPC
                            | libc::CLONE_NEWUTS
                            | libc::CLONE_NEWPID,
                    )
                },
                "namespace probe",
            )
            .is_ok()
            && probe_mount_isolation().is_ok()
        {
            0
        } else {
            1
        };
        unsafe { libc::_exit(code) }
    }
    let code = wait_for_pid(pid)?;
    if code == 0 {
        Ok(())
    } else {
        bail!("kernel rejected unprivileged namespaces")
    }
}

fn probe_mount_isolation() -> Result<()> {
    cvt(
        unsafe {
            libc::mount(
                std::ptr::null(),
                c_path(Path::new("/"))?.as_ptr(),
                std::ptr::null(),
                (libc::MS_REC | libc::MS_PRIVATE) as libc::c_ulong,
                std::ptr::null(),
            )
        },
        "make namespace probe mounts private",
    )?;
    let root = tempfile::tempdir().context("create namespace probe root")?;
    let rootfs = root.path().join("rootfs");
    fs::create_dir(&rootfs).context("create namespace probe mount point")?;
    bind_mount(Path::new("/"), &rootfs, true)?;
    let result = remount_tree_read_only(&rootfs, &[]);
    unsafe {
        libc::umount2(c_path(&rootfs)?.as_ptr(), libc::MNT_DETACH);
    }
    result
}

fn cvt(value: libc::c_int, operation: &str) -> Result<libc::c_int> {
    if value < 0 {
        Err(anyhow!("{operation}: {}", io::Error::last_os_error()))
    } else {
        Ok(value)
    }
}

fn c_path(path: &Path) -> Result<CString> {
    CString::new(path.as_os_str().as_bytes()).context("path contains NUL")
}

fn c_string(value: impl AsRef<OsStr>) -> Result<CString> {
    CString::new(value.as_ref().as_bytes()).context("value contains NUL")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mountinfo_paths_are_unescaped() {
        assert_eq!(
            decode_mountinfo_path("/tmp/with\\040space"),
            PathBuf::from("/tmp/with space")
        );
    }

    #[test]
    fn read_only_mounts_do_not_require_fallback_remounting() {
        let mountinfo = "1 0 0:1 / /tmp/root rw - ext4 /dev/root rw\n2 1 0:2 / /tmp/root/snap ro - squashfs snap ro\n";
        let writable = mountinfo
            .lines()
            .filter_map(writable_mount_path)
            .collect::<Vec<_>>();
        assert_eq!(writable, [PathBuf::from("/tmp/root")]);
    }
}
