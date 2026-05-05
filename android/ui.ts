import { HarnessError } from "../core/errors.ts";
import type {
  UiActionResult,
  UiInspectResult,
  UiPressOptions,
  UiReadResult,
  UiSelector,
  UiSnapshot,
  UiSnapshotDetail,
  UiSnapshotOptions,
  UiTypeOptions,
  UiWaitCondition,
  UiWaitResult,
} from "../core/ui-types.ts";
import { evaluateAndroidWebview } from "./cdp.ts";

type UiCommand =
  | { type: "snapshot"; options?: UiSnapshotOptions }
  | { type: "inspect"; selector: UiSelector }
  | { type: "click"; selector: UiSelector }
  | { type: "type"; selector: UiSelector; text: string; options?: UiTypeOptions }
  | { type: "clear"; selector: UiSelector }
  | { type: "press"; selector: UiSelector; options: UiPressOptions }
  | { type: "read"; selector: UiSelector }
  | { type: "waitFor"; condition: UiWaitCondition };

const buildUiExpression = (command: UiCommand) => `
(async () => {
  const command = ${JSON.stringify(command)};

  const cssEscape = (value) => {
    if (globalThis.CSS && typeof globalThis.CSS.escape === "function") {
      return globalThis.CSS.escape(value);
    }

    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  };

  const attrSelector = (tagName, attribute, value) =>
    \`\${tagName}[\${attribute}="\${String(value).replaceAll("\\\\", "\\\\\\\\").replaceAll('"', '\\\\\\"')}"]\`;

  const isVisible = (element) => {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number.parseFloat(style.opacity || "1") > 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const isEnabled = (element) =>
    !(element.disabled || element.getAttribute("aria-disabled") === "true");

  const cleanText = (value) =>
    (value || "").replace(/\\s+/g, " ").trim();

  const getRole = (element) => {
    const explicitRole = element.getAttribute("role");
    if (explicitRole) {
      switch (explicitRole) {
        case "button":
        case "link":
        case "dialog":
        case "checkbox":
        case "radio":
          return explicitRole;
      }
    }

    if (element instanceof HTMLButtonElement) return "button";
    if (element instanceof HTMLAnchorElement && element.href) return "link";
    if (element instanceof HTMLTextAreaElement) return "textarea";
    if (element instanceof HTMLSelectElement) return "select";
    if (element instanceof HTMLInputElement) {
      switch (element.type) {
        case "checkbox":
          return "checkbox";
        case "radio":
          return "radio";
        default:
          return "input";
      }
    }

    if (element instanceof HTMLDialogElement) return "dialog";
    if (/^H[1-6]$/.test(element.tagName) || element.tagName === "P" || element.tagName === "LABEL") {
      return "text";
    }

    return "unknown";
  };

  const getLabel = (element) => {
    const ariaLabel = cleanText(element.getAttribute("aria-label"));
    if (ariaLabel) {
      return ariaLabel;
    }

    if ("labels" in element && element.labels && element.labels.length > 0) {
      return cleanText(element.labels[0].textContent);
    }

    const id = element.getAttribute("id");
    if (id) {
      const label = document.querySelector(\`label[for="\${cssEscape(id)}"]\`);
      if (label) {
        return cleanText(label.textContent);
      }
    }

    return undefined;
  };

  const buildCssPath = (element) => {
    const parts = [];
    let current = element;

    while (current instanceof Element && current !== document.body) {
      if (current.id) {
        parts.unshift(\`#\${cssEscape(current.id)}\`);
        break;
      }

      const tagName = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tagName);
        break;
      }

      const siblings = Array.from(parent.children).filter(
        (child) => child.tagName === current.tagName,
      );
      const index = siblings.indexOf(current) + 1;
      parts.unshift(\`\${tagName}:nth-of-type(\${index})\`);
      current = parent;
    }

    return parts.join(" > ");
  };

  const isUnique = (selector) => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };

  const encodeElementId = (strategies) =>
    btoa(JSON.stringify({ strategies }));

  const decodeElementId = (value) => {
    try {
      const parsed = JSON.parse(atob(value));
      return Array.isArray(parsed?.strategies) ? parsed.strategies : null;
    } catch {
      return null;
    }
  };

  const createStrategies = (element) => {
    const strategies = [];
    const tagName = element.tagName.toLowerCase();
    const id = element.getAttribute("id");
    if (id) {
      const selector = \`#\${cssEscape(id)}\`;
      if (isUnique(selector)) {
        strategies.push({ kind: "css", value: selector });
      }
    }

    const name = element.getAttribute("name");
    if (name) {
      const selector = attrSelector(tagName, "name", name);
      if (isUnique(selector)) {
        strategies.push({ kind: "css", value: selector });
      }
    }

    const placeholder = element.getAttribute("placeholder");
    if (placeholder) {
      const selector = attrSelector(tagName, "placeholder", placeholder);
      if (isUnique(selector)) {
        strategies.push({ kind: "css", value: selector });
      }
    }

    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      const selector = attrSelector(tagName, "aria-label", ariaLabel);
      if (isUnique(selector)) {
        strategies.push({ kind: "css", value: selector });
      }
    }

    const text = cleanText(
      element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
        ? ""
        : element.textContent,
    );
    if (text) {
      strategies.push({ kind: "text", value: text, role: getRole(element) });
    }

    strategies.push({ kind: "css", value: buildCssPath(element) });
    return strategies;
  };

  const toSnapshot = (element) => {
    const role = getRole(element);
    const text =
      role === "input" || role === "textarea" || role === "select"
        ? undefined
        : cleanText(element.textContent);
    const value =
      "value" in element && typeof element.value === "string"
        ? element.value
        : undefined;

    return {
      id: encodeElementId(createStrategies(element)),
      role,
      text: text || undefined,
      name: element.getAttribute("name") || undefined,
      placeholder: element.getAttribute("placeholder") || undefined,
      label: getLabel(element),
      value,
      type: element instanceof HTMLInputElement ? element.type : undefined,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      enabled: isEnabled(element),
      visible: isVisible(element),
      checked:
        element instanceof HTMLInputElement &&
        (element.type === "checkbox" || element.type === "radio")
          ? element.checked
          : undefined,
      selected:
        element instanceof HTMLOptionElement ? element.selected : undefined,
    };
  };

  const snapshotSelectors = [
    "button",
    "a[href]",
    "input",
    "textarea",
    "select",
    "[role='button']",
    "[role='link']",
    "[role='dialog']",
    "[role='checkbox']",
    "[role='radio']",
    "h1",
    "h2",
    "h3",
    "p",
    "label",
  ];

  const textBlockSelectors = [
    "h1",
    "h2",
    "h3",
    "p",
    "[role='heading']",
    "[role='alert']",
    "[aria-live]",
    "[data-sonner-toast]",
    "div",
    "span",
  ];

  const createElementSnapshots = () => {
    const seen = new Set();
    const elements = [];

    for (const element of document.querySelectorAll(snapshotSelectors.join(","))) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      const role = getRole(element);
      const text = cleanText(element.textContent);
      const isInteractive =
        role !== "text" &&
        role !== "unknown";

      if (!isInteractive && !text) {
        continue;
      }

      if (!isVisible(element)) {
        continue;
      }

      const snapshot = toSnapshot(element);
      if (seen.has(snapshot.id)) {
        continue;
      }

      seen.add(snapshot.id);
      elements.push(snapshot);
    }

    return elements;
  };

  const createTextBlocks = () => {
    const seen = new Set();
    const textBlocks = [];

    for (const element of document.querySelectorAll(textBlockSelectors.join(","))) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      if (!isVisible(element)) {
        continue;
      }

      const tagName = element.tagName.toLowerCase();
      if (["button", "a", "input", "textarea", "select", "label"].includes(tagName)) {
        continue;
      }

      const text = cleanText(element.textContent);
      if (!text || text.length < 2 || text.length > 220) {
        continue;
      }

      const childText = Array.from(element.children)
        .filter((child) => child instanceof HTMLElement && isVisible(child))
        .map((child) => cleanText(child.textContent))
        .filter(Boolean);

      if (childText.includes(text)) {
        continue;
      }

      if (seen.has(text)) {
        continue;
      }

      seen.add(text);
      textBlocks.push({
        id: encodeElementId(createStrategies(element)),
        kind:
          tagName === "h1" || tagName === "h2" || tagName === "h3" || element.getAttribute("role") === "heading"
            ? "heading"
            : element.getAttribute("role") === "alert" ||
                element.hasAttribute("aria-live") ||
                text.toLowerCase().includes("couldn't") ||
                text.toLowerCase().includes("error") ||
                text.toLowerCase().includes("failed")
              ? "alert"
              : "body",
        text,
      });
    }

    return textBlocks.slice(0, 16);
  };

  const toInputKind = (element) => {
    if (element.role === "textarea") return "textarea";
    if (element.role === "select") return "select";
    switch (element.type) {
      case "email":
        return "email";
      case "password":
        return "password";
      case "search":
        return "search";
      case "file":
        return "file";
      case "text":
      case "tel":
      case "number":
      case "url":
        return "text";
      default:
        return element.role === "input" ? "unknown" : "unknown";
    }
  };

  const truncateValue = (value) => {
    if (!value) return undefined;
    return value.length > 80 ? value.slice(0, 77) + "..." : value;
  };

  const deriveSelectedTab = (elements, route) => {
    const routeSegment = route.split("/").filter(Boolean).pop() || "";
    const tabLink = elements.find((element) => {
      if (element.role !== "link" || !element.href || !element.text) {
        return false;
      }

      try {
        const href = new URL(element.href, location.href);
        return href.pathname === route || cleanText(element.text).toLowerCase() === routeSegment;
      } catch {
        return false;
      }
    });

    return tabLink?.text;
  };

  const deriveScreen = (route, title, textBlocks, selectedTab) => {
    const routeSegment = route.split("/").filter(Boolean).pop() || "root";
    const heading = textBlocks.find((block) => block.kind === "heading")?.text;
    const normalize = (value) =>
      cleanText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    if (heading) {
      const headingSlug = normalize(heading);
      if (!headingSlug || headingSlug === routeSegment) {
        return routeSegment;
      }

      if (selectedTab && normalize(selectedTab) === routeSegment) {
        return routeSegment + "-" + headingSlug;
      }

      return headingSlug;
    }

    if (title) {
      const titleSlug = normalize(title);
      if (
        titleSlug &&
        titleSlug !== routeSegment &&
        titleSlug.includes("-")
      ) {
        return routeSegment + "-" + titleSlug;
      }
    }

    return routeSegment;
  };

  const deriveBlockingMessage = (textBlocks) =>
    textBlocks.find((block) => {
      const text = block.text.toLowerCase();
      return (
        block.kind === "alert" ||
        text.includes("couldn't") ||
        text.includes("could not") ||
        text.includes("error") ||
        text.includes("failed") ||
        text.includes("denied")
      );
    })?.text;

  const shapeSnapshot = (detail = "summary") => {
    const route = location.pathname;
    const elements = createElementSnapshots();
    const textBlocks = createTextBlocks();
    const selectedTab = deriveSelectedTab(elements, route);
    const blockingMessage = deriveBlockingMessage(textBlocks);
    const actions = elements
      .filter((element) => element.role === "button" || element.role === "link")
      .map((element) => {
        const label = cleanText(element.label || element.text || "");
        let role = element.role === "button" ? "button" : "link";

        if (label.toLowerCase().includes("back")) {
          role = "back";
        } else if (
          element.role === "link" &&
          element.href &&
          ["/app/solver", "/app/study", "/app/profile"].some((path) => {
            try {
              return new URL(element.href, location.href).pathname === path;
            } catch {
              return false;
            }
          })
        ) {
          role = "tab";
        }

        return {
          id: element.id,
          role,
          label,
          enabled: element.enabled,
          selected:
            role === "tab" &&
            !!selectedTab &&
            cleanText(label).toLowerCase() === cleanText(selectedTab).toLowerCase(),
        };
      })
      .filter((action) => action.label && !action.label.toLowerCase().startsWith("close history"))
      .sort((left, right) => {
        const score = (action) => {
          if (action.role === "back") return 0;
          if (blockingMessage && action.enabled) return 1;
          if (action.role === "button" && action.enabled) return 2;
          if (action.role === "tab") return 3;
          return 4;
        };

        return score(left) - score(right);
      });

    const inputs = elements
      .filter(
        (element) =>
          element.role === "input" ||
          element.role === "textarea" ||
          element.role === "select",
      )
      .map((element) => ({
        id: element.id,
        kind: toInputKind(element),
        name: element.name,
        label: element.label,
        placeholder: element.placeholder,
        valuePreview: truncateValue(element.value),
        empty: !element.value,
        focused:
          document.activeElement instanceof HTMLElement &&
          toSnapshot(document.activeElement).id === element.id,
      }));

    const overlays = [];
    if (blockingMessage) {
      overlays.push({
        id: "blocking:" + blockingMessage,
        kind: "banner",
        message: blockingMessage,
        blocking: true,
      });
    }

    const canGoBack = actions.some((action) => action.role === "back");
    const status = blockingMessage
      ? "error"
      : actions.some((action) => action.enabled === false && action.label)
        ? "loading"
        : "idle";
    const screen = deriveScreen(route, document.title, textBlocks, selectedTab);

    const snapshot = {
      detail,
      screen,
      route,
      url: location.href,
      title: document.title,
      status,
      selectedTab,
      canGoBack,
      blockingMessage,
      primaryActions: actions.slice(0, 6),
      inputs: inputs.slice(0, 8),
      overlays,
    };

    if (detail === "summary") {
      return snapshot;
    }

    return {
      ...snapshot,
      elements,
      textBlocks: detail === "full" ? textBlocks : textBlocks.slice(0, 8),
      debug:
        detail === "full"
          ? {
              elementCount: elements.length,
              textBlockCount: textBlocks.length,
            }
          : undefined,
    };
  };

  const resolveByText = (text, role) => {
    const matches = [];
    for (const element of document.querySelectorAll(snapshotSelectors.join(","))) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      if (!isVisible(element)) {
        continue;
      }

      if (role && getRole(element) !== role) {
        continue;
      }

      if (cleanText(element.textContent) === text) {
        matches.push(element);
      }
    }

    return matches;
  };

  const resolveSelector = (selector) => {
    if (!selector || typeof selector !== "object") {
      throw new Error("A selector is required.");
    }

    const visibleOnly = (elements) =>
      elements.filter((element) => element instanceof HTMLElement && isVisible(element));

    const fromHandle = selector.elementId
      ? (() => {
          const strategies = decodeElementId(selector.elementId);
          if (!strategies) {
            return [];
          }

          for (const strategy of strategies) {
            if (strategy.kind === "css") {
              const element = document.querySelector(strategy.value);
              if (element instanceof HTMLElement && isVisible(element)) {
                return [element];
              }
            }

            if (strategy.kind === "text") {
              const matches = resolveByText(strategy.value, strategy.role);
              if (matches.length === 1) {
                return matches;
              }
            }
          }

          return [];
        })()
      : [];

    if (fromHandle.length > 0) {
      return fromHandle;
    }

    if (selector.selector) {
      return visibleOnly(Array.from(document.querySelectorAll(selector.selector)));
    }

    let matches = visibleOnly(Array.from(document.querySelectorAll(snapshotSelectors.join(","))));

    if (selector.role) {
      matches = matches.filter((element) => getRole(element) === selector.role);
    }

    if (selector.name) {
      matches = matches.filter(
        (element) => element.getAttribute("name") === selector.name,
      );
    }

    if (selector.placeholder) {
      matches = matches.filter(
        (element) =>
          element.getAttribute("placeholder") === selector.placeholder,
      );
    }

    if (selector.text) {
      matches = matches.filter(
        (element) => cleanText(element.textContent) === selector.text,
      );
    }

    return matches;
  };

  const getSingleElement = (selector) => {
    const matches = resolveSelector(selector);

    if (matches.length === 0) {
      throw new Error("No matching UI element was found.");
    }

    if (matches.length > 1) {
      throw new Error("Multiple UI elements matched the selector.");
    }

    return matches[0];
  };

  const setElementValue = (element, value) => {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      const previousValue = element.value;
      descriptor?.set?.call(element, value);

      const valueTracker = element._valueTracker;
      if (valueTracker && typeof valueTracker.setValue === "function") {
        valueTracker.setValue(previousValue);
      }

      element.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: value,
          inputType: "insertText",
        }),
      );
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: value,
          inputType: "insertText",
        }),
      );
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (element instanceof HTMLSelectElement) {
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    throw new Error("Target element does not support text input.");
  };

  const clickElement = (element) => {
    element.scrollIntoView({ block: "center", inline: "center" });
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.click();
  };

  const actionResult = (selector, element) => ({
    selector,
    matchedElement: toSnapshot(element),
  });

  const readResult = (selector, element) => ({
    selector,
    matchedElement: toSnapshot(element),
  });

  const inspectResult = (selector, element) => {
    const summary = shapeSnapshot("standard");
    return {
      selector,
      matchedElement: toSnapshot(element),
      screen: summary.screen,
      route: summary.route,
      title: summary.title,
      detail: "standard",
      textBlocks: summary.textBlocks,
    };
  };

  const pressElement = (element, options) => {
    const key = options?.key || "Enter";
    const code = options?.code || key;
    element.focus();
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        key,
        code,
      }),
    );
    element.dispatchEvent(
      new KeyboardEvent("keypress", {
        bubbles: true,
        key,
        code,
      }),
    );

    if (
      (key === "Enter" || key === " ") &&
      (element instanceof HTMLButtonElement ||
        (element instanceof HTMLAnchorElement && element.href))
    ) {
      element.click();
    } else if (
      key === "Enter" &&
      "form" in element &&
      element.form &&
      typeof element.form.requestSubmit === "function"
    ) {
      element.form.requestSubmit();
    }

    element.dispatchEvent(
      new KeyboardEvent("keyup", {
        bubbles: true,
        key,
        code,
      }),
    );
  };

  const waitForCondition = async (condition) => {
    const timeoutMs = condition.timeoutMs ?? 5000;
    const intervalMs = condition.intervalMs ?? 100;
    const startedAt = Date.now();

    return await new Promise((resolve) => {
      const tick = () => {
        let satisfied = false;

        try {
          if (condition.urlIncludes) {
            satisfied = location.href.includes(condition.urlIncludes);
          } else if (condition.text) {
            const fullSnapshot = shapeSnapshot("full");
            satisfied =
              (fullSnapshot.textBlocks || []).some((block) =>
                block.text.includes(condition.text),
              ) ||
              (fullSnapshot.elements || []).some((element) =>
                cleanText(element.text || element.label || "").includes(condition.text),
              );
          } else if (condition.element) {
            const matches = resolveSelector(condition.element);
            const state = condition.state ?? "visible";

            if (state === "hidden") {
              satisfied = matches.length === 0;
            } else if (state === "enabled") {
              satisfied = matches.length === 1 && isEnabled(matches[0]);
            } else if (state === "disabled") {
              satisfied = matches.length === 1 && !isEnabled(matches[0]);
            } else {
              satisfied = matches.length === 1;
            }
          }
        } catch {
          satisfied = false;
        }

        if (satisfied) {
          resolve({
            satisfied: true,
            elapsedMs: Date.now() - startedAt,
            snapshot: shapeSnapshot("summary"),
          });
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          resolve({
            satisfied: false,
            elapsedMs: Date.now() - startedAt,
            snapshot: shapeSnapshot("summary"),
          });
          return;
        }

        setTimeout(tick, intervalMs);
      };

      tick();
    });
  };

  const settleUi = async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 30));
  };

  switch (command.type) {
    case "snapshot":
      return shapeSnapshot(command.options?.detail || "summary");
    case "inspect": {
      const element = getSingleElement(command.selector);
      return inspectResult(command.selector, element);
    }
    case "click": {
      const element = getSingleElement(command.selector);
      clickElement(element);
      await settleUi();
      return actionResult(command.selector, element);
    }
    case "type": {
      const element = getSingleElement(command.selector);
      element.focus();
      const currentValue =
        "value" in element && typeof element.value === "string"
          ? element.value
          : "";
      const nextValue = command.options?.append
        ? \`\${currentValue}\${command.text}\`
        : command.text;
      setElementValue(element, nextValue);
      if (command.options?.submit) {
        if (element.form && typeof element.form.requestSubmit === "function") {
          element.form.requestSubmit();
        } else {
          element.dispatchEvent(
            new KeyboardEvent("keydown", {
              bubbles: true,
              key: "Enter",
              code: "Enter",
            }),
          );
        }
      }
      await settleUi();
      return actionResult(command.selector, element);
    }
    case "clear": {
      const element = getSingleElement(command.selector);
      element.focus();
      setElementValue(element, "");
      await settleUi();
      return actionResult(command.selector, element);
    }
    case "press": {
      const element = getSingleElement(command.selector);
      pressElement(element, command.options);
      await settleUi();
      return actionResult(command.selector, element);
    }
    case "read": {
      const element = getSingleElement(command.selector);
      return readResult(command.selector, element);
    }
    case "waitFor":
      return waitForCondition(command.condition);
    default:
      throw new Error(\`Unsupported UI command: \${command.type}\`);
  }
})()
`;

