import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { GzipJsonArrayWriter } from "../../../services/recording/eventLog";

describe("GzipJsonArrayWriter", () => {
  it("streams values into a gzipped JSON array", async () => {
    const writer = new GzipJsonArrayWriter();
    const values = Array.from({ length: 500 }, (_, i) => ({
      type: i % 5,
      timestamp: 1_700_000_000_000 + i,
      data: { text: "x".repeat(i % 40) }
    }));
    values.forEach((value) => writer.push(value));
    expect(writer.length).toBe(500);
    const gz = await writer.finish();
    expect(JSON.parse(gunzipSync(Buffer.from(gz)).toString())).toEqual(values);
  });

  it("produces an empty array when nothing was pushed", async () => {
    const gz = await new GzipJsonArrayWriter().finish();
    expect(JSON.parse(gunzipSync(Buffer.from(gz)).toString())).toEqual([]);
  });

  it("rejects pushes after finishing", async () => {
    const writer = new GzipJsonArrayWriter();
    await writer.finish();
    expect(() => writer.push({})).toThrow(/closed/);
    await expect(writer.finish()).rejects.toThrow(/twice/);
  });
});
