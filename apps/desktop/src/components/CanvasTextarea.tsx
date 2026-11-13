import { useLayoutEffect, useRef, useTransition, type TextareaHTMLAttributes } from "react";

function changedRange(before: string, after: string) {
  let start = 0, end = before.length, newEnd = after.length;
  while (start < end && start < newEnd && before[start] === after[start]) start++;
  while (start < end && start < newEnd && before[end - 1] === after[newEnd - 1]) { end--; newEnd--; }
  return { start, end, text: after.slice(start, newEnd) };
}

/** The native editor paints and maintains the caret while React updates the rest of the board. */
type CanvasTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue" | "onChange" | "onCompositionStart" | "onCompositionEnd"> & {
  value: string;
  readCurrentValue: () => string;
  onValueChange: (text: string) => void;
};
export function CanvasTextarea({ value, readCurrentValue, onValueChange, ...props }: CanvasTextareaProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const initial = useRef(value);
  const compositionBase = useRef<string | null>(null);
  const [pending, updateBoard] = useTransition();
  useLayoutEffect(() => {
    const input = field.current;
    if (pending || !input || input.value === value || compositionBase.current !== null || readCurrentValue() !== value) return;
    const change = changedRange(input.value, value);
    input.setRangeText(change.text, change.start, change.end, "preserve");
  }, [pending, value]);
  function publish(text: string) {
    updateBoard(() => onValueChange(text));
  }
  return <textarea {...props} ref={field} defaultValue={initial.current}
    onCompositionStart={event => { compositionBase.current = event.currentTarget.value; }}
    onCompositionEnd={event => {
      const base = compositionBase.current;
      compositionBase.current = null;
      const input = event.currentTarget;
      // Board renders can lag behind a native keystroke. Read the latest draft at commit.
      const current = readCurrentValue();
      if (base !== null && base !== current) {
        const board = changedRange(base, current), typed = changedRange(base, input.value);
        // Apply independent board changes outside the selected word after candidate confirmation.
        // For simultaneous edits to that word, the user's final input wins.
        if (board.end <= typed.start || board.start >= typed.end) {
          const shift = board.end <= typed.start ? 0 : input.value.length - base.length;
          input.setRangeText(board.text, board.start + shift, board.end + shift, "preserve");
        }
      }
      if (input.value !== current) publish(input.value);
    }}
    onChange={event => { if (compositionBase.current === null) publish(event.currentTarget.value); }} />;
}
