/** Incremental Telnet option negotiation. Authentication and transport are
 * deliberately handled separately so credentials never enter output logs. */
export class TelnetProtocol {
  private state: "data" | "iac" | "option" | "sub" | "sub-iac" = "data";
  private command = 0;

  read(chunk: Buffer): { data: Buffer; reply: Buffer } {
    const data: number[] = [];
    const reply: number[] = [];
    for (const byte of chunk) {
      switch (this.state) {
        case "data":
          if (byte === 255) this.state = "iac";
          else data.push(byte);
          break;
        case "iac":
          if (byte === 255) { data.push(byte); this.state = "data"; }
          else if (byte === 250) this.state = "sub";
          else if (byte >= 251 && byte <= 254) { this.command = byte; this.state = "option"; }
          else this.state = "data";
          break;
        case "option":
          // Decline unsupported options; do not acknowledge DONT/WONT to
          // avoid negotiation loops. Plain NVT text remains available.
          if (this.command === 251) reply.push(255, 254, byte);
          if (this.command === 253) reply.push(255, 252, byte);
          this.state = "data";
          break;
        case "sub":
          if (byte === 255) this.state = "sub-iac";
          break;
        case "sub-iac":
          this.state = byte === 240 ? "data" : "sub";
          break;
      }
    }
    return { data: Buffer.from(data), reply: Buffer.from(reply) };
  }
}
