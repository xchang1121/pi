// Modified for Pi's speculative-action sandbox migration.
//! Protect the unrestricted AppContainer broker from its child process.
//!
//! The protected DACL allows SYSTEM and Administrators, while OWNER RIGHTS is
//! limited to `READ_CONTROL`. The child therefore cannot open the broker as a
//! parent-process or memory-access escape target.

use anyhow::{Context, Result, anyhow};
use std::ffi::c_void;
use std::mem::size_of;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
    SE_KERNEL_OBJECT, SetSecurityInfo,
};
use windows::Win32::Security::{
    ACL, ACL_REVISION, AddAccessAllowedAce, DACL_SECURITY_INFORMATION, GetLengthSid, InitializeAcl,
    PROTECTED_DACL_SECURITY_INFORMATION,
};
use windows::Win32::System::Threading::{GetCurrentProcess, PROCESS_ALL_ACCESS};
use windows::core::PWSTR;

use crate::sid::LocalPsid;

/// Owner-Rights well-known SID (`S-1-3-4`). An ALLOW ACE on this SID
/// REPLACES the implicit `READ_CONTROL|WRITE_DAC` the object's owner
/// otherwise gets. Mask is `READ_CONTROL` for consistency with
/// [`crate::acl::Allow::OWNER_RIGHTS`]; mask-0 would also work here
/// (this path uses kernel `SetSecurityInfo`, which doesn't drop
/// mask-0 ACEs the way `SetNamedSecurityInfoW` does), but
/// `READ_CONTROL` is the project convention.
const SID_OWNER_RIGHTS: &str = "S-1-3-4";
const READ_CONTROL: u32 = 0x0002_0000;
const SID_SYSTEM: &str = "S-1-5-18";
const SID_BUILTIN_ADMINS: &str = "S-1-5-32-544";

/// Rewrite the current process DACL to SYSTEM + Administrators +
/// `OWNER_RIGHTS:READ_CONTROL`.
pub fn install_broker_dacl() -> Result<()> {
    // RAII over `ConvertStringSidToSidW` → freed via `LocalFree` on
    // drop.
    let system = LocalPsid::from_string(SID_SYSTEM)?;
    let admins = LocalPsid::from_string(SID_BUILTIN_ADMINS)?;
    let owner_rights = LocalPsid::from_string(SID_OWNER_RIGHTS)?;
    let aces: Vec<(windows::Win32::Security::PSID, u32)> = vec![
        (system.as_psid(), PROCESS_ALL_ACCESS.0),
        (admins.as_psid(), PROCESS_ALL_ACCESS.0),
        (owner_rights.as_psid(), READ_CONTROL),
    ];

    // ACL size = header + Σ(ACE fixed prefix + SID body). The fixed
    // prefix of an ACCESS_ALLOWED_ACE is 8 bytes (Header 4 + Mask 4);
    // `SidStart` is the first DWORD of the SID, so total per-ACE =
    // 8 + GetLengthSid.
    const ACE_FIXED: usize = 8;
    let mut total = size_of::<ACL>();
    for (s, _) in &aces {
        let len = unsafe { GetLengthSid(*s) } as usize;
        if len == 0 {
            return Err(anyhow!("GetLengthSid returned 0"));
        }
        total += ACE_FIXED + len;
    }
    total = (total + 3) & !3; // DWORD-align

    let mut buf = vec![0u8; total];
    let acl = buf.as_mut_ptr() as *mut ACL;
    unsafe {
        InitializeAcl(acl, total as u32, ACL_REVISION).context("InitializeAcl")?;
        for (s, mask) in &aces {
            AddAccessAllowedAce(acl, ACL_REVISION, *mask, *s).context("AddAccessAllowedAce")?;
        }
        // PROTECTED strips inherited ACEs — without it the user
        // SID's default "full access to own process" inherited
        // grant fires and the rewrite is a no-op.
        let r = SetSecurityInfo(
            GetCurrentProcess(),
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(acl),
            None,
        );
        if r.is_err() {
            return Err(anyhow!("SetSecurityInfo(broker process DACL): {r:?}"));
        }
    }
    // `buf` can drop here — `SetSecurityInfo` copies the ACL into
    // the kernel object's SECURITY_DESCRIPTOR.

    // Diagnostic: read back and dump the DACL as SDDL so CI can
    // confirm exactly what's on the broker process. Gated on
    // PI_SANDBOX_NATIVE_WIN_DEBUG — production callers (one exec per
    // user command) don't want a stderr line per command.
    if std::env::var_os("PI_SANDBOX_NATIVE_WIN_DEBUG").is_some() {
        match read_self_dacl_sddl() {
            Some(sddl) => eprintln!("pi-sandbox-native: self-protect applied (DACL: {sddl})"),
            None => eprintln!("pi-sandbox-native: self-protect applied"),
        }
    }
    Ok(())
}

/// Best-effort read of the current process's DACL as an SDDL
/// string. Returns `None` on any failure rather than erroring —
/// this is diagnostic only.
fn read_self_dacl_sddl() -> Option<String> {
    use crate::util::{from_pwstr, local_free};
    use windows::Win32::Security::PSECURITY_DESCRIPTOR;
    unsafe {
        let mut psd = PSECURITY_DESCRIPTOR::default();
        let r = GetSecurityInfo(
            HANDLE(GetCurrentProcess().0),
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            None,
            None,
            Some(&mut psd),
        );
        if r.is_err() || psd.0.is_null() {
            return None;
        }
        let mut s = PWSTR::null();
        let ok = ConvertSecurityDescriptorToStringSecurityDescriptorW(
            psd,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut s,
            None,
        );
        local_free(psd.0);
        if ok.is_err() {
            return None;
        }
        let out = from_pwstr(s);
        local_free(s.0 as *mut c_void);
        Some(out)
    }
}
