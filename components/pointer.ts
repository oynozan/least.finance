/**
 * True for a pointer that can really hover: a mouse, on a device whose
 * primary input hovers. Touch screens can emit stray mouse events, which
 * should count as taps rather than hovers.
 */
export const canHover = (event: { pointerType: string }) =>
  event.pointerType === "mouse" && window.matchMedia("(hover: hover)").matches;
