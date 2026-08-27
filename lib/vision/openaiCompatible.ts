import OpenAI from "openai";
import { openConfig, openaiConfig } from "../config/env";
import { VISION_SYSTEM, visionUserPrompt } from "./prompt";
import type { VisionProvider } from "./types";

/**
 * Any endpoint speaking the OpenAI chat API with image support: GPT-4o and
 * friends, or a local vision model served by Ollama. One adapter covers both
 * because the image content-part format is identical; only the base URL and
 * model name differ.
 */
export class OpenAICompatibleVisionProvider implements VisionProvider {
  readonly name: string;
  readonly model: string;
  private client: OpenAI;

  constructor(kind: "openai" | "open") {
    this.name = kind;
    if (kind === "openai") {
      const cfg = openaiConfig();
      this.client = new OpenAI({ apiKey: cfg.apiKey });
      this.model = process.env.VISION_MODEL || "gpt-4o";
    } else {
      const cfg = openConfig();
      this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
      this.model = process.env.VISION_MODEL || "llava:7b";
    }
  }

  async describePage(png: Buffer, captions: string[]): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 2000,
      messages: [
        { role: "system", content: VISION_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: visionUserPrompt(captions) },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
            },
          ],
        },
      ],
    });
    return (completion.choices[0]?.message?.content ?? "").trim();
  }
}
