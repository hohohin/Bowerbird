type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

/** Persist before the generation IPC, including failures rejected by Tauri argument decoding. */
export async function invokeGenerationWithDiagnostics(
  request: Record<string, unknown> & { jobId: string }, invoke: Invoke,
): Promise<string> {
  const attemptId = await invoke<string>("begin_generation_diagnostic", { request });
  try {
    return await invoke<string>("codex_create_image", { ...request, diagnosticId: attemptId });
  } catch (error) {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
    try {
      await invoke<void>("finish_generation_diagnostic", { attemptId, jobId: request.jobId, error: message });
    } catch (loggingError) {
      // Retain the original generation error; the already-persisted receipt remains searchable.
      console.error("生成诊断收尾保存失败", request.jobId, loggingError);
    }
    throw error;
  }
}
