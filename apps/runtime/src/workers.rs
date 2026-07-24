//! Runtime-wide owner of the one bounded native helper-process supervisor.

use std::sync::Arc;

use crate::integrations::{IntegrationService, Platform};
use crate::{
    integration_process::NativeIntegrationProcessAdapter, process::BoundedProcessSupervisor,
};

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

    /// Creates the closed integration service backed by this Runtime's one supervisor.
    #[must_use]
    pub fn integration_service(
        &self,
        platform: Platform,
        env_path: impl Into<String>,
        path_ext: impl Into<String>,
    ) -> IntegrationService {
        IntegrationService::new(
            platform,
            env_path,
            path_ext,
            Arc::new(NativeIntegrationProcessAdapter::from_supervisor(
                Arc::clone(&self.supervisor),
            )),
        )
    }

    pub(crate) fn supervisor(&self) -> Arc<BoundedProcessSupervisor> {
        Arc::clone(&self.supervisor)
    }
}
