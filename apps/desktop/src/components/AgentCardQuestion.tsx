import { ArrowUp, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { localChat, type AgentQuestionAnswer, type AgentQuestionBatch } from "../lib/localChat";
import { userErrorMessage } from "../lib/userError";

export function AgentCardQuestion({ conversationId, onResume }: {
  conversationId: string;
  onResume: (turnId: string) => void;
}) {
  const [batch, setBatch] = useState<AgentQuestionBatch>();
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const questions = await localChat.questions(conversationId);
        if (current) setBatch(questions[0]);
      } catch { /* Keep the last visible question while the native host reconnects. */ }
      if (current) timer = setTimeout(poll, 1800);
    }
    void poll();
    return () => { current = false; clearTimeout(timer); };
  }, [conversationId]);
  return batch ? <QuestionBubble key={JSON.stringify([batch.turnId, batch.callId])} batch={batch}
    conversationId={conversationId} onResume={onResume} /> : null;
}

function QuestionBubble({ batch, conversationId, onResume }: {
  batch: AgentQuestionBatch; conversationId: string; onResume: (turnId: string) => void;
}) {
  const labelId = useId();
  const [open, setOpen] = useState(true);
  const [answers, setAnswers] = useState<AgentQuestionAnswer[]>(() => batch.questions.map(question => ({ id: question.id, selected: [], custom: "" })));
  const [phase, setPhase] = useState<"ready" | "sending" | "submitted">("ready");
  const [failure, setFailure] = useState("");
  const request = useRef(false);
  const submittedSnapshot = useRef<AgentQuestionBatch>();
  const composing = useRef(false);
  const reopen = useRef<HTMLButtonElement>(null);
  const single = batch.questions.length === 1 && !batch.questions[0].multiSelect;
  const waiting = phase === "submitted" || batch.queued;
  useEffect(() => {
    if (phase === "submitted" && batch !== submittedSnapshot.current && batch.state === "continued" && !batch.queued) {
      request.current = false;
      setPhase("ready");
    }
  }, [batch, phase]);
  const complete = (batchAnswers: AgentQuestionAnswer[]) => batchAnswers.every(answer => answer.selected.length || answer.custom?.trim());
  const close = () => { setOpen(false); reopen.current?.focus(); };
  function change(index: number, value: Partial<AgentQuestionAnswer>) {
    const next = answers.map((answer, i) => i === index ? { ...answer, ...value } : answer);
    setAnswers(next);
    return next;
  }
  async function send(next: AgentQuestionAnswer[]) {
    if (request.current || batch.queued || !complete(next)) return;
    request.current = true;
    setPhase("sending");
    setFailure("");
    try {
      await localChat.answerQuestion(conversationId, batch.turnId, batch.callId,
        next.map(({ id, selected, custom }) => ({ id, selected, ...(custom?.trim() ? { custom: custom.trim() } : {}) })));
      submittedSnapshot.current = batch;
      setPhase("submitted");
    } catch (error) {
      request.current = false;
      setPhase("ready");
      setFailure(userErrorMessage(error, "暂未确认答复，请查看当前待答状态后重试"));
    } finally {
      onResume(batch.turnId);
    }
  }
  return <>
    <button ref={reopen} type="button" className="workflow-agent-question-status"
      aria-expanded={open} onClick={event => { event.stopPropagation(); setOpen(true); }}>
      {waiting ? "继续处理中" : "待你回答"}
    </button>
    {open && <section className="workflow-agent-question-bubble" role="group" aria-labelledby={labelId}
      onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); close(); }
      }}>
      <div className="workflow-agent-question-heading"><strong id={labelId}>Agent 提问</strong>
        <button type="button" className="app-icon-button" aria-label="关闭问题气泡" title="关闭问题气泡" onClick={close}><X size={14} /></button>
      </div>
      {batch.questions.map((question, index) => <fieldset key={question.id} disabled={phase !== "ready" || waiting}>
        <legend>{question.question}</legend>
        {question.options.map(option => {
          const selected = answers[index].selected.includes(option.label);
          return <button type="button" key={option.label} className="workflow-agent-question-option"
            aria-pressed={single ? undefined : selected} onClick={() => {
              const next = change(index, question.multiSelect
                ? { selected: selected ? answers[index].selected.filter(label => label !== option.label) : [...answers[index].selected, option.label] }
                : { selected: [option.label], custom: "" });
              if (single) void send(next);
            }}><span>{option.label}</span>{option.description && <small>{option.description}</small>}</button>;
        })}
        <div className="workflow-agent-question-answer">
          <textarea rows={1} value={answers[index].custom} aria-label={`${question.question} 文字答案`}
            placeholder={question.options.length ? "其他答案…" : "输入答案…"}
            onChange={event => change(index, { custom: event.target.value, ...(!question.multiSelect ? { selected: [] } : {}) })}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={event => {
              if (event.key !== "Enter" || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              void send(answers);
            }} />
          {(single || index === batch.questions.length - 1) && <button type="button" className="app-icon-button" aria-label="发送答案" title="发送答案"
            disabled={!complete(answers)} onClick={() => void send(answers)}><ArrowUp size={16} /></button>}
        </div>
      </fieldset>)}
      {(phase !== "ready" || waiting) && <p role="status">{phase === "sending" ? "正在提交答案…" : "答案已提交，等待 Agent 继续…"}</p>}
      {failure && <p role="alert">{failure}</p>}
    </section>}
  </>;
}
