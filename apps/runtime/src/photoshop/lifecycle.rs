use std::{
    io,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};

use super::{PhotoshopGatewayServer, PhotoshopIntegration};

const RETRY_INTERVAL: Duration = Duration::from_secs(5);

trait GatewayLease: Send {}

impl GatewayLease for PhotoshopGatewayServer {}

type GatewayStarter = Arc<dyn Fn() -> Option<Box<dyn GatewayLease>> + Send + Sync>;
type AvailabilityObserver = Arc<dyn Fn(bool) + Send + Sync>;

enum LifecycleCommand {
    SetEnabled {
        enabled: bool,
        settled: mpsc::SyncSender<()>,
    },
    #[cfg(test)]
    RetryNow {
        settled: mpsc::SyncSender<()>,
    },
    Shutdown,
}

/// Owns the Photoshop gateway listener and its one non-overlapping retry loop.
pub struct PhotoshopGatewayLifecycle {
    commands: mpsc::Sender<LifecycleCommand>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl PhotoshopGatewayLifecycle {
    /// Starts the lifecycle in the persisted enablement state. An unavailable
    /// fixed port pool is a live `Unavailable` state, not a Runtime startup error.
    ///
    /// # Errors
    ///
    /// Returns an error only when the lifecycle worker itself cannot start or
    /// report its initial bind attempt.
    pub fn start(integration: Arc<PhotoshopIntegration>, enabled: bool) -> io::Result<Self> {
        let gateway_integration = Arc::clone(&integration);
        let starter: GatewayStarter = Arc::new(move || {
            let gateway = PhotoshopGatewayServer::start(Arc::clone(&gateway_integration));
            gateway
                .port()
                .is_some()
                .then(|| Box::new(gateway) as Box<dyn GatewayLease>)
        });
        let observer: AvailabilityObserver = Arc::new(move |available| {
            integration.set_gateway_available(available);
        });
        Self::start_with(enabled, RETRY_INTERVAL, starter, observer)
    }

    fn start_with(
        enabled: bool,
        retry_interval: Duration,
        starter: GatewayStarter,
        observer: AvailabilityObserver,
    ) -> io::Result<Self> {
        let (commands, receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(0);
        let worker = thread::Builder::new()
            .name("debrute-photoshop-lifecycle".to_owned())
            .spawn(move || {
                run_lifecycle(
                    enabled,
                    retry_interval,
                    &receiver,
                    &starter,
                    &observer,
                    &ready_sender,
                );
            })?;
        if let Err(error) = ready_receiver.recv() {
            let _ = worker.join();
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                format!("Photoshop lifecycle startup failed: {error}"),
            ));
        }
        Ok(Self {
            commands,
            worker: Mutex::new(Some(worker)),
        })
    }

    /// Applies one already-persisted enablement transition and waits until the
    /// listener has either started, failed its first bind, or fully stopped.
    ///
    /// # Panics
    ///
    /// Panics if the lifecycle worker has terminated unexpectedly.
    pub fn set_enabled(&self, enabled: bool) {
        let (settled, settlement) = mpsc::sync_channel(0);
        self.commands
            .send(LifecycleCommand::SetEnabled { enabled, settled })
            .expect("Photoshop lifecycle worker must remain live");
        settlement
            .recv()
            .expect("Photoshop lifecycle transition must settle");
    }

    #[cfg(test)]
    fn retry_now(&self) {
        let (settled, settlement) = mpsc::sync_channel(0);
        self.commands
            .send(LifecycleCommand::RetryNow { settled })
            .expect("Photoshop lifecycle worker must remain live");
        settlement
            .recv()
            .expect("Photoshop lifecycle retry must settle");
    }
}

impl Drop for PhotoshopGatewayLifecycle {
    fn drop(&mut self) {
        let _ = self.commands.send(LifecycleCommand::Shutdown);
        if let Some(worker) = self
            .worker
            .get_mut()
            .expect("Photoshop lifecycle worker lock poisoned")
            .take()
        {
            let _ = worker.join();
        }
    }
}

fn run_lifecycle(
    mut enabled: bool,
    retry_interval: Duration,
    commands: &mpsc::Receiver<LifecycleCommand>,
    starter: &GatewayStarter,
    observer: &AvailabilityObserver,
    ready_sender: &mpsc::SyncSender<()>,
) {
    let mut gateway = enabled.then(|| starter()).flatten();
    observer(gateway.is_some());
    if ready_sender.send(()).is_err() {
        return;
    }

    loop {
        let command = if enabled && gateway.is_none() {
            match commands.recv_timeout(retry_interval) {
                Ok(command) => Some(command),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    gateway = starter();
                    observer(gateway.is_some());
                    None
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match commands.recv() {
                Ok(command) => Some(command),
                Err(_) => break,
            }
        };

        match command {
            Some(LifecycleCommand::SetEnabled {
                enabled: requested,
                settled,
            }) => {
                if requested {
                    if !enabled || gateway.is_none() {
                        enabled = true;
                        gateway = starter();
                        observer(gateway.is_some());
                    }
                } else {
                    enabled = false;
                    gateway = None;
                    observer(false);
                }
                let _ = settled.send(());
            }
            #[cfg(test)]
            Some(LifecycleCommand::RetryNow { settled }) => {
                if enabled && gateway.is_none() {
                    gateway = starter();
                    observer(gateway.is_some());
                }
                let _ = settled.send(());
            }
            Some(LifecycleCommand::Shutdown) => break,
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    struct FakeGateway;

    impl GatewayLease for FakeGateway {}

    #[test]
    fn unavailable_gateway_retries_serially_and_disable_stops_retrying() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let starter_attempts = Arc::clone(&attempts);
        let starter: GatewayStarter = Arc::new(move || {
            let attempt = starter_attempts.fetch_add(1, Ordering::SeqCst);
            (attempt == 1).then(|| Box::new(FakeGateway) as Box<dyn GatewayLease>)
        });
        let states = Arc::new(Mutex::new(Vec::new()));
        let observed_states = Arc::clone(&states);
        let observer: AvailabilityObserver = Arc::new(move |available| {
            observed_states.lock().unwrap().push(available);
        });
        let lifecycle =
            PhotoshopGatewayLifecycle::start_with(true, Duration::from_mins(1), starter, observer)
                .unwrap();

        lifecycle.retry_now();
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(*states.lock().unwrap(), vec![false, true]);

        lifecycle.set_enabled(false);
        let settled_attempts = attempts.load(Ordering::SeqCst);
        lifecycle.retry_now();
        assert_eq!(attempts.load(Ordering::SeqCst), settled_attempts);
        assert_eq!(*states.lock().unwrap(), vec![false, true, false]);
    }

    #[test]
    fn enabling_attempts_immediately_and_disable_is_idempotent() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let starter_attempts = Arc::clone(&attempts);
        let starter: GatewayStarter = Arc::new(move || {
            starter_attempts.fetch_add(1, Ordering::SeqCst);
            Some(Box::new(FakeGateway))
        });
        let states = Arc::new(Mutex::new(Vec::new()));
        let observed_states = Arc::clone(&states);
        let observer: AvailabilityObserver = Arc::new(move |available| {
            observed_states.lock().unwrap().push(available);
        });
        let lifecycle =
            PhotoshopGatewayLifecycle::start_with(false, Duration::from_mins(1), starter, observer)
                .unwrap();

        assert_eq!(attempts.load(Ordering::SeqCst), 0);
        lifecycle.set_enabled(true);
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        lifecycle.set_enabled(false);
        lifecycle.set_enabled(false);
        assert_eq!(*states.lock().unwrap(), vec![false, true, false, false]);
    }
}
