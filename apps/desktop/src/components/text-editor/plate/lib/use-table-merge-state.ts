import { useTableMergeState as usePlateTableMergeState, TablePlugin } from '@platejs/table/react';
import { KEYS, type TTableCellElement } from 'platejs';
import { useEditorSelector, useReadOnly } from 'platejs/react';

/** Plate 53.0.9 filters single cells out of getSelectedCellEntries, so its canSplit is always false. */
export function useTableMergeState() {
  const state = usePlateTableMergeState();
  const readOnly = useReadOnly();
  const canSplit = useEditorSelector(editor => {
    if (!editor.api.isCollapsed() || editor.getOption(TablePlugin, 'disableMerge')) return false;
    const cell = editor.api.above<TTableCellElement>({ match: { type: [KEYS.td, KEYS.th] } })?.[0];
    if (!cell) return false;
    const api = editor.getApi(TablePlugin).table;
    return api.getColSpan(cell) > 1 || api.getRowSpan(cell) > 1;
  }, []);
  return { ...state, canSplit: !readOnly && canSplit };
}
