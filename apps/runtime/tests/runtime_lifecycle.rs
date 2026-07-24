#![cfg(target_os = "macos")]

use std::{
    sync::{Arc, mpsc},
    time::Duration,
};

use debrute_runtime::control::{
    ControlErrorCode, RuntimeControlState, RuntimeShutdown, RuntimeStatus,
};
use uuid::Uuid;

#[test]
fn product_quit_has_no_frontend_blocker_or_flush_protocol() {
    let state = RuntimeControlState::new("runtime-instance", RuntimeStatus::Ready);
    let shutdown = state
        .take_shutdown_receiver()
        .expect("shutdown receiver should be available");

    state
        .request_product_quit()
        .expect("ready Runtime should accept Product Quit");

    assert_eq!(state.status(), RuntimeStatus::Exiting);
    assert_eq!(
        shutdown
            .recv_timeout(Duration::from_secs(1))
            .expect("quit should request shutdown"),
        RuntimeShutdown::ProductQuit
    );
    state
        .request_product_quit()
        .expect("repeated quit should be idempotent");
}

#[test]
fn update_crosses_one_commit_boundary_and_requests_replacement() {
    let state = Arc::new(RuntimeControlState::new(
        "runtime-instance",
        RuntimeStatus::Ready,
    ));
    let shutdown = state
        .take_shutdown_receiver()
        .expect("shutdown receiver should be available");
    let transaction_id = Uuid::new_v4().to_string();
    let (committed, commit_observed) = mpsc::sync_channel(1);
    assert!(state.request_product_update(
        &transaction_id,
        Box::new(move || {
            committed.send(()).expect("commit should be observed");
            Ok(())
        }),
        Box::new(|reason| panic!("update should not be cancelled: {reason}")),
    ));

    commit_observed
        .recv_timeout(Duration::from_secs(1))
        .expect("commit should run");
    assert_eq!(
        shutdown
            .recv_timeout(Duration::from_secs(1))
            .expect("update should request replacement"),
        RuntimeShutdown::ProductUpdate {
            transaction_id: transaction_id.clone(),
        }
    );
    assert_eq!(state.status(), RuntimeStatus::Replacing);
    assert_eq!(
        state.request_product_quit(),
        Err(ControlErrorCode::UpdateCommitInProgress)
    );
}

#[test]
fn system_termination_is_immediate_and_idempotent() {
    let state = RuntimeControlState::new("runtime-instance", RuntimeStatus::Starting);
    let shutdown = state
        .take_shutdown_receiver()
        .expect("shutdown receiver should be available");
    state.request_system_termination();
    state.request_system_termination();
    assert_eq!(state.status(), RuntimeStatus::Exiting);
    assert_eq!(
        shutdown
            .recv_timeout(Duration::from_secs(1))
            .expect("system termination should request shutdown"),
        RuntimeShutdown::SystemTermination
    );
}
