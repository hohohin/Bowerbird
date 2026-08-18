-- 生成会话级分组持久化：「重新编辑 / 重试」产生的版本分支（新 task_queue job）归入源会话
-- （conversationId = 根 job id），瀑布流把同 conversation 的各版本产出并成一张轮播卡。
-- 之前该归组只活在前端内存 genJobs（重启即失），此处落 session → conversation 映射：
-- 每个 provider session（= assets.generation_session_id）完成时写入，列表/详情分组查询
-- 据此把 session 组扩成 conversation 组（无映射的 session 行为不变，自成一组）。
CREATE TABLE generation_conversations (
  session_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_generation_conversations_conversation
  ON generation_conversations(conversation_id);
