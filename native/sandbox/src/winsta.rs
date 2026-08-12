// Modified for Pi's speculative-action sandbox migration.
//! Per-execution desktop isolation for Windows AppContainer children.

use anyhow::{Context, Result, anyhow};
use std::ffi::c_void;
use std::mem::size_of;
use std::sync::atomic::{AtomicU64, Ordering};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Security::{
    ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, GetUserObjectSecurity,
    InitializeSecurityDescriptor, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    SECURITY_DESCRIPTOR, SetSecurityDescriptorDacl, SetUserObjectSecurity,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, CreateDesktopW, DESKTOP_CONTROL_FLAGS, GetProcessWindowStation,
    GetUserObjectInformationW, HDESK, UOI_NAME,
};
use windows::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION;
use windows::core::PCWSTR;

use crate::acl::{NO_INHERIT, NewAce, ace_sid_is, filter_aces, rebuild_acl};
use crate::sid::{current_user_sid, sid_bytes};
use crate::util::{OwnedSd, wstr};

const STANDARD_RIGHTS_REQUIRED: u32 = 0x000F_0000;
const DESKTOP_ALL_ACCESS: u32 = STANDARD_RIGHTS_REQUIRED | 0x0000_01FF;

// Full station access except WRITE_DAC, WRITE_OWNER, and DELETE. READ_CONTROL
// is required while the loader attaches the child to the isolated desktop.
const WINSTA_ATTACH_MASK: u32 = 0x0002_037F;
static DESKTOP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct IsolatedDesk {
    desktop: HDESK,
    desk_path: Vec<u16>,
}

impl IsolatedDesk {
    pub fn new(package_sid: &str) -> Result<Self> {
        let station = current_winsta_name().context("read current window station")?;
        let counter = DESKTOP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = format!("pi-sandbox-{}-{counter}", std::process::id());
        let name_w = wstr(&name);

        let owner_sid = current_user_sid()?;
        let sd = OwnedSd::from_sddl(&format!(
            "D:P(A;;GA;;;{owner_sid})(A;;GA;;;{package_sid})(A;;GA;;;SY)"
        ))?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd.ptr.0,
            bInheritHandle: false.into(),
        };
        let desktop = unsafe {
            CreateDesktopW(
                PCWSTR(name_w.as_ptr()),
                PCWSTR::null(),
                None,
                DESKTOP_CONTROL_FLAGS(0),
                DESKTOP_ALL_ACCESS,
                Some(&attributes),
            )
        }
        .with_context(|| format!("CreateDesktopW({name}) on {station}"))?;

        Ok(Self {
            desktop,
            desk_path: wstr(&format!("{station}\\{name}")),
        })
    }

    pub fn desktop_name_ptr(&mut self) -> *mut u16 {
        self.desk_path.as_mut_ptr()
    }
}

impl Drop for IsolatedDesk {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseDesktop(self.desktop);
        }
    }
}

/// Grant the package SID enough access to attach to a private desktop on the
/// current station. Existing ACEs are preserved and the operation is idempotent.
pub fn grant_appcontainer_on_winsta(package_sid: &str) -> Result<()> {
    let station = unsafe { GetProcessWindowStation() }.context("GetProcessWindowStation")?;
    if station.0.is_null() {
        return Err(anyhow!("GetProcessWindowStation returned null"));
    }
    let handle = HANDLE(station.0);
    let security_information = DACL_SECURITY_INFORMATION;
    recompose_dacl(
        "window station",
        &sid_bytes(package_sid)?,
        WINSTA_ATTACH_MASK,
        || {
            let mut needed = 0u32;
            unsafe {
                let _ =
                    GetUserObjectSecurity(handle, &security_information.0, None, 0, &mut needed);
            }
            if needed == 0 {
                return Err(anyhow!("GetUserObjectSecurity sizing returned 0"));
            }
            let mut descriptor = vec![0u8; needed as usize];
            unsafe {
                GetUserObjectSecurity(
                    handle,
                    &security_information.0,
                    Some(PSECURITY_DESCRIPTOR(descriptor.as_mut_ptr() as *mut c_void)),
                    needed,
                    &mut needed,
                )
                .context("GetUserObjectSecurity(DACL)")?;
            }
            Ok(descriptor)
        },
        |descriptor| unsafe {
            SetUserObjectSecurity(handle, &security_information, descriptor)
                .context("SetUserObjectSecurity(DACL)")
        },
    )
}

