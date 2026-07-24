use std::{
    error::Error,
    io,
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};

use debrute_runtime::control::{ActivationIntent, RuntimeControlState, RuntimeStatus};
#[cfg(target_os = "macos")]
use debrute_runtime::login::MacOsLoginItem as PlatformLoginItem;
#[cfg(target_os = "windows")]
use debrute_runtime::login::WindowsLoginItem as PlatformLoginItem;
use tao::{
    event::{Event, StartCause},
    event_loop::{ControlFlow, EventLoopBuilder},
    platform::run_return::EventLoopExtRunReturn,
};
use tray_icon::{
    Icon, TrayIcon, TrayIconBuilder, TrayIconEvent,
    menu::{CheckMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem},
};

#[cfg(target_os = "windows")]
use tray_icon::{MouseButton, MouseButtonState};

#[cfg(target_os = "macos")]
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};

type ServiceResult = Result<(), Box<dyn Error + Send + Sync>>;

const OPEN_DESKTOP_ID: &str = "open-desktop";
const OPEN_BROWSER_ID: &str = "open-browser";
const START_AT_LOGIN_ID: &str = "start-at-login";
const QUIT_ID: &str = "quit-debrute";

pub fn run(
    state: &Arc<RuntimeControlState>,
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
    TrayIconEvent::set_event_handler(Some(move |event| {
        let _ = proxy.send_event(RuntimeEvent::Tray(event));
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
            Event::NewEvents(StartCause::Init) => match RuntimeTray::new() {
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
            },
            Event::UserEvent(event) => {
                if application.handle_runtime_event(event) {
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::MainEventsCleared => application.update_status(),
            _ => {}
        }
    });
    MenuEvent::set_event_handler(None::<fn(MenuEvent)>);
    TrayIconEvent::set_event_handler(None::<fn(TrayIconEvent)>);
    send_tray_result(
        &mut tray_ready_sender,
        Err("Runtime native event loop stopped before tray initialization".to_owned()),
    );
    if !service_worker.is_finished() && application.tray.is_some() {
        let _ = state.request_product_quit();
    }
    service_worker
        .join()
        .map_err(|_| io::Error::other("Runtime services thread panicked"))?
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
    Tray(TrayIconEvent),
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
            RuntimeEvent::Tray(event) => {
                #[cfg(target_os = "windows")]
                self.handle_tray_event(&event);
                #[cfg(target_os = "macos")]
                let _ = event;
                false
            }
            RuntimeEvent::ServiceStopped => true,
        }
    }

    fn update_status(&mut self) {
        if let Some(tray) = self.tray.as_mut() {
            tray.update_status(self.state.status());
        }
    }

    fn handle_menu_event(&mut self, id: &MenuId) {
        match id.as_ref() {
            OPEN_DESKTOP_ID => self.activate(&ActivationIntent::OpenDesktop),
            OPEN_BROWSER_ID => self.activate(&ActivationIntent::OpenBrowser),
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
        }
    }

    #[cfg(target_os = "windows")]
    fn handle_tray_event(&self, event: &TrayIconEvent) {
        if matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
        ) {
            self.activate(&ActivationIntent::OpenDesktop);
        }
    }

    fn activate(&self, intent: &ActivationIntent) {
        if let Err(error) = self.state.activate_intent(intent) {
            eprintln!("Debrute Runtime tray activation failed: {error:?}");
        }
    }
}

struct RuntimeTray {
    _icon: TrayIcon,
    status: MenuItem,
    start_at_login: CheckMenuItem,
    login_item: PlatformLoginItem,
    last_status: RuntimeStatus,
}

impl RuntimeTray {
    fn new() -> Result<Self, Box<dyn Error>> {
        let login_item = runtime_login_item()?;
        let status = MenuItem::with_id("runtime-status", "Runtime: Starting", false, None);
        let open_desktop = MenuItem::with_id(OPEN_DESKTOP_ID, "Open Desktop", true, None);
        let open_browser = MenuItem::with_id(OPEN_BROWSER_ID, "Open in Browser", true, None);
        let start_at_login = CheckMenuItem::with_id(
            START_AT_LOGIN_ID,
            "Start at Login",
            true,
            login_item.is_enabled()?,
            None,
        );
        let separator = PredefinedMenuItem::separator();
        let quit = MenuItem::with_id(QUIT_ID, "Quit Debrute", true, None);
        let menu = Menu::with_items(&[
            &status,
            &open_desktop,
            &open_browser,
            &start_at_login,
            &separator,
            &quit,
        ])?;
        let image = image::load_from_memory(include_bytes!("../../desktop/build/icons/32x32.png"))?
            .into_rgba8();
        let (width, height) = image.dimensions();
        let icon = Icon::from_rgba(image.into_raw(), width, height)?;
        let icon = TrayIconBuilder::new()
            .with_tooltip("Debrute Runtime")
            .with_icon(icon)
            .with_icon_as_template(cfg!(target_os = "macos"))
            .with_menu(Box::new(menu))
            .with_menu_on_left_click(cfg!(target_os = "macos"))
            .with_menu_on_right_click(true)
            .build()?;
        Ok(Self {
            _icon: icon,
            status,
            start_at_login,
            login_item,
            last_status: RuntimeStatus::Starting,
        })
    }

    fn update_status(&mut self, status: RuntimeStatus) {
        if self.last_status == status {
            return;
        }
        self.last_status = status;
        self.status.set_text(format!(
            "Runtime: {}",
            match status {
                RuntimeStatus::Starting => "Starting",
                RuntimeStatus::Ready => "Ready",
                RuntimeStatus::Exiting => "Exiting",
                RuntimeStatus::Replacing => "Updating",
            }
        ));
    }

    fn toggle_start_at_login(&mut self) {
        let enabled = !self.start_at_login.is_checked();
        match self.login_item.set_enabled(enabled) {
            Ok(()) => self.start_at_login.set_checked(enabled),
            Err(error) => eprintln!("Debrute Runtime could not update Start at Login: {error}"),
        }
    }
}

#[cfg(target_os = "macos")]
fn runtime_login_item() -> Result<PlatformLoginItem, Box<dyn Error>> {
    let home = std::env::var_os("HOME").ok_or_else(|| io::Error::other("HOME is unavailable"))?;
    Ok(PlatformLoginItem::new(home, stable_runtime_entrypoint()?))
}

#[cfg(target_os = "windows")]
fn runtime_login_item() -> Result<PlatformLoginItem, Box<dyn Error>> {
    Ok(PlatformLoginItem::new(stable_runtime_entrypoint()?))
}

fn stable_runtime_entrypoint() -> Result<std::path::PathBuf, io::Error> {
    std::env::var_os("DEBRUTE_RUNTIME_STABLE_ENTRYPOINT")
        .map(std::path::PathBuf::from)
        .map_or_else(std::env::current_exe, Ok)
}
