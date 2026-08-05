// Modified for Pi's speculative-action sandbox migration.
//! Additive filesystem ACL access for the Windows AppContainer workspace.

use anyhow::{Context, Result, anyhow, bail};
use std::ffi::c_void;
use std::mem::size_of;
use windows::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SE_FILE_OBJECT, SetNamedSecurityInfoW,
};
use windows::Win32::Security::{
    ACE_FLAGS, ACE_HEADER, ACE_REVISION, ACL, ACL_REVISION, ACL_SIZE_INFORMATION,
    AclSizeInformation, AddAccessAllowedAceEx, AddAce, CONTAINER_INHERIT_ACE,
    DACL_SECURITY_INFORMATION, GetAce, GetAclInformation, GetLengthSid, INHERITED_ACE,
    InitializeAcl, OBJECT_INHERIT_ACE, PSECURITY_DESCRIPTOR, PSID,
    UNPROTECTED_DACL_SECURITY_INFORMATION,
};
use windows::Win32::Storage::FileSystem::{
    FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
};

use crate::sid::LocalPsid;
use crate::util::{OwnedSd, pcwstr, win32_ok, wstr};

const ACE_FIXED_BYTES: usize = 8;
const WORKSPACE_ACCESS: u32 = FILE_GENERIC_READ.0
    | FILE_GENERIC_WRITE.0
    | FILE_GENERIC_EXECUTE.0
    | 0x0001_0000 // DELETE
    | 0x0000_0040; // FILE_DELETE_CHILD
const INHERIT_TO_CHILDREN: ACE_FLAGS = ACE_FLAGS(CONTAINER_INHERIT_ACE.0 | OBJECT_INHERIT_ACE.0);
pub(crate) const NO_INHERIT: ACE_FLAGS = ACE_FLAGS(0);

pub(crate) struct BuiltAcl {
    bytes: Vec<u8>,
}

impl BuiltAcl {
    pub(crate) fn as_ptr(&self) -> *const ACL {
        self.bytes.as_ptr() as *const ACL
    }
}

pub(crate) enum NewAce {
    Allow(PSID, u32, ACE_FLAGS),
}

impl NewAce {
    fn sid(&self) -> PSID {
        match self {
            Self::Allow(sid, ..) => *sid,
        }
    }
}

pub(crate) type KeptAces = (Vec<(*const c_void, u16)>, usize, ACE_REVISION);

pub(crate) fn rebuild_acl(
    revision: ACE_REVISION,
    head: &[NewAce],
    kept: &KeptAces,
    tail: &[NewAce],
) -> Result<BuiltAcl> {
    let mut size = size_of::<ACL>() + kept.1;
    for ace in head.iter().chain(tail) {
        size += ACE_FIXED_BYTES + unsafe { GetLengthSid(ace.sid()) } as usize;
    }
    size = (size + 3) & !3;
    let mut bytes = vec![0u8; size];
    let acl = bytes.as_mut_ptr() as *mut ACL;
    unsafe { InitializeAcl(acl, size as u32, revision) }.context("InitializeAcl")?;

    let add = |ace: &NewAce| match *ace {
        NewAce::Allow(sid, mask, flags) => {
            unsafe { AddAccessAllowedAceEx(acl, revision, flags, mask, sid) }
                .with_context(|| format!("AddAccessAllowedAceEx({mask:#x})"))
        }
    };
    head.iter().try_for_each(&add)?;
    for (ace, ace_size) in &kept.0 {
        unsafe { AddAce(acl, revision, u32::MAX, *ace, *ace_size as u32) }
            .context("AddAce(existing)")?;
    }
    tail.iter().try_for_each(&add)?;
    Ok(BuiltAcl { bytes })
}

