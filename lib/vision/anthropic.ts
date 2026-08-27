import Anthropic from "@anthropic-ai/sdk";
import { anthropicConfig } from "../config/env";
import { VISION_SYSTEM, visionUserPrompt } from "./prompt";
import type { VisionProvider } from "./types";

/** Claude reads images natively, as a base64 image block alongside the text. */
export class AnthropicVisionProvider implements VisionProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor() {
    const cfg = anthropicConfig();
    this.client = new Anthropic({ apiKey: cfg.apiKey });
    this.model = process.env.VISION_MODEL || cfg.model;
  }

  async describePage(png: Buffer, captions: string[]): Promise<string> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      system: VISION_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
            },
            { type: "text", text: visionUserPrompt(captions) },
          ],
        },
      ],
    });
    return resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
      .trim();
  }
}
