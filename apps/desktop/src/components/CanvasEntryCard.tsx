import { memo, useLayoutEffect, useRef, type ReactNode } from "react";

type Props = {
  card: unknown;
  render: () => ReactNode;
  entryContext: object | null;
};

// Appending a batch should not rerender the cards already mounted for the
// same snapshot. Normal editing uses live props.
const CanvasEntryCard = memo(
  function CanvasEntryCard({ render }: Props) { return render(); },
  (previous, next) => next.entryContext !== null && previous.entryContext === next.entryContext && previous.card === next.card,
);

export function renderCanvasCards<T extends { id: string }>(cards: T[], entryContext: object | null, render: (card: T) => ReactNode) {
  return cards.map(card => <CanvasEntryCard key={card.id} card={card} entryContext={entryContext} render={() => render(card)} />);
}

export function useCanvasEntryCardContext(context: object, opening: boolean) {
  const wasOpening = useRef(opening);
  const reuse = opening || wasOpening.current;
  // The readiness commit should mount only the last batch. A later update
  // can use normal props, including any changes from the first interaction.
  useLayoutEffect(() => { wasOpening.current = opening; }, [opening]);
  return reuse ? context : null;
}
