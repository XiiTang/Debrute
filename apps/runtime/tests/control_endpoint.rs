#![cfg(target_os = "macos")]

use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{FileTypeExt, PermissionsExt},
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use debrute_runtime::control::endpoint::{
    ControlEndpointAdapter, ControlEndpointOwnerAdapter, EndpointClaim, EndpointError,
    MacOsControlEndpoint, MacOsControlOwner,
};
use debrute_runtime::control::{
    AcceptedHandshake, CONTROL_PROTOCOL_VERSION, ClientHandshakeError, ClientMessage, ClientRole,
    FrameDecodeError, HandshakeRejection, HandshakeRole, RuntimeStatus, ServerHandshakeError,
    ServerMessage, encode_frame, read_server_frame, request_handshake, serve_handshake,
};
use fs2::FileExt;
use nix::fcntl::{FcntlArg, OFlag, fcntl};

const TEST_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(1);

#[test]
fn first_claim_owns_a_protected_unix_socket() {
    let temp = TestDirectory::new();
    let endpoint = MacOsControlEndpoint::new(temp.path().join("debrute"));

    let claim = endpoint
        .claim_or_connect(Duration::ZERO, TEST_HANDSHAKE_TIMEOUT)
        .expect("first claimant should own the Control endpoint");

    assert!(matches!(claim, EndpointClaim::Owner(_)));
    assert_eq!(mode(endpoint.directory()), 0o700);
    assert_eq!(mode(endpoint.socket_path()), 0o600);
    assert_eq!(mode(endpoint.lock_path()), 0o600);
}

#[test]
fn second_claim_connects_to_the_existing_owner() {
    let temp = TestDirectory::new();
    let endpoint = MacOsControlEndpoint::new(temp.path().join("debrute"));
    let first = endpoint
        .claim_or_connect(Duration::ZERO, TEST_HANDSHAKE_TIMEOUT)
        .expect("first claimant should own the Control endpoint");
    assert!(matches!(first, EndpointClaim::Owner(_)));

    let second = endpoint
        .claim_or_connect(Duration::ZERO, TEST_HANDSHAKE_TIMEOUT)
        .expect("second claimant should connect to the owner");

    assert!(matches!(second, EndpointClaim::Existing(_)));
}

#[test]
fn accepted_connection_uses_blocking_transport() {
    let temp = TestDirectory::new();
    let endpoint = MacOsControlEndpoint::new(temp.path().join("debrute"));
    let (owner, _client) = owner_and_client(&endpoint, TEST_HANDSHAKE_TIMEOUT);
    let connection = owner
        .accept_current_user(TEST_HANDSHAKE_TIMEOUT)
        .expect("same-user connection should be accepted");
    let flags = OFlag::from_bits_retain(
        fcntl(&connection, FcntlArg::F_GETFL).expect("connection flags should be readable"),
    );
    assert!(!flags.contains(OFlag::O_NONBLOCK));
}

#[test]
fn existing_instance_connection_completes_the_typed_handshake() {
    let temp = TestDirectory::new();
    let endpoint = MacOsControlEndpoint::new(temp.path().join("debrute"));
    let (owner, mut client) = owner_and_client(&endpoint, TEST_HANDSHAKE_TIMEOUT);

    let server = std::thread::spawn(move || {
        let mut connection = owner
            .accept_current_user(Duration::from_secs(1))
            .expect("same-user connection should be accepted");
        serve_handshake(&mut connection, "runtime-instance", RuntimeStatus::Starting)
            .expect("server handshake should succeed")
    });

    let accepted = request_handshake(&mut client, ClientRole::Launcher)
        .expect("launcher handshake should be accepted");

    assert_eq!(
        accepted,
        AcceptedHandshake {
            instance_id: "runtime-instance".to_owned(),
            status: RuntimeStatus::Starting,
        }
    );
    assert_eq!(
        server.join().expect("server thread should finish"),
        ClientRole::Launcher
    );
}

