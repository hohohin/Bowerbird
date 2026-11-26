//! Validation of the versioned workflow document. Saving retains the original JSON.
use std::collections::{HashMap, HashSet, VecDeque};

use serde::de::value::{Error as ValueError, MapDeserializer};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};

use super::invalid;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum WorkflowKind {
    Director3d,
    Instruction,
    Generation,
    Skill,
    Agent,
    ComfyVideo,
    Voice,
    VisualProfile,
    Text,
    Trigger,
    Planner,
    Loop,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum WorkflowAction {
    Describe,
    Reuse,
    Layers,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum OutputKind {
    Text,
    Image,
    VisualProfile,
    Session,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum RunStatus {
    Running,
    Waiting,
    Done,
    Failed,
    Stopped,
}

enum DataBinding<'a> {
    Dimension {
        asset: &'a str,
        dimension: &'a Value,
    },
    Group {
        asset_ids: &'a [Value],
    },
    Asset(&'a str),
    CanvasCell {
        target: &'a str,
        cell: &'a str,
    },
    Workflow {
        producer: &'a str,
        port: &'a str,
    },
}

impl<'a> DataBinding<'a> {
    fn read(raw: &'a Value) -> Option<Self> {
        Some(if let Some(dimension) = raw.get("dimension") {
            Self::Dimension {
                asset: raw["assetId"].as_str().filter(|id| !id.is_empty())?,
                dimension,
            }
        } else if raw["groupId"].is_string() {
            Self::Group {
                asset_ids: raw["assetIds"].as_array()?,
            }
        } else if let Some(asset) = raw["assetId"].as_str() {
            Self::Asset(asset)
        } else if let Some(target) = raw["canvasNodeId"].as_str() {
            Self::CanvasCell {
                target,
                cell: raw["cellId"].as_str()?,
            }
        } else {
            Self::Workflow {
                producer: raw["nodeId"].as_str()?,
                port: raw["portId"].as_str()?,
            }
        })
    }
}

fn value_error(path: &str, owner: &str, field: &str) -> AppError {
    let separator = if field.is_empty() { "" } else { "." };
    AppError::Other(format!(
        "工作流数据无效（{owner}，{path}{separator}{field}）"
    ))
}

fn field<'a, T: Deserialize<'a>>(
    raw: &'a Value,
    key: &str,
    path: &str,
    owner: &str,
) -> AppResult<T> {
    T::deserialize(&raw[key]).map_err(|_| value_error(path, owner, key))
}

struct WorkflowNode<'a> {
    id: &'a str,
    kind: WorkflowKind,
    data: &'a Value,
    inputs: &'a Map<String, Value>,
    outputs: &'a Map<String, Value>,
    path: String,
}

impl<'a> WorkflowNode<'a> {
    fn read(raw: &'a Value, index: usize) -> AppResult<Self> {
        let path = format!("nodes[{index}]");
        let id = raw["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| value_error(&path, "节点", "id"))?;
        let kind_name = raw["kind"]
            .as_str()
            .ok_or_else(|| value_error(&path, id, "kind"))?;
        let tag = MapDeserializer::<_, ValueError>::new([("kind", kind_name)].into_iter());
        let kind = WorkflowKind::deserialize(tag).map_err(|_| value_error(&path, id, "kind"))?;
        let _: WorkflowAction = field(raw, "action", &path, id)?;
        let _: f64 = field(raw, "x", &path, id)?;
        let _: f64 = field(raw, "y", &path, id)?;
        let _: &str = field(raw, "prompt", &path, id)?;
        let _: &str = field(raw, "provider", &path, id)?;
        let _: bool = field(raw, "trigger", &path, id)?;
        if !raw["outputPorts"].is_array() {
            return Err(value_error(&path, id, "outputPorts"));
        }
        let inputs = raw["inputs"]
            .as_object()
            .ok_or_else(|| value_error(&path, id, "inputs"))?;
        let outputs = raw["outputs"]
            .as_object()
            .ok_or_else(|| value_error(&path, id, "outputs"))?;
        Ok(Self {
            id,
            kind,
            data: raw,
            inputs,
            outputs,
            path,
        })
    }

    fn error(&self, field: &str) -> AppError {
        value_error(&self.path, self.id, field)
    }
}

fn check_data_dependencies(
    nodes: &[WorkflowNode<'_>],
    index: &HashMap<&str, usize>,
    dependencies: &[Vec<&str>],
) -> AppResult<()> {
    let mut outgoing = vec![Vec::new(); nodes.len()];
    let mut indegree: Vec<_> = dependencies.iter().map(Vec::len).collect();
    for (target, sources) in dependencies.iter().enumerate() {
        for id in sources {
            let source = *index.get(id).ok_or_else(|| nodes[target].error("inputs"))?;
            outgoing[source].push(target);
        }
    }
    let mut ready: VecDeque<_> = indegree
        .iter()
        .enumerate()
        .filter_map(|(index, degree)| (*degree == 0).then_some(index))
        .collect();
    while let Some(source) = ready.pop_front() {
        for &target in &outgoing[source] {
            indegree[target] -= 1;
            if indegree[target] == 0 {
                ready.push_back(target);
            }
        }
    }
    if let Some(mut current) = indegree.iter().position(|degree| *degree > 0) {
        let mut seen = HashSet::new();
        while seen.insert(current) {
            let Some(next) = dependencies[current]
                .iter()
                .filter_map(|id| index.get(id).copied())
                .find(|&source| indegree[source] > 0)
            else {
                break;
            };
            current = next;
        }
        let node = &nodes[current];
        return Err(AppError::Other(format!(
            "工作流包含循环（{}，{}.inputs）",
            node.id, node.path
        )));
    }
    Ok(())
}

fn validate_binding_metadata(binding: &Value) -> AppResult<()> {
    if binding
        .get("autoConnect")
        .is_some_and(|id| id.as_str().is_none_or(str::is_empty))
    {
        return Err(invalid());
    }
    if let Some(filter) = binding.get("mediaFilter") {
        let media = filter
            .as_array()
            .filter(|items| !items.is_empty() && items.len() <= 3)
            .ok_or_else(invalid)?;
        let mut seen = HashSet::new();
        for kind in media {
            let kind = kind
                .as_str()
                .filter(|kind| matches!(*kind, "image" | "video" | "audio"))
                .ok_or_else(invalid)?;
            if !seen.insert(kind) {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

fn control_binding_fields(binding: &Value, fields: &[&str]) -> bool {
    binding.as_object().is_some_and(|value| {
        value
            .keys()
            .all(|key| key == "autoConnect" || fields.contains(&key.as_str()))
    })
}

fn h3_r2v_port(port: &str) -> Option<(&'static str, usize)> {
    match port {
        "reference-image" => Some(("image", 9)),
        "reference-video" => Some(("video", 3)),
        "r2v-audio" => Some(("audio", 3)),
        _ => None,
    }
}

fn workflow_produces_video(node: &WorkflowNode<'_>) -> bool {
    matches!(
        node.kind,
        WorkflowKind::ComfyVideo | WorkflowKind::Director3d
    ) || node.kind == WorkflowKind::Generation && node.data["generation"]["media"] == "video"
        || node.kind == WorkflowKind::Agent && node.data["skill"] == "hyperframes"
}

fn video_audio_receiver(node: &WorkflowNode<'_>, port: &str, parked: bool) -> bool {
    let data = node.data;
    if parked {
        return node.kind == WorkflowKind::Generation
            && data["generation"]["media"] == "video"
            && matches!(port, "reference-audio" | "r2v-audio");
    }
    if node.kind == WorkflowKind::ComfyVideo {
        // Inactive H3 sockets survive mode changes.
        return matches!(port, "reference-audio" | "r2v-audio");
    }
    if port != "image" {
        return false;
    }
    let options = &data["generation"]["videoOptions"];
    node.kind == WorkflowKind::Voice
        || node.kind == WorkflowKind::Agent
            && data["skill"] == "hyperframes"
            && data["agentTransport"] == "codex-cli"
        || node.kind == WorkflowKind::Generation
            && data["generation"]["media"] == "video"
            && options["kind"] != "frames2video"
            && options["model_version"]
                .as_str()
                .is_none_or(|model| model.is_empty() || model.starts_with("seedance2"))
}

fn validate_video_audio_binding(
    binding: &Value,
    audio: &Value,
    accepts_audio: bool,
    producer: Option<&WorkflowNode<'_>>,
    assets: &mut HashSet<String>,
) -> AppResult<()> {
    if !accepts_audio
        || [
            "videoFrame",
            "groupId",
            "assetIds",
            "canvasNodeId",
            "cellId",
            "dimension",
        ]
        .iter()
        .any(|key| binding.get(*key).is_some())
        || binding["mediaFilter"]
            .as_array()
            .is_some_and(|types| !types.iter().any(|kind| kind == "audio"))
    {
        return Err(invalid());
    }
    let audio = audio
        .as_object()
        .filter(|audio| audio.keys().all(|key| key == "assetId"))
        .ok_or_else(invalid)?;
    if binding.get("nodeId").is_some() {
        if !producer.is_some_and(workflow_produces_video)
            || binding["portId"] != "image"
            || !audio.is_empty()
            || binding.get("assetId").is_some()
            || binding.get("assetNodeId").is_some()
        {
            return Err(invalid());
        }
    } else {
        let asset = audio
            .get("assetId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(invalid)?;
        if binding.get("portId").is_some()
            || binding["assetId"]
                .as_str()
                .is_none_or(|id| id.is_empty() || id == asset)
        {
            return Err(invalid());
        }
        assets.insert(asset.to_owned());
    }
    Ok(())
}

fn validate_image_output(value: &Value, assets: &mut HashSet<String>) -> AppResult<()> {
    // An asynchronous image output may contain only exact generation-session references.
    if value.get("assetIds").is_none() && value.get("nodeIds").is_none() {
        return Err(invalid());
    }
    if let Some(ids) = value.get("nodeIds") {
        if ids
            .as_array()
            .is_none_or(|ids| ids.iter().any(|id| id.as_str().is_none_or(str::is_empty)))
        {
            return Err(invalid());
        }
    }
    if let Some(ids) = value.get("assetIds") {
        for asset in ids.as_array().ok_or_else(invalid)? {
            assets.insert(asset.as_str().ok_or_else(invalid)?.to_owned());
        }
    }
    Ok(())
}

fn validate_output(value: &Value, assets: &mut HashSet<String>) -> AppResult<()> {
    match OutputKind::deserialize(&value["type"]).map_err(|_| invalid())? {
        OutputKind::Session
            if value["nodeIds"].as_array().is_some_and(|ids| ids.iter().all(Value::is_string)) => {}
        OutputKind::Image => validate_image_output(value, assets)?,
        OutputKind::Text if value["text"].is_string() => {
            if let Some(ids) = value.get("assetIds") {
                for asset in ids.as_array().ok_or_else(invalid)? {
                    assets.insert(asset.as_str().filter(|id| !id.is_empty()).ok_or_else(invalid)?.to_owned());
                }
            }
        }
        OutputKind::VisualProfile
            if value["profileId"].as_str().is_some_and(|id| !id.is_empty())
                && value["version"].as_i64().is_some_and(|v| v > 0) => {}
        _ => return Err(invalid()),
    }
    Ok(())
}

fn validate_loop(run: &Value, nodes: &[Value], assets: &mut HashSet<String>) -> AppResult<()> {
    let Some(state) = run.get("loop") else {
        return Ok(());
    };
    let owner = state["nodeId"].as_str().ok_or_else(invalid)?;
    if !nodes
        .iter()
        .any(|node| node["id"] == owner && node["kind"] == "loop")
    {
        return Err(invalid());
    }
    let order = run["order"].as_array().ok_or_else(invalid)?;
    if !order.contains(&json!(owner)) {
        return Err(invalid());
    }
    let body = state["bodyIds"]
        .as_array()
        .filter(|body| !body.is_empty())
        .ok_or_else(invalid)?;
    let mut ids = HashSet::new();
    for id in body {
        let key = id.as_str().ok_or_else(invalid)?;
        if key == owner || !order.contains(id) || !ids.insert(key) {
            return Err(invalid());
        }
    }
    let index = state["index"].as_u64().ok_or_else(invalid)? as usize;
    let start_index = match state.get("startIndex") {
        Some(value) => value
            .as_u64()
            .filter(|index| *index < 100)
            .ok_or_else(invalid)? as usize,
        None => 0,
    };
    let completed = state["completed"].as_array().ok_or_else(invalid)?;
    if let Some(items) = state.get("items") {
        let items = items
            .as_array()
            .filter(|items| !items.is_empty() && items.len() <= 100)
            .ok_or_else(invalid)?;
        let processed = start_index + completed.len();
        if start_index >= items.len()
            || index >= items.len()
            || !(processed == index || processed == items.len() && index + 1 == items.len())
        {
            return Err(invalid());
        }
        if run["status"] == "done" && processed != items.len() {
            return Err(invalid());
        }
        for item in items {
            if !item["text"].is_string() {
                return Err(invalid());
            }
            for asset in item["assetIds"].as_array().ok_or_else(invalid)? {
                assets.insert(
                    asset
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(invalid)?
                        .to_owned(),
                );
            }
        }
    } else if index != start_index || !completed.is_empty() || run["status"] == "done" {
        return Err(invalid());
    }
    for item in completed {
        let outputs = item["outputs"].as_object().ok_or_else(invalid)?;
        let steps = item["steps"].as_object().ok_or_else(invalid)?;
        if outputs.len() != ids.len()
            || steps.len() != ids.len()
            || outputs.keys().any(|id| !ids.contains(id.as_str()))
            || steps
                .iter()
                .any(|(id, step)| !ids.contains(id.as_str()) || step["status"] != "done")
        {
            return Err(invalid());
        }
        for ports in outputs.values() {
            for value in ports.as_object().ok_or_else(invalid)?.values() {
                if !matches!(
                    value["type"].as_str(),
                    Some("text" | "image" | "visual-profile" | "session")
                ) {
                    return Err(invalid());
                }
                if value["type"] == "image" {
                    validate_image_output(value, assets)?;
                } else if let Some(list) = value.get("assetIds") {
                    for asset in list.as_array().ok_or_else(invalid)? {
                        assets.insert(
                            asset
                                .as_str()
                                .filter(|id| !id.is_empty())
                                .ok_or_else(invalid)?
                                .to_owned(),
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn validate(document: &Value) -> AppResult<HashSet<String>> {
    // Local history includes frozen inputs and results from multiple runs. Its
    // cumulative size is not a per-request limit; validate the graph below.
    if document["schema_version"] != 1 {
        return Err(value_error("schema_version", "工作流", ""));
    }
    let nodes = document["nodes"]
        .as_array()
        .filter(|nodes| nodes.len() <= 500)
        .ok_or_else(|| value_error("nodes", "工作流", ""))?;
    let definitions = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| WorkflowNode::read(node, index))
        .collect::<AppResult<Vec<_>>>()?;
    let mut index = HashMap::with_capacity(definitions.len());
    for (position, node) in definitions.iter().enumerate() {
        if index.insert(node.id, position).is_some() {
            return Err(node.error("id"));
        }
    }
    let mut text_writers = HashMap::<&str, Vec<&str>>::new();
    let mut cell_writers = HashMap::<(&str, &str), &str>::new();
    let mut result_writers = HashMap::<&str, &str>::new();
    for definition in &definitions {
        if definition.kind == WorkflowKind::Text {
            let target = &definition.data["textTarget"];
            if let Some(target_id) = target["nodeId"].as_str() {
                text_writers
                    .entry(target_id)
                    .or_default()
                    .push(definition.id);
                for cell in target["cellId"].as_str().into_iter().chain(
                    target["cellIds"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str),
                ) {
                    cell_writers
                        .entry((target_id, cell))
                        .or_insert(definition.id);
                }
            }
        }
        for result in definition.data["resultNodeIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            result_writers.entry(result).or_insert(definition.id);
        }
    }
    let mut assets = HashSet::new();
    let mut dependencies = Vec::with_capacity(definitions.len());
    for current in &definitions {
        let node = current.data;
        let invalid = || current.error("inputs");
        let inputs = current.inputs;
        if current.kind == WorkflowKind::Planner
            && (node["trigger"] != false
                || inputs.keys().any(|key| key != "text" && key != "image")
                || !current.outputs.is_empty()
                || node["outputPorts"]
                    .as_array()
                    .is_none_or(|ports| !ports.is_empty()))
        {
            return Err(invalid());
        }
        if current.kind == WorkflowKind::Trigger && inputs.keys().any(|key| key != "completion") {
            return Err(invalid());
        }
        if node.get("triggerCount").is_some_and(|count| {
            current.kind != WorkflowKind::Trigger || count.as_u64().is_none_or(|count| count > 9999)
        }) {
            return Err(current.error("triggerCount"));
        }
        if node.get("triggerMode").is_some_and(|mode| {
            current.kind != WorkflowKind::Trigger
                || !matches!(
                    mode.as_str(),
                    Some("manual" | "daily" | "once" | "completion")
                )
        }) {
            return Err(current.error("triggerMode"));
        }
        if let Some(schedule) = node.get("triggerSchedule") {
            let invalid = || current.error("triggerSchedule");
            if current.kind != WorkflowKind::Trigger
                || schedule["id"].as_str().is_none_or(str::is_empty)
                || schedule["at"]
                    .as_u64()
                    .is_none_or(|at| at == 0 || at > 8_640_000_000_000_000)
                || !matches!(
                    schedule["status"].as_str(),
                    Some("armed" | "fired" | "missed" | "failed")
                )
            {
                return Err(invalid());
            }
            if let Some(time) = schedule.get("dailyAt") {
                let invalid = || current.error("triggerSchedule.dailyAt");
                let time = time.as_str().ok_or_else(invalid)?.as_bytes();
                if time.len() != 5
                    || time[2] != b':'
                    || ![time[0], time[1], time[3], time[4]]
                        .iter()
                        .all(u8::is_ascii_digit)
                    || &time[..2] > b"23".as_slice()
                    || &time[3..] > b"59".as_slice()
                    || schedule["status"] != "armed"
                {
                    return Err(invalid());
                }
            }
        }
        if let Some(seen) = node.get("completionSeen") {
            let invalid = || current.error("completionSeen");
            if current.kind != WorkflowKind::Trigger {
                return Err(invalid());
            }
            let mut unique = HashSet::new();
            for session in seen.as_array().ok_or_else(invalid)? {
                if !unique.insert(
                    session
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(invalid)?,
                ) {
                    return Err(invalid());
                }
            }
        }
        if current.kind == WorkflowKind::Loop {
            if node
                .get("loopMode")
                .is_some_and(|mode| !matches!(mode.as_str(), Some("images" | "rows" | "count")))
            {
                return Err(current.error("loopMode"));
            }
            if node
                .get("loopStartItem")
                .is_some_and(|value| value.as_u64().is_none_or(|item| !(1..=100).contains(&item)))
            {
                return Err(current.error("loopStartItem"));
            }
            if node["loopMode"] == "count" {
                if node["loopCount"]
                    .as_u64()
                    .is_none_or(|count| !(1..=100).contains(&count))
                {
                    return Err(current.error("loopCount"));
                }
            } else if node.get("loopCount").is_some() {
                return Err(current.error("loopCount"));
            }
            let port = if node["loopMode"] == "count" {
                "signal"
            } else if node["loopMode"] == "rows" {
                "text"
            } else {
                "image"
            };
            if inputs.keys().any(|key| key != port && key != "signal") {
                return Err(invalid());
            }
        }
        if current.kind == WorkflowKind::Text && node["textSource"].is_string() {
            if node["textSource"].as_str().is_none_or(str::is_empty)
                || inputs.keys().any(|key| key != "signal")
                || node.get("textTarget").is_some()
            {
                return Err(current.error("textSource"));
            }
            if nodes
                .iter()
                .any(|other| other["id"] != node["id"] && other["textSource"] == node["textSource"])
            {
                return Err(invalid());
            }
        } else if current.kind == WorkflowKind::Text {
            let invalid = || current.error("textTarget");
            if node["textTarget"]["nodeId"]
                .as_str()
                .is_none_or(str::is_empty)
                || node["textTarget"]["cellId"]
                    .as_str()
                    .is_none_or(str::is_empty)
                || inputs
                    .values()
                    .filter_map(Value::as_array)
                    .map(Vec::len)
                    .sum::<usize>()
                    != 1
                || inputs.keys().any(|key| key != "text" && key != "image")
            {
                return Err(invalid());
            }
            if nodes.iter().any(|other| {
                other["id"] != node["id"]
                    && other["kind"] == "text"
                    && other["textTarget"]["nodeId"] == node["textTarget"]["nodeId"]
                    && other["textTarget"]["cellId"] == node["textTarget"]["cellId"]
            }) {
                return Err(invalid());
            }
            if let Some(axis) = node["textTarget"].get("appendAxis") {
                if !matches!(axis.as_str(), Some("row" | "column"))
                    || node["textTarget"]["append"] != true
                {
                    return Err(invalid());
                }
                let cells = node["textTarget"]["axisCellIds"]
                    .as_array()
                    .filter(|cells| !cells.is_empty())
                    .ok_or_else(invalid)?;
                let mut unique = HashSet::new();
                for cell in cells {
                    let id = cell
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(invalid)?;
                    if !unique.insert(id) {
                        return Err(invalid());
                    }
                }
                if node["textTarget"]
                    .get("axisOffset")
                    .is_some_and(|offset| offset.as_u64().is_none())
                {
                    return Err(current.error("textTarget.axisOffset"));
                }
            }
            if let Some(value) = node["textTarget"].get("cellIds") {
                let cells = value.as_array().ok_or_else(invalid)?;
                let mut unique = HashSet::new();
                for cell in cells {
                    let id = cell
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(invalid)?;
                    if !unique.insert(id)
                        || nodes.iter().any(|other| {
                            other["id"] != node["id"]
                                && other["textTarget"]["nodeId"] == node["textTarget"]["nodeId"]
                                && (other["textTarget"]["cellId"] == *cell
                                    || other["textTarget"]["cellIds"]
                                        .as_array()
                                        .is_some_and(|ids| ids.contains(cell)))
                        })
                    {
                        return Err(invalid());
                    }
                }
            }
        }
        let parked_r2v = node
            .get("savedComfyR2V")
            .map(|parked| {
                let invalid = || current.error("savedComfyR2V");
                if current.kind != WorkflowKind::Generation
                    || node["generation"]["media"] != "video"
                {
                    return Err(invalid());
                }
                parked
                    .as_object()
                    .filter(|inputs| inputs.keys().all(|port| h3_r2v_port(port).is_some()))
                    .ok_or_else(invalid)
            })
            .transpose()?;
        let find_producer = |binding: &Value| {
            binding["nodeId"]
                .as_str()
                .and_then(|id| index.get(id))
                .map(|&position| &definitions[position])
        };
        for (position, binding) in node["savedComfyAudio"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            if let Some(audio) = binding.get("videoAudio") {
                let invalid = || current.error(&format!("savedComfyAudio[{position}]"));
                validate_binding_metadata(binding).map_err(|_| invalid())?;
                validate_video_audio_binding(
                    binding,
                    audio,
                    video_audio_receiver(current, "reference-audio", true),
                    find_producer(binding),
                    &mut assets,
                )
                .map_err(|_| invalid())?;
                if let Some(original) = binding["assetId"].as_str() {
                    assets.insert(original.to_owned());
                }
            }
        }
        let mut deps = Vec::new();
        for (port, bindings, parked) in inputs
            .iter()
            .map(|(port, value)| (port, value, false))
            .chain(
                parked_r2v
                    .into_iter()
                    .flatten()
                    .map(|(port, value)| (port, value, true)),
            )
        {
            let collection = if parked { "savedComfyR2V" } else { "inputs" };
            let port_path = || format!("{collection}.{port}");
            let invalid = || current.error(&port_path());
            if port == "completion" {
                if current.kind != WorkflowKind::Trigger {
                    return Err(invalid());
                }
                for (position, binding) in
                    bindings.as_array().ok_or_else(invalid)?.iter().enumerate()
                {
                    let invalid = || current.error(&format!("{}[{position}]", port_path()));
                    validate_binding_metadata(binding).map_err(|_| invalid())?;
                    if binding.get("canvasNodeId").is_some() {
                        if binding["canvasNodeId"].as_str().is_none_or(str::is_empty)
                            || binding["cellId"] != "image"
                            || !control_binding_fields(binding, &["canvasNodeId", "cellId"])
                        {
                            return Err(invalid());
                        }
                        continue;
                    }
                    let producer = binding["nodeId"]
                        .as_str()
                        .and_then(|id| index.get(id))
                        .map(|&i| &definitions[i])
                        .ok_or_else(invalid)?;
                    if matches!(producer.kind, WorkflowKind::Trigger | WorkflowKind::Planner)
                        || producer.data.get("textSource").is_some()
                        || !matches!(
                            binding["portId"].as_str(),
                            Some("text" | "image" | "visual-profile" | "iteration")
                        )
                        || !control_binding_fields(
                            binding,
                            &["nodeId", "portId", "pendingCompletionSession"],
                        )
                    {
                        return Err(invalid());
                    }
                    if binding
                        .get("pendingCompletionSession")
                        .is_some_and(|session| {
                            session.as_str().is_none_or(str::is_empty)
                                || binding["portId"] != "image"
                                || !matches!(
                                    producer.kind,
                                    WorkflowKind::Generation | WorkflowKind::ComfyVideo
                                )
                        })
                    {
                        return Err(invalid());
                    }
                }
                continue; // Completion events do not participate in the data dependency DAG.
            }
            let local_video = current.kind == WorkflowKind::ComfyVideo;
            let r2v = local_video && node["comfyVideo"]["mode"] == "r2v";
            let legacy_frames =
                local_video && matches!(port.as_str(), "first-frame" | "last-frame");
            let legacy_audio = local_video && port == "reference-audio";
            let r2v_port = (local_video || parked).then(|| h3_r2v_port(port)).flatten();
            let typed_port = r2v_port.or_else(|| legacy_audio.then_some(("audio", 1)));
            let image_port = port == "image" || typed_port.is_some() || legacy_frames;
            let inactive =
                parked || r2v_port.is_some() && !r2v || r2v && (legacy_audio || legacy_frames);
            if !image_port && !matches!(port.as_str(), "text" | "visual-profile" | "signal") {
                return Err(invalid());
            }
            let bindings = bindings.as_array().ok_or_else(invalid)?;
            if typed_port.is_some_and(|(_, limit)| bindings.len() > limit) {
                return Err(invalid());
            }
            for (position, binding) in bindings.iter().enumerate() {
                let invalid = || current.error(&format!("{}[{position}]", port_path()));
                validate_binding_metadata(binding).map_err(|_| invalid())?;
                if typed_port.is_some_and(|(media, _)| {
                    media != "image" && binding.get("videoFrame").is_some()
                        || binding.get("mediaFilter").is_some_and(|filter| {
                            filter
                                .as_array()
                                .is_none_or(|types| types.len() != 1 || types[0] != media)
                        })
                        || binding.get("portId").is_some_and(|port| port != "image")
                }) {
                    return Err(invalid());
                }
                if port == "signal" {
                    let producer = binding["nodeId"]
                        .as_str()
                        .and_then(|id| index.get(id))
                        .map(|&i| &definitions[i])
                        .ok_or_else(invalid)?;
                    if producer.kind != WorkflowKind::Trigger
                        || binding["portId"] != "signal"
                        || !control_binding_fields(binding, &["nodeId", "portId"])
                    {
                        return Err(invalid());
                    }
                    deps.push(producer.id);
                    continue;
                }
                if binding["portId"] == "signal" {
                    return Err(invalid());
                }
                if let Some(audio) = binding.get("videoAudio") {
                    validate_video_audio_binding(
                        binding,
                        audio,
                        video_audio_receiver(current, port, parked),
                        find_producer(binding),
                        &mut assets,
                    )
                    .map_err(|_| invalid())?;
                }
                if let Some(frame) = binding.get("videoFrame") {
                    if !image_port
                        || !matches!(frame["position"].as_str(), Some("first" | "last"))
                        || ["groupId", "assetIds", "canvasNodeId", "cellId", "dimension"]
                            .iter()
                            .any(|key| binding.get(*key).is_some())
                    {
                        return Err(invalid());
                    }
                    if binding.get("nodeId").is_some() {
                        // Generated videos use the legacy "image" output socket, even before a file exists.
                        let producer = find_producer(binding).ok_or_else(invalid)?;
                        // The generic image transport can also carry audio. Only persist a frame for an image receiver.
                        let accepts_frame = legacy_frames
                            || matches!(r2v_port, Some(("image", _)))
                            || port == "image"
                                && !local_video
                                && current.kind != WorkflowKind::Voice
                                && !node["textSource"].is_string()
                                && (current.kind != WorkflowKind::Text
                                    || node["textTarget"]["image"] == true);
                        if !workflow_produces_video(producer)
                            || !accepts_frame
                            || binding["portId"] != "image"
                            || frame.get("assetId").is_some()
                            || binding.get("assetId").is_some()
                            || binding.get("assetNodeId").is_some()
                            || binding["mediaFilter"]
                                .as_array()
                                .is_some_and(|types| !types.iter().any(|kind| kind == "image"))
                        {
                            return Err(invalid());
                        }
                    } else {
                        let frame_asset = frame["assetId"]
                            .as_str()
                            .filter(|id| !id.is_empty())
                            .ok_or_else(invalid)?;
                        if binding.get("portId").is_some()
                            || binding["assetId"]
                                .as_str()
                                .is_none_or(|id| id.is_empty() || id == frame_asset)
                        {
                            return Err(invalid());
                        }
                        assets.insert(frame_asset.to_owned());
                    }
                }
                match DataBinding::read(binding).ok_or_else(invalid)? {
                    DataBinding::Dimension { asset, dimension } => {
                        if port != "text"
                            || !dimension["title"].is_string()
                            || !dimension["body"].is_string()
                            || !(dimension["id"].is_null() || dimension["id"].is_string())
                            || [
                                "nodeId",
                                "portId",
                                "groupId",
                                "assetIds",
                                "canvasNodeId",
                                "cellId",
                            ]
                            .iter()
                            .any(|key| binding.get(*key).is_some())
                        {
                            return Err(invalid());
                        }
                        assets.insert(asset.to_owned());
                    }
                    DataBinding::Group { asset_ids } => {
                        if !image_port
                            || binding.get("nodeId").is_some()
                            || binding.get("assetId").is_some()
                            || binding.get("canvasNodeId").is_some()
                        {
                            return Err(invalid());
                        }
                        for asset in asset_ids {
                            assets.insert(
                                asset
                                    .as_str()
                                    .filter(|id| !id.is_empty())
                                    .ok_or_else(invalid)?
                                    .to_owned(),
                            );
                        }
                    }
                    DataBinding::Asset(asset) => {
                        if !image_port || binding.get("nodeId").is_some() {
                            return Err(invalid());
                        }
                        assets.insert(asset.to_owned());
                    }
                    DataBinding::CanvasCell { target, cell } => {
                        if (port != "text" && !image_port) || binding.get("nodeId").is_some() {
                            return Err(invalid());
                        }
                        if matches!(cell, "*" | "*text" | "*latest" | "*latest-image") {
                            if (matches!(cell, "*" | "*latest-image") && !image_port)
                                || (matches!(cell, "*text" | "*latest") && port != "text")
                            {
                                return Err(invalid());
                            }
                            if !inactive {
                                deps.extend(
                                    text_writers.get(target).into_iter().flatten().copied(),
                                );
                            }
                        }
                        if !inactive {
                            deps.extend(
                                cell_writers
                                    .get(&(target, cell))
                                    .or_else(|| result_writers.get(target))
                                    .copied(),
                            );
                        }
                    }
                    DataBinding::Workflow {
                        producer,
                        port: output,
                    } => {
                        let source = index.get(producer).map(|&i| &definitions[i]);
                        if output == "signal"
                            || source.is_some_and(|source| source.kind == WorkflowKind::Planner)
                            || !inactive && source.is_none()
                        {
                            return Err(invalid());
                        }
                        if !inactive {
                            deps.push(producer);
                        }
                    }
                }
            }
        }
        dependencies.push(deps);
        for (port, value) in current.outputs {
            validate_output(value, &mut assets)
                .map_err(|_| current.error(&format!("outputs.{port}")))?;
        }
    }
    check_data_dependencies(&definitions, &index, &dependencies)?;
    let runs = match document.get("runs") {
        Some(value) => value
            .as_array()
            .ok_or_else(|| value_error("runs", "工作流", ""))?
            .iter()
            .collect::<Vec<_>>(),
        None => {
            if document["run"].is_null() {
                vec![]
            } else {
                vec![&document["run"]]
            }
        }
    };
    let mut run_ids = HashSet::new();
    let mut schedule_ids = HashSet::new();
    let mut accesses: Vec<(HashSet<&str>, HashSet<&str>)> = Vec::new();
    let kind_of = |id: &Value| {
        id.as_str()
            .and_then(|id| index.get(id))
            .map(|&i| definitions[i].kind)
    };
    let triggers: HashSet<&str> = definitions
        .iter()
        .filter(|node| node.kind == WorkflowKind::Trigger)
        .map(|node| node.id)
        .collect();
    let root = if document.get("runs").is_some() {
        "runs"
    } else {
        "run"
    };
    for (position, run) in runs.into_iter().enumerate() {
        let path = if root == "runs" {
            format!("{root}[{position}]")
        } else {
            root.to_owned()
        };
        let id = run["id"]
            .as_str()
            .ok_or_else(|| value_error(&path, "运行", "id"))?;
        let invalid = || value_error(&path, id, "");
        let status: RunStatus = field(run, "status", &path, id)?;
        if let Some(schedule) = run.get("scheduleId") {
            let invalid = || value_error(&path, id, "scheduleId");
            if !schedule_ids.insert(
                schedule
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(invalid)?,
            ) || kind_of(&run["startId"]) != Some(WorkflowKind::Trigger)
            {
                return Err(invalid());
            }
        }
        if let Some(queue) = run.get("triggerQueue") {
            let invalid = || value_error(&path, id, "triggerQueue");
            for id in queue.as_array().ok_or_else(invalid)? {
                if kind_of(id) != Some(WorkflowKind::Trigger) {
                    return Err(invalid());
                }
            }
        }
        validate_loop(run, nodes, &mut assets).map_err(|_| value_error(&path, id, "loop"))?;
        let _: &str = field(run, "threadId", &path, id)?;
        if !run["steps"].is_object() {
            return Err(value_error(&path, id, "steps"));
        }
        let order: Vec<&str> = field(run, "order", &path, id)?;
        if order.iter().any(|id| {
            index
                .get(id)
                .is_none_or(|&i| definitions[i].kind == WorkflowKind::Planner)
        }) {
            return Err(value_error(&path, id, "order"));
        }
        if !run_ids.insert(id) {
            return Err(value_error(&path, id, "id"));
        }
        if matches!(status, RunStatus::Running | RunStatus::Waiting) {
            let locked = run
                .get("lockedNodeIds")
                .unwrap_or(&run["order"])
                .as_array()
                .ok_or_else(invalid)?;
            let mut reads_and_writes = HashSet::new();
            for locked_id in locked {
                let invalid = || value_error(&path, id, "lockedNodeIds");
                let id = locked_id.as_str().ok_or_else(invalid)?;
                if !index.contains_key(id) || !reads_and_writes.insert(id) {
                    return Err(invalid());
                }
            }
            let mut writes = HashSet::new();
            let invalid = || value_error(&path, id, "writeNodeIds");
            for id in run
                .get("writeNodeIds")
                .unwrap_or(&run["order"])
                .as_array()
                .ok_or_else(invalid)?
            {
                let id = id.as_str().ok_or_else(invalid)?;
                if !reads_and_writes.contains(id) || !writes.insert(id) {
                    return Err(invalid());
                }
            }
            if order.iter().any(|id| !writes.contains(id)) {
                return Err(invalid());
            }
            if let Some(snapshots) = run.get("inputOutputs") {
                let snapshot_error = || value_error(&path, id, "inputOutputs");
                // Frozen fallback outputs must not reattach removed project assets.
                let mut snapshot_assets = HashSet::new();
                for (node_id, outputs) in snapshots.as_object().ok_or_else(snapshot_error)? {
                    if !reads_and_writes.contains(node_id.as_str()) {
                        return Err(snapshot_error());
                    }
                    for (port, value) in outputs.as_object().ok_or_else(snapshot_error)? {
                        validate_output(value, &mut snapshot_assets).map_err(|_| {
                            value_error(&path, id, &format!("inputOutputs.{node_id}.{port}"))
                        })?;
                    }
                }
            }
            writes.retain(|id| !triggers.contains(id));
            reads_and_writes.retain(|id| !triggers.contains(id));
            if accesses.iter().any(|(other_access, other_writes)| {
                !writes.is_disjoint(other_access) || !other_writes.is_disjoint(&reads_and_writes)
            }) {
                return Err(invalid());
            }
            accesses.push((reads_and_writes, writes));
        } else if run.get("inputOutputs").is_some() {
            return Err(value_error(&path, id, "inputOutputs"));
        }
    }
    Ok(assets)
}
