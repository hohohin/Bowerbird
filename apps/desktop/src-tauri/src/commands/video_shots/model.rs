use super::invalid;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub type Texts = [String; 3];
pub type Results = BTreeMap<String, Texts>;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Scene,
    Manual,
    Long,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Cut {
    pub at: i64,
    pub kind: Kind,
}
#[derive(Clone, Default, Debug, Deserialize, Serialize)]
pub(super) struct Layout {
    pub cuts: Vec<Cut>,
    pub selected: Vec<String>,
    pub suppressed: BTreeSet<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub source_hash: String,
    pub revision: i64,
    pub duration_ms: i64,
    pub cuts: Vec<Cut>,
    pub selected: Vec<String>,
    pub results: Results,
    pub threshold: f64,
    pub can_undo: bool,
    pub undo_cuts: Option<Vec<Cut>>,
}

pub fn intervals(cuts: &[Cut], duration: i64) -> impl Iterator<Item = (i64, i64)> + '_ {
    let edges = cuts
        .iter()
        .map(|cut| cut.at)
        .chain(std::iter::once(duration));
    std::iter::once(0)
        .chain(cuts.iter().map(|cut| cut.at))
        .zip(edges)
}
pub fn interval_id(start: i64, end: i64) -> String {
    format!("{start}-{end}")
}
impl Plan {
    pub fn interval(&self, id: &str) -> Option<(i64, i64)> {
        let (s, e) = id.split_once('-')?;
        let (s, e): (i64, i64) = (s.parse().ok()?, e.parse().ok()?);
        if id != interval_id(s, e) {
            return None;
        }
        let next = if s == 0 {
            0
        } else {
            self.cuts.binary_search_by_key(&s, |cut| cut.at).ok()? + 1
        };
        (e == self.cuts.get(next).map_or(self.duration_ms, |cut| cut.at)).then_some((s, e))
    }
}

pub(super) fn validate(cuts: &[Cut], duration: i64) -> AppResult<()> {
    if intervals(cuts, duration).any(|(s, e)| e <= s) {
        return Err(invalid("切点须在原片时长内并按时间排列"));
    }
    Ok(())
}
pub(super) fn valid_threshold(threshold: f64) -> AppResult<()> {
    if !(0.01..=0.99).contains(&threshold) {
        return Err(invalid("请选择有效的检测阈值"));
    }
    Ok(())
}
pub(super) fn with_long_segments(mut cuts: Vec<Cut>, duration: i64) -> Vec<Cut> {
    // Long shot subdivisions are distinct from scene changes.
    let mut added = Vec::new();
    // Container duration is untrusted. Keep the initial editable layout bounded even
    // if a damaged header advertises years of footage. Real scene cuts are untouched.
    let target = 15000.max(duration / 100_000);
    for (s, e) in intervals(&cuts, duration) {
        let span = e - s;
        let count = span.div_euclid(target) + i64::from(span % target != 0);
        for n in 1..count {
            added.push(Cut {
                at: s + (span as i128 * n as i128 / count as i128) as i64,
                kind: Kind::Long,
            });
        }
    }
    cuts.extend(added);
    cuts.sort_unstable_by_key(|cut| cut.at);
    cuts
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Change {
    Select {
        selected: Vec<String>,
    },
    Edit {
        id: String,
        texts: Texts,
    },
    Cuts {
        cuts: Vec<Cut>,
        threshold: Option<f64>,
        confirmed: Vec<String>,
        #[serde(rename = "suppressedAt")]
        suppressed_at: Option<i64>,
    },
    Undo {
        confirmed: Vec<String>,
    },
}
