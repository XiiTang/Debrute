use std::{
    collections::HashMap,
    fs,
    time::{Duration, Instant},
};

use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::project::ProjectUse;

use super::{
    PhotoshopBridgeError, PhotoshopBridgeErrorCode, PhotoshopDownloadPlan,
    PhotoshopTransferDirection, PhotoshopTransferStatus, PhotoshopTransferView,
};

const TRANSFER_TIMEOUT: Duration = Duration::from_mins(5);
const MAX_ACTIVE_TRANSFERS: usize = 16;
const TERMINAL_HISTORY_LIMIT: usize = 20;

struct DownloadAuthority {
    token: String,
    file: fs::File,
    byte_length: u64,
    mime_type: &'static str,
    file_name: String,
}

struct TransferRecord {
    view: PhotoshopTransferView,
    deadline: Instant,
    download: Option<DownloadAuthority>,
    project_use: Option<ProjectUse>,
}

pub(crate) struct PhotoshopTransferStore {
    records: HashMap<String, TransferRecord>,
}

pub(crate) struct NewPhotoshopTransfer<'a> {
    pub transfer_id: &'a str,
    pub direction: PhotoshopTransferDirection,
    pub project_id: &'a str,
    pub plugin_instance_id: &'a str,
    pub project_relative_path: Option<String>,
    pub project_use: ProjectUse,
}

pub(crate) struct NewPhotoshopDownload<'a> {
    pub transfer: NewPhotoshopTransfer<'a>,
    pub token: String,
    pub file: fs::File,
    pub byte_length: u64,
    pub mime_type: &'static str,
    pub file_name: String,
}

impl PhotoshopTransferStore {
    pub(crate) fn new() -> Self {
        Self {
            records: HashMap::new(),
        }
    }

    pub(crate) fn begin_download(
        &mut self,
        input: NewPhotoshopDownload<'_>,
    ) -> Result<PhotoshopTransferView, PhotoshopBridgeError> {
        let NewPhotoshopDownload {
            transfer,
            token,
            file,
            byte_length,
            mime_type,
            file_name,
        } = input;
        let record = self.begin(transfer)?;
        let view = record.view.clone();
        record.download = Some(DownloadAuthority {
            token,
            file,
            byte_length,
            mime_type,
            file_name,
        });
        record.view.status = PhotoshopTransferStatus::Running;
        Ok(PhotoshopTransferView {
            status: PhotoshopTransferStatus::Running,
            ..view
        })
    }

    pub(crate) fn begin_upload(
        &mut self,
        input: NewPhotoshopTransfer<'_>,
    ) -> Result<PhotoshopTransferView, PhotoshopBridgeError> {
        let record = self.begin(input)?;
        record.view.status = PhotoshopTransferStatus::Running;
        Ok(record.view.clone())
    }

