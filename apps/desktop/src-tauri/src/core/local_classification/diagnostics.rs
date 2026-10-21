//! Bounded, memory-only development telemetry. Never records images, tokens or request bodies.
#[cfg(debug_assertions)]
use std::{collections::VecDeque, sync::{Arc, Mutex}, time::Instant};
#[cfg(debug_assertions)]
use serde::Serialize;

#[derive(Clone, Default)]
pub(super) struct Diagnostics {
    #[cfg(debug_assertions)]
    rows: Arc<Mutex<VecDeque<Record>>>,
}

#[cfg(debug_assertions)]
#[derive(Clone, Serialize)]
pub struct Step {
    pub stage: String,
    pub at_ms: u64,
    pub detail: String,
}

#[cfg(debug_assertions)]
#[derive(Clone, Serialize)]
pub struct Row {
    pub id: String,
    pub name: String,
    pub elapsed_ms: u64,
    pub finished: bool,
    pub steps: Vec<Step>,
}

#[cfg(debug_assertions)]
struct Record { start: Instant, row: Row }

impl Diagnostics {
    pub fn clear(&self) {
        #[cfg(debug_assertions)]
        if let Ok(mut rows) = self.rows.lock() { rows.clear(); }
    }

    pub fn begin(&self, id: &str, name: &str) {
        #[cfg(debug_assertions)]
        if let Ok(mut rows) = self.rows.lock() {
            rows.retain(|r| r.row.id != id);
            rows.push_back(Record { start: Instant::now(), row: Row {
                id: id.into(), name: name.into(), elapsed_ms: 0, finished: false,
                steps: vec![Step { stage: "prepare".into(), at_ms: 0, detail: "读取图片、缩放及准备标签示例".into() }],
            } });
            if rows.len() > 128 { rows.pop_front(); }
        }
        #[cfg(not(debug_assertions))]
        let _ = (id, name);
    }

    pub fn step(&self, id: &str, stage: &str, detail: &str) {
        #[cfg(debug_assertions)]
        if let Ok(mut rows) = self.rows.lock() {
            if let Some(record) = rows.iter_mut().find(|r| r.row.id == id) {
                if record.row.finished { return; }
                let elapsed = record.start.elapsed().as_millis() as u64;
                record.row.elapsed_ms = elapsed;
                record.row.finished = matches!(stage, "complete" | "failed" | "cancelled");
                // Each image makes at most two requests with three attempts each.
                if record.row.steps.len() < 32 {
                    record.row.steps.push(Step { stage: stage.into(), at_ms: elapsed, detail: detail.into() });
                }
            }
        }
        #[cfg(not(debug_assertions))]
        let _ = (id, stage, detail);
    }

    pub fn cancel_remaining(&self) {
        #[cfg(debug_assertions)]
        {
            let ids = self.snapshot().into_iter().filter(|r| !r.finished).map(|r| r.id).collect::<Vec<_>>();
            for id in ids { self.step(&id, "cancelled", "已停止本地等待"); }
        }
    }

    #[cfg(debug_assertions)]
    pub fn snapshot(&self) -> Vec<Row> {
        self.rows.lock().map(|rows| rows.iter().map(|record| {
            let mut row = record.row.clone();
            if !row.finished { row.elapsed_ms = record.start.elapsed().as_millis() as u64; }
            row
        }).collect()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn telemetry_is_bounded_ordered_and_cancellation_freezes_elapsed() {
        let log = Diagnostics::default();
        for i in 0..140 { log.begin(&i.to_string(), "测试图片"); }
        log.step("139", "backoff", "HTTP 429；等待 61 秒");
        let rows = log.snapshot();
        assert_eq!(rows.len(), 128);
        assert_eq!(rows[0].id, "12");
        assert_eq!(rows.last().unwrap().steps[1].stage, "backoff");
        log.cancel_remaining();
        let rows = log.snapshot();
        assert!(rows.iter().all(|r| r.finished));
        let elapsed = rows.last().unwrap().elapsed_ms;
        log.step("139", "complete", "迟到事件");
        assert_eq!(log.snapshot().last().unwrap().elapsed_ms, elapsed);
        assert_eq!(log.snapshot().last().unwrap().steps.last().unwrap().stage, "cancelled");
        log.clear();
        assert!(log.snapshot().is_empty());
    }
}
