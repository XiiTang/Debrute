#![cfg(target_os = "macos")]

use std::{
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use debrute_runtime::control::{ControlErrorCode, RuntimeControlState, RuntimeStatus};
use uuid::Uuid;

#[test]
fn product_quit_has_no_frontend_blocker_or_flush_protocol() {
    let state = RuntimeControlState::new("runtime-instance");
    assert!(state.finish_startup());

    state
        .request_product_quit()
        .expect("ready Runtime should accept Product Quit");

    assert_eq!(state.status(), RuntimeStatus::Exiting);
    state
        .request_product_quit()
        .expect("repeated quit should be idempotent");
}

#[test]
fn update_crosses_one_commit_boundary_and_requests_replacement() {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    assert!(state.finish_startup());
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
    let deadline = Instant::now() + Duration::from_secs(1);
    while state.status() != RuntimeStatus::Replacing && Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert_eq!(state.status(), RuntimeStatus::Replacing);
    assert_eq!(
        state.request_product_quit(),
        Err(ControlErrorCode::UpdateCommitInProgress)
    );
}

#[test]
fn update_commit_keeps_the_ready_status_readable() {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    assert!(state.finish_startup());
    let transaction_id = Uuid::new_v4().to_string();
    let (commit_started, started) = mpsc::sync_channel(1);
    let (release, commit_release) = mpsc::sync_channel(1);
    assert!(state.request_product_update(
        &transaction_id,
        Box::new(move || {
            commit_started
                .send(())
                .expect("commit start should be observed");
            commit_release.recv().expect("commit should be released");
            Ok(())
        }),
        Box::new(|reason| panic!("update should not be cancelled: {reason}")),
    ));
    started
        .recv_timeout(Duration::from_secs(1))
        .expect("commit should start");

    let (observed_status, observation) = mpsc::sync_channel(1);
    let status_state = Arc::clone(&state);
    let observer = std::thread::spawn(move || {
        observed_status
            .send(status_state.status())
            .expect("status should be observed");
    });
    let status = observation.recv_timeout(Duration::from_millis(100));
    release.send(()).expect("commit should be released");
    observer.join().expect("status observer should finish");

    assert_eq!(
        status.expect("status must stay readable during the commit"),
        RuntimeStatus::Ready
    );
}

#[test]
fn failed_update_commit_returns_to_ready() {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    assert!(state.finish_startup());
    let transaction_id = Uuid::new_v4().to_string();
    let (cancelled, cancellation) = mpsc::sync_channel(1);
    assert!(state.request_product_update(
        &transaction_id,
        Box::new(|| Err("commit failed".to_owned())),
        Box::new(move |reason| {
            cancelled
                .send(reason.to_owned())
                .expect("failure should be observed");
        }),
    ));

    assert_eq!(
        cancellation
            .recv_timeout(Duration::from_secs(1))
            .expect("commit failure should be reported"),
        "commit failed"
    );
    assert_eq!(state.status(), RuntimeStatus::Ready);
}

#[test]
fn startup_completion_cannot_overwrite_product_quit() {
    let state = RuntimeControlState::new("runtime-instance");
    state
        .request_product_quit()
        .expect("Product Quit should be accepted during startup");
    assert!(!state.finish_startup());
    assert_eq!(state.status(), RuntimeStatus::Exiting);
}
