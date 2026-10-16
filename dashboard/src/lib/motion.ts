// Motion that script starts, such as a smooth scroll, follows the reader's reduced-motion
// setting as the CSS does (index.css): with it on, the page jumps instead of gliding.

/** Whether the reader asked the system for less motion. */
export function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The scroll behavior to ask for: smooth, unless the reader asked for less motion. */
export function scrollMotion(): ScrollBehavior {
  return reducedMotion() ? "auto" : "smooth";
}
