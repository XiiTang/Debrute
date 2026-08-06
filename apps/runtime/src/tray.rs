use std::{
    collections::HashMap,
    error::Error,
    io,
    path::Path,
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};

use debrute_runtime::control::{
    ActivationIntent, ProjectFrontend, RuntimeControlState, RuntimeStatus, WorkbenchRoute,
};
#[cfg(target_os = "macos")]
use debrute_runtime::login::MacOsLoginItem as PlatformLoginItem;
#[cfg(target_os = "windows")]
use debrute_runtime::login::WindowsLoginItem as PlatformLoginItem;
use debrute_runtime::native_clipboard::write_text_to_system_clipboard;
use tao::{
    event::{Event, StartCause},
    event_loop::{ControlFlow, EventLoopBuilder},
    platform::run_return::EventLoopExtRunReturn,
};
use tray_icon::{
    Icon, TrayIcon, TrayIconBuilder,
    menu::{CheckMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu},
};

#[cfg(target_os = "macos")]
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};

type ServiceResult = Result<(), Box<dyn Error + Send + Sync>>;

const NEW_DESKTOP_WINDOW_ID: &str = "new-desktop-window";
const OPEN_BROWSER_ID: &str = "open-browser";
const COPY_URL_ID: &str = "copy-url";
const START_AT_LOGIN_ID: &str = "start-at-login";
const QUIT_ID: &str = "quit-debrute";

