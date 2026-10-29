import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "~/mcp/index.js";
import { downloadFigmaImagesTool } from "~/mcp/tools/download-figma-images-tool.js";
import type { ToolExtra } from "~/mcp/progress.js";

// A real 1x1 PNG, so the payload is something a vision API would accept.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

const stubExtra = {
  sendNotification: () => Promise.resolve(),
  signal: AbortSignal.timeout(30_000),
} as unknown as ToolExtra;

// Stands in for the Figma API: writes each requested file where the pipeline
// asked, the way the real service does.
function figmaServiceWriting(files: Record<string, Buffer | string>, seenDirs: string[]) {
  return {
    downloadImages: async (_fileKey: string, localPath: string, items: { fileName: string }[]) => {
      seenDirs.push(localPath);
      return Promise.all(
        items.map(async ({ fileName }) => {
          const filePath = path.join(localPath, fileName);
          await writeFile(filePath, files[fileName]);
          const dimensions = { width: 1, height: 1 };
          return {
            filePath,
            originalDimensions: dimensions,
            finalDimensions: dimensions,
            wasCropped: false,
            processingLog: [],
          };
        }),
      );
    },
  } as unknown as Parameters<typeof downloadFigmaImagesTool.handler>[1];
}

describe("get_figma_images (inline mode)", () => {
  it("replaces download_figma_images and asks for no destination path", async () => {
    const server = createServer(
      { figmaApiKey: "unused", figmaOAuthToken: "", useOAuth: false },
      { transport: "http", inlineImages: true },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const imagesTool = tools.find((tool) => tool.name === "get_figma_images");

    expect(tools.map((tool) => tool.name)).not.toContain("download_figma_images");
    expect(imagesTool?.inputSchema.properties).not.toHaveProperty("localPath");
    await client.close();
  });

  it("returns images as base64 content typed by their bytes, and leaves nothing on disk", async () => {
    const seenDirs: string[] = [];
    const service = figmaServiceWriting(
      // An image fill keeps Figma's original bytes, so a JPEG arrives under a .png name.
      { "hero.png": PNG, "photo.png": JPEG, "icon.svg": SVG },
      seenDirs,
    );

    const result = await downloadFigmaImagesTool.handler(
      {
        fileKey: "abc123",
        nodes: [
          { nodeId: "1:2", fileName: "hero.png" },
          { nodeId: "1:3", imageRef: "ref1", fileName: "photo.png" },
          { nodeId: "1:4", fileName: "icon.svg" },
        ],
        pngScale: 2,
      },
      service,
      undefined,
      true,
      "http",
      "api_key",
      undefined,
      stubExtra,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("Fetched 3 images") },
      { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
      { type: "image", data: JPEG.toString("base64"), mimeType: "image/jpeg" },
      { type: "text", text: `icon.svg:\n${SVG}` },
    ]);
    expect(seenDirs).toHaveLength(1);
    expect(existsSync(seenDirs[0])).toBe(false);
  });

  it("ignores a localPath the model sends anyway", async () => {
    const seenDirs: string[] = [];
    const result = await downloadFigmaImagesTool.handler(
      {
        fileKey: "abc123",
        nodes: [{ nodeId: "1:2", fileName: "hero.png" }],
        pngScale: 2,
        localPath: "../../etc",
      },
      figmaServiceWriting({ "hero.png": PNG }, seenDirs),
      "/project/root",
      true,
      "http",
      "api_key",
      undefined,
      stubExtra,
    );

    expect(result.isError).toBeUndefined();
    expect(seenDirs[0]).not.toContain("etc");
  });
});
