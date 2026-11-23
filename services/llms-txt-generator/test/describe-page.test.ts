import { expect, test } from "vitest";
import type { components } from "../contract/types.js";
import { describePageExtractively } from "../src/domain/describe-page.js";

type Request = components["schemas"]["PageEntryRequest"];
const metadata: Request["metadata"] = {
  title: null,
  description: null,
  canonicalUrl: null,
  language: null,
};
const request: Request = {
  url: "https://example.org/guide",
  summarizer: "extractive",
  metadata,
  content: { text: "", markdown: "" },
};

test("normalizes metadata and prefers it to the extracted heading and prose", () => {
  const result = describePageExtractively({
    ...request,
    metadata: {
      ...metadata,
      title: " The\t API\n Guide ",
      description: " First step.   Second step. Third step. ",
    },
    content: { text: "Plain text.", markdown: "# A different title\n\nA different paragraph." },
  });
  expect(result).toEqual({
    entry: { url: request.url, title: "The API Guide", description: "First step. Second step." },
    usage: [],
  });
});

test("uses the first usable top-level heading and paragraph, keeping visible inline text", () => {
  const result = describePageExtractively({
    ...request,
    metadata: { ...metadata, title: "\n \t", description: " " },
    content: {
      text: "Navigation. Unrelated plain text.",
      markdown: [
        "#",
        "",
        "> # Quoted title",
        "",
        "## **Quick** [start](https://example.org/start)",
        "",
        "- List item.",
        "",
        "```md",
        "## Fenced title",
        "Code is not prose.",
        "```",
        "",
        "> Quoted prose.",
        "",
        "Start with `npm` and [setup](https://example.org/setup). Then run tests. Later details.",
      ].join("\n"),
    },
  });
  expect(result.entry).toMatchObject({
    title: "Quick start",
    description: "Start with npm and setup. Then run tests.",
  });
});

test("falls back to the first plain-text paragraph when Markdown is blank", () => {
  const result = describePageExtractively({
    ...request,
    content: { markdown: " \n\t", text: " \r\n\r\n  Start\r\nhere\r\n \r\nSecond paragraph." },
  });
  expect(result.entry).toMatchObject({ title: "/guide", description: "Start here" });
});

test("does not treat list, quote, or code text as Markdown prose", () => {
  const result = describePageExtractively({
    ...request,
    content: {
      text: "Looks like prose in the alternate representation",
      markdown: "# Heading\n\n- A list\n\n> A quote\n\n```\nCode\n```",
    },
  });
  expect(result.entry).toMatchObject({ title: "Heading", description: null });
});

test("keeps only the first sentence when the second would exceed the budget", () => {
  const result = describePageExtractively({
    ...request,
    metadata: { ...metadata, description: "Start here. " + "Next ".repeat(210) + "step." },
  });
  expect(result.entry.description).toBe("Start here.");
});

test("clips an oversized first candidate at a word boundary", () => {
  const result = describePageExtractively({
    ...request,
    metadata: { ...metadata, description: "start ".repeat(200).trim() },
  });
  expect(result.entry.description).toBe("start ".repeat(166).trim() + "…");
});

test("clips emoji and decomposed letters at complete grapheme boundaries", () => {
  const result = describePageExtractively({
    ...request,
    metadata: { ...metadata, title: "😀".repeat(301), description: "e\u0301".repeat(501) },
  });
  expect(result.entry.title).toBe("😀".repeat(299) + "…");
  expect(result.entry.description).toBe("e\u0301".repeat(499) + "…");
  expect([...result.entry.title]).toHaveLength(300);
  expect([...result.entry.description!]).toHaveLength(999);
});

test("falls back to code points if the first grapheme is bigger than the clip budget", () => {
  const result = describePageExtractively({
    ...request,
    metadata: { ...metadata, title: "e" + "\u0301".repeat(305) },
  });
  expect(result.entry.title).toBe("e" + "\u0301".repeat(298) + "…");
});
