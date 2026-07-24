use std::{
    error::Error,
    fmt,
    io::Write,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender, TrySendError},
    },
    thread,
};

use super::{ServerMessage, encode_server_frame};

#[derive(Clone)]
pub(super) struct ControlSender {
    sender: SyncSender<OutboundFrame>,
    close_state: Arc<CloseState>,
}

impl ControlSender {
    pub(super) fn send(&self, message: ServerMessage) -> Result<(), OutboundError> {
        self.enqueue(OutboundFrame {
            message,
            flushed: None,
        })
    }

    pub(super) fn send_with_flush_receipt(
        &self,
        message: ServerMessage,
    ) -> Result<mpsc::Receiver<()>, OutboundError> {
        let (flushed, receipt) = mpsc::sync_channel(1);
        self.enqueue(OutboundFrame {
            message,
            flushed: Some(flushed),
        })?;
        Ok(receipt)
    }

    fn enqueue(&self, frame: OutboundFrame) -> Result<(), OutboundError> {
        if self.close_state.closed.load(Ordering::Acquire) {
            return Err(OutboundError::Closed);
        }
        match self.sender.try_send(frame) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.close_state.close();
                Err(OutboundError::QueueFull)
            }
            Err(TrySendError::Disconnected(_)) => {
                self.close_state.close();
                Err(OutboundError::Closed)
            }
        }
    }

    pub(super) fn close(&self) {
        self.close_state.close();
    }
}

struct OutboundFrame {
    message: ServerMessage,
    flushed: Option<SyncSender<()>>,
}

pub(super) fn start_serialized_writer(
    mut writer: impl Write + Send + 'static,
    queue_capacity: usize,
    close: impl Fn() + Send + Sync + 'static,
) -> ControlSender {
    let (sender, receiver) = mpsc::sync_channel::<OutboundFrame>(queue_capacity);
    let close_state = Arc::new(CloseState {
        closed: AtomicBool::new(false),
        close: Box::new(close),
    });
    let writer_close_state = Arc::clone(&close_state);
    thread::spawn(move || {
        while let Ok(frame) = receiver.recv() {
            let result = encode_server_frame(&frame.message)
                .map_err(|_| ())
                .and_then(|frame| writer.write_all(&frame).map_err(|_| ()))
                .and_then(|()| writer.flush().map_err(|_| ()));
            if result.is_err() {
                writer_close_state.close();
                return;
            }
            if let Some(flushed) = frame.flushed {
                let _ = flushed.send(());
            }
        }
    });
    ControlSender {
        sender,
        close_state,
    }
}

struct CloseState {
    closed: AtomicBool,
    close: Box<dyn Fn() + Send + Sync>,
}

impl CloseState {
    fn close(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            (self.close)();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboundError {
    QueueFull,
    Closed,
}

impl fmt::Display for OutboundError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::QueueFull => formatter.write_str("Control outbound queue is full"),
            Self::Closed => formatter.write_str("Control writer is closed"),
        }
    }
}

impl Error for OutboundError {}

#[cfg(test)]
mod tests {
    use std::{io, sync::mpsc, time::Duration};

    use super::{OutboundError, start_serialized_writer};
    use crate::control::{ControlEvent, ServerMessage};

    #[test]
    fn write_failure_closes_the_serialized_connection() {
        let (closed_sender, closed_receiver) = mpsc::channel();
        let sender = start_serialized_writer(FailingWriter, 2, move || {
            let _ = closed_sender.send(());
        });

        sender
            .send(ServerMessage::event(ControlEvent::ProductExiting))
            .expect("event should enter the writer queue");

        closed_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("write failure should close the connection");
        assert_eq!(
            sender.send(ServerMessage::event(ControlEvent::ProductReplacing)),
            Err(OutboundError::Closed)
        );
    }

    struct FailingWriter;

    impl io::Write for FailingWriter {
        fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "injected transport write failure",
            ))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}
