import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enrichWithYouTubeMetadata,
  fetchYouTubeVideoContexts,
  fetchYouTubeVideoMetadata,
  findYouTubeVideoCandidates,
  parseIsoDurationSeconds
} from "../lib/youtube.js";

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

test("uses YouTube channel identity instead of a category-style sheet tab name", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/videos?")) {
      return {
        ok: true,
        async json() {
          return {
            items: [{
              id: "video123",
              snippet: {
                title: "Current title",
                channelId: "UCapps1234567890",
                channelTitle: "Jotform Apps",
                thumbnails: {}
              }
            }]
          };
        }
      };
    }
    return {
      ok: true,
      async json() {
        return {
          items: [{
            id: "UCapps1234567890",
            snippet: { title: "Jotform Apps", thumbnails: {} }
          }]
        };
      }
    };
  };
  try {
    const records = [{ videoId: "video123", channel: "With Podo", troubles: [] }];
    await enrichWithYouTubeMetadata(records, { youtubeApiKey: "test-key" });
    assert.equal(records[0].channel, "Apps");
    assert.equal(records[0].youtubeChannelId, "UCapps1234567890");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enriches an unregistered signal directly from its YouTube video ID", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      async json() {
        return {
          items: [{
            id: "unregistered-video-411",
            snippet: {
              title: "How to Design Your App with AI",
              channelId: "UCapps1234567890",
              channelTitle: "Jotform Apps",
              thumbnails: { high: { url: "https://img.example/high.jpg" } }
            }
          }]
        };
      }
    };
  };
  try {
    const first = await fetchYouTubeVideoMetadata(["unregistered-video-411"], "test-key");
    const second = await fetchYouTubeVideoMetadata(["unregistered-video-411"], "test-key");
    assert.equal(calls, 1);
    assert.equal(first["unregistered-video-411"].title, "How to Design Your App with AI");
    assert.equal(first["unregistered-video-411"].channelTitle, "Jotform Apps");
    assert.equal(first["unregistered-video-411"].thumbnailUrl, "https://img.example/high.jpg");
    assert.deepEqual(second, first);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normal scan enrichment keeps its existing snippet-only request contract", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      async json() {
        return {
          items: [{
            id: "video-contract",
            snippet: {
              title: "Current title",
              channelId: "UCcontract",
              channelTitle: "Jotform",
              thumbnails: {}
            }
          }]
        };
      }
    };
  };
  try {
    const output = await enrichWithYouTubeMetadata(
      [{ videoId: "video-contract", channel: "Jotform", troubles: [] }],
      { youtubeApiKey: "test-key" }
    );
    assert.match(requestedUrl, /part=snippet/);
    assert.doesNotMatch(requestedUrl, /contentDetails/);
    assert.deepEqual(Object.keys(output).sort(), ["records", "warnings"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("export-only video context parses duration and current video status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        items: [{
          id: "video-context",
          snippet: { publishedAt: "2026-07-01T10:00:00Z" },
          contentDetails: { definition: "hd", duration: "PT1H2M3S" },
          liveStreamingDetails: {
            actualStartTime: "2026-07-01T10:00:00Z",
            actualEndTime: "2026-07-01T11:02:03Z"
          },
          status: { madeForKids: false, privacyStatus: "public" }
        }]
      };
    }
  });
  try {
    const [context] = await fetchYouTubeVideoContexts(["video-context"], "test-key");
    assert.equal(context.durationSeconds, 3723);
    assert.equal(context.liveArchive, true);
    assert.equal(context.madeForKids, false);
    assert.equal(context.privacyStatus, "public");
    assert.equal(parseIsoDurationSeconds("P1DT2H3M4S"), 93784);
    assert.equal(parseIsoDurationSeconds("not-a-duration"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
