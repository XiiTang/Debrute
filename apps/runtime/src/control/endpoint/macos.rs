use std::{
    fs::{self, File, OpenOptions},
    io,
    os::unix::{
        fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use fs2::FileExt;
use nix::unistd::{geteuid, getpeereid};

use super::{
    ControlEndpointAdapter, ControlEndpointKind, ControlEndpointOwnerAdapter, EndpointClaim,
    EndpointError,
};

const SOCKET_FILE_NAME: &str = "control.sock";
const LOCK_FILE_NAME: &str = "runtime.lock";

#[derive(Debug, Clone)]
pub struct MacOsControlEndpoint {
    directory: PathBuf,
    socket_path: PathBuf,
    lock_path: PathBuf,
}

impl MacOsControlEndpoint {
    #[must_use]
    pub fn for_current_user() -> Self {
        Self::new(std::env::temp_dir().join("debrute"))
    }

    #[must_use]
    pub fn new(directory: PathBuf) -> Self {
        Self {
            socket_path: directory.join(SOCKET_FILE_NAME),
            lock_path: directory.join(LOCK_FILE_NAME),
            directory,
        }
    }

    #[must_use]
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    #[must_use]
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    #[must_use]
    pub fn lock_path(&self) -> &Path {
        &self.lock_path
    }

    /// Connects one local stream so lifecycle supervision can wake a blocking
    /// owner accept during Runtime shutdown.
    ///
    /// # Errors
    ///
    /// Returns an I/O error when the owned socket cannot be connected.
    pub fn wake_accept(&self) -> io::Result<UnixStream> {
        UnixStream::connect(&self.socket_path)
    }

    fn materialize_directory(&self) -> Result<(), EndpointError> {
        fs::create_dir_all(&self.directory)?;
        let metadata = fs::symlink_metadata(&self.directory)?;
        if !metadata.file_type().is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "Control endpoint directory is not a directory: {}",
                    self.directory.display()
                ),
            )
            .into());
        }
        let current_uid = geteuid().as_raw();
        if metadata.uid() != current_uid {
            return Err(EndpointError::EndpointDirectoryOwnerMismatch {
                expected: current_uid,
                actual: metadata.uid(),
            });
        }
        fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))?;
        Ok(())
    }

    fn open_instance_lock(&self) -> Result<File, EndpointError> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(&self.lock_path)?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        Ok(file)
    }

    fn remove_stale_socket(&self) -> Result<(), EndpointError> {
        let metadata = match fs::symlink_metadata(&self.socket_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        if !metadata.file_type().is_socket() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!(
                    "Control socket path is occupied by a non-socket: {}",
                    self.socket_path.display()
                ),
            )
            .into());
        }
        fs::remove_file(&self.socket_path)?;
        Ok(())
    }
}

impl ControlEndpointAdapter for MacOsControlEndpoint {
    const KIND: ControlEndpointKind = ControlEndpointKind::MacOsUnixDomainSocket;
    type Owner = MacOsControlOwner;
    type Connection = UnixStream;

    fn connect_existing(
        &self,
        handshake_timeout: Duration,
    ) -> Result<Self::Connection, EndpointError> {
        let stream = UnixStream::connect(&self.socket_path).map_err(|error| {
            if is_absent_endpoint_error(&error) {
                EndpointError::Absent
            } else {
                EndpointError::Io(error)
            }
        })?;
        stream.set_read_timeout(Some(handshake_timeout))?;
        stream.set_write_timeout(Some(handshake_timeout))?;
        Ok(stream)
    }

    fn claim_or_connect(
        &self,
        startup_wait: Duration,
        handshake_timeout: Duration,
    ) -> Result<EndpointClaim<Self::Owner, Self::Connection>, EndpointError> {
        self.materialize_directory()?;
        let started_at = Instant::now();
        let deadline = started_at.checked_add(startup_wait).ok_or_else(|| {
            EndpointError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Control endpoint startup wait is too large",
            ))
        })?;

        loop {
            match UnixStream::connect(&self.socket_path) {
                Ok(stream) => {
                    stream.set_read_timeout(Some(handshake_timeout))?;
                    stream.set_write_timeout(Some(handshake_timeout))?;
                    return Ok(EndpointClaim::Existing(stream));
                }
                Err(error) if is_absent_endpoint_error(&error) => {}
                Err(error) => return Err(error.into()),
            }

            let instance_lock = self.open_instance_lock()?;
            match FileExt::try_lock_exclusive(&instance_lock) {
                Ok(()) => {
                    self.remove_stale_socket()?;
                    let listener = UnixListener::bind(&self.socket_path)?;
                    fs::set_permissions(&self.socket_path, fs::Permissions::from_mode(0o600))?;
                    return Ok(EndpointClaim::Owner(MacOsControlOwner {
                        listener,
                        instance_lock,
                        socket_path: self.socket_path.clone(),
                    }));
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error.into()),
            }

            let now = Instant::now();
            if now >= deadline {
                return Err(EndpointError::StartupTimedOut);
            }
            thread::sleep((deadline - now).min(Duration::from_millis(10)));
        }
    }
}

