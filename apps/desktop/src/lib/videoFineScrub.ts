/** Gesture thresholds in screen pixels; a fresh pointer press owns each gesture. */
export function startScrub(x: number, now: number) {
  return { origin: x, last: x, started: now, eligible: true, fine: false };
}
export function moveScrub(state: ReturnType<typeof startScrub>, x: number, now: number) {
  const distance = Math.abs(x - state.origin);
  if (!state.fine && distance > 12) state.eligible = false;
  if (state.eligible && now - state.started >= 400 && distance >= 3) state.fine = true;
  const delta = (x - state.last) / (state.fine ? 4 : 1);
  state.last = x;
  return delta;
}
