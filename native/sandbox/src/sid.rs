// Modified for Pi's speculative-action sandbox migration.
//! Owned SID conversion helpers for the Windows sandbox backend.

use anyhow::{Context, Result, anyhow};
use std::ffi::c_void;
use windows::Win32::Foundation::{HANDLE, LocalFree};
use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSidToSidW};
use windows::Win32::Security::{GetLengthSid, GetTokenInformation, PSID, TOKEN_QUERY, TokenUser};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::core::PWSTR;

use crate::util::{OwnedHandle, from_pwstr, local_free, wstr};

pub struct LocalPsid(PSID);

impl LocalPsid {
    pub fn from_string(value: &str) -> Result<Self> {
        let value_w = wstr(value);
        let mut sid = PSID::default();
        unsafe { ConvertStringSidToSidW(windows::core::PCWSTR(value_w.as_ptr()), &mut sid) }
            .with_context(|| format!("ConvertStringSidToSidW({value})"))?;
        Ok(Self(sid))
    }

    pub fn as_psid(&self) -> PSID {
        self.0
    }

    pub fn as_bytes(&self) -> &[u8] {
        let length = unsafe { GetLengthSid(self.0) } as usize;
        unsafe { std::slice::from_raw_parts(self.0.0 as *const u8, length) }
    }
}

impl Drop for LocalPsid {
    fn drop(&mut self) {
        if !self.0.0.is_null() {
            unsafe {
                let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(self.0.0)));
            }
        }
    }
}

pub fn sid_bytes(value: &str) -> Result<Vec<u8>> {
    Ok(LocalPsid::from_string(value)?.as_bytes().to_vec())
}

pub fn psid_to_string(sid: PSID) -> Result<String> {
    if sid.0.is_null() {
        return Err(anyhow!("null SID"));
    }
    let mut string = PWSTR::null();
    unsafe { ConvertSidToStringSidW(sid, &mut string) }.context("ConvertSidToStringSidW")?;
    let result = from_pwstr(string);
    local_free(string.0 as *mut c_void);
    Ok(result)
}

pub fn current_user_sid() -> Result<String> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
        .context("OpenProcessToken")?;
    let token = OwnedHandle(token);
    let mut size = 0u32;
    unsafe {
        let _ = GetTokenInformation(token.raw(), TokenUser, None, 0, &mut size);
    }
    if size == 0 {
        return Err(anyhow!("GetTokenInformation(TokenUser) sizing returned 0"));
    }
    let mut buffer = vec![0u8; size as usize];
    unsafe {
        GetTokenInformation(
            token.raw(),
            TokenUser,
            Some(buffer.as_mut_ptr() as *mut c_void),
            size,
            &mut size,
        )
        .context("GetTokenInformation(TokenUser)")?;
        let user = &*(buffer.as_ptr() as *const windows::Win32::Security::TOKEN_USER);
        psid_to_string(user.User.Sid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sid_round_trip() {
        let value = current_user_sid().unwrap();
        let sid = LocalPsid::from_string(&value).unwrap();
        assert_eq!(psid_to_string(sid.as_psid()).unwrap(), value);
    }
}
