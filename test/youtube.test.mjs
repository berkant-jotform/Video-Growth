import assert from "node:assert/strict";
import { test } from "node:test";
import { findYouTubeVideoCandidates } from "../lib/youtube.js";

test("finds and caches YouTube video candidates by title", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      async json() {
        return {
          items: [
            {
              id: { videoId: "zoom123" },
              snippet: {
                title: "How to Configure Zoom Settings & AI Companion",
                channelTitle: "Jotform"
              }
            },
            {
              id: { videoId: "other123" },
              snippet: {
                title: "Completely Different Video",
                channelTitle: "Other"
              }
            }
          ]
        };
      }
    };
  };

  try {
    const first = await findYouTubeVideoCandidates({
      title: "How to Configure Zoom Settings & AI Companion",
      channel: "Jotform",
      apiKey: "test-key"
    });
    const second = await findYouTubeVideoCandidates({
      title: "How to Configure Zoom Settings & AI Companion",
      channel: "Jotform",
      apiKey: "test-key"
    });

    assert.equal(calls, 1);
    assert.equal(first[0].videoId, "zoom123");
    assert.deepEqual(second, first);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