#[derive(Debug)]
pub struct MacOsControlOwner {
    listener: UnixListener,
    instance_lock: File,
    socket_path: PathBuf,
}

impl ControlEndpointOwnerAdapter for MacOsControlOwner {
    type Connection = UnixStream;

    fn accept_current_user(
        &self,
        handshake_timeout: Duration,
    ) -> Result<Self::Connection, EndpointError> {
        let (stream, _) = self.listener.accept()?;
        let (peer_uid, _) = getpeereid(&stream).map_err(errno_to_io)?;
        let current_uid = geteuid();
        authorize_peer_user(current_uid.as_raw(), peer_uid.as_raw())?;
        stream.set_read_timeout(Some(handshake_timeout))?;
        stream.set_write_timeout(Some(handshake_timeout))?;
        Ok(stream)
    }
}

impl Drop for MacOsControlOwner {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket_path);
        let _ = FileExt::unlock(&self.instance_lock);
    }
}

fn authorize_peer_user(expected: u32, actual: u32) -> Result<(), EndpointError> {
    if expected == actual {
        Ok(())
    } else {
        Err(EndpointError::PeerUserMismatch { expected, actual })
    }
}

fn errno_to_io(error: nix::errno::Errno) -> EndpointError {
    EndpointError::Io(io::Error::from_raw_os_error(error as i32))
}

fn is_absent_endpoint_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
    ) || matches!(
        error.raw_os_error(),
        Some(nix::libc::ENOENT | nix::libc::ECONNREFUSED | nix::libc::ENOTSOCK)
    )
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Write, thread, time::Duration};

    use uuid::Uuid;

    use super::{MacOsControlEndpoint, authorize_peer_user};
    use crate::control::endpoint::{
        ControlEndpointAdapter, ControlEndpointOwnerAdapter, EndpointClaim, EndpointError,
    };

    #[test]
    fn different_operating_system_user_is_rejected() {
        assert!(matches!(
            authorize_peer_user(501, 502),
            Err(EndpointError::PeerUserMismatch {
                expected: 501,
                actual: 502,
            })
        ));
    }

    #[test]
    fn connect_existing_never_materializes_or_claims_an_absent_endpoint() {
        let directory =
            std::path::PathBuf::from("/tmp").join(format!("dbrt-ce-{}", Uuid::new_v4().simple()));
        let endpoint = MacOsControlEndpoint::new(directory.clone());

        let error = endpoint
            .connect_existing(Duration::from_millis(10))
            .expect_err("an absent endpoint must stay absent");

        assert!(error.is_absent(), "unexpected endpoint error: {error:?}");
        assert!(!directory.exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn lifecycle_wake_connection_unblocks_the_owner_accept() {
        let directory =
            std::path::PathBuf::from("/tmp").join(format!("dbrt-ce-{}", Uuid::new_v4().simple()));
        let endpoint = MacOsControlEndpoint::new(directory.clone());
        let EndpointClaim::Owner(owner) = endpoint
            .claim_or_connect(Duration::from_millis(100), Duration::from_millis(250))
            .expect("test endpoint should be owned")
        else {
            panic!("test endpoint unexpectedly had an existing owner");
        };
        let accepted = thread::spawn(move || {
            owner
                .accept_current_user(Duration::from_millis(250))
                .expect("wake connection should be accepted")
        });
        let mut wake = endpoint
            .wake_accept()
            .expect("wake connection should connect");
        wake.write_all(b"x")
            .expect("wake stream should be writable");
        drop(accepted.join().expect("owner thread should finish"));
        let _ = fs::remove_dir_all(directory);
    }
}