#[test]
fn incompatible_handshake_is_typed_and_then_disconnected() {
    let temp = TestDirectory::new();
    let endpoint = MacOsControlEndpoint::new(temp.path().join("debrute"));
    let (owner, mut client) = owner_and_client(&endpoint, TEST_HANDSHAKE_TIMEOUT);

    let server = std::thread::spawn(move || {
        let mut connection = owner
            .accept_current_user(Duration::from_secs(1))
            .expect("same-user connection should be accepted");
        serve_handshake(&mut connection, "runtime-instance", RuntimeStatus::Ready)
    });
    let incompatible = ClientMessage::Handshake {
        protocol: "debrute-control".to_owned(),
        protocol_version: CONTROL_PROTOCOL_VERSION,
        product_version: "99.0.0".to_owned(),
        role: ClientRole::Launcher.into(),
    };
    client
        .write_all(&encode_frame(&incompatible).expect("incompatible handshake should encode"))
        .expect("incompatible handshake should be written");

    assert_eq!(
        read_server_frame(&mut client).expect("typed rejection should be readable"),
        ServerMessage::HandshakeRejected {
            reason: HandshakeRejection::IncompatibleProductVersion,
        }
    );
    assert!(matches!(
        server.join().expect("server thread should finish"),
        Err(ServerHandshakeError::Rejected(
            HandshakeRejection::IncompatibleProductVersion
        ))
    ));
    let mut byte = [0_u8; 1];
    assert_eq!(
        client
            .read(&mut byte)
            .expect("connection close should be observable"),
        0
    );
}

#[test]
fn claimant_waits_for_the_starting_owner_and_connects() {
    let temp = TestDirectory::new();
    let endpoint = MacOsControlEndpoint::new(temp.path().join("debrute"));
    fs::create_dir_all(endpoint.directory()).expect("endpoint directory should be created");
    let startup_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(endpoint.lock_path())
        .expect("startup lock should open");
    FileExt::try_lock_exclusive(&startup_lock).expect("startup lock should be held");

    let socket_path = endpoint.socket_path().to_owned();
    let starter = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        let listener = UnixListener::bind(&socket_path)
            .expect("simulated starting owner should bind its endpoint");
        let _accepted = listener
            .accept()
            .expect("simulated starting owner should receive claimant connection");
        FileExt::unlock(&startup_lock).expect("simulated startup lock should release");
    });

    let claimant = endpoint
        .claim_or_connect(Duration::from_secs(1), TEST_HANDSHAKE_TIMEOUT)
        .expect("losing claimant should wait for and connect to the owner");

    assert!(matches!(claimant, EndpointClaim::Existing(_)));
    starter.join().expect("starter thread should finish");
}

#[test]
fn claimant_times_out_without_starting_a_parallel_owner() {
    let temp = TestDirectory::new();
    let endpoint = MacOsControlEndpoint::new(temp.path().join("debrute"));
    fs::create_dir_all(endpoint.directory()).expect("endpoint directory should be created");
    let startup_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(endpoint.lock_path())
        .expect("startup lock should open");
    FileExt::try_lock_exclusive(&startup_lock).expect("startup lock should be held");

    let error = endpoint
        .claim_or_connect(Duration::from_millis(20), TEST_HANDSHAKE_TIMEOUT)
        .expect_err("claimant must not start a parallel owner while startup lock is held");

    assert!(matches!(error, EndpointError::StartupTimedOut));
    assert!(!endpoint.socket_path().exists());
}

#[test]
fn stale_socket_is_replaced_only_after_instance_lock_is_acquired() {
    let temp = TestDirectory::new();
    let endpoint = MacOsControlEndpoint::new(temp.path().join("debrute"));
    fs::create_dir_all(endpoint.directory()).expect("endpoint directory should be created");
    UnixListener::bind(endpoint.socket_path()).expect("stale socket should bind");

    let claim = endpoint
        .claim_or_connect(Duration::ZERO, TEST_HANDSHAKE_TIMEOUT)
        .expect("claimant should replace a stale socket after taking ownership");

    assert!(matches!(claim, EndpointClaim::Owner(_)));
    assert!(
        fs::symlink_metadata(endpoint.socket_path())
            .expect("replacement socket should have metadata")
            .file_type()
            .is_socket()
    );
}

#[test]
fn non_socket_endpoint_occupant_is_not_removed() {
    let temp = TestDirectory::new();
    let endpoint = MacOsControlEndpoint::new(temp.path().join("debrute"));
    fs::create_dir_all(endpoint.directory()).expect("endpoint directory should be created");
    fs::write(endpoint.socket_path(), b"not a socket").expect("occupant should be written");

    let error = endpoint
        .claim_or_connect(Duration::ZERO, TEST_HANDSHAKE_TIMEOUT)
        .expect_err("claimant must not remove an unknown endpoint occupant");

    assert!(
        matches!(error, EndpointError::Io(ref error) if error.kind() == std::io::ErrorKind::AlreadyExists),
        "unexpected error: {error:?}"
    );
    assert_eq!(
        fs::read(endpoint.socket_path()).expect("occupant should remain"),
        b"not a socket"
    );
}

