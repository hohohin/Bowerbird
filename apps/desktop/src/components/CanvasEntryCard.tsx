import { memo, useLayoutEffect, useRef, type ReactNode } from "react";

type Props = {
  card: unknown;
  render: () => ReactNode;
  entryContext: object | null;
};

// Card inputs include the snapshot and the presentation context supplied by its host.
const CanvasEntryCard = memo(
  function CanvasEntryCard({ render }: Props) { return render(); },
  (previous, next) => next.entryContext !== null && previous.entryContext === next.entryContext && previous.card === next.card,
);

export function renderCanvasCards<T extends { id: string }>(cards: T[], entryContext: object | null, render: (card: T) => ReactNode) {
  return cards.map(card => <CanvasEntryCard key={card.id} card={card} entryContext={entryContext} render={() => render(card)} />);
}

export function useCanvasEntryCardContext(context: object, opening: boolean, editingContext: object) {
  const wasOpening = useRef(opening);
  const reuse = opening || wasOpening.current;
  // The readiness commit should mount only the last batch.
  useLayoutEffect(() => { wasOpening.current = opening; }, [opening]);
  return reuse ? context : editingContext;
}
