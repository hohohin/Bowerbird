use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
};

const PREPARING: u8 = 0;
const STARTED: u8 = 1;
const CANCELLED: u8 = 2;

pub struct Intent {
    id: String,
    phase: AtomicU8,
}
impl Intent {
    pub fn begin(&self) -> bool {
        self.phase
            .compare_exchange(PREPARING, STARTED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
    pub fn cancelled(&self) -> bool {
        self.phase.load(Ordering::Acquire) == CANCELLED
    }
}

struct Registry {
    active: Option<Arc<Intent>>,
    // IPC tasks can be scheduled in a different order. Retain recent early
    // cancellations, with a bound for late mouse-up messages after completion.
    cancelled: VecDeque<String>,
}
pub struct Sessions(Mutex<Registry>);
impl Default for Sessions {
    fn default() -> Self {
        Self::new()
    }
}
impl Sessions {
    pub const fn new() -> Self {
        Self(Mutex::new(Registry {
            active: None,
            cancelled: VecDeque::new(),
        }))
    }
    pub fn start(&self, id: String) -> Result<Session<'_>, &'static str> {
        let mut registry = self.0.lock().unwrap();
        if registry.active.is_some() {
            return Err("已有素材正在拖动，请先放下或取消");
        }
        let phase = if let Some(index) = registry.cancelled.iter().position(|value| value == &id) {
            registry.cancelled.remove(index);
            CANCELLED
        } else {
            PREPARING
        };
        let intent = Arc::new(Intent {
            id,
            phase: AtomicU8::new(phase),
        });
        registry.active = Some(intent.clone());
        Ok(Session {
            owner: self,
            intent,
        })
    }
    pub fn cancel_pending(&self, id: &str) {
        let mut registry = self.0.lock().unwrap();
        if let Some(active) = registry.active.as_ref().filter(|active| active.id == id) {
            let _ = active.phase.compare_exchange(
                PREPARING,
                CANCELLED,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        } else if !registry.cancelled.iter().any(|value| value == id) {
            if registry.cancelled.len() == 64 {
                registry.cancelled.pop_front();
            }
            registry.cancelled.push_back(id.into());
        }
    }
}
pub struct Session<'a> {
    owner: &'a Sessions,
    pub intent: Arc<Intent>,
}
impl Drop for Session<'_> {
    fn drop(&mut self) {
        self.owner.0.lock().unwrap().active = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn released_preparation_cannot_start_on_a_later_mouse_press() {
        let sessions = Sessions::new();
        let old = sessions.start("old".into()).unwrap();
        sessions.cancel_pending("old");
        assert!(old.intent.cancelled());
        assert!(!old.intent.begin());
        drop(old);
        assert!(sessions.start("new".into()).unwrap().intent.begin());
    }
    #[test]
    fn cancellation_arriving_before_start_is_kept_without_cancelling_another_drag() {
        let sessions = Sessions::new();
        let current = sessions.start("current".into()).unwrap();
        sessions.cancel_pending("later");
        sessions.cancel_pending("older");
        assert!(current.intent.begin());
        drop(current);
        assert!(!sessions.start("later".into()).unwrap().intent.begin());
    }
    #[test]
    fn native_session_owns_release_and_rejects_nested_drags() {
        let sessions = Sessions::new();
        let active = sessions.start("active".into()).unwrap();
        assert!(active.intent.begin());
        sessions.cancel_pending("active");
        assert!(!active.intent.cancelled());
        assert!(sessions.start("second".into()).is_err());
        drop(active);
        assert!(sessions.start("second".into()).is_ok());
    }
}