fn recompose_dacl(
    label: &str,
    target_sid: &[u8],
    mask: u32,
    read: impl FnOnce() -> Result<Vec<u8>>,
    write: impl FnOnce(PSECURITY_DESCRIPTOR) -> Result<()>,
) -> Result<()> {
    let descriptor = read()?;
    let mut present = Default::default();
    let mut defaulted = Default::default();
    let mut old: *mut ACL = std::ptr::null_mut();
    unsafe {
        GetSecurityDescriptorDacl(
            PSECURITY_DESCRIPTOR(descriptor.as_ptr() as *mut c_void),
            &mut present,
            &mut old,
            &mut defaulted,
        )
        .with_context(|| format!("GetSecurityDescriptorDacl({label})"))?;
    }
    if present.as_bool() && old.is_null() {
        return Ok(());
    }

    let kept = filter_aces(old, |_, body| !ace_sid_is(body, target_sid))?;
    let sid = PSID(target_sid.as_ptr() as *mut c_void);
    let new = rebuild_acl(kept.2, &[], &kept, &[NewAce::Allow(sid, mask, NO_INHERIT)])?;

    let mut absolute: SECURITY_DESCRIPTOR = Default::default();
    let absolute_ptr = PSECURITY_DESCRIPTOR(&mut absolute as *mut _ as *mut c_void);
    unsafe {
        InitializeSecurityDescriptor(absolute_ptr, SECURITY_DESCRIPTOR_REVISION)
            .with_context(|| format!("InitializeSecurityDescriptor({label})"))?;
        SetSecurityDescriptorDacl(absolute_ptr, true, Some(new.as_ptr()), false)
            .with_context(|| format!("SetSecurityDescriptorDacl({label})"))?;
    }
    write(absolute_ptr)
}

fn current_winsta_name() -> Result<String> {
    let station = unsafe { GetProcessWindowStation() }.context("GetProcessWindowStation")?;
    if station.0.is_null() {
        return Err(anyhow!("GetProcessWindowStation returned null"));
    }
    object_name(HANDLE(station.0))
}

fn object_name(handle: HANDLE) -> Result<String> {
    let mut needed = 0u32;
    unsafe {
        let _ = GetUserObjectInformationW(handle, UOI_NAME, None, 0, Some(&mut needed));
    }
    if needed == 0 {
        return Err(anyhow!("GetUserObjectInformationW sizing returned 0"));
    }
    let mut buffer = vec![0u8; needed as usize];
    unsafe {
        GetUserObjectInformationW(
            handle,
            UOI_NAME,
            Some(buffer.as_mut_ptr() as *mut c_void),
            needed,
            Some(&mut needed),
        )
        .context("GetUserObjectInformationW(UOI_NAME)")?;
    }
    let wide =
        unsafe { std::slice::from_raw_parts(buffer.as_ptr() as *const u16, needed as usize / 2) };
    let end = wide
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(wide.len());
    Ok(String::from_utf16_lossy(&wide[..end]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_isolated_desktop_for_appcontainer_sid() {
        let appcontainer = crate::appcontainer::AppContainer::open().unwrap();
        grant_appcontainer_on_winsta(appcontainer.sid_string()).unwrap();
        let desktop = IsolatedDesk::new(appcontainer.sid_string()).unwrap();
        assert!(!desktop.desk_path.is_empty());
    }
}
