import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface DesktopCustomization {
  customized: boolean;
  owner: string | null;
}

const NOT_CUSTOMIZED: DesktopCustomization = {
  customized: false,
  owner: null,
};

export function parseDesktopCustomization(raw: unknown): DesktopCustomization {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return NOT_CUSTOMIZED;
  }

  const metadata = raw as Record<string, unknown>;
  if (metadata.paseoCustomized !== true) {
    return NOT_CUSTOMIZED;
  }

  const owner =
    typeof metadata.paseoCustomizationOwner === "string"
      ? metadata.paseoCustomizationOwner.trim()
      : "";

  return {
    customized: true,
    owner: owner || null,
  };
}

let cachedCustomization: DesktopCustomization | null = null;

export function getDesktopCustomization(): DesktopCustomization {
  if (!app.isPackaged) {
    return NOT_CUSTOMIZED;
  }

  if (cachedCustomization) {
    return cachedCustomization;
  }

  try {
    const packageJson = JSON.parse(
      readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"),
    ) as unknown;
    cachedCustomization = parseDesktopCustomization(packageJson);
  } catch (error) {
    console.warn(`[customization] Failed to read packaged build metadata: ${String(error)}`);
    cachedCustomization = NOT_CUSTOMIZED;
  }

  return cachedCustomization;
}
