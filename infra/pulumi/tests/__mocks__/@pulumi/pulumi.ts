import { vi } from "vitest";

export const interpolate = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  return strings.reduce((result, str, i) => {
    return result + str + (values[i] || "");
  }, "");
};

export const output = (value: unknown) => value;

export class Output<T> {
  static create<T>(value: T): Output<T> {
    return value as unknown as Output<T>;
  }
}

export class Config {
  private values: Record<string, string> = {};

  get(key: string): string | undefined {
    return this.values[key];
  }

  require(key: string): string {
    const value = this.values[key];
    if (!value) throw new Error(`Missing required config: ${key}`);
    return value;
  }

  getSecret(key: string): string | undefined {
    return this.values[key];
  }

  requireSecret(key: string): string {
    return this.require(key);
  }
}

export const getStack = vi.fn(() => "test");
export const getProject = vi.fn(() => "monitoring");
