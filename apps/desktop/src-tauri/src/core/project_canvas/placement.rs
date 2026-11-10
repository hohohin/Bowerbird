//! Canvas-unit placement shared by native generation and artifact delivery.
use super::*;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug)]
pub(super) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub(super) fn workflow_rect(node: &Value) -> Rect {
    let kind = node["kind"].as_str().unwrap_or("");
    let size = |key: &str, fallback: f64| {
        node["layoutSize"][key]
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(fallback)
    };
    Rect {
        x: node["x"].as_f64().unwrap_or(0.0),
        y: node["y"].as_f64().unwrap_or(0.0),
        width: size(
            "width",
            if kind == "trigger" {
                196.0
            } else if kind == "comfy-video" {
                416.0
            } else {
                320.0
            },
        ),
        height: size(
            "height",
            if kind == "trigger" {
                92.0
            } else if kind == "comfy-video" {
                360.0
            } else {
                280.0
            },
        ),
    }
}

pub(super) fn near(card: Rect, obstacles: &[Rect], minimum_x: f64) -> (f64, f64) {
    let fits = |x: f64, y: f64| {
        x >= minimum_x
            && !obstacles.iter().any(|other| {
                x < other.x + other.width + 32.0
                    && x + card.width + 32.0 > other.x
                    && y < other.y + other.height + 32.0
                    && y + card.height + 32.0 > other.y
            })
    };
    if fits(card.x, card.y) {
        return (card.x, card.y);
    }
    let mut candidates = Vec::new();
    for other in obstacles {
        let left = other.x - card.width - 32.0;
        let right = other.x + other.width + 32.0;
        let top = other.y - card.height - 32.0;
        let bottom = other.y + other.height + 32.0;
        candidates.extend([
            (right, card.y),
            (card.x, bottom),
            (card.x, top),
            (left, card.y),
            (right, bottom),
            (right, top),
            (left, bottom),
            (left, top),
        ]);
    }
    let distance = |p: &(f64, f64)| (p.0 - card.x).powi(2) + (p.1 - card.y).powi(2);
    candidates.sort_by(|a, b| {
        distance(a)
            .total_cmp(&distance(b))
            .then(b.0.total_cmp(&a.0))
            .then(b.1.total_cmp(&a.1))
    });
    candidates
        .into_iter()
        .find(|&(x, y)| fits(x, y))
        .unwrap_or((card.x, card.y))
}

fn turn(data: &Value, output: bool) -> Option<(String, String)> {
    let data = if output { &data["execution"] } else { data };
    Some((
        data["job_id"].as_str()?.into(),
        data["turn_key"].as_str()?.into(),
    ))
}