pub fn run(
    state: &Arc<RuntimeControlState>,
    stable_runtime_entrypoint: &Path,
    service: impl FnOnce() -> ServiceResult + Send + 'static,
) -> ServiceResult {
    let mut event_loop = EventLoopBuilder::<RuntimeEvent>::with_user_event().build();
    #[cfg(target_os = "macos")]
    {
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
        event_loop.set_activate_ignoring_other_apps(false);
    }
    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some({
        let proxy = proxy.clone();
        move |event| {
            let _ = proxy.send_event(RuntimeEvent::Menu(event));
        }
    }));
    let (tray_ready_sender, tray_ready_receiver) = mpsc::sync_channel(1);
    let service_proxy = event_loop.create_proxy();
    let service_worker = thread::Builder::new()
        .name("debrute-runtime-services".to_owned())
        .spawn(move || -> ServiceResult {
            match tray_ready_receiver.recv() {
                Ok(Ok(())) => {}
                Ok(Err(message)) => return Err(io::Error::other(message).into()),
                Err(_) => {
                    return Err(io::Error::other(
                        "Runtime native event loop stopped before tray initialization",
                    )
                    .into());
                }
            }
            let result = service();
            let _ = service_proxy.send_event(RuntimeEvent::ServiceStopped);
            result
        })?;
    let mut application = RuntimeApplication {
        state: Arc::clone(state),
        tray: None,
    };
    let mut tray_ready_sender = Some(tray_ready_sender);
    event_loop.run_return(|event, _target, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(100));
        match event {
            Event::NewEvents(StartCause::Init) => {
                match RuntimeTray::new(stable_runtime_entrypoint) {
                    Ok(tray) => {
                        application.tray = Some(tray);
                        send_tray_result(&mut tray_ready_sender, Ok(()));
                    }
                    Err(error) => {
                        send_tray_result(
                            &mut tray_ready_sender,
                            Err(format!("Debrute Runtime tray is unavailable: {error}")),
                        );
                        *control_flow = ControlFlow::Exit;
                    }
                }
            }
            Event::UserEvent(event) => {
                if application.handle_runtime_event(event) {
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::MainEventsCleared if application.update_presentation() => {
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
    MenuEvent::set_event_handler(None::<fn(MenuEvent)>);
    send_tray_result(
        &mut tray_ready_sender,
        Err("Runtime native event loop stopped before tray initialization".to_owned()),
    );
    if !service_worker.is_finished() && application.tray.is_some() {
        let _ = state.request_product_quit();
    }
    service_worker
        .join()
        .expect("Runtime services thread panicked")
}

fn send_tray_result(
    sender: &mut Option<mpsc::SyncSender<Result<(), String>>>,
    result: Result<(), String>,
) {
    if let Some(sender) = sender.take() {
        let _ = sender.send(result);
    }
}

#[derive(Debug)]
enum RuntimeEvent {
    Menu(MenuEvent),
    ServiceStopped,
}

struct RuntimeApplication {
    state: Arc<RuntimeControlState>,
    tray: Option<RuntimeTray>,
}

impl RuntimeApplication {
    fn handle_runtime_event(&mut self, event: RuntimeEvent) -> bool {
        match event {
            RuntimeEvent::Menu(event) => {
                self.handle_menu_event(&event.id);
                false
            }
            RuntimeEvent::ServiceStopped => true,
        }
    }

    fn update_presentation(&mut self) -> bool {
        if let Some(tray) = self.tray.as_mut() {
            let recent_projects = self
                .state
                .recent_projects_projection_after(tray.recent_projects_revision());
            if let Err(error) = tray.update_presentation(self.state.status(), recent_projects) {
                eprintln!("Debrute Runtime tray menu update failed: {error}");
                let _ = self.state.request_product_quit();
                return true;
            }
        }
        false
    }

    fn handle_menu_event(&mut self, id: &MenuId) {
        let action = self.tray.as_ref().and_then(|tray| tray.action(id)).cloned();
        match action {
            Some(TrayAction::Activate(intent)) => self.activate(&intent),
            Some(TrayAction::CopyUrl(route)) => self.copy_url(&route),
            None => match id.as_ref() {
                START_AT_LOGIN_ID => {
                    if let Some(tray) = self.tray.as_mut() {
                        tray.toggle_start_at_login();
                    }
                }
                QUIT_ID => {
                    if let Err(error) = self.state.request_product_quit() {
                        eprintln!("Debrute Runtime tray could not quit the product: {error:?}");
                    }
                }
                _ => {}
            },
        }
    }

    fn activate(&self, intent: &ActivationIntent) {
        if let Err(error) = self.state.activate_intent(intent, None) {
            eprintln!("Debrute Runtime tray activation failed: {error:?}");
        }
    }

    fn copy_url(&self, route: &WorkbenchRoute) {
        let url = match self.state.workbench_url(route) {
            Ok(url) => url,
            Err(error) => {
                eprintln!("Debrute Runtime tray could not resolve the Workbench URL: {error}");
                return;
            }
        };
        if let Err(error) = write_text_to_system_clipboard(&url) {
            eprintln!("Debrute Runtime tray could not copy the Workbench URL: {error}");
        }
    }
}

struct RuntimeTray {
    icon: TrayIcon,
    start_at_login: CheckMenuItem,
    actions: HashMap<String, TrayAction>,
    login_item: PlatformLoginItem,
    last_confirmed_start_at_login: bool,
    start_at_login_label: String,
    last_status: RuntimeStatus,
    last_recent_projects_revision: Option<u64>,
    recent_projects: Vec<String>,
}

impl RuntimeTray {
    fn new(stable_runtime_entrypoint: &std::path::Path) -> Result<Self, Box<dyn Error>> {
        let login_item = runtime_login_item(stable_runtime_entrypoint)?;
        let login_enabled = login_item.is_enabled()?;
        let built_menu = build_runtime_menu(
            RuntimeStatus::Starting,
            &[],
            login_enabled,
            "Start at Login",
        )?;
        #[cfg(target_os = "macos")]
        let image =
            image::load_from_memory(include_bytes!("../assets/tray-icon-macos-template.png"))?
                .into_rgba8();
        #[cfg(target_os = "windows")]
        let image = image::load_from_memory(include_bytes!("../assets/tray-icon-windows.png"))?
            .into_rgba8();
        let (width, height) = image.dimensions();
        let icon = Icon::from_rgba(image.into_raw(), width, height)?;
        let icon = TrayIconBuilder::new()
            .with_tooltip("Debrute Runtime")
            .with_icon(icon)
            .with_icon_as_template(cfg!(target_os = "macos"))
            .with_menu(Box::new(built_menu.menu))
            .with_menu_on_left_click(true)
            .with_menu_on_right_click(true)
            .build()?;
        Ok(Self {
            icon,
            start_at_login: built_menu.start_at_login,
            actions: built_menu.actions,
            login_item,
            last_confirmed_start_at_login: login_enabled,
            start_at_login_label: "Start at Login".to_owned(),
            last_status: RuntimeStatus::Starting,
            last_recent_projects_revision: None,
            recent_projects: Vec::new(),
        })
    }

    fn update_presentation(
        &mut self,
        status: RuntimeStatus,
        recent_projects: Option<(u64, Vec<String>)>,
    ) -> Result<(), Box<dyn Error>> {
        if self.last_status == status && recent_projects.is_none() {
            return Ok(());
        }
        let (recent_projects_revision, recent_projects) = recent_projects.map_or_else(
            || {
                (
                    self.last_recent_projects_revision,
                    self.recent_projects.clone(),
                )
            },
            |(revision, projects)| (Some(revision), projects),
        );
        let built_menu = build_runtime_menu(
            status,
            &recent_projects,
            self.last_confirmed_start_at_login,
            &self.start_at_login_label,
        )?;
        self.icon.set_menu(Some(Box::new(built_menu.menu)));
        self.start_at_login = built_menu.start_at_login;
        self.actions = built_menu.actions;
        self.last_status = status;
        self.last_recent_projects_revision = recent_projects_revision;
        self.recent_projects = recent_projects;
        Ok(())
    }

    fn toggle_start_at_login(&mut self) {
        let requested = self.start_at_login.is_checked();
        let login_item = &self.login_item;
        match commit_start_at_login_request(
            &mut self.last_confirmed_start_at_login,
            requested,
            |enabled| login_item.set_enabled(enabled),
        ) {
            Ok(()) => {
                "Start at Login".clone_into(&mut self.start_at_login_label);
                self.start_at_login.set_text(&self.start_at_login_label);
            }
            Err(error) => {
                self.start_at_login
                    .set_checked(self.last_confirmed_start_at_login);
                self.start_at_login_label = format!("Start at Login — Failed: {error}");
                self.start_at_login.set_text(&self.start_at_login_label);
            }
        }
    }

    fn action(&self, id: &MenuId) -> Option<&TrayAction> {
        self.actions.get(id.as_ref())
    }

    fn recent_projects_revision(&self) -> Option<u64> {
        self.last_recent_projects_revision
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TrayAction {
    Activate(ActivationIntent),
    CopyUrl(WorkbenchRoute),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TrayMenuEntry {
    id: String,
    label: String,
    action: TrayAction,
}

struct TrayMenuProjection {
    recent_projects_enabled: bool,
    desktop: Vec<TrayMenuEntry>,
    browser: Vec<TrayMenuEntry>,
    copy_url: Vec<TrayMenuEntry>,
}

fn tray_menu_projection(recent_project_roots: &[String]) -> TrayMenuProjection {
    let project_entries = |kind: &str, action: fn(&str) -> TrayAction| {
        recent_project_roots
            .iter()
            .enumerate()
            .map(|(index, canonical_root)| TrayMenuEntry {
                id: format!("recent-{kind}-{index}"),
                label: canonical_root.clone(),
                action: action(canonical_root),
            })
            .collect::<Vec<_>>()
    };
    TrayMenuProjection {
        recent_projects_enabled: !recent_project_roots.is_empty(),
        desktop: project_entries("desktop", |canonical_root| {
            TrayAction::Activate(ActivationIntent::OpenProject {
                project_root: canonical_root.to_owned(),
                frontend: ProjectFrontend::Desktop,
            })
        }),
        browser: project_entries("browser", |canonical_root| {
            TrayAction::Activate(ActivationIntent::OpenProject {
                project_root: canonical_root.to_owned(),
                frontend: ProjectFrontend::Browser,
            })
        }),
        copy_url: project_entries("copy-url", |canonical_root| {
            TrayAction::CopyUrl(WorkbenchRoute::OpenProject {
                canonical_root: canonical_root.to_owned(),
            })
        }),
    }
}

struct BuiltRuntimeMenu {
    menu: Menu,
    start_at_login: CheckMenuItem,
    actions: HashMap<String, TrayAction>,
}

fn build_runtime_menu(
    status: RuntimeStatus,
    recent_projects: &[String],
    start_at_login_checked: bool,
    start_at_login_label: &str,
) -> Result<BuiltRuntimeMenu, Box<dyn Error>> {
    let ready = status == RuntimeStatus::Ready;
    let status = MenuItem::with_id(
        "runtime-status",
        format!("Runtime: {}", runtime_status_label(status)),
        false,
        None,
    );
    let new_desktop_window =
        MenuItem::with_id(NEW_DESKTOP_WINDOW_ID, "New Desktop Window", ready, None);
    let open_browser = MenuItem::with_id(OPEN_BROWSER_ID, "Open in Browser", ready, None);
    let copy_url = MenuItem::with_id(COPY_URL_ID, "Copy URL", ready, None);

    let projection = tray_menu_projection(recent_projects);
    let recent_projects = Submenu::with_id(
        "recent-projects",
        "Recent Projects",
        ready && projection.recent_projects_enabled,
    );
    if projection.recent_projects_enabled {
        let desktop_recent =
            recent_submenu("recent-desktop", "Desktop", ready, &projection.desktop)?;
        let browser_recent =
            recent_submenu("recent-browser", "Browser", ready, &projection.browser)?;
        let copy_url_recent =
            recent_submenu("recent-copy-url", "Copy URL", ready, &projection.copy_url)?;
        recent_projects.append_items(&[&desktop_recent, &browser_recent, &copy_url_recent])?;
    }

    let start_at_login = CheckMenuItem::with_id(
        START_AT_LOGIN_ID,
        start_at_login_label,
        true,
        start_at_login_checked,
        None,
    );
    let separator = PredefinedMenuItem::separator();
    let quit = MenuItem::with_id(QUIT_ID, "Quit Debrute", true, None);
    let menu = Menu::with_items(&[
        &status,
        &new_desktop_window,
        &open_browser,
        &copy_url,
        &recent_projects,
        &start_at_login,
        &separator,
        &quit,
    ])?;

    let mut actions = HashMap::from([
        (
            NEW_DESKTOP_WINDOW_ID.to_owned(),
            TrayAction::Activate(ActivationIntent::OpenDesktop),
        ),
        (
            OPEN_BROWSER_ID.to_owned(),
            TrayAction::Activate(ActivationIntent::OpenBrowser),
        ),
        (
            COPY_URL_ID.to_owned(),
            TrayAction::CopyUrl(WorkbenchRoute::Root),
        ),
    ]);
    for entry in projection
        .desktop
        .into_iter()
        .chain(projection.browser)
        .chain(projection.copy_url)
    {
        actions.insert(entry.id, entry.action);
    }

    Ok(BuiltRuntimeMenu {
        menu,
        start_at_login,
        actions,
    })
}

fn recent_submenu(
    id: &str,
    label: &str,
    enabled: bool,
    entries: &[TrayMenuEntry],
) -> Result<Submenu, Box<dyn Error>> {
    let submenu = Submenu::with_id(id, label, enabled);
    for entry in entries {
        submenu.append(&MenuItem::with_id(
            &entry.id,
            escape_menu_label(&entry.label),
            enabled,
            None,
        ))?;
    }
    Ok(submenu)
}

fn escape_menu_label(label: &str) -> String {
    label.replace('&', "&&")
}

fn runtime_status_label(status: RuntimeStatus) -> &'static str {
    match status {
        RuntimeStatus::Starting => "Starting",
        RuntimeStatus::Ready => "Ready",
        RuntimeStatus::Exiting => "Exiting",
        RuntimeStatus::Replacing => "Updating",
    }
}

#[cfg(target_os = "macos")]
fn runtime_login_item(
    stable_runtime: &std::path::Path,
) -> Result<PlatformLoginItem, Box<dyn Error>> {
    let home = std::env::var_os("HOME").ok_or_else(|| io::Error::other("HOME is unavailable"))?;
    Ok(PlatformLoginItem::new(home, stable_runtime))
}

#[cfg(target_os = "windows")]
#[expect(
    clippy::unnecessary_wraps,
    reason = "both platforms share one fallible login-item construction contract"
)]
fn runtime_login_item(
    stable_runtime: &std::path::Path,
) -> Result<PlatformLoginItem, Box<dyn Error>> {
    Ok(PlatformLoginItem::new(stable_runtime))
}

fn commit_start_at_login_request<E>(
    confirmed: &mut bool,
    requested: bool,
    apply: impl FnOnce(bool) -> Result<(), E>,
) -> Result<(), E> {
    apply(requested)?;
    *confirmed = requested;
    Ok(())
}

#[cfg(test)]
mod tests {
    use debrute_runtime::control::{ActivationIntent, ProjectFrontend, WorkbenchRoute};

    use super::{
        TrayAction, commit_start_at_login_request, escape_menu_label, tray_menu_projection,
    };

    #[test]
    fn recent_projects_are_projected_once_into_three_explicit_action_groups() {
        let recent_projects = vec!["/projects/a".to_owned(), "/projects/b".to_owned()];

        let projection = tray_menu_projection(&recent_projects);

        assert!(projection.recent_projects_enabled);
        for entries in [
            &projection.desktop,
            &projection.browser,
            &projection.copy_url,
        ] {
            assert_eq!(
                entries
                    .iter()
                    .map(|entry| entry.label.as_str())
                    .collect::<Vec<_>>(),
                vec!["/projects/a", "/projects/b"]
            );
        }
        assert_eq!(projection.desktop[0].id, "recent-desktop-0");
        assert_eq!(projection.browser[1].id, "recent-browser-1");
        assert_eq!(projection.copy_url[0].id, "recent-copy-url-0");
        assert_eq!(
            projection.desktop[0].action,
            TrayAction::Activate(ActivationIntent::OpenProject {
                project_root: "/projects/a".to_owned(),
                frontend: ProjectFrontend::Desktop,
            })
        );
        assert_eq!(
            projection.browser[0].action,
            TrayAction::Activate(ActivationIntent::OpenProject {
                project_root: "/projects/a".to_owned(),
                frontend: ProjectFrontend::Browser,
            })
        );
        assert_eq!(
            projection.copy_url[0].action,
            TrayAction::CopyUrl(WorkbenchRoute::OpenProject {
                canonical_root: "/projects/a".to_owned(),
            })
        );
    }

    #[test]
    fn recent_projects_submenu_is_disabled_when_the_projection_is_empty() {
        let projection = tray_menu_projection(&[]);

        assert!(!projection.recent_projects_enabled);
        assert!(projection.desktop.is_empty());
        assert!(projection.browser.is_empty());
        assert!(projection.copy_url.is_empty());
    }

    #[test]
    fn recent_project_paths_escape_native_menu_mnemonics_without_changing_actions() {
        assert_eq!(escape_menu_label("/projects/R&D"), "/projects/R&&D");
    }

    #[test]
    fn start_at_login_uses_the_post_click_state_and_confirms_success() {
        let mut confirmed = false;
        let mut written = None;

        commit_start_at_login_request(&mut confirmed, true, |requested| {
            written = Some(requested);
            Ok::<(), ()>(())
        })
        .expect("registration write should succeed");

        assert_eq!(written, Some(true));
        assert!(confirmed);
    }

    #[test]
    fn failed_start_at_login_write_preserves_the_last_confirmed_state() {
        let mut confirmed = true;

        let result = commit_start_at_login_request(&mut confirmed, false, |_| Err("denied"));

        assert_eq!(result, Err("denied"));
        assert!(confirmed);
    }
}
