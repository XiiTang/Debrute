use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};

use super::super::{ProjectCapabilityFs, ProjectError, normalize_project_relative_path};
use super::PreviewCancellation;

const READABLE_CACHE_KEY_PREFIX_MAX_LENGTH: usize = 96;
const FNV64_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV64_PRIME: u64 = 0x0000_0100_0000_01b3;
const PREVIEW_ADMISSION_POLL: Duration = Duration::from_millis(50);

pub(super) struct Semaphore {
    capacity: usize,
    state: Mutex<SemaphoreState>,
    available: Condvar,
}

struct SemaphoreState {
    active: usize,
}

impl Semaphore {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            state: Mutex::new(SemaphoreState { active: 0 }),
            available: Condvar::new(),
        }
    }

    pub(super) fn acquire(
        &self,
        cancellation: &PreviewCancellation,
    ) -> Result<SemaphorePermit<'_>, ProjectError> {
        cancellation.check()?;
        let mut state = self.state.lock().map_err(|_| ProjectError::StatePoisoned)?;
        if state.active >= self.capacity {
            while state.active >= self.capacity {
                cancellation.check()?;
                state = self
                    .available
                    .wait_timeout(state, PREVIEW_ADMISSION_POLL)
                    .map_err(|_| ProjectError::StatePoisoned)?
                    .0;
            }
        }
        cancellation.check()?;
        state.active += 1;
        Ok(SemaphorePermit { semaphore: self })
    }
}

pub(super) struct SemaphorePermit<'a> {
    semaphore: &'a Semaphore,
}

impl Drop for SemaphorePermit<'_> {
    fn drop(&mut self) {
        let mut state = self
            .semaphore
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active = state.active.saturating_sub(1);
        self.semaphore.available.notify_one();
    }
}

#[derive(Default)]
pub(super) struct KeyedLocks {
    locks: Mutex<HashMap<String, Arc<KeyState>>>,
}

impl KeyedLocks {
    pub(super) fn acquire(
        &self,
        key: &str,
        cancellation: &PreviewCancellation,
    ) -> Result<KeyedLock<'_>, ProjectError> {
        cancellation.check()?;
        let reservation = {
            let mut locks = self.locks.lock().map_err(|_| ProjectError::StatePoisoned)?;
            let state = locks
                .get(key)
                .cloned()
                .unwrap_or_else(|| Arc::new(KeyState::default()));
            locks.insert(key.to_owned(), Arc::clone(&state));
            KeyReservation {
                owner: self,
                key: key.to_owned(),
                state,
            }
        };
        let mut activity = reservation
            .state
            .activity
            .lock()
            .map_err(|_| ProjectError::StatePoisoned)?;
        if activity.active {
            activity.waiters += 1;
            while activity.active {
                if let Err(error) = cancellation.check() {
                    activity.waiters = activity.waiters.saturating_sub(1);
                    return Err(error);
                }
                activity = reservation
                    .state
                    .available
                    .wait_timeout(activity, PREVIEW_ADMISSION_POLL)
                    .map_err(|_| ProjectError::StatePoisoned)?
                    .0;
            }
            activity.waiters = activity.waiters.saturating_sub(1);
        }
        cancellation.check()?;
        activity.active = true;
        drop(activity);
        Ok(KeyedLock {
            owner: self,
            key: key.to_owned(),
            state: Arc::clone(&reservation.state),
        })
    }
}

struct KeyReservation<'a> {
    owner: &'a KeyedLocks,
    key: String,
    state: Arc<KeyState>,
}

impl Drop for KeyReservation<'_> {
    fn drop(&mut self) {
        let mut locks = self
            .owner
            .locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = locks
            .get(&self.key)
            .filter(|state| Arc::ptr_eq(state, &self.state));
        let Some(current) = current else {
            return;
        };
        let activity = current
            .activity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let removable =
            !activity.active && activity.waiters == 0 && Arc::strong_count(current) == 2;
        drop(activity);
        if removable {
            locks.remove(&self.key);
        }
    }
}

struct KeyState {
    activity: Mutex<KeyActivity>,
    available: Condvar,
}

#[derive(Default)]
struct KeyActivity {
    active: bool,
    waiters: usize,
}

impl Default for KeyState {
    fn default() -> Self {
        Self {
            activity: Mutex::new(KeyActivity::default()),
            available: Condvar::new(),
        }
    }
}

pub(super) struct KeyedLock<'a> {
    owner: &'a KeyedLocks,
    key: String,
    state: Arc<KeyState>,
}

