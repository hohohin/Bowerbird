//! A user task owns one reference; paid attempts remain separate immutable records.
use super::*;
use std::collections::BTreeMap;

pub(super) fn require(root: &Path, id: &str, project: &str) -> AppResult<Value> {
    let value = own(root, id, project)?;
    if value["kind"] != "case" { return Err(error("不是复刻任务")); }
    Ok(value)
}
fn legacy_id(project: &str, reference: &str) -> String {
    format!("{:x}", Sha256::digest(format!("replication-case:{project}:{reference}")))[..32].into()
}
fn reference_id<'a>(records: &'a [Value], mut value: &'a Value) -> &'a str {
    // Older rewrite records only stored sourceAnalysisId; old generation may point to rewrite.
    for _ in 0..3 {
        if value["kind"] == "reference" { return field(value,"id"); }
        if !field(value,"referenceId").is_empty() { return field(value,"referenceId"); }
        if !field(&value["reference"],"id").is_empty() { return field(&value["reference"],"id"); }
        let source = if !field(value,"sourceAnalysisId").is_empty() { field(value,"sourceAnalysisId") } else { field(value,"sourceRewriteId") };
        match records.iter().find(|item| !source.is_empty() && field(item,"id") == source) { Some(parent) => value = parent, None => break }
    }
    ""
}
pub(super) fn list(root: &Path, project: &str) -> AppResult<Value> {
    let mut records = Vec::new();
    for entry in fs::read_dir(root)? {
        if let Some(id) = entry?.file_name().to_str() {
            if let Ok(value) = own(root, id, project) { records.push(value); }
        }
    }
    records.sort_by(|a,b| field(a,"createdAt").cmp(field(b,"createdAt")));
    let mut cases = BTreeMap::new();
    let mut owners = BTreeMap::new();
    for value in &records {
        if value["kind"] == "case" {
            if !field(value,"referenceId").is_empty() { owners.insert(field(value,"referenceId").to_owned(), field(value,"id").to_owned()); }
            cases.insert(field(value,"id").to_owned(), value.clone());
        }
    }
    for value in &records {
        if !field(value,"caseId").is_empty() {
            let reference = reference_id(&records,value);
            if !reference.is_empty() { owners.insert(reference.to_owned(), field(value,"caseId").to_owned()); }
        }
    }
    for value in &records {
        if value["kind"] == "case" { continue; }
        let reference = reference_id(&records,value);
        let id = if !field(value,"caseId").is_empty() { field(value,"caseId").to_owned() }
            else { owners.get(reference).cloned().unwrap_or_else(|| legacy_id(project, if reference.is_empty() { field(value,"id") } else { reference })) };
        let item = cases.entry(id.clone()).or_insert_with(|| json!({"id":id,"kind":"case","projectId":project,"title":value["title"].as_str().unwrap_or("视频复刻"),"createdAt":value["createdAt"],"updatedAt":value["updatedAt"],"step":1,"sourceMethod":"douyin","shareText":""}));
        if field(item,"referenceId").is_empty() && !reference.is_empty() { item["referenceId"] = json!(reference); }
        if value["kind"] == "douyin" {
            item["acquisition"] = value.clone();
            if field(item,"shareText").is_empty() { item["shareText"] = value["shareText"].clone(); }
        } else if value["operation"] == "analyze" { item["analysisJob"] = public(value.clone()); }
        else if value["operation"] == "rewrite" { item["rewriteJob"] = public(value.clone()); }
    }
    for item in cases.values_mut() {
        if let Ok(reference) = own(root, field(item,"referenceId"), project) {
            if reference["kind"] == "reference" {
                item["mediaPath"] = reference["path"].clone();
                item["reference"] = public(reference);
            }
        }
    }
    let mut values: Vec<Value> = cases.into_values().collect();
    values.sort_by(|a,b| field(b,"createdAt").cmp(field(a,"createdAt")));
    Ok(json!(values))
}
pub(super) fn update(root: &Path, project: &str, data: &Value) -> AppResult<Value> {
    let id = field(data,"id");
    let path = folder(root,id)?.join("record.json");
    let _guard = LOCK.lock().unwrap();
    let mut value = if path.exists() { require(root,id,project)? }
        else { json!({"id":id,"kind":"case","projectId":project,"createdAt":now()}) };
    for (key,max) in [("title",100),("shareText",8000),("analysisText",50000),("rewriteDirection",8000),("persona",8000),("rules",16000),("rewrittenText",50000),("firstFramePrompt",12000),("appliedAnalysisId",100),("appliedRewriteId",100),("workflowId",100)] {
        if let Some(text) = data.get(key) {
            if !text.is_string() || text.as_str().unwrap().chars().count() > max { return Err(error(&format!("{key} 格式或长度无效"))); }
            value[key] = text.clone();
        }
    }
    if let Some(step) = data.get("step") {
        if !matches!(step.as_u64(),Some(1..=4)) { return Err(error("任务步骤无效")); }
        value["step"] = step.clone();
    }
    if let Some(method) = data.get("sourceMethod") {
        if !["douyin","local","library"].contains(&method.as_str().unwrap_or("")) { return Err(error("获取途径无效")); }
        value["sourceMethod"] = method.clone();
    }
    if let Some(reference) = data.get("referenceId") {
        if !field(&value,"referenceId").is_empty() && value["referenceId"] != *reference { return Err(error("一个复刻任务只绑定一个视频，请新建任务")); }
        if !reference.is_null() {
            let record = own(root,reference.as_str().ok_or_else(|| error("参考视频无效"))?,project)?;
            if record["kind"] != "reference" { return Err(error("参考视频无效")); }
        }
        value["referenceId"] = reference.clone();
    }
    if data.get("frameReference").is_some() { value["frameReference"] = frame_reference(data)?; }
    value["updatedAt"] = json!(now());
    save(root,&value)?;
    Ok(value)
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn task_survives_before_video_and_groups_attempts_without_mutating_history() {
        let root=std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()); fs::create_dir_all(&root).unwrap();
        let id=uuid::Uuid::new_v4().simple().to_string();
        update(&root,"p",&json!({"id":id,"step":1,"shareText":"https://v.douyin.com/example/","sourceMethod":"douyin"})).unwrap();
        assert_eq!(list(&root,"p").unwrap()[0]["shareText"],"https://v.douyin.com/example/");
        assert!(update(&root,"other",&json!({"id":id,"title":"wrong"})).is_err());
        for operation in ["analyze","rewrite"] { save(&root,&json!({"id":uuid::Uuid::new_v4().simple().to_string(),"projectId":"p","caseId":id,"operation":operation,"state":"rewritten"})).unwrap(); }
        let result=list(&root,"p").unwrap(); assert_eq!(result.as_array().unwrap().len(),1); assert_eq!(result[0]["analysisJob"]["operation"],"analyze"); assert_eq!(result[0]["rewriteJob"]["operation"],"rewrite");
        assert!(update(&root,"p",&json!({"id":id,"referenceId":"../escape"})).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn completed_background_acquisition_and_legacy_jobs_keep_one_video_task() {
        let root=std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()); fs::create_dir_all(&root).unwrap();
        let case=uuid::Uuid::new_v4().simple().to_string();
        let reference=uuid::Uuid::new_v4().simple().to_string();
        update(&root,"p",&json!({"id":case,"shareText":"分享链接","step":1})).unwrap();
        save(&root,&json!({"id":reference,"projectId":"p","kind":"reference","path":"video.mp4","name":"视频"})).unwrap();
        save(&root,&json!({"id":uuid::Uuid::new_v4().simple().to_string(),"projectId":"p","caseId":case,"kind":"douyin","state":"ready","reference":{"id":reference}})).unwrap();
        let result=list(&root,"p").unwrap(); assert_eq!(result.as_array().unwrap().len(),1); assert_eq!(result[0]["referenceId"],reference); assert_eq!(result[0]["shareText"],"分享链接");
        update(&root,"p",&json!({"id":case,"referenceId":reference})).unwrap();
        assert!(update(&root,"p",&json!({"id":case,"referenceId":null})).is_err());
        assert!(list(&root,"other").unwrap().as_array().unwrap().is_empty());
        // Two old paid attempts using the same video do not become two visible tasks.
        let old_reference=uuid::Uuid::new_v4().simple().to_string();
        save(&root,&json!({"id":old_reference,"projectId":"p","kind":"reference","path":"old.mp4"})).unwrap();
        for operation in ["analyze","rewrite"] { save(&root,&json!({"id":uuid::Uuid::new_v4().simple().to_string(),"projectId":"p","referenceId":old_reference,"operation":operation})).unwrap(); }
        let analysis=uuid::Uuid::new_v4().simple().to_string();
        save(&root,&json!({"id":analysis,"projectId":"p","referenceId":old_reference,"operation":"analyze"})).unwrap();
        save(&root,&json!({"id":uuid::Uuid::new_v4().simple().to_string(),"projectId":"p","sourceAnalysisId":analysis,"operation":"rewrite"})).unwrap();
        assert_eq!(list(&root,"p").unwrap().as_array().unwrap().len(),2);
        fs::remove_dir_all(root).unwrap();
    }
}
