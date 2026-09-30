// Every test starts with a Jev stand-in that Drops everything, so no test reaches
// the real Jev by accident. Relay tests install their own; the opt-in smoke test
// installs the real one.

import { beforeEach } from "vitest";
import { installJev } from "../src/relay/jev";
import { FakeJev } from "./fake-jev";

beforeEach(() => {
  installJev(new FakeJev());
});