#[test]
fn product_message_before_handshake_is_rejected_by_closing_the_connection() {
    let temp = TestDirectory::new();
    let endpoint = MacOsControlEndpoint::new(temp.path().join("debrute"));
    let (owner, mut client) = owner_and_client(&endpoint, TEST_HANDSHAKE_TIMEOUT);

    let server = std::thread::spawn(move || {
        let mut connection = owner
            .accept_current_user(Duration::from_secs(1))
            .expect("same-user connection should be accepted");
        serve_handshake(&mut connection, "runtime-instance", RuntimeStatus::Ready)
    });
    write_raw_json_frame(
        &mut client,
        br#"{"type":"request","id":"1","method":"project.open"}"#,
    );

    assert!(matches!(
        server.join().expect("server thread should finish"),
        Err(ServerHandshakeError::Decode(_))
    ));
    let mut byte = [0_u8; 1];
    assert_eq!(
        client
            .read(&mut byte)
            .expect("connection close should be observable"),
        0
    );
}

#[test]
fn unknown_role_receives_a_typed_rejection() {
    let temp = TestDirectory::new();
    let endpoint = MacOsControlEndpoint::new(temp.path().join("debrute"));
    let (owner, mut client) = owner_and_client(&endpoint, TEST_HANDSHAKE_TIMEOUT);

    let server = std::thread::spawn(move || {
        let mut connection = owner
            .accept_current_user(TEST_HANDSHAKE_TIMEOUT)
            .expect("same-user connection should be accepted");
        serve_handshake(&mut connection, "runtime-instance", RuntimeStatus::Starting)
    });
    let unsupported = ClientMessage::Handshake {
        protocol: "debrute-control".to_owned(),
        protocol_version: CONTROL_PROTOCOL_VERSION,
        product_version: "0.0.3".to_owned(),
        role: HandshakeRole::Unsupported("web".to_owned()),
    };
    client
        .write_all(&encode_frame(&unsupported).expect("unsupported handshake should encode"))
        .expect("unsupported handshake should be written");

    assert_eq!(
        read_server_frame(&mut client).expect("typed rejection should be readable"),
        ServerMessage::HandshakeRejected {
            reason: HandshakeRejection::UnsupportedRole,
        }
    );
    assert!(matches!(
        server.join().expect("server thread should finish"),
        Err(ServerHandshakeError::Rejected(
            HandshakeRejection::UnsupportedRole
        ))
    ));
}

#[test]
fn existing_instance_handshake_has_a_bounded_read() {
    let temp = TestDirectory::new();
    let endpoint = MacOsControlEndpoint::new(temp.path().join("debrute"));
    let timeout = Duration::from_millis(20);
    let (owner, mut client) = owner_and_client(&endpoint, timeout);
    let server = std::thread::spawn(move || {
        let _connection = owner
            .accept_current_user(TEST_HANDSHAKE_TIMEOUT)
            .expect("same-user connection should be accepted");
        std::thread::sleep(Duration::from_millis(100));
    });

    let error = request_handshake(&mut client, ClientRole::Launcher)
        .expect_err("silent existing endpoint must not block a launcher indefinitely");

    assert!(matches!(
        error,
        ClientHandshakeError::Decode(FrameDecodeError::Read(ref error))
            if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)
    ));
    server.join().expect("server thread should finish");
}

fn owner_and_client(
    endpoint: &MacOsControlEndpoint,
    handshake_timeout: Duration,
) -> (MacOsControlOwner, UnixStream) {
    let EndpointClaim::Owner(owner) = endpoint
        .claim_or_connect(Duration::ZERO, handshake_timeout)
        .expect("first claimant should own the Control endpoint")
    else {
        panic!("first claimant unexpectedly connected to an existing endpoint");
    };
    let EndpointClaim::Existing(client) = endpoint
        .claim_or_connect(Duration::ZERO, handshake_timeout)
        .expect("second claimant should connect to the owner")
    else {
        panic!("second claimant unexpectedly owned the endpoint");
    };
    (owner, client)
}

fn write_raw_json_frame(writer: &mut impl Write, payload: &[u8]) {
    let length = u32::try_from(payload.len()).expect("test payload should fit in a frame");
    writer
        .write_all(&length.to_be_bytes())
        .expect("frame header should be written");
    writer
        .write_all(payload)
        .expect("frame payload should be written");
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path)
        .unwrap_or_else(|error| panic!("{} should have metadata: {error}", path.display()))
        .permissions()
        .mode()
        & 0o777
}

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("dbrt-{:x}-{id}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir(&path).expect("test root should be created");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
