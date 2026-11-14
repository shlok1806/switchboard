import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/src/index";
import { Branches, type BranchHost } from "../src/branches";
import { type ClaimHost, type ClaimMutation, Claims } from "../src/claims";

function fixture() {
  let task = { number: 1, title: "Task", status: "open", blockedBy: [], steps: [], labels: [] } as unknown as Task;
  const writes = vi.fn((next: Task) => {
    task = next;
  });
  const sync = vi.fn(async () => ({ ok: true }));
  const host = {
    tasks: {
      ensureSynced: sync,
      read: () => task,
      write: writes,
      exclusive: async (run: () => Promise<unknown>) => run(),
    },
    agents: { find: () => null },
    status: { note: vi.fn() },
    gitHub: () => null,
    append: vi.fn(),
  } as unknown as ClaimHost;
  return { claims: new Claims(host), host, writes, sync, read: () => task };
}
describe("managed Claims commit hooks", () => {
  it("concurrent eligible claims have one winner and holder retry is a no-op", async () => {
    const f = fixture();
    const commits = vi.fn((write: () => void) => write());
    const mutation: ClaimMutation = { prepare: async () => ({ commit: commits }) };
    const results = await Promise.all([
      f.claims.claim({ person: "alice" }, 1, undefined, mutation),
      f.claims.claim({ person: "bob" }, 1, undefined, mutation),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(commits).toHaveBeenCalledTimes(2);
    expect((await f.claims.claim({ person: "alice" }, 1, undefined, mutation)).ok).toBe(true);
    expect(f.writes).toHaveBeenCalledTimes(1);
  });
  it("sync completion precedes fresh permit acquisition and local state is reread", async () => {
    const f = fixture();
    const order: string[] = [];
    f.sync.mockImplementation(async () => {
      order.push("sync");
      return { ok: true };
    });
    await f.claims.claim({ person: "alice" }, 1, undefined, {
      prepare: async () => {
        order.push("permit");
        return {
          commit: (write) => {
            order.push("commit");
            write();
          },
        };
      },
    });
    expect(order).toEqual(["sync", "permit", "commit"]);
    expect(f.read().claim?.holder).toEqual({ kind: "person", person: "alice" });
  });
  it("revocation during sync denies claim without a local write", async () => {
    const f = fixture();
    await expect(
      f.claims.claim({ person: "alice" }, 1, undefined, {
        prepare: async () => {
          throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(f.writes).not.toHaveBeenCalled();
  });
  it("rejects a permit at commit without changing task state", async () => {
    const f = fixture();
    await expect(
      f.claims.claim({ person: "alice" }, 1, undefined, {
        prepare: async () => ({
          commit: () => {
            throw new Error("expired");
          },
        }),
      }),
    ).rejects.toThrow("expired");
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.read().status).toBe("open");
  });
  it("revoke during PR creation records external outcome and denies review commit", async () => {
    const f = fixture();
    await f.claims.claim({ person: "alice" }, 1);
    f.writes({ ...f.read(), branch: "task/1-example" });
    f.writes.mockClear();
    const pr = { number: 2, url: "https://github.test/pull/2" };
    const gitHub = { defaultBranch: async () => "main", createPullRequest: async () => pr };
    const branches = new Branches({
      ...f.host,
      claims: f.claims,
      gitHub: () => gitHub,
      appendOnce: vi.fn(),
    } as unknown as BranchHost);
    const externalOutcome = vi.fn();
    const intent = vi.fn((write: () => void) => write());
    await expect(
      branches.finish({ person: "alice" }, 1, undefined, {
        prepareIntent: async () => ({ commit: intent }),
        prepare: async () => {
          throw new Error("revoked after PR");
        },
        externalOutcome,
      }),
    ).rejects.toThrow("revoked after PR");
    expect(intent).toHaveBeenCalledTimes(1);
    expect(externalOutcome).toHaveBeenCalledWith(pr);
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.read().status).toBe("claimed");
  });
  it("sync beyond two seconds precedes fresh permit acquisition", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const start = Date.now();
      f.sync.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        return { ok: true };
      });
      let issuedAt = 0;
      const claim = f.claims.claim({ person: "alice" }, 1, undefined, {
        prepare: async () => {
          issuedAt = Date.now();
          return {
            commit: (write) => {
              expect(Date.now() - issuedAt).toBeLessThan(2000);
              write();
            },
          };
        },
      });
      await vi.advanceTimersByTimeAsync(2500);
      expect((await claim).ok).toBe(true);
      expect(issuedAt - start).toBeGreaterThanOrEqual(2500);
    } finally {
      vi.useRealTimers();
    }
  });
});