pub(crate) fn filter_aces(
    acl: *const ACL,
    mut keep: impl FnMut(&ACE_HEADER, &[u8]) -> bool,
) -> Result<KeptAces> {
    if acl.is_null() {
        return Ok((Vec::new(), 0, ACL_REVISION));
    }
    let revision = ACE_REVISION(unsafe { (*acl).AclRevision } as u32);
    let mut information = ACL_SIZE_INFORMATION::default();
    unsafe {
        GetAclInformation(
            acl,
            &mut information as *mut _ as *mut c_void,
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
        .context("GetAclInformation")?;
    }
    let mut result = Vec::new();
    let mut size = 0usize;
    for index in 0..information.AceCount {
        let mut ace: *mut c_void = std::ptr::null_mut();
        unsafe { GetAce(acl, index, &mut ace) }
            .map_err(|error| anyhow!("GetAce({index}): {error}"))?;
        if ace.is_null() {
            bail!("GetAce({index}) returned null");
        }
        let header = unsafe { &*(ace as *const ACE_HEADER) };
        let body = unsafe { std::slice::from_raw_parts(ace as *const u8, header.AceSize as usize) };
        if keep(header, body) {
            result.push((ace as *const c_void, header.AceSize));
            size += header.AceSize as usize;
        }
    }
    Ok((result, size, revision))
}

pub(crate) fn ace_sid_is(body: &[u8], sid: &[u8]) -> bool {
    body.get(ACE_FIXED_BYTES..ACE_FIXED_BYTES + sid.len()) == Some(sid)
}

fn read_file_dacl(path: &str) -> Result<(OwnedSd, *mut ACL)> {
    let path_w = wstr(path);
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let result = unsafe {
        GetNamedSecurityInfoW(
            pcwstr(&path_w),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut dacl),
            None,
            &mut descriptor,
        )
    };
    win32_ok(result, &format!("GetNamedSecurityInfoW('{path}')"))?;
    Ok((OwnedSd::from_raw(descriptor), dacl))
}

fn write_file_dacl(path: &str, acl: *const ACL) -> Result<()> {
    let path_w = wstr(path);
    let result = unsafe {
        SetNamedSecurityInfoW(
            pcwstr(&path_w),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(acl),
            None,
        )
    };
    win32_ok(result, &format!("SetNamedSecurityInfoW('{path}')"))
}

/// Add or remove the package SID's inheritable workspace ACE while preserving
/// unrelated explicit ACEs and re-deriving inherited ACEs from the parent.
pub fn set_appcontainer_workspace_access(
    path: &str,
    package_sid: &str,
    enabled: bool,
) -> Result<()> {
    let sid = LocalPsid::from_string(package_sid)
        .with_context(|| format!("parse AppContainer SID '{package_sid}'"))?;
    let sid_bytes = sid.as_bytes();
    let (_descriptor, old) = read_file_dacl(path)?;
    let kept = filter_aces(old, |header, body| {
        header.AceFlags & INHERITED_ACE.0 as u8 == 0 && !ace_sid_is(body, sid_bytes)
    })?;
    let additions = enabled
        .then(|| NewAce::Allow(sid.as_psid(), WORKSPACE_ACCESS, INHERIT_TO_CHILDREN))
        .into_iter()
        .collect::<Vec<_>>();
    let new = rebuild_acl(kept.2, &additions, &kept, &[])?;
    write_file_dacl(path, new.as_ptr())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package_ace_count(path: &str, sid: &str) -> usize {
        let sid = LocalPsid::from_string(sid).unwrap();
        let (_descriptor, dacl) = read_file_dacl(path).unwrap();
        let mut count = 0;
        filter_aces(dacl, |_, body| {
            if ace_sid_is(body, sid.as_bytes()) {
                count += 1;
            }
            true
        })
        .unwrap();
        count
    }

    #[test]
    fn workspace_access_is_idempotent_and_revocable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().to_str().unwrap();
        let appcontainer = crate::appcontainer::AppContainer::open().unwrap();
        let sid = appcontainer.sid_string();

        set_appcontainer_workspace_access(path, sid, true).unwrap();
        set_appcontainer_workspace_access(path, sid, true).unwrap();
        assert_eq!(package_ace_count(path, sid), 1);

        set_appcontainer_workspace_access(path, sid, false).unwrap();
        assert_eq!(package_ace_count(path, sid), 0);
    }
}
