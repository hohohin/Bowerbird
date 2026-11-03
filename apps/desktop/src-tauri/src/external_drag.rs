#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Decision {
    Continue,
    Drop,
    Cancel,
}

pub struct Gesture {
    pickup: bool,
    pressed: bool,
}
impl Gesture {
    pub fn new(pickup: bool) -> Self {
        Self {
            pickup,
            pressed: false,
        }
    }
    pub fn update(&mut self, left: bool, cancel: bool) -> Decision {
        if cancel {
            Decision::Cancel
        } else if !left && self.pressed {
            Decision::Drop
        } else if !left && !self.pickup {
            Decision::Cancel
        } else if left {
            self.pressed = true;
            Decision::Continue
        } else {
            Decision::Continue
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_drag_drops_on_release() {
        let mut gesture = Gesture::new(false);
        assert_eq!(gesture.update(true, false), Decision::Continue);
        assert_eq!(gesture.update(false, false), Decision::Drop);
    }
    #[test]
    fn delayed_hold_start_never_drops_after_pointer_was_already_released() {
        let mut gesture = Gesture::new(false);
        assert_eq!(gesture.update(false, false), Decision::Cancel);
    }
    #[test]
    fn pickup_waits_without_button_until_next_complete_click() {
        let mut gesture = Gesture::new(true);
        assert_eq!(gesture.update(false, false), Decision::Continue);
        assert_eq!(gesture.update(false, false), Decision::Continue);
        assert_eq!(gesture.update(true, false), Decision::Continue);
        assert_eq!(gesture.update(false, false), Decision::Drop);
    }
    #[test]
    fn escape_and_right_click_cancel_even_before_first_click() {
        assert_eq!(Gesture::new(true).update(false, true), Decision::Cancel);
        assert_eq!(Gesture::new(false).update(true, true), Decision::Cancel);
    }
}
#[cfg(target_os = "macos")]
#[path = "external_drag/macos.rs"]
pub mod macos;
#[path = "external_drag/session.rs"]
pub mod session;
#[cfg(windows)]
#[path = "external_drag/windows.rs"]
pub mod windows;
#[path = "external_drag/preview.rs"]
pub mod preview;
