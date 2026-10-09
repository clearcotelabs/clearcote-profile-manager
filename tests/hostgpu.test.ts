// Host GPU detection (electron/hostgpu.ts). The parsers are exercised on the REAL shapes the sources
// produce — PowerShell's ConvertTo-Json prints one controller as a bare object and several as an
// array, escapes "&" as & and the backslashes of a PNP id, and leaves a controller with no
// display at a null resolution. The detector itself is run with its command runner injected, so the
// exact command line it would spawn is pinned without spawning anything.

import { describe, it, expect, beforeEach } from "vitest";
import {
  WINDOWS_GPU_COMMAND,
  UNKNOWN_GPU,
  detectHostGpu,
  hostGpuCached,
  parseLinuxDrm,
  parsePnpDeviceId,
  parseWindowsControllers,
  resetHostGpuCache,
  vendorFromPciId,
} from "../electron/hostgpu";

// Verbatim from `powershell -NoProfile -Command "Get-CimInstance Win32_VideoController |
// Select-Object Name,PNPDeviceID,CurrentHorizontalResolution | ConvertTo-Json"` on the dev PC.
const ONE_NVIDIA = `{
    "Name":  "NVIDIA GeForce RTX 3070",
    "PNPDeviceID":  "PCI\\\\VEN_10DE\\u0026DEV_2484\\u0026SUBSYS_88D9103C\\u0026REV_A1\\\\4\\u002632396228\\u00260\\u00260009",
    "CurrentHorizontalResolution":  3440
}`;

// A laptop: the display runs off the integrated Intel part, the NVIDIA part has no screen attached.
const HYBRID = `[
    {
        "Name":  "Intel(R) UHD Graphics 770",
        "PNPDeviceID":  "PCI\\\\VEN_8086\\u0026DEV_A780\\u0026SUBSYS_88D9103C\\u0026REV_04\\\\3\\u002611583659\\u00260\\u002610",
        "CurrentHorizontalResolution":  1920
    },
    {
        "Name":  "NVIDIA GeForce RTX 4060 Laptop GPU",
        "PNPDeviceID":  "PCI\\\\VEN_10DE\\u0026DEV_28A0\\u0026SUBSYS_88D9103C\\u0026REV_A1\\\\4\\u00261E0B6A3\\u00260\\u00260008",
        "CurrentHorizontalResolution":  null
    }
]`;

// The same machine with the order swapped: the one with a resolution still wins.
const HYBRID_SWAPPED = `[
    {
        "Name":  "NVIDIA GeForce RTX 4060 Laptop GPU",
        "PNPDeviceID":  "PCI\\\\VEN_10DE\\u0026DEV_28A0\\u0026SUBSYS_88D9103C\\u0026REV_A1\\\\4\\u00261E0B6A3\\u00260\\u00260008",
        "CurrentHorizontalResolution":  null
    },
    {
        "Name":  "AMD Radeon RX 6700 XT",
        "PNPDeviceID":  "PCI\\\\VEN_1002\\u0026DEV_73DF\\u0026SUBSYS_1E0B1DA2\\u0026REV_C1\\\\6\\u002614A5EB0C\\u00260\\u00260008",
        "CurrentHorizontalResolution":  2560
    }
]`;

// A headless VM: Microsoft's software renderer, nothing else.
const BASIC_RENDER = `{
    "Name":  "Microsoft Basic Render Driver",
    "PNPDeviceID":  "ROOT\\\\BASICRENDER\\\\0000",
    "CurrentHorizontalResolution":  null
}`;
// ...and one where the software device is listed WITH a PCI-style id (some VMs do).
const BASIC_RENDER_PCI = `{
    "Name":  "Microsoft Basic Render Driver",
    "PNPDeviceID":  "PCI\\\\VEN_1414\\u0026DEV_008C\\u0026SUBSYS_00000000\\u0026REV_00\\\\3\\u00261\\u00260\\u00260",
    "CurrentHorizontalResolution":  1024
}`;

// Remote session: real card present but nothing reports a resolution; the software renderer first.
const NO_RESOLUTION = `[
    {
        "Name":  "Microsoft Basic Render Driver",
        "PNPDeviceID":  "PCI\\\\VEN_1414\\u0026DEV_008C\\u0026SUBSYS_00000000\\u0026REV_00\\\\3\\u00261\\u00260\\u00260",
        "CurrentHorizontalResolution":  null
    },
    {
        "Name":  "NVIDIA GeForce RTX 3060",
        "PNPDeviceID":  "PCI\\\\VEN_10DE\\u0026DEV_2504\\u0026SUBSYS_88D9103C\\u0026REV_A1\\\\4\\u002632396228\\u00260\\u00260009",
        "CurrentHorizontalResolution":  null
    }
]`;

