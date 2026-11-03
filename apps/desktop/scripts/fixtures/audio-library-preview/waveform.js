export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}