/// Presentation-only history must not reserve invisible rectangles. Source IDs,
/// files and persisted positions remain untouched.
pub(super) fn obstacles(
    tx: &Transaction<'_>,
    project: &str,
    workflow: &Value,
    excluded: &[&str],
) -> AppResult<Vec<Rect>> {
    let snapshot = project_canvas_snapshot_tx(tx, project)?;
    let archived: HashSet<_> = snapshot
        .threads
        .iter()
        .filter(|t| t.archived_at.is_some())
        .map(|t| t.id.as_str())
        .collect();
    let mut hidden: HashSet<String> = snapshot
        .group_items
        .iter()
        .map(|i| i.node_id.clone())
        .collect();
    hidden.extend(excluded.iter().map(|id| id.to_string()));
    for node in workflow["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| n["generation"]["media"] == "video")
    {
        hidden.extend(
            node["sessionNodeIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|id| id.as_str().map(String::from)),
        );
    }
    let mut nodes: Vec<_> = snapshot
        .nodes
        .iter()
        .filter(|n| {
            n.hidden_at.is_none() && !n.thread_id.as_deref().is_some_and(|t| archived.contains(t))
        })
        .map(|n| {
            (
                n,
                serde_json::from_str::<Value>(&n.payload_json).unwrap_or_default(),
            )
        })
        .collect();
    nodes.sort_by(|a, b| {
        a.0.created_at
            .cmp(&b.0.created_at)
            .then(a.0.id.cmp(&b.0.id))
    });
    let embedded: HashSet<String> = nodes
        .iter()
        .flat_map(|(_, p)| {
            p["cells"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|row| row.as_array().into_iter().flatten())
                .filter_map(|cell| {
                    cell["generation_ref"]["session_node_id"]
                        .as_str()
                        .map(String::from)
                })
        })
        .collect();
    hidden.extend(embedded.iter().cloned());
    let mut galleries = HashSet::new();
    let mut anchors = HashMap::<String, String>::new();
    let mut finished = HashMap::new();
    let mut folded_turns = HashMap::new();
    for (node, p) in nodes
        .iter()
        .filter(|(n, _)| n.kind == CreativeNodeKind::Prompt)
    {
        // Video history is excluded from the UI; its actual video output remains visible.
        if hidden.contains(&node.id) && !embedded.contains(&node.id) {
            continue;
        }
        if p["generation_group_dissolved"] == true {
            continue;
        }
        let independent = p["workflow_generation_group"]
            .as_str()
            .is_some_and(|key| key.starts_with("asset:"));
        let has_output = nodes.iter().any(|(n, out)| {
            n.kind == CreativeNodeKind::Asset
                && n.role == Some(CreativeNodeRole::Output)
                && turn(out, true) == turn(p, false)
        });
        if independent && !embedded.contains(&node.id) {
            if has_output {
                hidden.insert(node.id.clone());
            }
            continue;
        }
        let mut anchor = node.id.clone();
        if let Some(key) = p["workflow_generation_group"]
            .as_str()
            .or(p["conversation_id"].as_str())
            .or(p["job_id"].as_str())
        {
            anchor = anchors
                .entry(key.to_owned())
                .or_insert_with(|| node.id.clone())
                .clone();
            if !galleries.insert(key.to_owned()) {
                hidden.insert(node.id.clone());
            }
        }
        finished.insert(anchor.clone(), p["status"] == "done");
        if let Some(t) = turn(p, false) {
            folded_turns.insert(t, anchor);
        }
    }
    let mut gallery_heights = HashMap::new();
    for (node, p) in &nodes {
        if node.kind != CreativeNodeKind::Asset || node.role != Some(CreativeNodeRole::Output) {
            continue;
        }
        if let Some(anchor) = turn(p, true).and_then(|t| folded_turns.get(&t)) {
            if let Some((card, _)) = nodes.iter().find(|(n, _)| &n.id == anchor) {
                let width = p["snapshot"]["width"].as_f64().unwrap_or(0.0);
                let height = p["snapshot"]["height"].as_f64().unwrap_or(0.0);
                gallery_heights.insert(
                    anchor.clone(),
                    if finished.get(anchor) == Some(&true) {
                        card.width
                            * if width > 0.0 && height > 0.0 {
                                height / width
                            } else {
                                1.0
                            }
                    } else {
                        card.height.max(340.0)
                    },
                );
            }
        }
    }
    let mut result = Vec::new();
    for (node, p) in nodes {
        if node.kind == CreativeNodeKind::Asset
            && node.role == Some(CreativeNodeRole::Output)
            && turn(&p, true).is_some_and(|t| folded_turns.contains_key(&t))
        {
            continue;
        }
        if node.kind == CreativeNodeKind::Asset && p["generation_group_dissolved"] != true {
            if let Some(key) = p["workflow_generation_group"]
                .as_str()
                .filter(|key| !key.starts_with("asset:"))
            {
                if !galleries.insert(key.to_owned()) {
                    continue;
                }
            }
        }
        if hidden.contains(&node.id) || p["note_type"] == "section" {
            continue;
        }
        result.push(Rect {
            x: node.x,
            y: node.y,
            width: node.width,
            height: gallery_heights
                .get(&node.id)
                .copied()
                .unwrap_or(node.height),
        });
    }
    result.extend(snapshot.groups.iter().map(|g| Rect {
        x: g.x,
        y: g.y,
        width: g.width,
        height: g.height,
    }));
    result.extend(
        workflow["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|n| n["kind"] != "text" && !excluded.contains(&n["id"].as_str().unwrap_or("")))
            .map(workflow_rect),
    );
    Ok(result)
}

pub(super) fn workflow(tx: &Transaction<'_>, project: &str) -> AppResult<Value> {
    let json: Option<String> = tx
        .query_row(
            "SELECT document_json FROM canvas_workflows WHERE project_id=?1",
            [project],
            |row| row.get(0),
        )
        .optional()?;
    Ok(json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()?
        .unwrap_or_default())
}

pub(super) fn source<'a>(workflow: &'a Value, id: &str, agent: bool) -> Option<&'a Value> {
    let runs: Vec<_> = workflow["runs"]
        .as_array()
        .map(|runs| runs.iter().collect())
        .unwrap_or_else(|| vec![&workflow["run"]]);
    for run in runs {
        for (source, step) in run["steps"].as_object().into_iter().flatten() {
            let matches = if agent {
                step["agentRunId"].as_str() == Some(id)
            } else {
                step["jobId"].as_str() == Some(id)
                    || step["localDsGenerations"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .any(|(_, g)| g["jobId"].as_str() == Some(id))
            };
            if matches {
                return workflow["nodes"]
                    .as_array()?
                    .iter()
                    .find(|node| node["id"].as_str() == Some(source));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compact_edges_replace_fixed_downward_steps() {
        let card = Rect {
            x: 384.0,
            y: 0.0,
            width: 260.0,
            height: 148.0,
        };
        let obstacle = Rect {
            x: 384.0,
            y: 0.0,
            width: 260.0,
            height: 180.0,
        };
        // Nearest legal edge is above this obstacle, 180 units away, not a 420-unit jump.
        assert_eq!(near(card, &[obstacle], 384.0), (384.0, -180.0));
        let blocked_top = Rect {
            x: 384.0,
            y: -400.0,
            width: 260.0,
            height: 400.0,
        };
        assert_eq!(near(card, &[obstacle, blocked_top], 384.0), (384.0, 212.0));
        assert_eq!(
            grid(&[(190.0, 180.0); 6]),
            vec![
                (0.0, 0.0),
                (222.0, 0.0),
                (444.0, 0.0),
                (0.0, 212.0),
                (222.0, 212.0),
                (444.0, 212.0)
            ]
        );
        assert_eq!(
            workflow_rect(
                &serde_json::json!({"kind":"generation","layoutSize":{"width":320,"height":156}})
            )
            .height,
            156.0
        );
    }
}

pub(super) fn grid(sizes: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let columns = if sizes.len() <= 2 {
        1
    } else if sizes.len() <= 4 {
        2
    } else {
        3
    };
    let widths: Vec<f64> = (0..columns)
        .map(|col| {
            sizes
                .iter()
                .enumerate()
                .filter(|(i, _)| i % columns == col)
                .map(|(_, s)| s.0)
                .fold(0.0, f64::max)
        })
        .collect();
    let (mut y, mut height) = (0.0, 0.0_f64);
    sizes
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let col = i % columns;
            if col == 0 && i > 0 {
                y += height + 32.0;
                height = 0.0;
            }
            height = height.max(s.1);
            (widths[..col].iter().map(|w| w + 32.0).sum(), y)
        })
        .collect()
}
