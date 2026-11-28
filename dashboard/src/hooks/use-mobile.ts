import * as React from "react";

// The Dashboard's one breakpoint (design.md): below it, every page uses the phone pattern.
const MOBILE_BREAKPOINT = 640;

export function useIsMobile() {
  // Read at once, so the first render already has the phone's layout: a page that measures
  // itself on mount (Activity scrolling to a turn) never measures the desktop one.
  const [isMobile, setIsMobile] = React.useState(() => typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

// Below this width an inspector beside a table or the board leaves the list too little room
// (design.md "Inspector"): a row opens it as a sheet instead, as on a phone.
const INSPECTOR_BESIDE = 1024;

/** True where the inspector is a sheet a row opens, not a column beside the list. */
export function useInspectorSheet() {
  const [sheet, setSheet] = React.useState(() => typeof window !== "undefined" && window.innerWidth < INSPECTOR_BESIDE);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${INSPECTOR_BESIDE - 1}px)`);
    const onChange = () => setSheet(window.innerWidth < INSPECTOR_BESIDE);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return sheet;
}
