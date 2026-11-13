-- Existing turns keep their original request fingerprint and recovery checkpoint.
UPDATE local_chat_conversations SET provider = 'dsh-cloud'
WHERE provider = 'deepseek-cloud';
