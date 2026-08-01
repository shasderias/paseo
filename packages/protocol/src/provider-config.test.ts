import { describe, expect, test } from "vitest";

import { ProviderOverrideSchema, ProviderOverridesSchema } from "./provider-config.js";

describe("ProviderOverrideSchema launchHook", () => {
  test("accepts a launchHook command string", () => {
    const parsed = ProviderOverrideSchema.parse({
      launchHook: "~/.paseo/hooks/pi-launch.sh",
    });

    expect(parsed.launchHook).toBe("~/.paseo/hooks/pi-launch.sh");
  });

  test("omits launchHook when not configured", () => {
    const parsed = ProviderOverrideSchema.parse({
      env: { FOO: "bar" },
    });

    expect(parsed.launchHook).toBeUndefined();
  });

  test("rejects an empty launchHook", () => {
    const result = ProviderOverrideSchema.safeParse({ launchHook: "" });
    expect(result.success).toBe(false);
  });

  test("rejects a non-string launchHook", () => {
    const result = ProviderOverrideSchema.safeParse({ launchHook: 42 });
    expect(result.success).toBe(false);
  });

  test("launchHook is not required", () => {
    const result = ProviderOverrideSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe("ProviderOverridesSchema launchHook", () => {
  test("accepts launchHook on built-in, derived, and ACP provider entries", () => {
    const parsed = ProviderOverridesSchema.parse({
      pi: {
        launchHook: "~/.paseo/hooks/pi-launch.sh",
      },
      zai: {
        extends: "claude",
        label: "ZAI",
        launchHook: "~/.paseo/hooks/zai-launch.sh",
      },
      "my-agent": {
        extends: "acp",
        label: "My Agent",
        command: ["my-agent", "--acp"],
        launchHook: "~/.paseo/hooks/my-agent-launch.sh",
      },
    });

    expect(parsed.pi?.launchHook).toBe("~/.paseo/hooks/pi-launch.sh");
    expect(parsed.zai?.launchHook).toBe("~/.paseo/hooks/zai-launch.sh");
    expect(parsed["my-agent"]?.launchHook).toBe("~/.paseo/hooks/my-agent-launch.sh");
  });

  test("rejects an empty launchHook on a provider entry", () => {
    const result = ProviderOverridesSchema.safeParse({
      pi: {
        launchHook: "",
      },
    });
    expect(result.success).toBe(false);
  });
});
