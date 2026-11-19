//! Keep Codex's native request open and respond on the original JSON-RPC call.
use super::{
    error,
    questions::{Answer, Question, QuestionBatch},
    read_message, write_message, AppResult, StreamState,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncWrite},
    sync::{mpsc, watch},
    time::Instant,
};

struct Pending {
    request_id: Value,
    batch: QuestionBatch,
    reply: mpsc::UnboundedSender<Reply>,
    sent: bool,
}

struct Reply {
    request_id: Value,
    answers: Value,
}

static PENDING: LazyLock<Mutex<HashMap<String, Vec<Pending>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn batches(id: &str) -> Vec<QuestionBatch> {
    PENDING
        .lock()
        .unwrap()
        .get(id)
        .map_or_else(Vec::new, |pending| {
            pending
                .iter()
                .map(|question| question.batch.clone())
                .collect()
        })
}

pub(super) fn answer(
    id: &str,
    turn: &str,
    call: &str,
    answers: &[Answer],
) -> Option<AppResult<()>> {
    let mut pending = PENDING.lock().unwrap();
    let questions = pending.get_mut(id)?;
    Some((|| {
        let question = questions
            .iter_mut()
            .find(|question| question.batch.turn_id == turn && question.batch.call_id == call)
            .ok_or_else(|| error("此问题已结束，请查看最新对话"))?;
        question.batch.validate_answers(answers)?;
        let answers = answers
            .iter()
            .map(|answer| {
                let values: Vec<_> = answer
                    .selected
                    .iter()
                    .chain(answer.custom.iter().filter(|text| !text.trim().is_empty()))
                    .collect();
                (answer.id.clone(), json!({"answers":values}))
            })
            .collect::<serde_json::Map<_, _>>();
        question
            .reply
            .send(Reply {
                request_id: question.request_id.clone(),
                answers: Value::Object(answers),
            })
            .map_err(|_| error("此问题已结束，请查看最新对话"))?;
        question.batch.queued = true;
        Ok(())
    })())
}

pub(super) struct QuestionTurn<'a> {
    id: &'a str,
    turn: &'a str,
    reply: mpsc::UnboundedSender<Reply>,
    answers: mpsc::UnboundedReceiver<Reply>,
    waiting: watch::Sender<bool>,
}

impl<'a> QuestionTurn<'a> {
    pub(super) fn new(id: &'a str, turn: &'a str, waiting: watch::Sender<bool>) -> Self {
        let (reply, answers) = mpsc::unbounded_channel();
        Self {
            id,
            turn,
            reply,
            answers,
            waiting,
        }
    }

    pub(super) fn open(&self, request: &Value, stream: &StreamState) -> AppResult<()> {
        let params = &request["params"];
        if !stream.start_confirmed
            || stream.provider_thread.is_none()
            || stream.provider_turn.is_none()
            || params["threadId"].as_str() != stream.provider_thread.as_deref()
            || params["turnId"].as_str() != stream.provider_turn.as_deref()
        {
            return Err(error("问题与当前 Codex 轮次不匹配，请查看对话"));
        }
        let call = params["itemId"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| error("Codex 未返回问题编号，请继续对话"))?;
        let raw_questions = params["questions"]
            .as_array()
            .filter(|questions| !questions.is_empty())
            .ok_or_else(|| error("Codex 未返回可回答的问题，请继续对话"))?;
        if raw_questions
            .iter()
            .any(|question| question["isSecret"] == true)
        {
            return Err(error("Agent 无法通过画布收集密码等机密答案，请继续对话"));
        }
        let questions: Vec<Question> = serde_json::from_value(params["questions"].clone())
            .map_err(|_| error("Codex 返回的问题无法读取，请继续对话"))?;
        let mut ids = HashSet::new();
        if questions.iter().any(|question| {
            let mut labels = HashSet::new();
            question.id.trim().is_empty()
                || question.question.trim().is_empty()
                || question.multi_select
                || !ids.insert(&question.id)
                || question
                    .options
                    .iter()
                    .any(|option| option.label.trim().is_empty() || !labels.insert(&option.label))
        }) {
            return Err(error("Codex 返回的问题或选项无效，请继续对话"));
        }
        let mut pending = PENDING.lock().unwrap();
        let items = pending.entry(self.id.to_owned()).or_default();
        if items
            .iter()
            .any(|question| question.batch.call_id == call || question.request_id == request["id"])
        {
            return Err(error("Codex 重复发出了同一个问题，请继续对话"));
        }
        items.push(Pending {
            request_id: request["id"].clone(),
            batch: QuestionBatch {
                turn_id: self.turn.to_owned(),
                call_id: call.to_owned(),
                questions,
                state: "open".to_owned(),
                queued: false,
            },
            reply: self.reply.clone(),
            sent: false,
        });
        self.waiting.send_replace(true);
        Ok(())
    }

    pub(super) async fn next_message(
        &mut self,
        reader: &mut (impl AsyncBufRead + Unpin),
        writer: &mut (impl AsyncWrite + Unpin),
    ) -> AppResult<Value> {
        // Keep any partially received line alive while also forwarding UI replies.
        let next = read_message(reader);
        tokio::pin!(next);
        loop {
            tokio::select! {
                incoming = &mut next => return incoming,
                Some(reply) = self.answers.recv() => {
                    write_message(writer, json!({"id":reply.request_id,"result":{"answers":reply.answers}})).await?;
                    let mut pending = PENDING.lock().unwrap();
                    if let Some(questions) = pending.get_mut(self.id) {
                        if let Some(question) = questions.iter_mut().find(|question| {
                            question.batch.turn_id == self.turn && question.request_id == reply.request_id
                        }) {
                            question.sent = true;
                        }
                        self.waiting.send_replace(questions.iter().any(|question| !question.sent));
                    }
                }
            }
        }
    }

