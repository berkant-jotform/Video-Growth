import assert from "node:assert/strict";
import test from "node:test";

import { matchesDetectorSearch } from "../lib/detector-filters.mjs";

test("detector search matches the current YouTube title shown on a card", () => {
  const run = {
    videoTitle: "",
    currentYoutubeTitle: "How to Add Photo Gallery on WordPress",
    videoId: "o-mr8NlaAc0",
    channel: "Jotform",
    options: {
      A: "How to Add a Photo Gallery to WordPress",
      B: "How to Embed a Photo Gallery Widget in WordPress"
    }
  };

  assert.equal(matchesDetectorSearch(run, "Jotform", "How to Add Photo Gallery on WordPress"), true);
  assert.equal(matchesDetectorSearch(run, "Jotform", "Embed a Photo Gallery Widget"), true);
  assert.equal(matchesDetectorSearch(run, "Jotform", "unrelated title"), false);
});
