use std::{
    collections::HashMap,
    error::Error,
    fmt,
    sync::{Mutex, MutexGuard, PoisonError},
};

use url::Url;
use uuid::Uuid;

use crate::control::WorkbenchRoute;

pub const WORKBENCH_SESSION_COOKIE: &str = "debrute_web_session";

pub struct WorkbenchLaunchService {
    origin: String,
    source_workbench: Mutex<Option<SourceWorkbenchRegistration>>,
    desktop_tickets: Mutex<HashMap<String, DesktopTicket>>,
}

struct SourceWorkbenchRegistration {
    owner_id: String,
    origin: String,
}

struct DesktopTicket {
    route: WorkbenchRoute,
    browser_session: String,
    desktop: DesktopLaunchBinding,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct DesktopLaunchBinding {
    pub(crate) desktop_host_id: String,
    pub(crate) window_key: String,
}

pub(crate) struct DesktopTicketConsumption {
    pub(crate) route: WorkbenchRoute,
    pub(crate) browser_session: String,
    pub(crate) desktop: DesktopLaunchBinding,
}

impl WorkbenchLaunchService {
    pub(super) fn new(origin: String) -> Self {
        Self {
            origin,
            source_workbench: Mutex::new(None),
            desktop_tickets: Mutex::new(HashMap::new()),
        }
    }

    #[must_use]
    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub(crate) fn register_source_workbench(
        &self,
        owner_id: &str,
        origin: &str,
    ) -> Result<(), SourceWorkbenchRegistrationError> {
        let origin = normalize_source_workbench_origin(origin)?;
        let mut registration = self
            .source_workbench
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if registration
            .as_ref()
            .is_some_and(|current| current.owner_id != owner_id)
        {
            return Err(SourceWorkbenchRegistrationError::AlreadyRegistered);
        }
        *registration = Some(SourceWorkbenchRegistration {
            owner_id: owner_id.to_owned(),
            origin,
        });
        Ok(())
    }

    pub(crate) fn unregister_source_workbench(&self, owner_id: &str) {
        let mut registration = self
            .source_workbench
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if registration
            .as_ref()
            .is_some_and(|current| current.owner_id == owner_id)
        {
            *registration = None;
        }
    }

    /// Resolves a validated Workbench route against the active source or bundled origin.
    ///
    /// # Errors
    ///
    /// Returns an error when the route contains an invalid Project id.
    pub fn url_for_route(&self, route: &WorkbenchRoute) -> Result<String, WorkbenchLaunchError> {
        validate_route(route)?;
        let registration = self
            .source_workbench
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let origin = registration
            .as_ref()
            .map_or(self.origin.as_str(), |registration| {
                registration.origin.as_str()
            });
        Ok(format!("{origin}{}", route_path(route)))
    }

    pub(crate) fn create_desktop_ticket(
        &self,
        route: WorkbenchRoute,
        desktop: DesktopLaunchBinding,
    ) -> Result<String, WorkbenchLaunchError> {
        validate_route(&route)?;
        let ticket = Uuid::new_v4().to_string();
        self.lock_tickets().insert(
            ticket.clone(),
            DesktopTicket {
                route,
                browser_session: Uuid::new_v4().to_string(),
                desktop,
            },
        );
        Ok(ticket)
    }

    pub(crate) fn consume_desktop_ticket(&self, ticket: &str) -> Option<DesktopTicketConsumption> {
        let ticket = self.lock_tickets().remove(ticket)?;
        Some(DesktopTicketConsumption {
            route: ticket.route,
            browser_session: ticket.browser_session,
            desktop: ticket.desktop,
        })
    }

    #[must_use]
    pub(crate) fn create_browser_session() -> String {
        Uuid::new_v4().to_string()
    }

    pub(crate) fn revoke_desktop_launches(&self, host_id: &str, window_key: &str) {
        self.lock_tickets().retain(|_, ticket| {
            ticket.desktop.desktop_host_id != host_id || ticket.desktop.window_key != window_key
        });
    }

    fn lock_tickets(&self) -> MutexGuard<'_, HashMap<String, DesktopTicket>> {
        self.desktop_tickets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkbenchLaunchError {
    InvalidProjectId,
}

impl fmt::Display for WorkbenchLaunchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Workbench Project id is not a valid opaque id")
    }
}

impl Error for WorkbenchLaunchError {}

fn validate_route(route: &WorkbenchRoute) -> Result<(), WorkbenchLaunchError> {
    match route {
        WorkbenchRoute::Root => Ok(()),
        WorkbenchRoute::Project { project_id } if is_opaque_value(project_id) => Ok(()),
        WorkbenchRoute::Project { .. } => Err(WorkbenchLaunchError::InvalidProjectId),
    }
}

fn route_path(route: &WorkbenchRoute) -> String {
    match route {
        WorkbenchRoute::Root => "/".to_owned(),
        WorkbenchRoute::Project { project_id } => format!("/projects/{project_id}"),
    }
}

pub(super) fn is_opaque_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SourceWorkbenchRegistrationError {
    InvalidOrigin,
    AlreadyRegistered,
}

fn normalize_source_workbench_origin(
    value: &str,
) -> Result<String, SourceWorkbenchRegistrationError> {
    let parsed = Url::parse(value).map_err(|_| SourceWorkbenchRegistrationError::InvalidOrigin)?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(SourceWorkbenchRegistrationError::InvalidOrigin);
    }
    Ok(parsed.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_ticket_is_memory_only_and_one_use() {
        let service = WorkbenchLaunchService::new("http://127.0.0.1:17321".to_owned());
        let route = WorkbenchRoute::Project {
            project_id: "project-1".to_owned(),
        };
        let ticket = service
            .create_desktop_ticket(
                route.clone(),
                DesktopLaunchBinding {
                    desktop_host_id: "host-1".to_owned(),
                    window_key: "window-1".to_owned(),
                },
            )
            .unwrap();

        assert!(!service.url_for_route(&route).unwrap().contains(&ticket));
        assert_eq!(
            service.consume_desktop_ticket(&ticket).unwrap().route,
            route
        );
        assert!(service.consume_desktop_ticket(&ticket).is_none());
    }

    #[test]
    fn source_workbench_registration_changes_only_the_stable_origin() {
        let service = WorkbenchLaunchService::new("http://127.0.0.1:17321".to_owned());
        service
            .register_source_workbench("launcher-1", "http://127.0.0.1:5173")
            .unwrap();
        assert_eq!(
            service.url_for_route(&WorkbenchRoute::Root).unwrap(),
            "http://127.0.0.1:5173/"
        );
        service.unregister_source_workbench("launcher-1");
        assert_eq!(
            service.url_for_route(&WorkbenchRoute::Root).unwrap(),
            "http://127.0.0.1:17321/"
        );
    }
}