describe("PCI ids", () => {
  it("maps the three makers and nothing else", () => {
    expect(vendorFromPciId(0x10de)).toBe("nvidia");
    expect(vendorFromPciId(0x8086)).toBe("intel");
    expect(vendorFromPciId(0x1002)).toBe("amd");
    expect(vendorFromPciId(0x1414)).toBe("unknown"); // Microsoft Basic Render
    expect(vendorFromPciId(0x15ad)).toBe("unknown"); // VMware SVGA
    expect(vendorFromPciId(null)).toBe("unknown");
  });

  it("reads VEN_ and DEV_ out of a PNP device id, after JSON has unescaped it", () => {
    const pnp = JSON.parse(ONE_NVIDIA).PNPDeviceID as string;
    expect(pnp).toBe("PCI\\VEN_10DE&DEV_2484&SUBSYS_88D9103C&REV_A1\\4&32396228&0&0009");
    expect(parsePnpDeviceId(pnp)).toEqual({ vendorId: 0x10de, deviceId: 0x2484 });
  });

  it("is case-insensitive on the hex and null on anything else", () => {
    expect(parsePnpDeviceId("PCI\\VEN_10de&DEV_2484")).toEqual({ vendorId: 0x10de, deviceId: 0x2484 });
    expect(parsePnpDeviceId("ROOT\\BASICRENDER\\0000")).toEqual({ vendorId: null, deviceId: null });
    expect(parsePnpDeviceId("")).toEqual({ vendorId: null, deviceId: null });
    expect(parsePnpDeviceId(null)).toEqual({ vendorId: null, deviceId: null });
  });
});

describe("Windows — ConvertTo-Json shapes", () => {
  it("one controller comes as a bare object (the dev PC)", () => {
    expect(parseWindowsControllers(ONE_NVIDIA)).toEqual({ vendor: "nvidia", name: "NVIDIA GeForce RTX 3070", deviceId: 0x2484 });
  });

  it("several come as an array; the one with a resolution drives the display", () => {
    expect(parseWindowsControllers(HYBRID)).toEqual({ vendor: "intel", name: "Intel(R) UHD Graphics 770", deviceId: 0xa780 });
    expect(parseWindowsControllers(HYBRID_SWAPPED)).toEqual({ vendor: "amd", name: "AMD Radeon RX 6700 XT", deviceId: 0x73df });
  });

  it("Microsoft's Basic Render Driver is unknown, with or without a PCI-style id", () => {
    expect(parseWindowsControllers(BASIC_RENDER)).toEqual({ vendor: "unknown", name: "Microsoft Basic Render Driver", deviceId: null });
    expect(parseWindowsControllers(BASIC_RENDER_PCI)).toEqual({ vendor: "unknown", name: "Microsoft Basic Render Driver", deviceId: 0x8c });
  });

  it("with no resolution anywhere, the first hardware controller is taken over the software one", () => {
    expect(parseWindowsControllers(NO_RESOLUTION)).toEqual({ vendor: "nvidia", name: "NVIDIA GeForce RTX 3060", deviceId: 0x2504 });
  });

  it("a resolution of 0 does not count as a display", () => {
    const zero = HYBRID.replace('"CurrentHorizontalResolution":  1920', '"CurrentHorizontalResolution":  0');
    // Neither has a display now; the first hardware controller (Intel) wins.
    expect(parseWindowsControllers(zero).vendor).toBe("intel");
  });

  it("tolerates leading output, a BOM and CRLF", () => {
    expect(parseWindowsControllers("﻿" + ONE_NVIDIA.replace(/\n/g, "\r\n") + "\r\n").vendor).toBe("nvidia");
  });

  it("is unknown on empty output, null, and anything that is not JSON", () => {
    expect(parseWindowsControllers("")).toEqual(UNKNOWN_GPU);
    expect(parseWindowsControllers("   \r\n")).toEqual(UNKNOWN_GPU);
    expect(parseWindowsControllers("null")).toEqual(UNKNOWN_GPU);
    expect(parseWindowsControllers("[]")).toEqual(UNKNOWN_GPU);
    expect(parseWindowsControllers("Get-CimInstance : Access denied")).toEqual(UNKNOWN_GPU);
    expect(parseWindowsControllers("42")).toEqual(UNKNOWN_GPU);
  });

  it("copes with a controller that has no PNP id at all", () => {
    expect(parseWindowsControllers('{"Name":"Virtual Display","CurrentHorizontalResolution":800}')).toEqual({
      vendor: "unknown",
      name: "Virtual Display",
      deviceId: null,
    });
  });
});

