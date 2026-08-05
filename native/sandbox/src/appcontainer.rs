// Modified for Pi's speculative-action sandbox migration.
use anyhow::{Context, Result, anyhow};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0,
};
use windows::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows::Win32::Security::{FreeSid, PSID, SECURITY_CAPABILITIES};
use windows::Win32::System::Threading::{
    CreateMutexW, INFINITE, ReleaseMutex, WaitForSingleObject,
};
use windows::core::{HRESULT, PCWSTR};

use crate::sid::psid_to_string;
use crate::util::wstr;

const PROFILE_NAME: &str = "Pi.SpeculativeAction";
const PROFILE_MUTEX: &str = r"Local\Pi-SpeculativeAction-AppContainer";

struct ProfileLock(HANDLE);

impl ProfileLock {
    fn acquire() -> Result<Self> {
        let name = wstr(PROFILE_MUTEX);
        let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
            .context("create AppContainer profile mutex")?;
        match unsafe { WaitForSingleObject(handle, INFINITE) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self(handle)),
            result => {
                unsafe {
                    let _ = CloseHandle(handle);
                }
                Err(anyhow!(
                    "wait for AppContainer profile mutex returned {result:?}"
                ))
            }
        }
    }
}

impl Drop for ProfileLock {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}

pub struct AppContainer {
    sid: PSID,
    sid_string: String,
}

impl AppContainer {
    pub fn open() -> Result<Self> {
        let _lock = ProfileLock::acquire()?;
        let name = wstr(PROFILE_NAME);
        let display = wstr("Pi Speculative Action");
        let description = wstr("Process isolation for speculative tool execution");
        let sid = match unsafe {
            CreateAppContainerProfile(
                PCWSTR(name.as_ptr()),
                PCWSTR(display.as_ptr()),
                PCWSTR(description.as_ptr()),
                None,
            )
        } {
            Ok(sid) => sid,
            Err(error) if error.code() == HRESULT::from_win32(ERROR_ALREADY_EXISTS.0) => unsafe {
                DeriveAppContainerSidFromAppContainerName(PCWSTR(name.as_ptr()))
                    .context("derive existing AppContainer SID")?
            },
            Err(error) => return Err(anyhow!(error)).context("create AppContainer profile"),
        };
        let sid_string = psid_to_string(sid).context("stringify AppContainer SID")?;
        Ok(Self { sid, sid_string })
    }

    pub fn sid_string(&self) -> &str {
        &self.sid_string
    }

    pub fn security_capabilities(&self) -> SECURITY_CAPABILITIES {
        SECURITY_CAPABILITIES {
            AppContainerSid: self.sid,
            Capabilities: std::ptr::null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        }
    }
}

impl Drop for AppContainer {
    fn drop(&mut self) {
        if !self.sid.0.is_null() {
            unsafe {
                FreeSid(self.sid);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sid_is_available_without_elevation() {
        let appcontainer = AppContainer::open().unwrap();
        assert!(appcontainer.sid_string().starts_with("S-1-15-2-"));
    }
}
