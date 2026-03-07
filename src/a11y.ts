const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function isFocusableElement(node: Element): node is HTMLElement {
  return node instanceof HTMLElement && !node.hasAttribute("inert");
}

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).reduce<
    HTMLElement[]
  >((elements, node) => {
    if (isFocusableElement(node) && !node.hasAttribute("aria-hidden")) {
      elements.push(node);
    }
    return elements;
  }, []);
}

export function focusFirstElement(
  container: HTMLElement,
  fallback?: HTMLElement | null,
): void {
  const [first] = getFocusableElements(container);
  (first ?? fallback)?.focus();
}

export function trapFocusWithin(
  event: KeyboardEvent,
  container: HTMLElement | null,
): void {
  if (event.key !== "Tab" || !container) return;

  const focusableElements = getFocusableElements(container);
  if (focusableElements.length === 0) {
    event.preventDefault();
    return;
  }

  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];
  const activeElement = document.activeElement;

  if (event.shiftKey) {
    if (activeElement === firstElement || !container.contains(activeElement)) {
      event.preventDefault();
      lastElement.focus();
    }
    return;
  }

  if (activeElement === lastElement || !container.contains(activeElement)) {
    event.preventDefault();
    firstElement.focus();
  }
}
