type MenuPresentation<Icon extends string> = {
  label: string;
  icon?: Icon;
  disabled?: boolean;
  disabledReason?: string;
  title?: string;
};

type MenuActionPresentation = { danger?: boolean; tour?: string; ariaLabel?: string };

export type MenuItemDescriptor<Action extends string, Icon extends string, Slot extends string = never> =
  | { kind: "divider"; id: string }
  | { kind: "slot"; id: Slot }
  | (MenuPresentation<Icon> & { kind: "submenu"; id: string; menuLabel?: string; items: readonly MenuItemDescriptor<Action, Icon, Slot>[] })
  | (MenuPresentation<Icon> & MenuActionPresentation & { kind: "action"; id: Action })
  | (MenuPresentation<Icon> & MenuActionPresentation & { kind: "checkbox" | "radio"; id: Action; checked: boolean });