impl Drop for KeyedLock<'_> {
    fn drop(&mut self) {
        let mut activity = self
            .state
            .activity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        activity.active = false;
        self.state.available.notify_one();
        drop(activity);
        let mut locks = self
            .owner
            .locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if Arc::strong_count(&self.state) == 2
            && locks
                .get(&self.key)
                .is_some_and(|state| Arc::ptr_eq(state, &self.state))
        {
            locks.remove(&self.key);
        }
    }
}

pub(super) fn project_relative_path_cache_key(path: &str) -> Result<String, ProjectError> {
    let normalized = normalize_project_relative_path(path)?;
    let encoded = encode_uri_component(&normalized);
    let mut readable = if encoded.len() <= READABLE_CACHE_KEY_PREFIX_MAX_LENGTH {
        encoded.clone()
    } else {
        let mut prefix = encoded[..READABLE_CACHE_KEY_PREFIX_MAX_LENGTH].to_owned();
        if let Some(last_percent) = prefix.rfind('%')
            && prefix.len() - last_percent < 3
        {
            prefix.truncate(last_percent);
        }
        prefix
    };
    if readable.is_empty() {
        "path".clone_into(&mut readable);
    }
    let hash = normalized
        .as_bytes()
        .iter()
        .fold(FNV64_OFFSET_BASIS, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(FNV64_PRIME)
        });
    Ok(format!("{readable}--{hash:016x}"))
}

pub(super) fn project_revision_cache_key(revision: &str) -> Result<String, ProjectError> {
    if revision.is_empty() {
        return Err(ProjectError::Validation(
            "Project revision cache key source must be non-empty.".to_owned(),
        ));
    }
    Ok(encode_uri_component(revision))
}

pub(super) fn safe_cache_segment(value: &str, label: &str) -> Result<String, ProjectError> {
    if value.is_empty() {
        return Err(ProjectError::Validation(format!(
            "{label} must be non-empty."
        )));
    }
    let encoded = encode_uri_component(value);
    if encoded.is_empty() || matches!(encoded.as_str(), "." | "..") || encoded.contains(['/', '\\'])
    {
        return Err(ProjectError::Validation(format!(
            "{label} must be a filesystem-safe path segment."
        )));
    }
    Ok(encoded)
}

pub(super) fn validate_cache_segment(value: &str, label: &str) -> Result<String, ProjectError> {
    if value.is_empty() || matches!(value, "." | "..") || value.contains(['/', '\\']) {
        Err(ProjectError::Validation(format!(
            "{label} must be a filesystem-safe path segment."
        )))
    } else {
        Ok(value.to_owned())
    }
}

pub(super) fn atomic_write(
    project_root: &std::path::Path,
    project_relative_path: &str,
    bytes: &[u8],
) -> Result<(), ProjectError> {
    ProjectCapabilityFs::open(project_root)?.atomic_write(project_relative_path, bytes)
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_keys_match_the_frozen_typescript_algorithm() {
        assert_eq!(
            project_relative_path_cache_key("images/cover.png").unwrap(),
            "images%2Fcover.png--58c1e05606778e3e"
        );
        assert_eq!(
            project_revision_cache_key("1780000000000:204800").unwrap(),
            "1780000000000%3A204800"
        );
        assert_eq!(
            project_relative_path_cache_key("拼接图/韩语 page 1.png").unwrap(),
            "%E6%8B%BC%E6%8E%A5%E5%9B%BE%2F%E9%9F%A9%E8%AF%AD%20page%201.png--a2da7f50228f9fdc"
        );
    }

    #[test]
    fn abandoned_key_reservations_do_not_accumulate() {
        let locks = KeyedLocks::default();
        for index in 0..=128 {
            let key = format!("cancelled-{index}");
            let state = Arc::new(KeyState::default());
            locks
                .locks
                .lock()
                .unwrap()
                .insert(key.clone(), Arc::clone(&state));
            drop(KeyReservation {
                owner: &locks,
                key,
                state,
            });
        }
        assert!(locks.locks.lock().unwrap().is_empty());
    }

    #[test]
    fn one_reservation_cannot_remove_a_reused_same_key_state() {
        let locks = KeyedLocks::default();
        let key = "shared".to_owned();
        let state = Arc::new(KeyState::default());
        locks
            .locks
            .lock()
            .unwrap()
            .insert(key.clone(), Arc::clone(&state));
        let first = KeyReservation {
            owner: &locks,
            key: key.clone(),
            state: Arc::clone(&state),
        };
        let second = KeyReservation {
            owner: &locks,
            key: key.clone(),
            state,
        };

        drop(first);
        assert!(locks.locks.lock().unwrap().contains_key(&key));
        drop(second);
        assert!(locks.locks.lock().unwrap().is_empty());
    }
}
