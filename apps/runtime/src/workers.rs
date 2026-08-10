//! Runtime-wide owner of the one bounded native helper-process supervisor.

use std::sync::Arc;

use crate::process::BoundedProcessSupervisor;

#[derive(Clone)]
pub struct RuntimeWorkerServices {
    supervisor: Arc<BoundedProcessSupervisor>,
}

impl Default for RuntimeWorkerServices {
    fn default() -> Self {
        Self {
            supervisor: Arc::new(BoundedProcessSupervisor::default()),
        }
    }
}

impl RuntimeWorkerServices {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn supervisor(&self) -> Arc<BoundedProcessSupervisor> {
        Arc::clone(&self.supervisor)
    }
}
