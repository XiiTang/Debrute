use std::{
    error::Error,
    fmt,
    path::{Path, PathBuf},
};

use super::CommitPlatform;

pub(super) const OFFICIAL_SKILL_PREFIX: &str = "debrute-";
#[cfg(target_os = "windows")]
pub(super) const WINDOWS_INSTALLER_GUID: &str = "708c37b7-2547-5a47-9bfa-42bb13156a66";
#[cfg(target_os = "windows")]
pub(super) const WINDOWS_INSTALLER_CACHE_DIRECTORY: &str = "@debrutedesktop-updater";
#[cfg(target_os = "windows")]
pub(super) const WINDOWS_SHORTCUT_NAME: &str = "Debrute.lnk";

/// The complete deterministic per-user ownership boundary for one installed Product.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledProductLayout {
    platform: CommitPlatform,
    user_home: PathBuf,
    debrute_home: PathBuf,
    product_root: PathBuf,
    bin_directory: PathBuf,
    skills_directory: PathBuf,
    desktop_application: PathBuf,
    desktop_executable: PathBuf,
}

impl InstalledProductLayout {
    /// Resolves the current user's closed Product layout without accepting caller-owned paths.
    ///
    /// # Errors
    ///
    /// Returns [`ProductLayoutError`] when the operating-system user roots are unavailable.
    pub fn for_current_user() -> Result<Self, ProductLayoutError> {
        #[cfg(target_os = "macos")]
        {
            use nix::unistd::{Uid, User};

            let user = User::from_uid(Uid::current())
                .map_err(|_| ProductLayoutError::UserHomeMissing)?
                .ok_or(ProductLayoutError::UserHomeMissing)?;
            Self::for_roots(CommitPlatform::Macos, user.dir, None)
        }
        #[cfg(target_os = "windows")]
        {
            let user_home = debrute_windows_product_fs::current_user_profile_directory()
                .map_err(|_| ProductLayoutError::UserHomeMissing)?;
            let local_app_data =
                debrute_windows_product_fs::current_user_local_app_data_directory()
                    .map_err(|_| ProductLayoutError::LocalAppDataMissing)?;
            Self::for_roots(CommitPlatform::Windows, user_home, Some(local_app_data))
        }
    }

    /// Builds the internal layout from already-resolved operating-system roots.
    /// Product commands use [`Self::for_current_user`]; crate tests supply
    /// deterministic roots through this crate-private constructor.
    ///
    /// # Errors
    ///
    /// Returns [`ProductLayoutError`] when a required root is empty or missing.
    pub(crate) fn for_roots(
        platform: CommitPlatform,
        user_home: PathBuf,
        local_app_data: Option<PathBuf>,
    ) -> Result<Self, ProductLayoutError> {
        if user_home.as_os_str().is_empty() {
            return Err(ProductLayoutError::UserHomeMissing);
        }
        let debrute_home = user_home.join(".debrute");
        let (desktop_application, desktop_executable) = match platform {
            CommitPlatform::Macos => {
                let application = user_home.join("Applications/Debrute.app");
                let executable = application.join("Contents/MacOS/Debrute");
                (application, executable)
            }
            CommitPlatform::Windows => {
                let local_app_data = local_app_data
                    .filter(|path| !path.as_os_str().is_empty())
                    .ok_or(ProductLayoutError::LocalAppDataMissing)?;
                let application = local_app_data.join("Programs/Debrute");
                let executable = application.join("Debrute.exe");
                (application, executable)
            }
        };
        Ok(Self {
            platform,
            product_root: debrute_home.join("products"),
            bin_directory: debrute_home.join("bin"),
            skills_directory: user_home.join(".agents/skills"),
            user_home,
            debrute_home,
            desktop_application,
            desktop_executable,
        })
    }

    #[must_use]
    pub const fn platform(&self) -> CommitPlatform {
        self.platform
    }

    #[must_use]
    pub fn user_home(&self) -> &Path {
        &self.user_home
    }

    #[must_use]
    pub fn debrute_home(&self) -> &Path {
        &self.debrute_home
    }

    #[must_use]
    pub fn product_root(&self) -> &Path {
        &self.product_root
    }

    #[must_use]
    pub fn bin_directory(&self) -> &Path {
        &self.bin_directory
    }

    #[must_use]
    pub fn skills_directory(&self) -> &Path {
        &self.skills_directory
    }

    #[must_use]
    pub fn desktop_application(&self) -> &Path {
        &self.desktop_application
    }

    #[must_use]
    pub fn desktop_executable(&self) -> &Path {
        &self.desktop_executable
    }

    #[must_use]
    pub fn desktop_product_seed(&self) -> PathBuf {
        match self.platform {
            CommitPlatform::Macos => self
                .desktop_application
                .join("Contents/Resources/product-seed"),
            CommitPlatform::Windows => self.desktop_application.join("resources/product-seed"),
        }
    }

    #[must_use]
    pub fn global_settings_file(&self) -> PathBuf {
        self.debrute_home.join("config/global_settings.json")
    }

    #[must_use]
    pub fn secrets_file(&self) -> PathBuf {
        self.debrute_home.join("config/secrets.json")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProductLayoutError {
    UserHomeMissing,
    LocalAppDataMissing,
}

impl fmt::Display for ProductLayoutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UserHomeMissing => formatter.write_str("The current user home is unavailable"),
            Self::LocalAppDataMissing => {
                formatter.write_str("The current Windows Local AppData directory is unavailable")
            }
        }
    }
}

impl Error for ProductLayoutError {}
