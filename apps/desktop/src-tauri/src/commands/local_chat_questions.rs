//! Desktop question and answer payload shared by chat providers.
use super::{error, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuestionBatch {
    pub(super) turn_id: String,
    pub(super) call_id: String,
    pub(super) questions: Vec<Question>,
    pub(super) state: String,
    pub(super) queued: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Question {
    pub(super) id: String,
    pub(super) question: String,
    #[serde(default, deserialize_with = "optional_options")]
    pub(super) options: Vec<QuestionOption>,
    #[serde(default, alias = "multi_select")]
    pub(super) multi_select: bool,
}

fn optional_options<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<Vec<QuestionOption>, D::Error> {
    Ok(Option::deserialize(input)?.unwrap_or_default())
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct QuestionOption {
    pub(super) label: String,
    pub(super) description: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Answer {
    pub(super) id: String,
    pub(super) selected: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) custom: Option<String>,
}

impl QuestionBatch {
    pub(super) fn validate_answers(&self, answers: &[Answer]) -> AppResult<()> {
        if self.queued {
            return Err(error("答案已排队，Agent 正在处理"));
        }
        if self.questions.len() != answers.len()
            || !self.questions.iter().all(|question| {
                let mut matching = answers.iter().filter(|answer| answer.id == question.id);
                let Some(answer) = matching.next() else {
                    return false;
                };
                let custom = answer
                    .custom
                    .as_deref()
                    .is_some_and(|text| !text.trim().is_empty());
                matching.next().is_none()
                    && (!answer.selected.is_empty() || custom)
                    && (question.multi_select || answer.selected.len() + usize::from(custom) == 1)
                    && answer.selected.iter().collect::<HashSet<_>>().len() == answer.selected.len()
                    && answer
                        .selected
                        .iter()
                        .all(|label| question.options.iter().any(|option| &option.label == label))
            })
        {
            return Err(error("请完成这组问题的每一项后再提交"));
        }
        Ok(())
    }
}