const executeUiCommand = async <T>(
  deviceId: string,
  appId: string,
  targetId: string,
  command: UiCommand,
): Promise<T> => {
  const result = await evaluateAndroidWebview(
    deviceId,
    appId,
    targetId,
    buildUiExpression(command),
  );

  return result.value as T;
};

const wrapUiError = (error: unknown): never => {
  if (error instanceof HarnessError) {
    throw error;
  }

  if (error instanceof Error) {
    throw new HarnessError("command_failed", error.message);
  }

  throw new HarnessError("command_failed", "Unknown UI command failure.");
};

export const snapshotAndroidUi = async (
  deviceId: string,
  appId: string,
  targetId: string,
  options?: UiSnapshotOptions,
): Promise<UiSnapshot> => {
  try {
    return await executeUiCommand<UiSnapshot>(deviceId, appId, targetId, {
      type: "snapshot",
      options,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const inspectAndroidUi = async (
  deviceId: string,
  appId: string,
  targetId: string,
  selector: UiSelector,
): Promise<UiInspectResult> => {
  try {
    return await executeUiCommand<UiInspectResult>(deviceId, appId, targetId, {
      type: "inspect",
      selector,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const clickAndroidUi = async (
  deviceId: string,
  appId: string,
  targetId: string,
  selector: UiSelector,
): Promise<UiActionResult> => {
  try {
    return await executeUiCommand<UiActionResult>(deviceId, appId, targetId, {
      type: "click",
      selector,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const typeIntoAndroidUi = async (
  deviceId: string,
  appId: string,
  targetId: string,
  selector: UiSelector,
  text: string,
  options?: UiTypeOptions,
): Promise<UiActionResult> => {
  try {
    return await executeUiCommand<UiActionResult>(deviceId, appId, targetId, {
      type: "type",
      selector,
      text,
      options,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const clearAndroidUi = async (
  deviceId: string,
  appId: string,
  targetId: string,
  selector: UiSelector,
): Promise<UiActionResult> => {
  try {
    return await executeUiCommand<UiActionResult>(deviceId, appId, targetId, {
      type: "clear",
      selector,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const pressAndroidUi = async (
  deviceId: string,
  appId: string,
  targetId: string,
  selector: UiSelector,
  options: UiPressOptions,
): Promise<UiActionResult> => {
  try {
    return await executeUiCommand<UiActionResult>(deviceId, appId, targetId, {
      type: "press",
      selector,
      options,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const readAndroidUi = async (
  deviceId: string,
  appId: string,
  targetId: string,
  selector: UiSelector,
): Promise<UiReadResult> => {
  try {
    return await executeUiCommand<UiReadResult>(deviceId, appId, targetId, {
      type: "read",
      selector,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const waitForAndroidUi = async (
  deviceId: string,
  appId: string,
  targetId: string,
  condition: UiWaitCondition,
): Promise<UiWaitResult> => {
  try {
    return await executeUiCommand<UiWaitResult>(deviceId, appId, targetId, {
      type: "waitFor",
      condition,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};
