import assert from "node:assert/strict";
import { test } from "node:test";
import { enrichWithYouTubeMetadata, fetchYouTubeVideoMetadata, findYouTubeVideoCandidates } from "../lib/youtube.js";

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
