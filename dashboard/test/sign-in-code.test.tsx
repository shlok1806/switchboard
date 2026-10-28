// @vitest-environment happy-dom
// "Sign in with a code": the device flow from the sign-in screen, clicked through as a Person would.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceCodeResponse } from "@shared/index";
import { SignInScreen } from "@/components/domain/join";
import type { DevicePollResult, DeviceSignIn } from "@/lib/session";

const code: DeviceCodeResponse = {
  deviceCode: "dev-1",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  interval: 5,
  expiresIn: 900,
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(polls: DevicePollResult[]) {
  const poll = vi.fn(async () => polls.shift() ?? ({ kind: "pending", slowDown: false } as const));
  const device: DeviceSignIn = { start: async () => code, poll };
  const onSignedIn = vi.fn();
  render(<SignInScreen repo="o/r" onSignIn={() => {}} device={device} onSignedIn={onSignedIn} />);
  return { poll, onSignedIn };
}

/** Lets the pending promises settle, then moves the clock. */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function start() {
  fireEvent.click(screen.getByRole("button", { name: "Sign in with a code" }));
  await wait(0);
}

describe("Sign in with a code", () => {
  it("shows the code and a link to GitHub, polls at the interval, and signs in once approved", async () => {
    const { poll, onSignedIn } = setup([{ kind: "pending", slowDown: false }, { kind: "signed-in" }]);
    await start();
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open GitHub/ }).getAttribute("href")).toBe("https://github.com/login/device");
    expect(poll).not.toHaveBeenCalled();

    await wait(5000);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(onSignedIn).not.toHaveBeenCalled();
    await wait(5000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(poll).toHaveBeenCalledWith("dev-1", "o/r");
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("waits longer after GitHub asks it to slow down", async () => {
    const { poll } = setup([{ kind: "pending", slowDown: true }]);
    await start();
    await wait(5000);
    expect(poll).toHaveBeenCalledTimes(1);
    await wait(9000);
    expect(poll).toHaveBeenCalledTimes(1);
    await wait(1000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("says why it stopped, and offers a new code", async () => {
    const { onSignedIn } = setup([{ kind: "failed", reason: "That GitHub account does not have write access to this repo." }]);
    await start();
    await wait(5000);
    expect(screen.getByRole("alert").textContent).toContain("does not have write access");
    expect(screen.getByRole("button", { name: "Get a new code" })).toBeTruthy();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("stops polling when cancelled", async () => {
    const { poll } = setup([]);
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await wait(30_000);
    expect(poll).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in with a code" })).toBeTruthy();
  });
});
