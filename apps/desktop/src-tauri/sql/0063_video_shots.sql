CREATE TABLE video_shot_results (
    plan_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    interval_id TEXT NOT NULL,
    texts TEXT NOT NULL,
    visible INTEGER NOT NULL CHECK (visible IN (0,1)),
    PRIMARY KEY(plan_id, interval_id)
);
CREATE TABLE video_shot_applied_tasks (
    plan_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    task_key TEXT NOT NULL,
    interval_id TEXT NOT NULL,
    PRIMARY KEY(plan_id, task_key)
);