    pub(super) fn pending(&self) -> bool {
        PENDING
            .lock()
            .unwrap()
            .get(self.id)
            .is_some_and(|questions| {
                questions
                    .iter()
                    .any(|question| question.batch.turn_id == self.turn)
            })
    }

    /// Resolving an unanswered request means Codex withdrew it before accepting a reply.
    pub(super) fn resolved(&self, request_id: &Value) -> bool {
        self.remove(|question| &question.request_id == request_id)
    }

    fn remove(&self, matches: impl Fn(&Pending) -> bool) -> bool {
        let mut pending = PENDING.lock().unwrap();
        let Some(questions) = pending.get_mut(self.id) else {
            return false;
        };
        let mut unanswered = false;
        questions.retain(|question| {
            let keep = question.batch.turn_id != self.turn || !matches(question);
            unanswered |= !keep && !question.sent;
            keep
        });
        self.waiting
            .send_replace(questions.iter().any(|question| !question.sent));
        if questions.is_empty() {
            pending.remove(self.id);
        }
        unanswered
    }
}

impl Drop for QuestionTurn<'_> {
    fn drop(&mut self) {
        self.remove(|_| true);
    }
}

pub(super) async fn execution_budget(mut waiting: watch::Receiver<bool>, mut remaining: Duration) {
    loop {
        let paused = *waiting.borrow_and_update();
        if paused {
            if waiting.changed().await.is_err() {
                return;
            }
        } else {
            let start = Instant::now();
            tokio::select! {
                _ = tokio::time::sleep(remaining) => return,
                change = waiting.changed() => {
                    if change.is_err() { return; }
                    remaining = remaining.saturating_sub(start.elapsed());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};

    fn request() -> (StreamState, Value) {
        let stream = StreamState {
            provider_thread: Some("provider-thread".into()),
            provider_turn: Some("provider-turn".into()),
            start_confirmed: true,
            ..Default::default()
        };
        let request = json!({
            "id":27,"method":"item/tool/requestUserInput","params":{
                "threadId":"provider-thread","turnId":"provider-turn","itemId":"call","isBlocking":false,
                "questions":[
                    {"id":"audience","question":"这张海报面向谁？","options":[{"label":"亲子家庭"}]},
                    {"id":"date","question":"活动在哪天？","options":null}
                ]
            }
        });
        (stream, request)
    }

    #[tokio::test]
    async fn validates_and_delivers_answers_to_exact_codex_request_once() {
        let (stream, request) = request();
        let (waiting, _) = watch::channel(false);
        let mut pending = QuestionTurn::new("codex-answers", "local-turn", waiting);
        pending.open(&request, &stream).unwrap();
        let answers: Vec<Answer> = serde_json::from_value(json!([
            {"id":"audience","selected":["亲子家庭"]},
            {"id":"date","selected":[],"custom":"周六"}
        ]))
        .unwrap();
        assert!(answer("other-chat", "local-turn", "call", &answers).is_none());
        assert!(answer(pending.id, "other-turn", "call", &answers)
            .unwrap()
            .is_err());
        assert!(answer(pending.id, pending.turn, "other-call", &answers)
            .unwrap()
            .is_err());
        assert!(answer(pending.id, pending.turn, "call", &answers[..1])
            .unwrap()
            .is_err());
        answer(pending.id, pending.turn, "call", &answers)
            .unwrap()
            .unwrap();
        assert!(pending.pending());
        assert!(batches(pending.id)[0].queued);
        assert!(answer(pending.id, pending.turn, "call", &answers)
            .unwrap()
            .is_err());

        let (mut response, listener) = tokio::io::duplex(1024);
        let (provider, stdout) = tokio::io::duplex(1024);
        let mut stdout = BufReader::new(stdout);
        let send = pending.next_message(&mut stdout, &mut response);
        let receive = async {
            let mut provider = provider;
            let mut listener = BufReader::new(listener);
            let mut line = String::new();
            listener.read_line(&mut line).await.unwrap();
            let reply: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(
                reply,
                json!({"id":27,"result":{"answers":{
                    "audience":{"answers":["亲子家庭"]},"date":{"answers":["周六"]}
                }}})
            );
            write_message(
                &mut provider,
                json!({"method":"serverRequest/resolved","params":{"requestId":27}}),
            )
            .await
            .unwrap();
        };
        let (resolved, ()) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(send, receive)
        })
        .await
        .unwrap();
        let resolved = resolved.unwrap();
        assert_eq!(resolved["method"], "serverRequest/resolved");
        assert!(
            pending.pending(),
            "sending alone does not settle the question"
        );
        assert!(!pending.resolved(&resolved["params"]["requestId"]));
        assert!(!pending.pending());
        assert!(batches(pending.id).is_empty());
    }

    #[test]
    fn rejects_wrong_provider_turn_and_discards_questions_when_turn_ends() {
        let (stream, mut request) = request();
        let (waiting, _) = watch::channel(false);
        let pending = QuestionTurn::new("codex-discard", "local-turn", waiting);
        request["params"]["turnId"] = json!("other-turn");
        assert!(pending.open(&request, &stream).is_err());
        assert!(batches(pending.id).is_empty());
        request["params"]["turnId"] = json!("provider-turn");
        request["params"]["questions"][0]["isSecret"] = json!(true);
        assert!(pending.open(&request, &stream).is_err());
        request["params"]["questions"][0]["isSecret"] = json!(false);
        pending.open(&request, &stream).unwrap();
        assert!(!pending.resolved(&json!(28)));
        assert!(pending.resolved(&json!(27)));
        pending.open(&request, &stream).unwrap();
        let id = pending.id;
        drop(pending);
        assert!(batches(id).is_empty());
    }
}