    fn begin(
        &mut self,
        input: NewPhotoshopTransfer<'_>,
    ) -> Result<&mut TransferRecord, PhotoshopBridgeError> {
        if self.records.contains_key(input.transfer_id) {
            return Err(PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::InvalidTransferPayload,
                "Photoshop transfer id has already been used.",
            ));
        }
        if self
            .records
            .values()
            .filter(|record| !record.view.status.is_terminal())
            .count()
            >= MAX_ACTIVE_TRANSFERS
        {
            return Err(PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::TransferCapacityReached,
                "Photoshop transfer capacity is exhausted.",
            ));
        }
        let now = OffsetDateTime::now_utc();
        let timestamp = format_time(now)?;
        let id = input.transfer_id.to_owned();
        self.records.insert(
            id.clone(),
            TransferRecord {
                view: PhotoshopTransferView {
                    transfer_id: id.clone(),
                    direction: input.direction,
                    project_id: input.project_id.to_owned(),
                    plugin_instance_id: input.plugin_instance_id.to_owned(),
                    project_relative_path: input.project_relative_path,
                    status: PhotoshopTransferStatus::Pending,
                    error_code: None,
                    message: None,
                    created_at: timestamp.clone(),
                    updated_at: timestamp,
                },
                deadline: Instant::now() + TRANSFER_TIMEOUT,
                download: None,
                project_use: Some(input.project_use),
            },
        );
        self.records.get_mut(&id).ok_or_else(|| {
            PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::StatePoisoned,
                "Photoshop transfer state is unavailable.",
            )
        })
    }

    pub(crate) fn take_download(
        &mut self,
        plugin_instance_id: &str,
        transfer_id: &str,
        token: &str,
    ) -> Result<PhotoshopDownloadPlan, PhotoshopBridgeError> {
        let record = self.records.get_mut(transfer_id).ok_or_else(expired_url)?;
        if record.view.plugin_instance_id != plugin_instance_id
            || record.view.direction != PhotoshopTransferDirection::DebruteToPhotoshop
            || record.view.status.is_terminal()
            || record.deadline <= Instant::now()
        {
            return Err(expired_url());
        }
        let valid_token = record.download.as_ref().is_some_and(|download| {
            constant_time_equal(download.token.as_bytes(), token.as_bytes())
        });
        if !valid_token {
            return Err(expired_url());
        }
        let download = record.download.take().ok_or_else(expired_url)?;
        Ok(PhotoshopDownloadPlan {
            file: download.file,
            byte_length: download.byte_length,
            mime_type: download.mime_type,
            file_name: download.file_name,
        })
    }

    pub(crate) fn active_download_project(
        &mut self,
        plugin_instance_id: &str,
        transfer_id: &str,
    ) -> Result<String, PhotoshopBridgeError> {
        let record = self.records.get(transfer_id).ok_or_else(expired_url)?;
        if record.view.plugin_instance_id != plugin_instance_id
            || record.view.direction != PhotoshopTransferDirection::DebruteToPhotoshop
            || record.view.status.is_terminal()
            || record.download.is_none()
            || record.deadline <= Instant::now()
        {
            return Err(expired_url());
        }
        Ok(record.view.project_id.clone())
    }

    pub(crate) fn complete(
        &mut self,
        plugin_instance_id: &str,
        transfer_id: &str,
        ok: bool,
        error_code: Option<PhotoshopBridgeErrorCode>,
        message: Option<String>,
        project_relative_path: Option<String>,
    ) -> Result<PhotoshopTransferView, PhotoshopBridgeError> {
        let record = self.records.get_mut(transfer_id).ok_or_else(|| {
            PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::InvalidTransferPayload,
                "Photoshop transfer was not found.",
            )
        })?;
        if record.view.plugin_instance_id != plugin_instance_id || record.view.status.is_terminal()
        {
            return Err(PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::InvalidTransferPayload,
                "Photoshop transfer cannot accept this result.",
            ));
        }
        if ok && (error_code.is_some() || message.is_some()) {
            return Err(PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::InvalidTransferPayload,
                "A successful Photoshop transfer cannot contain failure detail.",
            ));
        }
        record.view.status = if ok {
            PhotoshopTransferStatus::Succeeded
        } else {
            PhotoshopTransferStatus::Failed
        };
        record.view.error_code = if ok {
            None
        } else {
            error_code.or(Some(PhotoshopBridgeErrorCode::PhotoshopPlaceFailed))
        };
        record.view.message = message;
        if project_relative_path.is_some() {
            record.view.project_relative_path = project_relative_path;
        }
        record.view.updated_at = now_string()?;
        record.download = None;
        record.project_use = None;
        let view = record.view.clone();
        self.prune_terminal();
        Ok(view)
    }

    pub(crate) fn fail_for_plugin(
        &mut self,
        plugin_instance_id: &str,
        code: PhotoshopBridgeErrorCode,
        message: &str,
    ) {
        for record in self.records.values_mut().filter(|record| {
            record.view.plugin_instance_id == plugin_instance_id
                && !record.view.status.is_terminal()
        }) {
            fail_record(record, code, message);
        }
        self.prune_terminal();
    }

    pub(crate) fn fail_all(&mut self, code: PhotoshopBridgeErrorCode, message: &str) {
        for record in self
            .records
            .values_mut()
            .filter(|record| !record.view.status.is_terminal())
        {
            fail_record(record, code, message);
        }
        self.prune_terminal();
    }

    pub(crate) fn expire_due(&mut self) -> bool {
        let now = Instant::now();
        let mut changed = false;
        for record in self
            .records
            .values_mut()
            .filter(|record| !record.view.status.is_terminal() && record.deadline <= now)
        {
            changed = true;
            fail_record(
                record,
                PhotoshopBridgeErrorCode::TransferTimeout,
                "Photoshop transfer timed out.",
            );
        }
        self.prune_terminal();
        changed
    }

    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.records
            .values()
            .filter(|record| !record.view.status.is_terminal())
            .map(|record| record.deadline)
            .min()
    }

    #[cfg(test)]
    pub(crate) fn expire_all_for_test(&mut self) {
        for record in self
            .records
            .values_mut()
            .filter(|record| !record.view.status.is_terminal())
        {
            record.deadline = Instant::now();
        }
        let _ = self.expire_due();
    }

    pub(crate) fn views(&self) -> Vec<PhotoshopTransferView> {
        let mut views = self
            .records
            .values()
            .map(|record| record.view.clone())
            .collect::<Vec<_>>();
        views.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.transfer_id.cmp(&right.transfer_id))
        });
        views
    }

    fn prune_terminal(&mut self) {
        let mut terminal = self
            .records
            .iter()
            .filter(|(_, record)| record.view.status.is_terminal())
            .map(|(id, record)| (id.clone(), record.view.updated_at.clone()))
            .collect::<Vec<_>>();
        terminal.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
        let remove = terminal.len().saturating_sub(TERMINAL_HISTORY_LIMIT);
        for (id, _) in terminal.into_iter().take(remove) {
            self.records.remove(&id);
        }
    }
}

fn fail_record(record: &mut TransferRecord, code: PhotoshopBridgeErrorCode, message: &str) {
    record.view.status = PhotoshopTransferStatus::Failed;
    record.view.error_code = Some(code);
    record.view.message = Some(message.to_owned());
    record.view.updated_at = now_string().unwrap_or_else(|_| record.view.created_at.clone());
    record.download = None;
    record.project_use = None;
}

fn expired_url() -> PhotoshopBridgeError {
    PhotoshopBridgeError::new(
        PhotoshopBridgeErrorCode::TransferUrlExpired,
        "Photoshop transfer URL expired.",
    )
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let maximum = left.len().max(right.len());
    for index in 0..maximum {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

fn now_string() -> Result<String, PhotoshopBridgeError> {
    format_time(OffsetDateTime::now_utc())
}

fn format_time(value: OffsetDateTime) -> Result<String, PhotoshopBridgeError> {
    value.format(&Rfc3339).map_err(|error| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PersistenceFailed,
            error.to_string(),
        )
    })
}
