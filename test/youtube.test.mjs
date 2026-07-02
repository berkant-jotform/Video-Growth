import assert from "node:assert/strict";
import { test } from "node:test";
import { findYouTubeVideoCandidates } from "../lib/youtube.js";

test("finds and caches YouTube video candidates by title", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    calls += 1;
    requestedUrl = String(url);
    return {
      ok: true,
      async json() {
        return {
          items: [
            {
              id: { videoId: "zoom123" },
              snippet: {
                title: "How to Configure Zoom Settings & AI Companion",
                channelTitle: "Jotform",
                channelId: "UCjotform123456789012"
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
      channelId: "UCjotform123456789012",
      apiKey: "test-key"
    });
    const second = await findYouTubeVideoCandidates({
      title: "How to Configure Zoom Settings & AI Companion",
      channel: "Jotform",
      channelId: "UCjotform123456789012",
      apiKey: "test-key"
    });

    assert.equal(calls, 1);
    assert.match(requestedUrl, /channelId=UCjotform123456789012/);
    assert.equal(first[0].videoId, "zoom123");
    assert.equal(first[0].channelId, "UCjotform123456789012");
    assert.deepEqual(second, first);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
