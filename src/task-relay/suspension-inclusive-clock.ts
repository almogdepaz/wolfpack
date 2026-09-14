import { dlopen, FFIType, ptr } from "bun:ffi";

const MACOS_SYSTEM_LIBRARY = "/usr/lib/libSystem.B.dylib";
const LINUX_C_LIBRARY = "libc.so.6";
const CLOCK_BOOTTIME = 7;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const NANOSECONDS_PER_MILLISECOND_BIGINT = 1_000_000n;
const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export interface SuspensionClockBindings {
  readonly platform: string;
  readonly macTimebaseInfo: (() => { readonly status: number; readonly numerator: number; readonly denominator: number }) | undefined;
  readonly macContinuousTime: (() => bigint) | undefined;
  readonly linuxBootTime: (() => { readonly status: number; readonly seconds: bigint; readonly nanoseconds: bigint }) | undefined;
}

let defaultElapsedNow: (() => number) | undefined;

function invalid(message: string): never { throw new Error(`invalid suspension clock result: ${message}`); }

function milliseconds(nanoseconds: number): number {
  const value = nanoseconds / NANOSECONDS_PER_MILLISECOND;
  if (!Number.isFinite(value) || value < 0) invalid("non-finite elapsed time");
  return value;
}

function macClock(bindings: SuspensionClockBindings): () => number {
  if (!bindings.macTimebaseInfo || !bindings.macContinuousTime) throw new Error("macOS suspension clock bindings unavailable");
  const timebase = bindings.macTimebaseInfo();
  if (timebase.status !== 0 || !Number.isSafeInteger(timebase.numerator) || !Number.isSafeInteger(timebase.denominator)
    || timebase.numerator <= 0 || timebase.denominator <= 0) invalid("mach timebase");
  const millisecondsDivisor = BigInt(timebase.denominator) * NANOSECONDS_PER_MILLISECOND_BIGINT;
  const numerator = BigInt(timebase.numerator);
  return () => {
    const ticks = bindings.macContinuousTime!();
    if (ticks < 0n) invalid("mach continuous time");
    const scaledTicks = ticks * numerator;
    const wholeMilliseconds = scaledTicks / millisecondsDivisor;
    const remainder = scaledTicks % millisecondsDivisor;
    if (wholeMilliseconds > MAX_SAFE_BIGINT) invalid("mach continuous time");
    const value = Number(wholeMilliseconds) + Number(remainder) / Number(millisecondsDivisor);
    if (!Number.isFinite(value)) invalid("mach continuous time");
    return value;
  };
}

function linuxClock(bindings: SuspensionClockBindings): () => number {
  if (!bindings.linuxBootTime) throw new Error("Linux suspension clock binding unavailable");
  return () => {
    const value = bindings.linuxBootTime!();
    if (value.status !== 0 || value.seconds < 0n || value.seconds > MAX_SAFE_BIGINT
      || value.nanoseconds < 0n || value.nanoseconds >= NANOSECONDS_PER_SECOND) invalid("clock_gettime(CLOCK_BOOTTIME)");
    return milliseconds(Number(value.seconds) * Number(NANOSECONDS_PER_SECOND) + Number(value.nanoseconds));
  };
}

function fromBindings(bindings: SuspensionClockBindings): () => number {
  if (bindings.platform === "darwin") return macClock(bindings);
  if (bindings.platform === "linux") return linuxClock(bindings);
  throw new Error(`suspension-inclusive clock unsupported on ${bindings.platform}`);
}

function nativeBindings(): SuspensionClockBindings {
  try {
    if (process.platform === "darwin") {
      const library = dlopen(MACOS_SYSTEM_LIBRARY, {
        mach_continuous_time: { args: [], returns: FFIType.u64 },
        mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
      });
      const timebase = new Uint32Array(2);
      const timebasePointer = ptr(timebase);
      return {
        platform: "darwin",
        macTimebaseInfo: () => {
          void library;
          return { status: library.symbols.mach_timebase_info(timebasePointer), numerator: timebase[0]!, denominator: timebase[1]! };
        },
        macContinuousTime: () => library.symbols.mach_continuous_time(),
        linuxBootTime: undefined,
      };
    }
    if (process.platform === "linux") {
      const library = dlopen(LINUX_C_LIBRARY, {
        clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      });
      const timespec = new BigInt64Array(2);
      const timespecPointer = ptr(timespec);
      return {
        platform: "linux",
        macTimebaseInfo: undefined,
        macContinuousTime: undefined,
        linuxBootTime: () => {
          void library;
          return { status: library.symbols.clock_gettime(CLOCK_BOOTTIME, timespecPointer), seconds: timespec[0]!, nanoseconds: timespec[1]! };
        },
      };
    }
  } catch (error) {
    throw new Error(`suspension-inclusive clock initialization failed on ${process.platform}`, { cause: error });
  }
  throw new Error(`suspension-inclusive clock unsupported on ${process.platform}`);
}

export function createSuspensionInclusiveElapsedNow(bindings?: SuspensionClockBindings): () => number {
  if (bindings) return fromBindings(bindings);
  return defaultElapsedNow ??= fromBindings(nativeBindings());
}
