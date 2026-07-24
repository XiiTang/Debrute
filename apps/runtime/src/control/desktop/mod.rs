use std::{
    collections::HashMap,
    error::Error,
    fmt,
    sync::{Mutex, MutexGuard},
};

use uuid::Uuid;

use crate::workbench::{DesktopLaunchBinding, WorkbenchLaunchError, WorkbenchLaunchService};

use super::{ControlEvent, OutboundError, ServerMessage, WorkbenchRoute, writer::ControlSender};

pub struct DesktopWindowTopology {
    inner: Mutex<DesktopTopologyInner>,
}

struct DesktopTopologyInner {
    host: Option<DesktopHost>,
    windows: HashMap<String, WorkbenchRoute>,
}

#[derive(Clone)]
struct DesktopHost {
    id: String,
    sender: ControlSender,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopOpenResult {
    Opened,
    FocusedExisting,
}

#[derive(Debug)]
pub enum DesktopOpenError {
    HostUnavailable,
    Outbound(OutboundError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopHostRegistrationError {
    AlreadyConnected,
}

impl DesktopWindowTopology {
    pub(super) fn new() -> Self {
        Self {
            inner: Mutex::new(DesktopTopologyInner {
                host: None,
                windows: HashMap::new(),
            }),
        }
    }

    pub(super) fn promote_host(
        &self,
        host_id: String,
        sender: ControlSender,
    ) -> Result<(), DesktopHostRegistrationError> {
        let mut inner = self.lock_inner();
        if inner.host.is_some() {
            return Err(DesktopHostRegistrationError::AlreadyConnected);
        }
        inner.host = Some(DesktopHost {
            id: host_id,
            sender,
        });
        Ok(())
    }

    #[must_use]
    pub(super) fn has_host(&self) -> bool {
        self.lock_inner().host.is_some()
    }

    pub(super) fn unregister_host(
        &self,
        host_id: &str,
        workbench: Option<&WorkbenchLaunchService>,
    ) {
        let window_keys = {
            let mut inner = self.lock_inner();
            if inner.host.as_ref().is_none_or(|host| host.id != host_id) {
                return;
            }
            inner.host = None;
            inner
                .windows
                .drain()
                .map(|(key, _)| key)
                .collect::<Vec<_>>()
        };
        if let Some(workbench) = workbench {
            for window_key in window_keys {
                workbench.revoke_desktop_launches(host_id, &window_key);
            }
        }
    }

    pub(super) fn open(
        &self,
        route: &WorkbenchRoute,
    ) -> Result<DesktopOpenResult, DesktopOpenError> {
        let mut inner = self.lock_inner();
        let host = inner
            .host
            .clone()
            .ok_or(DesktopOpenError::HostUnavailable)?;
        if let WorkbenchRoute::Project { project_id } = route
            && let Some(window_key) = inner.windows.iter().find_map(|(window_key, current)| {
                matches!(current, WorkbenchRoute::Project { project_id: current_id } if current_id == project_id)
                    .then(|| window_key.clone())
            })
        {
            host.sender
                .send(ServerMessage::event(ControlEvent::DesktopWindowFocusRequested {
                    window_key,
                }))
                .map_err(DesktopOpenError::Outbound)?;
            return Ok(DesktopOpenResult::FocusedExisting);
        }
        let window_key = Uuid::new_v4().to_string();
        inner.windows.insert(window_key.clone(), route.clone());
        if let Err(error) = host.sender.send(ServerMessage::event(
            ControlEvent::DesktopWindowOpenRequested {
                window_key: window_key.clone(),
                route: route.clone(),
            },
        )) {
            inner.windows.remove(&window_key);
            return Err(DesktopOpenError::Outbound(error));
        }
        Ok(DesktopOpenResult::Opened)
    }

    pub(super) fn create_launch_ticket(
        &self,
        host_id: &str,
        window_key: &str,
        workbench: &WorkbenchLaunchService,
    ) -> Result<(String, String), WorkbenchLaunchError> {
        let route = {
            let inner = self.lock_inner();
            if inner.host.as_ref().is_none_or(|host| host.id != host_id) {
                return Err(WorkbenchLaunchError::InvalidProjectId);
            }
            inner
                .windows
                .get(window_key)
                .cloned()
                .ok_or(WorkbenchLaunchError::InvalidProjectId)?
        };
        let url = workbench.url_for_route(&route)?;
        let ticket = workbench.create_desktop_ticket(
            route,
            DesktopLaunchBinding {
                desktop_host_id: host_id.to_owned(),
                window_key: window_key.to_owned(),
            },
        )?;
        Ok((ticket, url))
    }

    pub(super) fn close_window(
        &self,
        host_id: &str,
        window_key: &str,
        workbench: Option<&WorkbenchLaunchService>,
    ) -> bool {
        let removed = {
            let mut inner = self.lock_inner();
            if inner.host.as_ref().is_none_or(|host| host.id != host_id) {
                return false;
            }
            inner.windows.remove(window_key).is_some()
        };
        if removed && let Some(workbench) = workbench {
            workbench.revoke_desktop_launches(host_id, window_key);
        }
        removed
    }

    pub(super) fn retarget(&self, binding: &DesktopLaunchBinding, route: WorkbenchRoute) -> bool {
        let mut inner = self.lock_inner();
        if inner
            .host
            .as_ref()
            .is_none_or(|host| host.id != binding.desktop_host_id)
        {
            return false;
        }
        let Some(current) = inner.windows.get_mut(&binding.window_key) else {
            return false;
        };
        *current = route;
        true
    }

    pub(super) fn focus(&self, binding: &DesktopLaunchBinding) -> Result<bool, OutboundError> {
        let inner = self.lock_inner();
        let Some(host) = inner
            .host
            .as_ref()
            .filter(|host| host.id == binding.desktop_host_id)
        else {
            return Ok(false);
        };
        if !inner.windows.contains_key(&binding.window_key) {
            return Ok(false);
        }
        host.sender.send(ServerMessage::event(
            ControlEvent::DesktopWindowFocusRequested {
                window_key: binding.window_key.clone(),
            },
        ))?;
        Ok(true)
    }

    fn lock_inner(&self) -> MutexGuard<'_, DesktopTopologyInner> {
        self.inner.lock().expect("Desktop topology lock poisoned")
    }
}

impl fmt::Display for DesktopOpenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HostUnavailable => formatter.write_str("Desktop host is unavailable"),
            Self::Outbound(error) => write!(formatter, "Desktop event delivery failed: {error}"),
        }
    }
}

impl Error for DesktopOpenError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Outbound(error) => Some(error),
            Self::HostUnavailable => None,
        }
    }
}
