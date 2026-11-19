//! Native DSH question snapshots and answers scoped to the application's original turn.
use super::*;
use super::super::questions::QuestionBatch;
pub(crate) use super::super::questions::Answer;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

pub(in crate::commands::local_chat) struct QuestionTurn {
    host: Host,
    pending: Pending,
    pub(in crate::commands::local_chat) turn_id: String,
    pub(in crate::commands::local_chat) checkpoint: String,
}

impl QuestionTurn {
    #[cfg(test)]
    pub(super) fn fixture(host: Host, pending: Pending, turn_id: String) -> Self {
        let checkpoint = serde_json::to_string(&pending).unwrap();
        Self { host, pending, turn_id, checkpoint }
    }

    pub(in crate::commands::local_chat) async fn load(db: &Database, id: &str) -> AppResult<Option<Self>> {
        let Some((turn_id, checkpoint)) = db.local_chat_dsh_question_checkpoint(id)? else { return Ok(None); };
        let pending: Pending = serde_json::from_str(&checkpoint).map_err(|_| error("原本机 DSH 问答记录不完整"))?;
        if pending.version != 1 || !pending.questions_enabled || (pending.session != session_id(&turn_id)
            && db.local_chat_provider_thread(id)?.as_deref() != Some(pending.session.as_str()))
        {
            return Err(error("本机 DSH 问题与原对话不匹配"));
        }
        let config = dsh::recovery_connection(&checkpoint).await?;
        if pending.base != local_base(&config.base)? { return Err(error("请连接原本机 DSH 服务后回答")); }
        let host = Host::connect(&config.base, config.auth.as_deref()).await?;
        Ok(Some(Self { host, pending, turn_id, checkpoint }))
    }

    pub(in crate::commands::local_chat) async fn batches(&self) -> AppResult<Vec<QuestionBatch>> {
        let entries = self.host.events(&self.pending).await?;
        let reply = fold_history(&entries, &self.pending.rpc_id, self.pending.after)?;
        if reply.question_calls.is_empty() { return Ok(Vec::new()); }
        let (active, queued) = self.host.question_projection(&self.pending.session).await?;
        active.into_iter()
            .filter(|item| item["callId"].as_str().is_some_and(|call| reply.question_calls.contains(call)))
            .map(|mut item| {
                item["turnId"] = json!(self.turn_id);
                item["queued"] = json!(item["callId"].as_str().is_some_and(|id| queued.contains(id)));
                let batch: QuestionBatch = serde_json::from_value(item)
                    .map_err(|_| error("本机 DSH 返回的问题格式无法读取"))?;
                Ok(batch)
            }).collect()
    }

    pub(in crate::commands::local_chat) async fn validate(&self, call: &str, answers: &[Answer]) -> AppResult<()> {
        let batch = self.batches().await?.into_iter().find(|item| item.call_id == call)
            .ok_or_else(|| error("此问题已结束，请查看最新对话"))?;
        batch.validate_answers(answers)
    }

    pub(in crate::commands::local_chat) async fn answer(&self, call: &str, answers: &[Answer]) -> AppResult<()> {
        let answer = json!({"answers":answers});
        // The native method cold-restores the original Session and accepts continued calls.
        let queued = self.host.rpc("userQuestions/answer", json!({
            "agentId": self.pending.session, "callId": call, "answer": answer,
        })).await?;
        if queued == true { return Ok(()); }
        tokio::time::timeout(Duration::from_secs(8),
            self.host.answer_open_question(&self.pending.session, call, &answer))
            .await.map_err(|_| error("原问题暂未能接收答复，请查看当前待答状态"))?
    }

    pub(in crate::commands::local_chat) async fn reattach(
        self, app: AppHandle, db: Arc<Database>, id: String, call: String, answers: Vec<Answer>,
        cancel: watch::Receiver<bool>, received: tokio::sync::oneshot::Sender<AppResult<()>>,
    ) -> AppResult<&'static str> {
        let session = &self.pending.session;
        let gateway = Gateway::start(&app, &db, &id, &self.turn_id, session, cancel.clone()).await?;
        handshake_add(session, &gateway.endpoint, &gateway.token)?;
        // Even if the HTTP receipt is lost, observe the original request rather than resend.
        let result = if *cancel.borrow() { Err(error("任务已停止")) } else { self.answer(&call, &answers).await };
        let _ = received.send(result);
        let result = observe_live(&app, &db, &id, &self.turn_id, &self.host, &self.pending, &gateway, cancel).await;
        handshake_remove(session);
        result
    }
}

impl Host {
    async fn answer_open_question(&self, session: &str, call: &str, answer: &Value) -> AppResult<()> {
        let url = format!("{}/api/remote.mux", self.base.replacen("http://", "ws://", 1));
        let failure = || error("本机 DSH 原问题连接中断，请查看当前待答状态");
        let mut request = url.into_client_request().map_err(|_| failure())?;
        if let Some(cookie) = &self.cookie {
            request.headers_mut().insert("cookie", cookie.clone());
        }
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.map_err(|_| failure())?;
        socket.send(Message::Text(json!({"type":"open","streamId":"question","endpoint":"$events","payload":{"args":{}}}).to_string()))
            .await.map_err(|_| failure())?;
        let mut client = None;
        while let Some(message) = socket.next().await {
            let message = message.map_err(|_| failure())?;
            let Message::Text(text) = message else { continue; };
            let frame: Value = serde_json::from_str(&text).map_err(|_| failure())?;
            if frame["streamId"] != "question" { continue; }
            if frame["type"] == "error" || frame["type"] == "end" { return Err(failure()); }
            let event = &frame["value"];
            if event["type"] == "ready" {
                client = event["clientId"].as_str().map(str::to_owned);
                continue;
            }
            if event["event"] != "user-questions/request" || event["agentId"] != session
                || event["request"]["wait"]["callId"] != call
            {
                continue;
            }
            let client = client.as_deref().ok_or_else(failure)?;
            let event_id = event["eventId"].as_str().ok_or_else(failure)?;
            self.rpc("$events/result", json!({"clientId":client,"eventId":event_id,
                "outcome":{"kind":"result","value":answer}})).await?;
            return Ok(());
        }
        Err(failure())
    }
}
