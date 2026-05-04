export type UiElementRole =
  | "button"
  | "link"
  | "tab"
  | "back"
  | "input"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "text"
  | "dialog"
  | "unknown";

export type UiSelector = {
  elementId?: string;
  selector?: string;
  text?: string;
  role?: UiElementRole;
  name?: string;
  placeholder?: string;
};

export type UiElementSnapshot = {
  id: string;
  role: UiElementRole;
  text?: string;
  name?: string;
  placeholder?: string;
  label?: string;
  value?: string;
  type?: string;
  href?: string;
  enabled: boolean;
  visible: boolean;
  checked?: boolean;
  selected?: boolean;
};

export type UiSnapshotDetail = "summary" | "standard" | "full";

export type UiStatus = "idle" | "loading" | "success" | "error" | "blocked";

export type UiActionSummary = {
  id: string;
  role: "button" | "link" | "tab" | "back";
  label: string;
  enabled: boolean;
  selected?: boolean;
};

export type UiInputSummary = {
  id: string;
  kind:
    | "text"
    | "email"
    | "password"
    | "search"
    | "textarea"
    | "file"
    | "select"
    | "unknown";
  name?: string;
  label?: string;
  placeholder?: string;
  valuePreview?: string;
  empty: boolean;
  focused: boolean;
};

export type UiOverlaySummary = {
  id: string;
  kind: "dialog" | "sheet" | "toast" | "banner" | "native-blocker" | "unknown";
  title?: string;
  message?: string;
  blocking: boolean;
};

export type UiTextBlock = {
  id: string;
  kind: "heading" | "body" | "alert";
  text: string;
};

export type UiSnapshot = {
  detail: UiSnapshotDetail;
  screen: string;
  route: string;
  url: string;
  title: string;
  status: UiStatus;
  selectedTab?: string;
  canGoBack: boolean;
  blockingMessage?: string;
  primaryActions: UiActionSummary[];
  inputs: UiInputSummary[];
  overlays: UiOverlaySummary[];
  elements?: UiElementSnapshot[];
  textBlocks?: UiTextBlock[];
  debug?: {
    elementCount: number;
    textBlockCount: number;
  };
};

export type UiActionResult = {
  selector: UiSelector;
  matchedElement?: UiElementSnapshot;
};

export type UiInspectResult = {
  selector: UiSelector;
  matchedElement: UiElementSnapshot;
  screen: string;
  route: string;
  title: string;
  detail: UiSnapshotDetail;
  textBlocks?: UiTextBlock[];
};

export type UiSnapshotOptions = {
  detail?: UiSnapshotDetail;
};

export type UiTypeOptions = {
  append?: boolean;
  submit?: boolean;
};

export type UiPressOptions = {
  key: string;
  code?: string;
};

export type UiReadResult = {
  selector: UiSelector;
  matchedElement: UiElementSnapshot;
};

export type UiWaitCondition = {
  element?: UiSelector;
  text?: string;
  urlIncludes?: string;
  state?: "visible" | "hidden" | "enabled" | "disabled";
  timeoutMs?: number;
  intervalMs?: number;
};

export type UiWaitResult = {
  satisfied: boolean;
  elapsedMs: number;
  snapshot?: UiSnapshot;
};
