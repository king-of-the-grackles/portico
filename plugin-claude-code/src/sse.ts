export interface SseMessage {
  event: string;
  data: string;
}

/** Splits a server-sent-events byte stream into messages. Comment lines (": ping") produce no message. */
export class SseParser {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  /** Adds a chunk and returns the messages it completed. */
  push(chunk: Uint8Array): SseMessage[] {
    this.buffer += this.decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    const messages: SseMessage[] = [];
    for (let end = this.buffer.indexOf("\n\n"); end >= 0; end = this.buffer.indexOf("\n\n")) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line === "" || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0 || event !== "message") messages.push({ event, data: data.join("\n") });
    }
    return messages;
  }
}
