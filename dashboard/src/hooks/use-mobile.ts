import * as React from "react"

// The Dashboard's one breakpoint (design.md): below it, every page uses the phone pattern.
const MOBILE_BREAKPOINT = 640

export function useIsMobile() {
  // Read at once, so the first render already has the phone's layout: a page that measures
  // itself on mount (Activity scrolling to a turn) never measures the desktop one.
  const [isMobile, setIsMobile] = React.useState(() => typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}
