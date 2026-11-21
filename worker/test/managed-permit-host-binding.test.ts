import { describe, expect, it } from "vitest";
import type { PolicyResource } from "../../shared/src/m1";
import { resourceKey } from "../src/policy-permits";

describe("managed permit Host binding", () => {
  it("binds an exact Host, including its absence, into the resource key", () => {
    const resource: PolicyResource = { kind: "workspace", organizationId: "org", id: "workspace" };
    const first = resourceKey({ ...resource, hostId: "host-a" });
    expect(first).not.toBe(resourceKey({ ...resource, hostId: "host-b" }));
    expect(first).not.toBe(resourceKey(resource));
    expect(resourceKey(resource)).toBe(resourceKey({ ...resource, hostId: undefined }));
  });
});
