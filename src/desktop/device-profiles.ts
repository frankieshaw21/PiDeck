import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface DeviceProfile {
  id: string;
  sessionId: string;
  name: string;
  protocol: "ssh" | "telnet";
  host: string;
  port: number;
  username: string;
}

/** Persists public connection details only; credentials and live state are never saved. */
export class DeviceProfileStore {
  private profiles: DeviceProfile[] = [];
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!Array.isArray(value)) throw new Error("Invalid device profile file");
    const profiles = value.map((entry) => this.validate(entry));
    if (new Set(profiles.map((entry) => entry.id)).size !== profiles.length) throw new Error("Duplicate device profile ID");
    this.profiles = profiles;
  }

  list(sessionId: string): DeviceProfile[] {
    return this.profiles.filter((profile) => profile.sessionId === sessionId).map((profile) => ({ ...profile }));
  }

  async save(sessionId: string, value: Omit<DeviceProfile, "id" | "sessionId"> & { id?: string }): Promise<DeviceProfile> {
    const id = value.id ?? randomUUID();
    const profile = this.validate({ ...value, id, sessionId });
    const previous = this.profiles.find((entry) => entry.id === id);
    if (previous && previous.sessionId !== sessionId) throw new Error("Device belongs to another conversation");
    this.profiles = [...this.profiles.filter((entry) => entry.id !== id), profile];
    await this.persist();
    return { ...profile };
  }

  async remove(sessionId: string, id: string): Promise<void> {
    if (!this.profiles.some((entry) => entry.id === id && entry.sessionId === sessionId)) throw new Error("Unknown device");
    this.profiles = this.profiles.filter((entry) => entry.id !== id);
    await this.persist();
  }

  async removeSession(sessionId: string): Promise<void> {
    this.profiles = this.profiles.filter((entry) => entry.sessionId !== sessionId);
    await this.persist();
  }

  private validate(value: unknown): DeviceProfile {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid device profile");
    const item = value as Record<string, unknown>;
    const text = (key: string, limit: number) => {
      const v = item[key];
      if (typeof v !== "string" || !v.trim() || v.length > limit) throw new Error(`Invalid device ${key}`);
      return v.trim();
    };
    const id = text("id", 128), sessionId = text("sessionId", 128), name = text("name", 120), host = text("host", 253), username = text("username", 128);
    if (!/^[a-zA-Z0-9_.:\-\[\]]+$/.test(host)) throw new Error("Invalid device host");
    if (item.protocol !== "ssh" && item.protocol !== "telnet") throw new Error("Invalid device protocol");
    if (typeof item.port !== "number" || !Number.isInteger(item.port) || item.port < 1 || item.port > 65535) throw new Error("Invalid device port");
    return { id, sessionId, name, host, username, protocol: item.protocol, port: item.port };
  }

  private async persist(): Promise<void> {
    const content = JSON.stringify(this.profiles, null, 2);
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    });
    await this.writes;
  }
}