describe("Linux — /sys/class/drm", () => {
  it("prefers the boot VGA device", () => {
    expect(
      parseLinuxDrm([
        { vendor: "0x8086\n", device: "0x4682\n", bootVga: "0\n" },
        { vendor: "0x10de\n", device: "0x2786\n", bootVga: "1\n" },
      ]),
    ).toEqual({ vendor: "nvidia", name: "", deviceId: 0x2786 });
  });

  it("falls back to the first card with a vendor id when no boot_vga is present", () => {
    expect(
      parseLinuxDrm([
        { vendor: null, device: null, bootVga: null }, // a card dir with no device/ (e.g. a virtual one)
        { vendor: "0x1002\n", device: "0x747e\n", bootVga: null },
        { vendor: "0x10de\n", device: "0x2504\n", bootVga: null },
      ]),
    ).toEqual({ vendor: "amd", name: "", deviceId: 0x747e });
  });

  it("is unknown with no cards, and for a maker it does not know", () => {
    expect(parseLinuxDrm([])).toEqual(UNKNOWN_GPU);
    expect(parseLinuxDrm([{ vendor: "0x1af4\n", device: "0x1050\n", bootVga: "1\n" }])).toEqual({ vendor: "unknown", name: "", deviceId: 0x1050 }); // virtio-gpu
  });

  it("reads the ids with or without the 0x prefix and surrounding whitespace", () => {
    expect(parseLinuxDrm([{ vendor: " 8086 ", device: "a780", bootVga: "1" }])).toEqual({ vendor: "intel", name: "", deviceId: 0xa780 });
  });
});

describe("detectHostGpu", () => {
  it("on Windows runs exactly the documented PowerShell command and parses its output", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const got = await detectHostGpu({
      platform: "win32",
      run: async (file, args) => {
        calls.push({ file, args });
        return ONE_NVIDIA;
      },
    });
    expect(got).toEqual({ vendor: "nvidia", name: "NVIDIA GeForce RTX 3070", deviceId: 0x2484 });
    expect(calls).toEqual([{ file: "powershell", args: WINDOWS_GPU_COMMAND.args }]);
    expect(WINDOWS_GPU_COMMAND.args.join(" ")).toBe(
      "-NoProfile -NonInteractive -Command Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID,CurrentHorizontalResolution | ConvertTo-Json",
    );
  });

  it("on Linux reads the DRM cards", async () => {
    const got = await detectHostGpu({ platform: "linux", readDrm: () => [{ vendor: "0x8086", device: "0x9a49", bootVga: "1" }] });
    expect(got).toEqual({ vendor: "intel", name: "", deviceId: 0x9a49 });
  });

  it("on macOS is unknown without running anything", async () => {
    let ran = false;
    const got = await detectHostGpu({
      platform: "darwin",
      run: async () => {
        ran = true;
        return ONE_NVIDIA;
      },
      readDrm: () => {
        ran = true;
        return [];
      },
    });
    expect(got).toEqual(UNKNOWN_GPU);
    expect(ran).toBe(false);
  });

  it("never throws — a failing command or reader is unknown", async () => {
    await expect(
      detectHostGpu({
        platform: "win32",
        run: async () => {
          throw new Error("spawn powershell ENOENT");
        },
      }),
    ).resolves.toEqual(UNKNOWN_GPU);
    await expect(
      detectHostGpu({
        platform: "linux",
        readDrm: () => {
          throw new Error("EACCES");
        },
      }),
    ).resolves.toEqual(UNKNOWN_GPU);
  });
});

describe("hostGpuCached", () => {
  beforeEach(() => resetHostGpuCache());

  it("detects once per run and hands every caller the same answer", async () => {
    let runs = 0;
    const opts = {
      platform: "win32" as const,
      run: async () => {
        runs++;
        return ONE_NVIDIA;
      },
    };
    const a = await hostGpuCached(opts);
    const b = await hostGpuCached(opts);
    const c = await hostGpuCached({ ...opts, run: async () => HYBRID }); // ignored: already cached
    expect(runs).toBe(1);
    expect(a).toEqual({ vendor: "nvidia", name: "NVIDIA GeForce RTX 3070", deviceId: 0x2484 });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("caches even a failure as unknown, rather than re-spawning PowerShell on every open of the editor", async () => {
    let runs = 0;
    const opts = {
      platform: "win32" as const,
      run: async () => {
        runs++;
        throw new Error("timeout");
      },
    };
    expect(await hostGpuCached(opts)).toEqual(UNKNOWN_GPU);
    expect(await hostGpuCached(opts)).toEqual(UNKNOWN_GPU);
    expect(runs).toBe(1);
  });
});
