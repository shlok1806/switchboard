// A stopped clock for the screenshot tests: with `?state=` the simulated Channel draws the same
// page on every run, so its times ("52 min", "maya 05:33") must not move either. Timers still
// run; only what the clock says is fixed.

/** From now on `Date.now()` and `new Date()` answer this instant. */
export function freezeClock(at: string) {
  const fixed = Date.parse(at);
  const Real = Date;
  class Frozen extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [string | number | Date]));
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = Frozen as DateConstructor;
}
