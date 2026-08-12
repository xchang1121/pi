//! Token helpers for launching an AppContainer process.

use anyhow::{Context, Result};
use std::ffi::c_void;
use std::mem::size_of;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Security::{
    DuplicateTokenEx, GetTokenInformation, SecurityImpersonation, TOKEN_ALL_ACCESS,
    TOKEN_DUPLICATE, TOKEN_QUERY, TokenIsAppContainer, TokenPrimary,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub fn open_self_token() -> Result<HANDLE> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY,
            &mut token,
        )
        .context("OpenProcessToken")?;
        Ok(token)
    }
}

pub fn to_primary(token: HANDLE) -> Result<HANDLE> {
    unsafe {
        let mut primary = HANDLE::default();
        DuplicateTokenEx(
            token,
            TOKEN_ALL_ACCESS,
            None,
            SecurityImpersonation,
            TokenPrimary,
            &mut primary,
        )
        .context("DuplicateTokenEx(primary)")?;
        Ok(primary)
    }
}

pub fn process_is_app_container(process: HANDLE) -> Result<bool> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).context("OpenProcessToken(child)")?;
        let token = crate::util::OwnedHandle(token);
        let mut value = 0u32;
        let mut returned = 0u32;
        GetTokenInformation(
            token.raw(),
            TokenIsAppContainer,
            Some(&mut value as *mut u32 as *mut c_void),
            size_of::<u32>() as u32,
            &mut returned,
        )
        .context("GetTokenInformation(TokenIsAppContainer)")?;
        Ok(value != 0)
    }
}
