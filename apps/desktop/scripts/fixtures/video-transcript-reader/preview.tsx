import React from "react";
import { createRoot } from "react-dom/client";
import { VideoTranscriptReader } from "../../../src/components/VideoTranscriptReader";
import type { VideoTranscript } from "../../../src/lib/videoTranscript";
import "../../../src/styles.css";
import "../../../src/components/IndustrialTheme.css";

const utterances: VideoTranscript["utterances"] = Array.from({ length: 2400 }, (_, index) => ({
  text: index === 2399 ? "索引尾句，到了。" : `第 ${index + 1} 句。`,
  startMs: index * 3000,
  endMs: (index + 1) * 3000,
}));
utterances[0].text = "好好，HELLO world！2026年。收工。";
utterances[0].words = ["好", "好", "hello", "world", "二", "零", "二", "六", "年", "收", "工"].map((text, index) => ({
  text, startMs: 100 + index * 200, endMs: 200 + index * 200,
}));
utterances[1].text = "较长的一句包含几行需要自动换行的文字。".repeat(6);
utterances[2].text = "好好。";
utterances[2].words = [{ text: "好", startMs: 6080, endMs: 6180 }];
utterances[3].text = "甲乙。";
utterances[3].words = [{ text: "甲", startMs: -1, endMs: -1 }, { text: "乙", startMs: 9140, endMs: 9140 }];
if (new URLSearchParams(location.search).has("legacy")) {
  for (const utterance of utterances) delete utterance.words;
}
const transcript: VideoTranscript = { status: "completed", text: `${utterances.map(line => line.text).join("\n")}\n仅全文存在的附注。`, utterances };
const fixture = Object.assign(window, { seekTimes: [] as number[], transcriptText: transcript.text });

createRoot(document.getElementById("root")!).render(<main style={{ display: "flex", width: "min(100vw, 380px)", height: "420px" }}>
  <VideoTranscriptReader transcript={transcript} onSeek={time => fixture.seekTimes.push(time)}/>
</main>);
