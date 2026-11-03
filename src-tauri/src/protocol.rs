//! Android Wry 0.54 waits 10s for a custom-protocol response and then panics.
//! Never let a network stall outlive that boundary, even if Tokio is busy.
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

type Sender<T> = Box<dyn FnOnce(T) + Send>;
pub struct DeadlineResponder<T> {
    state: Arc<(Mutex<Option<Sender<T>>>, Condvar)>,
}

impl<T: Send + 'static> DeadlineResponder<T> {
    pub fn new(
        send: impl FnOnce(T) + Send + 'static,
        timeout: Duration,
        fallback: impl Fn() -> T + Send + Sync + 'static,
    ) -> Self {
        let state = Arc::new((
            Mutex::new(Some(Box::new(send) as Sender<T>)),
            Condvar::new(),
        ));
        let waiting = state.clone();
        let fallback = Arc::new(fallback);
        let on_timeout = fallback.clone();
        let spawned = std::thread::Builder::new()
            .name("protocol-deadline".into())
            .stack_size(128 * 1024)
            .spawn(move || {
                let (lock, changed) = &*waiting;
                let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
                let (mut guard, result) = changed
                    .wait_timeout_while(guard, timeout, |send| send.is_some())
                    .unwrap_or_else(|e| e.into_inner());
                if result.timed_out() {
                    if let Some(send) = guard.take() {
                        drop(guard);
                        send(on_timeout());
                    }
                }
            });
        let responder = Self { state };
        if spawned.is_err() {
            responder.respond(fallback());
        }
        responder
    }
    pub fn respond(&self, value: T) -> bool {
        let (lock, changed) = &*self.state;
        let send = lock.lock().unwrap_or_else(|e| e.into_inner()).take();
        changed.notify_one();
        if let Some(send) = send {
            send(value);
            true
        } else {
            false
        }
    }
}

pub type AssetResponder = DeadlineResponder<tauri::http::Response<Vec<u8>>>;
pub fn guard(raw: tauri::UriSchemeResponder, url: String) -> AssetResponder {
    DeadlineResponder::new(
        move |response: tauri::http::Response<Vec<u8>>| {
            let timed_out = response.status().as_u16() == 504;
            raw.respond(response);
            if timed_out {
                log::warn!("[protocol-timeout] request exceeded response deadline: {url}");
            }
        },
        Duration::from_secs(8),
        || {
            tauri::http::Response::builder()
                .status(504)
                .header("Access-Control-Allow-Origin", "*")
                .body(b"Resource request timed out; retry after download completes".to_vec())
                .unwrap()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stalled_request_returns_before_wry_and_late_completion_is_ignored() {
        let (tx, rx) = std::sync::mpsc::channel();
        let responder = DeadlineResponder::new(
            move |value| {
                tx.send(value).unwrap();
            },
            Duration::from_millis(25),
            || 504,
        );
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), 504);
        assert!(!responder.respond(200));
        assert!(rx.try_recv().is_err());
    }
    #[test]
    fn completed_request_cancels_watchdog_without_double_response() {
        let (tx, rx) = std::sync::mpsc::channel();
        let responder = DeadlineResponder::new(
            move |value| {
                tx.send(value).unwrap();
            },
            Duration::from_millis(25),
            || 504,
        );
        assert!(responder.respond(200));
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), 200);
        assert!(rx.recv_timeout(Duration::from_millis(60)).is_err());
    }
}
