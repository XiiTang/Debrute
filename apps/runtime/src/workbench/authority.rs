use std::{
    collections::HashMap,
    error::Error,
    fmt,
    path::Path,
    sync::{Mutex, MutexGuard},
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
        let mut registration = lock(&self.source_workbench, "source Workbench registration");
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
        let mut registration = lock(&self.source_workbench, "source Workbench registration");
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
    /// Returns an error when the route contains an invalid canonical root.
    pub fn url_for_route(&self, route: &WorkbenchRoute) -> Result<String, WorkbenchLaunchError> {
        validate_route(route)?;
        let registration = lock(&self.source_workbench, "source Workbench registration");
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
            .expect("Desktop launch ticket lock poisoned")
    }
}

fn lock<'a, T>(mutex: &'a Mutex<T>, name: &str) -> MutexGuard<'a, T> {
    mutex
        .lock()
        .unwrap_or_else(|_| panic!("{name} lock poisoned"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkbenchLaunchError {
    InvalidProjectPath,
}

impl fmt::Display for WorkbenchLaunchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Workbench Project path is not a valid absolute path")
    }
}

impl Error for WorkbenchLaunchError {}

/// Builds a Project route from the current Root Workbench URL without opening
/// or admitting the requested Project path.
///
/// # Errors
///
/// Returns an error when the requested Project root is not an absolute path.
pub fn build_project_workbench_url(
    root_url: &str,
    requested_project_root: &str,
) -> Result<String, WorkbenchLaunchError> {
    if !is_absolute_project_root(requested_project_root) {
        return Err(WorkbenchLaunchError::InvalidProjectPath);
    }
    Ok(format!(
        "{}{}",
        root_url.trim_end_matches('/'),
        project_route_path(requested_project_root)
    ))
}

fn is_absolute_project_root(project_root: &str) -> bool {
    let bytes = project_root.as_bytes();
    bytes.first() == Some(&b'/')
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'))
        || is_unc_project_root(project_root)
}

fn is_unc_project_root(project_root: &str) -> bool {
    let Some(remainder) = project_root.strip_prefix(r"\\") else {
        return false;
    };
    let mut components = remainder
        .split(['\\', '/'])
        .filter(|component| !component.is_empty());
    components.next().is_some() && components.next().is_some()
}

fn validate_route(route: &WorkbenchRoute) -> Result<(), WorkbenchLaunchError> {
    match route {
        WorkbenchRoute::Root => Ok(()),
        WorkbenchRoute::OpenProject { canonical_root }
            if !canonical_root.is_empty() && Path::new(canonical_root).is_absolute() =>
        {
            Ok(())
        }
        WorkbenchRoute::OpenProject { .. } => Err(WorkbenchLaunchError::InvalidProjectPath),
    }
}

fn route_path(route: &WorkbenchRoute) -> String {
    match route {
        WorkbenchRoute::Root => "/".to_owned(),
        WorkbenchRoute::OpenProject { canonical_root } => project_route_path(canonical_root),
    }
}

fn project_route_path(project_root: &str) -> String {
    format!(
        "/open?path={}",
        url::form_urlencoded::byte_serialize(project_root.as_bytes()).collect::<String>()
    )
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
    use std::fs;

    use super::*;

    fn canonical_test_project(label: &str) -> (std::path::PathBuf, String) {
        let base =
            std::env::temp_dir().join(format!("debrute-authority-{label}-{}", Uuid::new_v4()));
        let project = base.join("Reference Projects");
        fs::create_dir_all(&project).unwrap();
        let canonical = project
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        (base, canonical)
    }

    #[test]
    fn project_workbench_url_encodes_an_unadmitted_absolute_root() {
        assert_eq!(
            build_project_workbench_url(
                "http://127.0.0.1:17321/",
                "/definitely/not/present/Reference #? 中文",
            )
            .unwrap(),
            "http://127.0.0.1:17321/open?path=%2Fdefinitely%2Fnot%2Fpresent%2FReference+%23%3F+%E4%B8%AD%E6%96%87"
        );
    }

    #[test]
    fn project_workbench_url_accepts_a_windows_drive_root_on_any_host() {
        assert_eq!(
            build_project_workbench_url(
                "http://127.0.0.1:17321/",
                r"C:\Reference Projects\A#?.debrute",
            )
            .unwrap(),
            "http://127.0.0.1:17321/open?path=C%3A%5CReference+Projects%5CA%23%3F.debrute"
        );
    }

    #[test]
    fn project_workbench_url_accepts_a_unc_root_on_any_host() {
        assert_eq!(
            build_project_workbench_url("http://127.0.0.1:17321/", r"\\server\share\Reference 文",)
                .unwrap(),
            "http://127.0.0.1:17321/open?path=%5C%5Cserver%5Cshare%5CReference+%E6%96%87"
        );
    }

    #[test]
    fn project_workbench_url_rejects_a_relative_root() {
        assert_eq!(
            build_project_workbench_url("http://127.0.0.1:17321/", "Reference Projects"),
            Err(WorkbenchLaunchError::InvalidProjectPath)
        );
    }

    #[test]
    fn root_workbench_url_follows_the_current_source_registration() {
        let service = WorkbenchLaunchService::new("http://127.0.0.1:17321".to_owned());
        assert_eq!(
            service.url_for_route(&WorkbenchRoute::Root).unwrap(),
            "http://127.0.0.1:17321/"
        );
        service
            .register_source_workbench("launcher-1", "http://127.0.0.1:5173")
            .unwrap();
        assert_eq!(
            service.url_for_route(&WorkbenchRoute::Root).unwrap(),
            "http://127.0.0.1:5173/"
        );
    }

    #[test]
    fn desktop_ticket_is_memory_only_and_one_use() {
        let service = WorkbenchLaunchService::new("http://127.0.0.1:17321".to_owned());
        let (base, canonical_root) = canonical_test_project("desktop-ticket");
        let route = WorkbenchRoute::OpenProject { canonical_root };
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
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn source_workbench_registration_owns_the_origin_without_changing_the_route() {
        let service = WorkbenchLaunchService::new("http://127.0.0.1:17321".to_owned());
        let (base, canonical_root) = canonical_test_project("source-workbench");
        let route = WorkbenchRoute::OpenProject {
            canonical_root: canonical_root.clone(),
        };
        service
            .register_source_workbench("launcher-1", "http://127.0.0.1:5173")
            .unwrap();
        let source_url = Url::parse(&service.url_for_route(&route).unwrap()).unwrap();
        assert_eq!(
            source_url.origin().ascii_serialization(),
            "http://127.0.0.1:5173"
        );
        assert_eq!(
            source_url
                .query_pairs()
                .find(|(key, _)| key == "path")
                .unwrap()
                .1,
            canonical_root
        );
        service.unregister_source_workbench("launcher-1");
        let bundled_url = Url::parse(&service.url_for_route(&route).unwrap()).unwrap();
        assert_eq!(
            bundled_url.origin().ascii_serialization(),
            "http://127.0.0.1:17321"
        );
        assert_eq!(
            bundled_url
                .query_pairs()
                .find(|(key, _)| key == "path")
                .unwrap()
                .1,
            canonical_root
        );
        fs::remove_dir_all(base).unwrap();
    }
}
