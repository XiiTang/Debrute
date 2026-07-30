#![cfg(target_os = "macos")]

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use debrute_runtime::control::{
    ActivationIntent, ActivationOutcome, ControlErrorCode, ProductUpdateTransitionFailure,
    RuntimeActivationService, RuntimeControlState, RuntimeStatus,
};
use uuid::Uuid;

struct CountingActivation {
    calls: Arc<AtomicUsize>,
}

impl RuntimeActivationService for CountingActivation {
    fn activate(
        &self,
        _intent: &ActivationIntent,
        _preferred_desktop_window_key: Option<&str>,
    ) -> Result<ActivationOutcome, ControlErrorCode> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ActivationOutcome::Opened)
    }
}

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
fn queued_activation_is_rejected_after_product_quit_before_reaching_the_platform() {
    let state = RuntimeControlState::new("runtime-instance");
    assert!(state.finish_startup());
    let calls = Arc::new(AtomicUsize::new(0));
    assert!(
        state.install_activation_service(Arc::new(CountingActivation {
            calls: Arc::clone(&calls),
        }))
    );

    state
        .request_product_quit()
        .expect("ready Runtime should accept Product Quit");

    assert_eq!(
        state.activate_intent(&ActivationIntent::OpenDesktop, None),
        Err(ControlErrorCode::RuntimeExiting)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn update_crosses_one_commit_boundary_and_requests_replacement() {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    assert!(state.finish_startup());
    let calls = Arc::new(AtomicUsize::new(0));
    assert!(
        state.install_activation_service(Arc::new(CountingActivation {
            calls: Arc::clone(&calls),
        }))
    );
    let transaction_id = Uuid::new_v4().to_string();
    let (committed, commit_observed) = mpsc::sync_channel(1);
    assert!(state.request_product_update(
        &transaction_id,
        Box::new(|| {}),
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
    assert_eq!(
        state.activate_intent(&ActivationIntent::OpenDesktop, None),
        Err(ControlErrorCode::UpdateCommitInProgress)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
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
        Box::new(|| {}),
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
fn failed_reversible_update_preparation_returns_to_ready() {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    assert!(state.finish_startup());
    let transaction_id = Uuid::new_v4().to_string();
    let (cancelled, cancellation) = mpsc::sync_channel(1);
    assert!(state.request_product_update(
        &transaction_id,
        Box::new(|| {}),
        Box::new(|| Err(ProductUpdateTransitionFailure::preparing("commit failed"))),
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
fn forward_only_update_failure_keeps_replacement_ownership() {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    assert!(state.finish_startup());
    let transaction_id = Uuid::new_v4().to_string();
    let (cancelled, cancellation) = mpsc::sync_channel(1);
    assert!(state.request_product_update(
        &transaction_id,
        Box::new(|| {}),
        Box::new(|| Err(ProductUpdateTransitionFailure::committing("target failed"))),
        Box::new(move |reason| {
            cancelled
                .send(reason.to_owned())
                .expect("failure should be observed");
        }),
    ));

    assert_eq!(
        cancellation.recv_timeout(Duration::from_secs(1)).unwrap(),
        "target failed"
    );
    assert_eq!(state.status(), RuntimeStatus::Replacing);
    assert_eq!(
        state.request_product_quit(),
        Err(ControlErrorCode::UpdateCommitInProgress)
    );
}

#[test]
fn accepted_update_closes_new_work_and_drains_existing_work_before_preparation() {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    assert!(state.finish_startup());
    let permit = state
        .begin_product_work()
        .expect("Ready Runtime should admit work");
    let (started, observed) = mpsc::sync_channel(1);
    assert!(state.request_product_update(
        &Uuid::new_v4().to_string(),
        Box::new(|| {}),
        Box::new(move || {
            started.send(()).unwrap();
            Ok(())
        }),
        Box::new(|reason| panic!("update should not be cancelled: {reason}")),
    ));

    assert!(state.begin_product_work().is_none());
    assert_eq!(
        state.request_product_quit(),
        Err(ControlErrorCode::UpdateCommitInProgress)
    );
    assert!(observed.recv_timeout(Duration::from_millis(100)).is_err());
    drop(permit);
    observed.recv_timeout(Duration::from_secs(1)).unwrap();
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
